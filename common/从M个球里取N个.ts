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

/** 全排列 */
const permutation = <Item, Items extends Array<Item>>(list: Items) =>
  (function* (): Generator<Item[], void, void> {
    const nums = Array(list.length)
      .fill(0)
      .map((_, i) => i);
    //交换两个元素
    const swap = (index: number, j: number) => {
      // [nums[index],nums[j]]=[nums[j],nums[index]]
      const temp = nums[index];
      nums[index] = nums[j];
      nums[j] = temp;
    };
    let index = 0; //交换点下标
    let swapNums = 0;
    // const out: Item[][] = [];
    while (1) {
      yield nums.map(i => list[i]);
      //  out.push(nums);
      for (let i = nums.length - 2; i >= 0; i--) {
        if (nums[i] < nums[i + 1]) {
          index = i;
          break;
        }
        if (i == 0) return; //没有找到需要交换的点，即交换全部完成，退出循环
      }

      for (let j = nums.length - 1; j >= 0; j--) {
        if (nums[index] < nums[j]) {
          swapNums = j;
          break;
        }
      }

      swap(index, swapNums);

      //将 index 后的数正序排序，这样就使得这种排序是当前情况下最小的
      let j = nums.length - 1;
      let i = index + 1;
      while (i < j) {
        swap(i, j);
        i++;
        j--;
      }
    }
    return;
  })();

// const combination1 = (() => {
//   console.time("time");
//   var out = [];
//   var m = 6;
//   var n = 4;
//   var sp = Array(n)
//     .fill(0)
//     .map((_, i) => i);

//   var max = m - n;
//   var end = n - 1;
//   var p = end;
//   // debugger;

//   while (1) {
//     out.push([...sp]);
//     /** 如果超过最大值，指针向前进位 */
//     while (sp[p] >= max + p) {
//       if (--p < 0) {
//         console.log(out.length);
//         console.timeEnd("time");
//         return;
//       }
//     }
//     sp[p]++;

//     /** 这个位置后面的数字依次相加 */
//     while (p < end) {
//       sp[p + 1] = sp[p] + 1;
//       p++;
//     }
//     /** 指针回到末位 */
//     p = end;
//   }
// })();
// console.log([...permutation(["t", "6", "g", "5", 5, 6, 7, 8 /**/])]);

// Usage
//   const items = [1, 2, 3, 4];
//   combination(items, 2);

// combination1([1, 2, 3 /*, 4 5, 6, 7, 8*/], 2);

// const t = permutation([1, 2, 3, 4 /* 5, 6, 7, 8*/]);
// for (const value of t) {
//   /** 强制退出 */
//   if (value[0] === 4) {
//     t.return();
//   }
//   console.log(value);
// }
// while (1) {
//   const { value, done } = t.next();
//   if (done) break;

// }

// const t = function* () {
//   for (let index = 0; index < 5; index++) {
//     if (yield index) {
//       return;
//     }
//   }
// };

// const ttt = t();
// let v: any;

// let i = 0;
// let value: number[], done: boolean | undefined;
// while ((({ value, done } = t.next()), !done)) {
//   console.log(value);
//   if (i++ >= 3) {
//     t.return();
//   }
// }

// for (let p = length - 1, i = p - 1; i >= length - n; i--) {
//   console.log("1", i, p);
//   while (p <= length - 1 && p > i) {
//     console.log(i, p);
//     p--;
//   }
//   p = length - 1;
// }
// var i = length - n - 1,
//   p = i + 1;
// // while (i <= length - n) {
// //   console.log("---");
// //   while (p <= length - 1) {
// //     console.log(i, p);
// //     p++;
// //   }

// //   i++;
// //   p = i + 1;
// // }
// let j = n - 2;
// p = j + 1;
// //console.log(j, p);
// while (j >= 0) {
//   while (p <= length - 1) {
//     console.log(j, p);
//     p++;
//   }
//   j--;
//   p = j + 1;
// }
/**
 * 0 1 2 i=1 p=2
 * 0 1 3 i=1 p=3
 * 0 1 4 i=1 p=4
 * 0 2 3 i=2 p=i+1=3
 * 0 2 4
 * 1 2 3
 * 1 2 4
 *
 **/
// (() => {
//   console.time("time");
//   var out = [];
//   var m = 30;
//   var arr = Array(m)
//       .fill(0)
//       .map((_, i) => i),
//     n = 10,
//     sp = arr.slice(0, n);
//   var p = n - 1;
//   var max = m - n;
//   // debugger;

//   while (1) {
//     out.push([...sp]);
//     if (sp[p] < max + p) {
//       sp[p]++;
//     } else {
//       do {
//         if (--p < 0) {
//           console.log(out.length);
//           console.timeEnd("time");
//           return;
//         }
//       } while (sp[p] >= max + p);
//       sp[p]++;
//       for (let i = p + 1; i < n; i++) {
//         sp[i] = sp[i - 1] + 1;
//       }
//       // 指针回到末位
//       p = n - 1;
//     }
//   }
// })();
