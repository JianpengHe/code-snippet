export const isServer = typeof window === "undefined";

const fs = isServer ? ((0, eval)("require")("fs") as typeof import("fs")) : undefined;

const localStorage = isServer ? undefined : globalThis.localStorage;

/**
 * 单个数据项的存储配置。
 *
 * @template T 数据项的类型。
 *
 * @example
 * ```ts
 * const storage: IDataStorage<number> = {
 *   data: 0,
 *   read: value => Number(value),
 *   write: value => String(value),
 * };
 * ```
 */
export type IDataStorage<T = string> = {
  /** 当前数据项的值，也是数据不存在时使用的默认值。 */
  data: T;

  /** 从持久化数据中读取并转换为实际使用的数据类型。 */
  read: (value: string) => T | Promise<T>;

  /** 将当前数据转换为可持久化的字符串。 */
  write: (value: T) => string | Promise<string>;
};

/**
 * 管理一组具有独立数据类型的数据。
 *
 * 每个数据项都可以单独定义读取、写入和数据类型。
 * 在 Node.js 环境下使用文件系统持久化，在浏览器环境下使用 localStorage。
 *
 * @template T 数据项配置对象的类型。
 *
 * @example
 * ```ts
 * const storage = new DataStorage({
 *   username: {
 *     data: "guest",
 *     read: value => value,
 *     write: value => value,
 *   },
 *   age: {
 *     data: 18,
 *     read: value => Number(value),
 *     write: value => String(value),
 *   },
 * });
 *
 * storage.get("username"); // string
 * storage.get("age");      // number
 *
 * storage.set("username", "Tom");
 * storage.set("age", 20);
 * ```
 */
export class DataStorage<T extends Record<string, IDataStorage<any>>> {
  /** 当前各数据项的配置和数据。 */
  private readonly dataMap: Partial<T> = {};
  /** 等待初始化 */
  public isInitialized: Promise<void>;

  constructor(
    /** 各数据项的默认值以及数据转换方式。 */
    private readonly storage: T,

    /** 持久化存储使用的路径或 key 前缀。 */
    private readonly storagePath: string
  ) {
    this.isInitialized = this.syncAll();
  }

  /**
   * 从持久化存储中同步所有数据项。
   *
   * 如果某个数据项不存在，则继续使用初始化时设置的默认值。
   */
  public async syncAll(): Promise<void> {
    for (const key in this.storage) await this.sync(key);
  }

  /**
   * 从持久化存储中同步指定数据项。
   *
   * 如果对应数据不存在，则保留该数据项当前的值。
   *
   * @param key 要同步的数据项名称。
   */
  public async sync<K extends keyof T>(key: K): Promise<void> {
    const storage = this.storage[key];
    const storedValue = this.readFile(this.storagePath + String(key));

    this.dataMap[key] = {
      ...storage,

      // 持久化数据不存在时使用配置中提供的默认值。
      data: storedValue === undefined ? storage.data : await storage.read(storedValue),
    };
  }

  /**
   * 获取指定数据项的当前值。
   *
   * 返回值类型会根据 key 自动推导。
   *
   * @param key 要获取的数据项名称。
   * @returns 对应数据项的当前值。
   *
   * @example
   * ```ts
   * const username = storage.get("username"); // string
   * const age = storage.get("age");           // number
   * ```
   */
  public get<K extends keyof T>(key: K): T[K]["data"] {
    const storage = this.dataMap[key];
    if (!storage) throw new Error("key not found");
    return storage.data;
  }

  /**
   * 更新指定数据项的值，并立即持久化。
   *
   * value 的类型会根据 key 自动推导。
   *
   * @param key 要更新的数据项名称。
   * @param value 要设置的新值。
   *
   * @example
   * ```ts
   * storage.set("username", "Tom");
   * storage.set("age", 20);
   * ```
   */
  public set<K extends keyof T>(key: K, value: T[K]["data"]): void {
    const storage = this.dataMap[key];
    if (!storage) throw new Error("key not found");
    storage.data = value;
    (async () => {
      let writeValue = storage.write(value);
      if (writeValue instanceof Promise) writeValue = await writeValue;
      this.writeFile(this.storagePath + String(key), writeValue);
    })();
  }

  /**
   * 从持久化存储中读取字符串。
   *
   * Node.js 环境使用文件系统，浏览器环境使用 localStorage。
   *
   * @param path 要读取的文件路径或 localStorage key。
   * @returns 保存的数据；不存在时返回 undefined。
   */
  public readFile(path: string): string | undefined {
    if (!this.storagePath) return undefined;
    try {
      if (fs) return String(fs.readFileSync(path, "utf-8"));
      if (localStorage) return localStorage.getItem(path) ?? undefined;
    } catch (err) {
      console.log(err);
    }

    return undefined;
  }

  /**
   * 将字符串写入持久化存储。
   *
   * Node.js 环境写入文件，浏览器环境写入 localStorage。
   *
   * @param path 要写入的文件路径或 localStorage key。
   * @param value 要保存的字符串。
   */
  public writeFile(path: string, value: string): void {
    if (fs) return fs.writeFileSync(path, value);
    if (localStorage) return localStorage.setItem(path, value);
  }
}

// 测试用例
// const dataStorage = new DataStorage(
//   {
//     name: {
//       write: a => a,
//       read: a => a,
//       data: "a1",
//     },
//     age: {
//       write: a => a,
//       read: a => a,
//       data: 123,
//     },
//     family: {
//       write: a => a,
//       read: a => a,
//       data: {
//         mom: "mom",
//         dad: "dad",
//       },
//     },
//   },
//   "data/"
// );

// const a = dataStorage.get("family");
