export function find<E, T extends Array<E> | Buffer>(
  arr1: T,
  arr2: T,
  maxTimes = Infinity,
  judge: (value1: T[0], value2: T[0]) => boolean = (a, b) => a === b
) {
  const maxIndex = Math.min(arr1.length, arr2.length);
  let output: null | { main: T; child: T; index: number } = null;
  const indexOf = (arrA: T, arrB: T, index: number) => {
    /** 判断arrB在不在arrA里面 */
    const end = Math.min(maxIndex, arrB.length, maxTimes);
    for (let j = 0; j < end; j++) {
      if (!judge(arrA[index + j], arrB[j])) return;
    }
    output = { main: arrA, child: arrB, index };
    return;
  };

  for (let i = 0; i < maxIndex; i++) {
    /** 判断arr1在不在arr2里面 */
    indexOf(arr1, arr2, i);
    if (output) return output;
    /** 判断arr2在不在arr1里面 */
    indexOf(arr2, arr1, i);
    if (output) return output;
  }
  return null;
}

// 测试用例
// console.log(find([1, 2, 3, 4], [3, 4, 5], 2));

// console.log(find(Buffer.from([0xff, 0xfe, 0x82]), Buffer.from([0x70, 0x60, 0xff, 0xfe, 0x67]), 2));
// console.log(
//   find(Buffer.from([0xff, 0xfe, 0x82]), Buffer.from([0x70, 0x60, 0xff - 3, 0xfe + 4, 0x67]), 2, (a, b) => {
//     const diff = Math.abs(a - b);
//     return diff < 5 || diff > 250;
//   })
// );
