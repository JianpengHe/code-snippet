import { ReliableRTCPeerConnection } from "./ReliableRTCPeerConnection";
/**
 * 单路视频流的详细统计信息
 */
export interface VideoStreamStats {
  /** 分辨率 { width, height } */
  resolution: { width: number; height: number };
  /** 帧率 (fps) */
  framesPerSecond: number;
  /** 码率 (kbps) */
  bitrateKbps: number;
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
 * 包含上行和下行视频流的完整统计信息
 */
export interface StreamingStats {
  /** 我方发送给远端的视频流信息 (Outbound) */
  outboundVideo: VideoStreamStats | null;
  /** 我方从远端接收的视频流信息 (Inbound) */
  inboundVideo: VideoStreamStats | null;
}

/**
 * @fileoverview 扩展了 ReliableRTCPeerConnection, 增加了基于网络状况的自适应视频质量控制功能。
 */

export class ReliableVideoRTC extends ReliableRTCPeerConnection {
  // --- 视频质量控制参数 (保持不变) ---
  private static readonly MAX_BITRATE = 10_000_000;
  private static readonly MIN_BITRATE = 500_000;
  private static readonly START_BITRATE = 2_500_000;
  private static readonly ADAPTATION_INTERVAL = 5000;

  // --- 内部状态 ---
  private videoSender: RTCRtpSender | null = null;
  private adaptationIntervalId: number = 0;
  private lastStatsReport: RTCStatsReport | null = null;
  /**
   * 由用户传入的本地媒体流
   */
  private readonly localStream: MediaStream;

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
    this.stopQualityAdaptation();
    if (this.role === "offer") {
      pc.addTransceiver("audio", { direction: "sendrecv" });
      pc.addTransceiver("video", { direction: "sendrecv" });
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
      pc.addTransceiver(track, { direction: "sendrecv" });
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
  private setManagedVideoSender(sender: RTCRtpSender): void {
    this.videoSender = sender;
    console.log("✅ 自适应质量控制器已接管 Video Sender。");
    // 设置初始编码参数
    const parameters = this.videoSender.getParameters();
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}];
    }
    parameters.encodings[0].maxBitrate = ReliableVideoRTC.START_BITRATE;
    parameters.encodings[0].scaleResolutionDownBy = 1.0;
    this.videoSender.setParameters(parameters).catch(err => {
      console.error("设置初始视频参数失败:", err);
    });
  }

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
  private startQualityAdaptation(): void {
    if (this.adaptationIntervalId) {
      clearInterval(this.adaptationIntervalId);
    }

    if (!this.videoSender) {
      // 如果没有通过 addManagedVideoTrack 添加，尝试自动查找
      this.videoSender = this.peerConnection?.getSenders().find(s => s.track?.kind === "video") || null;
      if (!this.videoSender) {
        console.warn("未找到视频发送器(Video Sender)，无法启动质量自适应功能。");
        return;
      }
    }

    console.log("🚀 启动视频质量自适应监控...");
    this.adaptationIntervalId = window.setInterval(
      this.adaptVideoQuality.bind(this),
      ReliableVideoRTC.ADAPTATION_INTERVAL
    );
  }

  /**
   * 停止质量自适应监控。
   */
  private stopQualityAdaptation(): void {
    if (this.adaptationIntervalId) {
      console.log("🛑 停止视频质量自适应监控。");
      clearInterval(this.adaptationIntervalId);
      this.adaptationIntervalId = 0;
      this.lastStatsReport = null;
    }
  }

  /**
   * 核心方法：检查网络状态并调整视频码率。
   */
  private async adaptVideoQuality(): Promise<void> {
    if (!this.videoSender || !this.lastStatsReport) {
      // 第一次运行时，仅获取数据，不作调整
      if (this.videoSender) {
        this.lastStatsReport = await this.videoSender.getStats();
      }
      return;
    }

    const currentStats = await this.videoSender.getStats();
    let currentBitrate = 0;

    // --- 数据分析 ---
    currentStats.forEach(report => {
      if (report.type === "outbound-rtp" && report.kind === "video") {
        const lastReport = this.lastStatsReport!.get(report.id);
        if (lastReport) {
          // 计算当前实际发送码率 (bps)
          const bytesSent = report.bytesSent - lastReport.bytesSent;
          const timeDiff = (report.timestamp - lastReport.timestamp) / 1000; // aec
          if (timeDiff > 0) {
            currentBitrate = (bytesSent * 8) / timeDiff;
          }

          // --- 决策逻辑 ---
          const params = this.videoSender!.getParameters();
          if (!params.encodings?.[0]) return;

          let newMaxBitrate = params.encodings[0].maxBitrate || ReliableVideoRTC.START_BITRATE;

          // 获取网络质量指标
          const roundTripTime = report.roundTripTime ? report.roundTripTime * 1000 : 0; // in ms
          const nackCount = report.nackCount - (lastReport.nackCount || 0);

          console.log(
            `[网络诊断] RTT: ${roundTripTime}ms, NACKs(增量): ${nackCount}, 当前码率: ${(
              currentBitrate / 1_000_000
            ).toFixed(2)} Mbps`
          );

          // 1. 如果网络状况良好 (低延迟，无丢包)，逐步增加码率
          if (roundTripTime < 250 && nackCount === 0) {
            newMaxBitrate *= 1.1; // 增加 10%
          }
          // 2. 如果出现中等网络问题 (延迟增加或少量丢包)，降低码率
          else if (roundTripTime > 400 || nackCount > 5) {
            newMaxBitrate *= 0.85; // 降低 15%
          }
          // 3. 如果网络状况很差 (高延迟且大量丢包)，大幅降低码率
          else if (roundTripTime > 600 || nackCount > 10) {
            newMaxBitrate *= 0.7; // 降低 30%
          }

          // 确保新码率在设定的最大/最小范围内
          newMaxBitrate = Math.max(ReliableVideoRTC.MIN_BITRATE, Math.min(newMaxBitrate, ReliableVideoRTC.MAX_BITRATE));

          // 如果新旧码率变化不大，则不进行调整，防止抖动
          if (Math.abs(newMaxBitrate - params.encodings[0].maxBitrate!) < 100_000) {
            return;
          }

          console.log(
            `[质量调整] 目标最大码率从 ${(params.encodings[0].maxBitrate! / 1000).toFixed(0)} kbps 调整为 ${(
              newMaxBitrate / 1000
            ).toFixed(0)} kbps`
          );
          params.encodings[0].maxBitrate = newMaxBitrate;
          this.videoSender!.setParameters(params).catch(err => console.error("调整码率失败:", err));
        }
      }
    });

    this.lastStatsReport = currentStats;
  }
  /**
   * [核心API] 获取当前上行和下行视频流的详细统计信息。
   * 这是一个异步方法，返回一个包含分辨率、帧率、码率、编码器等信息的对象。
   * @returns {Promise<StreamingStats>} 包含音视频流详细信息的 Promise。
   */
  public async getStreamingStats(): Promise<StreamingStats> {
    if (!this.peerConnection) {
      console.warn("PeerConnection尚未初始化，无法获取统计信息。");
      return { outboundVideo: null, inboundVideo: null };
    }

    const report = await this.peerConnection.getStats();
    const stats: StreamingStats = { outboundVideo: null, inboundVideo: null };

    // 为了计算码率，我们需要与上一次的统计数据进行比较
    const lastReport = this.lastStatsReport;

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

      let targetStat: Partial<VideoStreamStats> = {}; // 使用 Partial 方便构建
      let isProcessed = false;

      // --- 处理我方接收的视频流 (Inbound) ---
      if (stat.type === "inbound-rtp") {
        targetStat.resolution = { width: stat.frameWidth, height: stat.frameHeight };
        targetStat.framesPerSecond = stat.framesPerSecond;
        targetStat.codec = codecMap.get(stat.codecId) || "N/A";
        targetStat.packetsLost = stat.packetsLost;
        targetStat.nackCount = stat.nackCount;
        targetStat.pliCount = stat.pliCount;
        targetStat.jitter = stat.jitter;

        if (lastReport) {
          const lastInboundStat = lastReport.get(stat.id);
          if (lastInboundStat) {
            const bytesReceived = stat.bytesReceived - lastInboundStat.bytesReceived;
            const timeDiff = (stat.timestamp - lastInboundStat.timestamp) / 1000;
            targetStat.bitrateKbps = timeDiff > 0 ? Math.round((bytesReceived * 8) / timeDiff / 1000) : 0;
          }
        }
        stats.inboundVideo = targetStat as VideoStreamStats;
        isProcessed = true;
      }

      // --- 处理我方发送的视频流 (Outbound) ---
      if (stat.type === "outbound-rtp") {
        targetStat.resolution = { width: stat.frameWidth, height: stat.frameHeight };
        targetStat.framesPerSecond = stat.framesPerSecond;
        targetStat.codec = codecMap.get(stat.codecId) || "N/A";
        targetStat.nackCount = stat.nackCount;
        targetStat.pliCount = stat.pliCount;
        // Inbound-only stats
        targetStat.packetsLost = 0;
        targetStat.jitter = 0;

        if (lastReport) {
          const lastOutboundStat = lastReport.get(stat.id);
          if (lastOutboundStat) {
            const bytesSent = stat.bytesSent - lastOutboundStat.bytesSent;
            const timeDiff = (stat.timestamp - lastOutboundStat.timestamp) / 1000;
            targetStat.bitrateKbps = timeDiff > 0 ? Math.round((bytesSent * 8) / timeDiff / 1000) : 0;
          }
        }
        stats.outboundVideo = targetStat as VideoStreamStats;
        isProcessed = true;
      }
    });

    // 更新 lastStatsReport 以便下次计算码率
    // 注意：这个方法和质量自适应方法共享 lastStatsReport
    this.lastStatsReport = report;

    return stats;
  }
}
