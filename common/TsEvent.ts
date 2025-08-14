export class TsEventTarget<EventList extends Record<string, Record<string, any>>> extends EventTarget {
  public on<EventName extends keyof EventList>(
    eventName: EventName,
    callback: ((evt: TsMixEvent<EventList[EventName]>) => void) | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    return super.addEventListener(String(eventName), callback as any, options);
  }
  public once<EventName extends keyof EventList>(
    eventName: EventName,
    callback: ((evt: TsMixEvent<EventList[EventName]>) => void) | null
  ): void {
    return super.addEventListener(String(eventName), callback as any, { once: true });
  }

  public off<EventName extends keyof EventList>(
    eventName: EventName,
    callback: ((evt: TsMixEvent<EventList[EventName]>) => void) | null,
    options?: EventListenerOptions | boolean
  ): void {
    return super.removeEventListener(String(eventName), callback as any, options);
  }

  public emit<EventName extends keyof EventList>(eventName: EventName, arg: EventList[EventName]) {
    if (arg instanceof Event) {
      console.log(arg);
      // arg.type = String(eventName);
      return super.dispatchEvent(arg);
    }

    return super.dispatchEvent(new TsMixEvent(String(eventName), arg));
  }
}

class TsMixEventBase<T extends Record<string, any>> extends Event {
  public readonly detail?: T;

  constructor(type: string, detail?: T, eventInitDict?: EventInit) {
    super(type, eventInitDict);

    if (detail) {
      this.detail = detail;
      Object.assign(this, detail);
    }
  }
}

type TsMixEvent<T extends Record<string, any>> = TsMixEventBase<T> & T;
interface TsMixEventConstructor {
  new <T extends Record<string, any>>(type: string, detail?: T, eventInitDict?: EventInit): TsMixEvent<T>;
}
export const TsMixEvent: TsMixEventConstructor = TsMixEventBase as TsMixEventConstructor;

// 测试用例
// class Person extends TsEventTarget<{ add: { name: string; age: number }; remove: { name: string; age?: number } }> {
//   constructor() {
//     super();
//     this.on("add", e => {
//       console.log(e.age);
//       this.emit("remove", { name: "张三" });
//     });
//   }
// }

// const person = new Person();
// setTimeout(() => {
//   person.emit("add", { name: "张三", age: 18 });
// }, 100);
// person.on("remove", e => {
//   console.log("remove", e.name);
// });
