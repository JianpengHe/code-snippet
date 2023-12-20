(() => {
  const XMLHttpRequest = window.XMLHttpRequest;
  window.XMLHttpRequest = new Proxy(XMLHttpRequest, {
    construct() {
      return new Proxy(new XMLHttpRequest(), {
        set(target, p, newValue) {
          if (typeof newValue === "function") {
            target[p] = (...args) => {
              /** 拦截onreadystatechang事件 */
              if (target.readyState === 4) {
                // TODO: do any things
                console.log(target.responseText);
              }
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
            return target[p].bind(target);
          }
          return target[p];
        },
      });
    },
  });
  const fetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit | undefined) => {
    const res = await fetch(input, init);
    return new Proxy(res, {
      get(target: Response, p: string | symbol) {
        if (p === "arrayBuffer" || p === "blob" || p === "formData" || p === "json" || p === "text") {
          return async () => {
            const body = await res[p]();
            // TODO: do any things
            console.log(input, body);
            return body;
          };
        }
        return target[p];
      },
    });
  };
})();
