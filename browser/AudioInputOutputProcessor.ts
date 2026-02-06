const registerProcessorName = "audioInputOutput";

const registerProcessorFn = String((registerProcessorName: string, blockSize: number) => {
  //@ts-ignore
  registerProcessor(
    registerProcessorName,
    //@ts-ignore
    class extends AudioWorkletProcessor {
      /** 采集缓存大小（对应一次 postMessage 的数据量） */
      private inputBuffer = new Float32Array(blockSize);
      private inputBufferIndex = 0;
      private inputBufferSamplePerProcess = 128;

      private outputBuffer: Float32Array[] = [];
      private outputBufferSampleCount = 0;
      private outputBufferPlaySpeed = 1;

      constructor() {
        super();
        /** 接收主线程发送的音频数据并缓存 */
        //@ts-ignore
        this.port.onmessage = ({ data }: MessageEvent) => {
          const buffer: Float32Array = data.buffer;
          this.outputBuffer.push(buffer);
          this.outputBufferSampleCount += buffer.length;
        };
      }

      /** 每128个样本执行：录音 + 播放 */
      process(inputs: Float32Array[][], outputs: Float32Array[][]) {
        /** 输入缓存大小（对应一次 process 调用的音频数据量） */
        const inputData = inputs[0] ? inputs[0][0] : null;
        // 采集输入缓冲写入 inputBuffer
        if (inputData?.length) {
          // 将当前process音频数据写入大缓存
          this.inputBuffer.set(inputData, this.inputBufferIndex);
          // 更新当前process音频数据长度
          this.inputBufferSamplePerProcess = inputData.length;
        } else {
          // 如果没有输入，填充静音，否则缓冲区会保留上一轮的脏数据
          // this.inputBuffer.fill(0, this.inputBufferIndex, this.inputBufferIndex + this.inputBufferSamplePerProcess);
        }
        // 更新当前process音频数据索引
        this.inputBufferIndex += this.inputBufferSamplePerProcess;

        // 填满后发送给主线程
        if (this.inputBufferIndex >= this.inputBuffer.length) {
          //@ts-ignore
          // this.port.postMessage({
          //   buffer: this.inputBuffer.slice(),
          //   // @ts-ignore
          //   sampleRate,
          // });
          // this.inputBufferIndex = 0;
          // 1. 获取要发送的数据块
          const bufferToSend = this.inputBuffer;
          // 2. 发送，并利用第二个参数声明“转移所有权”
          // 注意：转移的是 ArrayBuffer，而不是 Float32Array 视图
          //@ts-ignore
          this.port.postMessage(
            {
              buffer: bufferToSend,
              // @ts-ignore
              sampleRate,
              outputSampleCount: this.outputBufferSampleCount,
              outputPlaySpeed: this.outputBufferPlaySpeed,
            },
            [bufferToSend.buffer]
          );

          // 3. 此时 bufferToSend.buffer 已经在当前线程不可用了（变成 0 字节）
          // 我们需要重新分配一个新的容器
          this.inputBuffer = new Float32Array(blockSize);
          this.inputBufferIndex = 0;
        }

        // 播放输出缓冲到输出源
        const output = outputs[0];
        /** 输出缓存大小（对应一次 postMessage 的数据量） */
        const outputSampleCount = output[0].length;

        // TODO: 调整播放速度

        if (this.outputBufferPlaySpeed === 1) {
          /** 已写入输出缓存的样本数 */
          let writedSampleCount = 0;
          let buffer: Float32Array | undefined = undefined;
          while (this.outputBufferSampleCount > 0 && (buffer = this.outputBuffer[0])) {
            /** 计算当前块能写入多少数据（剩余空间 vs 当前块长度） */
            const maxWriteSampleCount = outputSampleCount - writedSampleCount;
            if (maxWriteSampleCount < buffer.length) {
              // 切割出需要写入的那部分
              this.outputBuffer[0] = buffer.subarray(maxWriteSampleCount);
              buffer = buffer.subarray(0, maxWriteSampleCount);
            } else {
              this.outputBuffer.shift();
            }
            // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
            for (const outputBuffer of output) outputBuffer.set(buffer, writedSampleCount);
            writedSampleCount += buffer.length;
            this.outputBufferSampleCount -= buffer.length;
            // 如果填满了，就跳出
            if (writedSampleCount >= outputSampleCount) return true;
          }

          /**  如果数据不够填满一帧（例如网络卡顿），剩余部分补 0（静音） */
          const fillZeroCount = outputSampleCount - writedSampleCount;
          if (fillZeroCount > 0) {
            // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
            for (const outputBuffer of output) outputBuffer.fill(0, writedSampleCount);
          }
          // 返回 true 保持处理器存活
          return true;
        }

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
      this.audioNode.port.onmessage = ({ data: { buffer, sampleRate, outputSampleCount, outputPlaySpeed } }) =>
        this.onInputData(buffer, sampleRate, outputSampleCount, outputPlaySpeed);
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
  public onInputData(buffer: Float32Array, sampleRate: number, outputSampleCount: number, outputPlaySpeed: number) {
    console.log("onInputData", buffer, sampleRate, outputSampleCount, outputPlaySpeed);
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
