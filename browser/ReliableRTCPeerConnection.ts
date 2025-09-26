import { MyEvent } from "../common/手写事件";

/**
 * @fileoverview 定义一个可靠的、带自动重连功能的 WebRTC 对等连接类。
 */

/**
 * 定义了通过信令服务器交换的各种消息类型。
 * 这是 WebRTC 建立连接所必须的“握手”过程。
 */
export type SignalingMessage =
  // "join" 消息：用于通知对方加入或重新协商，并建议对方的角色。
  | { type: "join"; data: "offer" | "answer" }
  // "offer" 消息：包含 SDP (Session Description Protocol)，描述了发起方的媒体能力和网络信息。
  | { type: "offer"; data: string }
  // "answer" 消息：对 "offer" 的响应，包含应答方的 SDP。
  | { type: "answer"; data: string }
  // "candidate" 消息：包含 ICE (Interactive Connectivity Establishment) 候选者，用于帮助双方发现最佳的网络路径。
  | { type: "candidate"; data: RTCIceCandidate };

/**
 * 定义了 ReliableRTCPeerConnection 类可以触发的事件及其回调函数签名。
 * 用户可以通过监听这些事件来响应连接生命周期中的不同时刻。
 */
export type PeerConnectionEventMap = {
  // 在需要进行媒体协商（创建 Offer/Answer）之前触发。
  beforeNegotiation: (peerConnection: RTCPeerConnection) => void;
  // 当有信令消息需要发送到远端时触发。
  signaling: (signaling: SignalingMessage) => void;
  // 在创建 Offer 或 Answer 之前触发，允许用户在此时机添加 Track 或配置 DataChannel。
  beforeCreateOfferAnswer: (peerConnection: RTCPeerConnection) => void;
  // 连接关闭时触发。
  close: () => void;
  // WebRTC 连接成功建立时触发。
  connected: (peerConnection: RTCPeerConnection) => void;
  // 当接收到远端的媒体轨道（Track）时触发。
  track: (event: RTCTrackEvent) => void;
  // 当接收到远端的数据通道（DataChannel）时触发。
  datachannel: (event: RTCDataChannelEvent) => void;
  // 连接状态发生变化时触发。
  onconnectionstatechange: (state: RTCPeerConnectionState) => void;
};

/**
 * 一个可靠的 WebRTC 对等连接封装类。
 * 实现了自动重连、角色协商和简化的事件模型。
 */
export class ReliableRTCPeerConnection extends MyEvent<PeerConnectionEventMap> {
  /**
   * 当前端点在本次连接中的角色："offer" (发起方) 或 "answer" (应答方)。
   */
  public role: "offer" | "answer" = "answer";

  /**
   * RTCPeerConnection 的原生实例。
   */
  public peerConnection: RTCPeerConnection | null = null;

  /**
   * 标记连接是否已被手动关闭。
   */
  public isClosed = false;

  public log(...args: any[]): void {
    console.log(...args);
  }
  constructor(
    /** WebRTC 的配置，主要用于指定 ICE 服务器。 */
    public readonly rtcConfig: RTCConfiguration = {
      iceServers: [
        {
          urls: [
            "stun:stun.miwifi.com:3478",
            "stun:stun.chat.bilibili.com:3478",
            "stun:stun.cloudflare.com:3478",
            "stun:stun.l.google.com:19302",
          ],
        },
      ],
    },
    /** 允许的最大自动重连次数。*/
    private readonly maxReconnectAttempts = 10
  ) {
    super();
    this.start();
  }

  /**
   * 启动并初始化连接流程。
   */
  public start(): void {
    this.cleanupPeerConnection();
    // 默认将后加入者设定为 "answer" 方，等待对方发起 "offer"。
    this.role = "answer";
    this.log("我的角色已初始化为: " + this.role);
    // 异步发送 "join" 信号，通知对方自己的存在，并建议对方成为 "offer" 方。
    Promise.resolve().then(() =>
      this.emit("signaling", { type: "join", data: this.role === "answer" ? "offer" : "answer" })
    );
  }

  /**
   * 初始化一个新的 RTCPeerConnection 实例并绑定所有必要的事件监听器。
   * @returns {RTCPeerConnection} 新创建的 RTCPeerConnection 实例。
   */
  private initializePeerConnection(): RTCPeerConnection {
    this.log("🔧 初始化 RTCPeerConnection...");
    this.cleanupPeerConnection(); // 清理旧的连接实例

    const newPeerConnection = new RTCPeerConnection(this.rtcConfig);
    this.peerConnection = newPeerConnection;

    // 绑定原生事件处理器
    newPeerConnection.onnegotiationneeded = this.handleNegotiationNeeded.bind(this);
    newPeerConnection.onicecandidate = this.handleIceCandidate.bind(this);
    newPeerConnection.ontrack = this.handleTrack.bind(this);
    newPeerConnection.ondatachannel = this.handleDataChannel.bind(this);
    newPeerConnection.onconnectionstatechange = this.handleConnectionStateChange.bind(this);

    // 触发 beforeNegotiation 事件，让用户有机会在协商前进行操作（如添加轨道）。
    this.emit("beforeNegotiation", newPeerConnection);
    return newPeerConnection;
  }

  /**
   * 一个标志位，用于防止在协商过程中发生并发冲突。
   */
  private isNegotiating = false;

  /**
   * 处理 `onnegotiationneeded` 事件。
   * 此事件在需要进行新的 SDP 协商时（例如添加了新的 track）自动触发。
   * 只有 "offer" 方会主动发起协商。
   */
  private async handleNegotiationNeeded(): Promise<void> {
    this.log("触发 handleNegotiationNeeded");
    if (this.role === "answer") {
      this.log("角色为 'answer'，不主动发起协商。");
      return;
    }

    if (
      this.isNegotiating ||
      !this.peerConnection ||
      this.isClosed ||
      this.peerConnection.signalingState !== "stable"
    ) {
      this.log("协商条件不满足，跳过本次协商请求。");
      return;
    }

    this.isNegotiating = true;
    try {
      this.log("🤝 需要协商，正在创建 Offer...");
      this.emit("beforeCreateOfferAnswer", this.peerConnection);
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      if (!this.peerConnection.localDescription) {
        throw new Error("创建 Offer 后 localDescription 为空");
      }
      // 通过 'signaling' 事件将 Offer SDP 发送出去
      this.emit("signaling", { data: this.peerConnection.localDescription.sdp, type: "offer" });
    } catch (error) {
      this.log("❌ 创建 Offer 失败:", error);
    } finally {
      this.isNegotiating = false;
    }
  }

  /**
   * 处理 `onicecandidate` 事件。
   * 当网络栈发现一个新的 ICE 候选者时触发。
   * @param {RTCPeerConnectionIceEvent} event - 包含候选者的事件对象。
   */
  private handleIceCandidate(event: RTCPeerConnectionIceEvent): void {
    this.log(event.candidate);
    if (event.candidate) {
      // @ts-ignore
      this.log("【发现新的 ICE 候选者】" + event.candidate.url);
      // 将发现的 ICE 候选者通过信令发送给对方
      this.emit("signaling", { type: "candidate", data: event.candidate });
    }
  }

  public async printSelectedIceCandidatePair() {
    if (!this.peerConnection) throw new Error("peerConnection 实例不存在。");
    const stats = await this.peerConnection.getStats();
    let selectedPairId = "";

    // 方法 1：查 transport 条目
    stats.forEach(report => {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId;
      }
    });

    // 方法 2（兼容老浏览器）：如果 transport 没有该字段，从 candidate-pair 里找 nominated 且 state = succeeded 的那一对
    if (!selectedPairId) {
      stats.forEach(report => {
        if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") {
          selectedPairId = report.id;
        }
      });
    }

    if (!selectedPairId) {
      console.warn("未能找到被选用的 candidate pair");
      return;
    }

    // 找出 local 和 remote 的 candidate 信息
    stats.forEach(report => {
      if (report.type === "local-candidate" && report.id === stats.get(selectedPairId)?.localCandidateId) {
        this.log(`【本地候选】 ${report.address} [${report.protocol}]${report.relatedAddress} ${report.url}`);
      }
      if (report.type === "remote-candidate" && report.id === stats.get(selectedPairId)?.remoteCandidateId) {
        this.log(`【远端候选】 ${report.address} [${report.protocol}]`);
      }
    });
  }

  /**
   * 处理 `onconnectionstatechange` 事件。
   * 监控连接的整体状态，并据此执行连接、断开、重连等逻辑。
   */
  private handleConnectionStateChange(): void {
    if (!this.peerConnection) throw new Error("peerConnection 实例不存在。");
    const state = this.peerConnection.connectionState;
    this.emit("onconnectionstatechange", state);
    this.log(`🔌 连接状态改变: ${state}`);

    switch (state) {
      case "connected":
        this.currentReconnectAttempt = 0; // 重置重连计数
        if (this.reconnectTimerId) {
          clearTimeout(this.reconnectTimerId);
          this.reconnectTimerId = 0;
        }
        this.log("✅ WebRTC 已建立连接。");
        this.emit("connected", this.peerConnection);
        this.printSelectedIceCandidatePair();
        break;

      case "disconnected":
        this.log("⚠️ WebRTC 连接断开，尝试重连...");
        // 添加随机延迟，避免双方同时发起重连导致冲突
        if (!this.reconnectTimerId && !this.isClosed) {
          this.reconnectTimerId = window.setTimeout(() => {
            this.reconnectTimerId = 0;
            this.reconnect();
          }, 1000 + Math.random() * 1000);
        }
        break;

      case "failed":
        this.log("❌ WebRTC 连接失败，立即尝试重连...");
        if (!this.reconnectTimerId && !this.isClosed) {
          this.reconnectTimerId = window.setTimeout(() => {
            this.reconnectTimerId = 0;
            this.reconnect();
          }, Math.random() * 1000);
        }
        break;

      case "closed":
        this.close();
        break;
    }
  }

  /**
   * 重连计时器的 ID。
   */
  private reconnectTimerId = 0;

  /**
   * 当前的自动重连尝试次数。
   */
  private currentReconnectAttempt = 0;

  /**
   * 执行重连逻辑。
   */
  public reconnect(): void {
    this.pendingCandidates.length = 0;
    if (this.isClosed) return;

    if (this.currentReconnectAttempt >= this.maxReconnectAttempts) {
      this.log(`❌ 已达到最大重连次数 (${this.maxReconnectAttempts})，停止重连。`);
      this.cleanupPeerConnection();
      return;
    }

    this.currentReconnectAttempt++;
    this.log(`🔄 正在进行第 ${this.currentReconnectAttempt}/${this.maxReconnectAttempts} 次重连...`);
    this.isNegotiating = false;

    // 重新初始化 PeerConnection，将由 'onnegotiationneeded' 自动触发 offer 创建流程。
    this.initializePeerConnection();
  }

  /**
   * 公开的关闭连接方法。
   * 会清理所有资源并阻止任何未来的重连。
   */
  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cleanupPeerConnection();
    this.isNegotiating = false;
    this.emit("close");
    this.log("🔌 WebRTC 连接已关闭。");
  }

  /**
   * 清理当前 RTCPeerConnection 实例及其相关资源（计时器、事件监听器等）。
   */
  private cleanupPeerConnection() {
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = 0;
    }
    if (this.peerConnection) {
      // 解绑所有事件监听器，防止内存泄漏
      this.peerConnection.ontrack = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onnegotiationneeded = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  /**
   * 缓存收到的远端 ICE 候选者。
   * 在 `remoteDescription` 设置之前收到的 candidate 需要被缓存，待设置后再添加。
   */
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];

  /**
   * 处理从信令服务器接收到的消息。
   * 这是驱动整个 WebRTC 连接状态机的核心方法。
   * @param {SignalingMessage} message - 收到的信令消息。
   */
  public async onSignalingMessage({ type, data }: SignalingMessage): Promise<void> {
    if (this.isClosed) return;

    this.log(`📩 收到信令消息: ${type}`);

    try {
      switch (type) {
        case "join":
          this.log("对方请求协商，我方将成为指定的角色并发起连接。");
          this.role = data;
          this.log("我的新角色是: " + this.role);
          this.currentReconnectAttempt = 0; // 重置重连计数
          this.reconnect(); // 作为指定角色重新开始连接流程
          break;

        case "offer":
          if (this.role === "offer") {
            this.log("作为 'offer' 方，忽略收到的 'offer'。");
            return;
          }
          if (this.peerConnection?.connectionState === "connected") {
            this.log("⚠️ 连接已存在，忽略新的 'offer'。");
            return;
          }

          this.log("收到 Offer，准备创建 Answer...");
          // 如果当前 PeerConnection 状态不适合接收 Offer，则重新初始化。
          if (!this.peerConnection || this.peerConnection.signalingState !== "stable") {
            this.initializePeerConnection();
          }

          this.isNegotiating = false; // 重置协商状态

          await this.peerConnection!.setRemoteDescription({ type: "offer", sdp: data });
          this.log("✅ [应答方] 已设置 Remote Description。");

          this.emit("beforeCreateOfferAnswer", this.peerConnection!);

          const answer = await this.peerConnection!.createAnswer();
          await this.peerConnection!.setLocalDescription(answer);
          if (!this.peerConnection!.localDescription) throw new Error("创建 Answer 后 localDescription 为空");

          this.emit("signaling", { type: "answer", data: this.peerConnection!.localDescription.sdp });
          this.log("✅ [应答方] 已创建并发送 Answer。");

          // 添加之前缓存的 ICE 候选者
          for (const candidate of this.pendingCandidates) {
            await this.peerConnection!.addIceCandidate(candidate).catch(err => {
              this.log("添加缓存的 ICE 候选者失败:", err);
            });
          }
          this.pendingCandidates.length = 0;
          break;

        case "answer":
          if (this.role === "answer") {
            this.log("作为 'answer' 方，忽略收到的 'answer'。");
            return;
          }
          if (this.peerConnection?.signalingState === "have-local-offer") {
            await this.peerConnection.setRemoteDescription({ type: "answer", sdp: data });
            this.log("✅ [发起方] 已设置 Remote Description (Answer)。");
          } else {
            this.log(`收到意外的 Answer，当前状态: ${this.peerConnection?.signalingState}`);
          }
          break;

        case "candidate":
          if (data) {
            // 如果 remoteDescription 已经设置，则直接添加 candidate；否则，先缓存起来。
            if (this.peerConnection?.remoteDescription) {
              await this.peerConnection.addIceCandidate(data).catch(err => {
                this.log("添加 ICE 候选者失败:", err);
              });
            } else {
              this.pendingCandidates.push(data);
            }
          }
          break;
      }
    } catch (error) {
      this.log(`❌ 处理信令消息 "${type}" 时出错:`, error);
      this.isNegotiating = false; // 发生错误时重置协商状态
    }
  }

  /**
   * 处理 `ontrack` 事件。
   * @param {RTCTrackEvent} event - 包含媒体轨道的事件对象。
   */
  private handleTrack(event: RTCTrackEvent): void {
    this.log(`📡 收到媒体轨道 (Track): kind=${event.track.kind}`, event.track);
    this.emit("track", event);
  }

  /**
   * 处理 `ondatachannel` 事件。
   * @param {RTCDataChannelEvent} event - 包含数据通道的事件对象。
   */
  private handleDataChannel(event: RTCDataChannelEvent): void {
    this.log("📡 收到数据通道 (DataChannel):", event.channel.label);
    this.emit("datachannel", event);
  }
}

// 测试用例addTrack

// const init = async () => {
//   ws.removeEventListener("open", init);
//   const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
//   ws.send(JSON.stringify({ type: "join" }));
//   const rtc = new ReliableRTCPeerConnection();
//   ws.addEventListener("message", e => {
//     const data = JSON.parse(e.data);
//     this.log(data.type);
//     rtc.onSignalingMessage(data);
//   });
//   rtc.on("signaling", signaling => ws.send(JSON.stringify(signaling)));
//   rtc.on("beforeNegotiation", peerConnection => {
//     this.log("beforeNegotiation");
//     localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
//   });
//   rtc.on("track", ({ track, streams }) => {
//     this.log("track");
//     streams[0].getTracks().forEach(track => {
//       remoteVideo.srcObject = streams[0];
//       remoteVideo.play().catch(() => {});
//     });
//   });
// };
// const wsURL = new URL("/WebSocketVoice", location.href);
// wsURL.protocol = wsURL.protocol.replace("http", "ws");
// wsURL.search = "?uid=test" + String(Math.random()).substring(2);
// const ws = new ReliableWebSocket(wsURL);
// ws.addEventListener("open", init);

// 测试用例addTransceiver
// const init = async () => {
//   ws.removeEventListener("open", init);
//   const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

//   // 把本地 track 绑定到“远端 offer 创建出来的 transceiver”上
//   const bindLocalToRemoteTransceiver = (pc: RTCPeerConnection, kind: "audio" | "video") => {
//     const localTrack = localStream.getTracks().find(t => t.kind === kind) || null;

//     // 关键：找“远端提供的 m-line 对应的 transceiver”
//     // 注意这里根据 receiver.track.kind 来匹配，而不是 sender.track
//     const t = pc.getTransceivers().find(tx => tx.receiver?.track?.kind === kind);

//     if (t) {
//       // 把本地轨道挂到这个 transceiver 的 sender 上
//       t.sender.replaceTrack(localTrack);
//       // 明确方向
//       t.direction = localTrack ? "sendrecv" : "recvonly";
//     } else {
//       // 只有在“你是 offerer”且本地需要主动建 m-line 的时候才 addTransceiver
//       // 作为 answerer（已 setRemoteDescription(offer)）这里通常不该进来
//       if (localTrack) {
//         pc.addTransceiver(localTrack, { direction: "sendrecv" });
//       } else {
//         pc.addTransceiver(kind, { direction: "recvonly" });
//       }
//     }
//   };

//   const rtc = new ReliableRTCPeerConnection();
//   ws.addEventListener("open", () => {
//     this.log("网络重连");
//     rtc.start();
//   });
//   ws.addEventListener("message", e => {
//     const data = JSON.parse(e.data);
//     this.log("信令消息:", data.type);
//     rtc.onSignalingMessage(data);
//   });

//   rtc.on("signaling", signaling => ws.send(JSON.stringify(signaling)));

//   rtc.on("beforeNegotiation", pc => {
//     // 空着即可；如果你是“主动发起方(offerer)”才考虑预放 sendrecv 占位
//     if (rtc.role === "offer") {
//       pc.addTransceiver("audio", { direction: "sendrecv" });
//       pc.addTransceiver("video", { direction: "sendrecv" });
//     }
//   });

//   rtc.on("beforeCreateOfferAnswer", pc => {
//     // 这里执行时，answerer 已经 setRemoteDescription(offer) 完成
//     // 远端的 m-line 已经在 pc.getTransceivers() 里了
//     bindLocalToRemoteTransceiver(pc, "audio");
//     bindLocalToRemoteTransceiver(pc, "video");
//   });

//   rtc.on("track", ({ track }) => {
//     const remoteStream = (remoteVideo.srcObject as MediaStream) || (remoteVideo.srcObject = new MediaStream());
//     for (const t of remoteStream.getTracks()) {
//       if (t.kind === track.kind) remoteStream.removeTrack(t);
//     }
//     remoteStream.addTrack(track);
//     remoteVideo.play().catch(e => this.log(e));
//   });
// };

// const wsURL = new URL("/WebSocketVoice", location.href);
// wsURL.protocol = wsURL.protocol.replace("http", "ws");
// wsURL.search = "?uid=test" + String(Math.random()).substring(2);
// const ws = new ReliableWebSocket(wsURL);
// ws.addEventListener("open", init);

// setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
