/**
 * 音频循环播放控制器
 *
 * 设计目标：
 * - 支持 AudioBuffer 任意片段循环播放
 * - 支持 pause / resume 且进度连续
 * - 支持设置 offset（相对于循环片段）
 */
export class PlayAudioBuffer {
  /** 外部传入或内部创建的 AudioContext（通常整个页面只应有一个） */
  private context: AudioContext;

  /** 当前正在播放的 AudioBufferSourceNode（一次性节点） */
  private source: AudioBufferSourceNode | null = null;

  /** 音量控制节点 */
  private gainNode: GainNode;

  /** 当前使用的音频数据 */
  private buffer: AudioBuffer | null = null;

  /** 循环起始点（秒，基于 AudioBuffer 时间轴） */
  private loopStart: number = 0;

  /** 循环结束点（秒，基于 AudioBuffer 时间轴） */
  private loopEnd: number = 0;

  /** 循环片段的时长（loopEnd - loopStart） */
  public duration: number = 0;

  /**
   * 已播放时间快照（秒）
   * - pause 时保存
   * - resume 时作为 offset 使用
   * - 始终基于“循环片段时间轴”
   */
  private playedTime: number = 0;

  /**
   * 本次播放开始时的 AudioContext.currentTime 基准
   * 用于根据 currentTime 推导当前 offset
   */
  private playStartTime: number = 0;

  /**
   * 构造函数
   * @param context 可选：外部传入 AudioContext（推荐）
   * @param volume 初始音量，默认 1
   */
  constructor(context?: AudioContext, volume: number = 1) {
    // 如果外部没有传入，则内部创建（不推荐频繁创建）
    this.context = context ?? new AudioContext();

    // 创建音量节点
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = Math.max(0, volume);

    // 音频最终输出到 destination
    this.gainNode.connect(this.context.destination);
  }

  /**
   * 切换音频数据及循环区间
   * @param audioBuffer 音频数据
   * @param loopStart 循环起点（秒，基于 buffer）
   * @param loopEnd 循环终点（秒，基于 buffer）
   */
  public changeBuffer(audioBuffer: AudioBuffer, loopStart: number = 0, loopEnd?: number) {
    // 如果正在播放，先暂停，确保状态干净
    if (!this.paused) {
      this.pause();
    }

    this.buffer = audioBuffer;

    // 校验并修正循环区间
    const bufferDuration = audioBuffer.duration;

    this.loopStart = Math.max(0, Math.min(loopStart, bufferDuration));
    this.loopEnd = Math.max(this.loopStart, Math.min(loopEnd ?? bufferDuration, bufferDuration));

    // 计算循环时长
    this.duration = this.loopEnd - this.loopStart;

    // 防御：避免 duration === 0 导致后续 NaN
    if (this.duration <= 0) {
      throw new Error("loopEnd 必须大于 loopStart");
    }

    // 重置播放进度
    this.playedTime = 0;
  }

  /**
   * 开始或继续播放
   * @param offset 偏移量（秒，相对于循环片段，而非 buffer 绝对时间）
   */
  public async play(offset: number = this.playedTime) {
    if (!this.buffer) {
      throw new Error("请先调用 changeBuffer 设置音频数据");
    }

    // 如果当前正在播放，先暂停并清理旧的 source
    if (!this.paused) {
      this.pause();
    }

    // 创建新的 AudioBufferSourceNode（一次性）
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;

    // 开启循环，并设置循环区间（基于 buffer 时间轴）
    source.loop = true;
    source.loopStart = this.loopStart;
    source.loopEnd = this.loopEnd;

    // 连接：Source → Gain → Destination
    source.connect(this.gainNode);

    // 处理浏览器自动播放策略
    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    // 修正 offset 范围，避免越界
    offset = Math.min(Math.max(0, offset), this.duration);

    // 实际在 AudioBuffer 中的起始播放点
    const startOffset = this.loopStart + offset;

    // 启动播放
    source.start(0, startOffset);

    // 记录播放基准时间
    this.playStartTime = this.context.currentTime - offset;

    // 保存引用，表示当前处于播放状态
    this.source = source;
  }

  /**
   * 暂停播放
   * - 会记录当前 offset
   * - 销毁当前 SourceNode
   */
  public pause() {
    if (!this.source) return;

    // 在 stop 之前计算当前播放进度（非常关键）
    this.playedTime = this.offset;

    try {
      this.source.stop();
    } catch {
      // 某些浏览器在边界情况下 stop 可能抛异常，忽略即可
    }

    this.source.disconnect();
    this.source = null;
  }

  /**
   * 当前播放进度（秒，范围 0 ~ duration）
   * - paused 时返回已保存的 playedTime
   * - playing 时根据 currentTime 动态计算
   */
  public get offset(): number {
    if (this.paused) {
      return this.playedTime;
    }

    const elapsedTime = this.context.currentTime - this.playStartTime;

    // 对 duration 取模，处理循环回绕
    return elapsedTime % this.duration;
  }

  /**
   * 是否处于暂停状态
   */
  public get paused(): boolean {
    return this.source === null;
  }

  /**
   * 获取当前音量
   */
  public get volume(): number {
    return this.gainNode.gain.value;
  }

  /**
   * 设置音量（>= 0）
   * 实际项目中可改为 setTargetAtTime 以避免爆音
   */
  public set volume(value: number) {
    this.gainNode.gain.value = Math.max(0, value);
  }

  /**
   * 销毁实例
   * 注意：
   * - 如果 AudioContext 是外部传入的，不应在这里 close
   * - 如果是内部创建的，可按需关闭
   */
  public dispose(closeContext: boolean = false) {
    this.pause();

    if (closeContext) {
      this.context.close();
    }
  }
}
