(global => {
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
})(window as any);
