import * as stream from "stream";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

export class Package extends stream.Readable {
  private readonly root: string;
  constructor(inputDirectory: string) {
    super();
    const fullPath = path.resolve(inputDirectory);
    const { dir } = path.parse(fullPath);
    this.root = dir;
    this.dfs(fullPath)
      .then(() => this.push(null))
      .catch(err => {
        if (!this.destroyed) this.destroy(err);
      });
  }
  private async dfs(fullPath: string) {
    if (this.destroyed) return;
    const stats = await fs.promises.lstat(fullPath);
    if (stats.isDirectory()) {
      await this.pushFile(fullPath + "/", stats);
      for (const file of await fs.promises.readdir(fullPath)) {
        await this.dfs(path.resolve(fullPath, file));
      }
      return;
    }
    if (stats.isFile()) return this.pushFile(fullPath, stats);
  }

  private curFile: { fd: number; resolve: () => void; md5: crypto.Hash } | undefined;

  private pushFile(fullPath: string, { size, ctimeMs, mtimeMs, atimeMs }: fs.Stats) {
    if (this.destroyed) return;
    if (!fullPath.startsWith(this.root)) {
      console.log(this.root, fullPath);
      this.destroy(new Error("暂不支持"));
      throw new Error("暂不支持");
    }
    /** 相对路径 */
    const relativePath = fullPath.substring(this.root.length + 1).replace(/\0/g, "");
    // console.log(relativePath, size);
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
        16,
      0,
      6,
    );
    /** 写入ctime */
    headInfoBuf.writeIntLE(Math.floor(ctimeMs), 6, 6);
    /** 写入mtime */
    headInfoBuf.writeIntLE(Math.floor(mtimeMs), 12, 6);
    /** 写入atime */
    headInfoBuf.writeIntLE(Math.floor(atimeMs), 18, 6);
    this.push(Buffer.concat([headInfoBuf, headPathBuf]));

    /** 空文件 */
    if (size === 0) {
      this.push(Buffer.alloc(16).fill(0));
      return;
    }
    return new Promise<void>((resolve, reject) =>
      fs.open(fullPath, (err, fd) => {
        if (err) {
          this.destroy(err);
          reject(err);
          return;
        }
        this.curFile = {
          fd,
          resolve,
          md5: crypto.createHash("md5"),
        };
        this._read(16384);
      }),
    );
  }

  public _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.curFile = undefined;
    callback(error);
  }

  public _read(size: number) {
    if (!this.curFile) return;
    const { fd, resolve, md5 } = this.curFile;
    const buf = Buffer.alloc(size);
    fs.read(fd, buf, 0, size, null, (err, bytesRead) => {
      if (err) {
        this.destroy(err);
        return;
      }
      if (bytesRead > 0) {
        md5.update(buf.subarray(0, bytesRead));
        this.push(buf.subarray(0, bytesRead));
        return;
      }
      this.push(md5.digest());
      fs.close(fd);
      this.curFile = undefined;
      resolve();
    });
  }
}
