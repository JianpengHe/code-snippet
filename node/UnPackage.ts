import * as stream from "stream";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
enum EUnPackageFileStage {
  总大小,
  时间,
  文件名,
  文件,
  哈希,
}

type ICallback = (error: Error | null | undefined) => void;
type IUnPackageProps = {
  outputDirectory?: string;
  onFile?: UnPackage["onFile"];
};
type IFileInfo = {
  fd: number;
  filePath: string;
  fileSize: number;
  /** 该文件剩余未处理的字节 */
  lastSize: number;
  ctime?: Date;
  mtime?: Date;
  atime?: Date;
  /** 阶段 */
  stage: EUnPackageFileStage;
  md5?: crypto.Hash;
};
export class UnPackage extends stream.Writable {
  private readonly onFile?: (fileInfo: IFileInfo) => void | true;
  // private readonly dirSet = new Set<string>();
  private readonly outputDirectory: string;
  constructor(props?: IUnPackageProps) {
    const { outputDirectory, onFile } = props || {};
    super();
    this.outputDirectory = path.resolve(outputDirectory ?? __dirname);
    this.onFile = onFile;
  }

  /** 没来得及处理的buffer */
  private tempBuf: Buffer[] = [];

  /** 当前正在处理的文件 */
  private fileInfo: IFileInfo | undefined;

  /** 需要触发drain时的回调 */
  private callback: ICallback | undefined;
  // private callbacks: ICallback[] = [];

  /** 同时只能处理一个文件 */
  private writeLock = false;

  public _write(chunk?: any, encoding?: BufferEncoding, callback?: ICallback) {
    /** 如果已经被销毁了，不做任何处理 */
    if (this.destroyed) return false;

    /** 如果是系统触发的回调，会带上chunk */
    chunk && this.tempBuf.push(chunk);

    if (this.writeLock) return false;
    /** 判断触发 */
    if (!this.callback) this.callback = callback;
    // let callback: ICallback | undefined = typeof cb1 === "function" ? cb1 : cb2;
    // callback && this.callbacks.push(callback);

    /** 合并所有待处理的buffer */
    this.tempBuf[0] = Buffer.concat(this.tempBuf);
    this.tempBuf.length = 1;

    /** 如果一个buffer里面有多个文件的情况 */
    while (this.tempBuf[0].length && !this.destroyed) {
      if (!this.fileInfo) {
        /** 如果没有正在处理的文件，就读取新文件的总大小 */
        if (this.tempBuf[0].length < 6) break;

        /** 设置新文件的信息 */
        this.fileInfo = {
          fd: 0,
          filePath: "",
          fileSize: 0,
          lastSize: this.tempBuf[0].readIntLE(0, 6),
          stage: EUnPackageFileStage.时间,
          // md5: crypto.createHash("md5"),
        };

        /** 去掉已消耗的字节 */
        this.tempBuf[0] = this.tempBuf[0].subarray(6);
      }

      if (this.fileInfo.stage === EUnPackageFileStage.时间) {
        /** 读取头部 */
        if (this.tempBuf[0].length < 6 * 3) break;
        //this.fileInfo.time = this.tempBuf[0].subarray(0, 6 * 3);
        this.fileInfo.ctime = new Date(this.tempBuf[0].readIntLE(0, 6) ?? new Date());
        this.fileInfo.mtime = new Date(this.tempBuf[0].readIntLE(6, 6) ?? new Date());
        this.fileInfo.atime = new Date(this.tempBuf[0].readIntLE(12, 6) ?? new Date());
        this.fileInfo.stage = EUnPackageFileStage.文件名;
        this.fileInfo.lastSize -= 6 * 3;
        this.tempBuf[0] = this.tempBuf[0].subarray(6 * 3);
      }

      if (this.fileInfo.stage === EUnPackageFileStage.文件名) {
        /** 读取头部 */
        const index = this.tempBuf[0].indexOf("\0");
        if (index < 0) break;
        this.fileInfo.filePath = String(this.tempBuf[0].subarray(0, index));
        this.fileInfo.lastSize -= index + 1 + 16;
        this.fileInfo.fileSize = this.fileInfo.lastSize;
        this.tempBuf[0] = this.tempBuf[0].subarray(index + 1);
        const fileInfo = this.fileInfo;
        /** 如果不是空文件 */
        if (fileInfo.fileSize !== 0) {
          /** 开启异步 */
          this.writeLock = true;
          // this.mkdir(fileInfo.filePath, () =>
          fs.open(path.resolve(this.outputDirectory, fileInfo.filePath), "w", (err, fd) => {
            if (err) {
              this.destroy(err);
              // throw err;
              return;
            }
            fileInfo.fd = fd;
            fileInfo.stage = EUnPackageFileStage.文件;
            fileInfo.md5 = crypto.createHash("md5");
            this.writeLock = false;
            this._write();
          });
          // ,);
          return false;
        } else {
          /** 判断文件夹 */
          if (fileInfo.filePath.endsWith("/")) {
            this.writeLock = true;
            this.mkdir(fileInfo);
            return false;
          }
          /** 真正的空文件 */
          fs.open(path.resolve(this.outputDirectory, fileInfo.filePath), "w", (err, fd) => {
            if (err) {
              this.destroy(err);
              // throw err;
              return;
            }
            this._onFile(fileInfo);
          });
        }
        fileInfo.stage = EUnPackageFileStage.哈希;
        // if (this.fileInfo.lastSize <= this.tempBuf[0].length)
        //   /** 如果缓存的buf大于文件所需的buf，走同步 */
      }

      if (this.fileInfo.stage === EUnPackageFileStage.文件) {
        /** 如果文件body还没处理完 */
        if (this.fileInfo.lastSize > 0) {
          /** 开启异步 */
          this.writeLock = true;
          return this.writeFile(this.fileInfo);
        }
        this.fileInfo.stage = EUnPackageFileStage.哈希;
      }

      if (this.fileInfo.stage === EUnPackageFileStage.哈希) {
        /** 读取头部 */
        if (this.tempBuf[0].length < 16) break;
        const hashBuf = this.tempBuf[0].subarray(0, 16);
        if (this.fileInfo.md5) {
          /** 不是空文件 */
          if (!this.fileInfo.md5.digest().equals(hashBuf)) {
            console.log("校验失败：" + this.fileInfo.filePath);
            this.destroy(new Error("校验失败：" + this.fileInfo.filePath));
            return false;
          }
          this._onFile(this.fileInfo);
        }
        /** 该文件处理完成 */
        this.fileInfo = undefined;
        this.tempBuf[0] = this.tempBuf[0].subarray(16);
      }
    }
    /** 触发drain */
    this.callback?.(null);
    // while ((callback = this.callbacks.shift())) callback(null);
    return true;
  }

  public _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.tempBuf.length = 0;
    this.fileInfo = undefined;
    this.callback = undefined;
    // this.callbacks.length = 0;
    this.writeLock = true;
    callback(error);
  }

  private writeFile(fileInfo: UnPackage["fileInfo"]) {
    if (!fileInfo || fileInfo.stage !== EUnPackageFileStage.文件) return false;
    const fileBuf = this.tempBuf[0].subarray(0, fileInfo.lastSize);
    fs.write(fileInfo.fd, fileBuf, (err, written, buffer) => {
      if (err) {
        this.destroy(err);
        return;
      }
      this.tempBuf[0] = this.tempBuf[0].subarray(written);
      fileInfo.md5?.update(buffer);
      fileInfo.lastSize -= written;
      this.writeLock = false;
      this._write();
    });
    return false;
  }
  private mkdir(fileInfo: IFileInfo) {
    fs.mkdir(fileInfo.filePath, { recursive: true }, () => {
      fileInfo.stage = EUnPackageFileStage.哈希;
      this.writeLock = false;
      this._write();
      fs.utimes(fileInfo.filePath, fileInfo.atime || new Date(), fileInfo.mtime || new Date(), () => {});
    });
  }

  private _onFile(fileInfo: IFileInfo) {
    if (this.onFile?.(fileInfo) === true) {
      fs.close(fileInfo.fd);
    } else {
      fs.futimes(fileInfo.fd, fileInfo.atime || new Date(), fileInfo.mtime || new Date(), () => fs.close(fileInfo.fd));
    }
  }
  // private mkdir(fileName: string, cb: () => void) {
  //   const { dir } = path.parse(fileName);
  //   if (this.dirSet.has(dir)) {
  //     cb();
  //     return;
  //   }
  //   this.dirSet.add(dir);
  //   fs.mkdir(path.resolve(this.outputDirectory, dir), { recursive: true }, cb);
  // }
}
