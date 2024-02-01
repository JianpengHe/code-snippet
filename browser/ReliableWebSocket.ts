type IWebSocketSendData = string | ArrayBufferLike | Blob | ArrayBufferView;
export class ReliableWebSocket {
  public url: string | URL;
  public webSocket?: WebSocket;
  constructor(url: string | URL) {
    this.url = url;
    this.reconnect();
  }
  public reconnect() {
    if (this.reConTimer || this.webSocket?.readyState === 1) return;
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
    while (this.webSocket?.readyState === 1 && (buffer = this.readyToSendbufs.shift())) {
      this.webSocket.send(buffer);
    }
  }
  public send(data: IWebSocketSendData) {
    this.readyToSendbufs.push(data);
    this.tryToSend();
    return this;
  }
  private readyToSendbufs: IWebSocketSendData[] = [];

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
