/**
 * PlayPCMAudio
 *
 * 这是一个基于 Web Audio API 的 PCM 音频播放器类，
 * 可将实时传入的 Float32Array PCM 数据分块缓冲并连续播放。
 */
export class PlayPCMAudio {
  /** 播放延迟，s，用于预先填充缓冲区再开始播放 */
  public delay = 0.1;

  /** Web Audio 上下文 */
  public readonly audioContext: AudioContext;
  //   /** 每个缓冲区持续时长，单位秒 */
  //   public readonly durationPerBuffer: number;
  //   /** 采样率 */
  public readonly sampleRate: number;
  //   /** 每个缓冲区帧数 = sampleRate * durationPerBuffer */
  //   public readonly frameCount: number;

  //   /** 队列：每个元素包含一个缓冲区数据和对应的 AudioBufferSourceNode */
  //   private sources: { buffer: Float32Array; source: AudioBufferSourceNode }[] = [];

  /** 写入过的 PCM 样本总数 */
  private curSample = 0;

  /** 播放状态：0=未开始，1=播放中，2=已关闭 */
  private playState = 0;
  /** 第一个启动时刻 单位秒 */
  private startTime = 0;

  private readonly sources: AudioBufferSourceNode[] = [];

  private getSource() {
    const source = this.sources.find(({ buffer }) => buffer === null);
    if (source) return source;
    const newSource = this.audioContext.createBufferSource();
    newSource.connect(this.audioContext.destination);
    newSource.onended = () => {
      newSource.buffer = null;
    };
    this.sources.push(newSource);
    return newSource;
  }

  constructor(audioContext: AudioContext = new AudioContext(), sampleRate: number = 48000) {
    this.audioContext = audioContext;
    this.sampleRate = sampleRate;
  }

  /**
   * 接收新的 PCM 音频数据，并写入对应缓冲区
   * @param audioData Float32Array PCM 数据
   */
  public sendData(audioData: Float32Array) {
    if (this.playState === 2) return;
    const sample = audioData.length / 4;
    const now = performance.now() / 1000;
    if (this.playState === 0) {
      this.playState = 1;
      this.startTime = now;
    }
    const nowNeedPlayCurTime = now - this.startTime + this.delay;
    const curSampleCurTime = this.curSample / this.sampleRate;
    console.log(nowNeedPlayCurTime, curSampleCurTime);
    const source = this.getSource();
    source.buffer = this.audioContext.createBuffer(1, audioData.length / 4, this.sampleRate);
    const buffer = source.buffer.getChannelData(0);
    for (let i = 0; i < audioData.length; i++) buffer[i] = audioData[i];
    source.start(nowNeedPlayCurTime - curSampleCurTime);

    this.curSample += sample;
  }

  /**
   * 停止播放，后续将不再接收或播放新数据
   */
  public close() {
    this.playState = 2;
    // 停止所有未播放缓冲区
    this.sources.forEach(source => source.buffer && source.stop());
    this.sources.length = 0;
  }
}
