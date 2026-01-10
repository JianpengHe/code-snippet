const registerProcessorName = "audioInputOutput";

/**
 * AudioWorklet 注册函数
 * 通过字符串注入到 worklet 线程中执行
 */
const registerProcessorFn = String((registerProcessorName: string, blockSize: number) => {
  /** AudioWorklet 固定处理帧大小（Web Audio 规范规定） */
  const FRAME_SIZE = 128;

  /**
   * =======================
   * 播放 / 抖动控制参数
   * =======================
   */

  /**
   * 启动播放时的初始缓冲帧数
   * 40 * 128 ≈ 5333 samples ≈ 111ms
   *
   * 用于：
   * - 首次播放
   * - 网络流重启后重新对齐
   */
  const INITIAL_BUFFER_FRAMES = 40 * FRAME_SIZE;

  /**
   * 触发播放时间轴调整的最小差值
   * 小于该值认为是正常波动，不做调整
   */
  const MIN_DIFF_FRAME = 25 * FRAME_SIZE;

  /**
   * 单次允许向前追赶的最大帧数
   * 防止一次性跳太多导致明显听感突变
   */
  const MAX_DIFF_FRAME = 100 * FRAME_SIZE;

  /**
   * 抖动统计周期
   * 每累计这么多“网络时间轴推进量”后，进行一次延迟评估
   */
  const STATISTIC_CYCLE_FRAME = 2400 * FRAME_SIZE;

  /**
   * 在抖动基础上额外预留的安全帧
   * 用于防止刚好追到边界又发生抖动
   */
  const MAX_JITTER_ADD_FRAME = 5 * FRAME_SIZE;

  //@ts-ignore
  registerProcessor(
    registerProcessorName,
    //@ts-ignore
    class extends AudioWorkletProcessor {
      /**
       * 输入采集缓冲区
       * 用于将多次 128 帧拼成一个 blockSize 再 postMessage
       */
      private inputBuffer = new Float32Array(blockSize);
      private inputBufferIndex = 0;

      /**
       * 播放缓存
       * key   : 帧编号（以 128 为单位对齐）
       * value : 对应的 Float32Array(128)
       */
      private playbackBuffer = new Map<number, Float32Array>();

      /**
       * 当前播放到的帧编号（播放时间轴）
       * 只允许向前推进，不允许回退
       */
      private currentPlayFrame = Infinity;

      /**
       * 网络侧最近一次收到的帧编号
       * 用于判断网络流是否重启
       */
      private latestNetworkFrame = 0;

      /**
       * 网络侧“期望帧编号”
       * 表示当前网络时间轴走到哪里
       * ❗不在 process() 中推进
       */
      private latestExpectedFrame = 0;

      /**
       * 上一次计算得到的延迟
       * 用于计算 jitter（延迟变化量）
       */
      private lastLatency = 0;

      /**
       * 当前统计周期内观测到的最大抖动
       */
      private maxObservedJitter = 0;

      /**
       * 抖动统计周期的起始帧
       */
      private latencyStatStartFrame = 0;
      /** 播放失同步连续计数 */
      private desyncCount = 0;

      /** 触发失同步修复的阈值 */
      private readonly DESYNC_THRESHOLD = 5;
      constructor() {
        super();
        //@ts-ignore
        this.port.onmessage = this.handleIncomingBuffer.bind(this);
      }

      /**
       * 接收主线程送来的播放数据（网络 / 回环音频）
       */
      private handleIncomingBuffer({ data }: MessageEvent) {
        const buffer: Float32Array = data.buffer;

        /**
         * 将帧编号强制对齐到 128
         * 确保和 AudioWorklet 的 process 节拍一致
         */
        const frameIndex = Math.floor(data.frameIndex / FRAME_SIZE) * FRAME_SIZE;

        /**
         * ===== 初始化播放时间轴 =====
         * 第一次收到数据时，建立播放起点
         * 向后预留 INITIAL_BUFFER_FRAMES 作为启动缓存
         */
        if (this.currentPlayFrame === Infinity) {
          this.currentPlayFrame = frameIndex - INITIAL_BUFFER_FRAMES;
          this.latestExpectedFrame = frameIndex;
          this.latencyStatStartFrame = frameIndex;
        }
        /**
         * ===== 播放时间轴失同步检测（温和版）=====
         *
         * 判断条件：
         * 1. 即使加上启动缓冲，网络帧仍明显落后于播放帧
         * 2. 连续多次出现该情况
         */
        if (frameIndex + INITIAL_BUFFER_FRAMES < this.currentPlayFrame) {
          this.desyncCount++;
        } else {
          this.desyncCount = 0;
        }

        /**
         * 连续多次确认失同步，才认为播放源已换代
         */
        if (this.desyncCount >= this.DESYNC_THRESHOLD) {
          console.log("播放时间轴失同步修复", frameIndex + INITIAL_BUFFER_FRAMES, this.currentPlayFrame);
          this.playbackBuffer.clear();
          this.currentPlayFrame = frameIndex - INITIAL_BUFFER_FRAMES;
          this.latestExpectedFrame = frameIndex;
          this.latencyStatStartFrame = frameIndex;
          this.maxObservedJitter = 0;
          this.lastLatency = 0;
          this.desyncCount = 0;
        }
        /**
         * ===== 网络流重启检测 =====
         * 如果帧编号倒退，认为网络流被重置
         */
        if (frameIndex < this.latestNetworkFrame) {
          this.playbackBuffer.clear();
          this.currentPlayFrame = frameIndex - INITIAL_BUFFER_FRAMES;
          this.latestExpectedFrame = frameIndex;
          this.latencyStatStartFrame = frameIndex;
          this.maxObservedJitter = 0;
          this.lastLatency = 0;
        }

        this.latestNetworkFrame = frameIndex;
        this.latestExpectedFrame = Math.max(this.latestExpectedFrame, frameIndex);

        /**
         * ===== 延迟 / 抖动计算 =====
         *
         * 延迟 = 网络时间轴 - 播放时间轴
         * 抖动 = 延迟的变化量
         */
        const latency = this.latestExpectedFrame - this.currentPlayFrame;
        const jitter = Math.abs(latency - this.lastLatency);
        this.lastLatency = latency;
        this.maxObservedJitter = Math.max(this.maxObservedJitter, jitter);

        /**
         * ===== 周期性自动追帧 =====
         * 每经过一个统计周期，根据抖动情况决定是否需要缩短延迟
         */
        if (this.latestExpectedFrame - this.latencyStatStartFrame > STATISTIC_CYCLE_FRAME) {
          /**
           * 理想的播放帧位置：
           * 网络最新帧 -（抖动 + 安全帧）
           */
          let expectPlayFrame =
            this.latestExpectedFrame - (Math.min(MAX_DIFF_FRAME, this.maxObservedJitter) + MAX_JITTER_ADD_FRAME);

          const diff = expectPlayFrame - this.currentPlayFrame;

          /**
           * 只有当差值超过最小阈值，才进行调整
           */
          if (Math.abs(diff) > MIN_DIFF_FRAME && diff > 0) {
            /**
             * 控制追帧幅度，避免一次跳太多
             */
            const advance =
              diff > MIN_DIFF_FRAME * 2 ? diff - MIN_DIFF_FRAME : Math.floor(diff / FRAME_SIZE / 2) * FRAME_SIZE;

            const newPlayFrame = this.currentPlayFrame + advance;

            /**
             * 删除被跳过的缓存帧
             */
            for (let i = this.currentPlayFrame; i < newPlayFrame; i += FRAME_SIZE) {
              this.playbackBuffer.delete(i);
            }

            this.currentPlayFrame = newPlayFrame;
          }

          /**
           * 重置统计周期
           */
          this.latencyStatStartFrame = this.latestExpectedFrame;
          this.maxObservedJitter = 0;
        }

        /**
         * ===== 缓存音频数据 =====
         * 按 128 帧切片存入播放缓存
         */
        for (let i = 0; i < buffer.length; i += FRAME_SIZE) {
          const chunkFrame = frameIndex + i;
          if (chunkFrame < this.currentPlayFrame) continue;
          this.playbackBuffer.set(chunkFrame, buffer.subarray(i, i + FRAME_SIZE));
        }

        /**
         * 防止缓存无限增长（兜底保护）
         */
        if (this.playbackBuffer.size > 3000) {
          this.playbackBuffer.clear();
        }
      }

      /**
       * AudioWorklet 实时处理函数
       * 每次调用固定处理 128 帧
       */
      process(inputs: Float32Array[][], outputs: Float32Array[][]) {
        const inputData = inputs[0]?.[0];

        /**
         * ===== 录音采集 =====
         * 拼接成 blockSize 再发回主线程
         */
        if (inputData) this.inputBuffer.set(inputData, this.inputBufferIndex);
        this.inputBufferIndex += FRAME_SIZE;

        if (this.inputBufferIndex === this.inputBuffer.length) {
          //@ts-ignore
          this.port.postMessage({
            buffer: this.inputBuffer,
            lastReceivedFrame: this.latestNetworkFrame,
            currentPlayFrame: this.currentPlayFrame,
            playbackBufferSize: this.playbackBuffer.size,
            maxObservedJitter: this.maxObservedJitter,
            // @ts-ignore
            sampleRate,
          });
          this.inputBufferIndex = 0;
        }

        /**
         * ===== 播放 =====
         * 根据当前播放时间轴取出对应帧
         */
        const chunk = this.playbackBuffer.get(this.currentPlayFrame);

        if (chunk) {
          for (const output of outputs[0]) output.set(chunk);
        } else {
          // 丢帧时输出静音，但播放时间轴仍然前进
          for (const output of outputs[0]) output.fill(0);
        }

        /**
         * 播放完成后推进播放时间轴
         */
        this.playbackBuffer.delete(this.currentPlayFrame);
        this.currentPlayFrame += FRAME_SIZE;

        return true;
      }
    }
  );
});

export class AudioInputOutputProcessor {
  public readonly audioContext: AudioContext;
  public audioNode?: AudioWorkletNode;
  public readonly initing: Promise<void>;

  constructor(
    mediaStream?: MediaStream,
    blockSize = 512,
    ctx = new AudioContext({
      sampleRate: 48000, // 强制要求浏览器以此频率运行 Worklet
    })
  ) {
    this.audioContext = ctx;

    const objectUrl = URL.createObjectURL(
      new Blob([`(${registerProcessorFn})("${registerProcessorName}",${blockSize})`], {
        type: "application/javascript; charset=utf-8",
      })
    );

    this.initing = ctx.audioWorklet.addModule(objectUrl);
    this.initing.finally(() => URL.revokeObjectURL(objectUrl));

    this.initing.then(() => {
      this.audioNode = new AudioWorkletNode(ctx, registerProcessorName);
      if (mediaStream) ctx.createMediaStreamSource(mediaStream).connect(this.audioNode);
      this.audioNode.connect(ctx.destination);
      this.audioNode.port.onmessage = ({ data }) =>
        this.onInputData(
          data.buffer,
          data.lastReceivedFrame,
          data.currentPlayFrame,
          data.playbackBufferSize,
          data.maxObservedJitter,
          data.sampleRate
        );
    });

    const resume = () => ctx.resume();
    window.addEventListener("click", resume, { once: true });
  }

  // 可由外部覆盖
  public onInputData(
    buffer: Float32Array,
    lastReceivedFrame: number,
    currentPlayFrame: number,
    playbackBufferSize: number,
    maxObservedJitter: number,
    sampleRate: number
  ) {
    console.log(
      "onInputData",
      buffer,
      lastReceivedFrame,
      currentPlayFrame,
      playbackBufferSize,
      maxObservedJitter,
      sampleRate
    );
  }

  /**
   * 主线程向 AudioWorklet 推送播放数据
   */
  public pushOutputData(buffer: Float32Array, frameIndex: number) {
    this.audioNode?.port.postMessage({ frameIndex, buffer });
  }
}

// 测试用例
// const blockSize = 512;
// navigator.mediaDevices
//   .getUserMedia({
//     audio: {
//       sampleRate: 48000,
//       sampleSize: 16,
//       autoGainControl: false,
//       noiseSuppression: false,
//       echoCancellation: false,
//     },
//   })
//   .then(async mediaStream => {
//     const audioInputOutputProcessor = new AudioInputOutputProcessor(mediaStream, blockSize);
//     let frameIndex = 0;
//     audioInputOutputProcessor.onInputData = (
//       buffer,
//       lastReceivedFrame,
//       currentPlayFrame,
//       playbackBufferSize,
//       maxObservedJitter
//     ) => {
//       if (Math.floor(currentPlayFrame / blockSize) % 20 === 0) {
//         document.body.innerHTML = `${new Date().toLocaleTimeString()} 当前缓存帧数: ${playbackBufferSize}，延迟 ${(
//           (lastReceivedFrame - currentPlayFrame) /
//           48
//         ).toFixed(2)}ms，最大网络抖动 ${(maxObservedJitter / 48).toFixed(2)}ms`;
//       }
//       /** 把麦克风数据送到扬声器 */
//       audioInputOutputProcessor.pushOutputData(buffer, frameIndex);
//       frameIndex += buffer.length;
//     };
//   });
