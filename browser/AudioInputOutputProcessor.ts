const registerProcessorName = "audioInputOutput";

const registerProcessorFn = String((registerProcessorName: string, blockSize: number) => {
  /** 播放缓存帧数，用于启动播放延迟 */
  const INITIAL_BUFFER_FRAMES = 40 * 128;
  /** 每次自动调整最小帧数差（尽量缓存30帧再播放，延迟大约83.3ms） */
  const MIN_DIFF_FRAME = 30 * 128;
  /** 每次自动调整最大帧数差(约266ms) */
  const MAX_DIFF_FRAME = 100 * 128;
  /** 统计周期（6.4秒） */
  const STATISTIC_CYCLE_FRAME = 2400 * 128;
  /** 最大抖动额外加上的帧 */
  const MAX_JITTER_ADD_FRAME = 5 * 128;
  //@ts-ignore
  registerProcessor(
    registerProcessorName,
    //@ts-ignore
    class extends AudioWorkletProcessor {
      /** 采集缓存大小（对应一次 postMessage 的数据量） */
      private inputBuffer = new Float32Array(blockSize);
      private inputBufferIndex = 0;

      /** 输出缓冲区，按帧编号缓存 Float32Array */
      private playbackBuffer = new Map<number, Float32Array>();

      /** 当前播放到的帧编号 */
      private currentPlayFrame = Infinity;

      /** 最近接收到的帧编号 */
      private latestReceivedFrame = Infinity;

      /** 期望收到的帧编号 */
      private latestExpectedFrame = 0;

      /** 网络抖动（一个统计周期内的最大网络抖动） */
      private maxObservedJitter = 0;

      /** 统计延迟的起始帧编号 */
      private latencyStatStartFrame = 0;

      constructor() {
        super();
        //@ts-ignore
        this.port.onmessage = this.handleIncomingBuffer.bind(this);
      }

      /** 接收主线程发送的音频数据并缓存 */
      private handleIncomingBuffer({ data }: MessageEvent) {
        const buffer: Float32Array = data.buffer;
        const frameIndex: number = Math.ceil(data.frameIndex / 128) * 128;

        // 如果收到的是旧数据，说明发生了重启
        if (frameIndex < this.latestReceivedFrame) {
          console.warn("音频流重启，清空播放缓存");
          this.playbackBuffer.clear();
          this.currentPlayFrame = frameIndex - INITIAL_BUFFER_FRAMES;
          this.latencyStatStartFrame = 0;
          this.maxObservedJitter = 0;
          this.latestExpectedFrame = 0;
        }
        this.latestExpectedFrame = Math.max(this.latestExpectedFrame, frameIndex);

        // 统计播放延迟
        const currentLatency = this.latestExpectedFrame - frameIndex;
        this.maxObservedJitter = Math.max(this.maxObservedJitter, currentLatency);

        if (this.latestExpectedFrame - this.latencyStatStartFrame > STATISTIC_CYCLE_FRAME) {
          // 如果延迟超过一定阈值，则向前跳过部分帧，降低延迟
          let expectPlayFrame =
            this.latestExpectedFrame - (Math.min(MAX_DIFF_FRAME, this.maxObservedJitter) + MAX_JITTER_ADD_FRAME);
          const diff = expectPlayFrame - this.currentPlayFrame;
          console.log("网络抖动", (this.maxObservedJitter / 48).toFixed(2), "ms", (diff / 48).toFixed(2));
          if (Math.abs(expectPlayFrame - this.currentPlayFrame) > MIN_DIFF_FRAME) {
            if (diff > 0) {
              expectPlayFrame =
                this.currentPlayFrame +
                (diff > MIN_DIFF_FRAME * 2 ? diff - MIN_DIFF_FRAME : Math.floor(diff / 128 / 2) * 128);
              // 播放速度过快，需要提前播放
              for (let i = this.currentPlayFrame; i < expectPlayFrame; i += 128) {
                this.playbackBuffer.delete(i);
              }
            }
            console.log(
              diff > 0 ? "缩短延迟" : "",
              "调整",
              "当前缓存块数",
              this.playbackBuffer.size,
              "最大可调节",
              diff / 128,
              "本次调节",
              (expectPlayFrame - this.currentPlayFrame) / 128
            );
            this.currentPlayFrame = expectPlayFrame;
          }
          this.latestExpectedFrame = frameIndex;
          this.maxObservedJitter = 0;
          this.latencyStatStartFrame = this.latestExpectedFrame;
        }

        // console.log(`当前缓存帧数: ${this.playbackBuffer.size}，延迟 ${(currentLatency / 48).toFixed(2)}ms`);

        // 过期帧数量
        let expiredFrameCount = 0;
        // 将数据按帧切片并缓存
        for (let i = 0; i < buffer.length; i += 128) {
          const chunk = buffer.slice(i, i + 128);
          const chunkFrameIndex = frameIndex + i;

          // 跳过已经播放过的帧
          if (chunkFrameIndex < this.currentPlayFrame) {
            // console.log("跳过过期帧");
            expiredFrameCount++;
            continue;
          }

          this.playbackBuffer.set(chunkFrameIndex, chunk);
        }
        expiredFrameCount && console.log("过期帧数量", expiredFrameCount);

        this.latestReceivedFrame = frameIndex;
        // 控制缓存大小（最多保留 300 帧）
        if (this.playbackBuffer.size > 3000) {
          // console.log([...this.playbackBuffer.keys()]);
          console.warn("播放缓存过大，执行裁剪");
          this.latestReceivedFrame = Infinity;
          // return;
          // const sortedKeys = [...this.playbackBuffer.keys()].sort((a, b) => a - b);
          // const excess = sortedKeys.length - 1000;
          // for (let i = 0; i < excess; i++) {
          //   this.playbackBuffer.delete(sortedKeys[i]);
          // }
        }
      }

      /** 每一帧执行：录音 + 播放 */
      process(inputs: Float32Array[][], outputs: Float32Array[][]) {
        const inputData = inputs[0][0];

        // 采集输入缓冲写入 inputBuffer
        if (inputData) this.inputBuffer.set(inputData, this.inputBufferIndex);
        this.inputBufferIndex += 128;

        // 填满后发送给主线程
        if (this.inputBufferIndex === this.inputBuffer.length) {
          //@ts-ignore
          this.port.postMessage({
            buffer: this.inputBuffer,
            lastReceivedFrame: this.latestReceivedFrame,
            currentPlayFrame: this.currentPlayFrame,
            playbackBufferSize: this.playbackBuffer.size,
            maxObservedJitter: this.maxObservedJitter,
            // @ts-ignore
            sampleRate,
            // t: JSON.stringify({
            //   inputs: inputs.map(a => a.map(b => b.length)),
            //   outputs: outputs.map(a => a.map(b => b.length)),
            // }),
          });
          this.inputBufferIndex = 0;
        }

        // 播放：取出对应帧
        const chunk = this.playbackBuffer.get(this.currentPlayFrame);

        if (chunk) {
          for (const output of outputs[0]) output.set(chunk);
        } else {
          // console.log("丢帧", this.playbackBuffer.size);
          for (const output of outputs[0]) output.fill(0);
          if (this.playbackBuffer.size === 0) {
            this.playbackBuffer.set(this.currentPlayFrame, new Float32Array(128));
            this.currentPlayFrame -= 128;
            // this.latestReceivedFrame = Infinity;
          }
        }

        // 清理当前帧数据
        this.playbackBuffer.delete(this.currentPlayFrame);
        this.currentPlayFrame += 128;
        this.latestExpectedFrame += 128;
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

    // 创建音频处理工作线程
    const objectUrl = URL.createObjectURL(
      new Blob([`(${registerProcessorFn})("${registerProcessorName}",${blockSize})`], {
        type: "application/javascript; charset=utf-8",
      })
    );
    this.initing = ctx.audioWorklet.addModule(objectUrl);
    this.initing?.finally?.(() => URL.revokeObjectURL(objectUrl));
    this.initing.then(() => {
      this.audioNode = new AudioWorkletNode(ctx, registerProcessorName);
      if (mediaStream) ctx.createMediaStreamSource(mediaStream).connect(this.audioNode);
      this.audioNode.connect(ctx.destination);
      this.audioNode.port.onmessage = ({
        data: { buffer, lastReceivedFrame, currentPlayFrame, playbackBufferSize, maxObservedJitter, sampleRate },
      }) =>
        this.onInputData(
          buffer,
          lastReceivedFrame,
          currentPlayFrame,
          playbackBufferSize,
          maxObservedJitter,
          sampleRate
        );
    });
    this.initing.catch(e => alert(e));

    const fn = () => {
      ctx.resume();
      if (!document.hidden) navigator.wakeLock.request("screen");
    };
    window.addEventListener("click", fn, { once: true });
    window.addEventListener("visibilitychange", fn);
    ctx.addEventListener("statechange", fn);
  }

  // overwrite
  public onInputData(
    buffer: Float32Array,
    lastReceivedFrame: number,
    currentPlayFrame: number,
    playbackBufferSize: number,
    maxObservedJitter: number,
    sampleRate: number
  ) {
    console.log("onInputData", buffer, lastReceivedFrame, currentPlayFrame, playbackBufferSize, maxObservedJitter);
  }

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
