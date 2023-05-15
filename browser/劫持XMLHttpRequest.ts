(() => {
  const XMLHttpRequest = window.XMLHttpRequest;
  window.XMLHttpRequest = new Proxy(XMLHttpRequest, {
    construct() {
      return new Proxy(new XMLHttpRequest(), {
        set(target, p, newValue) {
          if (p === "onreadystatechange") {
            target[p] = (...args) => {
              /** 拦截onreadystatechang事件 */
              if (target.readyState === 4) {
                // TODO: do any things
                console.log(target.responseText);
              }
              /** 开发者原有的逻辑 */
              newValue(...args);
            };
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
})();
