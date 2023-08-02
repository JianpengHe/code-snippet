"use strict";
var EId;
(function (EId) {
    EId[EId["A"] = 1] = "A";
    EId[EId["B"] = 2] = "B";
})(EId || (EId = {}));
class Test {
    send(id, req) {
        return new Promise(r => {
            r(8);
        });
    }
    onRequest(id, cb) { }
    onMessage(id, cb) { }
    async hookMessage(id, cb) {
        return 0;
    }
}
const a = new Test();
a.send(EId.B, { id2: 5 });
a.onRequest(2, (res, req) => { });
//# sourceMappingURL=TS%E6%8C%89%E7%85%A7key%E7%B2%BE%E7%A1%AE%E6%8F%90%E7%A4%BA.js.map