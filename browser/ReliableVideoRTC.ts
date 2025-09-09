import { ReliableRTCPeerConnection } from "./ReliableRTCPeerConnection";
// const logPanel = document.getElementById("logPanel") as HTMLDivElement;
// const console = new Proxy(window.console, {
//   get(target, type) {
//     return (message: string, ...a): void => {
//       const p = document.createElement("pre");
//       p.innerHTML = `[${new Date().toLocaleTimeString()}] ${String(message)}`;

//       p.className = String(type);
//       logPanel.appendChild(p);
//       window.console[type](message, ...a);
//     };
//   },
// });
/**
 * 单路视频流的详细统计信息
 */

export interface RTCEncodedFrame {
  type?: string;
  timestamp: number;
  data: ArrayBuffer;
  track: MediaStreamTrack;
  now: number;
}

export interface IStreamStats {
  /** 视频编码器 mimeType, e.g., "video/VP9" */
  videoCodec: string;
  /** 音频编码器 mimeType, e.g., "audio/opus" */
  audioCodec: string;

  // 通用属性
  /** 视频 NACK（丢包重传请求）总数 */
  videoNackCount: number;
  /** 视频网络抖动 (seconds) */
  videoJitter: number;
  /** 视频发送/接收的字节总数 */
  videoBytesProcessed: number;
  /** 视频发送/接收的数据包总数 */
  videoPacketsProcessed: number;
  /** 视频丢失的数据包总数 (仅限接收流) */
  videoPacketsLost?: number;
  /** 音频 NACK（丢包重传请求）总数 */
  audioNackCount: number;
  /** 音频网络抖动 (seconds) */
  audioJitter: number;
  /** 音频发送/接收的字节总数 */
  audioBytesProcessed: number;
  /** 音频发送/接收的数据包总数 */
  audioPacketsProcessed: number;
  /** 音频丢失的数据包总数 (仅限接收流) */
  audioPacketsLost?: number;

  // --- 视频流特有属性 ---

  /** 视频帧宽度（像素）(仅限接收流)。*/
  frameWidth?: number;

  /** 视频帧高度（像素）(仅限接收流)。*/
  frameHeight?: number;

  /** 视频帧率（每秒帧数）(仅限接收流)。*/
  framesPerSecond?: number;

  /** 解码的帧数 (仅限接收流)。*/
  framesDecoded?: number;

  /** 丢弃的帧数 (仅限接收流)。*/
  framesDropped?: number;

  /** PLI（关键帧请求）的总数。*/
  pliCount?: number;

  /** FIR（帧内请求）的总数。*/
  firCount?: number;

  // --- 音频流特有属性 ---

  /** 音频电平（响度）。*/
  audioLevel?: number;

  /** 音频总能量。*/
  totalAudioEnergy?: number;

  /** 被隐藏（如由于丢包）的音频样本数。*/
  concealedSamples?: number;

  /** 隐藏事件（如丢包导致的静音填充）的总数。*/
  concealmentEvents?: number;

  /** 抖动缓冲区的延迟（毫秒）(仅限接收流)。*/
  jitterBufferDelay?: number;

  /** 从抖动缓冲区发出的样本总数。*/
  jitterBufferEmittedCount?: number;

  /** 接收到的音频样本总数。*/
  totalSamplesReceived?: number;

  // --- 发送流特有属性 ---
  /** 流是否处于活跃状态。*/
  active?: boolean;

  /** 目标码率（比特每秒）。*/
  targetBitrate?: number;
}

export class ReliableVideoRTC extends ReliableRTCPeerConnection {
  /**
   * 由用户传入的本地媒体流
   */
  private readonly localStream: MediaStream;
  public onTransceiver(transceiver: RTCRtpTransceiver) {}
  constructor(
    stream: MediaStream,
    remoteVideo?: HTMLVideoElement | null,
    muted = false,
    rtcConfig: RTCConfiguration = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    },
    maxReconnectAttempts = 10
  ) {
    super(rtcConfig, maxReconnectAttempts);
    this.localStream = stream;

    // 将所有事件处理函数绑定到类内部，实现完全封装
    this.on("beforeNegotiation", this.onBeforeNegotiation.bind(this));
    this.on("beforeCreateOfferAnswer", this.onBeforeCreateOfferAnswer.bind(this));
    // this.on("connected", this.startQualityAdaptation.bind(this));
    this.on("track", ({ track }) => {
      if (!remoteVideo) return;
      const remoteStream = (remoteVideo.srcObject as MediaStream) || (remoteVideo.srcObject = new MediaStream());
      for (const t of remoteStream.getTracks()) {
        if (t.kind === track.kind) remoteStream.removeTrack(t);
      }
      remoteStream.addTrack(track);
      remoteVideo.play().catch(e => console.error("远端视频播放失败:", e));
      remoteVideo.muted = muted;
    });
  }

  /**
   * [内部] 在协商开始前，设置编码器优先级。
   */
  private onBeforeNegotiation(pc: RTCPeerConnection): void {
    // this.stopQualityAdaptation();

    if (this.role === "offer") {
      this.onTransceiver(pc.addTransceiver("audio", { direction: "sendrecv" }));
      this.onTransceiver(pc.addTransceiver("video", { direction: "sendrecv" }));
    }
    this.setCodecPriority(pc);
  }

  /**
   * [内部] 在创建 Offer/Answer 前，处理所有 Transceiver 逻辑。
   * 这是实现封装的核心，它取代了所有外部的轨道管理代码。
   */
  private onBeforeCreateOfferAnswer(pc: RTCPeerConnection): void {
    console.log("onBeforeCreateOfferAnswer");

    console.log("准备创建 Offer/Answer，内部开始处理 Transceiver...");
    const videoTrack = this.localStream.getVideoTracks()[0] || null;
    const audioTrack = this.localStream.getAudioTracks()[0] || null;

    // --- 统一处理视频轨道 ---
    this.manageTransceiver("video", videoTrack, pc);

    // --- 统一处理音频轨道 ---
    this.manageTransceiver("audio", audioTrack, pc);
  }

  /**
   * [内部] 通用的 Transceiver 管理函数，强制使用 addTransceiver API。
   */
  private manageTransceiver(kind: "video" | "audio", track: MediaStreamTrack | null, pc: RTCPeerConnection): void {
    const existingTransceiver = pc.getTransceivers().find(t => t.receiver.track?.kind === kind);

    if (existingTransceiver) {
      // 复用已有的 Transceiver (Answerer 路径)
      console.log(`复用已有的 ${kind} Transceiver。`);
      if (existingTransceiver.sender.track !== track) {
        existingTransceiver.sender.replaceTrack(track);
        // this.onTransceiver(existingTransceiver);
      }
      existingTransceiver.direction = track ? "sendrecv" : "recvonly";
    } else if (track) {
      // 创建新的 Transceiver (Offerer 路径)
      console.log(`创建新的 ${kind} Transceiver。`);
      this.onTransceiver(pc.addTransceiver(track, { direction: "sendrecv" }));
    }

    // 如果是视频，找到对应的 sender 并交由质量监控
    // if (kind === "video") {
    //   const videoSender = pc.getSenders().find(s => s.track === track);
    //   if (videoSender) {
    //     this.setManagedVideoSender(videoSender);
    //   }
    // }
  }

  /**
   * [内部] 设置 video sender 以便进行质量控制。
   */
  // private setManagedVideoSender(sender: RTCRtpSender): void {}

  /**
   * 设置视频编码器优先级。
   * 按照 AV1 > H265 > VP9 > H264 > VP8 的顺序设置偏好。
   */
  private setCodecPriority(pc: RTCPeerConnection): void {
    const videoTransceiver = pc
      .getTransceivers()
      .find(t => t.sender.track?.kind === "video" || t.receiver.track?.kind === "video");

    if (!videoTransceiver) return;
    // @ts-ignore
    if (videoTransceiver.codecPreferences && videoTransceiver.codecPreferences.length > 0) return;
    const preferredCodecOrder = ["video/AV1", "video/H265", "video/VP9", "video/H264", "video/VP8"];

    const capabilities = RTCRtpSender.getCapabilities("video");
    if (!capabilities) return;
    const { codecs } = capabilities;
    const sortedCodecs: any[] = [];
    preferredCodecOrder.forEach(mimeType =>
      sortedCodecs.push(...codecs.filter(c => c.mimeType.toLowerCase() === mimeType.toLowerCase()))
    );
    const remainingCodecs = codecs.filter(
      c => !sortedCodecs.some(sc => sc.mimeType === c.mimeType && sc.sdpFmtpLine === c.sdpFmtpLine)
    );
    sortedCodecs.push(...remainingCodecs);
    try {
      videoTransceiver.setCodecPreferences(sortedCodecs);
      console.log("✅ 已成功设置视频编码器优先级。");
    } catch (err) {
      console.error("❌ 设置编码器偏好失败:", err);
    }
  }

  /**
   * 当连接成功建立后，启动质量自适应监控。
   */
  // private startQualityAdaptation(): void {
  //   console.log("🚀 启动视频质量自适应监控...");
  // }

  /**
   * [核心API] 获取当前上行和下行视频流的详细统计信息。
   * 这是一个异步方法，返回一个包含音视频详细统计信息的对象。
   * @param {string} bound - 指定获取入站 ("inbound-rtp") 或出站 ("outbound-rtp") 统计信息。
   * @returns {Promise<IStreamStats | null>} 包含音视频流详细信息的 Promise。
   */
  public async getStreamingStats(bound: "outbound-rtp" | "inbound-rtp" = "inbound-rtp"): Promise<IStreamStats | null> {
    if (!this.peerConnection) {
      console.warn("PeerConnection尚未初始化，无法获取统计信息。");
      return null;
    }

    const report = await this.peerConnection.getStats();

    // 初始化一个完整的 IStreamStats 对象，为所有属性设置默认值
    const output: IStreamStats = {
      videoCodec: "",
      audioCodec: "",
      videoNackCount: 0,
      videoJitter: 0,
      videoBytesProcessed: 0,
      videoPacketsProcessed: 0,
      audioNackCount: 0,
      audioJitter: 0,
      audioBytesProcessed: 0,
      audioPacketsProcessed: 0,
      // 其他可选属性不在这里初始化，让它们保持 undefined，更符合实际
    };

    // 首先，创建一个 Codec ID 到 MimeType 的映射，方便查找
    const codecMap = new Map<string, string>();
    report.forEach(stat => {
      if (stat.type === "codec") codecMap.set(stat.id, stat.mimeType);
    });

    // 遍历统计报告，填充 IStreamStats 对象
    report.forEach(stat => {
      // 只处理指定的入站或出站流报告
      if (stat.type !== bound) return;

      const kind = stat.kind || stat.mediaType; // 兼容不同浏览器

      // 根据流类型，分别填充视频和音频数据
      if (kind === "video") {
        output.videoCodec = codecMap.get(stat.codecId) || "N/A";
        output.videoNackCount = stat.nackCount || 0;
        output.videoJitter = stat.jitter || 0;
        output.videoBytesProcessed = stat.bytesReceived || stat.bytesSent || 0;
        output.videoPacketsProcessed = stat.packetsReceived || stat.packetsSent || 0;

        // 仅入站流有 packetsLost 属性
        if (bound === "inbound-rtp") output.videoPacketsLost = stat.packetsLost;

        // 视频流特有属性
        output.frameWidth = stat.frameWidth;
        output.frameHeight = stat.frameHeight;
        output.framesPerSecond = stat.framesPerSecond;
        output.framesDecoded = stat.framesDecoded;
        output.framesDropped = stat.framesDropped;
        output.pliCount = stat.pliCount;
        output.firCount = stat.firCount;
      } else if (kind === "audio") {
        output.audioCodec = codecMap.get(stat.codecId) || "N/A";
        output.audioNackCount = stat.nackCount || 0;
        output.audioJitter = stat.jitter || 0;
        output.audioBytesProcessed = stat.bytesReceived || stat.bytesSent || 0;
        output.audioPacketsProcessed = stat.packetsReceived || stat.packetsSent || 0;

        // 仅入站流有 packetsLost 属性
        if (bound === "inbound-rtp") output.audioPacketsLost = stat.packetsLost;

        // 音频流特有属性
        output.audioLevel = stat.audioLevel;
        output.totalAudioEnergy = stat.totalAudioEnergy;
        output.concealedSamples = stat.concealedSamples;
        output.concealmentEvents = stat.concealmentEvents;
        output.jitterBufferDelay = stat.jitterBufferDelay;
        output.jitterBufferEmittedCount = stat.jitterBufferEmittedCount;
        output.totalSamplesReceived = stat.totalSamplesReceived;
      }

      // 检查是否有发送流特有属性
      if (bound === "outbound-rtp") {
        output.active = stat.active;
        output.targetBitrate = stat.targetBitrate;
      }
    });

    // 检查是否成功获取到任何统计数据
    if (output.videoCodec || output.audioCodec) return output;
    return null;
  }
  public readFrames() {
    return new Promise<{ frames: RTCEncodedFrame[]; isEnd: () => boolean }>((resolve, reject) => {
      const tracks: Set<MediaStreamTrack> = new Set();
      const frames: RTCEncodedFrame[] = [];
      const read = (receiver: RTCRtpReceiver) => {
        if (!receiver?.track) {
          console.log(receiver);
          throw new Error("not found: " + "transceiver?.receiver");
        }
        const kind = receiver.track.kind;
        if (kind !== "video" && kind !== "audio") return;

        if (
          tracks.has(receiver.track) ||
          !ReliableVideoRTC.getFrames(receiver, data => {
            frames.push({
              type: data.type,
              timestamp: data.timestamp,
              data: data.data,
              track: receiver.track,
              now: Math.floor(performance.now()),
            });
            return data;
          })
        )
          return;
        tracks.add(receiver.track);
        receiver.track.addEventListener("ended", () => tracks.delete(receiver.track));
        console.log(tracks);
        resolve({
          frames,
          isEnd: () => tracks.size === 0,
        });
        return;
      };
      this.onTransceiver = ({ receiver }) => read(receiver);
      this.on("track", ({ receiver }) => read(receiver));
    });
  }
  static getFrames(
    receiver: RTCRtpReceiver,
    onFrame: (frame: { type?: string; timestamp: number; data: ArrayBuffer }) => {
      type?: string;
      timestamp: number;
      data: ArrayBuffer;
    }
  ) {
    // 仅支持音视频 track
    if (receiver.track.kind !== "video" && receiver.track.kind !== "audio") return false;
    // @ts-ignore
    if (receiver.createEncodedStreams) {
      try {
        // 保存原始帧数据
        // @ts-ignore
        const { readable, writable } = receiver.createEncodedStreams();
        const transformStream = new TransformStream({
          transform(encodedFrame, controller) {
            controller.enqueue(onFrame(encodedFrame));
          },
        });

        // --- 步骤 4: 启动流处理 ---
        // 这是比手动 while 循环更推荐的方式
        readable
          .pipeThrough(transformStream)
          .pipeTo(writable)
          .catch(err => {
            console.error("媒体流处理出错:", err);
          });
      } catch (e) {
        console.error(e);
        return false;
      }
      return true;
    }
    return false;
  }
  /**
   * 对 RTCEncodedFrame 数组进行排序。
   * 这个函数确保对于每一个独立的 MediaStreamTrack，其对应的帧都严格按照 timestamp 升序排列。
   * 这对于处理网络传输中乱序到达的媒体帧非常重要。
   * @param frames RTCEncodedFrame 帧数组
   * @returns 排序后的帧数组
   */
  static sortFrames(frames: RTCEncodedFrame[]) {
    // 使用 Map 来记录每个轨道（track）最后遇到的帧的时间戳
    const timeMap = new Map<MediaStreamTrack, number>();

    // 遍历所有待排序的帧
    for (let i = 0; i < frames.length; i++) {
      const { track, timestamp } = frames[i];
      // 获取当前轨道已记录的最新时间戳，如果是新轨道则默认为 0
      const preTimestamp = timeMap.get(track) || 0;

      // 如果当前帧的时间戳小于该轨道之前记录的时间戳，说明发生了乱序
      if (timestamp < preTimestamp) {
        /**
         * 发现乱序帧，需要将其回溯插入到正确的位置。
         */
        let j = i - 1;

        // 从当前位置向前搜索，为这个乱序的帧找到正确的插入点
        while (j >= 0) {
          // 使用后缀递减 j--：先用 j 的当前值获取 frame，然后 j 的值立即减 1
          const frame = frames[j--];

          // 如果不是同一个轨道，就跳过
          if (frame.track !== track) continue;

          // 如果找到了时间戳更小的帧，说明乱序帧应该插在此帧之后
          if (frame.timestamp < timestamp) {
            // 因为在上面 frame[j--] 中，j 已经多减了 1，
            // 所以这里用 j++ 将其“拨回”到正确的索引位置。
            j++;
            break;
          }
        }

        // 暂存需要移动的乱序帧
        const frameToMove = frames[i];
        // 从原位置删除
        frames.splice(i, 1);
        // 在计算出的正确位置 j+1 处插入。
        // 如果循环到底都没找到（即乱序帧是最小的），j 会是 -1，j+1=0，插入到最前面，逻辑正确。
        frames.splice(j + 1, 0, frameToMove);
      }

      // 更新当前轨道的最新时间戳
      timeMap.set(track, timestamp);
    }

    // 返回排序完成的数组
    return frames;
  }
}
