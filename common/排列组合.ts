// const combination1 = <Item, Items extends Array<Item>>(list: Items, n: number) => {
//   const length = list.length;
//   if (n > length) {
//     console.log(list, n);
//     throw new Error("过长");
//   }
//   const result: Set<Item> = new Set();
//   const dfs = () => {
//     if (result.size >= n) {
//       console.log([...result]);
//       return;
//     }
//     for (let i = 0; i < list.length; i++) {
//       const item = list[i];
//       if (!result.has(item)) {
//         result.add(item);
//         dfs();
//         result.delete(item);
//       }
//     }
//   };
//   dfs();
// };

/** 组合（从m个里面取n个） */
const combination = <Item, Items extends Array<Item>>(list: Items, n: number) => {
  const m = list.length;
  if (n > m) {
    console.log(list, n);
    throw new Error("过长");
  }

  return (function* (): Generator<Item[], void, void> {
    // console.time("time");
    const sp = Array(n)
      .fill(0)
      .map((_, i) => i);
    /** 数组末位 */
    const end = n - 1;
    /** 最大值的起点，需要加上偏移值才是最大值 */
    const max = m - n - 1;
    /** 指针 */
    let p = end;
    // debugger;
    while (1) {
      yield sp.map(i => list[i]);
      //out.push([...sp]);
      /** 如果超过最大值，指针向前进位 */
      while (sp[p] > max + p) {
        if (--p < 0) {
          // console.log(out.length);
          // console.timeEnd("time");
          return;
        }
      }
      sp[p]++;

      /** 这个位置后面的数字依次相加 */
      while (p < end) {
        sp[p + 1] = sp[p] + 1;
        p++;
      }
      /** 指针回到末位 */
      p = end;
    }
  })();
};

/** 测试用例 */
console.log("组合测试用例");
for (const arr of combination(
  Array(6)
    .fill(0)
    .map((_, i) => i + 1),
  4
)) {
  console.log(arr);
}
