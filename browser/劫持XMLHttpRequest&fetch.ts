import { MyEvent } from "../common/手写事件";
type IFetchBodyBase = { input: RequestInfo | URL; init?: RequestInit | undefined; eventName: keyof IEventList };
type IEventList = {
  sendXMLHttpRequest: (xhr: XMLHttpRequest) => void;
  onreadystatechange: (xhr: XMLHttpRequest) => void;
  sendFetch: (info: { input: RequestInfo | URL; init?: RequestInit | undefined }) => void;
  onFetchBody: (data: { readonly data: any | Promise<any> } & IFetchBodyBase) => void;
  onFetchArrayBuffer: (data: { data: ArrayBuffer } & IFetchBodyBase) => void;
  onFetchBlob: (data: { data: Blob } & IFetchBodyBase) => void;
  onFetchFormData: (data: { data: FormData } & IFetchBodyBase) => void;
  onFetchJson: (data: { data: { [x: string]: any } } & IFetchBodyBase) => void;
  onFetchText: (data: { data: string } & IFetchBodyBase) => void;
  onFetchClone: (data: { readonly data: Response } & IFetchBodyBase) => void;
};

const XMLHttpRequest = window.XMLHttpRequest;
const fetch = window.fetch;

export default () => {
  const event = new MyEvent<IEventList>();
  window.XMLHttpRequest = new Proxy(XMLHttpRequest, {
    construct() {
      return new Proxy(new XMLHttpRequest(), {
        set(target, p, newValue) {
          if (typeof newValue === "function") {
            target[p] = (...args) => {
              /** 拦截onreadystatechange事件 */
              // if (target.readyState === 4) {
              //   // TODO: do any things
              //   console.log(target.responseText);
              // }
              event.emit("onreadystatechange", target);
              /** 开发者原有的逻辑 */
              newValue(...args);
            };
          } else {
            target[p] = newValue;
          }
          return true;
        },
        get(target, p) {
          if (typeof target[p] === "function") {
            if (p === "send") {
              event.emit("sendXMLHttpRequest", target);
            }
            return target[p].bind(target);
          }
          return target[p];
        },
      });
    },
  });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit | undefined) => {
    const info = { input, init };
    event.emit("sendFetch", info);
    // @ts-ignore
    const res = await fetch(info.input, info.init);
    return new Proxy(res, {
      get(target: Response, p: string | symbol) {
        const emit = async (eventName: keyof IEventList, data?: any) => {
          data = data ?? (await res[p]());
          const body = { data, input, init, eventName };
          // // TODO: do any things
          // console.log(input, body);
          event.emit(eventName, body);
          event.emit("onFetchBody", body);
          if (body.data instanceof Promise) {
            body.data = await body.data;
          }
          return body.data;
        };
        // console.log(target, p);
        switch (p) {
          case "arrayBuffer":
            return emit("onFetchArrayBuffer");
          case "blob":
            return emit("onFetchBlob");
          case "formData":
            return emit("onFetchFormData");
          case "json":
            return emit("onFetchJson");
          case "text":
            return emit("onFetchText");
          case "clone":
            emit("onFetchClone", target.clone());
            break;
        }

        return typeof target[p] === "function" ? target[p].bind(res) : target[p];
      },
    });
  };
  return event;
};

// 使用例子
// import hook from "./劫持XMLHttpRequest&fetch";
// hook().on("onreadystatechange", xhr => {
//   console.log(xhr);
// });
