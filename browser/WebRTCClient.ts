// WebRTCClient.ts

/** 信令消息类型定义 */
type SignalingMessage = {
  type: "offer" | "answer" | "candidate" | "hangup";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export class WebRTCClient {
  public peerConnection: RTCPeerConnection | null = null;
  private readonly rtcConfig: RTCConfiguration;
  private readonly baseMediaStream: MediaStream; // 保存初始媒体流，用于重连时添加轨道

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
  private readonly maxBitrateHigh = 5_000_000; // 高画质码率上限（可改成 5_000_000）
  private readonly maxBitrateMedium = 2_000_000; // 中画质
  private readonly maxBitrateLow = 500_000; // 低画质

  constructor(
    initialStream: MediaStream,
    rtcConfiguration: RTCConfiguration = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    }
  ) {
    this.baseMediaStream = initialStream;
    this.rtcConfig = rtcConfiguration;
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
      this.peerConnection.ontrack = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onnegotiationneeded = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.isNegotiating = false;
    this.onConnectionStateChange?.("closed");
  }

  /** 处理信令消息 */
  public async onSignalingMessage(message: SignalingMessage): Promise<void> {
    if (!this.peerConnection) {
      this._initAndNegotiate();
      if (!this.peerConnection) return;
    }

    try {
      switch (message.type) {
        case "offer":
          console.log("📩 收到 Offer，创建 Answer...");
          await this.peerConnection.setRemoteDescription(message.sdp!);
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);
          this._sendSignaling({ type: "answer", sdp: this.peerConnection.localDescription! });
          break;

        case "answer":
          console.log("📩 收到 Answer。");
          await this.peerConnection.setRemoteDescription(message.sdp!);
          break;

        case "candidate":
          if (message.candidate) {
            await this.peerConnection.addIceCandidate(message.candidate);
          }
          break;

        case "hangup":
          this.close();
          break;
      }
    } catch (err) {
      console.error("❌ 处理信令消息时出错:", err);
    }
  }

  /** 初始化并添加轨道 */
  private _initAndNegotiate(): void {
    this._initPeerConnection();
    this.baseMediaStream.getTracks().forEach(track => {
      this.peerConnection?.addTrack(track, this.baseMediaStream);
    });
    this._startNetworkProbe(); // 初始化时启动网络检测
  }

  /** 初始化 RTCPeerConnection */
  private _initPeerConnection(): void {
    if (this.isClosed || this.peerConnection) return;
    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    this.peerConnection.onnegotiationneeded = this._handleNegotiationNeeded.bind(this);
    this.peerConnection.onicecandidate = this._handleIceCandidate.bind(this);
    this.peerConnection.ontrack = this._handleTrack.bind(this);
    this.peerConnection.ondatachannel = this._handleDataChannel.bind(this);
    this.peerConnection.onconnectionstatechange = this._handleConnectionStateChange.bind(this);
  }

  /** 协商流程 */
  private async _handleNegotiationNeeded(): Promise<void> {
    if (this.isNegotiating || !this.peerConnection || this.isClosed) return;
    this.isNegotiating = true;

    try {
      console.log("🤝 需要协商，正在创建 Offer...");
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
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
    console.log(`🎥 收到远程轨道 (${event.track.kind})`);
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
    this.onConnectionStateChange?.(state);

    switch (state) {
      case "connected":
        this.reconnectCount = 0;
        if (this.reconnectTimerId) {
          clearTimeout(this.reconnectTimerId);
          this.reconnectTimerId = null;
        }
        console.log("✅ WebRTC 已建立连接。");
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
    if (this.reconnectCount >= this.maxReconnectCount) {
      console.error(`❌ 已达最大重连次数 (${this.maxReconnectCount})，关闭连接。`);
      this.close();
      return;
    }

    this.reconnectCount++;
    console.log(`🔄 正在重连... (${this.reconnectCount}/${this.maxReconnectCount})`);

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this._initAndNegotiate();
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
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];

        switch (level) {
          case "high":
            params.encodings[0].maxBitrate = this.maxBitrateHigh;
            params.encodings[0].maxFramerate = 30;
            // 恢复原分辨率
            sender.track.applyConstraints({ width: 1280, height: 720, frameRate: 30 }).catch(() => {});
            console.log("🎥 切换到高画质 (720p@30fps)");
            break;

          case "medium":
            params.encodings[0].maxBitrate = this.maxBitrateMedium;
            params.encodings[0].maxFramerate = 20;
            sender.track.applyConstraints({ width: 1280, height: 720, frameRate: 20 }).catch(() => {});
            console.log("🎥 切换到中画质 (720p@20fps)");
            break;

          case "low":
            params.encodings[0].maxBitrate = this.maxBitrateLow;
            params.encodings[0].maxFramerate = 15;
            sender.track.applyConstraints({ width: 854, height: 480, frameRate: 15 }).catch(() => {});
            console.log("🎥 切换到低画质 (480p@15fps)");
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
