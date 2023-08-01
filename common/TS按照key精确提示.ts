enum EId {
    A = 1,
    /** 哈哈哈 */
    B
}
type IReq = {
    1: { id: number }
    2: { id2: number }
}
type IRes = {
    1: { name: number }
    2: { name2: number }
}

class Test<ReqList, ResList>{
    public send<Id extends (keyof ReqList & keyof ResList)>(id: Id, req: ReqList[Id]): Promise<ResList[Id]> {
        //id=3
        return new Promise(r => {
            r(8)
        })
    }

    public onRequest<Id extends (keyof ReqList & keyof ResList)>(id: Id, cb: (res: ResList[Id], req: ReqList[Id]) => void): void {

    }
    public onMessage<Id extends keyof ResList>(id: Id, cb: (res: ResList[Id]) => void): void {

    }

    public async hookMessage<Id extends keyof ResList>(id: Id, cb: (res: ResList[Id]) => void): Promise<ResList[Id]> {
        return 0
    }
}


const a = new Test<IReq, IRes>();
a.send(EId.B, { id: 5 });

a.onRequest(2, (res, req) => {

})