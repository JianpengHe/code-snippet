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
export interface VideoStreamStats {
  /** 分辨率 { width, height } */
  width: number;
  height: number;
  /** 帧率 (fps) */
  framesPerSecond: number;
  /** 编码器 mimeType, e.g., "video/VP9" */
  codec: string;
  /** 数据包丢失总数 */
  packetsLost: number;
  /** NACK（丢包重传请求）总数 */
  nackCount: number;
  /** PLI（关键帧请求）总数 */
  pliCount: number;
  /** 网络抖动 (seconds) */
  jitter: number;
}

/**
 * @fileoverview 扩展了 ReliableRTCPeerConnection, 增加了基于网络状况的自适应视频质量控制功能。
 */

export class ReliableVideoRTC extends ReliableRTCPeerConnection {
  // --- 视频质量控制参数 (保持不变) ---
  // private static readonly MAX_BITRATE = 10_000_000;
  // private static readonly MIN_BITRATE = 500_000;
  // private static readonly START_BITRATE = 2_500_000;
  // private static readonly ADAPTATION_INTERVAL = 5000;

  // --- 内部状态 ---
  // private videoSender: RTCRtpSender | null = null;
  // private adaptationIntervalId: number = 0;
  // private lastStatsReport: RTCStatsReport | null = null;
  /**
   * 由用户传入的本地媒体流
   */
  private readonly localStream: MediaStream;
  public onTransceiver(transceiver: RTCRtpTransceiver) {}
  constructor(
    stream: MediaStream,
    remoteVideo?: HTMLVideoElement | null,
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
    this.on("connected", this.startQualityAdaptation.bind(this));
    this.on("track", ({ track }) => {
      if (!remoteVideo) return;
      const remoteStream = (remoteVideo.srcObject as MediaStream) || (remoteVideo.srcObject = new MediaStream());
      for (const t of remoteStream.getTracks()) {
        if (t.kind === track.kind) remoteStream.removeTrack(t);
      }
      remoteStream.addTrack(track);
      remoteVideo.play().catch(e => console.error("远端视频播放失败:", e));
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
      }
      existingTransceiver.direction = track ? "sendrecv" : "recvonly";
    } else if (track) {
      // 创建新的 Transceiver (Offerer 路径)
      console.log(`创建新的 ${kind} Transceiver。`);
      this.onTransceiver(pc.addTransceiver(track, { direction: "sendrecv" }));
    }

    // 如果是视频，找到对应的 sender 并交由质量监控
    if (kind === "video") {
      const videoSender = pc.getSenders().find(s => s.track === track);
      if (videoSender) {
        this.setManagedVideoSender(videoSender);
      }
    }
  }

  /**
   * [内部] 设置 video sender 以便进行质量控制。
   */
  private setManagedVideoSender(sender: RTCRtpSender): void {}

  // setCodecPriority, startQualityAdaptation, stopQualityAdaptation, adaptVideoQuality 等其他内部方法保持不变...
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
    const preferredCodecOrder = ["video/AV1", "video/VP9", "video/VP8"];
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
  private startQualityAdaptation(): void {
    console.log("🚀 启动视频质量自适应监控...");
  }

  /**
   * [核心API] 获取当前上行和下行视频流的详细统计信息。
   * 这是一个异步方法，返回一个包含分辨率、帧率、码率、编码器等信息的对象。
   * @returns {Promise<StreamingStats>} 包含音视频流详细信息的 Promise。
   */
  public async getStreamingStats(
    type: "outbound-rtp" | "inbound-rtp" = "inbound-rtp"
  ): Promise<VideoStreamStats | null> {
    if (!this.peerConnection) {
      console.warn("PeerConnection尚未初始化，无法获取统计信息。");
      return null;
    }

    const report = await this.peerConnection.getStats();

    const output: VideoStreamStats = {
      width: 0,
      height: 0,
      framesPerSecond: 0,
      codec: "",
      packetsLost: 0,
      nackCount: 0,
      pliCount: 0,
      jitter: 0,
    };

    // 为了计算码率，我们需要与上一次的统计数据进行比较

    // 首先，创建一个 Codec ID 到 MimeType 的映射
    const codecMap = new Map<string, string>();
    report.forEach(stat => {
      if (stat.type === "codec") {
        codecMap.set(stat.id, stat.mimeType);
      }
    });

    // 遍历统计报告，查找 inbound 和 outbound 视频流
    report.forEach(stat => {
      const kind = stat.kind || stat.mediaType; // 兼容不同浏览器
      if (kind !== "video") {
        return;
      }

      if (stat.type === type) {
        output.width = stat.frameWidth;
        output.height = stat.frameHeight;
        output.framesPerSecond = stat.framesPerSecond;
        output.codec = codecMap.get(stat.codecId) || "N/A";
        output.packetsLost = stat.packetsLost;
        output.nackCount = stat.nackCount;
        output.pliCount = stat.pliCount;
        output.jitter = stat.jitter;
      }
    });

    return output;
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
    // const now = new Date().getTime();
    // const wsURL = new URL(`${now}.webm`, location.href);
    // wsURL.protocol = wsURL.protocol.replace("http", "ws");
    // wsURL.search = "?uid=" + uid;
    // const ws = new ReliableWebSocket(wsURL);

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
        // setTimeout(() => {
        //   // 视频的尺寸信息 (必须提供)
        //   const videoWidth = 1280;
        //   const videoHeight = 720;

        //   // 调用函数进行转换
        //   try {
        //     const ivfBlob = encodeFramesToIVF(arr, {
        //       width: videoWidth,
        //       height: videoHeight,
        //       fourcc: "AV01", // 确保你的码流是 AV1
        //     });

        //     console.log(`IVF Blob created successfully! Size: ${ivfBlob.size} bytes`);

        //     // 现在你可以使用这个 blob 了，例如生成一个下载链接
        //     const url = URL.createObjectURL(ivfBlob);
        //     const a = document.createElement("a");
        //     a.href = url;
        //     a.download = "recorded_video.ivf"; // FFmpeg 可以直接处理 .ivf 文件
        //     document.body.appendChild(a);
        //     a.click();
        //     document.body.removeChild(a);
        //     URL.revokeObjectURL(url);
        //   } catch (error) {
        //     console.error("Failed to encode frames to IVF:", error);
        //   }
        // }, 10000);
      } catch (e) {
        console.error(e);
      }
      return true;
    }
    return false;
  }
}
