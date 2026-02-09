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
      /** 当前 AudioWorklet 的采样率（兜底 48k） */
      //@ts-ignore
      private readonly sampleRate = sampleRate || 48000;

      // ==========================================
      // 录音部分 (Mic -> Main Thread)
      // ==========================================
      /** 录音缓冲区：累计到一定大小后发送给主线程 */
      private recordBuffer = new Float32Array(blockSize);
      /** 当前录音缓冲区写入位置 */
      private recordWriteIndex = 0;
      /** 单次 process 回调内的样本数（通常为 128） */
      private processFrameSize = 128;

      // ==========================================
      // 播放部分 (Main Thread -> Speaker)
      // ==========================================
      /** 播放队列（抖动缓冲）：存放来自主线程的音频块 */
      private readonly outputBufferQueue: Float32Array[] = [];
      /** 播放队列中剩余的总样本数 */
      private outputBufferQueueSampleCount = 0;
      /** 当前读取到第几个 buffer */
      private outputQueueReadBufferIndex = 0;
      /** 当前 buffer 内 sample 偏移 */
      private outputQueueReadSampleIndex = 0;

      /** 当前播放速率对应的“读取样本数”（以 128 为 1x） */
      private currentReadSamplesPerFrame = this.processFrameSize;
      /** 累计已播放的样本数（统计用途） */
      private totalOutputSamples = 0;

      // ==========================================
      // 自适应缓冲控制 (Adaptive Buffer Control)
      // ==========================================
      /** 最小安全缓冲阈值（80ms），低于此值可能发生卡顿 */
      private readonly minSafeBufferSamples = this.sampleRate * 0.08;

      /** 动态目标缓冲大小（根据网络抖动自动调整） */
      private targetBufferSamples = this.sampleRate * 0.1;

      /** 极端积压阈值（5 秒），超过后强制 2 倍速追帧 */
      private readonly panicBufferSamples = this.sampleRate * 5;

      /** 连续稳定运行的样本数（用于评估网络质量） */
      private stableRunningSamples = 0;

      // ==========================================
      // 预测与平滑控制参数
      // ==========================================
      /** 预测周期：每隔一定样本数重新计算目标缓冲 */
      private readonly PREDICT_INTERVAL_SAMPLES = this.sampleRate * 3;
      /** 距离上次预测经过的样本数 */
      private samplesSinceLastPrediction = 0;

      // ==========================================
      // 二阶低通滤波器状态（Direct Form I）
      // ==========================================
      private lpfInput1 = 0;
      private lpfInput2 = 0;
      private lpfOutput1 = 0;
      private lpfOutput2 = 0;

      /** 当前低通滤波器系数（随 speed 动态更新） */
      private lpf_b0 = 0;
      private lpf_b1 = 0;
      private lpf_b2 = 0;
      private lpf_a1 = 0;
      private lpf_a2 = 0;
      constructor() {
        super();

        // ===============================
        // 接收主线程推送的播放数据
        // ===============================
        //@ts-ignore
        this.port.onmessage = ({ data }: MessageEvent) => {
          const audioChunk: Float32Array = data.buffer;
          this.outputBufferQueue.push(audioChunk);
          this.outputBufferQueueSampleCount += audioChunk.length;
        };
      }

      /**
       * 核心算法：根据网络稳定性预测最佳缓冲大小
       * * 原理：
       * 1. 运行越稳定 (stableDurationSamples 越大)，目标缓冲越小 (追求低延迟)。
       * 2. 缓冲积压越多，越需要加速播放。
       */
      private updateTargetBufferSamples() {
        // 节流：未到预测时间点则跳过
        if (this.samplesSinceLastPrediction < this.PREDICT_INTERVAL_SAMPLES) {
          return;
        }
        this.samplesSinceLastPrediction = 0;

        const bufferedSamples = this.outputBufferQueueSampleCount;

        // 缓冲严重不足时，直接回退到最小安全值
        if (bufferedSamples <= this.minSafeBufferSamples) {
          this.targetBufferSamples = this.minSafeBufferSamples;
          return;
        }
        // 计算缩减比率
        // 稳定半衰期：约 10秒
        const STABLE_HALF_LIFE = this.sampleRate * 1;
        const MAX_REDUCE_RATIO = 0.8;
        const SAFE_MARGIN = this.minSafeBufferSamples;

        // 稳定因子：运行越久，越接近 1
        const stabilityFactor = 1 - Math.exp(-this.stableRunningSamples / STABLE_HALF_LIFE);

        // 安全因子：缓冲余量越充足，越接近 1
        const excess = bufferedSamples - this.minSafeBufferSamples;
        const safetyFactor = excess >= SAFE_MARGIN ? 1 : excess / SAFE_MARGIN;

        // 综合缩减比率
        const reduceRatio = MAX_REDUCE_RATIO * stabilityFactor * safetyFactor;

        // 计算建议的新缓冲大小
        const suggested = this.targetBufferSamples - bufferedSamples * (1 - reduceRatio);

        // 限制在 [最小安全值, 1 秒]
        this.targetBufferSamples = Math.min(Math.max(suggested, this.minSafeBufferSamples), this.sampleRate);
      }

      /**
       * 计算当前应使用的播放速率
       */
      private calculateReadSamplesPerFrame(): number {
        // 极端积压：直接 2 倍速
        if (this.outputBufferQueueSampleCount > this.panicBufferSamples) return this.processFrameSize * 2;

        // 更新目标缓冲水位线
        this.updateTargetBufferSamples();

        // 缓冲健康：正常 1 倍速
        if (this.outputBufferQueueSampleCount < this.targetBufferSamples) return this.processFrameSize;

        // 缓冲偏多 -> 线性插值计算加速倍率 (1.0 ~ 2.0 之间平滑过渡)
        const speedFactor =
          1 +
          (this.outputBufferQueueSampleCount - this.targetBufferSamples) /
            (this.panicBufferSamples - this.targetBufferSamples);

        return Math.round(this.processFrameSize * speedFactor);
      }

      /**
       * AudioWorklet 主处理函数
       * 每 128 个采样点 (Quantum) 执行一次
       */
      process(inputs: Float32Array[][], outputs: Float32Array[][]): true {
        // ==========================================
        // 1. 录音处理（Input -> recordBuffer）
        // ==========================================
        const inputData = inputs[0]?.[0] ?? null;
        // 采集输入缓冲写入 inputBuffer
        if (inputData?.length) {
          // 将当前process音频数据写入大缓存
          this.recordBuffer.set(inputData, this.recordWriteIndex);
          // 更新当前process音频数据长度
          this.processFrameSize = inputData.length;
        } else {
          // 如果没有输入，填充静音，否则缓冲区会保留上一轮的脏数据
          // this.inputBuffer.fill(0, this.inputBufferIndex, this.inputBufferIndex + this.inputBufferSamplePerProcess);
        }
        // 更新当前process音频数据索引
        this.recordWriteIndex += this.processFrameSize;

        // 录音缓冲满，发送给主线程
        if (this.recordWriteIndex >= this.recordBuffer.length) {
          //@ts-ignore
          // this.port.postMessage({
          //   buffer: this.inputBuffer.slice(),
          //   // @ts-ignore
          //   sampleRate,
          // });
          // this.inputBufferIndex = 0;
          // 1. 获取要发送的数据块
          const bufferToSend = this.recordBuffer;
          // 2. 发送，并利用第二个参数声明“转移所有权”
          // 注意：转移的是 ArrayBuffer，而不是 Float32Array 视图
          //@ts-ignore
          this.port.postMessage(
            {
              buffer: bufferToSend,
              sampleRate: this.sampleRate,
              // 附带当前的播放状态供调试/监控
              outputSampleCount: this.outputBufferQueueSampleCount,
              outputPlaySpeed: this.currentReadSamplesPerFrame,
              stableSamples: this.stableRunningSamples,
              playSpeedx1SampleCount: this.targetBufferSamples,
            },
            // 零拷贝转移所有权 (Transferable Objects)
            [bufferToSend.buffer]
          );
          // 3. 此时 bufferToSend.buffer 已经在当前线程不可用了（变成 0 字节）
          // 我们需要重新分配一个新的容器
          this.recordBuffer = new Float32Array(blockSize);
          this.recordWriteIndex = 0;
        }

        // ==========================================
        // 2. 播放处理（Queue -> Output）
        // ==========================================
        const outputChannels = outputs[0];
        /** 输出缓存大小（对应一次 postMessage 的数据量） */
        const frameOutputSamples = outputChannels[0].length;

        /** 稳定运行时间（用于计算播放速率） */
        this.stableRunningSamples += frameOutputSamples;
        // 预测节流计时
        this.samplesSinceLastPrediction += frameOutputSamples;
        // 计算播放速度
        this.currentReadSamplesPerFrame = this.calculateReadSamplesPerFrame();
        this.totalOutputSamples += frameOutputSamples;

        // ===== 策略 A：1x 直接拷贝 =====

        if (this.currentReadSamplesPerFrame === this.processFrameSize)
          // 返回 true 保持处理器存活
          return this.outputNormalSpeed(outputChannels, frameOutputSamples);

        /** 策略 B：变速播放 (1.x ~ 2.0 倍速，需重采样) */
        return this.resampleAndOutput(outputChannels, frameOutputSamples);
      }
      /**
       * 根据当前 speed 动态更新二阶 Butterworth 低通滤波器
       * cutoff 会随 speed 反向收紧，用于抗混叠
       */
      private updateLowPassFilter(speed: number) {
        // ===== 语音安全参数 =====
        const baseCutoff = 8000; // 8kHz：语音上限
        const cutoff = Math.min(baseCutoff / speed, 9000); // 动态收紧
        const fs = this.sampleRate;

        // 预扭曲（双线性变换）
        const omega = Math.tan((Math.PI * cutoff) / fs);
        const omega2 = omega * omega;
        const sqrt2 = Math.SQRT2;

        const norm = 1 / (1 + sqrt2 * omega + omega2);

        // Butterworth 二阶低通系数
        this.lpf_b0 = omega2 * norm;
        this.lpf_b1 = 2 * this.lpf_b0;
        this.lpf_b2 = this.lpf_b0;

        this.lpf_a1 = 2 * (omega2 - 1) * norm;
        this.lpf_a2 = (1 - sqrt2 * omega + omega2) * norm;
      }
      /**
       * 从输出缓存队列中采样指定位置的样本值
       * @param localBufIndex 输出缓存队列索引
       * @param localSampleOff 输出缓存队列样本偏移量
       * @returns 样本值
       */
      private sampleAt(localBufIndex: number, localSampleOff: number): number {
        // let off = localSampleIndex + rel;
        while (localBufIndex < this.outputBufferQueue.length) {
          const buf = this.outputBufferQueue[localBufIndex];
          if (localSampleOff < 0) {
            localBufIndex--;
            if (localBufIndex < 0) return 0;
            localSampleOff += this.outputBufferQueue[localBufIndex].length;
          } else if (localSampleOff >= buf.length) {
            localSampleOff -= buf.length;
            localBufIndex++;
          } else {
            return buf[localSampleOff];
          }
        }
        return 0;
      }
      /**
       * 变速重采样（语音优化版）
       * 技术：
       * - 相位累加（Phase Accumulation）
       * - 四点 Hermite 插值（Catmull-Rom）
       * - 二阶 Butterworth 低通（cutoff 随 speed 变化）
       */
      private resampleAndOutput(outputChannels: Float32Array[], frameOutputSamples: number): true {
        const speed = this.currentReadSamplesPerFrame / frameOutputSamples;

        if (this.outputBufferQueueSampleCount < this.currentReadSamplesPerFrame) return true;

        let localBufIndex = this.outputQueueReadBufferIndex;
        let localSampleIndex = this.outputQueueReadSampleIndex;

        // ==========================================
        // 3. 更新二阶低通（cutoff 随 speed）
        // ==========================================
        this.updateLowPassFilter(speed);

        // ==========================================
        // 4. 重采样主循环
        // ==========================================
        let phase = 0;
        let lastInt = 0;

        for (let i = 0; i < frameOutputSamples; i++) {
          const intP = phase | 0;
          const t = phase - intP;

          const delta = intP - lastInt;
          if (delta > 0) {
            localSampleIndex += delta;
            while (
              localBufIndex < this.outputBufferQueue.length &&
              localSampleIndex >= this.outputBufferQueue[localBufIndex].length
            ) {
              localSampleIndex -= this.outputBufferQueue[localBufIndex].length;
              localBufIndex++;
            }
            lastInt = intP;
          }

          /**
           * 取 4 个点：
           * x[-1], x[0], x[1], x[2]
           */
          const xm1 = this.sampleAt(localBufIndex, localSampleIndex - 1);
          const x0 = this.sampleAt(localBufIndex, localSampleIndex);
          const x1 = this.sampleAt(localBufIndex, localSampleIndex + 1);
          const x2 = this.sampleAt(localBufIndex, localSampleIndex + 2);

          // ======================================
          // Hermite (Catmull-Rom) 插值
          // ======================================
          const c0 = x0;
          const c1 = 0.5 * (x1 - xm1);
          const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
          const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);

          const interp = ((c3 * t + c2) * t + c1) * t + c0;

          // ======================================
          // 二阶 Butterworth 低通
          // ======================================
          const y =
            this.lpf_b0 * interp +
            this.lpf_b1 * this.lpfInput1 +
            this.lpf_b2 * this.lpfInput2 -
            this.lpf_a1 * this.lpfOutput1 -
            this.lpf_a2 * this.lpfOutput2;

          this.lpfInput2 = this.lpfInput1;
          this.lpfInput1 = interp;
          this.lpfOutput2 = this.lpfOutput1;
          this.lpfOutput1 = y;

          // 写入输出
          for (const ch of outputChannels) ch[i] = y;

          // 推进相位
          phase += speed;
        }

        const consumed = this.currentReadSamplesPerFrame;
        this.outputQueueReadSampleIndex = localSampleIndex;
        this.outputQueueReadBufferIndex = localBufIndex;
        this.outputBufferQueueSampleCount -= consumed;

        this.compactOutputQueue();
        return true;
      }
      // ==========================================
      // 1x 速播放
      // ==========================================
      private outputNormalSpeed(outputChannels: Float32Array[], frameOutputSamples: number): true {
        let written = 0;
        /** 每次循环只处理outputBufferQueue的一个元素 */
        while (written < frameOutputSamples && this.outputBufferQueueSampleCount > 0) {
          const buf = this.outputBufferQueue[this.outputQueueReadBufferIndex];
          if (!buf) break;
          /** 计算当前块能写入多少数据（剩余空间 vs 当前块长度） */
          const remainInBuf = buf.length - this.outputQueueReadSampleIndex;
          /** 计算当前块需要写入多少数据（剩余数据 vs 所需数据） */
          const need = frameOutputSamples - written;
          /** 计算实际写入数据量（取剩余空间和所需数据的较小值） */
          const copyCount = Math.min(remainInBuf, need);
          /** 从当前块提取数据（从游标位置开始，长度为 copyCount） */
          const subBuffer = buf.subarray(this.outputQueueReadSampleIndex, this.outputQueueReadSampleIndex + copyCount);
          // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
          for (const ch of outputChannels) ch.set(subBuffer, written);

          this.outputQueueReadSampleIndex += copyCount;
          this.outputBufferQueueSampleCount -= copyCount;
          written += copyCount;

          if (this.outputQueueReadSampleIndex >= buf.length) {
            this.outputQueueReadBufferIndex++;
            this.outputQueueReadSampleIndex = 0;
          }
        }
        /**  如果数据不够填满一帧（例如网络卡顿），剩余部分补 0（静音） */
        if (written < frameOutputSamples) {
          // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
          for (const ch of outputChannels) ch.fill(0, written);

          this.stableRunningSamples = 0;
          // this.samplesSinceLastPredict = this.PREDICT_INTERVAL_SAMPLES; // 立即触发下一次预测
          this.targetBufferSamples = Math.min(this.targetBufferSamples + this.sampleRate * 0.005, this.sampleRate);
          this.samplesSinceLastPrediction = 0;
        }

        this.compactOutputQueue();
        return true;
      }
      // ==========================================
      // 队列压缩（超过 66 个元素时，删除64个旧数据）
      // ==========================================
      private compactOutputQueue() {
        if (this.outputQueueReadBufferIndex > 66) {
          this.outputBufferQueue.splice(0, 64);
          this.outputQueueReadBufferIndex -= 64;
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
console.log("666");
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
