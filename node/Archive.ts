import * as stream from "stream";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { RecvStreamPro } from "../../tools/src/node/RecvStreamPro";

type IAddFile = {
  fullPath?: string;
  relativePath: string;
  size: number;
  ctimeMs: number;
  mtimeMs: number;
  atimeMs: number;
  readable?: stream.Readable;
  resolve: (md5: string) => void;
  reject: (reason?: Error) => void;
  md5Handle?: crypto.Hash;
  md5?: Buffer;
};

class Package extends stream.Readable {
  constructor(inputDirectory?: string) {
    super();
    if (inputDirectory !== undefined) {
      Package.readDirectory(inputDirectory).then(files => {
        files.forEach(file => this.addFile(file));
        this.end();
      });
    }
  }

  static async readDirectory(directory: string) {
    directory = path.resolve(directory);
    const fileList: Omit<IAddFile, "resolve" | "reject" | "md5Handle">[] = [];
    let root = path.parse(directory).dir;
    if (!root.endsWith(path.sep)) root += path.sep;
    async function dfs(fullPath: string) {
      const stats = await fs.promises.lstat(fullPath);
      const isDirectory = stats.isDirectory();
      const isFile = stats.isFile();
      if (isDirectory || isFile) {
        if (isDirectory && !fullPath.endsWith(path.sep)) fullPath += path.sep;
        if (!fullPath.startsWith(root)) throw new Error("不支持上层文件夹" + fullPath + ",root:" + root);
        fileList.push({
          fullPath,
          relativePath: fullPath.substring(root.length),
          size: stats.size,
          ctimeMs: stats.ctimeMs,
          mtimeMs: stats.mtimeMs,
          atimeMs: stats.atimeMs,
        });
        if (isDirectory) {
          for (const file of await fs.promises.readdir(fullPath)) {
            await dfs(path.resolve(fullPath, file));
          }
        }
      }

      // if (stats.isFile()) return this.pushFile(curPath, stats);
    }
    await dfs(directory);
    return fileList;
  }

  private curFile: IAddFile | undefined;

  private pushFile() {
    // if (!fullPath.startsWith(this.root)) {
    //   console.log(this.root, fullPath);
    //   this.destroy(new Error("暂不支持"));
    //   throw new Error("暂不支持");
    // }
    /** 相对路径 */
    // const relativePath = fullPath.substring(this.root.length + 1).replace(/\0/g, "");
    // console.log(relativePath, size);
    if (!this.curFile) {
      this.destroy(new Error("不存在this.curFile"));
      throw new Error("不存在this.curFile");
    }
    const { fullPath, relativePath, size, ctimeMs, mtimeMs, atimeMs, readable, resolve, reject } = this.curFile;

    if (this.destroyed) {
      reject(new Error("流已经destroyed"));
      return;
    }

    /** 文件相对路径Buffer */
    const headPathBuf = Buffer.from(relativePath + "\0");
    /** 总大小+ ctime + mtime + atime */
    const headInfoBuf = Buffer.allocUnsafe(6 * 4);
    /** 写入总大小 */
    headInfoBuf.writeIntLE(
      /** 除总大小以外的头 */
      3 * 6 +
        /** 文件相对路径 */
        headPathBuf.length +
        /** 文件大小 */
        size +
        /** MD5 */
        (size > 0 ? 16 : 0),
      0,
      6
    );
    /** 写入ctime */
    headInfoBuf.writeIntLE(Math.floor(ctimeMs), 6, 6);
    /** 写入mtime */
    headInfoBuf.writeIntLE(Math.floor(mtimeMs), 12, 6);
    /** 写入atime */
    headInfoBuf.writeIntLE(Math.floor(atimeMs), 18, 6);
    this.push(Buffer.concat([headInfoBuf, headPathBuf]));

    /** 不为空文件 */
    if (size !== 0) {
      this.curFile.md5Handle = crypto.createHash("md5");
      this.curFile.readable = readable ?? (fullPath ? fs.createReadStream(fullPath) : undefined);
      this.curFile.readable?.once("close", () => {
        if (this.curFile) {
          this.curFile.md5 = this.curFile.md5Handle?.digest();
          if (!this.curFile.md5) throw new Error("md5不存在");
          this.push(this.curFile.md5);
          resolve(this.curFile.md5.toString("hex"));
          this.curFile = undefined;
        }
        this.tryToAddFile();
      });
      this._read(16384);
      return;
    }

    // this.push(Buffer.alloc(16).fill(0));
    resolve("");
    this.curFile = undefined;
    this.tryToAddFile();
  }

  private readonly addFileQueue: IAddFile[] = [];
  private async tryToAddFile() {
    if (this.curFile) return;
    if ((this.curFile = this.addFileQueue.shift())) {
      return this.pushFile();
    }
    if (this.addFileQueue.length === 0 && this.ended) {
      this.push(null);
    }
  }
  public async addFile(file: Omit<IAddFile, "resolve" | "reject" | "md5">) {
    return new Promise<string>((resolve, reject) => {
      if (this.ended) {
        reject(new Error("已结束，不允许再添加"));
        return;
      }
      const fileInfo = file as IAddFile;
      fileInfo.resolve = resolve;
      fileInfo.reject = reject;
      this.addFileQueue.push(fileInfo);
      this.tryToAddFile();
    });
  }

  private ended = false;
  public async end() {
    this.ended = true;
    this.tryToAddFile();
  }

  public _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.curFile = undefined;
    callback(error);
  }

  public _read(size: number) {
    if (!this.curFile) return;
    const { resolve, reject, md5Handle, readable } = this.curFile;
    if (!readable || !md5Handle) {
      const err = new Error("size不为0时，readable不能为空");
      reject(err);
      this.destroy(err);
      throw err;
    }
    if (readable.readableEnded) return;

    if (readable.readableLength) {
      const buf = readable.read();
      if (buf) {
        md5Handle.update(buf);
        this.push(buf);
        return;
      }
    }
    readable.once("readable", () => {
      const buf = readable.read();
      if (!buf) return;
      md5Handle.update(buf);
      this.push(buf);
    });
  }
}

export type IFileInfo = {
  relativePath: string;
  fileSize: number;
  fileStream?: stream.Readable;
  ctime: Date;
  mtime: Date;
  atime: Date;
  verificationResult?: boolean;
  md5?: Buffer;
};

export type IUnPackageOpt = {
  outputDir?: string;
  onFileInfo?: (fileInfo: IFileInfo) => void;
  onFile?: (fileInfo: IFileInfo) => void;
  onDir?: (fileInfo: IFileInfo) => void | Promise<void>;
  onError?: (fileInfo: IFileInfo) => void;
};
class UnPackage extends RecvStreamPro {
  private readonly opt: Omit<IUnPackageOpt, "outputDir"> & { outputDir: string };
  constructor(opt?: IUnPackageOpt) {
    super();
    this.opt = { ...opt, outputDir: path.resolve(opt?.outputDir ?? __dirname) };
    this.read();
  }
  private async onEnd() {
    for (const [fullPath, { atime, mtime, ctime }] of [...this.utimesDirs.entries()].sort(
      (a, b) => b[0].length - a[0].length
    )) {
      await fs.promises.utimes(fullPath, atime, mtime);
    }
    this.utimesDirs.clear();
  }
  private async read() {
    while (!this.isFinal) {
      let headInfoBuf = this.readBuffer(24);
      headInfoBuf = (headInfoBuf.constructor === Promise ? await headInfoBuf : headInfoBuf) as Buffer;
      if (headInfoBuf.length !== 24) {
        /** 结束了 */
        this.onEnd();
        return;
      }
      // console.log(headInfoBuf);
      const fileInfo: IFileInfo = {
        fileSize: headInfoBuf.readIntLE(0, 6),
        ctime: new Date(headInfoBuf.readIntLE(6, 6)),
        mtime: new Date(headInfoBuf.readIntLE(12, 6)),
        atime: new Date(headInfoBuf.readIntLE(18, 6)),
        relativePath: "",
      };

      let relativePathBuf = this.readBufferUnfixed(2, buf => {
        const index = buf.indexOf(0);
        return index < 0 ? -1 : index + 1;
      });
      relativePathBuf = (relativePathBuf.constructor === Promise ? await relativePathBuf : relativePathBuf) as Buffer;

      fileInfo.relativePath = String(relativePathBuf).trim();

      if (fileInfo.relativePath[fileInfo.relativePath.length - 1] === "\0")
        fileInfo.relativePath = fileInfo.relativePath.substring(0, fileInfo.relativePath.length - 1);
      /** 文件大小 */
      fileInfo.fileSize -=
        3 * 6 +
        /** 文件相对路径 */
        relativePathBuf.length;

      if (fileInfo.fileSize > 0) {
        /** MD5 */
        fileInfo.fileSize -= 16;
      }

      let md5: crypto.Hash | undefined;
      if (fileInfo.fileSize > 0) {
        md5 = crypto.createHash("md5");
        const fileStream = this.readStream(fileInfo.fileSize);
        fileInfo.fileStream = fileStream;
        fileStream.pipe(md5, { end: false });

        await Promise.all([(this.onFileInfo(fileInfo), new Promise(r => fileStream.once("close", r)))]);

        let md5Buf = this.readBuffer(16);
        md5Buf = (md5Buf.constructor === Promise ? await md5Buf : md5Buf) as Buffer;
        // console.log(md5.digest(), md5Buf);
        fileInfo.md5 = md5.digest();
        fileInfo.verificationResult = fileInfo.md5.equals(md5Buf);

        if (!fileInfo.verificationResult) {
          if (this.opt.onError) this.opt.onError(fileInfo);
          else throw new Error("MD5校验失败");
        }
      } else {
        const onFileReturn = this.onFileInfo(fileInfo);
        if (onFileReturn) await onFileReturn;
      }
    }
  }
  private utimesDirs: Map<string, { atime: Date; mtime: Date; ctime: Date }> = new Map();
  private onFileInfo(fileInfo: IFileInfo) {
    this.opt.onFileInfo?.(fileInfo);
    const { fileStream, atime, mtime, ctime, relativePath } = fileInfo;
    const fullPath = path.resolve(this.opt.outputDir, relativePath);
    if (!fullPath.startsWith(this.opt.outputDir))
      throw new Error(relativePath + "试图脱离当前目录" + this.opt.outputDir + "，已被阻止");

    if (relativePath.endsWith("/") || relativePath.endsWith("\\")) {
      return this.opt?.onDir
        ? this.opt?.onDir(fileInfo)
        : new Promise<void>(resolve => {
            fs.mkdir(fullPath, { recursive: true }, () => {
              this.utimesDirs.set(fullPath, { atime, mtime, ctime });
              resolve();
            });
          });
    }

    if (this.opt?.onFile) return this.opt?.onFile(fileInfo);

    if (fileStream) {
      return new Promise<void>(resolve => {
        const fileWriteStream = fs.createWriteStream(fullPath + ".temp");
        fileStream.pipe(fileWriteStream);
        fileWriteStream.once("close", () =>
          fs.rename(fullPath + ".temp", fullPath, () => {
            resolve();
            fs.utimes(fullPath, atime, mtime, () => {});
          })
        );
      });
    }
    fs.writeFile(fullPath, Buffer.allocUnsafe(0), () => fs.utimes(fullPath, atime, mtime, () => {}));
    return;
  }
}
export default { Package, UnPackage };
/** 测试用例 */
// import * as child_process from "child_process";
// import * as os from "os";

// const TestCases = (dir: string) => {
//   console.log("开始打包", dir);
//   console.time("打包耗时");
//   const f = fs.createWriteStream("../test.bin");
//   new Package(dir).pipe(f);
//   f.once("close", () => {
//     console.timeEnd("打包耗时");
//     console.time("解包耗时");
//     fs.createReadStream("../test.bin").pipe(new UnPackage(UnPackage.writeToDisk(__dirname)));
//     process.on("exit", () => console.timeEnd("解包耗时"));
//   });
// };

/** 测试用例1 大小不一的文件 */
// TestCases(os.homedir() + "/Downloads/flutter");
/** 测试用例2 超多小文件 */
// TestCases(String(child_process.execSync("pnpm store path")).trim());
/** 测试用例3 几个超大文件 */
// TestCases(os.homedir() + "/Downloads");
// TestCases("D:/九五至尊");
/** 测试用例4 空文件夹和空文件 */
// fs.mkdirSync("../t");
// TestCases("../t");
