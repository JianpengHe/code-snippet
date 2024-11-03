import * as child_process from "child_process";
import { MyEvent } from "../common/手写事件";

export type INode7zEvent = {
  info: (info: INode7zInfo) => void;
  progress: (progress: INode7zProgress) => void;
  end: () => void;
  error: (msg: string) => void;
};

export type INode7zInfo = {
  raw: string;
};
export type INode7zProgress = {
  raw: string;
  progress: number;
  fileIndex: number;
  file: string;
};

export class Node7z extends MyEvent<INode7zEvent> {
  public readonly subprocess: child_process.ChildProcessWithoutNullStreams;
  constructor(
    mode: "a" | "x" | "t",
    input: string,
    args: string[] = [],
    node7zPath = "C:/softwares/zip/7z.exe", //||"C:/Program Files/7-Zip/7z.exe",
    cwd = __dirname
  ) {
    super();
    this.subprocess = child_process.spawn(node7zPath, [mode, input, ...args, "-y", "-bsp1", "-mmt=on"], {
      cwd,
      shell: true,
    });
    this.subprocess.stdout.on("data", (msg: Buffer) => {
      if (!msg) return;
      const raw = String(msg).trim();
      if (msg[0] === 0x0d && msg[1] === 0x20) {
        const [_, progress, fileIndex, file] =
          String(msg)
            .trim()
            .match(/^(\d+)% (\d+) - (.+)$/) || [];
        if (file) {
          this.emit("progress", { raw, progress: Number(progress) / 100, fileIndex: Number(fileIndex), file });
          return;
        }
        this.emit("info", { raw });
      }
    });
    this.subprocess.once("close", () => this.emit("end"));
    this.subprocess.once("error", a => console.log("error", a));
    this.subprocess.stderr.on("error", c => console.log(777777, c + ""));
  }
}

// const node7z = new Node7z("x", "1.7z");
// node7z
//   .on("info", a => console.log("info", a))
//   .on("progress", a => console.log("progress", a))
//   .on("end", () => console.log("end"));
