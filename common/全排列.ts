function permute<T>(arr: T[]): T[][] {
  const used: Set<number> = new Set();
  const temp: T[] = [];
  const output: T[][] = [];
  const dfs = () => {
    if (temp.length === arr.length) {
      output.push([...temp]);
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      temp.push(arr[i]);
      dfs();
      temp.pop();
      used.delete(i);
    }
  };
  dfs();
  return output;
}
console.log(permute(["a", "c", "b", "5"]));

// function  permute1<T>(arr: T[]): T[][] {

// }
