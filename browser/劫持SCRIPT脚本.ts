((callback: (src: string, txt: string) => string) => {
  const { appendChild, insertBefore } = Element.prototype;
  //@ts-ignore
  Element.prototype.appendChild = function (dom: any) {
    const src = String(dom.src);
    if (dom.nodeName === "SCRIPT" && new URL(src).host === location.host) {
      fetch(src)
        .then(a => a.text())
        .then(text => {
          dom.src = URL.createObjectURL(new Blob([callback(src, text)]));
          appendChild.call(this, dom);
          dom.addEventListener("load", () => URL.revokeObjectURL(dom.src));
        })
        .catch(e => {
          console.error(e);
        });
      return;
    }
    return appendChild.call(this, dom);
  };
  //@ts-ignore
  Element.prototype.insertBefore = function (dom: any, ...args) {
    const src = String(dom.src);
    if (dom.nodeName === "SCRIPT" && new URL(src).host === location.host) {
      fetch(src)
        .then(a => a.text())
        .then(text => {
          dom.src = URL.createObjectURL(new Blob([callback(src, text)]));
          insertBefore.call(this, dom, ...args);
          dom.addEventListener("load", () => URL.revokeObjectURL(dom.src));
        })
        .catch(e => {
          console.error(e);
        });
      return;
    }
    return insertBefore.call(this, dom, ...args);
  };
})((src, txt) => {
  return txt.replace("1", "2");
});
