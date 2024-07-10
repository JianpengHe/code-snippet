import * as child_process from "child_process";
import { MyEvent } from "../common/手写事件";
import { RecvStream } from "../../tools/dist/node/RecvStream";

export type IFFmpegEvent = {
  info: (info: IFFmpegInfo) => void;
  progress: (info: IFFmpegInfo, progress: IFFmpegProgress) => void;
  end: (info: IFFmpegInfo) => void;
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
  durationRaw: string;
  duration: number;
  input: IFFmpegStreamInfo[][];
  output: IFFmpegStreamInfo[][];
  mapping: string[];
};
export type IFFmpegProgress = {
  bitrate: string;
  fps: number;
  frame: number;
  q: number;
  speed: string;
  time: string;
  raw: string;
  [x: string]: any;
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
  private info?: IFFmpegInfo;
  private async readBuffer() {
    const buffers: Buffer[] = [];
    let buffer: Buffer | undefined;
    const changeStatus = (isEnd = false) => {
      const txt = String(Buffer.concat(buffers)).trim();
      //   console.log([txt], Buffer.concat(buffers));
      switch (this.status) {
        case EFFmpegStatus.info:
          this.info = FFmpeg.parseInfo(txt);
          this.emit("info", this.info);
          this.status = EFFmpegStatus.progress;
          break;
        case EFFmpegStatus.progress:
          const progressInfo: IFFmpegProgress = {
            bitrate: "",
            fps: 0,
            frame: 0,
            q: 0,
            speed: "",
            time: "",
            raw: txt,
          };
          this.info &&
            this.emit(
              "progress",
              this.info,
              [...txt.matchAll(/([^\s=]+)\s*=\s*([^\s=]+)/g)].reduce((obj, [_, k, v]) => {
                const value = Number(v);
                return { ...obj, [k]: isNaN(value) ? v : value };
              }, progressInfo)
            );
      }
      //
      buffers.length = 0;
      if (isEnd && this.info) {
        this.emit("end", this.info);
      }
    };

    while ((buffer = await this.recvStream.readBufferSync(byte => byte === 13))) {
      if (buffers.length && buffer.length > 1 && buffer[0] !== 0x0a) {
        changeStatus();
      }
      buffers.push(buffer);
    }
    changeStatus(true);
  }
  static parseInfo(txt: string) {
    const info: IFFmpegInfo = {
      duration: 0,
      durationRaw: "",
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
        if (!info.durationRaw && /^Duration/.test(line)) {
          info.durationRaw = ((line + ",").match(/Duration:([^,]+),/)?.[1] || "").trim();
          info.duration = FFmpeg.timeToMilliSecond(info.durationRaw);
          continue;
        }
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
    // console.log(JSON.stringify(info, null, 2));
    // console.log("----------", lines.slice(inputStart, outputStart));
    // console.log("----------", lines.slice(outputStart));

    return info;
  }

  static timeToMilliSecond(time: string) {
    time = time.trim();
    let o = 0;
    const [sec, milliSecond] = time.split(".");
    if (milliSecond) {
      o += Number(milliSecond) * Math.pow(10, -1 * milliSecond.length + 3);
    }
    sec
      .split(":")
      .reverse()
      .forEach((ch, i) => {
        o += Number(ch) * Math.pow(60, i) * 1000;
      });
    return o;
  }
}

// import {
//   EShowTransferProgressDisplay,
//   IShowTransferProgressOpt,
//   ShowTransferProgress,
// } from "../../tools/dist/node/ShowTransferProgress";
// const opt: IShowTransferProgressOpt = {
//   title: "T",
//   totalSize: 0,
//   interval: 0,
//   display: [
//     // EShowTransferProgressDisplay.瞬间速度,
//     // EShowTransferProgressDisplay.平均速度,
//     EShowTransferProgressDisplay.进度条,
//     EShowTransferProgressDisplay.预估时间,
//     EShowTransferProgressDisplay.文件名,
//   ],
// };
// const showTransferProgress = new ShowTransferProgress(opt);
// new FFmpeg([
//   "-i",
//   "D:/input.mkv",
//   //   "-c:v",
//   //   "hevc_nvenc",
//   //   "-c:a",
//   //   "copy",
//   //   "-rc",
//   //   "vbr_hq",
//   //   "-crf",
//   //   "18",
//   //   "-tune",
//   //   "uhq",
//   //   "-minrate",
//   //   "414720",
//   //   "-maxrate",
//   //   "414720",
//   //   //   "-hide_banner",
//   //   "-y",
//   //   "D:/t6ttt.mkv",
// ])
//   .on("info", info => {
//     showTransferProgress.opt.totalSize = info.duration;
//     // console.log("info", JSON.stringify(info, null, 2));
//   })
//   .on("progress", (info, txt) => {
//     showTransferProgress.set(FFmpeg.timeToMilliSecond(txt.time));
//     // console.log("progress", txt, info);
//   })
//   .on("end", info => {
//     showTransferProgress.set(info.duration);
//     console.log("结束了", info);
//   });
