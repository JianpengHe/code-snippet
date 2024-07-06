import * as child_process from "child_process";
import { MyEvent } from "../common/手写事件";
import { RecvStream } from "../../tools/dist/node/RecvStream";

export type IFFmpegEvent = {
  info: (info: IFFmpegInfo) => void;
  progress: (txt: string, info: IFFmpegInfo) => void;
};

export enum EFFmpegStatus {
  info,
  progress,
}
export type IFFmpegStreamInfo = {
  lang: string;
  type: string;
  encode: string;
  rate: string;
  frame: string;
  bitRate: string;
  raw: string;
};
export type IFFmpegInfo = {
  input: IFFmpegStreamInfo[][];
  output: IFFmpegStreamInfo[][];
  mapping: string[];
};

export class FFmpeg extends MyEvent<IFFmpegEvent> {
  private recvStream: RecvStream;
  constructor(args: string[], ffmpegPath = "C:/softwares/ffmpeg.exe", cwd = __dirname) {
    super();
    const spawn = child_process.spawn(ffmpegPath, args, { cwd });
    this.recvStream = new RecvStream(spawn.stderr);
    this.readBuffer();
  }
  private status: EFFmpegStatus = EFFmpegStatus.info;
  private async readBuffer() {
    const buffers: Buffer[] = [];
    let buffer: Buffer | undefined;
    const changeStatus = () => {
      const txt = String(Buffer.concat(buffers)).trim();
      //   console.log([txt], Buffer.concat(buffers));
      switch (this.status) {
        case EFFmpegStatus.info:
          this.emit("info", FFmpeg.parseInfo(txt));
          this.status = EFFmpegStatus.progress;
          break;
        case EFFmpegStatus.progress:
          console.log("changeStatus", txt);
      }
      //
      buffers.length = 0;
    };

    while ((buffer = await this.recvStream.readBufferSync(byte => byte === 13))) {
      if (buffers.length && buffer.length > 1 && buffer[0] !== 0x0a) {
        changeStatus();
      }
      buffers.push(buffer);
    }
    changeStatus();
  }
  static parseInfo(txt: string) {
    const info: IFFmpegInfo = {
      input: [],
      output: [],
      mapping: [],
    };
    const matchLine = (line: string, obj: IFFmpegStreamInfo[][]) => {
      const [_, fileIndex, streamIndex, lang, type, others] =
        line.match(/^Stream #(\d+):(\d+)(\([\da-zA-Z]+\)){0,1}: ([\da-zA-Z]+):*(.*)$/) || [];
      if (type) {
        if (!obj[fileIndex]) obj[fileIndex] = [];
        const args = others
          .trim()
          .replace(/\([^\)]+\)/g, "")
          .replace(/\[[^\]]+\]/g, "")
          .split(",")
          .map(a => a.trim());
        obj[fileIndex][streamIndex] = {
          type,
          lang: (lang || "").replace(/[^\da-zA-Z]/g, ""),
          encode: args[0] || "",
          rate: args.find(arg => arg.includes(type === "Audio" ? "Hz" : "x")) || "",
          frame: type === "Video" ? args.find(arg => arg.includes("fps")) : args[2] || "",
          bitRate: args.find(arg => arg.includes("b/s")) || "",
          raw: line,
        };
      }
    };
    const lines = txt.split("\r\n");
    const inputStart = lines.findIndex(line => /^Input.+:$/.test(line));
    const outputStart = lines.findIndex(line => /^Output.+:$/.test(line));
    let mappingStart = outputStart < 0 ? lines.length : outputStart;
    if (inputStart < 0) return info;
    for (let i = inputStart; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "Stream mapping:") {
        mappingStart = i;
        continue;
      }

      if (i < mappingStart) {
        /** input */
        matchLine(line, info.input);
      } else if (i < outputStart) {
        if (/^Stream /.test(line)) {
          info.mapping.push(line);
        }
      } else {
        /** output */
        matchLine(line, info.output);
      }
    }
    console.log(JSON.stringify(info, null, 2));
    // console.log("----------", lines.slice(inputStart, outputStart));
    // console.log("----------", lines.slice(outputStart));

    return info;
  }
}

// setTimeout(() => {
//   console.log("手动关闭");
//   process.exit();
// }, 500);
new FFmpeg([
  "-i",
  "D:/input.mkv",
  "-c:v",
  "hevc_nvenc",
  "-c:a",
  "copy",
  "-rc",
  "vbr_hq",
  "-crf",
  "18",
  "-tune",
  "uhq",
  "-minrate",
  "414720",
  "-maxrate",
  "414720",
  //   "-hide_banner",
  "-y",
  "D:/t6ttt.mkv",
]);
// const a = child_process.spawn(
//   "C:/softwares/ffmpeg.exe",
//   [
//     "-i",
//     "D:/input.mkv",
//     // "-c:v",
//     // "hevc_nvenc",
//     // "-c:a",
//     // "copy",
//     // "-rc",
//     // "vbr_hq",
//     // "-crf",
//     // "18",
//     // "-tune",
//     // "uhq",
//     // "-minrate",
//     // "414720",
//     // "-maxrate",
//     // "414720",
//     // "-hide_banner",
//     // "-y",
//     // "D:/t6ttt.mkv",
//   ],
//   { cwd: __dirname }
// );

// a.stdout.on("data", d => {
//   console.log("stdout", [d, String(d)]);
// });
// a.stderr.on("data", d => {
//   console.log("stderr", [d, String(d)]);
// });
