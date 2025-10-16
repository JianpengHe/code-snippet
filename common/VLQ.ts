/**
 * @file VLQ (Variable-length quantity) Big-Endian Encoder and Decoder
 * @description 这是一种使用可变长度数量对数字进行编码的实现，采用大端序（Big-Endian）。
 * 编码的第一个字节包含了长度信息。
 */

/**
 * 将一个非负整数编码为 VLQ (大端序) 格式的字节数组。
 *
 * VLQ 编码规则：
 * - 编码结果的第一个字节是一个前缀，用于指示整个编码占用的总字节数。
 * - 前缀的格式是 `1` 后面跟着 `n` 个 `0`，其中 `n` 是后续负载字节的数量 (n = 总字节数 - 1)。
 * - 例如：
 * - 1 字节: `1xxxxxxx` (n=0, 前缀为 `1`)
 * - 2 字节: `01xxxxxx` (n=1, 前缀为 `01`)
 * - 3 字节: `001xxxxx` (n=2, 前缀为 `001`)
 * - ...
 * - 8 字节: `00000001` (n=7, 前缀为 `00000001`)
 *
 * @param valueToEncode 要编码的非负整数。必须在 [0, Number.MAX_SAFE_INTEGER] 范围内。
 * @returns 返回一个 Uint8Array，其中包含编码后的字节序列。
 */
export function encodeVLQ_BE(valueToEncode: number): Uint8Array {
  // 校验输入数字是否在安全整数范围内
  if (!Number.isSafeInteger(valueToEncode))
    throw new RangeError("输入数字超出了安全整数范围 [0, Number.MAX_SAFE_INTEGER]");

  // 性能优化：最常见的情况是单字节编码（值 < 128）
  if (valueToEncode >= 0 && valueToEncode < 128) {
    // 1字节编码，前缀是 `1` (二进制 `10000000`)
    return Uint8Array.of(0b10000000 | valueToEncode);
  }

  // 计算表示该数字至少需要多少个比特位
  const significantBitCount = valueToEncode < 0 ? 54 : Math.floor(Math.log2(valueToEncode)) + 1;
  // 根据有效比特位数，计算编码后需要占用的总字节数
  const encodedByteLength = Math.ceil(significantBitCount / 7);
  // 计算后续负载字节的数量 (continuation bytes)
  const continuationByteCount = encodedByteLength - 1;
  // 计算第一个字节中的长度前缀。例如，如果总长度为3字节，则后续有2个字节，前缀为 001xxxxx
  const lengthPrefix = 1 << (7 - continuationByteCount);
  // 计算第一个字节中用于存储数据负载的掩码
  const firstBytePayloadMask = (1 << (8 - encodedByteLength)) - 1;
  switch (encodedByteLength) {
    case 2: {
      // 2 字节编码 (值范围: 128 to 16383)
      return Uint8Array.of(
        lengthPrefix | ((valueToEncode >>> 8) & firstBytePayloadMask), // 第 1 字节：前缀 + 高位数据
        valueToEncode & 0xff // 第 2 字节：低 8 位数据
      );
    }
    case 3: {
      // 3 字节编码
      return Uint8Array.of(
        lengthPrefix | ((valueToEncode >>> 16) & firstBytePayloadMask), // 第 1 字节
        (valueToEncode >>> 8) & 0xff, // 第 2 字节
        valueToEncode & 0xff // 第 3 字节
      );
    }
    case 4: {
      // 4 字节编码
      return Uint8Array.of(
        lengthPrefix | ((valueToEncode >>> 24) & firstBytePayloadMask), // 第 1 字节
        (valueToEncode >>> 16) & 0xff, // 第 2 字节
        (valueToEncode >>> 8) & 0xff, // 第 3 字节
        valueToEncode & 0xff // 第 4 字节
      );
    }
    // 当数字超过 32 位时，JavaScript 会使用浮点数表示，需要特殊处理
    case 5: {
      const high32Bits = Math.floor(valueToEncode / 4294967296);
      const low32Bits = valueToEncode >>> 0;
      return Uint8Array.of(
        (lengthPrefix | ((high32Bits >>> 8) & firstBytePayloadMask)) + (high32Bits & 0xff),
        (low32Bits >>> 24) & 0xff,
        (low32Bits >>> 16) & 0xff,
        (low32Bits >>> 8) & 0xff,
        low32Bits & 0xff
      );
    }
    case 6: {
      const high32Bits = Math.floor(valueToEncode / 4294967296);
      const low32Bits = valueToEncode >>> 0;
      return Uint8Array.of(
        (lengthPrefix | ((high32Bits >>> 16) & firstBytePayloadMask)) + ((high32Bits >>> 8) & 0xff),
        high32Bits & 0xff,
        (low32Bits >>> 24) & 0xff,
        (low32Bits >>> 16) & 0xff,
        (low32Bits >>> 8) & 0xff,
        low32Bits & 0xff
      );
    }
    case 7: {
      const high32Bits = Math.floor(valueToEncode / 4294967296);
      const low32Bits = valueToEncode >>> 0;
      return Uint8Array.of(
        (lengthPrefix | ((high32Bits >>> 24) & firstBytePayloadMask)) + ((high32Bits >>> 16) & 0xff),
        (high32Bits >>> 8) & 0xff,
        high32Bits & 0xff,
        (low32Bits >>> 24) & 0xff,
        (low32Bits >>> 16) & 0xff,
        (low32Bits >>> 8) & 0xff,
        low32Bits & 0xff
      );
    }
    case 8: {
      /** 是否是负数 */
      const isNegative = valueToEncode < 0 ? 128 : 0;
      valueToEncode = isNegative ? -valueToEncode : valueToEncode;
      const high32Bits = Math.floor(valueToEncode / 4294967296);
      const low32Bits = valueToEncode >>> 0;
      return Uint8Array.of(
        lengthPrefix + ((high32Bits >>> 24) & 0xff),
        ((high32Bits >>> 16) & 0xff) + isNegative,
        (high32Bits >>> 8) & 0xff,
        high32Bits & 0xff,
        (low32Bits >>> 24) & 0xff,
        (low32Bits >>> 16) & 0xff,
        (low32Bits >>> 8) & 0xff,
        low32Bits & 0xff
      );
    }
  }

  throw new Error("输入数字超出了可编码的范围");
}

/**
 * 从 VLQ 编码的第一个字节中解析出数据负载和总字节长度。
 *
 * @param firstByte VLQ 编码序列的第一个字节。
 * @returns 返回一个对象，包含 { value: number, length: number }
 * - `value`: 第一个字节中包含的数据负载部分。
 * - `length`: 整个 VLQ 编码序列的总字节数。
 */
export function decodeVLQ_BE_Obj(firstByte: number): { value: number; length: number } {
  if (firstByte === 0) throw new Error("无效的 VLQ 前导字节 (0)");

  // `Math.clz32` 计算前导零的数量。通过这个技巧可以快速确定总字节长度。
  // 例如: `1xxxxxxx` (1字节) -> clz32=24, length=1
  //       `01xxxxxx` (2字节) -> clz32=25, length=2
  const encodedByteLength = Math.clz32(firstByte) - 24 + 1;
  // 创建一个掩码，用于提取第一个字节中的数据负载
  const payloadMask = (1 << (8 - encodedByteLength)) - 1;

  return { value: firstByte & payloadMask, length: encodedByteLength };
}

/**
 * 将从第一个字节解析出的数据负载与后续字节组合，重构出原始数字。
 *
 * @param firstBytePayload 从第一个字节中解析出的数据负载。
 * @param buffer 包含 VLQ 序列中后续字节的缓冲区。
 * @param totalByteLength 整个 VLQ 序列的总长度。
 * @param offset 后续字节在缓冲区中的起始偏移量。
 * @returns 重构后的原始数字。
 */
export function decodeVLQ_BE_ObjNum(
  firstBytePayload: number,
  buffer: Uint8Array,
  totalByteLength = buffer.length + 1,
  offset = 0
): number {
  // 注意：调用方需确保 buffer 从 offset 起有 (totalByteLength - 1) 个字节可读
  switch (totalByteLength) {
    case 1:
      return firstBytePayload;
    case 2:
      return (firstBytePayload << 8) | buffer[offset];
    case 3:
      return (firstBytePayload << 16) | (buffer[offset] << 8) | buffer[offset + 1];
    case 4:
      // 使用 `>>> 0` 将结果转换为无符号32位整数，防止符号位扩展导致负数
      return ((firstBytePayload << 24) >>> 0) + (buffer[offset] << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2];
    // 处理超过 32 位的数字
    case 5: {
      const high32Bits = firstBytePayload;
      const low32Bits =
        buffer[offset] * 0x1000000 + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3];
      return high32Bits * 0x100000000 + low32Bits;
    }
    case 6: {
      const high32Bits = (firstBytePayload << 8) | buffer[offset];
      const low32Bits =
        buffer[offset + 1] * 0x1000000 + (buffer[offset + 2] << 16) + (buffer[offset + 3] << 8) + buffer[offset + 4];
      return high32Bits * 0x100000000 + low32Bits;
    }
    case 7: {
      const high32Bits = (firstBytePayload << 16) | (buffer[offset] << 8) | buffer[offset + 1];
      const low32Bits =
        buffer[offset + 2] * 0x1000000 + (buffer[offset + 3] << 16) + (buffer[offset + 4] << 8) + buffer[offset + 5];
      return high32Bits * 0x100000000 + low32Bits;
    }
    case 8: {
      /** 是否是负数 */
      const isNegative = buffer[offset] >= 128;
      const high32Bits =
        firstBytePayload * 0x1000000 +
        ((isNegative ? buffer[offset] - 128 : buffer[offset]) << 16) +
        (buffer[offset + 1] << 8) +
        buffer[offset + 2];
      const low32Bits =
        buffer[offset + 3] * 0x1000000 + (buffer[offset + 4] << 16) + (buffer[offset + 5] << 8) + buffer[offset + 6];
      return (isNegative ? -1 : 1) * (high32Bits * 0x100000000 + low32Bits);
    }
  }
  throw new Error("解码长度超出范围 [1, 8]");
}

/**
 * 从字节缓冲区中解码一个 VLQ (大端序) 编码的数字。
 *
 * @param buffer 包含 VLQ 编码数据的 Uint8Array。
 * @param bufferInfo 一个包含 { offset: number } 的对象，用于跟踪和更新在缓冲区中的读取位置。
 * 函数会修改此对象的 `offset` 属性。
 * @returns 解码后的数字。
 */
export function decodeVLQ_BE(buffer: Uint8Array, bufferInfo: { offset: number } = { offset: 0 }): number {
  const initialOffset = bufferInfo.offset;
  if (initialOffset >= buffer.length) {
    throw new RangeError("缓冲区偏移量超出了范围");
  }

  const firstByte = buffer[initialOffset];
  // 从第一个字节解析出数据负载和总长度
  const { value: firstBytePayload, length: encodedByteLength } = decodeVLQ_BE_Obj(firstByte);

  // 校验缓冲区剩余长度是否足够进行解码
  if (initialOffset + encodedByteLength > buffer.length) {
    throw new RangeError("根据前缀声明的长度，缓冲区数据不足");
  }

  // 计算后续字节的起始偏移量
  const continuationBytesOffset = initialOffset + 1;
  // 组合第一个字节的负载和后续字节，重构出原始数字
  const decodedValue = decodeVLQ_BE_ObjNum(firstBytePayload, buffer, encodedByteLength, continuationBytesOffset);

  // 更新偏移量，前进 `encodedByteLength` 个字节
  bufferInfo.offset = initialOffset + encodedByteLength;
  return decodedValue;
}

/** 测试用例 */
// function runTest() {
//   let iterations = 1000000;
//   let num = 1;
//   let factor = 2;
//   console.time("VLQ 编解码测试耗时");
//   try {
//     while (iterations--) {
//       const encoded = encodeVLQ_BE(num);
//       const decoded = decodeVLQ_BE(encoded);
//       if (num !== decoded) {
//         console.error(`测试失败! 原始值: ${num}, 编码后: ${encoded}, 解码后: ${decoded}`);
//         throw new Error(`不匹配: ${num}`);
//       }

//       num = Math.ceil(num * factor);

//       if (num > Number.MAX_SAFE_INTEGER) {
//         console.log("达到最大安全整数，重置测试值。");
//         factor = Math.random() + 1.1; // 使用新的随机因子
//         num = 1;
//       }
//     }
//     console.log("所有测试用例通过！");
//   } catch (e) {
//     console.log(`在值为 ${num} 时发生错误`);
//     console.error(e);
//   }
//   console.timeEnd("VLQ 编解码测试耗时");
// }

// runTest();
