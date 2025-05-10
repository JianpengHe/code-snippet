export type ISendCanvasOptions = {
  /** RGB每个通道的容错率（像素差异容忍度），数字越大图片质量越差，默认：3 */
  errorRate?: number;
  /** 最大帧率（每秒最多捕获的画面数），设置为0时不限制，默认：50 */
  maxFps?: number;
  /** 最大传输网速（字节/秒），设置为0时不限制，默认：500 * 1024 */
  maxSpeed?: number;
  /** 最大传输网速统计周期（多少毫秒内计算网速），默认：3000 */
  // speedStatisticalPeriod?: number;
};

const workerScript = String((canvasWidth: number, canvasHeight: number, opt: ISendCanvasOptions) => {
  // 这里是worker的代码（Worker线程中执行的脚本）
  const configOptions: Required<ISendCanvasOptions> = {
    errorRate: 3, // 默认容错率为3
    maxFps: 50,   // 默认最大帧率为50fps
    maxSpeed: 500 * 1024, // 默认最大传输速度为500KB/s
    // speedStatisticalPeriod: 3000, // 默认网速统计周期为3秒
    ...opt, // 合并用户传入的配置选项
  };
  /** 根据帧率计算的每帧间隔时间（毫秒） */
  const frameInterval = configOptions.maxFps ? 1000 / configOptions.maxFps : 0;

  /** 创建用于处理图像的离屏画布 */
  const offscreenCanvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const canvasContext = offscreenCanvas.getContext("2d", { willReadFrequently: true });
  /** 创建用于生成差异图像的离屏画布 */
  const diffCanvas = new OffscreenCanvas(offscreenCanvas.width, offscreenCanvas.height);
  const diffContext = diffCanvas.getContext("2d", { willReadFrequently: true });
  /** 存储上一帧的像素数据，用于比较差异 */
  const previousFrameData = new Uint8Array(offscreenCanvas.height * offscreenCanvas.width * 3);
  if (!canvasContext || !diffContext) throw new Error("画布上下文初始化失败");
  /** 存储数据传输记录，用于计算网速 [时间戳, 数据大小] */
  // const transferDataList: [number, number][] = [];

  /** 接收主线程发送的图像位图数据 */
  onmessage = function (e) {
    const imageBitmap = e.data as ImageBitmap;
    if (!imageBitmap) return; // 如果没有收到有效数据则直接返回
    canvasContext.drawImage(imageBitmap, 0, 0, offscreenCanvas.width, offscreenCanvas.height); // 将位图绘制到画布上
    imageBitmap.close(); // 释放位图资源以避免内存泄漏
    processImageData(); // 处理图像数据
  };
  /** 处理画布图像数据，计算差异并发送 */
  const processImageData = async () => {
    const { width, height } = offscreenCanvas;
    const { errorRate, maxSpeed } = configOptions;
    // if (errorRate === undefined || !maxFps || !maxSpeed || !speedStatisticalPeriod) return;
    /** 获取当前帧的像素数据 */
    const currentFrameData = canvasContext.getImageData(0, 0, width, height);
    /** 获取差异画布的像素数据，用于生成差异图像 */
    const diffImageData = diffContext.getImageData(0, 0, width, height);

    /** 标记是否需要发送此帧（如果有像素变化） */
    let hasPixelChanges = false;
    /** 上一帧数据的索引（RGB格式，没有Alpha通道） */
    let prevDataIndex = 0;
    /** 遍历所有像素，比较当前帧与上一帧的差异 */
    for (let pixelIndex = 0; pixelIndex < currentFrameData.data.length; pixelIndex += 4) {
      /** 当前像素的RGB分量 */
      const currentRed = currentFrameData.data[pixelIndex];
      const currentGreen = currentFrameData.data[pixelIndex + 1];
      const currentBlue = currentFrameData.data[pixelIndex + 2];

      /** 上一帧对应像素的RGB分量 */
      const prevRed = previousFrameData[prevDataIndex];
      const prevGreen = previousFrameData[prevDataIndex + 1];
      const prevBlue = previousFrameData[prevDataIndex + 2];

      /** 判断像素是否有明显变化（超出容错率） */
      const redDiff = Math.abs(currentRed - prevRed);
      const greenDiff = Math.abs(currentGreen - prevGreen);
      const blueDiff = Math.abs(currentBlue - prevBlue);
      
      if (redDiff <= errorRate && blueDiff <= errorRate && greenDiff <= errorRate) {
        // 像素无明显变化，设置为透明（不需要传输）
        diffImageData.data[pixelIndex] = 0;
        diffImageData.data[pixelIndex + 1] = 0;
        diffImageData.data[pixelIndex + 2] = 0;
        diffImageData.data[pixelIndex + 3] = 0; // 完全透明
      } else {
        // 像素有明显变化，需要更新
        hasPixelChanges = true; // 标记需要发送此帧
        // 更新差异图像和上一帧数据
        previousFrameData[prevDataIndex] = diffImageData.data[pixelIndex] = currentRed; // 更新红色分量
        previousFrameData[prevDataIndex + 1] = diffImageData.data[pixelIndex + 1] = currentGreen; // 更新绿色分量
        previousFrameData[prevDataIndex + 2] = diffImageData.data[pixelIndex + 2] = currentBlue; // 更新蓝色分量
        diffImageData.data[pixelIndex + 3] = 255; // 完全不透明
      }
      prevDataIndex += 3; // 移动到上一帧数据的下一个像素（RGB格式，没有Alpha通道）
    }

    /** 计算下一帧的延迟时间（基于帧率或网速限制） */
    let nextFrameDelay = frameInterval;
    /** 如果有像素变化，则发送差异帧 */
    if (hasPixelChanges) {
      // 将差异数据绘制到差异画布
      diffContext.putImageData(diffImageData, 0, 0);
      /** 将差异画布转换为WebP格式并使用gzip压缩（提高传输效率） */
      const compressedImageData = await new Response(
        (await diffCanvas.convertToBlob({ quality: 1, type: "image/webp" }))
          .stream()
          .pipeThrough(new CompressionStream("gzip")) // 使用gzip进一步压缩
      ).arrayBuffer();
      
      /** 记录数据传输信息用于网速控制 */
      // maxSpeed && transferDataList.unshift([performance.now(), compressedImageData.byteLength]);
      
      /** 根据网速限制调整下一帧延迟（防止网络拥塞） */
      if (maxSpeed) {
        // 计算传输当前数据需要的时间（毫秒）
        const transferTime = (compressedImageData.byteLength / maxSpeed) * 1000;
        // 取较大值作为下一帧延迟，确保不超过网速限制
        nextFrameDelay = Math.max(nextFrameDelay, transferTime);
      }
      
      /** 发送压缩后的图像数据（使用可转移对象优化性能） */
      (postMessage as Worker["postMessage"])(compressedImageData, [compressedImageData]);
    }
    
    // 网速统计相关代码（已注释）
    // const now = performance.now();
    // if (maxSpeed) {
    //   const minTime = now - speedStatisticalPeriod;
    //   const currentSpeed =
    //     transferDataList.reduce((sum, [time, size], i, array) => {
    //       if (time > minTime) return sum + size;
    //       array.length = i;
    //       return sum;
    //     }, 0) /
    //     speedStatisticalPeriod /
    //     1000;
    // }
    
    /** 安排下一次图像处理（通知主线程可以发送新帧） */
    setTimeout(() => (postMessage as Worker["postMessage"])(null, []), nextFrameDelay);
  };
  (postMessage as Worker["postMessage"])(null, []);
});
/**
 * 画布传输类 - 用于高效传输画布内容
 * 通过Web Worker和差异压缩算法实现高性能画布内容传输
 */
export class SendCanvas {
  /** 源画布（可以是普通画布或离屏画布） */
  public readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Web Worker实例，用于在后台线程处理图像 */
  public readonly worker: Worker;
  /** 当需要读取新帧时调用，返回false可阻止读取 */
  public onRead(): false | void {}
  /** 当有新的差异帧数据时调用 */
  public onData(data: ArrayBuffer) {}
  /** Worker脚本的对象URL */
  private readonly objectURL: string;
  
  /**
   * 创建画布传输实例
   * @param canvas 源画布
   * @param opt 传输选项配置
   */
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, opt: ISendCanvasOptions = {}) {
    this.canvas = canvas;
    // 创建包含Worker脚本的Blob对象URL
    this.objectURL = window.URL.createObjectURL(
      new Blob([`(${workerScript})(${canvas.width},${canvas.height},${JSON.stringify(opt)})`])
    );
    // 创建Worker实例
    this.worker = new Worker(this.objectURL);
    // 处理Worker消息
    this.worker.onmessage = ({ data }) => {
      if (!data) {
        // 如果没有数据，表示Worker请求新帧
        // 调用onRead回调，如果不返回false则创建位图并发送给Worker
        this.onRead() !== false && createImageBitmap(canvas).then(bitmap => this.worker.postMessage(bitmap, [bitmap]));
        return;
      }
      // 有数据时调用onData回调处理差异帧数据
      this.onData(data);
    };
  }
  
  /**
   * 销毁实例，释放资源
   */
  public destroy() {
    this.worker.terminate(); // 终止Worker
    window.URL.revokeObjectURL(this.objectURL); // 释放Blob URL
  }
}

// 测试用例 - 屏幕共享示例
// const screenShareOptions = {
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
//   const videoElement = document.createElement("video");
//   videoElement.autoplay = true; // 设置自动播放
//   
//   /** 请求用户选择要共享的屏幕或窗口 */
//   videoElement.srcObject = await navigator.mediaDevices.getDisplayMedia(screenShareOptions);
//   
//   /** 获取视频轨道 */
//   const videoTrack = videoElement.srcObject.getVideoTracks()[0];
//   
//   /** 当视频可以播放时开始处理 */
//   videoElement.addEventListener("canplay", async () => {
//     /** 获取视频尺寸 */
//     const videoHeight = videoElement.videoHeight;
//     const videoWidth = videoElement.videoWidth;
//     
//     /** 创建离屏画布用于处理视频帧 */
//     const offscreenCanvas = new OffscreenCanvas(videoWidth, videoHeight);
//     const canvasContext = offscreenCanvas.getContext("2d", { willReadFrequently: true })!;
//     
//     /** 创建画布传输实例 */
//     const canvasTransfer = new SendCanvas(offscreenCanvas);
//     
//     /** 当需要读取新帧时，将视频内容绘制到画布 */
//     canvasTransfer.onRead = () => {
//       if (videoTrack.readyState === "live") {
//         canvasContext.drawImage(videoElement, 0, 0, videoWidth, videoHeight);
//       }
//     };
//     
//     /** 处理传输的差异帧数据 */
//     canvasTransfer.onData = compressedData => {
//       console.log(compressedData); // 这里可以将数据发送到服务器或其他客户端
//     };
//   });
// })();
