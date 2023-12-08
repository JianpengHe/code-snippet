"use strict";
(global => {
    const workerScript = window.URL.createObjectURL(new Blob([
        "(" +
            String(() => {
                const fakeIdToTimerId = new Map();
                const fn = {
                    setInterval(fakeId, time = 0) {
                        fakeIdToTimerId.set(fakeId, Number(setInterval(() => postMessage(fakeId), time)));
                    },
                    clearInterval(fakeId) {
                        const timerId = fakeIdToTimerId.get(fakeId);
                        if (timerId) {
                            clearInterval(timerId);
                            fakeIdToTimerId.delete(fakeId);
                        }
                    },
                    setTimeout(fakeId, time = 0) {
                        fakeIdToTimerId.set(fakeId, Number(setTimeout(() => {
                            fakeIdToTimerId.delete(fakeId);
                            postMessage(fakeId);
                        }, time)));
                    },
                    clearTimeout(fakeId) {
                        const timerId = fakeIdToTimerId.get(fakeId);
                        if (timerId) {
                            clearTimeout(timerId);
                            fakeIdToTimerId.delete(fakeId);
                        }
                    },
                };
                onmessage = ({ data }) => {
                    const { name, fakeId, timeout } = data || {};
                    fn[name]?.(fakeId, timeout);
                };
            }) +
            ")();",
    ]));
    const worker = new Worker(workerScript);
    const fakeIdToCallback = new Map();
    let lastFakeId = 0;
    global.setInterval = function (callback, timeout, ...args) {
        const fakeId = ++lastFakeId;
        fakeIdToCallback.set(fakeId, () => callback(...args));
        worker.postMessage({ name: "setInterval", fakeId, timeout });
        return fakeId;
    };
    global.clearInterval = function (fakeId) {
        if (fakeIdToCallback.has(fakeId)) {
            fakeIdToCallback.delete(fakeId);
            worker.postMessage({ name: "clearInterval", fakeId });
        }
    };
    global.setTimeout = function (callback, timeout, ...args) {
        const fakeId = ++lastFakeId;
        fakeIdToCallback.set(fakeId, () => {
            fakeIdToCallback.delete(fakeId);
            callback(...args);
        });
        worker.postMessage({ name: "setTimeout", fakeId, timeout });
        return fakeId;
    };
    global.clearTimeout = function (fakeId) {
        if (fakeIdToCallback.has(fakeId)) {
            fakeIdToCallback.delete(fakeId);
            worker.postMessage({ name: "clearTimeout", fakeId });
        }
    };
    worker.onmessage = function ({ data }) {
        const callback = fakeIdToCallback.get(data);
        callback && callback();
    };
    worker.onerror = function (event) {
        console.error(event);
    };
})(window);
//# sourceMappingURL=%E7%A6%BB%E5%B1%8F%E5%AE%9A%E6%97%B6%E5%99%A8.js.map