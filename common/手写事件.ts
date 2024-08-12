export class MyEvent<EventList extends Record<string, (...args: any) => void>> {
  /** 监听器池 */
  private eventListenerMap: Map<keyof EventList, Set<EventList[keyof EventList]>> = new Map();

  /** 一次性监听器池 */
  private eventDisposableListenerMap: Map<keyof EventList, Set<EventList[keyof EventList]>> = new Map();

  public on<EventName extends keyof EventList>(eventName: EventName, callback: EventList[EventName]) {
    const newListenerSet: Set<EventList[keyof EventList]> = new Set();
    const listenerSetByEventName =
      this.eventListenerMap.get(eventName) ?? (this.eventListenerMap.set(eventName, newListenerSet), newListenerSet);
    listenerSetByEventName.add(callback);
    return this;
  }

  public once<EventName extends keyof EventList>(eventName: EventName, callback: EventList[EventName]) {
    const newListenerSet: Set<EventList[keyof EventList]> = new Set();
    const disposableListenerSetByEventName =
      this.eventDisposableListenerMap.get(eventName) ??
      (this.eventDisposableListenerMap.set(eventName, newListenerSet), newListenerSet);
    disposableListenerSetByEventName.add(callback);
    return this.on(eventName, callback);
  }

  public off<EventName extends keyof EventList>(eventName: EventName, callback: EventList[EventName]) {
    this.eventListenerMap.get(eventName)?.delete(callback);
    this.eventDisposableListenerMap.get(eventName)?.delete(callback);
    return this;
  }

  public emit<EventName extends keyof EventList>(eventName: EventName, ...args: Parameters<EventList[EventName]>) {
    const listenerSetByEventName = this.eventListenerMap.get(eventName);
    const disposableListenerSetByEventName = this.eventDisposableListenerMap.get(eventName);
    if (listenerSetByEventName) {
      for (const callback of listenerSetByEventName) {
        callback.apply(this, args);
        /** 删除一次性监听器 */
        if (disposableListenerSetByEventName?.has(callback)) {
          disposableListenerSetByEventName.delete(callback);
          listenerSetByEventName.delete(callback);
        }
      }
    }
    return this;
  }
  public when<T, EventName extends keyof EventList>(
    eventName: EventName,
    filter: (...args: Parameters<EventList[EventName]>) => T | undefined
  ) {
    return new Promise<T>(r => {
      // @ts-ignore
      const callback: EventList[EventName] = (...args: Parameters<EventList[EventName]>): void => {
        const returnValue = filter(...args);
        if (returnValue !== undefined) {
          this.off(eventName, callback);
          r(returnValue);
        }
      };
      this.on(eventName, callback);
    });
  }
}

// 测试用例
// type IEventList = {
//   run: (id: number) => void;
//   jump: (msg: string, times: number) => void;
// };
// const myEvent = new MyEvent<IEventList>();

// myEvent.on("run", id => {
//   console.log("on run", id);
// });

// myEvent.once("run", id => {
//   console.log("once run", id);
// });

// const callback = (msg, times) => {
//   console.log("on jump", msg, times);
// };
// myEvent.on("jump", callback);
// myEvent.on("jump", (msg, times) => {
//   console.log("on jump2", msg, times);
// });

// myEvent.emit("run", 1);
// myEvent.emit("jump", "ok", 4);
// setTimeout(() => {
//   myEvent.off("jump", callback);
//   myEvent.emit("run", 2);
//   myEvent.emit("jump", "ok2", 8);
// }, 500);

/**
on run 1
once run 1
on jump ok 4
on jump2 ok 4

on run 2
on jump2 ok2 8
 */
