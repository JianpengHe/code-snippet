import * as child_process from "child_process";
import * as stream from "stream";

export type IZstandardProps = {
  args?: string[];
  options?: child_process.SpawnOptionsWithoutStdio;
  duplexOptions?: stream.DuplexOptions;
  zstdPath?: string;
};
export class Zstandard extends stream.Duplex {
  public readonly subprocess: child_process.ChildProcessWithoutNullStreams;
  public receivedBytes = 0;
  public outputBytes = 0;
  constructor(level: number | "d", { args, options, duplexOptions: transformOptions, zstdPath }: IZstandardProps = {}) {
    super(transformOptions);
    args = args || ["-" + level, "-vc", "-T0", "--progress", "--no-check"];
    options = options || { cwd: __dirname };
    zstdPath = zstdPath || "zstd.exe";
    this.subprocess = child_process.spawn(zstdPath, args, options);
    this.subprocess.stdout.on("data", chunk => {
      this.outputBytes += chunk.length;
      if (this.push(chunk) === false) this.subprocess.stdout.pause();
    });
    this.subprocess.stdout.once("close", () => this.push(null));
    this.subprocess.stdout.once("error", err => this.destroy(err));
    this.subprocess.stderr.on("data", buffer => this.emit("process", buffer));
  }

  public _read(size: number) {
    this.subprocess.stdout.resume();
  }

  public _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.subprocess.stdin.closed) this.subprocess.stdin.destroy(error || undefined);
    if (!this.subprocess.stdout.closed) this.subprocess.stdout.destroy(error || undefined);
    callback(error);
  }

  public _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.receivedBytes += chunk.length;
    return this.subprocess.stdin.write(chunk, encoding, callback);
  }
  public _final(callback: (error?: Error | null) => void): void {
    this.subprocess.stdin.end(callback);
  }
}

/** 测试用例 */
// import * as fs from "fs";
// const readStream = fs.createReadStream("../test.bin");
// const writeStream = fs.createWriteStream("../test.bin.zst");

// const zstandard = new Zstandard(16);
// readStream.pipe(zstandard).pipe(writeStream);

// let lastProcessMsg = "";
// zstandard.on("process", buffer => {
//   lastProcessMsg += String(buffer);
//   lastProcessMsg = (
//     lastProcessMsg
//       .trim()
//       .split("\r")
//       .findLast(line => line.includes("%")) || ""
//   ).trim();
//   console.log(
//     lastProcessMsg,
//     (zstandard.receivedBytes / 1024 / 1024).toFixed(3),
//     (zstandard.outputBytes / 1024 / 1024).toFixed(3)
//   );
// });
