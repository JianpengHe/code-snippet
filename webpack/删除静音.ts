import * as fs from "fs";

// --- 配置 ---
const inputFileName = "output.pcm";
const outputFileName = "output_no_silence.pcm"; // 输出文件
const amplitudeThreshold = 3; // 静音判定阈值
const SAMPLES_TO_TOGGLE = 24; // 连续多少帧触发切换（静音/非静音）

// --- 状态变量 ---
let isWritingEnabled = true; // true = 输出声音，false = 静音丢弃
let triggerBuffer = []; // 缓存可能触发状态切换的样本

// --- 文件流 ---
const readStream = fs.createReadStream(inputFileName);
const writeStream = fs.createWriteStream(outputFileName);

// 用于跨 chunk 处理不完整的采样帧
let carryOverBuffer = Buffer.alloc(0);

console.log(`开始处理文件，小端 16bit PCM，静音阈值: ${amplitudeThreshold}`);

// 数据处理
readStream.on("data", chunk => {
  // 拼接上次剩余字节
  const combinedBuffer = Buffer.concat([carryOverBuffer, chunk]);
  // 只处理偶数字节（16bit 对齐）
  const processableLength = Math.floor(combinedBuffer.length / 2) * 2;
  const processableBuffer = combinedBuffer.slice(0, processableLength);
  carryOverBuffer = combinedBuffer.slice(processableLength);

  // 小端 16bit 转为 Int16Array
  const samples = new Int16Array(processableBuffer.buffer, processableBuffer.byteOffset, processableBuffer.length / 2);

  const samplesToWrite = [];

  for (const sample of samples) {
    const isSilent = Math.abs(sample) < amplitudeThreshold; // 静音判定

    if (isSilent) {
      // 记录静音样本
      triggerBuffer.push(sample);

      if (triggerBuffer.length >= SAMPLES_TO_TOGGLE) {
        // 连续静音 5 帧 → 关闭写入（丢弃静音）
        isWritingEnabled = false;
        triggerBuffer = []; // 静音样本直接丢弃
      }
    } else {
      // 当前是有声音
      if (triggerBuffer.length > 0) {
        // 如果之前有静音缓存但未满 5 帧
        if (isWritingEnabled) {
          samplesToWrite.push(...triggerBuffer);
        }
        triggerBuffer = [];
      }

      // 确保开启写入
      if (!isWritingEnabled) {
        isWritingEnabled = true;
      }

      if (isWritingEnabled) {
        samplesToWrite.push(sample);
      }
    }
  }

  if (samplesToWrite.length > 0) {
    const outputData = new Int16Array(samplesToWrite);
    writeStream.write(Buffer.from(outputData.buffer, outputData.byteOffset, outputData.byteLength));
  }
});

readStream.on("end", () => {
  // 文件结束时，如果有未写入的静音缓存且在写入状态，就补写
  if (triggerBuffer.length > 0 && isWritingEnabled) {
    console.log(`文件末尾，写入遗留的 ${triggerBuffer.length} 个样本。`);
    const outputData = new Int16Array(triggerBuffer);
    writeStream.write(Buffer.from(outputData.buffer, outputData.byteOffset, outputData.byteLength));
  }

  writeStream.end();
  console.log(`文件处理完成！输出文件: ${outputFileName}`);
});

readStream.on("error", err => console.error("读取错误:", err));
writeStream.on("error", err => console.error("写入错误:", err));
