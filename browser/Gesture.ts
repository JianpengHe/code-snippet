/**
 * 手势二维坐标点类型
 */
export type IGesturePoint = {
  x: number;
  y: number;
};

/**
 * 手势变换结果数据类型
 */
export type IGestureTransformRes = {
  /** X 轴平移量（px） */
  translateX: number;
  /** Y 轴平移量（px） */
  translateY: number;
  /** 旋转弧度（rad） */
  rotate: number;
  /** 缩放倍数（1 为原始大小） */
  scale: number;
  /** 拼接完成的 CSS transform 属性字符串（可直接赋值给 style.transform） */
  transformText: string;
};

/**
 * 手势控制核心类 (Gesture)
 *
 * 功能特性：
 * 1. 交互支持：单指/鼠标平移拖拽、双指缩放/旋转、鼠标滚轮缩放、双击缩放。
 * 2. 屏幕自适应：内置一键等比居中自适应（fitToScreen，contain 模式）。
 * 3. 极速渲染：基于 requestAnimationFrame (rAF) 进行帧节流，在高刷屏（120Hz+）及高频鼠标下保持丝滑流畅。
 * 4. 健壮容错：内置尺寸探测（隐藏元素无闪烁）、异常中断自恢复（touchcancel/window blur）、完整生命周期管理。
 *
 * 常见使用方式：
 *   方式 1（极简模式，推荐）：直接传入 DOM 节点
 *     const gesture = new Gesture(document.querySelector("#preview"));
 *
 *   方式 2（传统手动模式，向后兼容）：传入指定中心点
 *     const gesture = new Gesture({ x: 100, y: 100 });
 *     dom.addEventListener("touchstart", gesture.onStartListener);
 */
export class Gesture {
  /**
   * 构造函数
   * @param target - 可传入 HTMLElement 直接一键自动绑定；也可传入 IGesturePoint 手动指定中心点（默认 {x: 0, y: 0}）
   * @param autoFit - 传入 DOM 时，是否在初始化完成后自动执行屏幕等比居中缩放（默认为 true）
   */
  constructor(target: IGesturePoint | HTMLElement = { x: 0, y: 0 }, autoFit = true) {
    // 预先绑定事件函数的 this 指向，确保作为监听器传递时不丢失上下文
    this.onStartListener = this.onStart.bind(this);
    this.onMoveListener = this.onMove.bind(this);
    this.onEndListener = this.onEnd.bind(this);
    this.onScaleListener = this.onScale.bind(this);

    if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
      this.transformOrigin = { x: 0, y: 0 };
      this.bindElement(target, autoFit);
    } else {
      this.transformOrigin = target as IGesturePoint;
    }
  }

  /** 当前实时的变换结果（每次计算后即时更新） */
  private readonly transformRes: IGestureTransformRes = {
    translateX: 0,
    translateY: 0,
    rotate: 0,
    scale: 1,
    transformText: ``,
  };

  /** 上一次手势结束时的变换锁存结果（作为下一次新手势开始时的增量叠加基准） */
  private readonly preEndTransformRes: IGestureTransformRes = {
    translateX: 0,
    translateY: 0,
    rotate: 0,
    scale: 1,
    transformText: ``,
  };

  /** 变换原点（对应 CSS 的 transform-origin） */
  private transformOrigin: IGesturePoint;

  /** 当前由本手势实例全权托管的 DOM 节点 */
  public boundElement: HTMLElement | null = null;

  /** 手势刚开始（按下一瞬间）的触摸点基准信息（弧度、点间距及各点坐标） */
  private startPoints: { rad: number; distance: number; points: IGesturePoint[] } = { points: [], rad: 0, distance: 0 };

  /**
   * 连续点击 / 双击状态机跟踪器
   * - expire: 双击判断有效截止时间戳
   * - type: "start"（首次按下未松开）| "firstPoint"（首次抬起，正等待第 2 次点击）| ""（空闲状态）
   */
  private lastClickPoint: IGesturePoint & { expire: number; type: string } = { x: 0, y: 0, expire: 0, type: "" };

  /**
   * 解绑当前已绑定的 DOM 节点及其所有事件监听器
   */
  public unbind() {
    if (this.boundElement) {
      this.boundElement.removeEventListener("touchstart", this.onStartListener, false);
      this.boundElement.removeEventListener("mousedown", this.onStartListener, false);
      this.boundElement.removeEventListener("wheel", this.onScaleListener, false);
      this.boundElement.removeEventListener("dblclick", this.onScaleListener, false);
      this.boundElement = null;
    }
  }

  /**
   * 彻底销毁手势实例
   * 清理 DOM 监听、window 全局监听、双击防抖定时器与未执行的 rAF 动画帧，防止内存泄漏或手势卡死
   */
  public destroy() {
    this.unbind();
    this.removeAllListener();
    if (this.onGestureEndTimer) {
      clearTimeout(this.onGestureEndTimer);
      this.onGestureEndTimer = 0;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      this.pendingMoveObj = null;
    }
    this.isGestureActive = false;
  }

  /**
   * 绑定 DOM 节点（内部自动防止重复绑定）
   *
   * 自动化执行流程：
   *   1. 若之前绑定过元素，先安全解绑
   *   2. 测量元素真实宽高（针对 display: none 的隐藏元素有同帧保护测量，绝无画面闪烁）
   *   3. 计算中心点作为 transformOrigin 并同步至 CSS
   *   4. 自动配置必要样式（position: fixed, left: 0, top: 0, touch-action: none）
   *   5. 自动关联 onTransform 回调修改 style.transform
   *   6. 自动挂载 touchstart, mousedown, wheel, dblclick 监听器
   *   7. 自动调用 fitToScreen() 将元素等比缩放并居中在屏幕视口中
   *
   * @param el - 需要手势控制的 HTMLElement（如 div、img、canvas 等）
   * @param autoFit - 是否在绑定后自动执行屏幕自适应居中（默认为 true）
   */
  public bindElement(el: HTMLElement, autoFit = true): this {
    // 幂等防护：防止对同一个元素重复绑定造成事件监听层叠
    if (this.boundElement === el) {
      if (autoFit) this.fitToScreen(el);
      return this;
    }

    // 先安全清理旧绑定的元素与事件
    this.unbind();
    this.boundElement = el;

    // 1. 获取元素真实尺寸（安全兼容隐藏 DOM）
    const { width, height } = this.measureSize(el);

    // 2. 将变换原点设为元素几何中心
    this.transformOrigin = { x: width / 2, y: height / 2 };

    // 3. 配置手势所需的基准样式，确保基于视口左上角定位并屏蔽系统默认手势
    el.style.position = "fixed";
    el.style.left = "0";
    el.style.top = "0";
    el.style.touchAction = "none"; // 屏蔽移动端浏览器默认滚动/下拉刷新
    el.style.transformOrigin = `${this.transformOrigin.x}px ${this.transformOrigin.y}px`;

    // 4. 自动连接变换回调，把生成的 transformText 作用到节点上
    this.onTransform = ({ transformText }) => {
      el.style.transform = transformText;
    };

    // 5. 挂载交互触发监听器
    el.addEventListener("touchstart", this.onStartListener, false);
    el.addEventListener("mousedown", this.onStartListener, false);
    el.addEventListener("wheel", this.onScaleListener, false);
    el.addEventListener("dblclick", this.onScaleListener, false);

    // 6. 默认自适应屏幕视口居中
    if (autoFit) this.fitToScreen(el);

    return this;
  }

  /**
   * 一键缩放到合适大小并居中显示（完整显示在屏幕内，contain 模式）
   *
   * 计算原则：宁愿缩小一点也保证整个 DOM 都在视口内，同时旋转置 0，平移居中。
   * 可多次重复调用（例如在 window.onresize 窗口大小改变时调用）。
   *
   * @param targetEl - 可选的目标元素，默认使用已绑定的 boundElement
   */
  public fitToScreen(targetEl: HTMLElement | null = this.boundElement) {
    if (!targetEl) return;

    const { width, height } = this.measureSize(targetEl);
    if (width === 0 || height === 0) return;

    // 更新 transformOrigin 为当前元素中心
    this.transformOrigin = { x: width / 2, y: height / 2 };
    targetEl.style.transformOrigin = `${this.transformOrigin.x}px ${this.transformOrigin.y}px`;

    // 当前视口宽度与高度
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;

    // contain 缩放比率：宽或高任一超出视口即等比缩小，默认不超过 1 倍原大
    const scale = Math.min(screenWidth / width, screenHeight / height, 1);

    // 居中偏移量：使元素在视口内水平与垂直严格居中
    const translateX = (screenWidth - width) / 2;
    const translateY = (screenHeight - height) / 2;

    // 重置变换状态（旋转清零，平移与缩放居中归位）
    this.resetTo(translateX, translateY, 0, scale);
  }

  /**
   * 动态更新目标尺寸（支持视频流分辨率切换、画布动态扩容等场景）
   *
   * 运算逻辑：
   *   1. 比例检查：
   *      - 若宽高比发生明显改变（超过 2%，如 16:9 横屏切 9:16 竖屏），自动触发 fitToScreen() 重新等比居中。
   *      - 若宽高比保持一致（如 720P 升级为 1080P），进行数学无缝补偿，保持屏幕视觉绝对不动，无感知刷新。
   *
   * @param oldWidth 旧的宽度像素值
   * @param oldHeight 旧的高度像素值
   * @param newWidth 新的宽度像素值
   * @param newHeight 新的高度像素值
   */
  public updateSize(oldWidth: number, oldHeight: number, newWidth: number, newHeight: number) {
    if (!oldWidth || !oldHeight || !newWidth || !newHeight) return;

    // 尺寸完全无变动直接返回
    if (oldWidth === newWidth && oldHeight === newHeight) return;

    const el = this.boundElement;

    // 同步更新 DOM 盒模型尺寸与手势中心原点
    if (el) {
      el.style.width = `${newWidth}px`;
      el.style.height = `${newHeight}px`;
      el.style.transformOrigin = `${newWidth / 2}px ${newHeight / 2}px`;
    }
    this.transformOrigin = { x: newWidth / 2, y: newHeight / 2 };

    // 宽高比例一致性判断（允许约 2% 的浮点舍入误差）
    const oldRatio = oldWidth / oldHeight;
    const newRatio = newWidth / newHeight;
    const isRatioChanged = Math.abs(oldRatio - newRatio) > 0.02;

    // 比例改变（如横竖屏切换）：无法维持原有相对视野，执行 fitToScreen 重新自适应屏幕居中
    if (isRatioChanged) {
      this.fitToScreen();
      return;
    }

    // 比例一致（如 720P -> 1080P）：执行无缝平移与缩放补偿，视觉呈现分毫不动
    const scaleFactor = oldWidth / newWidth;
    const newScale = this.transformRes.scale * scaleFactor;
    const newTx = this.transformRes.translateX + (oldWidth - newWidth) / 2;
    const newTy = this.transformRes.translateY + (oldHeight - newHeight) / 2;

    this.resetTo(newTx, newTy, this.transformRes.rotate, newScale);
  }

  /**
   * 安全获取元素的真实宽高
   *
   * 如果元素为 display: none，通过在同帧同步任务内临时置为 display: block + visibility: hidden + position: absolute
   * 读取 offsetWidth/offsetHeight。在下一个屏幕绘制（paint）之前恢复原有样式，
   * 绝不会在屏幕上产生任何视觉闪烁（Reflow 但不会触发 Paint）。
   */
  public measureSize(el: HTMLElement): { width: number; height: number } {
    let width = el.offsetWidth;
    let height = el.offsetHeight;

    // 已经处于渲染流中且有宽高，直接返回
    if (width > 0 && height > 0) return { width, height };

    // 针对隐藏元素，在同步 JS 宏任务里临时切换测量，读取完立即同步复原
    const saved = {
      display: el.style.display,
      visibility: el.style.visibility,
      position: el.style.position,
    };

    Object.assign(el.style, {
      display: "block",
      visibility: "hidden",
      position: "absolute",
    });

    width = el.offsetWidth;
    height = el.offsetHeight;

    // 立即同步恢复原始样式
    Object.assign(el.style, saved);
    return { width, height };
  }

  /**
   * 直接设定/重置变换状态（立刻生效并同步触发 onTransform）
   */
  public resetTo(translateX: number, translateY: number, rotate: number, scale: number) {
    this.transformRes.translateX = this.preEndTransformRes.translateX = translateX;
    this.transformRes.translateY = this.preEndTransformRes.translateY = translateY;
    this.transformRes.rotate = this.preEndTransformRes.rotate = rotate;
    this.transformRes.scale = this.preEndTransformRes.scale = scale;
    const text = `translate3d(${translateX}px, ${translateY}px,0) rotate3d(0, 0, 1,${rotate}rad) scale3d(${scale},${scale},${scale})`;
    this.transformRes.transformText = this.preEndTransformRes.transformText = text;
    this.onTransform(this.transformRes);
  }

  /** 允许的最小缩放比例（默认 0.1，防止元素被捏成负数倒置或缩小到 0 丢失） */
  public minScale = 0.1;
  /** 允许的最大缩放比例（默认 10 倍） */
  public maxScale = 10;

  /** rAF 动画帧 ID 与待处理的手势位移缓存（实现 60/120Hz 渲染节流） */
  private rafId = 0;
  private pendingMoveObj: { points: IGesturePoint[]; rotate: number; scale: number } | null = null;

  /**
   * 核心变换计算函数
   *
   * 根据当前触摸点、旋转角度和缩放倍率，计算最新平移与形变。
   * 内部严格保持仿射变换矩阵的坐标补偿推导，保证旋转缩放时中心点不飘移。
   *
   * @param obj.points - 当前触摸点数组
   * @param obj.rotate - 相对于手势开始时的旋转增量（弧度）
   * @param obj.scale - 相对于手势开始时的缩放倍数
   */
  public transform(obj: { points: IGesturePoint[]; rotate: number; scale: number }) {
    this.beforeTransform(obj, this.transformRes);
    const { points, rotate, scale } = obj;

    // 1. 基础缩放边界限制（限制在 [minScale, maxScale] 内）
    let effectiveScale = scale;
    const targetScale = this.preEndTransformRes.scale * scale;
    if (targetScale < this.minScale) {
      effectiveScale = this.minScale / (this.preEndTransformRes.scale || 1);
    } else if (targetScale > this.maxScale) {
      effectiveScale = this.maxScale / (this.preEndTransformRes.scale || 1);
    }

    // 2. 计算基准点经过旋转和缩放变换后的相对偏移，用以补偿平移量
    const afterRotatePoint = this.afterRotate(this.startPoints.points[0] || points[0], rotate, effectiveScale);

    // 3. 计算最终平移、旋转与缩放（叠加上一轮手势锁存的值）
    this.transformRes.translateX = points[0].x - afterRotatePoint.x + this.preEndTransformRes.translateX;
    this.transformRes.translateY = points[0].y - afterRotatePoint.y + this.preEndTransformRes.translateY;
    this.transformRes.rotate = rotate + this.preEndTransformRes.rotate;
    this.transformRes.scale = this.preEndTransformRes.scale * effectiveScale;

    // 4. 组装 CSS 变换字符串并触发更新回调
    this.transformRes.transformText = `translate3d(${this.transformRes.translateX}px, ${this.transformRes.translateY}px,0) rotate3d(0, 0, 1,${this.transformRes.rotate}rad) scale3d(${this.transformRes.scale},${this.transformRes.scale},${this.transformRes.scale})`;
    this.onTransform(this.transformRes);
  }

  /**
   * 手势移动处理（touchmove / mousemove）
   *
   * 1. 单指状态：仅计算平移拖拽，保持初始弧度与间距不变。
   * 2. 多指状态：动态计算两点间弧度差与距离比，实现旋转与缩放。
   * 3. 性能优化：使用 requestAnimationFrame 对 DOM 渲染进行帧节流。
   */
  private onMove(ev: TouchEvent | MouseEvent) {
    if (this.disable) return;
    //ev.preventDefault();
    const points = this.getPonits(ev);
    if (points.length < 1) return;

    const isSingleFinger = points.length === 1;
    // 单指时使用初始值（不旋转不缩放），双指时按两点连线几何计算
    const newRad = isSingleFinger ? this.startPoints.rad : Gesture.getRad(points[0], points[1]);
    const newScale = isSingleFinger ? this.startPoints.distance : Gesture.getDistance(points[0], points[1]);

    // 将最新状态存入待渲染队列
    this.pendingMoveObj = {
      points,
      rotate: newRad - this.startPoints.rad,
      scale: newScale / this.startPoints.distance,
    };

    // 如果当前帧尚未预约，注册 requestAnimationFrame 统一在下一屏幕刷新前执行
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        if (this.pendingMoveObj) {
          this.transform(this.pendingMoveObj);
          this.pendingMoveObj = null;
        }
      });
    }
  }

  /** 手势结束延迟判定定时器（用于双击判定时间窗口） */
  private onGestureEndTimer = 0;

  /**
   * 手势结束处理（touchend / mouseup / touchcancel）
   *
   * 1. 抬手时若有挂起的 rAF，立即同步执行结算，确保终态绝对精准。
   * 2. 将当前计算结果更新到 preEndTransformRes 中作为下一次基准。
   * 3. 针对所有触点全部抬起的情况，判断是否属于双击并触发 onGestureEnd。
   * 4. 针对多指转单指的平滑过渡，重置基准点信息。
   */
  private onEnd(ev: TouchEvent | MouseEvent) {
    //ev.preventDefault();

    // 抬手瞬间如果还有未渲染的 rAF，立即同步执行，防止最终松手位置发生回退滞后
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      if (this.pendingMoveObj) {
        this.transform(this.pendingMoveObj);
        this.pendingMoveObj = null;
      }
    }

    // 锁存当前结果作为下次基准
    Object.assign(this.preEndTransformRes, this.transformRes);
    const points = this.getPonits(ev);

    // 判断是否所有手指都已离开屏幕
    if (ev.type === "mouseup" || (ev.type === "touchend" && this.getPonits(ev, true).length === 0)) {
      this.removeAllListener();
      this.isGestureActive = false;
      const transformRes = { ...this.transformRes };
      const startPoints = { ...this.startPoints };
      const now = performance.now();

      // 双击时间窗口判断
      if (now > this.lastClickPoint.expire || this.lastClickPoint.type === "firstPoint") {
        this.lastClickPoint.expire = 0;
        this.lastClickPoint.type = "";
        this.onGestureEndTimer && clearTimeout(this.onGestureEndTimer);
        this.onGestureEndTimer = 0;
        this.onGestureEnd(transformRes, startPoints);
      } else {
        // 第一次点击后等待 350ms，若无第 2 次点击则触发常规结束
        this.lastClickPoint.expire = now + 300;
        this.lastClickPoint.type = "firstPoint";
        this.onGestureEndTimer = Number(
          setTimeout(() => {
            this.onGestureEndTimer = 0;
            if (this.isGestureActive) return;
            this.onGestureEnd(transformRes, startPoints);
          }, 350)
        );
      }
    }

    // 更新剩余触点基准（多指抬起其中一只手指时，无缝降级为剩余手指的基准点，防止画面跳跃）
    this.startPoints.points = points;
    this.startPoints.rad = 0;
    this.startPoints.distance = 1;
    if (points.length >= 2) {
      this.startPoints.rad = Gesture.getRad(points[0], points[1]);
      this.startPoints.distance = Gesture.getDistance(points[0], points[1]);
    }
  }

  /**
   * 鼠标滚轮缩放 / 双击缩放处理
   *
   * 使用标准 deltaY 属性（正值向下滚 = 缩小 0.7 倍；负值向上滚 = 放大 1.5 倍）
   */
  private onScale(ev: WheelEvent | MouseEvent) {
    if (this.disable) return;
    const points = this.getPonits(ev);

    // 滚轮连续滚动防抖：滚动停止 10ms 后触发 onGestureEnd
    this.onGestureEndTimer && clearTimeout(this.onGestureEndTimer);
    this.onGestureEndTimer = Number(
      setTimeout(() => {
        this.onGestureEndTimer = 0;
        if (this.isGestureActive) return;
        this.onGestureEnd(this.transformRes, this.startPoints);
      }, 10)
    );

    // 内联保存变换状态为基准
    Object.assign(this.preEndTransformRes, this.transformRes);
    this.startPoints.points = points;
    this.startPoints.rad = 0;
    this.startPoints.distance = 1;

    // deltaY > 0 为向下滚轮（缩小），反之放大
    this.transform({ points, rotate: 0, scale: ev instanceof WheelEvent ? (ev.deltaY > 0 ? 0.7 : 1.5) : 1.5 });
  }

  /**
   * 手势按下初始处理（touchstart / mousedown）
   *
   * 1. 记录手势激活状态，清除待执行的延迟结束定时器。
   * 2. 执行双击时间窗口检测。
   * 3. 挂载 window 全局 move、up、cancel、blur 监听器。
   */
  private onStart(ev: TouchEvent | MouseEvent) {
    if (this.disable) return;
    this.isGestureActive = true;
    this.onGestureEndTimer && clearTimeout(this.onGestureEndTimer);
    this.onGestureEndTimer = 0;
    const points = this.getPonits(ev);

    // 双击检测判定
    if (points.length === 1) {
      const now = performance.now();
      if (now > this.lastClickPoint.expire || this.lastClickPoint.type === "") {
        this.lastClickPoint.x = points[0].x;
        this.lastClickPoint.y = points[0].y;
        this.lastClickPoint.expire = now + 300;
        this.lastClickPoint.type = "start";
      } else {
        // 在 300ms 内再次按下，确认进入连续双击手势
        this.lastClickPoint.expire = Infinity;
      }
    }

    this.onEnd(ev);
    this.onGestureStart(this.transformRes, this.startPoints);
    this.removeAllListener();
    this.addAllListener();
  }

  /** 浏览器窗口失焦处理：防止鼠标移出浏览器外松开后手势卡死 */
  private onWindowBlurListener = () => {
    if (this.isGestureActive) {
      this.onEnd(new MouseEvent("mouseup"));
    }
  };

  /** 挂载全局手势追踪事件（绑在 window 上，保证手指/鼠标滑出元素范围后依然可平滑跟踪） */
  private addAllListener() {
    window.addEventListener("touchmove", this.onMoveListener, false);
    window.addEventListener("mousemove", this.onMoveListener, false);
    window.addEventListener("touchend", this.onEndListener, false);
    window.addEventListener("touchcancel", this.onEndListener, false);
    window.addEventListener("mouseup", this.onEndListener, false);
    window.addEventListener("blur", this.onWindowBlurListener, false);
  }

  /** 移除全局手势追踪事件 */
  private removeAllListener() {
    window.removeEventListener("touchmove", this.onMoveListener, false);
    window.removeEventListener("mousemove", this.onMoveListener, false);
    window.removeEventListener("touchend", this.onEndListener, false);
    window.removeEventListener("touchcancel", this.onEndListener, false);
    window.removeEventListener("mouseup", this.onEndListener, false);
    window.removeEventListener("blur", this.onWindowBlurListener, false);
  }

  // ==========================================
  // 公共监听器引用（已预绑定 this 上下文）
  // ==========================================

  /** 按下监听器（可传给 touchstart / mousedown） */
  public onStartListener: (ev: TouchEvent | MouseEvent) => void;
  /** 移动监听器（内部使用） */
  private onMoveListener: (ev: TouchEvent | MouseEvent) => void;
  /** 结束监听器（内部使用） */
  private onEndListener: (ev: TouchEvent | MouseEvent) => void;
  /** 缩放监听器（可传给 wheel / dblclick） */
  public onScaleListener: (ev: WheelEvent | MouseEvent) => void;

  // ==========================================
  // 公共回调与外部配置勾子
  // ==========================================

  /** 每次变换更新时的回调（已绑定 DOM 时会自动将 transformText 赋予样式） */
  public onTransform = (transformRes: IGestureTransformRes): void => {};
  /** 手势开始时的回调 */
  public onGestureStart = (transformRes: IGestureTransformRes, startPoints: Gesture["startPoints"]): void => {};
  /** 手势彻底结束时的回调（所有触点离开且通过双击窗口确认后触发，适合处理回弹/吸附动画） */
  public onGestureEnd = (transformRes: IGestureTransformRes, startPoints: Gesture["startPoints"]): void => {};
  /** 是否正在进行手势交互 */
  public isGestureActive = false;
  /** 变换执行前的预处理回调（外部可在此动态修改 obj.rotate 或 obj.scale 进行干预） */
  public beforeTransform = (
    obj: { points: IGesturePoint[]; rotate: number; scale: number },
    transformRes: IGestureTransformRes
  ): void => {};
  /** 是否禁用全部手势响应 */
  public disable = false;

  /**
   * 从原生 TouchEvent / MouseEvent 事件中提取当前触摸点坐标
   * @param ev 原生事件对象
   * @param getRaw 是否获取未经处理的原始点数据（内部双击判定时使用）
   */
  public getPonits(ev: TouchEvent | MouseEvent, getRaw = false): IGesturePoint[] {
    const out: IGesturePoint[] = [];
    if (ev instanceof TouchEvent) {
      for (const { clientX, clientY } of ev.touches) {
        out.push({ x: clientX, y: clientY });
      }
    } else {
      out.push({ x: ev.clientX, y: ev.clientY });
    }
    // 双击单指拖动时，注入上一次的锚点作为虚拟副触点，实现单指捏合模拟
    if (!getRaw && out.length === 1 && this.lastClickPoint.expire === Infinity) {
      out.unshift({ x: this.lastClickPoint.x, y: this.lastClickPoint.y });
    }
    return out;
  }

  /** 计算两点连线相对于水平 X 轴的弧度角 (atan2) */
  public static getRad = (p1: IGesturePoint, p2: IGesturePoint) => Math.atan2(p2.y - p1.y, p2.x - p1.x);

  /** 计算两点间的欧几里得几何直线距离 */
  public static getDistance = (p1: IGesturePoint, p2: IGesturePoint) =>
    Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));

  /**
   * 计算指定点绕 transformOrigin 旋转特定弧度并缩放后的坐标点
   * 用于补偿由于元素旋转和缩放造成的视觉轴心飘移，维持手指触摸点与图形对应位置相对静止
   *
   * 参考数学推导：https://blog.csdn.net/weixin_34910922/article/details/121569340
   */
  public afterRotate(p: IGesturePoint, rad: number, scale: number): IGesturePoint {
    const x = p.x - this.transformOrigin.x - this.preEndTransformRes.translateX;
    const y = p.y - this.transformOrigin.y - this.preEndTransformRes.translateY;
    return {
      x: (Math.cos(rad) * x - Math.sin(rad) * y) * scale + this.transformOrigin.x + this.preEndTransformRes.translateX,
      y: (Math.sin(rad) * x + Math.cos(rad) * y) * scale + this.transformOrigin.y + this.preEndTransformRes.translateY,
    };
  }
}

// ==========================================
// 使用示例 (Usage Examples)
// ==========================================

/*
// ------------------------------------------
// 示例 1：普通元素/图片 直接传入 constructor 自动绑定 + 屏幕自适应
// ------------------------------------------
const img = new Image();
img.src = "https://t7.baidu.com/it/u=2621658848,3952322712&fm=193";
img.onload = () => {
  document.body.appendChild(img);

  // 极简使用：new Gesture(dom) 一步到位，自动修改样式、绑定监听、自适应屏幕居中
  const gesture = new Gesture(img);

  // 监听手势结束，增加吸附/边界回弹逻辑
  gesture.onGestureEnd = (transformRes, startPoints) => {
    // 限制最大缩放为 3 倍，最小为 0.5 倍
    let scale = 1;
    if (transformRes.scale > 3) {
      scale = 3 / transformRes.scale;
    } else if (transformRes.scale < 0.5) {
      scale = 0.5 / transformRes.scale;
    }
    if (scale !== 1) {
      img.style.transition = "transform 0.2s";
      gesture.disable = true;
      gesture.transform({ points: startPoints.points, scale, rotate: 0 });
    }
  };

  img.ontransitionend = () => {
    img.style.transition = "";
    gesture.disable = false;
  };

  // 屏幕旋转或窗口缩放时，可再次调用 fitToScreen 自动重新居中
  window.addEventListener("resize", () => {
    gesture.fitToScreen();
  });
};

// ------------------------------------------
// 示例 2：针对初始隐藏的 DOM（display: none）
// ------------------------------------------
const hiddenDiv = document.createElement("div");
hiddenDiv.style.display = "none";
hiddenDiv.style.width = "1200px";
hiddenDiv.style.height = "800px";
hiddenDiv.style.background = "#333";
document.body.appendChild(hiddenDiv);

// constructor 内部支持隐藏元素测量真实尺寸，测量过程不会在屏幕上闪烁
const gestureHidden = new Gesture(hiddenDiv);

// 后续显示该元素
hiddenDiv.style.display = "block";

// ------------------------------------------
// 示例 3：纯数学模式（保留原有向后兼容用法）
// ------------------------------------------
// const gestureManual = new Gesture({ x: 100, y: 100 });
// myEl.addEventListener("touchstart", gestureManual.onStartListener);

// ------------------------------------------
// 示例 4：WebRTC 视频流动态分辨率无缝更新（业务方峰值锁定 + Gesture 比例自适应）
// ------------------------------------------
// const video = document.querySelector("video")!;
// const gesture = new Gesture(video, false);
//
// // 业务方自行维护峰值锁定逻辑
// let peakWidth = 0;
// let peakHeight = 0;
//
// const onResize = () => {
//   const newW = video.videoWidth;
//   const newH = video.videoHeight;
//   if (!newW || !newH) return;
//
//   // 峰值锁定：只增不降，低码率时不缩回
//   const oldW = peakWidth || newW;
//   const oldH = peakHeight || newH;
//   peakWidth = Math.max(peakWidth, newW);
//   peakHeight = Math.max(peakHeight, newH);
//
//   // 仅当峰值真正变化时才通知 Gesture 更新
//   if (peakWidth !== oldW || peakHeight !== oldH) {
//     gesture.updateSize(oldW, oldH, peakWidth, peakHeight);
//   }
// };
// video.addEventListener("resize", onResize);
// video.addEventListener("loadedmetadata", onResize);
*/
