"use strict";
class MyEvent {
    eventListenerMap = new Map();
    eventDisposableListenerMap = new Map();
    on(eventName, callback) {
        const newListenerSet = new Set();
        const listenerSetByEventName = this.eventListenerMap.get(eventName) ?? (this.eventListenerMap.set(eventName, newListenerSet), newListenerSet);
        listenerSetByEventName.add(callback);
        return this;
    }
    once(eventName, callback) {
        const newListenerSet = new Set();
        const disposableListenerSetByEventName = this.eventDisposableListenerMap.get(eventName) ??
            (this.eventDisposableListenerMap.set(eventName, newListenerSet), newListenerSet);
        disposableListenerSetByEventName.add(callback);
        return this.on(eventName, callback);
    }
    off(eventName, callback) {
        this.eventListenerMap.get(eventName)?.delete(callback);
        this.eventDisposableListenerMap.get(eventName)?.delete(callback);
        return this;
    }
    emit(eventName, ...args) {
        const listenerSetByEventName = this.eventListenerMap.get(eventName);
        const disposableListenerSetByEventName = this.eventDisposableListenerMap.get(eventName);
        if (listenerSetByEventName) {
            for (const callback of listenerSetByEventName) {
                callback.apply(this, args);
                if (disposableListenerSetByEventName?.has(callback)) {
                    disposableListenerSetByEventName.delete(callback);
                    listenerSetByEventName.delete(callback);
                }
            }
        }
        return this;
    }
}
const myEvent = new MyEvent();
myEvent.on("run", id => {
    console.log("on run", id);
});
myEvent.once("run", id => {
    console.log("once run", id);
});
const callback = (msg, times) => {
    console.log("on jump", msg, times);
};
myEvent.on("jump", callback);
myEvent.on("jump", (msg, times) => {
    console.log("on jump2", msg, times);
});
myEvent.emit("run", 1);
myEvent.emit("jump", "ok", 4);
setTimeout(() => {
    myEvent.off("jump", callback);
    myEvent.emit("run", 2);
    myEvent.emit("jump", "ok2", 8);
}, 500);
//# sourceMappingURL=%E6%89%8B%E5%86%99%E4%BA%8B%E4%BB%B6.js.map