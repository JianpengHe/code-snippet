/**
 * 一个优化的流处理器，可以按需从 fetch 响应体中读取指定大小的数据块。
 * 当请求的数据已存在于缓冲区时，它会同步返回结果以提高性能。
 */
export class StreamDemander {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private isStreamDone: boolean = false;

  /**
   * @param response 来自 `fetch` 调用的 Response 对象。
   */
  constructor(response: Response) {
    if (!response.body) {
      throw new Error("Fetch 响应体不存在或不可读。");
    }
    this.reader = response.body.getReader();
  }

  /**
   * 添加一个读取任务，从流中读取指定数量的字节。
   * 如果数据已在缓冲区中，则同步返回 ArrayBuffer。
   * 否则，异步从流中读取，并返回一个 Promise<ArrayBuffer>。
   * @param bytesToRead 需要读取的字节数量。
   * @returns {ArrayBuffer | Promise<ArrayBuffer>} 根据数据是否立即可用，返回一个 ArrayBuffer 或一个解析为 ArrayBuffer 的 Promise。
   */
  public addTask(bytesToRead: number): Uint8Array | Promise<Uint8Array> {
    if (bytesToRead < 0) {
      throw new Error("需要读取的字节数不能为负数。");
    }
    if (bytesToRead === 0) {
      return new Uint8Array();
    }

    // --- 同步路径优化 ---
    // 检查缓冲区数据是否已足够，如果足够则直接同步处理并返回
    if (this.buffer.length >= bytesToRead) {
      const resultChunk = this.buffer.subarray(0, bytesToRead);
      this.buffer = this.buffer.subarray(bytesToRead);
      // 返回结果的拷贝，避免外部修改影响内部缓冲区
      return resultChunk.slice();
    }

    // --- 异步路径 ---
    // 如果缓冲区数据不足，则调用私有的异步方法来处理流的读取
    return this.readAndFulfill(bytesToRead);
  }

  /**
   * 私有方法，处理需要从流中读取数据的异步逻辑。
   * @param bytesToRead 需要读取的字节数量。
   * @returns 一个 Promise，它会解析为一个包含所需数据的 ArrayBuffer。
   */
  private async readAndFulfill(bytesToRead: number): Promise<Uint8Array> {
    // 循环从流中读取数据，直到内部缓冲区满足本次任务需求
    while (this.buffer.length < bytesToRead) {
      if (this.isStreamDone) {
        throw new Error(`流已结束，无法读取 ${bytesToRead} 字节，剩余可用数据仅 ${this.buffer.length} 字节。`);
      }

      const { done, value } = await this.reader.read();

      if (done) {
        this.isStreamDone = true;
        break;
      }

      const newBuffer = new Uint8Array(this.buffer.length + value.length);
      newBuffer.set(this.buffer);
      newBuffer.set(value, this.buffer.length);
      this.buffer = newBuffer;
    }

    if (this.buffer.length < bytesToRead) {
      throw new Error(`任务失败：请求读取 ${bytesToRead} 字节，但流已结束，总共只能提供 ${this.buffer.length} 字节。`);
    }

    const resultChunk = this.buffer.subarray(0, bytesToRead);
    this.buffer = this.buffer.subarray(bytesToRead);

    return resultChunk.slice();
  }
}
