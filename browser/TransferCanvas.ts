export type ISendCanvasOptions = {
  /** RGB每个通道的容错率（像素差异容忍度），数字越大图片质量越差，默认：3 */
  errorRate?: number;
  /** 最大帧率（每秒最多捕获的画面数），设置为0时不限制，默认：50 */
  maxFps?: number;
  /** 最大传输网速（字节/秒），设置为0时不限制，默认：500 * 1024 */
  maxSpeed?: number;
  /** 最大传输网速统计周期（多少毫秒内计算网速），默认：3000 */
  // speedStatistical?: number;
};

const workerScript = String((width: number, height: number, opt: ISendCanvasOptions) => {
  // 这里是worker的代码
  const options: Required<ISendCanvasOptions> = {
    errorRate: 3,
    maxFps: 50,
    maxSpeed: 500 * 1024,
    // speedStatistical: 3000,
    ...opt,
  };
  /** 每一帧间隔时间 */
  const intervalPerFps = options.maxFps ? 1000 / options.maxFps : 0;

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const canvasToJpg = new OffscreenCanvas(canvas.width, canvas.height);
  const contextToJpg = canvasToJpg.getContext("2d", { willReadFrequently: true });
  const lastFam = new Uint8Array(canvas.height * canvas.width * 3);
  if (!context || !contextToJpg) throw new Error("未初始化");
  /** 存储数据传输记录，用于计算网速 [时间戳, 数据大小] */
  // const dataList: [number, number][] = [];

  onmessage = function (e) {
    const bitmap = e.data as ImageBitmap;
    if (!bitmap) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close(); // 释放 bitmap 资源
    getImageData();
  };
  const getImageData = async () => {
    const { width, height } = canvas;
    const { errorRate, maxSpeed } = options;
    // if (errorRate === undefined || !maxFps || !maxSpeed || !speedStatistical) return;
    /** 获取当前帧的像素数据 */
    const nowFam = context.getImageData(0, 0, width, height);
    /** 获取图像画布的像素数据，用于生成差异图像 */
    const canvasToJpgImageData = contextToJpg.getImageData(0, 0, width, height);

    /** 标记是否需要发送此帧（如果有像素变化） */
    let needSend = false;
    /** 上一帧数据的索引 */
    let p = 0;
    /** 遍历所有像素，比较当前帧与上一帧的差异 */
    for (let i = 0; i < nowFam.data.length; i += 4) {
      /** 当前像素的红色分量 */
      const r = nowFam.data[i];
      /** 当前像素的绿色分量 */
      const g = nowFam.data[i + 1];
      /** 当前像素的蓝色分量 */
      const b = nowFam.data[i + 2];

      /** 上一帧对应像素的红色分量 */
      const r1 = lastFam[p];
      /** 上一帧对应像素的绿色分量 */
      const g1 = lastFam[p + 1];
      /** 上一帧对应像素的蓝色分量 */
      const b1 = lastFam[p + 2];

      /** 判断像素是否有明显变化（超出容错率） */
      if (Math.abs(r - r1) <= errorRate && Math.abs(b - b1) <= errorRate && Math.abs(g - g1) <= errorRate) {
        // 像素无明显变化，设置为透明
        canvasToJpgImageData.data[i] = 0;
        canvasToJpgImageData.data[i + 1] = 0;
        canvasToJpgImageData.data[i + 2] = 0;
        canvasToJpgImageData.data[i + 3] = 0; // 完全透明
      } else {
        // 像素有明显变化，需要更新
        needSend = true; // 标记需要发送此帧
        lastFam[p] = canvasToJpgImageData.data[i] = r; // 更新红色分量
        lastFam[p + 1] = canvasToJpgImageData.data[i + 1] = g; // 更新绿色分量
        lastFam[p + 2] = canvasToJpgImageData.data[i + 2] = b; // 更新蓝色分量
        canvasToJpgImageData.data[i + 3] = 255; // 完全不透明
      }
      p += 3; // 移动到上一帧数据的下一个像素
    }

    let nextTime = intervalPerFps;
    /** 如果有像素变化，则发送差异帧 */
    if (needSend) {
      // 将差异数据绘制到图像画布
      contextToJpg.putImageData(canvasToJpgImageData, 0, 0);
      /** 将画布转换为WebP格式并压缩 */
      const webp = await new Response(
        (await canvasToJpg.convertToBlob({ quality: 1, type: "image/webp" }))
          .stream()
          .pipeThrough(new CompressionStream("gzip")) // 使用gzip进一步压缩
      ).arrayBuffer();
      /** 记录数据传输信息用于网速控制 */
      // maxSpeed && dataList.unshift([performance.now(), webp.byteLength]);
      if (maxSpeed) nextTime = Math.max(nextTime, (webp.byteLength / maxSpeed) * 1000);
      /** 发送压缩后的图像数据 */
      (postMessage as Worker["postMessage"])(webp, [webp]);
    }
    // const now = performance.now();

    // if (maxSpeed) {
    //   const minTime = now - speedStatistical;
    // const curSpeed =
    //   dataList.reduce((sum, [time, size], i, array) => {
    //     if (time > minTime) return sum + size;
    //     array.length = i;
    //     return sum;
    //   }, 0) /
    //   speedStatistical /
    //   1000;
    // }
    setTimeout(() => (postMessage as Worker["postMessage"])(null, []), nextTime);
  };
  (postMessage as Worker["postMessage"])(null, []);
});
export class SendCanvas {
  public readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  public readonly worker: Worker;
  public onRead(): false | void {}
  public onData(data: ArrayBuffer) {}

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, opt: ISendCanvasOptions = {}) {
    this.canvas = canvas;
    const url = window.URL.createObjectURL(
      new Blob([`(${workerScript})(${canvas.width},${canvas.height},${JSON.stringify(opt)})`])
    );
    this.worker = new Worker(url);
    this.worker.onmessage = ({ data }) => {
      if (!data) {
        this.onRead() !== false && createImageBitmap(canvas).then(bitmap => this.worker.postMessage(bitmap, [bitmap]));
        return;
      }
      this.onData(data);
    };
  }
}

// 测试用例
// const displayMediaOptions = {
//   video: {
//     cursor: "always", // 始终显示光标
//     width: Math.min(screen.width, 1920), // 限制最大宽度为1920
//     height: Math.min(screen.height, 1080), // 限制最大高度为1080
//     // frameRate: 10 // 帧率设置（已注释）
//   },
//   audio: false, // 不捕获音频
// };
// (async () => {
//   /** 创建视频元素用于捕获屏幕内容 */
//   const video = document.createElement("video");
//   video.autoplay = true; // 设置自动播放
//   /** 请求用户选择要共享的屏幕或窗口 */
//   video.srcObject = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
//   /** 获取视频轨道 */
//   const videoTrack = video.srcObject.getVideoTracks()[0];
//   /** 当视频可以播放时开始处理 */
//   video.addEventListener("canplay", async () => {
//     /** 获取视频高度 */
//     const height = video.videoHeight;
//     /** 获取视频宽度 */
//     const width = video.videoWidth;
//     /** 创建离屏画布用于处理视频帧 */
//     const offscreen = new OffscreenCanvas(width, height);
//     const context = offscreen.getContext("2d", { willReadFrequently: true })!;
//     const sendCanvas = new SendCanvas(offscreen);
//     sendCanvas.onRead = () => {
//       if (videoTrack.readyState === "live") {
//         context.drawImage(video, 0, 0, width, height);
//       }
//     };
//     sendCanvas.onData = data => {
//       console.log(data);
//     };
//   });
// })();
