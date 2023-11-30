"use strict";
function find(arr1, arr2, maxTimes = Infinity, judge = (a, b) => a === b) {
    const maxIndex = Math.min(arr1.length, arr2.length);
    let output = null;
    const indexOf = (arrA, arrB, index) => {
        let j = 0;
        const end = Math.min(maxIndex, arrB.length, maxTimes);
        for (; j < end; j++) {
            if (!judge(arrA[index + j], arrB[j]))
                return;
        }
        output = { main: arrA, child: arrB, index };
        return;
    };
    for (let i = 0; i < maxIndex; i++) {
        indexOf(arr1, arr2, i);
        if (output)
            return output;
        indexOf(arr2, arr1, i);
        if (output)
            return output;
    }
    return null;
}
console.log(find([1, 2, 3, 4], [3, 4, 5], 2));
console.log(find(Buffer.from([0xff, 0xfe, 0x82]), Buffer.from([0x70, 0x60, 0xff, 0xfe, 0x67]), 2));
console.log(find(Buffer.from([0xff, 0xfe, 0x82]), Buffer.from([0x70, 0x60, 0xff - 3, 0xfe + 4, 0x67]), 2, (a, b) => {
    const diff = Math.abs(a - b);
    return diff < 5 || diff > 250;
}));
//# sourceMappingURL=find.js.map