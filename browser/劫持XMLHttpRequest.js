"use strict";
(() => {
    const XMLHttpRequest = window.XMLHttpRequest;
    window.XMLHttpRequest = new Proxy(XMLHttpRequest, {
        construct() {
            return new Proxy(new XMLHttpRequest(), {
                set(target, p, newValue) {
                    if (p === "onreadystatechange") {
                        target[p] = (...args) => {
                            if (target.readyState === 4) {
                                console.log(target.responseText);
                            }
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
//# sourceMappingURL=%E5%8A%AB%E6%8C%81XMLHttpRequest.js.map