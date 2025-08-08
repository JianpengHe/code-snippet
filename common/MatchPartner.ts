export class MatchPartner<T extends object, ID = string> {
  /** 等待匹配的 ID 队列 */
  private readonly waitingQueue: ID[] = [];

  /** ID 到对象的映射 */
  private readonly objectMap = new Map<ID, T>();

  /** 对象到其配对对象 ID 的映射（弱引用） */
  private readonly partnerIdMap = new WeakMap<T, ID>();

  /**
   * 添加一个待匹配对象。如果该 ID 已存在，会先删除旧对象。
   * 如果等待队列中有对象可配对，会自动完成配对。
   *
   * @param id 新对象的唯一标识
   * @param obj 新对象本身
   * @param onDeleted 如果该 ID 已有旧对象，则在替换前触发回调
   */
  public add(id: ID, obj: T, onDeleted?: (oldObj: T) => void) {
    const oldObj = this.objectMap.get(id);

    // 如果 ID 已存在，先清理旧对象和它的配对
    if (oldObj) {
      onDeleted?.(oldObj);
      this.del(oldObj, id);
      // 同时从等待队列中移除旧 ID（如果存在）
      const index = this.waitingQueue.indexOf(id);
      if (index !== -1) this.waitingQueue.splice(index, 1);
    }

    this.objectMap.set(id, obj);

    // 查找等待队列中的对象，尝试配对
    let partnerId: ID | undefined;
    while ((partnerId = this.waitingQueue.shift()) !== undefined) {
      const partnerObj = this.objectMap.get(partnerId);
      if (!partnerObj) {
        partnerId = undefined;
        continue;
      } // 如果对象已经不存在，跳过
      console.log("匹配成功", id, partnerId);
      this.partnerIdMap.set(obj, partnerId);
      this.partnerIdMap.set(partnerObj, id);
      break;
    }
    if (partnerId === undefined) {
      console.log("暂无配对对象，等待匹配，当前匹配队列长度", this.waitingQueue.length);
      this.waitingQueue.push(id);
    }
    return this;
  }

  /**
   * 删除某个对象及其配对关系。
   * 若有配对对象，将其重新放入等待队列中。
   *
   * @param obj 要删除的对象
   */
  public del(obj: T, id?: ID) {
    const partnerId = this.partnerIdMap.get(obj);
    this.partnerIdMap.delete(obj);

    if (partnerId) {
      // 将配对对象重新放入等待队列
      this.waitingQueue.push(partnerId);
      const partnerObj = this.objectMap.get(partnerId);
      if (partnerObj) this.partnerIdMap.delete(partnerObj);
    }
    if (id === undefined) {
      for (const [key, value] of this.objectMap) {
        if (value === obj) {
          console.log("找到残留项", key);
          id = key;
          break;
        }
      }
    }
    if (id !== undefined) {
      console.log("清理ID映射表objectMap", id);
      this.objectMap.delete(id);
    }
    return this;
  }

  /**
   * 根据对象获取它的配对对象
   */
  public getPartnerObj(obj: T) {
    const partnerId = this.getPartnerId(obj);
    if (!partnerId) return undefined;
    return this.getObjById(partnerId);
  }

  /**
   * 根据对象获取它的配对 ID（如果有）
   */
  public getPartnerId(obj: T) {
    return this.partnerIdMap.get(obj);
  }

  /**
   * 根据 ID 获取配对对象的 ID
   */
  public getPartnerIdById(id: ID) {
    const obj = this.objectMap.get(id);
    if (!obj) return undefined;
    return this.getPartnerId(obj);
  }
  /**
   * 根据 ID 获取对象
   */
  public getObjById(id: ID) {
    return this.objectMap.get(id);
  }
}

// 测试用例
// const matchPartner = new MatchPartner<{ id: string }>();
// const a = { id: "1" };
// const b = { id: "2" };
// const c = { id: "3" };
// const d = { id: "4" };

// matchPartner.add("1", a);
// matchPartner.add("1", b);
// matchPartner.add("2", c);
// matchPartner.add("2", d);
// matchPartner.del(a);

// console.log(
//   matchPartner.getObjById("1"),
//   matchPartner.getObjById("2"),
//   matchPartner.getPartnerObj(a),
//   matchPartner.getPartnerObj(b),
//   matchPartner.getPartnerObj(c),
//   matchPartner.getPartnerObj(d),
//   matchPartner
// );
