import { MyEvent } from "../common/手写事件";

/**
 * @fileoverview 管理 WebRTC 协商、连接恢复及 TURN 配置；信令通道和等待直连的时间由调用方决定。
 */

/**
 * 定义了通过信令服务器交换的各种消息类型。
 * 这是 WebRTC 建立连接所必须的“握手”过程。
 */
export type SignalingMessage =
  // 不带 targetId 的 join 是连接请求，带 targetId 的 join 是确认，确认不再触发回复。
  | { type: "join"; data: string; targetId?: string }
  | ((
      | { type: "offer"; data: string }
      | { type: "answer"; data: string }
      | { type: "candidate"; data: RTCIceCandidateInit }
    ) & {
      // 两端的连接 ID 和 offer 轮次必须由信令服务器原样透传，两端均需使用此协议。
      senderId: string;
      targetId: string;
      negotiationId: number;
    });

/**
 * 定义了 ReliableRTCPeerConnection 类可以触发的事件及其回调函数签名。
 * 用户可以通过监听这些事件来响应连接生命周期中的不同时刻。
 */
export type PeerConnectionEventMap = {
  // 每次创建新 PC 后同步触发，适合添加 Track/Transceiver/DataChannel；不会等待 async 回调。
  beforeNegotiation: (peerConnection: RTCPeerConnection) => void;
  // 当有信令消息需要发送到远端时触发。
  signaling: (signaling: SignalingMessage) => void;
  // 每轮创建 SDP 前同步触发；应答方此时已应用远端 Offer，可复用其 Transceiver。
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
 * 连接流程：start/reconnect 发送 join → 双向确认 ID 并选角色 → Offer/Answer → ICE 建连。
 * senderId/targetId 隔离不同连接，negotiationId 隔离同一连接内的多轮 SDP。
 * 调用方先挂好 signaling 监听，再调用 start；之后把信令原样发给对端，并把对端消息交给 onSignalingMessage。
 */
export class ReliableRTCPeerConnection extends MyEvent<PeerConnectionEventMap> {
  /** 只决定谁主动创建 Offer；双方都可以发送媒体和进行 ICE 探测。 */
  public role: "offer" | "answer" = "answer";

  /** 在每次本地主动握手时生成，用来拒绝上一轮连接的迟到信令。 */
  private myId = "";

  /** 对端的连接 ID；只有对端主动 start/reconnect 时才会改变。 */
  private remoteId: string | null = null;
  /** 记住已被替换的远端 ID，避免迟到的旧 join 把连接切回上一轮。 */
  private readonly retiredRemoteIds = new Set<string>();
  /** 同一对连接内递增，避免把迟到的 answer/candidate 用到下一次 offer。 */
  private negotiationId = 0;
  /** 只串行处理同一连接的 SDP/ICE；join 可立即使旧连接和旧队列失效。 */
  private signalingQueue: Promise<void> = Promise.resolve();

  /** 重连会替换此实例；异步流程必须保存引用，并在恢复执行时检查是否仍为当前连接。 */
  public peerConnection: RTCPeerConnection | null = null;

  /** close 后停止处理信令；显式调用 start 可以重新启动。 */
  public isClosed = false;

  /** 防止 createOffer 尚未改变 signalingState 时，重复事件又创建一份 Offer。 */
  private isNegotiating = false;
  private currentReconnectAttempt = 0;
  /** 断线后的恢复等待；与等待 join/answer/ICE 的超时不是同一件事。 */
  private reconnectTimerId = 0;
  private negotiationTimerId = 0;
  /** 早到的候选必须等对应轮次的远端 SDP 应用后再添加，不能只看 remoteDescription 是否非空。 */
  private readonly pendingCandidates: Array<{ negotiationId: number; candidate: RTCIceCandidateInit }> = [];

  public log(...args: any[]): void {
    console.log(...args);
  }
  constructor(
    /** 创建 PC 时使用的配置；修改此对象不会自动更新现有 PC，需重新握手才能生效。 */
    public readonly rtcConfig: RTCConfiguration = {
      // 同时配置 STUN/TURN 时允许直连和中继，由 ICE 选择路径；列表顺序不代表优先级。
      iceTransportPolicy: "all",
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
    private readonly maxReconnectAttempts = 10,
    /** 覆盖等待 join、answer 和 ICE 建连，防止一直停在 new/have-local-offer。 */
    private readonly negotiationTimeoutMs = 15000
  ) {
    super();
    // 兜底会合并 iceServers，复制外层配置，避免影响复用同一配置的其他实例。
    this.rtcConfig = { ...rtcConfig };
  }

  /** 直连或 ICE 已通。使用方用它决定还要不要去取 TURN。 */
  public isConnected(): boolean {
    const pc = this.peerConnection;
    return (
      pc?.connectionState === "connected" ||
      pc?.iceConnectionState === "connected" ||
      pc?.iceConnectionState === "completed"
    );
  }

  /**
   * 记下 TURN，供之后新建的 PC 使用。当前还没连通时重新握手。
   * 调用方查询和真正传入之间可能已经连通，这里会再查一次，避免拆掉现有通话。
   */
  public setTurnServers(servers: RTCIceServer | RTCIceServer[]): void {
    const list = Array.isArray(servers) ? servers : [servers];
    if (!this.hasTurnServer(list)) throw new Error("没有 turn: 或 turns: 服务器");
    // 换成新数组，避免改到调用方或其他实例仍在共用的那一份。
    this.rtcConfig.iceServers = [...(this.rtcConfig.iceServers ?? []), ...list];
    if (!this.isClosed && !this.isConnected()) this.reconnect();
  }

  private hasTurnServer(servers: RTCIceServer[] = this.rtcConfig.iceServers ?? []): boolean {
    // 一个 iceServer 可含多个 URL，服务器数量不能用来区分 STUN 和 TURN。
    return servers.some(({ urls }) => {
      const list = Array.isArray(urls) ? urls : [urls];
      return list.some(url => typeof url === "string" && /^turns?:/i.test(url));
    });
  }

  /** 监听器就绪后调用。允许从 close 恢复，并重新计算重试次数；保留已取得的 TURN 配置。 */
  public start(): void {
    this.isClosed = false;
    this.currentReconnectAttempt = 0;
    this.requestConnection();
  }

  private requestConnection(): void {
    this.cleanupPeerConnection();
    // 本地主动重连才换 ID，让对端能识别并清理上一轮连接；此时还不能自行确定角色。
    this.myId = Math.random().toString(36).substring(2);
    this.role = "answer";
    this.armNegotiationTimeout();
    // 调用方已经挂好监听，这里直接发出。start 再次进入时会先换掉 myId，旧的 join 不会补发。
    const myId = this.myId;
    this.emit("signaling", { type: "join", data: myId });
  }

  /** 本地重连或远端换代都可能走到这里，先关闭旧 PC，避免两套原生连接继续发事件。 */
  private initializePeerConnection(): RTCPeerConnection {
    this.log("🔧 初始化 RTCPeerConnection...");
    this.cleanupPeerConnection(); // 清理旧的连接实例

    const newPeerConnection = new RTCPeerConnection(this.rtcConfig);
    this.peerConnection = newPeerConnection;

    // 原生事件可能晚于重连到达，只允许当前 PC 驱动协商、发送候选和改变连接状态。
    newPeerConnection.onnegotiationneeded = () => {
      if (this.isCurrentConnection(newPeerConnection)) void this.handleNegotiationNeeded();
    };
    newPeerConnection.onicecandidate = event => {
      if (this.isCurrentConnection(newPeerConnection)) this.handleIceCandidate(event);
    };
    newPeerConnection.ontrack = event => {
      this.log(`📡 收到媒体轨道 (Track): kind=${event.track.kind}`, event.track);
      this.emit("track", event);
    };
    newPeerConnection.ondatachannel = event => {
      this.log("📡 收到数据通道 (DataChannel):", event.channel.label);
      this.emit("datachannel", event);
    };
    newPeerConnection.onconnectionstatechange = () => {
      if (this.isCurrentConnection(newPeerConnection)) this.handleConnectionStateChange();
    };

    // 同步交给调用方/子类添加媒体或数据通道；远端 Offer 的 Transceiver 此时可能还未出现。
    this.emit("beforeNegotiation", newPeerConnection);
    return newPeerConnection;
  }

  /** await 和 emit 都可能让控制权交出去：原生异步完成或用户回调返回后，旧 PC 可能已失效。 */
  private isCurrentConnection(pc: RTCPeerConnection): boolean {
    return !this.isClosed && this.peerConnection === pc;
  }

  /**
   * 处理 `onnegotiationneeded` 事件。
   * 此事件在需要进行新的 SDP 协商时（例如添加了新的 track）自动触发。
   * 只有 "offer" 方会主动发起协商。
   */
  private async handleNegotiationNeeded(): Promise<void> {
    const pc = this.peerConnection;
    this.log("触发 handleNegotiationNeeded");
    if (this.role === "answer") {
      this.log("角色为 'answer'，不主动发起协商。");
      return;
    }

    // 锁保护创建过程，stable 检查则防止在等待上一轮 Answer 时再发 Offer，两者不能互相替代。
    if (this.isNegotiating || !pc || this.isClosed || pc.signalingState !== "stable") {
      this.log("协商条件不满足，跳过本次协商请求。");
      return;
    }

    this.isNegotiating = true;
    const negotiationId = ++this.negotiationId;
    this.armNegotiationTimeout();
    try {
      this.log("🤝 需要协商，正在创建 Offer...");
      this.emit("beforeCreateOfferAnswer", pc);
      if (!this.isCurrentConnection(pc)) return;
      const offer = await pc.createOffer();
      if (!this.isCurrentConnection(pc)) return;
      await pc.setLocalDescription(offer);
      if (!this.isCurrentConnection(pc)) return;

      if (!pc.localDescription) {
        throw new Error("创建 Offer 后 localDescription 为空");
      }
      // 发送浏览器实际应用的 SDP；配上连接双方的 ID 和轮次，便于对端拒绝迟到消息。
      this.emit("signaling", {
        data: pc.localDescription.sdp,
        type: "offer",
        senderId: this.myId,
        targetId: this.remoteId!,
        negotiationId,
      });
    } catch (error) {
      if (this.isCurrentConnection(pc)) {
        this.log("❌ 创建 Offer 失败:", error);
        this.reconnect();
      }
    } finally {
      // 旧 Promise 完成时不能释放新连接正在使用的协商锁。
      if (this.isCurrentConnection(pc)) this.isNegotiating = false;
    }
  }

  /**
   * 处理 `onicecandidate` 事件。
   * 当网络栈发现一个新的 ICE 候选者时触发。
   * @param {RTCPeerConnectionIceEvent} event - 包含候选者的事件对象。
   */
  private handleIceCandidate(event: RTCPeerConnectionIceEvent): void {
    if (event.candidate && this.remoteId && this.negotiationId) {
      this.log("发现 ICE 候选:", event.candidate);
      // 找到一条就转发一条，不必等全部收集结束；candidate 为 null 仅表示本地收集完成。
      this.emit("signaling", {
        type: "candidate",
        data: event.candidate,
        senderId: this.myId,
        targetId: this.remoteId,
        negotiationId: this.negotiationId,
      });
    }
  }

  /** 调试实际选路；收集到 relay 不代表正在使用 TURN，需要查看最终选中的候选对。 */
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

    // 统计条目本来就以 ID 索引，确定候选对后直接查关联地址，不必再遍历整份报告。
    const pair = stats.get(selectedPairId);
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (local) this.log(`【本地候选】 ${local.address} [${local.protocol}]${local.relatedAddress} ${local.url}`);
    if (remote) this.log(`【远端候选】 ${remote.address} [${remote.protocol}]`);
  }

  /**
   * 处理 `onconnectionstatechange` 事件。
   * 监控连接的整体状态，并据此执行连接、断开、重连等逻辑。
   */
  private handleConnectionStateChange(): void {
    const pc = this.peerConnection;
    if (!pc) return;
    const state = pc.connectionState;
    this.emit("onconnectionstatechange", state);
    // 用户状态回调可能同步关闭或重启，不能继续按旧状态操作新 PC。
    if (!this.isCurrentConnection(pc)) return;
    this.log(`🔌 连接状态改变: ${state}`);

    switch (state) {
      case "connected":
        this.currentReconnectAttempt = 0; // 重置重连计数
        if (pc.signalingState === "stable") this.clearNegotiationTimeout();
        if (this.reconnectTimerId) {
          clearTimeout(this.reconnectTimerId);
          this.reconnectTimerId = 0;
        }
        this.log("✅ WebRTC 已建立连接。");
        this.emit("connected", pc);
        if (this.isCurrentConnection(pc)) {
          void this.printSelectedIceCandidatePair().catch(error => this.log("读取 ICE 统计失败:", error));
        }
        break;

      case "disconnected":
      case "failed":
        this.log(`WebRTC ${state}，等待恢复或重新连接。`);
        // 短暂断网给 ICE 5~7 秒恢复机会；failed 缩短等待，随机间隔避免两端同时重试。
        // 已有恢复任务时沿用原定时器，不因重复状态事件创建多个重连流程。
        if (!this.reconnectTimerId) {
          const delay = state === "disconnected" ? 5000 + Math.random() * 2000 : Math.random() * 1000;
          this.reconnectTimerId = window.setTimeout(() => {
            this.reconnectTimerId = 0;
            this.reconnect();
          }, delay);
        }
        break;
    }
  }

  private clearNegotiationTimeout(): void {
    clearTimeout(this.negotiationTimerId);
    this.negotiationTimerId = 0;
  }

  private armNegotiationTimeout(): void {
    // 每个握手阶段重新计时；信令丢失时可能一直停在 new，不能只等原生 failed 事件。
    this.clearNegotiationTimeout();
    this.negotiationTimerId = window.setTimeout(() => {
      this.negotiationTimerId = 0;
      if (!this.isClosed) {
        this.log("协商或 ICE 建连超时，重新通知对端建立连接。");
        this.reconnect();
      }
    }, this.negotiationTimeoutMs);
  }

  /**
   * 执行重连逻辑。
   */
  public reconnect(): void {
    if (this.isClosed) return;

    if (this.currentReconnectAttempt >= this.maxReconnectAttempts) {
      this.log(`❌ 已达到最大重连次数 (${this.maxReconnectAttempts})，停止重连。`);
      this.cleanupPeerConnection();
      return;
    }

    this.currentReconnectAttempt++;
    this.log(`🔄 正在进行第 ${this.currentReconnectAttempt}/${this.maxReconnectAttempts} 次重连...`);
    // 应答方也必须通知对端；新 ID 同时使旧连接的所有迟到信令失效。
    this.requestConnection();
  }

  /**
   * 停止自动恢复并清理资源；重复调用不会重复触发 close，显式 start 仍可重新开始。
   * 请调用本方法关闭，原生 pc.close() 不会派发 connectionstatechange 来替本类清理状态。
   */
  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cleanupPeerConnection();
    this.emit("close");
    this.log("🔌 WebRTC 连接已关闭。");
  }

  /**
   * 只清理单个 PC 的资源和协商状态。已写入的 TURN 配置留在 rtcConfig 上，普通重连继续复用。
   */
  private cleanupPeerConnection() {
    this.clearNegotiationTimeout();
    this.isNegotiating = false;
    this.negotiationId = 0;
    this.pendingCandidates.length = 0;
    // 已关闭的原生操作可能永不 resolve，不能让新连接继续等待旧队列。
    this.signalingQueue = Promise.resolve();
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = 0;
    }
    if (this.peerConnection) {
      // 先解绑本类注册的回调，再关闭原生连接，避免清理动作又触发上层事件或重连。
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
   * 处理从信令服务器接收到的消息。
   * 这是驱动整个 WebRTC 连接状态机的核心方法。
   * @param {SignalingMessage} message - 收到的信令消息。
   */
  public async onSignalingMessage(message: SignalingMessage): Promise<void> {
    if (this.isClosed) return;

    this.log(`📩 收到信令消息: ${message.type}`);

    if (message.type === "join") {
      try {
        const { data, targetId } = message;
        // 1. join 先于 SDP 处理：它决定这一对连接的身份，也能立即淘汰旧 PC/旧消息队列。
        // 忽略自身回显、发给旧本地 ID 的确认，以及已被替换的远端 ID。
        if (
          !data ||
          data === this.myId ||
          this.retiredRemoteIds.has(data) ||
          (targetId !== undefined && targetId !== this.myId)
        )
          return;

        if (this.remoteId !== data || !this.peerConnection) {
          if (this.remoteId && this.remoteId !== data) this.retiredRemoteIds.add(this.remoteId);
          this.remoteId = data;
          // 双方按同一规则比较 ID，才能一方发 Offer、一方应答；先定角色再让上层添加通道。
          this.role = this.myId > data ? "offer" : "answer";
          // 接受对端重连时保留自己的 ID；此处调用 reconnect 会造成双方不断换 ID。
          const pc = this.initializePeerConnection();
          if (!this.isCurrentConnection(pc)) return;
          this.armNegotiationTimeout();
        }
        // 2. 回传自己的 ID，补齐先后上线时丢掉的首次 join；确认不再回复，避免无限往返。
        const pc = this.peerConnection!;
        if (targetId === undefined) this.emit("signaling", { type: "join", data: this.myId, targetId: data });
        if (!this.isCurrentConnection(pc)) return;
        // 显式启动首轮 Offer：空 PC 不保证触发 negotiationneeded，不能依赖尚未执行的添轨回调。
        if (this.role === "offer" && !this.negotiationId) void this.handleNegotiationNeeded();
      } catch (error) {
        this.log("❌ 处理 join 时出错:", error);
        this.reconnect();
      }
      return;
    }

    const pc = this.peerConnection;
    // 3. SDP/ICE 必须属于当前双方连接，且轮次有效；迟到的旧 Answer 不能消耗新 Offer。
    if (
      !pc ||
      message.senderId !== this.remoteId ||
      message.targetId !== this.myId ||
      !Number.isSafeInteger(message.negotiationId) ||
      message.negotiationId <= 0
    )
      return;

    // 4. WebSocket 按序投递不等于 async 按序完成；入站 SDP/ICE 串行，防止重复 Offer 打断应答。
    this.signalingQueue = this.signalingQueue
      .then(async () => {
        if (this.isCurrentConnection(pc)) await this.processSignalingMessage(message, pc);
      })
      .catch(error => {
        if (this.isCurrentConnection(pc)) {
          this.log(`❌ 处理信令消息 "${message.type}" 时出错:`, error);
          this.reconnect();
        }
      });
    return this.signalingQueue;
  }

  private async processSignalingMessage(
    message: Exclude<SignalingMessage, { type: "join" }>,
    pc: RTCPeerConnection
  ): Promise<void> {
    const { type, data, negotiationId } = message;
    switch (type) {
      case "offer": {
        // 重复 offer 不重建 PC，也不重新执行正在进行的应答。
        if (this.role !== "answer" || negotiationId <= this.negotiationId) return;
        if (pc.signalingState !== "stable") throw new Error("收到 Offer 时连接尚未稳定");
        this.negotiationId = negotiationId;
        this.armNegotiationTimeout();
        // 必须先应用远端 Offer，浏览器才知道对方提供了哪些通道，随后才能添轨并创建 Answer。
        await pc.setRemoteDescription({ type: "offer", sdp: data });
        if (!this.isCurrentConnection(pc)) return;
        this.emit("beforeCreateOfferAnswer", pc);
        if (!this.isCurrentConnection(pc)) return;
        const answer = await pc.createAnswer();
        if (!this.isCurrentConnection(pc)) return;
        await pc.setLocalDescription(answer);
        if (!this.isCurrentConnection(pc)) return;
        if (!pc.localDescription) throw new Error("创建 Answer 后 localDescription 为空");
        this.emit("signaling", {
          type: "answer",
          data: pc.localDescription.sdp,
          senderId: this.myId,
          targetId: this.remoteId!,
          negotiationId,
        });
        if (!this.isCurrentConnection(pc)) return;
        // 5. SDP 就绪后补上早到候选；连接测试不必等所有候选收集完毕才开始。
        await this.flushPendingCandidates(pc, negotiationId);
        break;
      }
      case "answer":
        // 只接受当前 Offer 的回答；重复、过期或尚未发起 Offer 时收到的 Answer 都直接忽略。
        if (this.role !== "offer" || negotiationId !== this.negotiationId || pc.signalingState !== "have-local-offer")
          return;
        await pc.setRemoteDescription({ type: "answer", sdp: data });
        if (!this.isCurrentConnection(pc)) return;
        await this.flushPendingCandidates(pc, negotiationId);
        break;
      case "candidate":
        // 发起方只接收自己已发出的轮次；应答方可以暂存先于新 Offer 到达的候选。
        if (negotiationId < this.negotiationId || (this.role === "offer" && negotiationId !== this.negotiationId))
          return;
        if (negotiationId === this.negotiationId && pc.remoteDescription && pc.signalingState === "stable") {
          await pc.addIceCandidate(data).catch(error => this.log("添加 ICE 候选者失败:", error));
        } else {
          // 重协商时 remoteDescription 可能仍是上一轮 answer，必须等本轮 SDP 完成。
          this.pendingCandidates.push({ negotiationId, candidate: data });
        }
        break;
    }
    // 已连接时的重新协商不会再次触发 connected 事件，需在 SDP 完成后取消超时。
    if (this.isCurrentConnection(pc) && pc.connectionState === "connected" && pc.signalingState === "stable") {
      this.clearNegotiationTimeout();
    }
  }

  private async flushPendingCandidates(pc: RTCPeerConnection, negotiationId: number): Promise<void> {
    // 取出一批再处理：旧轮次丢弃，更晚轮次留给其对应 SDP；重连后不能再写入旧 PC。
    const candidates = this.pendingCandidates.splice(0);
    for (const entry of candidates) {
      if (!this.isCurrentConnection(pc)) return;
      if (entry.negotiationId > negotiationId) this.pendingCandidates.push(entry);
      else if (entry.negotiationId === negotiationId) {
        await pc.addIceCandidate(entry.candidate).catch(error => this.log("添加缓存的 ICE 候选者失败:", error));
      }
    }
  }
}

// 测试用例addTrack

// const init = async () => {
//   ws.removeEventListener("open", init);
//   const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
//   // 房间加入，没有 data。对等连接的 join 由下面的 start() 发出，和这条消息不是一回事。
//   ws.send(JSON.stringify({ type: "join" }));
//   const rtc = new ReliableRTCPeerConnection();
//   ws.addEventListener("message", e => {
//     const data = JSON.parse(e.data);
//     this.log(data.type);
//     rtc.onSignalingMessage(data);
//   });
//   // 原样转发。offer、answer、candidate 上的 senderId、targetId、negotiationId 不能丢掉。
//   rtc.on("signaling", signaling => ws.send(JSON.stringify(signaling)));
//   rtc.on("beforeNegotiation", peerConnection => {
//     this.log("beforeNegotiation");
//     // 这里必须同步 addTrack。回调返回后，offer 方会立刻创建首轮 Offer。
//     localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
//   });
//   rtc.on("track", ({ track, streams }) => {
//     this.log("track");
//     streams[0].getTracks().forEach(track => {
//       remoteVideo.srcObject = streams[0];
//       remoteVideo.play().catch(() => {});
//     });
//   });
//   rtc.start();
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

//   // 原样转发。offer、answer、candidate 上的 senderId、targetId、negotiationId 不能丢掉。
//   rtc.on("signaling", signaling => ws.send(JSON.stringify(signaling)));

//   rtc.on("beforeNegotiation", pc => {
//     // 空着即可；如果你是“主动发起方(offerer)”才考虑预放 sendrecv 占位
//     // 此时角色已经定下来。只放占位，本地 track 留到 beforeCreateOfferAnswer。
//     if (rtc.role === "offer") {
//       pc.addTransceiver("audio", { direction: "sendrecv" });
//       pc.addTransceiver("video", { direction: "sendrecv" });
//     }
//   });

//   rtc.on("beforeCreateOfferAnswer", pc => {
//     // answerer：这里执行时已经 setRemoteDescription(offer)，远端 m-line 在 getTransceivers() 里
//     // offerer：复用 beforeNegotiation 预放的 transceiver，再 replaceTrack
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
//   rtc.start();
// };

// const wsURL = new URL("/WebSocketVoice", location.href);
// wsURL.protocol = wsURL.protocol.replace("http", "ws");
// wsURL.search = "?uid=test" + String(Math.random()).substring(2);
// const ws = new ReliableWebSocket(wsURL);
// ws.addEventListener("open", init);

// setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
