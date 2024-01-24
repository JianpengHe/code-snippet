enum EPromiseState {
  "Pending" = 0,
  "Fulfilled" = 1,
  "Rejected" = 2,
}
type IPromiseResult = any | MyPromise<IPromiseResult>;
/** 在微任务阶段调用该回调函数 */
const useMicrotask = microtaskFunc => {
  /** 微任务是Promise特有的东西，为了调通测试用例，先借用一下 */
  if (Promise?.resolve) {
    Promise.resolve().then(microtaskFunc);
  } else {
    setTimeout(microtaskFunc);
  }
};

/** 手写Promise */
export class MyPromise<T extends IPromiseResult> {
  constructor(
    executor: (resolve: (value?: T) => IPromiseResult, reject: (reason?: any) => IPromiseResult) => IPromiseResult
  ) {
    executor(
      value =>
        useMicrotask(() => {
          if (this.PromiseState === EPromiseState.Pending) {
            this.PromiseState = EPromiseState.Fulfilled;
            this.PromiseResult = value;
          }
          this.done();
        }),
      reason =>
        useMicrotask(() => {
          if (this.PromiseState === EPromiseState.Pending) {
            this.PromiseState = EPromiseState.Rejected;
            this.PromiseResult = reason;
          }
          this.done();
        })
    );
  }
  public PromiseState = EPromiseState.Pending;
  public PromiseResult?: T;
  /** 因为then可以调用很多次，所以需要把每个回调函数存起来 */
  private readonly fulfilledCallbacks: Array<(value: T) => IPromiseResult> = [];
  private readonly rejectedCallbacks: Array<(reason: any) => IPromiseResult> = [];
  private readonly finallyCallbacks: Array<(reason: any) => IPromiseResult> = [];

  public then<IFulfilledReturn extends IPromiseResult, IRejectedReturn extends IPromiseResult>(
    onfulfilled?: (value: T) => IFulfilledReturn,
    onrejected?: (reason: any) => IRejectedReturn
  ) {
    return new MyPromise<IFulfilledReturn | IRejectedReturn | T>((resolve, reject) => {
      this.fulfilledCallbacks.push(value => {
        if (!onfulfilled) {
          resolve(value);
          return;
        }
        const newValue = onfulfilled(value);
        if (newValue instanceof MyPromise) {
          newValue.then(resolve, reject);
          return;
        }
        resolve(newValue);
      });
      this.rejectedCallbacks.push(reason => {
        if (!onrejected) {
          reject(reason);
          return;
        }
        const newValue = onrejected(reason);
        if (newValue instanceof MyPromise) {
          newValue.then(resolve, reject);
          return;
        }
        resolve(newValue);
      });
      if (this.PromiseState !== EPromiseState.Pending) this.done();
    });
  }
  public catch<IRejectedReturn extends IPromiseResult>(onrejected?: (reason: any) => IRejectedReturn) {
    return new MyPromise<IRejectedReturn | T>((resolve, reject) => {
      this.fulfilledCallbacks.push(resolve);
      this.rejectedCallbacks.push(reason => {
        if (!onrejected) {
          reject(reason);
          return;
        }
        const newValue = onrejected(reason);
        if (newValue instanceof MyPromise) {
          newValue.then(resolve, reject);
          return;
        }
        resolve(newValue);
      });
      if (this.PromiseState !== EPromiseState.Pending) this.done();
    });
  }

  public finally<IFinallyedReturn extends IPromiseResult>(onfinally?: () => IFinallyedReturn) {
    return new MyPromise((resolve, reject) => {
      this.fulfilledCallbacks.push(resolve);
      this.rejectedCallbacks.push(reject);
      this.finallyCallbacks.push(value => {
        if (!onfinally) {
          resolve(value);
          return;
        }
        const newValue = onfinally();
        if (newValue instanceof MyPromise) {
          newValue.then(resolve, reject);
          return;
        }
        resolve(newValue);
      });
      if (this.PromiseState !== EPromiseState.Pending) this.done();
    });
  }
  private done() {
    if (this.PromiseState === EPromiseState.Pending) throw new Error("未完成");
    /** 清空回调函数的队列 */
    let func: any = undefined;
    while (
      (func = (
        this.PromiseState === EPromiseState.Fulfilled ? this.fulfilledCallbacks : this.rejectedCallbacks
      ).shift())
    ) {
      func(this.PromiseResult);
    }
    while ((func = this.finallyCallbacks.shift())) {
      func();
    }

    this.fulfilledCallbacks.length = 0;
    this.rejectedCallbacks.length = 0;
  }

  /** resolve静态方法 */
  static resolve<T extends IPromiseResult>(value?: T) {
    return new MyPromise<T>(resolve => resolve(value));
  }

  /** reject静态方法 */
  static reject(reason?: any) {
    return new MyPromise<never>((_, reject) => reject(reason));
  }

  static all<T>(values: Iterable<MyPromise<T> | T>): MyPromise<T[]> {
    return new MyPromise<T[]>((resolve, reject) => {
      const out: T[] = [];
      const valuesArr = [...values];
      let done = 0;
      for (let i = 0; i < valuesArr.length; i++) {
        const promise = valuesArr[i];
        if (promise instanceof MyPromise) {
          promise.then(res => {
            out[i] = res;
            if (++done >= valuesArr.length) resolve(out);
          }, reject);
          continue;
        }
        out[i] = promise;
        if (++done >= valuesArr.length) resolve(out);
      }
    });
  }

  static allSettled<T>(
    values: Iterable<MyPromise<T> | T>
  ): MyPromise<({ status: "fulfilled"; value: T } | { status: "rejected"; reason: any })[]> {
    return new MyPromise<({ status: "fulfilled"; value: T } | { status: "rejected"; reason: any })[]>(
      (resolve, reject) => {
        const out: ({ status: "fulfilled"; value: T } | { status: "rejected"; reason: any })[] = [];
        const valuesArr = [...values];
        let done = 0;
        for (let i = 0; i < valuesArr.length; i++) {
          const promise = valuesArr[i];
          if (promise instanceof MyPromise) {
            promise.then(
              value => {
                out[i] = { status: "fulfilled", value };
                if (++done >= valuesArr.length) resolve(out);
              },
              reason => {
                out[i] = { status: "rejected", reason };
                if (++done >= valuesArr.length) resolve(out);
              }
            );
            continue;
          }
          out[i] = { status: "fulfilled", value: promise };
          if (++done >= valuesArr.length) resolve(out);
        }
      }
    );
  }

  static any<T>(values: Iterable<MyPromise<T> | T>): MyPromise<T | any[]> {
    return new MyPromise<T | any[]>((resolve, reject) => {
      const out: any[] = [];
      const valuesArr = [...values];
      let done = 0;
      for (let i = 0; i < valuesArr.length; i++) {
        const promise = valuesArr[i];
        if (promise instanceof MyPromise) {
          promise.then(resolve, reason => {
            out[i] = reason;
            if (++done >= valuesArr.length) reject(new AggregateError(out, "All promises were rejected"));
          });
          continue;
        }
        resolve(promise);
      }
    });
  }

  static race<T>(values: Iterable<MyPromise<T> | T>): MyPromise<T> {
    return new MyPromise<T>((resolve, reject) => {
      for (const promise of values) {
        if (promise instanceof MyPromise) {
          promise.then(resolve, reject);
          continue;
        }
        resolve(promise);
      }
    });
  }
}

/** 测试用例1：只包含resolve的then链 */
1 &&
  setTimeout(() => {
    console.log("测试用例1：只包含resolve的then链");
    new MyPromise<number>(r => r(1))
      .then()
      .then(a => {
        console.log("MyPromise1", a);
        return "6";
      })
      .then(a => {
        console.log("MyPromise2", a);
        return new MyPromise<bigint>(r => r(2n));
      })
      .then(a => {
        console.log("MyPromise3", a);
      })
      .then(a => {
        console.log("MyPromise4", a);
      });

    new Promise<number>(r => r(1))
      .then()
      .then(a => {
        console.log("Promise1", a);
        return "6";
      })
      .then(a => {
        console.log("Promise2", a);
        return new Promise<bigint>(r => r(2n));
      })
      .then(a => {
        console.log("Promise3", a);
      })
      .then(a => {
        console.log("Promise4", a);
      });

    new Promise<number>(r => r(1))
      .then()
      .then(a => {
        console.log("Promise11", a);
        return "6";
      })
      .then(a => {
        console.log("Promise12", a);
        return new Promise<bigint>(r => r(2n));
      })
      .then(a => {
        console.log("Promise13", a);
      })
      .then(a => {
        console.log("Promise14", a);
      });
    console.log("time");
  }, 0);

/** 测试用例2：多次调用 resolve、reject，以及该Promise完成后是否会继续调用新添加的回调函数 */
1 &&
  setTimeout(() => {
    console.log("测试用例2：多次调用 resolve、reject，以及该Promise完成后是否会继续调用新添加的回调函数");
    let myresolve, myreject;
    const myPromise = new MyPromise<number>((resolve, reject) => {
      myresolve = resolve;
      myreject = reject;
    });
    myPromise.then(
      a => console.log("MyPromise resolve 1", a),
      a => console.log("MyPromise reject 1", a)
    );
    myresolve(666);
    myPromise.then(
      a => console.log("MyPromise resolve 2", a),
      a => console.log("MyPromise reject 2", a)
    );
    setTimeout(() => {
      myreject(777);
      myPromise.then(
        a => console.log("MyPromise resolve 3", a),
        a => console.log("MyPromise reject 3", a)
      );
    }, 10);
    setTimeout(() => {
      myPromise.then(
        a => console.log("myPromise resolve 4", a),
        a => console.log("myPromise reject 4", a)
      );
    }, 20);

    let resolve1, reject1;
    const promise = new Promise<number>((resolve, reject) => {
      resolve1 = resolve;
      reject1 = reject;
    });
    promise.then(
      a => console.log("Promise resolve 1", a),
      a => console.log("Promise reject 1", a)
    );
    resolve1(666);
    promise.then(
      a => console.log("Promise resolve 2", a),
      a => console.log("Promise reject 2", a)
    );
    setTimeout(() => {
      reject1(777);
      promise.then(
        a => console.log("Promise resolve 3", a),
        a => console.log("Promise reject 3", a)
      );
    }, 10);
    setTimeout(() => {
      promise.then(
        a => console.log("Promise resolve 4", a),
        a => console.log("Promise reject 4", a)
      );
    }, 20);
  }, 300);

/** 测试用例3：各种状态的then链 */
1 &&
  setTimeout(() => {
    console.log("测试用例3：各种状态的then链");
    MyPromise.resolve(1)
      .finally(() => {
        console.log("MyPromise finally");
      })
      .then(a => {
        console.log("MyPromise1", a); // 正常输出
        return MyPromise.reject("6");
      })
      .then(a => {
        console.log("MyPromise2", a); // 跳过
        return new MyPromise<bigint>(r => r(2n));
      })
      .then(
        a => {
          console.log("MyPromise3", a); // 跳过
          return new MyPromise<bigint>(r => r(3n));
        },
        b => {
          console.log("MyPromise reject3", b); // 输出，错误在这里被处理了，继续往下执行
          // return "Go on";
        }
      )
      .catch(a => {
        console.log("MyPromise catch4", a); // 所有的错误都被处理了，没错误了，跳过
        return "Go on catch";
      })
      .then(a => {
        console.log("MyPromise5", a); // 正常输出
        return MyPromise.reject("last error");
      })
      .catch(a => {
        console.log("MyPromise catch6", a); // 输出
      })
      .finally(() => {
        console.log("MyPromise finally2");
      });

    Promise.resolve(1)
      .finally(() => {
        console.log("Promise finally");
      })
      .then(a => {
        console.log("Promise1", a); // 正常输出
        return Promise.reject("6");
      })
      .then(a => {
        console.log("Promise2", a); // 跳过
        return new Promise<bigint>(r => r(2n));
      })
      .then(
        a => {
          console.log("Promise3", a); // 跳过
          return new Promise<bigint>(r => r(3n));
        },
        b => {
          console.log("Promise reject3", b); // 输出，错误在这里被处理了，继续往下执行
          // return "Go on";
        }
      )
      .catch(a => {
        console.log("Promise catch4", a); // 所有的错误都被处理了，没错误了，跳过
        return "Go on catch";
      })
      .then(a => {
        console.log("Promise5", a); // 正常输出
        return Promise.reject("last error");
      })
      .catch(a => {
        console.log("Promise catch6", a); // 输出
      })
      .finally(() => {
        console.log("Promise finally2");
      });
  }, 600);

/** 测试用例4：Promise的静态方法 */
1 &&
  setTimeout(() => {
    console.log("测试用例4：Promise的静态方法");
    MyPromise.all([1, new MyPromise(r => setTimeout(r, 30, 2)), new MyPromise(r => setTimeout(r, 10, 3))]).then(a =>
      console.log("MyPromise.all", a)
    );
    Promise.all([1, new Promise(r => setTimeout(r, 30, 2)), new Promise(r => setTimeout(r, 10, 3))]).then(a =>
      console.log("Promise.all", a)
    );

    MyPromise.allSettled([
      1,
      new MyPromise((_, r) => setTimeout(r, 30, 2)),
      new MyPromise(r => setTimeout(r, 10, 3)),
    ]).then(a => console.log("MyPromise.allSettled", a));
    Promise.allSettled([1, new Promise((_, r) => setTimeout(r, 30, 2)), new Promise(r => setTimeout(r, 10, 3))]).then(
      a => console.log("Promise.allSettled", a)
    );

    MyPromise.any([new MyPromise((_, r) => setTimeout(r, 0, 2)), new MyPromise((_, r) => setTimeout(r, 10, 3))]).then(
      () => {},
      a => console.log("MyPromise.any reject", a)
    );
    Promise.any([new Promise((_, r) => setTimeout(r, 0, 2)), new Promise((_, r) => setTimeout(r, 10, 3))]).then(
      () => {},
      a => console.log("Promise.any reject", a)
    );
    MyPromise.any([new MyPromise(r => setTimeout(r, 0, 2)), new MyPromise((_, r) => setTimeout(r, 10, 3))]).then(a =>
      console.log("MyPromise.any resolve", a)
    );
    Promise.any([new Promise(r => setTimeout(r, 0, 2)), new Promise((_, r) => setTimeout(r, 10, 3))]).then(a =>
      console.log("Promise.any resolve", a)
    );

    MyPromise.race([new MyPromise(r => setTimeout(r, 1, 2)), new MyPromise((_, r) => setTimeout(r, 10, 3))]).then(
      a => console.log("MyPromise.race resolve", a),
      a => console.log("MyPromise.race reject", a)
    );
    Promise.race([new Promise(r => setTimeout(r, 1, 2)), new Promise((_, r) => setTimeout(r, 10, 3))]).then(
      a => console.log("Promise.race resolve", a),
      a => console.log("Promise.race reject", a)
    );
    MyPromise.race([new MyPromise(r => setTimeout(r, 100, 2)), new MyPromise((_, r) => setTimeout(r, 10, 3))]).then(
      a => console.log("MyPromise.race resolve", a),
      a => console.log("MyPromise.race reject", a)
    );
    Promise.race([new Promise(r => setTimeout(r, 100, 2)), new Promise((_, r) => setTimeout(r, 10, 3))]).then(
      a => console.log("Promise.race resolve", a),
      a => console.log("Promise.race reject", a)
    );
  }, 900);

/** 测试用例：面试题 */
1 &&
  setTimeout(() => {
    console.log("测试用例：面试题");
    setTimeout(() => {
      console.log("MyPromise 1");
      MyPromise.resolve().then(() => {
        console.log("MyPromise 2");
      });
    }, 0);

    MyPromise.resolve().then(() => {
      console.log("MyPromise 3");
      setTimeout(() => {
        console.log("MyPromise 4");
      }, 0);
    });
    console.log("MyPromise 5");
    setTimeout(() => {
      console.log("Promise 1");
      Promise.resolve().then(() => {
        console.log("Promise 2");
      });
    }, 0);

    Promise.resolve().then(() => {
      console.log("Promise 3");
      setTimeout(() => {
        console.log("Promise 4");
      }, 0);
    });
    console.log("Promise 5");
  }, 1000);
