"use strict";
((callback) => {
    const { appendChild, insertBefore } = Element.prototype;
    Element.prototype.appendChild = function (dom) {
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
    Element.prototype.insertBefore = function (dom, ...args) {
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
//# sourceMappingURL=%E5%8A%AB%E6%8C%81SCRIPT%E8%84%9A%E6%9C%AC.js.map