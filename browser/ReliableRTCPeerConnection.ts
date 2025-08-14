import { TsEventTarget } from "../common/TsEvent";
type ISignaling =
  | { data: null; name: "join" }
  | { data: string; name: "offer" }
  | { data: string; name: "answer" }
  | { data: RTCIceCandidate; name: "candidate" };

export type ReliableRTCPeerConnectionEvent = {
  beforeNegotiation: { peerConnection: RTCPeerConnection };
  signaling: ISignaling;
  beforeCreateOfferAnswer: { peerConnection: RTCPeerConnection };
  close: {};
  connected: { peerConnection: RTCPeerConnection };
  track: RTCTrackEvent;
};
export class ReliableRTCPeerConnection extends TsEventTarget<ReliableRTCPeerConnectionEvent> {
  public maxReconnectCount = 10;
  public peerConnection: RTCPeerConnection | null = null;
  private readonly rtcConfig: RTCConfiguration;
  public isClosed = false;
  constructor(
    rtcConfiguration: RTCConfiguration = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    },
    maxReconnectCount = 10
  ) {
    super();
    this.rtcConfig = rtcConfiguration;
    this.maxReconnectCount = maxReconnectCount;
  }
  /** 初始化 RTCPeerConnection */
  private initPeerConnection(): RTCPeerConnection {
    if (this.peerConnection) return this.peerConnection;
    console.log("🔧 初始化 RTCPeerConnection...");
    this.clean();
    const peerConnection = new RTCPeerConnection(this.rtcConfig);
    this.peerConnection = peerConnection;
    peerConnection.onnegotiationneeded = this.handleNegotiationNeeded.bind(this);

    peerConnection.onicecandidate = this.handleIceCandidate.bind(this);
    peerConnection.ontrack = this.handleTrack.bind(this);
    // peerConnection.ondatachannel = this._handleDataChannel.bind(this);
    peerConnection.onconnectionstatechange = this.handleConnectionStateChange.bind(this);
    this.emit("beforeNegotiation", { peerConnection });
    return peerConnection;
  }
  /** 正在协商 */
  private isNegotiating = false;

  /** 协商流程 */
  private async handleNegotiationNeeded(): Promise<void> {
    const { peerConnection } = this;

    if (this.isNegotiating || !peerConnection || this.isClosed || peerConnection.signalingState !== "stable") return;

    this.isNegotiating = true;
    try {
      console.log("🤝 需要协商，正在创建 Offer...");
      this.emit("beforeCreateOfferAnswer", { peerConnection });
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      if (!peerConnection.localDescription) throw new Error("localDescription 为空");
      this.emit("signaling", { data: peerConnection.localDescription.sdp, name: "offer" });
    } catch (err) {
      console.error("❌ 创建 Offer 失败:", err);
    } finally {
      this.isNegotiating = false;
    }
  }
  /** ICE 候选收集 */
  private handleIceCandidate(event: RTCPeerConnectionIceEvent): void {
    if (event.candidate) this.emit("signaling", { name: "candidate", data: event.candidate });
  }

  /** 连接状态变化 */
  private handleConnectionStateChange(): void {
    const peerConnection = this.peerConnection;
    if (!peerConnection) throw new Error("无peerConnection？");
    const state = peerConnection.connectionState;
    console.log(`🔌 连接状态改变: ${state}`);
    // this.onConnectionStateChange?.(state);

    switch (state) {
      case "connected":
        this.autoReconnectCount = 0;
        if (this.reconnectTimerId) {
          clearTimeout(this.reconnectTimerId);
          this.reconnectTimerId = 0;
        }
        console.log("✅ WebRTC 已建立连接。");
        this.emit("connected", { peerConnection });
        // setTimeout(() => {
        //   this.negotiatedCodecs().catch(console.warn);
        // }, 500);
        break;

      case "disconnected":
        console.warn("⚠️ WebRTC 连接断开，尝试重连...");
        if (!this.reconnectTimerId && !this.isClosed) {
          // 为了避免双方同时重连发起 offer 冲突，可以引入一个小的随机延迟
          const randomDelay = 5000 + Math.random() * 1000;
          this.reconnectTimerId = window.setTimeout(() => {
            this.reconnectTimerId = 0;
            this.reconnect();
          }, randomDelay);
        }
        break;

      case "failed":
        console.error("❌ WebRTC 连接失败，立即重连...");
        this.reconnect();
        break;

      case "closed":
        // 这里的 close() 有 isClosed 保护，不会被意外的事件重复触发
        this.close();
        break;
    }
  }
  private reconnectTimerId = 0;
  /** 自动重连次数 */
  private autoReconnectCount = 0;
  /** 重连逻辑 */
  public reconnect(): void {
    if (this.isClosed) return;
    if (this.autoReconnectCount >= this.maxReconnectCount) {
      console.error(`❌ 已达最大重连次数 (${this.maxReconnectCount})`);
      this.clean();
      return;
    }

    this.autoReconnectCount++;
    console.log(`🔄 正在重连... (${this.autoReconnectCount}/${this.maxReconnectCount})`);
    this.isNegotiating = false;

    // 3. 总是通过 start() 方法发起重连，确保逻辑统一
    // 我们将作为新的呼叫方（Offerer）
    console.log("🔄 重连：将作为 Offerer 重新发起连接。");
    // (可选)可以发送一个 'join' 消息，让对方知道我们要重连了。
    // this._sendSignaling({ type: "join" });
    this.initPeerConnection();
  }
  /** 关闭连接并清理资源 */
  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.clean();
    this.isNegotiating = false;
    this.emit("close", {});
    console.log("🔌 WebRTC 连接已关闭。");
  }

  private clean() {
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = 0;
    }
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onnegotiationneeded = null;

      //   this.peerConnection.getSenders().forEach(sender => {
      //     try {
      //       sender.track?.stop();
      //     } catch (e) {
      //       console.warn("停止 track 失败:", e);
      //     }
      //   });

      this.peerConnection.close();
      this.peerConnection = null;
    }
  }
  /** 缓存 ICE Candidate */
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];

  /** 处理信令消息 */
  public async onSignalingMessage({ name, data }: ISignaling): Promise<void> {
    if (this.isClosed) return;
    let { peerConnection } = this;
    try {
      switch (name) {
        case "join":
          console.log("📩 收到 Join，对方请求重新协商，我方将发起重连。");
          this.reconnect(); // 收到 join 后，作为发起方重连
          break;

        case "offer":
          console.log("📩 收到 Offer，创建 Answer...");
          if (
            peerConnection &&
            (peerConnection.signalingState === "have-local-offer" || peerConnection.signalingState === "closed")
          ) {
            console.warn("⚠️ 收到新的 Offer，但连接已存在。关闭旧连接以进行重新协商...");
            this.clean();
            return;
          }
          console.log("我现在是应答方");
          // 重置协商状态，以防万一
          this.isNegotiating = false;

          // 作为应答方，在这里初始化 PeerConnection
          peerConnection = this.initPeerConnection();
          //   this._startNetworkProbe();
          await peerConnection.setRemoteDescription({ type: "offer", sdp: data });

          console.log("✅ [应答方] 已设置 Remote Description。");

          //   this.baseMediaStream.getTracks().forEach(track => {
          //     this.peerConnection?.addTrack(track, this.baseMediaStream);
          //     console.log(`📡 [应答方] 已添加 Track: ${track.id} (${track.kind})`);
          //   });
          this.emit("beforeCreateOfferAnswer", { peerConnection });
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          if (!peerConnection.localDescription) throw new Error("localDescription is null");
          this.emit("signaling", { name: "answer", data: peerConnection.localDescription.sdp });
          console.log("✅ [应答方] 已创建并发送 Answer。");

          for (const candidate of this.pendingCandidates) {
            await peerConnection.addIceCandidate(candidate).catch(err => {
              console.warn("添加缓存 ICE 失败:", err);
            });
          }
          this.pendingCandidates.length = 0;
          break;

        case "answer":
          console.log("📩 收到 Answer。");
          if (this.peerConnection?.signalingState === "have-local-offer") {
            await this.peerConnection.setRemoteDescription({ type: "answer", sdp: data });

            console.log("✅ [呼叫方] 已设置 Remote Description (Answer)。");
          } else {
            console.warn("收到意外的 Answer，当前状态:", this.peerConnection?.signalingState);
          }
          break;

        case "candidate":
          if (data) {
            if (this.peerConnection?.remoteDescription) {
              await this.peerConnection.addIceCandidate(data).catch(err => {
                console.warn("添加 ICE 失败:", err);
              });
            } else {
              this.pendingCandidates.push(data);
            }
          }
          break;
      }
    } catch (err) {
      console.error("❌ 处理信令消息时出错:", err);
      this.isNegotiating = false;
    }
  }

  private handleTrack(event: RTCTrackEvent) {
    console.log("📡 收到 Track:", event.track);
    this.emit("track", event);
  }
}

// const peerConnection = new ReliableRTCPeerConnection();

// const ws = new WebSocket("/WebSocketVoice");
// ws.addEventListener("open", () => {
//   console.log("连接成功");
// });
// ws.addEventListener("message", e => {
//   console.log(e.data);
//   const data = JSON.parse(e.data);
//   peerConnection.onSignalingMessage(data);
// });
// peerConnection.on("signaling", ({ type, data }) => {
//   ws.send(JSON.stringify({ type, data }));
// });
