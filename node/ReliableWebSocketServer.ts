/**
 * 每次 WebSocket 连接对应的基本信息。
 *
 * ws：当前 WebSocket 连接对象。
 * id：文件唯一标识。同一个 id 同一时刻只允许一个有效的文件写入会话。
 */
export type IReliableWebSocketServerInfo<T> = {
  ws: T;
  id: string;
};

/**
 * Map 中保存的会话信息。
 *
 * closing：
 *   undefined 表示当前没有启动关闭流程。
 *   有值表示当前实例已经进入关闭流程。
 *
 *   resolve / reject 不是底层关闭操作本身的 Promise，
 *   而是当前正在等待旧实例关闭的请求所使用的回调。
 *
 * downstream：
 *   当前 WebSocket 对应的业务实例，负责处理音频数据、
 *   读取文件大小以及关闭文件写入资源。
 */
export type IReliableWebSocketServerMap<T> = {
  closing: { resolve?: () => void; reject?: () => void } | undefined;
  downstream: WsDownstream<T>;
};

export class ReliableWebSocketServer<T> {
  constructor(
    /**
     * 创建具体的下游处理实例。
     * 例如 Downstream 会负责管理文件写入流。
     */
    private readonly WsClass: typeof WsDownstream<T>,

    /**
     * 向指定 WebSocket 发送握手响应。
     * 当前协议中，响应内容包含文件完整性标识和服务端已有文件大小。
     */
    private readonly sendBuffer: (info: IReliableWebSocketServerInfo<T>, data: string | Buffer) => void,

    /**
     * 握手协议使用的固定标识。
     */
    private readonly KeepDataIntegrityKey: string
  ) {}

  private timer: NodeJS.Timeout | undefined = undefined;
  private timerFn() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let runNextTime = false;
    for (const [id, info] of this.map) {
      if (info.closing || !info.downstream.isOpen()) continue;
      this.sendBuffer(info, this.KeepDataIntegrityKey + "->" + info.downstream.getSize());
      runNextTime = true;
    }
    if (runNextTime) this.timer = setTimeout(this.timerFn.bind(this), 60 * 1000);
  }

  /**
   * 以文件 id 为 key，保存当前已经登记的会话。
   *
   * 这里保存的是当前会话，而不是所有正在等待连接的请求。
   * closing 负责标记当前会话正在关闭，并协调等待该关闭操作的请求。
   */
  private map: Map<string, IReliableWebSocketServerMap<T> & IReliableWebSocketServerInfo<T>> = new Map();

  /**
   * 处理新的 WebSocket 连接。
   *
   * 返回 true：
   *   当前连接完成初始化，并且握手响应已发送。
   *
   * 返回 false：
   *   当前连接未能完成握手，调用方应关闭该连接。
   *
   * 核心流程：
   * 1. 等待同一个文件 id 的旧实例关闭。
   * 2. 创建新实例。
   * 3. 将新实例登记到 Map。
   * 4. 读取服务端已有文件大小。
   * 5. 再次检查当前实例是否仍有效。
   * 6. 发送握手响应。
   */
  public async onConnection(info: IReliableWebSocketServerInfo<T>) {
    try {
      // 先检查同一个文件 id 是否已有会话。
      const oldWs = this.map.get(info.id);
      /**
       * 必须等待旧实例的文件资源关闭完成，再创建新实例。
       *
       * 如果有多个新请求先后到来，downstreamClose 会让较早的
       * 等待者 reject，只保留最新的等待者。
       *
       * 因此，较早请求进入 catch 并返回 false；
       * 最新请求则继续等待旧实例关闭。
       */
      if (oldWs) await new Promise<void>((resolve, reject) => this.downstreamClose(oldWs, resolve, reject));

      /**
       * 旧实例关闭后再创建新实例。
       *
       * 构造函数可能会立即创建文件写入流，因此必须先完成旧实例的
       * 关闭等待，不能提前创建，否则可能出现两个实例同时操作同一文件。
       */
      const downstream = new this.WsClass(info);

      /**
       * 等待旧实例关闭期间，新 WebSocket 也可能已经断开。
       *
       * 这里检查新连接是否仍然打开。如果已经断开，需要关闭刚创建的
       * downstream，避免构造函数创建的文件写入流无人负责清理。
       *
       * 必须 await close，确保文件资源清理完成后才返回。
       */
      if (!downstream.isOpen()) {
        await downstream.close();
        return false;
      }

      /**
       * 为当前连接创建独立的 Map 记录。
       *
       * closing 初始为 undefined，表示该实例尚未进入关闭流程。
       *
       * 必须先登记，再异步读取文件大小。这样如果读取期间又有新连接
       * 到来，新请求就可以找到这个实例并启动它的关闭流程。
       */
      const map = { ...info, closing: undefined, downstream };
      this.map.set(info.id, map);
      if (!this.timer) this.timer = setTimeout(this.timerFn.bind(this), 60 * 1000);

      /**
       * 获取服务端已有文件大小，作为前端断点续传的起始偏移量。
       *
       * 这是一个异步操作。等待期间，当前实例可能已经被更新的请求
       * 替换，或者因为 WebSocket 断开而进入关闭流程。
       */
      const size = await downstream.getSize();

      // getSize 返回后重新获取 Map 中的当前实例。
      const curMap = this.map.get(info.id);

      /**
       * 不能仅凭 getSize 成功就发送握手。
       *
       * 需要同时满足：
       * 1. Map 中的连接仍然是本次请求的 WebSocket。
       * 2. 当前实例没有进入关闭流程。
       * 3. WebSocket 仍然处于打开状态。
       *
       * 这样可以防止旧请求在异步等待结束后，继续发送过期的握手响应。
       */
      if (curMap?.ws === info.ws && !curMap.closing && downstream.isOpen()) {
        // 告知前端服务端已保存的数据大小。
        // 前端收到后，才能从对应偏移量继续发送音频。
        this.sendBuffer(info, this.KeepDataIntegrityKey + "->" + size);

        return true;
      }

      /**
       * 初始化期间连接已经失效，或者当前 Map 已经属于其他连接。
       *
       * 此处只能关闭本次请求创建的 map，不能关闭 curMap，
       * 因为 curMap 可能已经是更新请求创建的新实例。
       *
       * 如果本实例已经进入关闭流程，就不重复启动关闭操作。
       */
      if (!map.closing) this.downstreamClose(map);
    } catch (e) {
      /**
       * 当前实现将初始化或等待过程中发生的异常转换为握手失败。
       *
       * 按当前调用约定，外层收到 false 后会关闭 WebSocket，
       * 再由 onClose 处理仍登记在 Map 中的会话。
       *
       * 注意：这里本身没有主动清理资源，因此依赖外层关闭连接的流程。
       */
    }

    return false;
  }

  /**
   * 接收当前 WebSocket 发送的数据。
   *
   * 只有 Map 中仍然登记的当前连接，且没有进入关闭流程时，
   * 才允许将数据交给 downstream。
   *
   * 旧连接即使还有消息到达，也不能继续写入文件。
   */
  public onData({ id, ws }: IReliableWebSocketServerInfo<T>, data: Buffer) {
    const map = this.map.get(id);
    if (!map || map.ws !== ws || map.closing) return;
    map.downstream.onData(data);
  }

  /**
   * 处理 WebSocket 断开事件。
   *
   * 只处理 Map 中仍然登记的当前连接。
   * 如果这是旧连接的延迟 close 事件，或者实例已经在关闭，
   * 就不重复启动关闭流程。
   */
  public onClose({ id, ws }: IReliableWebSocketServerInfo<T>) {
    const map = this.map.get(id);
    if (!map || map.ws !== ws || map.closing) return;
    this.downstreamClose(map);
  }

  /**
   * 启动或等待某个 downstream 的关闭流程。
   *
   * map.closing 同时承担两项职责：
   * 1. 标记该实例已经进入关闭流程，防止重复调用 close。
   * 2. 保存当前最新的关闭等待者。
   *
   * 如果关闭已经启动：
   * - reject 之前的等待者，让较早的创建请求失效。
   * - 不再重复调用 downstream.close()。
   * - 保存最新请求的 resolve/reject，等待底层关闭完成。
   *
   * 如果关闭尚未启动：
   * - 启动一次 downstream.close()。
   * - 底层关闭完成后删除旧实例，并通知当前等待者。
   */
  private downstreamClose(
    map: IReliableWebSocketServerMap<T> & IReliableWebSocketServerInfo<T>,
    resolve?: () => void,
    reject?: () => void
  ) {
    /**
     * 如果已有等待者，说明更早的请求正在等待这个实例关闭。
     *
     * 新请求到来时，旧请求不再有资格继续创建会话，
     * 因此 reject 旧请求的等待 Promise。
     *
     * 这里 reject 的只是等待者，不是底层 close 操作。
     * 底层关闭会继续执行，不能因为旧请求失效而取消资源清理。
     */
    map.closing?.reject?.();

    /**
     * 只有第一次进入关闭流程时才真正调用 close。
     *
     * 后续请求只替换等待者，不会再次关闭同一个 downstream。
     */
    if (!map.closing) {
      map.downstream.close().finally(() => {
        /**
         * 关闭完成时，只有 Map 仍然指向这个 WebSocket，
         * 才删除该文件 id 对应的记录。
         *
         * 这样可以避免旧实例的关闭回调删除后来登记的新连接。
         *
         * 当前实现比较的是 ws 身份；按照既定约束，
         * 同一 WebSocket 不会针对同一个 id 重复创建实例。
         */
        if (map.ws === this.map.get(map.id)?.ws) this.map.delete(map.id);

        /**
         * 这里读取的是 map.closing 当前保存的等待者，
         * 而不是第一次启动关闭时捕获的 resolve。
         *
         * 因为关闭期间可能有多个新请求依次到来，
         * 较早的等待者已经被 reject，最后留下的是最新等待者。
         *
         * 底层关闭完成后，唤醒最新等待者，让它继续创建新实例。
         */
        map.closing?.resolve?.();
      });
    }

    /**
     * 无论是否首次启动关闭，都把当前调用者记录为最新等待者。
     *
     * 这一步必须放在启动 close 之后同步完成即可：
     * close 返回 Promise，finally 回调会在后续微任务中执行。
     * 因而正常的异步 close 实现下，回调读取到的是更新后的 closing。
     */
    map.closing = { resolve, reject };
  }
}

/**
 * downstream 的基类。
 *
 * ReliableWebSocketServer 不直接处理文件写入细节，
 * 只通过这些方法管理具体实例的生命周期。
 *
 * 具体子类需要实现：
 * - close：关闭该实例持有的资源。
 * - onData：处理收到的数据。
 * - getSize：读取服务端已有文件大小。
 * - isOpen：判断对应的 WebSocket 是否仍然打开。
 */
export class WsDownstream<T> {
  constructor(public readonly info: IReliableWebSocketServerInfo<T>) {}
  public async close() {
    throw new Error("请在子类覆盖close中实现");
  }
  public onData(data: Buffer) {
    throw new Error("请在子类覆盖onData中实现");
  }
  public async getSize(): Promise<number> {
    throw new Error("请在子类覆盖getSize中实现");
  }
  public isOpen(): boolean {
    throw new Error("请在子类覆盖isOpen中实现");
  }
}

// 测试用例
// import * as fs from "fs";
// import * as wsServer from "ws";

// class Downstream<T extends WebSocket> extends WsDownstream<T> {
//   private readonly fsWriteStream: fs.WriteStream;

//   constructor(info: IReliableWebSocketServerInfo<T>) {
//     super(info);
//     this.fsWriteStream = fs.createWriteStream(info.id + ".bin", { flags: "a" });
//   }

//   public onData(data: Buffer) {
//     if (this.fsWriteStream.writable) this.fsWriteStream.write(data);
//   }

//   public async close() {
//     if (this.fsWriteStream.writable) this.fsWriteStream.end();
//     if (this.isOpen()) this.info.ws.close();
//     await new Promise<void>(resolve => this.fsWriteStream.on("close", resolve));
//   }

//   public async getSize() {
//     try {
//       return (await fs.promises.stat(this.info.id + ".bin")).size;
//     } catch (e) {
//       // 当前示例将读取失败视为文件大小为 0。
//       // 生产环境可以进一步区分文件不存在和其他错误。
//       return 0;
//     }
//   }

//   public isOpen() {
//     return this.info.ws.readyState === WebSocket.OPEN;
//   }
// }

// const wss = new wsServer.WebSocketServer({ noServer: true });

// const reliableWebSocketServer = new ReliableWebSocketServer<WebSocket>(
//   Downstream,
//   (info, data) => info.ws.send(data),
//   "KeepDataIntegrityKey"
// );

// wss.on("connection", async (ws, req) => {
//   /** 仅作实例，实际中不能直接拿url当作文件路径 */
//   const info = { ws, id: req.url || "" };
//   ws.on("close", () => reliableWebSocketServer.onClose(info));

//   /**
//    * 等待服务端完成初始化并发送握手响应。
//    *
//    * false 表示当前连接未能取得该文件 id 的有效会话资格，
//    * 因此关闭该连接。
//    */
//   if (!(await reliableWebSocketServer.onConnection(info))) {
//     if (ws.readyState === WebSocket.OPEN) ws.close();
//     return;
//   }
//   /** 没握手成功前，数据全部丢弃 */
//   ws.on("message", (buf: Buffer, isBinary: boolean) => isBinary && reliableWebSocketServer.onData(info, buf));
// });
