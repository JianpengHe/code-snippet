type IWebSocketSendData = string | ArrayBufferLike | Blob | ArrayBufferView;
const KeepDataIntegrityKey = "recvSize";
export class ReliableWebSocket {
  public url?: URL;
  public webSocket?: WebSocket;
  /** 待发送数据队列 */
  private readonly readyToSendbufs: IWebSocketSendData[] = [];
  /** 已发送数据数组 */
  private readonly sentBufs: ArrayBuffer[] = [];
  /** 已发送数据大小 */
  private sentSize = 0;
  /** 是否准备好了，可以发送数据 */
  private isReadyToSend = true;

  constructor(
    /** WebSocket 地址 */
    url: string | URL,
    /** 是否保持数据完整性 */
    private readonly keepDataIntegrity = false
  ) {
    this.url = new URL(url);
    if (this.keepDataIntegrity) this.url.searchParams.set("keepDataIntegrity", KeepDataIntegrityKey);

    this.reconnect();
  }
  public reconnect() {
    if (!this.url || this.reConTimer || this.webSocket?.readyState === 1) return;
    if (this.webSocket?.readyState === 0) {
      this.reConTimer = Number(
        setTimeout(() => {
          this.reConTimer && clearTimeout(this.reConTimer);
          this.reConTimer = 0;
          this.webSocket?.close();
          this.reconnect();
        }, 3000)
      );
      return;
    }
    this.reConTimer && clearTimeout(this.reConTimer);
    this.reConTimer = 0;
    this.webSocket?.close();
    this.webSocket = new WebSocket(this.url);
    this.isReadyToSend = true;
    if (this.keepDataIntegrity) {
      this.isReadyToSend = false;
      this.webSocket.addEventListener("message", e => {
        if (typeof e.data === "string" && e.data.startsWith(KeepDataIntegrityKey + "->")) {
          e.stopPropagation();
          const saveSize = Number(e.data.split("->")[1]);

          while (this.sentBufs.length > 0 && saveSize > this.sentSize) {
            const needDelSize = saveSize - this.sentSize;
            const curBufSize = this.sentBufs[0].byteLength;
            /** 待删除数据大小小于当前缓冲区大小，需要截断当前缓冲区 */
            if (needDelSize < curBufSize) {
              this.sentBufs[0] = this.sentBufs[0].slice(needDelSize);
              this.sentSize += needDelSize;
              break;
            }
            this.sentSize += curBufSize;
            this.sentBufs.shift();
          }
          /** 首次连接时，需要将上次连接断开后，没发到服务器的数据，重新添加到待发送数据队列 */
          if (this.isReadyToSend === false) {
            this.readyToSendbufs.unshift(...this.sentBufs);
            this.sentBufs.length = 0;
            this.isReadyToSend = true;
            this.tryToSend();
          }
        }
      });
    }
    for (const [type, listener] of this.eventListeners) {
      this.webSocket.addEventListener(type, listener);
    }

    this.webSocket.addEventListener("error", e => {
      console.log(e);
      setTimeout(() => this.reconnect(), 500);
    });
    this.webSocket.addEventListener("close", e => {
      console.log(e);
      setTimeout(() => this.reconnect(), 500);
    });
    this.webSocket.addEventListener("open", () => this.tryToSend());
  }
  private reConTimer = 0;
  private tryToSend() {
    let buffer: IWebSocketSendData | undefined;
    while (this.isReadyToSend && this.webSocket?.readyState === 1 && (buffer = this.readyToSendbufs.shift())) {
      this.webSocket.send(buffer);
      if (this.keepDataIntegrity && buffer) {
        //@ts-ignore
        const newBuffer = buffer.buffer || buffer;
        if (newBuffer.constructor === ArrayBuffer) this.sentBufs.push(newBuffer);
      }
    }
  }
  public send(data: IWebSocketSendData) {
    this.readyToSendbufs.push(data);
    this.tryToSend();
    return this;
  }
  public close() {
    this.url = undefined;
    this.webSocket?.close();
  }
  private eventListeners: [string, any][] = [];
  public addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any
  ) {
    this.webSocket?.addEventListener(type, listener);
    this.eventListeners.push([type, listener]);
    return this;
  }
  public removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any
  ) {
    this.webSocket?.removeEventListener(type, listener);
    const index = this.eventListeners.findIndex(a => a[0] === type && a[1] === listener);
    if (index >= 0) {
      this.eventListeners.splice(index, 1);
    }
    return this;
  }
}
