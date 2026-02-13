/// <reference types="@types/audioworklet" />
const registerProcessorName = "audioInputOutput";
export type IAudioInputOutputProcessorMessage = {
  /** 当前输入缓冲区 */
  buffer: Float32Array;
  /** 当前采样率 */
  sampleRate: number;
  /** 当前输出缓冲区样本数 */
  outputSampleCount: number;
  /** 当前输出播放速度 */
  outputPlaySpeed: string;
  /** 当前稳定播放的样本数 */
  stableSamples: number;
  /** 当前缓存的样本数 */
  playSpeedx1SampleCount: number;
};

const registerProcessorFn = String((registerProcessorName: string, blockSize: number) => {
  /**
   * 基础缓冲区管理类
   * 负责：录音数据的累积、播放队列的管理、样本级别的精确查找
   */
  class AudioBufferManager {
    // ==========================================
    // 录音部分 (Mic -> Main Thread)
    // ==========================================
    /** 录音缓冲区：累计到一定大小后发送给主线程 */
    private recordBuffer = new Float32Array(blockSize);
    /** 当前录音缓冲区写入位置 */
    private recordWriteIndex = 0;
    /** 单次 process 回调内的样本数（通常为 128） */
    public processFrameSize = 128; // AudioWorklet 固定的处理单元大小

    // ==========================================
    // 播放部分 (Main Thread -> Speaker)
    // ==========================================
    /** 播放队列（抖动缓冲）：存放来自主线程的音频块 */
    protected readonly outputBufferQueue: Float32Array[] = [];
    /** 播放队列中剩余的总样本数 */
    public outputBufferQueueSampleCount = 0;
    /** 当前读取到第几个 buffer */
    protected outputQueueReadBufferIndex = 0;
    /** 当前 buffer 内 sample 偏移 */
    protected outputQueueReadSampleIndex = 0;

    /** 处理输入音频数据（录音） */
    public onInputData(inputs: Float32Array[][]): Float32Array | null {
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

      // 当录音缓冲区填满目标大小时（如 512 采样），抛出给主线程
      if (this.recordWriteIndex >= this.recordBuffer.length) {
        // 使用 slice 确保发送的是副本，避免当前线程后续写入污染数据
        const dataToSend = this.recordBuffer;
        //  此时 bufferToSend.buffer 已经在当前线程不可用了（变成 0 字节）
        // 我们需要重新分配一个新的容器
        this.recordBuffer = new Float32Array(blockSize);
        this.recordWriteIndex = 0;
        return dataToSend;
      }
      return null;
    }

    /** 接收来自主线程的待播放音频块 */
    public onOutputData(audioChunk: Float32Array) {
      this.outputBufferQueue.push(audioChunk);
      this.outputBufferQueueSampleCount += audioChunk.length;
    }

    /** * 精准采样函数：支持跨 Buffer 边界和插值所需的相对位移查找
     * @param outputQueueReadBufferIndex 当前 Buffer 索引
     * @param outputQueueReadSampleIndex 当前采样点相对于该 Buffer 起始位置的偏移（允许为负或溢出）
     */
    protected getSampleWithOffset(outputQueueReadBufferIndex: number, outputQueueReadSampleIndex: number): number {
      while (outputQueueReadBufferIndex < this.outputBufferQueue.length) {
        const buffer = this.outputBufferQueue[outputQueueReadBufferIndex];
        if (outputQueueReadSampleIndex < 0) {
          // 向前跨 Buffer
          outputQueueReadBufferIndex--;
          if (outputQueueReadBufferIndex < 0) return 0; // 越界保护（静音）
          outputQueueReadSampleIndex += this.outputBufferQueue[outputQueueReadBufferIndex].length;
        } else if (outputQueueReadSampleIndex >= buffer.length) {
          // 向后跨 Buffer
          outputQueueReadSampleIndex -= buffer.length;
          outputQueueReadBufferIndex++;
        } else {
          return buffer[outputQueueReadSampleIndex];
        }
      }
      return 0;
    }

    // protected syncAt(
    //   value: number,
    //   outputQueueReadSampleIndex = this.outputQueueReadSampleIndex,
    //   outputQueueReadBufferIndex = this.outputQueueReadBufferIndex
    // ) {
    //   outputQueueReadSampleIndex += value;
    //   const outputBufferQueue = this.outputBufferQueue;
    //   while (
    //     outputQueueReadBufferIndex < outputBufferQueue.length &&
    //     outputQueueReadSampleIndex >= outputBufferQueue[outputQueueReadBufferIndex].length
    //   ) {
    //     outputQueueReadSampleIndex -= outputBufferQueue[outputQueueReadBufferIndex].length;
    //     outputQueueReadBufferIndex++;
    //   }
    //   this.outputQueueReadSampleIndex = outputQueueReadSampleIndex;
    //   this.outputQueueReadBufferIndex = outputQueueReadBufferIndex;
    // }

    /** 队列压缩：防止已播放的 Buffer 长期占用内存 */
    public compactQueue() {
      // 阈值设为 64 是为了平衡 GC 频率和内存占用
      if (this.outputQueueReadBufferIndex > 64) {
        this.outputBufferQueue.splice(0, 64);
        this.outputQueueReadBufferIndex -= 64;
      }
    }
  }

  /**
   * 重采样执行类
   * 负责：变速播放、Hermite 插值、抗混叠低通滤波
   */
  class ResamplerEngine extends AudioBufferManager {
    // ==========================================
    // 二阶低通滤波器状态（Direct Form I）
    // ==========================================
    // 低通滤波器状态（防止变速产生的金属混叠音）
    private lpfX1 = 0;
    private lpfX2 = 0; // 输入历史
    private lpfY1 = 0;
    private lpfY2 = 0; // 输出历史

    /** 当前低通滤波器系数（随 speed 动态更新） */
    private b0 = 0;
    private b1 = 0;
    private b2 = 0;
    private a1 = 0;
    private a2 = 0;

    /** 动态计算二阶低通系数：当 speed > 1 时，截止频率必须收缩，cutoff 会随 speed 反向收紧，用于抗混叠 */
    private updateAntialiasingFilter(speed: number) {
      // ===== 语音安全参数 =====
      const baseCutoff = 8000; // 8kHz：语音上限
      const cutoff = Math.min(baseCutoff / speed, 9000); // 动态收紧
      const omega = Math.tan((Math.PI * cutoff) / sampleRate);
      const omega2 = omega * omega;
      const norm = 1 / (1 + Math.SQRT2 * omega + omega2);

      // Butterworth 二阶低通系数

      this.b0 = omega2 * norm;
      this.b1 = 2 * this.b0;
      this.b2 = this.b0;

      this.a1 = 2 * (omega2 - 1) * norm;
      this.a2 = (1 - Math.SQRT2 * omega + omega2) * norm;
    }

    /**
     * 变速重采样
     * 技术：
     * - 相位累加（Phase Accumulation）
     * - 四点 Hermite 插值（Catmull-Rom）
     * - 二阶 Butterworth 低通（cutoff 随 speed 变化）
     */
    public resampleAndOutput(
      outputChannels: Float32Array[],
      frameSamples: number, // 目标输出长度（128）
      consumeSamples: number // 实际消耗的原始样本数（如 130，代表加速）
    ) {
      /** 当前播放速度（小数） */
      const rate = consumeSamples / frameSamples;
      if (this.outputBufferQueueSampleCount < consumeSamples) return;

      let bufIdx = this.outputQueueReadBufferIndex;
      let sampleIdx = this.outputQueueReadSampleIndex;

      // ==========================================
      // 3. 更新二阶低通（cutoff 随 speed）
      // ==========================================
      this.updateAntialiasingFilter(rate);

      // ==========================================
      // 4. 重采样主循环
      // ==========================================
      let lastPhaseInt = 0;
      for (let i = 0; i <= frameSamples; i++) {
        const isEnd = i === frameSamples;
        const phase = rate * i;
        // 最后一步强制对齐到 consumeSamples，解决浮点数 0.999999 精度问题
        const intP = isEnd ? Math.round(phase) : phase | 0;
        const t = phase - intP; // 插值权重

        const delta = intP - lastPhaseInt;
        if (delta > 0) {
          sampleIdx += delta;
          // 移动游标：当游标超过当前 Buffer 长度时，跳到下一个 Buffer
          while (bufIdx < this.outputBufferQueue.length && sampleIdx >= this.outputBufferQueue[bufIdx].length) {
            sampleIdx -= this.outputBufferQueue[bufIdx].length;
            bufIdx++;
          }
          lastPhaseInt = intP;
        }

        if (isEnd) break; // 游标移动完毕，退出，不进行最后的越界采样

        // Hermite 四点插值：获取当前位置周围的 4 个点
        const x_m1 = this.getSampleWithOffset(bufIdx, sampleIdx - 1);
        const x_0 = this.getSampleWithOffset(bufIdx, sampleIdx);
        const x_1 = this.getSampleWithOffset(bufIdx, sampleIdx + 1);
        const x_2 = this.getSampleWithOffset(bufIdx, sampleIdx + 2);

        // ======================================
        // Hermite (Catmull-Rom) 插值
        // ======================================
        const c0 = x_0;
        const c1 = 0.5 * (x_1 - x_m1);
        const c2 = x_m1 - 2.5 * x_0 + 2 * x_1 - 0.5 * x_2;
        const c3 = 0.5 * (x_2 - x_m1) + 1.5 * (x_0 - x_1);
        const rawInterp = ((c3 * t + c2) * t + c1) * t + c0;

        // 二阶 Butterworth 低通 (Direct Form I)
        const y =
          this.b0 * rawInterp +
          this.b1 * this.lpfX1 +
          this.b2 * this.lpfX2 -
          this.a1 * this.lpfY1 -
          this.a2 * this.lpfY2;
        this.lpfX2 = this.lpfX1;
        this.lpfX1 = rawInterp;
        this.lpfY2 = this.lpfY1;
        this.lpfY1 = y;

        for (const ch of outputChannels) ch[i] = y;
      }

      // 同步回成员变量
      this.outputQueueReadSampleIndex = sampleIdx;
      this.outputQueueReadBufferIndex = bufIdx;
      this.outputBufferQueueSampleCount -= consumeSamples;
      // this.syncAt(currentReadSamplesPerFrame, oldOutputQueueReadSampleIndex, oldOutputQueueReadBufferIndex);
      // ttt !== currentReadSamplesPerFrame &&
      //   console.log(
      //     ttt,
      //     "resampleAndOutput",
      //     localSampleIndex,
      //     currentReadSamplesPerFrame === 128 ? "" : currentReadSamplesPerFrame,
      //     frameOutputSamples === 128 ? "" : frameOutputSamples,
      //     localBufIndex
      //   );
    }

    /** 标准 1x 速播放（优化路径：直接内存拷贝） */
    public outputNormalSpeed(outputChannels: Float32Array[], frameSamples: number): boolean {
      let written = 0;
      /** 每次循环只处理outputBufferQueue的一个元素 */
      while (written < frameSamples && this.outputBufferQueueSampleCount > 0) {
        const buf = this.outputBufferQueue[this.outputQueueReadBufferIndex];
        if (!buf) break;
        /** 计算当前块能写入多少数据（剩余空间 vs 当前块长度） */
        const available = buf.length - this.outputQueueReadSampleIndex;
        /** 计算当前块需要写入多少数据（剩余数据 vs 所需数据） */
        const need = frameSamples - written;
        /** 计算实际写入数据量（取剩余空间和所需数据的较小值） */
        const copyCount = Math.min(available, need);
        /** 从当前块提取数据（从游标位置开始，长度为 copyCount） */
        const chunk = buf.subarray(this.outputQueueReadSampleIndex, this.outputQueueReadSampleIndex + copyCount);
        // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
        for (const ch of outputChannels) ch.set(chunk, written);

        this.outputQueueReadSampleIndex += copyCount;
        this.outputBufferQueueSampleCount -= copyCount;
        written += copyCount;

        if (this.outputQueueReadSampleIndex >= buf.length) {
          this.outputQueueReadBufferIndex++;
          this.outputQueueReadSampleIndex = 0;
        }
      }
      /**  如果数据不够填满一帧（例如网络卡顿），剩余部分补 0（静音） */
      if (written < frameSamples) {
        // 将数据写入所有声道（通常 output 有 1 或 2 个声道）
        for (const ch of outputChannels) ch.fill(0, written);
        return false; // 缓冲不足，产生欠载
      }

      return true;
    }
  }

  /**
   * 速率计算控制器
   * 负责：根据当前缓冲区深度，决定下一帧是 1.0x 还是加速
   */
  class BufferRateController {
    // private currentReadSamplesPerFrame = this.processorBuffer.processFrameSize;
    /** 累计已播放的样本数（统计用途） */
    // private totalOutputSamples = 0;

    // ==========================================
    // 自适应缓冲控制 (Adaptive Buffer Control)
    // ==========================================
    /** 最小安全缓冲阈值（50ms），低于此值可能发生卡顿 */
    private readonly minSafeBufferSamples = sampleRate * 0.05;

    /** 动态目标缓冲大小（根据网络抖动自动调整） */
    private targetBufferSamples = sampleRate * 0.1;

    /** 最大允许加速倍率 */
    private readonly MAX_SPEED = 1.6;

    /** 极端积压阈值（5 秒），超过后强制最大倍速追帧 */
    private readonly panicBufferSamples = sampleRate * 5;

    /** 连续稳定运行的样本数（用于评估网络质量） */
    private stableRunningSamples = 0;

    // ==========================================
    // 预测与平滑控制参数
    // ==========================================
    /** 预测周期：每隔一定样本数重新计算目标缓冲 */
    private readonly PREDICT_INTERVAL_SAMPLES = sampleRate * 3;
    /** 距离上次预测经过的样本数 */
    private samplesSinceLastPrediction = 0;

    /** 当前实际播放速率 */
    private currentSpeed = 1.0;

    /** 加速平滑系数（越小越慢） */
    private readonly SMOOTH_ALPHA = 0.0001;

    constructor(
      /** 当前播放速率对应的“读取样本数”（以 128 为 1x） */
      private currentReadSamplesPerFrame: number
    ) {}

    /**
     * 核心算法：根据网络稳定性预测最佳缓冲大小
     * * 原理：
     * 1. 运行越稳定 (stableDurationSamples 越大)，目标缓冲越小 (追求低延迟)。
     * 2. 缓冲积压越多，越需要加速播放。
     */
    private updateTargetBufferSamples(bufferedSamples: number) {
      // 节流：未到预测时间点则跳过
      if (this.samplesSinceLastPrediction < this.PREDICT_INTERVAL_SAMPLES) {
        return;
      }
      this.samplesSinceLastPrediction = 0;

      // 缓冲严重不足时，直接回退到最小安全值
      if (bufferedSamples <= this.minSafeBufferSamples) {
        this.targetBufferSamples = this.minSafeBufferSamples;
        return;
      }

      // 计算缩减比率
      // 稳定半衰期：约 1秒
      const STABLE_HALF_LIFE = sampleRate;
      const MAX_REDUCE_RATIO = 0.8;
      const SAFE_MARGIN = this.minSafeBufferSamples;

      // 稳定因子：运行越久，越接近 1
      const stabilityFactor = 1 - Math.exp(-this.stableRunningSamples / STABLE_HALF_LIFE);

      // 安全因子：缓冲余量越充足，越接近 1
      const excess = bufferedSamples - this.minSafeBufferSamples;
      const safetyFactor = excess >= SAFE_MARGIN ? 1 : excess / SAFE_MARGIN;

      // 综合缩减比率
      const reduceRatio = MAX_REDUCE_RATIO * stabilityFactor * safetyFactor;

      // 计算建议的新缓冲大小（逐步逼近 minSafe，而不是随 buffer 线性下降）
      const suggested =
        this.targetBufferSamples - (this.targetBufferSamples - this.minSafeBufferSamples) * (1 - reduceRatio);

      // 限制在 [最小安全值, 1 秒]
      this.targetBufferSamples = Math.min(Math.max(suggested, this.minSafeBufferSamples), sampleRate);
    }

    /**
     * 计算当前应使用的播放速率（最终速率不会低于 1x）
     */
    private calculateTargetSpeed(outputBufferQueueSampleCount: number): number {
      // 极端积压：直接 MAX_SPEED 倍速
      if (outputBufferQueueSampleCount > this.panicBufferSamples) return this.MAX_SPEED;

      // 更新目标缓冲水位线
      this.updateTargetBufferSamples(outputBufferQueueSampleCount);

      // 缓冲健康：正常 1 倍速
      if (outputBufferQueueSampleCount < this.targetBufferSamples) return 1;

      // 缓冲偏多 -> 线性插值计算加速倍率
      const speedFactor =
        1 +
        (outputBufferQueueSampleCount - this.targetBufferSamples) /
          (this.panicBufferSamples - this.targetBufferSamples);

      return Math.min(speedFactor, this.MAX_SPEED);
    }

    /**
     * 处理一次需要多少音频数据
     * @param frameOutputSamples 一次处理输出样本数（通常为 128）
     * @param outputBufferQueueSampleCount 当前输出缓存队列中的样本数
     * @returns 实际应该读取的样本数（根据当前播放速率）
     */
    public process(frameOutputSamples: number, outputBufferQueueSampleCount: number) {
      /** 稳定运行时间（用于计算播放速率）
       */
      // if (this.currentSpeed === 1) {
      this.stableRunningSamples += frameOutputSamples;
      // } else {
      //   // 发生追帧说明网络不稳定，稳定计数回退（避免误判为长期稳定）
      //   this.stableRunningSamples *= 0.98;
      // }

      // 预测节流计时
      this.samplesSinceLastPrediction =
        outputBufferQueueSampleCount < 0
          ? -this.PREDICT_INTERVAL_SAMPLES
          : this.samplesSinceLastPrediction + frameOutputSamples;

      /** 发生卡顿了 **/
      if (this.samplesSinceLastPrediction < 0) {
        /** 发生卡顿了，并且还没有缓存，直接1倍数 */
        this.currentSpeed = 1;
        return (this.currentReadSamplesPerFrame = frameOutputSamples);
      }

      const targetSpeed = Math.max(1, this.calculateTargetSpeed(outputBufferQueueSampleCount));

      // ================================
      // 核心改动：只对“加速”做平滑
      // ================================
      if (targetSpeed > this.currentSpeed) {
        // 加速 → 平滑
        this.currentSpeed += (targetSpeed - this.currentSpeed) * this.SMOOTH_ALPHA;
      } else {
        // 降速 → 立即
        this.currentSpeed = targetSpeed;
      }

      return (this.currentReadSamplesPerFrame = Math.round(frameOutputSamples * this.currentSpeed));
    }

    public reset() {
      this.stableRunningSamples = 0;

      /** 发生卡顿了，直接加一个预测周期的CD，锁死1倍速 */
      this.samplesSinceLastPrediction = -this.PREDICT_INTERVAL_SAMPLES;

      // 立刻回到 1x
      this.currentSpeed = 1;

      // 卡顿后适当提高安全缓冲
      this.targetBufferSamples = Math.min(this.targetBufferSamples + sampleRate * 0.005, sampleRate);
    }

    public get statistics() {
      return {
        outputPlaySpeed: `+${this.currentReadSamplesPerFrame - 128}`,
        stableSamples: this.stableRunningSamples,
        playSpeedx1SampleCount: this.targetBufferSamples,
      };
    }
  }

  // === 注册 AudioWorkletProcessor ===
  registerProcessor(
    registerProcessorName,
    class extends AudioWorkletProcessor {
      // ==========================================
      // 基础配置
      // ==========================================

      private engine = new ResamplerEngine();
      private controller = new BufferRateController(this.engine.processFrameSize);

      constructor() {
        super();

        // ===============================
        // 接收主线程推送的播放数据
        // ===============================
        this.port.onmessage = ({ data }) => this.engine.onOutputData(data.buffer);
      }

      /**
       * AudioWorklet 主处理函数
       * 每 128 个采样点 (Quantum) 执行一次
       */
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        // 1. 处理录音
        const inputBuffer = this.engine.onInputData(inputs);
        if (inputBuffer) {
          const message: IAudioInputOutputProcessorMessage = {
            buffer: inputBuffer,
            sampleRate,
            // 附带当前的播放状态供调试/监控
            outputSampleCount: this.engine.outputBufferQueueSampleCount,
            ...this.controller.statistics,
          };
          // 发送，并利用第二个参数声明“转移所有权”
          // 注意：转移的是 ArrayBuffer，而不是 Float32Array 视图
          this.port.postMessage(message, [inputBuffer.buffer]); // 零拷贝转移所有权
        }

        // 2. 处理播放（Queue -> Output）
        const outputChannels = outputs[0];
        /** 输出缓存大小（对应一次 postMessage 的数据量） */
        const frameSamples = outputChannels[0].length;

        const consume = this.controller.process(frameSamples, this.engine.outputBufferQueueSampleCount);

        if (consume === this.engine.processFrameSize) {
          // 1x速：高性能路径
          if (!this.engine.outputNormalSpeed(outputChannels, frameSamples)) {
            // 缓存不足，重置控制器
            this.controller.reset();
          }
        } else {
          // 变速：重采样路径  (1.x ~ 2.0 倍速)
          this.engine.resampleAndOutput(outputChannels, frameSamples, consume);
        }

        this.engine.compactQueue();
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
    // 强制要求浏览器以此频率运行 Worklet
    ctx = new AudioContext({ sampleRate: 48000 })
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
      this.audioNode.port.onmessage = ({ data }) => this.onInputData(data);
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
  public onInputData({
    buffer,
    sampleRate,
    outputSampleCount,
    outputPlaySpeed,
    stableSamples,
    playSpeedx1SampleCount,
  }: IAudioInputOutputProcessorMessage) {
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

// // 测试用例
// class Echo {
//   private readonly queue: Float32Array[] = [];
//   private timer = 0;
//   public onmessage = (data: Float32Array) => {};
//   private clean = () => {
//     this.timer = 0;
//     let item: Float32Array | undefined;
//     while ((item = this.queue.shift())) this.onmessage(item);
//   };
//   public send = (data: Float32Array) => {
//     this.queue.push(data);
//     if (this.timer) return;
//     this.timer = Number(setTimeout(this.clean, Math.random() > 0.995 ? 3000 : (Math.random() * 10) ** 2));
//   };
// }
// const echo = new Echo();
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
//     audioInputOutputProcessor.onInputData = buffer => echo.send(buffer);
//     echo.onmessage = buffer => {
//       /** 把回声数据送到扬声器 */
//       audioInputOutputProcessor.pushOutputData(buffer, frameIndex);
//       frameIndex += buffer.length;
//     };
//   });
