import { MyEvent } from "../common/手写事件";
type IEventList = {
  sendXMLHttpRequest: (xhr: XMLHttpRequest) => void;
  onreadystatechange: (xhr: XMLHttpRequest) => void;
  sendFetch: (info: { input: RequestInfo | URL; init?: RequestInit | undefined }) => void;
  onFetchBody: (data: any) => void;
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
        if (p === "arrayBuffer" || p === "blob" || p === "formData" || p === "json" || p === "text") {
          return async () => {
            const body = await res[p]();
            // // TODO: do any things
            // console.log(input, body);
            event.emit("onFetchBody", body);
            return body;
          };
        }
        return target[p];
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
