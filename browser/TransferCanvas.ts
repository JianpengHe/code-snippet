type IToWorkerData =
  | ({
      type: "init";
      offScreenCanvas: OffscreenCanvas;
    } & ISendCanvasOptions)
  | {
      type: "getImageData";
    };

export type ISendCanvasOptions = {
  /** RGB每个通道的容错率（像素差异容忍度），默认：3 */
  errorRate?: number;
  /** 最大帧率（每秒最多捕获的画面数），默认：50 */
  maxFps?: number;
  /** 最大传输网速（字节/秒）:，默认：500 * 1024 */
  maxSpeed?: number;
  /** 最大传输网速统计周期（多少毫秒内计算网速），默认：3000 */
  speedStatistical?: number;
};

const workerScript =
  "(" +
  String(() => {
    // 这里是worker的代码
    let opt: ISendCanvasOptions = {};
    let context: OffscreenCanvasRenderingContext2D | null = null;
    let canvas: OffscreenCanvas | null = null;
    let canvasToJpg: OffscreenCanvas | null = null;
    let contextToJpg: OffscreenCanvasRenderingContext2D | null = null;
    let lastFam: Uint8Array | null = null;
    let lastTime = 0;
    //   /** 当前时间戳 */
    //   let nowTime = performance.now();
    /** 存储数据传输记录，用于计算网速 [时间戳, 数据大小] */
    const dataList: [number, number][] = [];

    onmessage = function (e) {
      const data = e.data as IToWorkerData;
      switch (data.type) {
        case "init":
          canvas = data.offScreenCanvas;
          context = canvas.getContext("2d", { willReadFrequently: true });
          canvasToJpg = new OffscreenCanvas(canvas.width, canvas.height);
          /** 获取图像画布的2D上下文 */
          contextToJpg = canvasToJpg.getContext("2d", { willReadFrequently: true });

          lastFam = new Uint8Array(canvas.height * canvas.width * 3);

          opt.errorRate = data.errorRate ?? 3;
          opt.maxFps = data.maxFps ?? 50;
          opt.maxSpeed = data.maxSpeed ?? 500 * 1024;
          opt.speedStatistical = data.speedStatistical ?? 3000;
          postMessage({ type: "canGetImageData" });
          break;
        case "getImageData":
          getImageData();
          //  postMessage({ type: "imageData", imageData }, [imageData.data.buffer]);
          break;
      }
    };
    const getImageData = async () => {
      if (!context || !canvas || !contextToJpg || !canvasToJpg || !lastFam) throw new Error("未初始化");
      const { width, height } = canvas;
      const { errorRate, maxFps, maxSpeed, speedStatistical } = opt;
      if (errorRate === undefined || !maxFps || !maxSpeed || !speedStatistical) return;
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
      // framesPerSec++; // 增加帧率计数
      // console.log(webp.byteLength); // 输出数据大小（已注释）
      /** 如果有像素变化，则发送差异帧 */
      if (needSend) {
        // 将差异数据绘制到图像画布
        contextToJpg.putImageData(canvasToJpgImageData, 0, 0);
        /** 将画布转换为WebP格式并压缩 */
        const webp = await new Response(
          (
            await canvasToJpg.convertToBlob({
              quality: 1, // 使用最低质量以减小文件大小
              type: "image/webp", // 使用WebP格式
            })
          )
            .stream()
            .pipeThrough(new CompressionStream("gzip")) // 使用gzip进一步压缩
        ).arrayBuffer();
        /** 记录数据传输信息用于网速控制 */
        // dataList.unshift([performance.now(), webp.byteLength]);
        /** 发送压缩后的图像数据 */
        (postMessage as Worker["postMessage"])({ type: "data", data: webp }, [webp]);
        //  webSocket.send(webp);
      }
    };
  }) +
  ")();";

export class SendCanvas {
  public readonly offScreenCanvas: OffscreenCanvas;
  public readonly worker: Worker;
  private isInit = false;
  public onRead(): false | void {}
  public onData(data: ArrayBuffer) {}
  constructor(offScreenCanvas: OffscreenCanvas, options: ISendCanvasOptions = {}) {
    this.offScreenCanvas = offScreenCanvas;
    const url = window.URL.createObjectURL(new Blob([workerScript]));
    this.worker = new Worker(url);
    this.postMessageToWorker({ type: "init", offScreenCanvas, ...options }, [offScreenCanvas]);
    this.worker.onmessage = e => {
      const data = e.data as any;
      switch (data.type) {
        case "canGetImageData":
          this.isInit = true;
          this.onRead() !== false && this.postMessageToWorker({ type: "getImageData" });
          break;
        case "data":
          this.onData(data.data);
          break;
      }
    };
  }
  private postMessageToWorker(data: IToWorkerData, transfer: Transferable[] = []) {
    return this.worker.postMessage(data, transfer);
  }
}
