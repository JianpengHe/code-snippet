import { MyEvent } from "../common/手写事件";

export type CrossOriginMessageEventList = {
  [x: string]: any;
  connect?: never;
};
export type CrossOriginMessageCallback<EventList extends CrossOriginMessageEventList, K extends keyof EventList> = (
  data: EventList[K],
  that: CrossOriginMessage<EventList>
) => void;

export class CrossOriginMessage<EventList extends CrossOriginMessageEventList> extends MyEvent<
  {
    [K in keyof EventList]: (data: EventList[K], that: CrossOriginMessage<EventList>) => void;
  } & { connect: (data: string, that: CrossOriginMessage<EventList>) => void }
> {
  public readonly origin: string;
  private token = "";
  private lister(e: any) {
    // console.log(e, this.origin);
    if (e.origin !== this.origin) return;
    try {
      const { event, data, token } = JSON.parse(e.data || "{}");
      //   console.log(event, data, token);

      if (!event) return;
      if (String(event).startsWith("_connect")) {
        if (this.windowProxy) {
          // @ts-ignore
          this.emit(event, data, this);
          return;
        }
        this.token = token;
        (this.windowProxy = e.source).postMessage(JSON.stringify({ event, token }), this.origin);
        // @ts-ignore
        this.emit("connect", token, this);
        return;
      }
      if (token !== this.token) return;
      //   console.log("连接成功");
      // @ts-ignore
      this.emit(event, data, this);
    } catch (e) {
      console.log(e);
    }
  }
  private thisLister: CrossOriginMessage<EventList>["lister"];
  constructor(origin: string) {
    super();
    this.origin = origin;
    window.addEventListener("message", (this.thisLister = this.lister.bind(this)));
  }
  private windowProxy: Promise<WindowProxy> | undefined;
  public connect(windowProxy: WindowProxy | null) {
    // console.log("连接。。。", windowProxy);
    this.token = "";
    if (!windowProxy) return false;
    this.windowProxy = new Promise<WindowProxy>(r => {
      const token = Math.random().toString(36).substring(2);
      const event: any = "_connect" + token;
      const timer = Number(
        setInterval(() => {
          //   console.log({ event, token });
          windowProxy.postMessage(JSON.stringify({ event, token }), this.origin);
        }, 1000)
      );
      this.once(event, () => {
        // console.log("连接成功");
        clearInterval(timer);
        r(windowProxy);
        this.token = token;
        //@ts-ignore
        this.emit("connect", token, this);
      });
    });
    return true;
  }
  public async send<EventName extends keyof EventList>(event: EventName, data: EventList[EventName]) {
    const windowProxy = await this.windowProxy;
    if (!windowProxy || !this.token) {
      throw new Error("未初始化");
    }
    windowProxy.postMessage(JSON.stringify({ event, data, token: this.token }), this.origin);
  }
  public close() {
    this.token = "";
    this.windowProxy = undefined;
    window.removeEventListener("message", this.thisLister);
  }
  public async request<EventName extends keyof EventList>(event: EventName, data: EventList[EventName]) {
    this.send(event, data);
    // @ts-ignore
    const res: EventList[EventName] = await this.when(event, newData =>
      newData === data || (typeof data === "object" && Object.keys(data).every(k => data[k] === newData[k]))
        ? newData
        : undefined
    );
    return res;
  }
}

// const cross = new CrossOriginMessage<{ test: number; t: string }>("");
// cross.connect(window.open());
// cross.send("test", 0);
// cross.request("test","6").then(res=>)
// cross.emit("test", 3);
// cross.emit("connect", "");
