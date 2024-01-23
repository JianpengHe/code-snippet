/** call */
function call<T extends (...args: any[]) => any>(func: T, thisObj: any, ...args: Parameters<T>) {
  const symbol = Symbol();
  switch (typeof thisObj) {
    case "string":
    case "number":
    case "boolean":
      thisObj = new (Object.getPrototypeOf(thisObj).constructor)(thisObj);
      break;
    case "undefined":
      thisObj = window;
      break;
    case "bigint":
    case "symbol":
      throw new Error("暂不支持bigint或symbol");
    case "object":
      if (thisObj === null) {
        thisObj = window;
        break;
      }
    case "function":
  }

  Object.defineProperty(thisObj, symbol, { value: func, enumerable: false, configurable: true });
  const returnValue: ReturnType<T> = thisObj[symbol](...args);
  delete thisObj[symbol];
  return returnValue;
}

/** apply */
function apply<T extends (...args: any[]) => any>(func: T, thisObj: any, args?: Parameters<T>) {
  //@ts-ignore
  return args ? call(func, thisObj, ...args) : call(func, thisObj);
}

/** bind */
function bind<T extends (...args: any[]) => any>(func: T, thisObj: any) {
  return function (...args: Parameters<T>) {
    //@ts-ignore
    if (new.target) return new func(...args);
    return call(func, thisObj, ...args);
  };
}

/** 测试用例 */
console.log(Object.prototype.toString.call(1), call(Object.prototype.toString, 1));
console.log(
  Object.prototype.toString.call(1n)
  //  call(Object.prototype.toString, 1n)
);
console.log(Object.prototype.toString.call("1"), call(Object.prototype.toString, "1"));
console.log(Object.prototype.toString.call({}), call(Object.prototype.toString, {}));
console.log(Object.prototype.toString.call(true), call(Object.prototype.toString, true));
console.log(
  Object.prototype.toString.call(Symbol())
  // call(Object.prototype.toString, Symbol())
);
console.log(
  Object.prototype.toString.call(function () {}),
  call(Object.prototype.toString, function () {})
);
console.log(Object.prototype.toString.call(undefined), call(Object.prototype.toString, undefined));

function test() {
  // @ts-ignore
  return this;
}
const obj = { test };

console.log(test.call(1), call(test, 1));
console.log(obj.test.call(1), call(obj.test, 1));

const arr = [1];
apply(arr.push, arr, [4, 5]);
call(arr.push, arr, 4, 5);
console.log(arr);

/** bind */
console.log(obj.test.bind(1)(), bind(test, 1)());
//@ts-ignore
console.log(new (obj.test.bind(1))(), new (bind(test, 1))());
