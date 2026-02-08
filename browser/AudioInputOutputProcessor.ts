const registerProcessorName = "audioInputOutput";

const registerProcessorFn = String((registerProcessorName: string, blockSize: number) => {
  //@ts-ignore
  registerProcessor(
    registerProcessorName,
    //@ts-ignore
    class extends AudioWorkletProcessor {
      // ==========================================
      // 基础配置
      // ==========================================
      //@ts-ignore
      private readonly sampleRate = sampleRate || 48000;

      // ==========================================
      // 录音部分 (Mic -> Main Thread)
      // ==========================================
      /** 录音缓冲：用于积攒足够的音频数据后发送给主线程 */
      private inputBuffer = new Float32Array(blockSize);
      /** 录音缓冲当前的写入位置 */
      private inputBufferIndex = 0;
      /** 单次处理过程中的样本数 (通常是 128) */
      private processChunkSize = 128;

      // ==========================================
      // 播放部分 (Main Thread -> Speaker)
      // ==========================================
      /** 播放队列：存放从网络/主线程接收到的音频块 (Jitter Buffer) */
      private outputBuffer: Float32Array[] = [];
      /** 当前播放队列中剩余的总样本数 */
      private outputBufferSampleCount = 0;

      /** 当前播放倍速 (1.0 = 正常, >1.0 = 加速追帧) */
      private currentPlaybackRate = 1;
      /** 累计已播放的样本数 */
      private totalPlayedSamples = 0;

      // ==========================================
      // 自适应缓冲控制 (Adaptive Buffer Control)
      // ==========================================
      /** 最小安全缓冲阈值 (80ms)，低于此值可能导致卡顿 */
      private readonly minSafeBufferSize = this.sampleRate * 0.08;

      /** 动态目标缓冲大小：根据网络抖动情况自动调整 */
      private dynamicTargetBufferSize = this.sampleRate * 0.1;

      /** 追帧阈值：当缓冲超过此值 (5秒) 时，强制 2倍速播放以快速消耗积压 */
      private readonly panicThresholdSamples = this.sampleRate * 5;

      /** 稳定运行的持续时间 (样本数)，用于判断网络质量 */
      private stableDurationSamples: number = 0;

      // ==========================================
      // 预测与平滑算法参数
      // ==========================================
      /** 预测节流：每隔 6 秒 (对应采样率) 重新计算一次目标缓冲大小 */
      private readonly PREDICT_INTERVAL_SAMPLES = this.sampleRate * 3;
      /** 距离上次预测经过的样本数 */
      private samplesSinceLastPredict = 0;

      /** 低通滤波器系数 (Alpha)，用于重采样时的平滑处理 */
      private readonly lowPassAlpha: number;

      constructor() {
        super();

        // --- 消息监听：接收主线程传来的音频数据 ---
        //@ts-ignore
        this.port.onmessage = ({ data }: MessageEvent) => {
          const chunk: Float32Array = data.buffer;
          // 将数据推入播放队列
          this.outputBuffer.push(chunk);
          this.outputBufferSampleCount += chunk.length;
        };

        // --- 初始化低通滤波器 (RC Low-pass Filter) ---
        // 用于消除重采样（加速播放）时产生的高频混叠噪音
        const cutoffFreq = 12000; // 截止频率 12kHz (人声保留范围)
        // RC 低通公式
        const dt = 1 / this.sampleRate;
        const RC = 1 / (2 * Math.PI * cutoffFreq);
        this.lowPassAlpha = dt / (RC + dt);
      }

      /**
       * 核心算法：根据网络稳定性预测最佳缓冲大小
       * * 原理：
       * 1. 运行越稳定 (stableDurationSamples 越大)，目标缓冲越小 (追求低延迟)。
       * 2. 缓冲积压越多，越需要加速播放。
       */
      private updateTargetBufferSize() {
        // 节流：未到预测时间点则跳过
        if (this.samplesSinceLastPredict < this.PREDICT_INTERVAL_SAMPLES) {
          return;
        }
        this.samplesSinceLastPredict = 0;

        const currentBuffered = this.outputBufferSampleCount;

        // 1. 安全保护：如果当前缓冲严重不足，直接重置目标为最小安全值，防止过度激进
        if (currentBuffered <= this.minSafeBufferSize) {
          this.dynamicTargetBufferSize = this.minSafeBufferSize;
          return;
        }

        // 2. 计算缩减比率
        // 稳定半衰期：约 10秒
        const STABLE_HALF_LIFE = this.sampleRate * 1;
        const MAX_REDUCE_RATIO = 0.8; // 最大允许减少 80% 的缓冲
        const SAFE_MARGIN = this.minSafeBufferSize;

        // 稳定因子：运行越久越接近 1
        const stabilityFactor = 1 - Math.exp(-this.stableDurationSamples / STABLE_HALF_LIFE);

        // 安全因子：缓冲余量越充足越接近 1
        const excessBuffer = currentBuffered - this.minSafeBufferSize;
        const safetyFactor = excessBuffer >= SAFE_MARGIN ? 1 : excessBuffer / SAFE_MARGIN;

        // 综合缩减比率
        const reduceRatio = MAX_REDUCE_RATIO * stabilityFactor * safetyFactor;

        // 计算建议的新缓冲大小
        const suggestedBufferSize = this.dynamicTargetBufferSize - currentBuffered * (1 - reduceRatio);

        // 3. 限制范围：[最小安全值, 1秒数据量]
        this.dynamicTargetBufferSize = Math.min(Math.max(suggestedBufferSize, this.minSafeBufferSize), this.sampleRate);
      }

      /**
       * 计算当前需要的播放倍速
       * @returns 播放倍率 (1.0 ~ 2.0)
       */
      private calculatePlaybackRate(): number {
        // 情况 A: 积压极其严重 -> 2倍速全速追赶
        if (this.outputBufferSampleCount > this.panicThresholdSamples) {
          return 2;
        }

        // 更新目标缓冲水位线
        this.updateTargetBufferSize();

        const targetSize = this.dynamicTargetBufferSize;

        // 情况 B: 缓冲处于健康水位 -> 1倍速正常播放
        if (this.outputBufferSampleCount < targetSize) {
          return 1;
        }

        // 情况 C: 缓冲偏多 -> 线性插值计算加速倍率 (1.0 ~ 2.0 之间平滑过渡)
        // 缓冲越多，速度越快
        return 1 + (this.outputBufferSampleCount - targetSize) / (this.panicThresholdSamples - targetSize);
      }

      /**
       * AudioWorklet 主处理函数
       * 每 128 个采样点 (Quantum) 执行一次
       */
      process(inputs: Float32Array[][], outputs: Float32Array[][]): true {
        // ==========================================
        // 1. 录音处理 (Input -> Buffer)
        // ==========================================
        const inputData = inputs[0] ? inputs[0][0] : null;
        // 采集输入缓冲写入 inputBuffer
        if (inputData?.length) {
          // 将当前process音频数据写入大缓存
          this.inputBuffer.set(inputData, this.inputBufferIndex);
          // 更新当前process音频数据长度
          this.processChunkSize = inputData.length;
        } else {
          // 如果没有输入，填充静音，否则缓冲区会保留上一轮的脏数据
          // this.inputBuffer.fill(0, this.inputBufferIndex, this.inputBufferIndex + this.inputBufferSamplePerProcess);
        }
        // 更新当前process音频数据索引
        this.inputBufferIndex += this.processChunkSize;

        // 录音缓存填满，发送给主线程
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
              sampleRate: this.sampleRate,
              // 附带当前的播放状态供调试/监控
              outputSampleCount: this.outputBufferSampleCount,
              outputPlaySpeed: this.currentPlaybackRate,
              stableSamples: this.stableDurationSamples,
              playSpeedx1SampleCount: this.dynamicTargetBufferSize,
            },
            // 零拷贝转移所有权 (Transferable Objects)
            [bufferToSend.buffer]
          );

          // 3. 此时 bufferToSend.buffer 已经在当前线程不可用了（变成 0 字节）
          // 我们需要重新分配一个新的容器
          this.inputBuffer = new Float32Array(blockSize);
          this.inputBufferIndex = 0;
        }

        // ==========================================
        // 2. 播放处理 (Buffer -> Output)
        // ==========================================
        const output = outputs[0];
        /** 输出缓存大小（对应一次 postMessage 的数据量） */
        const requiredOutputSamples = output[0].length;

        // 稳定运行时间
        this.stableDurationSamples += requiredOutputSamples;
        // 预测节流计时
        this.samplesSinceLastPredict += requiredOutputSamples;
        // 计算播放速度
        this.currentPlaybackRate = this.calculatePlaybackRate();
        this.totalPlayedSamples += requiredOutputSamples;

        /** 策略 A：1倍速 (直接内存拷贝，最高效) */
        if (this.currentPlaybackRate < (requiredOutputSamples + 1) / requiredOutputSamples) {
          let samplesWritten = 0;
          let buffer: Float32Array | undefined;
          // 循环从队列头部取数据填充输出
          while (this.outputBufferSampleCount > 0 && (buffer = this.outputBuffer[0])) {
            /** 计算当前块能写入多少数据（剩余空间 vs 当前块长度） */
            const remainingSpace = requiredOutputSamples - samplesWritten;
            if (remainingSpace < buffer.length) {
              // 当前块数据比剩余空间多 -> 切割，填满输出，剩下的放回去
              this.outputBuffer[0] = buffer.subarray(remainingSpace); // 保留剩余部分
              buffer = buffer.subarray(0, remainingSpace);
            } else {
              this.outputBuffer.shift(); // 移除已处理的块
            }
            // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
            for (const channel of output) channel.set(buffer, samplesWritten);
            samplesWritten += buffer.length;
            this.outputBufferSampleCount -= buffer.length;
            // 如果填满了，就跳出
            if (samplesWritten >= requiredOutputSamples) return true;
          }

          /**  如果数据不够填满一帧（例如网络卡顿），剩余部分补 0（静音） */
          const samplesMissing = requiredOutputSamples - samplesWritten;
          if (samplesMissing > 0) {
            // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
            for (const channel of output) channel.fill(0, samplesWritten);

            // 发生卡顿，重置稳定性计数
            this.stableDurationSamples = 0;
            // this.samplesSinceLastPredict = this.PREDICT_INTERVAL_SAMPLES; // 立即触发下一次预测
            this.dynamicTargetBufferSize = Math.min(
              this.dynamicTargetBufferSize + this.sampleRate * 0.005,
              this.sampleRate
            );
            this.samplesSinceLastPredict = 0; // 反而要重置，给新水位一点时间观察
          }
          // 返回 true 保持处理器存活
          return true;
        }

        /** 策略 B：变速播放 (1.x ~ 2.0 倍速，需重采样) */
        this.resampleAndPlay(output);
        return true;
      }

      /**
       * 变速重采样算法
       * 技术：相位累加 (Phase Accumulation) + 线性插值 (Linear Interpolation) + 一阶低通滤波 (LPF)
       */
      private resampleAndPlay(outputChannels: Float32Array[]): void {
        const outputLength = outputChannels[0].length;

        // 根据倍速计算需要从 buffer 中读取多少个原始样本
        // 例如：要输出 128 个点，2倍速播放，则需要读取 256 个原始点
        let readLen = Math.round(outputLength * this.currentPlaybackRate);

        // 计算步进 (Step Size)
        const speed = readLen / outputLength;

        // 如果数据不够，放弃本次变速处理 (通常会自动回退到补零逻辑，这里简化直接返回)
        if (this.outputBufferSampleCount < readLen) return;

        // 1. 收集所需的源数据 (Source Blocks)
        const sourceChunks: Float32Array[] = [];

        while (readLen > 0 && this.outputBuffer[0]) {
          const buffer = this.outputBuffer[0];

          if (readLen >= buffer.length) {
            // 需要整个块
            sourceChunks.push(buffer);
            readLen -= buffer.length;
            this.outputBufferSampleCount -= buffer.length;
            this.outputBuffer.shift();
          } else {
            // 只需要块的一部分
            sourceChunks.push(buffer.subarray(0, readLen));
            this.outputBuffer[0] = buffer.subarray(readLen); // 修改队列头部
            this.outputBufferSampleCount -= readLen;
            readLen = 0;
            break;
          }
        }

        // 2. 准备虚拟游标 (Virtual Cursor) 用于在 sourceChunks 数组组中漫游
        let currentChunkIndex = 0;
        let currentOffsetInChunk = 0;

        /** 游标向前移动 */
        const advanceCursor = (step: number) => {
          currentOffsetInChunk += step;
          // 跨越块边界处理
          while (
            currentChunkIndex < sourceChunks.length &&
            currentOffsetInChunk >= sourceChunks[currentChunkIndex].length
          ) {
            currentOffsetInChunk -= sourceChunks[currentChunkIndex].length;
            currentChunkIndex++;
          }
        };

        /** 读取指定偏移量的样本值 (Peek) */
        const peekSample = (offset: number): number => {
          let idx = currentChunkIndex;
          let off = currentOffsetInChunk + offset;

          // 向前查找
          while (idx < sourceChunks.length && off >= sourceChunks[idx].length) {
            off -= sourceChunks[idx].length;
            idx++;
          }

          if (idx >= sourceChunks.length) return 0;
          return sourceChunks[idx][off] ?? 0;
        };

        // 3. 执行重采样循环
        // 状态变量保持在闭包/类成员中可能更好，这里沿用原逻辑作为局部变量演示
        // 注意：为了完美音质，phase 和 lastFilteredValue 应该提升为类成员变量
        let filterState = 0; // 上一次滤波后的值
        let phase = 0; // 相位累加器
        let lastIntegerPhase = 0;

        for (let i = 0; i < outputLength; i++) {
          const integerPhase = phase | 0; // 取整
          const fractionPhase = phase - integerPhase; // 小数部分 (用于插值权重)

          // 移动游标
          const delta = integerPhase - lastIntegerPhase;
          if (delta > 0) {
            advanceCursor(delta);
            lastIntegerPhase = integerPhase;
          }

          // 获取相邻两个样本点
          const sampleCurrent = peekSample(0);
          const sampleNext = peekSample(1);

          // 线性插值 (Linear Interpolation)
          const interpolatedValue = sampleCurrent + (sampleNext - sampleCurrent) * fractionPhase;

          // 低通滤波 (IIR Filter) - 平滑处理，消除高频锯齿
          // y[n] = y[n-1] + alpha * (x[n] - y[n-1])
          const filteredValue = filterState + this.lowPassAlpha * (interpolatedValue - filterState);
          filterState = filteredValue;

          // 写入输出
          for (const channel of outputChannels) channel[i] = filteredValue;

          // 推进相位
          phase += speed;
        }
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
        data: { buffer, sampleRate, outputSampleCount, outputPlaySpeed, stableSamples, playSpeedx1SampleCount },
      }) =>
        this.onInputData(buffer, sampleRate, outputSampleCount, outputPlaySpeed, stableSamples, playSpeedx1SampleCount);
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
    sampleRate: number,
    outputSampleCount: number,
    outputPlaySpeed: number,
    stableSamples: number,
    playSpeedx1SampleCount: number
  ) {
    console.log(
      "onInputData",
      buffer,
      sampleRate,
      outputSampleCount,
      outputPlaySpeed,
      stableSamples,
      playSpeedx1SampleCount
    );
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
