import * as stream from "stream";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

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
  md5?: crypto.Hash;
};

export class Package extends stream.Readable {
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
    const fileList: Omit<IAddFile, "resolve" | "reject" | "md5">[] = [];
    const root = path.parse(directory).dir + path.sep;
    async function dfs(fullPath: string) {
      const stats = await fs.promises.lstat(fullPath);
      const isDirectory = stats.isDirectory();
      const isFile = stats.isFile();
      if (isDirectory || isFile) {
        if (isDirectory && !fullPath.endsWith(path.sep)) fullPath += path.sep;
        if (!fullPath.startsWith(root)) throw new Error("不支持上层文件夹" + fullPath);
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
      this.curFile.md5 = crypto.createHash("md5");
      this.curFile.readable = readable ?? (fullPath ? fs.createReadStream(fullPath) : undefined);
      this.curFile.readable?.once("close", () => {
        const md5 = this.curFile?.md5?.digest();
        if (!md5) throw new Error("md5不存在");
        this.push(md5);
        resolve(md5.toString("hex"));
        this.curFile = undefined;
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
      this.addFileQueue.push({ ...file, resolve, reject });
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
    const { resolve, reject, md5, readable } = this.curFile;
    if (!readable || !md5) {
      const err = new Error("size不为0时，readable不能为空");
      reject(err);
      this.destroy(err);
      throw err;
    }
    if (readable.readableEnded) return;

    if (readable.readableLength) {
      const buf = readable.read();
      if (buf) {
        md5.update(buf);
        this.push(buf);
        return;
      }
    }
    readable.once("readable", () => {
      const buf = readable.read();
      if (!buf) return;
      md5.update(buf);
      this.push(buf);
    });
  }
}
