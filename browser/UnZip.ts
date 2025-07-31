import { StreamDemander } from "./StreamDemander";

/**
 * ZIP文件头信息接口
 * 描述ZIP文件中单个文件的基本信息
 */
export type IUnZipHead = {
  /** 解压文件所需 pkware最低版本 */
  version: number;
  /** 通用比特标志位(置比特0位=加密) */
  flag: number;
  /** 压缩方式：0=不压缩, 8=deflate */
  compressionMethod: number;
  /** 文件最后修改时间 (参考https://learn.microsoft.com/zh-cn/windows/win32/api/winbase/nf-winbase-dosdatetimetofiletime) */
  lastModificationTime: number;
  /** 文件最后修改日期 */
  lastModificationDate: number;
  /** CRC-32校验码，用于验证文件完整性 */
  CRC: number;
  /** 压缩后的大小（字节数） */
  compressedSize: number;
  /** 未压缩的大小（字节数） */
  uncompressedSize: number;
  /** 文件名长度（字节数） */
  fileNameLength: number;
  /** 扩展区长度（字节数） */
  extraFieldLength: number;
  /** 文件名 */
  fileName: string;
  /** 扩展区数据 */
  extraField?: Uint8Array;
  /** 完整解压路径，包含输出目录 */
  filePath: string;
  /** 单个文件子可读流，用于读取文件内容 */
  fileBuffer: Uint8Array;
};

export class UnZip extends StreamDemander {
  constructor(response: Response) {
    super(response);
    this.init();
  }
  private totalFileCount: number = 0;
  public readonly fileMap = new Map<string, IUnZipHead>();
  private isRecvEnd: boolean = false;
  private checkEnd() {
    if (this.isRecvEnd && this.totalFileCount >= this.fileMap.size) this.onEnd(this.fileMap);
  }
  private async init() {
    while (true) {
      let result = this.addTask(4);
      switch (new DataView((result instanceof Promise ? await result : result).buffer).getUint32(0)) {
        case 0x504b0102:
          console.log(0x504b0102);
          this.isRecvEnd = true;
          this.checkEnd();
          return;
          break;
        case 0x504b0304:
          result = this.addTask(26);
          const buf = new DataView((result instanceof Promise ? await result : result).buffer);
          const info: IUnZipHead = {
            version: buf.getUint16(0, true),
            flag: buf.getUint16(2, true),
            compressionMethod: buf.getUint16(4, true),
            lastModificationTime: buf.getUint16(6, true),
            lastModificationDate: buf.getUint16(8, true),
            CRC: buf.getUint32(10, true),
            compressedSize: buf.getUint32(14, true),
            uncompressedSize: buf.getUint32(18, true),
            fileNameLength: buf.getUint16(22, true),
            extraFieldLength: buf.getUint16(24, true),
            fileName: "",
            filePath: "",
            fileBuffer: new Uint8Array(),
          };
          result = this.addTask(info.fileNameLength);
          info.fileName = UnZip.bufferToText(result instanceof Promise ? await result : result);
          result = this.addTask(info.extraFieldLength);
          info.extraField = result instanceof Promise ? await result : result;

          result = this.addTask(info.compressedSize);
          info.fileBuffer = result instanceof Promise ? await result : result;
          this.fileMap.set(info.fileName, info);
          if (info.compressionMethod === 8 || info.compressionMethod === 9) {
            UnZip.inflateRaw(info.fileBuffer!).then(res => {
              info.fileBuffer = res;
              this.onFile(info);
              this.totalFileCount++;
              this.checkEnd();
            });
          } else {
            this.onFile(info);
            this.totalFileCount++;
            this.checkEnd();
          }

          break;
        case 0x504b0506:
          console.log(0x504b0506);
          return;
          break;
        case 0x504b0708:
          console.log(0x504b0708);
          return;
          break;
      }
    }
  }
  public onEnd(fileMap: UnZip["fileMap"]) {
    console.log(fileMap);
  }
  public onFile(info: IUnZipHead) {
    console.log(info);
  }
  static async inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()
    );
  }
  static bufferToText(data: Uint8Array): string {
    return new TextDecoder().decode(data);
  }
}

// 测试用例
// (async () => {
//   const unZip = new UnZip(await fetch("https://xxx.com/test.zip"));

//   unZip.onFile = data => {
//     console.log(data);
//   };
//   unZip.onEnd = fileMap => {
//     console.log(fileMap);
//   };
// })();
