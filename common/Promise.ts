enum EPromiseState {
  "Pending" = 0,
  "Fulfilled" = 1,
  "Rejected" = 2,
}
export class MyPromise<IEventualValue> {
  constructor(executor: (resolve: (value: IEventualValue) => void, reject: (reason?: any) => void) => void) {
    executor(this.resolve.bind(this), this.reject.bind(this));
  }
  private state = EPromiseState.Pending;
  private fulfilledCallback: Array<(value: IEventualValue) => any> = [];
  private rejectedCallback: Array<(reason: any) => any> = [];
  public then<IFulfilledReturn, IRejectedReturn>(
    onfulfilled?: (value: IEventualValue) => IFulfilledReturn,
    onrejected?: (reason: any) => IRejectedReturn
  ) {
    onfulfilled && this.fulfilledCallback.push(onfulfilled);
    onrejected && this.rejectedCallback.push(onrejected);
    // if()
    // return new MyPromise();
  }
  private resolve(value: IEventualValue): void {
    setTimeout(() => {
      // 微任务
      let fn: MyPromise<IEventualValue>["fulfilledCallback"][0] | undefined = undefined;
      while ((fn = this.fulfilledCallback.shift())) {
        fn(value);
      }
      this.rejectedCallback.length = 0;
    });
    if (this.state !== EPromiseState.Pending) return;
    this.state = EPromiseState.Fulfilled;
  }
  private reject(reason?: any): void {
    if (this.state !== EPromiseState.Pending) return;
    this.state = EPromiseState.Rejected;
  }
}

new MyPromise<string>(() => {});
// new Promise<number>(r => r(1)).then<string, object>(a => {
//   console.log(a);
// });
