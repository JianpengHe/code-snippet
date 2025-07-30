export function setIntervalTimeoutProxy(global: any = window) {
  if (!String(global.setInterval).endsWith("{ [native code] }")) {
    console.warn("重复加载");
    return;
  }
  const workerScript = window.URL.createObjectURL(
    new Blob([
      "(" +
        String(() => {
          const fakeIdToTimerId: Map<number, number> = new Map();
          const fn = {
            setInterval(fakeId: number, time: number = 0) {
              fakeIdToTimerId.set(fakeId, Number(setInterval(() => postMessage(fakeId), time)));
            },
            clearInterval(fakeId: number) {
              const timerId = fakeIdToTimerId.get(fakeId);
              if (timerId) {
                clearInterval(timerId);
                fakeIdToTimerId.delete(fakeId);
              }
            },
            setTimeout(fakeId: number, time: number = 0) {
              fakeIdToTimerId.set(
                fakeId,
                Number(
                  setTimeout(() => {
                    fakeIdToTimerId.delete(fakeId);
                    postMessage(fakeId);
                  }, time)
                )
              );
            },
            clearTimeout(fakeId: number) {
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
    ])
  );

  const worker = new Worker(workerScript);
  const fakeIdToCallback: Map<number, () => void> = new Map();
  const getFakeId = () => {
    while (1) {
      const id = Math.floor(Math.random() * 1e10);
      if (!fakeIdToCallback.has(id)) return id;
    }
    throw new Error("error");
  };
  (({ clearInterval, clearTimeout }) => {
    global.setInterval = function <T extends any[]>(callback: (...args: T) => void, timeout?: number, ...args: T) {
      const fakeId = getFakeId();
      fakeIdToCallback.set(fakeId, () => callback(...args));
      worker.postMessage({ name: "setInterval", fakeId, timeout });
      return fakeId;
    };
    global.clearInterval = function (fakeId: number) {
      if (fakeIdToCallback.has(fakeId)) {
        fakeIdToCallback.delete(fakeId);
        worker.postMessage({ name: "clearInterval", fakeId });
      } else {
        clearInterval(fakeId);
      }
    };

    global.setTimeout = function <T extends any[]>(callback: (...args: T) => void, timeout?: number, ...args: T) {
      const fakeId = getFakeId();
      fakeIdToCallback.set(fakeId, () => {
        fakeIdToCallback.delete(fakeId);
        callback(...args);
      });
      worker.postMessage({ name: "setTimeout", fakeId, timeout });
      return fakeId;
    };
    global.clearTimeout = function (fakeId: number) {
      if (fakeIdToCallback.has(fakeId)) {
        fakeIdToCallback.delete(fakeId);
        worker.postMessage({ name: "clearTimeout", fakeId });
      } else {
        clearTimeout(fakeId);
      }
    };
  })(global);

  worker.onmessage = function ({ data }) {
    const callback = fakeIdToCallback.get(data);
    callback && callback();
  };
  worker.onerror = function (event) {
    console.error(event);
  };
}

export function requestAnimationFrameProxy(
  fps = 60,
  onVisible: (event?: any) => void = () => {},
  global: any = window
) {
  if (!String(global.requestAnimationFrame).endsWith("{ [native code] }")) {
    console.warn("重复加载");
    return;
  }
  setIntervalTimeoutProxy(global);

  const nativeRequest = global.requestAnimationFrame.bind(global);

  const taskMap = new Map<number, FrameRequestCallback>();
  let idCounter = 0;
  global.requestAnimationFrame = (rawCallback: FrameRequestCallback): number => {
    const id = idCounter++;
    const isVisible = !document.hidden; //document.visibilityState === "visible";
    const callback = (ts: number = performance.now()) => {
      if (!taskMap.has(id)) return;
      taskMap.delete(id);
      rawCallback(ts);
    };
    taskMap.set(id, rawCallback);
    if (isVisible) {
      nativeRequest(callback);
    } else {
      global.setTimeout(callback, 1000 / fps);
    }

    return id;
  };

  global.cancelAnimationFrame = taskMap.delete.bind(taskMap);

  const stopImmediatePropagation = (event?: any) => {
    if (document.hidden) {
      for (const k of [...taskMap.keys()]) {
        const callback = taskMap.get(k);
        callback && global.requestAnimationFrame(callback);
        global.cancelAnimationFrame(k);
      }
    }
    onVisible(event);
    return event?.stopImmediatePropagation();
  };
  stopImmediatePropagation();
  for (const event of [
    "visibilitychange",
    "mozvisibilitychange",
    "msvisibilitychange",
    "webkitvisibilitychange",
    "qbrowserVisibilityChange",
    "pagehide",
    "pageshow",
  ]) {
    window.addEventListener(event, stopImmediatePropagation, true);
    document.addEventListener(event, stopImmediatePropagation, true);
    document.body.addEventListener(event, stopImmediatePropagation, true);
  }
}
