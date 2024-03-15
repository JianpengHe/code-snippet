export type IGesturePoint = { x: number; y: number };
export type IGestureTransformRes = {
  translateX: number;
  translateY: number;
  rotate: number;
  scale: number;
  transformText: string;
};
export class Gesture {
  constructor(transformOrigin: IGesturePoint = { x: 0, y: 0 }) {
    this.transformOrigin = transformOrigin;
    this.onStartListener = this.onStart.bind(this);
    this.onMoveListener = this.onMove.bind(this);
    this.onEndListener = this.onEnd.bind(this);
    this.onScaleListener = this.onScale.bind(this);
  }
  private readonly transformRes: IGestureTransformRes = {
    translateX: 0,
    translateY: 0,
    rotate: 0,
    scale: 1,
    transformText: ``,
  };
  private readonly preEndTransformRes: IGestureTransformRes = {
    translateX: 0,
    translateY: 0,
    rotate: 0,
    scale: 1,
    transformText: ``,
  };
  private readonly transformOrigin: IGesturePoint;
  private startPoints: { rad: number; distance: number; points: IGesturePoint[] } = { points: [], rad: 0, distance: 0 };

  private lastClickPoint: IGesturePoint & { expire: number; type: string } = { x: 0, y: 0, expire: 0, type: "" };
  public transform(obj: { points: IGesturePoint[]; rotate: number; scale: number }) {
    this.beforeTransform(obj, this.transformRes);
    const { points, rotate, scale } = obj;
    const afterRotatePoint = this.afterRotate(this.startPoints.points[0] || points[0], rotate, scale);
    this.transformRes.translateX = points[0].x - afterRotatePoint.x + this.preEndTransformRes.translateX;
    this.transformRes.translateY = points[0].y - afterRotatePoint.y + this.preEndTransformRes.translateY;
    this.transformRes.rotate = rotate + this.preEndTransformRes.rotate;
    this.transformRes.scale = this.preEndTransformRes.scale * scale;
    this.transformRes.transformText = `translate3d(${this.transformRes.translateX}px, ${this.transformRes.translateY}px,0) rotate3d(0, 0, 1,${this.transformRes.rotate}rad) scale3d(${this.transformRes.scale},${this.transformRes.scale},${this.transformRes.scale})`;
    this.onTransform(this.transformRes);
  }
  private onMove(ev: TouchEvent | MouseEvent) {
    if (this.disable) return;
    ev.preventDefault();
    const points = this.getPonits(ev);
    if (points.length < 1) return;
    const isSingleFinger = points.length === 1;
    const newRad = isSingleFinger ? this.startPoints.rad : Gesture.getRad(points[0], points[1]);
    const newScale = isSingleFinger ? this.startPoints.distance : Gesture.getDistance(points[0], points[1]);
    return this.transform({
      points,
      rotate: newRad - this.startPoints.rad,
      scale: newScale / this.startPoints.distance,
    });
  }
  private onGestureEndTimer = 0;
  private onEnd(ev: TouchEvent | MouseEvent) {
    ev.preventDefault();
    for (const k in this.transformRes) {
      this.preEndTransformRes[k] = this.transformRes[k];
    }
    const points = this.getPonits(ev);

    if (ev.type === "mouseup" || (ev.type === "touchend" && this.getPonits(ev, true).length === 0)) {
      this.removeAllListener();
      this.isGestureActive = false;
      const transformRes = { ...this.transformRes };
      const startPoints = { ...this.startPoints };
      const now = performance.now();
      if (now > this.lastClickPoint.expire || this.lastClickPoint.type === "firstPoint") {
        this.lastClickPoint.expire = 0;
        this.lastClickPoint.type = "";
        this.onGestureEndTimer && clearTimeout(this.onGestureEndTimer);
        this.onGestureEndTimer = 0;
        this.onGestureEnd(transformRes, startPoints);
      } else {
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
    this.startPoints.points = points;
    this.startPoints.rad = 0;
    this.startPoints.distance = 1;
    if (points.length >= 2) {
      this.startPoints.rad = Gesture.getRad(points[0], points[1]);
      this.startPoints.distance = Gesture.getDistance(points[0], points[1]);
    }
  }
  private onScale(ev: WheelEvent | MouseEvent) {
    if (this.disable) return;
    const points = this.getPonits(ev);
    this.onGestureEndTimer && clearTimeout(this.onGestureEndTimer);
    this.onGestureEndTimer = Number(
      setTimeout(() => {
        this.onGestureEndTimer = 0;
        if (this.isGestureActive) return;
        this.onGestureEnd(this.transformRes, this.startPoints);
      }, 10)
    );
    if (ev instanceof WheelEvent) this.onEnd(ev);
    this.transform({ points, rotate: 0, scale: (ev["wheelDeltaY"] || 0) < 0 ? 0.7 : 1.5 });
  }

  private onStart(ev: TouchEvent | MouseEvent) {
    if (this.disable) return;
    this.isGestureActive = true;
    this.onGestureEndTimer && clearTimeout(this.onGestureEndTimer);
    this.onGestureEndTimer = 0;
    const points = this.getPonits(ev);
    if (points.length === 1) {
      const now = performance.now();
      if (now > this.lastClickPoint.expire || this.lastClickPoint.type === "") {
        this.lastClickPoint.x = points[0].x;
        this.lastClickPoint.y = points[0].y;
        this.lastClickPoint.expire = now + 300;
        this.lastClickPoint.type = "start";
      } else {
        this.lastClickPoint.expire = Infinity;
      }
    }
    this.onEnd(ev);
    this.onGestureStart(this.transformRes, this.startPoints);
    this.removeAllListener();
    this.addAllListener();
  }

  private addAllListener() {
    window.addEventListener("touchmove", this.onMoveListener, false);
    window.addEventListener("mousemove", this.onMoveListener, false);
    window.addEventListener("touchend", this.onEndListener, false);
    window.addEventListener("mouseup", this.onEndListener, false);
  }

  private removeAllListener() {
    window.removeEventListener("touchmove", this.onMoveListener, false);
    window.removeEventListener("mousemove", this.onMoveListener, false);
    window.removeEventListener("touchend", this.onEndListener, false);
    window.removeEventListener("mouseup", this.onEndListener, false);
  }

  public onStartListener: (ev: TouchEvent | MouseEvent) => void;
  private onMoveListener: (ev: TouchEvent | MouseEvent) => void;
  private onEndListener: (ev: TouchEvent | MouseEvent) => void;
  public onScaleListener: (ev: WheelEvent | MouseEvent) => void;
  public onTransform = (transformRes: IGestureTransformRes): void => {};
  public onGestureStart = (transformRes: IGestureTransformRes, startPoints: Gesture["startPoints"]): void => {};
  public onGestureEnd = (transformRes: IGestureTransformRes, startPoints: Gesture["startPoints"]): void => {};
  /** 是否正在手势动作 */
  public isGestureActive = false;
  /** 旋转/缩放前回调 */
  public beforeTransform = (
    obj: { points: IGesturePoint[]; rotate: number; scale: number },
    transformRes: IGestureTransformRes
  ): void => {};
  /** 是否禁用 */
  public disable = false;

  /** 从原生事件里获取坐标 */
  public getPonits(ev: TouchEvent | MouseEvent, getRaw = false): IGesturePoint[] {
    const out: IGesturePoint[] = [];
    if (ev instanceof TouchEvent) {
      for (const { clientX, clientY } of ev.touches) {
        out.push({ x: clientX, y: clientY });
      }
    } else {
      out.push({ x: ev.clientX, y: ev.clientY });
    }
    if (!getRaw && out.length === 1 && this.lastClickPoint.expire === Infinity) {
      out.unshift({ x: this.lastClickPoint.x, y: this.lastClickPoint.y });
    }
    return out;
  }
  /** 获取两点组成的线段的弧度 */
  public static getRad = (p1: IGesturePoint, p2: IGesturePoint) => Math.atan2(p2.y - p1.y, p2.x - p1.x);
  /** 两点间距离 */
  public static getDistance = (p1: IGesturePoint, p2: IGesturePoint) =>
    Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
  /** 旋转后的新坐标 */
  public afterRotate(p: IGesturePoint, rad: number, scale: number): IGesturePoint {
    const x = p.x - this.transformOrigin.x - this.preEndTransformRes.translateX;
    const y = p.y - this.transformOrigin.y - this.preEndTransformRes.translateY;
    /** 参考：https://blog.csdn.net/weixin_34910922/article/details/121569340 */
    return {
      x: (Math.cos(rad) * x - Math.sin(rad) * y) * scale + this.transformOrigin.x + this.preEndTransformRes.translateX,
      y: (Math.sin(rad) * x + Math.cos(rad) * y) * scale + this.transformOrigin.y + this.preEndTransformRes.translateY,
    };
  }
}

/** 测试用例 */
// const img = new Image();
// img.src = "https://t7.baidu.com/it/u=2621658848,3952322712&fm=193";
// img.onload = () => {
//   const origin = { x: 100, y: 100 };
//   img.style.transformOrigin = `${origin.x}px ${origin.y}px`;
//   img.style.position = "fixed";
//   img.style.left = "0";
//   img.style.top = "0";
//   document.body.appendChild(img);

//   const gesture = new Gesture(origin);
//   img.addEventListener("touchstart", gesture.onStartListener, false);
//   img.addEventListener("mousedown", gesture.onStartListener, false);
//   img.addEventListener("wheel", gesture.onScaleListener, false);
//   img.addEventListener("dblclick", gesture.onScaleListener, false);
//   gesture.onTransform = ({ transformText }) => {
//     img.style.transform = transformText;
//   };
//   gesture.beforeTransform = obj => {
//     // obj.rotate = 0;
//   };
//   gesture.onGestureEnd = (transformRes, startPoints) => {
//     console.log("onGestureEnd");
//     /** 限制旋转角度 */
//     let rotate = transformRes.rotate / (Math.PI / 2);
//     rotate = Math.round(rotate) * (Math.PI / 2) - transformRes.rotate;

//     /** 限制最大缩放 */
//     let scale = 1;
//     if (transformRes.scale > 3) {
//       scale = 3 / transformRes.scale;
//     } else if (transformRes.scale < 0.3) {
//       scale = 0.3 / transformRes.scale;
//     }
//     if (rotate || scale !== 1) {
//       img.style.transition = "transform 0.2s";
//       gesture.disable = true;
//       gesture.transform({ points: startPoints.points, scale, rotate });
//     }
//   };
//   img.ontransitionend = () => {
//     img.style.transition = "";
//     gesture.disable = false;
//   };
// };
