// WebRTCClient.ts

/** 信令消息类型定义 */
type SignalingMessage = {
  type: "offer" | "answer" | "candidate" | "hangup" | "join";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export class WebRTCClient {
  public peerConnection: RTCPeerConnection | null = null;
  private readonly rtcConfig: RTCConfiguration;
  private readonly baseMediaStream: MediaStream; // 保存初始媒体流

  // --- 重连状态 ---
  private reconnectCount = 0;
  private readonly maxReconnectCount = 10;
  private reconnectTimerId: number | null = null;

  // --- 状态标志 ---
  private isNegotiating = false; // 避免重复协商
  public isClosed = false;

  // --- 对外回调 ---
  public onTrack: ((event: RTCTrackEvent) => void) | null = null;
  public onDataChannel: ((event: RTCDataChannelEvent) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;

  /** 网络探测相关 */
  private networkProbeTimer: number | null = null;
  private readonly maxBitrateHigh = 5_000_000;
  private readonly maxBitrateMedium = 2_000_000;
  private readonly maxBitrateLow = 500_000;

  /** 缓存 ICE Candidate */
  private _pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    initialStream: MediaStream,
    rtcConfiguration: RTCConfiguration = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    }
  ) {
    this.baseMediaStream = initialStream;
    this.rtcConfig = rtcConfiguration;
  }

  // 核心修改部分：提供一个清晰的启动方法给呼叫方
  /**
   * 作为呼叫方（Offerer）启动连接
   */
  public start(): void {
    if (this.peerConnection) {
      console.warn("连接已存在，请勿重复启动。");
      return;
    }
    console.log("🚀 作为呼叫方启动连接...");
    this._initPeerConnection();

    // 呼叫方：在创建 Offer 前，使用 addTransceiver 添加轨道
    this.baseMediaStream.getTracks().forEach(track => {
      try {
        this.peerConnection?.addTransceiver(track, { direction: "sendrecv" });
        console.log(`📡 [呼叫方] 已添加 Transceiver 用于 track: ${track.id} (${track.kind})`);
      } catch (err) {
        console.warn("添加 transceiver 失败:", err);
      }
    });

    this._startNetworkProbe();
    // onnegotiationneeded 事件会被自动触发，然后开始创建 Offer
  }

  /** 创建数据通道 */
  public createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel | undefined {
    if (!this.peerConnection) {
      console.error("❌ PeerConnection 未初始化，无法创建 DataChannel。");
      return;
    }
    const channel = this.peerConnection.createDataChannel(label, options);
    console.log(`📡 已创建数据通道 "${label}"`);
    return channel;
  }

  /** 关闭连接并清理资源 */
  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    console.log("🔌 正在关闭 WebRTC 连接...");

    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
    if (this.networkProbeTimer) {
      clearInterval(this.networkProbeTimer);
      this.networkProbeTimer = null;
    }

    if (this.peerConnection) {
      // 移除所有事件监听器
      this.peerConnection.ontrack = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onnegotiationneeded = null;

      // 关闭发送方，停止媒体发送
      this.peerConnection.getSenders().forEach(sender => {
        try {
          sender.track?.stop();
        } catch (e) {
          console.warn("停止 track 失败:", e);
        }
      });

      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.isNegotiating = false;
    this.onConnectionStateChange?.("closed");
    console.log("🔌 WebRTC 连接已关闭。");
  }

  /** 处理信令消息 */
  public async onSignalingMessage(message: SignalingMessage): Promise<void> {
    try {
      switch (message.type) {
        case "join":
          console.log("📩 收到 Join，重新发起协商");
          this._reconnect(); // 重新发起方角色
          break;

        // ====================================================================
        // 核心修改部分：应答方 (Answerer) 的处理逻辑
        // ====================================================================
        case "offer":
          console.log("📩 收到 Offer，创建 Answer...");
          if (this.isNegotiating) {
            console.warn("当前正在协商，延迟处理 Offer...");
            setTimeout(() => this.onSignalingMessage(message), 100);
            return;
          }
          this.isNegotiating = true;

          // 如果是应答方，在这里才初始化 PeerConnection
          if (!this.peerConnection) {
            this._initPeerConnection();
            this._startNetworkProbe(); // 别忘了也为应答方启动网络探测
            if (!this.peerConnection) return;
          }

          // 1. 先设置远端描述，这会自动创建 Transceivers
          await this.peerConnection.setRemoteDescription(message.sdp!);
          console.log("✅ [应答方] 已设置 Remote Description。");

          // 2. 然后将本地轨道添加到由 setRemoteDescription 创建的 Transceiver 上
          //    使用 addTrack 是最简单、最稳妥的方式，它会自动匹配。
          this.baseMediaStream.getTracks().forEach(track => {
            this.peerConnection?.addTrack(track, this.baseMediaStream);
            console.log(`📡 [应答方] 已添加 Track: ${track.id} (${track.kind})`);
          });

          // 3. 创建 Answer
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);
          this._sendSignaling({ type: "answer", sdp: this.peerConnection.localDescription! });
          console.log("✅ [应答方] 已创建并发送 Answer。");

          // 处理缓存的 ICE
          for (const candidate of this._pendingCandidates) {
            await this.peerConnection.addIceCandidate(candidate).catch(err => {
              console.warn("添加缓存 ICE 失败:", err);
            });
          }
          this._pendingCandidates = [];
          this.isNegotiating = false;
          break;

        case "answer":
          console.log("📩 收到 Answer。");
          // isNegotiating 状态可以防止在 setRemoteDescription 未完成时收到其他信令
          if (this.peerConnection?.signalingState === "have-local-offer") {
            await this.peerConnection.setRemoteDescription(message.sdp!);
            console.log("✅ [呼叫方] 已设置 Remote Description (Answer)。");
          } else {
            console.warn("收到意外的 Answer，当前状态:", this.peerConnection?.signalingState);
          }
          break;

        case "candidate":
          if (message.candidate) {
            // 只有在设置了远端描述后才能添加 ICE 候选者
            if (this.peerConnection?.remoteDescription) {
              await this.peerConnection.addIceCandidate(message.candidate).catch(err => {
                console.warn("添加 ICE 失败:", err);
              });
            } else {
              // 否则先缓存起来
              this._pendingCandidates.push(message.candidate);
            }
          }
          break;

        case "hangup":
          this.close();
          break;
      }
    } catch (err) {
      console.error("❌ 处理信令消息时出错:", err);
      this.isNegotiating = false; // 出错时重置状态
    }
  }
  /**
   * 初始化并根据角色决定是否协商
   * @param isOfferer - 是否作为发起方
   */
  private _initAndNegotiate(isOfferer = true): void {
    this._initPeerConnection();

    this.baseMediaStream.getTracks().forEach(track => {
      try {
        this.peerConnection?.addTrack(track, this.baseMediaStream);
      } catch (err) {
        console.warn("添加 track 失败:", err);
      }
    });

    if (isOfferer) {
      // 作为发起方，onnegotiationneeded 会被自动触发
      console.log("作为发起方初始化，等待 onnegotiationneeded 事件。");
    }

    this._startNetworkProbe();
  }

  /** 初始化 RTCPeerConnection (不再负责添加轨道) */
  private _initPeerConnection(): void {
    if (this.isClosed || this.peerConnection) return;

    console.log("🔧 初始化 RTCPeerConnection...");
    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    this.peerConnection.onnegotiationneeded = this._handleNegotiationNeeded.bind(this);
    this.peerConnection.onicecandidate = this._handleIceCandidate.bind(this);
    this.peerConnection.ontrack = this._handleTrack.bind(this);
    this.peerConnection.ondatachannel = this._handleDataChannel.bind(this);
    this.peerConnection.onconnectionstatechange = this._handleConnectionStateChange.bind(this);
  }

  /**
   * 设置视频编码器优先级
   * 按照 AV1 > H265 > VP9 > H264 > VP8 的顺序设置偏好
   */
  private _setCodecPriority(): void {
    if (!this.peerConnection) return;

    // 找到视频轨道的 transceiver
    const videoTransceiver = this.peerConnection.getTransceivers().find(t => t.sender.track?.kind === "video");

    if (!videoTransceiver) {
      console.warn("未找到视频轨道的 Transceiver，无法设置编码器偏好。");
      return;
    }

    // 定义我们期望的编码器优先级
    const preferredCodecOrder = ["video/AV1", "video/H265", "video/VP9", "video/H264", "video/VP8"];

    // 获取浏览器支持的所有视频编码器
    const capabilities = RTCRtpSender.getCapabilities("video");
    if (!capabilities) {
      console.warn("无法获取视频编码器能力。");
      return;
    }
    const { codecs } = capabilities;
    console.log("浏览器支持的原始编码器列表:", codecs);

    // 根据我们的优先级列表对浏览器支持的编码器进行排序
    const sortedCodecs: any[] = [];
    preferredCodecOrder.forEach(mimeType => {
      const filtered = codecs.filter(c => c.mimeType.toLowerCase() === mimeType.toLowerCase());
      sortedCodecs.push(...filtered);
    });

    // 将不支持的或者未列出的编码器放到最后
    const remainingCodecs = codecs.filter(c => !sortedCodecs.includes(c));
    sortedCodecs.push(...remainingCodecs);

    console.log("排序后准备应用的编码器列表:", sortedCodecs);

    // 应用排序后的编码器列表
    try {
      videoTransceiver.setCodecPreferences(sortedCodecs);
      console.log("✅ 已成功设置视频编码器优先级。");
    } catch (err) {
      console.error("❌ 设置编码器偏好失败:", err);
    }
  }

  /** 协商流程 */
  private async _handleNegotiationNeeded(): Promise<void> {
    if (
      this.isNegotiating ||
      !this.peerConnection ||
      this.isClosed ||
      this.peerConnection.signalingState !== "stable"
    ) {
      console.log(
        ` Negotiation needed, but skipped. negotiating: ${this.isNegotiating}, state: ${this.peerConnection?.signalingState}`
      );
      return;
    }
    this.isNegotiating = true;

    try {
      console.log("🤝 需要协商，正在创建 Offer...");
      // 在创建 Offer 之前，调用我们新增的方法来设置编码器优先级
      this._setCodecPriority();

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      console.log("Offer SDP (可检查 m=video 行确认编码顺序):", offer.sdp);
      this._sendSignaling({ type: "offer", sdp: this.peerConnection.localDescription! });
    } catch (err) {
      console.error("❌ 创建 Offer 失败:", err);
    } finally {
      this.isNegotiating = false;
    }
  }

  /** ICE 候选收集 */
  private _handleIceCandidate(event: RTCPeerConnectionIceEvent): void {
    if (event.candidate) {
      this._sendSignaling({ type: "candidate", candidate: event.candidate });
    }
  }

  /** 收到远程轨道 */
  private _handleTrack(event: RTCTrackEvent): void {
    console.log(`🎥 收到远程轨道 (${event.track.kind})，关联到流:`, event.streams[0]?.id);
    this.onTrack?.(event);
  }

  /** 收到远程数据通道 */
  private _handleDataChannel(event: RTCDataChannelEvent): void {
    console.log(`📡 收到远程数据通道 "${event.channel.label}"`);
    this.onDataChannel?.(event);
  }

  /** 连接状态变化 */
  private _handleConnectionStateChange(): void {
    if (!this.peerConnection) return;
    const state = this.peerConnection.connectionState;
    console.log(`🔌 连接状态改变: ${state}`);
    this.onConnectionStateChange?.(state);

    switch (state) {
      case "connected":
        this.reconnectCount = 0;
        if (this.reconnectTimerId) {
          clearTimeout(this.reconnectTimerId);
          this.reconnectTimerId = null;
        }
        console.log("✅ WebRTC 已建立连接。");
        setTimeout(() => {
          this.negotiatedCodecs().catch(console.warn);
        }, 100);
        break;

      case "disconnected":
        console.warn("⚠️ WebRTC 连接断开，1秒后尝试重连...");
        if (!this.reconnectTimerId) {
          this.reconnectTimerId = window.setTimeout(() => this._reconnect(), 1000);
        }
        break;

      case "failed":
        console.error("❌ WebRTC 连接失败，立即重连...");
        this._reconnect();
        break;

      case "closed":
        this.close();
        break;
    }
  }

  /** 重连逻辑 */
  private _reconnect(): void {
    if (this.isClosed || this.reconnectCount >= this.maxReconnectCount) {
      if (!this.isClosed) {
        console.error(`❌ 已达最大重连次数 (${this.maxReconnectCount})，关闭连接。`);
        this.close();
      }
      return;
    }

    this.reconnectCount++;
    console.log(`🔄 正在重连... (${this.reconnectCount}/${this.maxReconnectCount})`);

    // 先关闭旧的连接（如果有）
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    // 重连时，我们是发起方
    this._initAndNegotiate(true);
  }

  /** 打印当前正在使用的音视频编码器 */
  public async negotiatedCodecs(): Promise<any> {
    if (!this.peerConnection) return;

    console.log("📊 查询当前使用的编码器...");

    try {
      const stats = await this.peerConnection.getStats();
      const codecs = new Map<string, any>();
      let outboundCodec: any | undefined;
      let inboundCodec: any | undefined;

      // 首先，遍历一遍找到所有的 codec 定义
      stats.forEach(report => {
        if (report.type === "codec") {
          codecs.set(report.id, report);
        }
      });

      // 然后，找到正在使用的出站和入站 rtp 流，并关联它们的 codec
      stats.forEach(report => {
        // 出站（我们发送给对方的）
        if (report.type === "outbound-rtp" && report.kind === "video") {
          if (report.codecId && codecs.has(report.codecId)) {
            outboundCodec = codecs.get(report.codecId);
          }
        }
        // 入站（我们从对方接收的）
        if (report.type === "inbound-rtp" && report.kind === "video") {
          if (report.codecId && codecs.has(report.codecId)) {
            inboundCodec = codecs.get(report.codecId);
          }
        }
      });

      if (outboundCodec) {
        console.log(
          `🚀 [发送方] 正在使用的视频编码: ${outboundCodec.mimeType} (profile: ${outboundCodec.sdpFmtpLine || "N/A"})`
        );
      } else {
        console.log("🚀 [发送方] 暂未检测到正在发送的视频编码。");
      }

      if (inboundCodec) {
        console.log(
          `📥 [接收方] 正在接收的视频编码: ${inboundCodec.mimeType} (profile: ${inboundCodec.sdpFmtpLine || "N/A"})`
        );
      } else {
        console.log("📥 [接收方] 暂未检测到正在接收的视频编码。");
      }
      return { inboundCodec, outboundCodec };
    } catch (err) {
      console.error("❌ 查询编码器统计信息失败:", err);
    }
  }
  /** 启动网络探测 */
  private _startNetworkProbe(): void {
    if (this.networkProbeTimer) return; // 避免重复启动
    this.networkProbeTimer = window.setInterval(async () => {
      if (!this.peerConnection) return;

      try {
        const stats = await this.peerConnection.getStats();
        let rtt: number | null = null;
        let packetsLost = 0;
        let packetsSent = 0;

        stats.forEach(report => {
          if (report.type === "candidate-pair" && report.state === "succeeded") {
            if (report.currentRoundTripTime) {
              rtt = report.currentRoundTripTime * 1000; // 秒→毫秒
            }
          }
          if (report.type === "outbound-rtp" && report.kind === "video") {
            if (report.packetsLost) packetsLost += report.packetsLost;
            if (report.packetsSent) packetsSent += report.packetsSent;
          }
        });

        const lossRate = packetsSent > 0 ? (packetsLost / packetsSent) * 100 : 0;
        const quality = this._evaluateNetworkQuality(rtt, lossRate);

        this._applyVideoQualityProfile(quality);
      } catch (err) {
        console.warn("网络探测失败:", err);
      }
    }, 3000);
  }

  /** 评估网络质量 */
  private _evaluateNetworkQuality(rtt: number | null, lossRate: number): "high" | "medium" | "low" {
    if (rtt !== null) {
      if (rtt < 100 && lossRate < 2) return "high";
      if (rtt < 300 && lossRate < 5) return "medium";
      return "low";
    }
    return "medium";
  }

  /** 应用视频画质配置（码率 + 帧率 + 分辨率） */
  private _applyVideoQualityProfile(level: "high" | "medium" | "low"): void {
    const senders = this.peerConnection?.getSenders() || [];
    senders.forEach(sender => {
      if (sender.track && sender.track.kind === "video") {
        console.log(sender);
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];

        switch (level) {
          case "high":
            params.encodings[0].maxBitrate = this.maxBitrateHigh;
            params.encodings[0].maxFramerate = 30;
            sender.track.applyConstraints({ width: 1280, height: 720, frameRate: 30 }).catch(err => {
              console.warn("applyConstraints 失败:", err);
            });
            console.log("🎥 切换到高画质 (720p@30fps)");
            break;

          case "medium":
            params.encodings[0].maxBitrate = this.maxBitrateMedium;
            params.encodings[0].maxFramerate = 20;
            sender.track.applyConstraints({ width: 1280, height: 720, frameRate: 20 }).catch(err => {
              console.warn("applyConstraints 失败:", err);
            });
            console.log("🎥 切换到中画质 (720p@20fps)");
            break;

          case "low":
            params.encodings[0].maxBitrate = this.maxBitrateLow;
            params.encodings[0].maxFramerate = 10;
            sender.track.applyConstraints({ width: 1280, height: 720, frameRate: 10 }).catch(err => {
              console.warn("applyConstraints 失败:", err);
            });
            console.log("🎥 切换到低画质 (720p@10fps)");
            break;
        }

        sender.setParameters(params).catch(err => {
          console.warn("调整视频参数失败:", err);
        });
      }
    });
  }
  /** 发送信令消息（内部包装） */
  private _sendSignaling(message: SignalingMessage): void {
    this.sendSignalingMessage(JSON.stringify(message));
  }

  /** 外部实现：信令消息发送 */
  public sendSignalingMessage(message: string): void {
    throw new Error("sendSignalingMessage 必须由外部实现。");
  }
}
