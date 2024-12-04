import * as stream from "stream";
import * as crypto from "crypto";

export class CipherGCM {
  private readonly key: crypto.CipherKey;
  private readonly algorithm: crypto.CipherGCMTypes;
  constructor(password: crypto.BinaryLike, algorithm: crypto.CipherGCMTypes = "aes-256-gcm") {
    this.key = crypto.createHash("sha3-256").update(password).digest();
    this.algorithm = algorithm;
  }
  public encrypt(input: stream.Readable, output: stream.Writable, iv = crypto.randomBytes(12)) {
    output.write(iv);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    input.pipe(cipher);
    cipher.pipe(output, { end: false });
    cipher.once("end", () => output.end(cipher.getAuthTag()));
  }
  public decrypt(input: stream.Readable, output: stream.Writable) {
    let decipher: crypto.DecipherGCM;
    let curBuffer = Buffer.allocUnsafe(0);
    const writeCurBuffer = () => {
      if (curBuffer.length <= 16) return true;
      const buf = curBuffer.subarray(0, curBuffer.length - 16);
      curBuffer = curBuffer.subarray(curBuffer.length - 16);
      return decipher.write(buf);
    };
    let writableNeedDrain: Promise<void> | undefined;
    input.on("readable", async () => {
      let data: Buffer;
      if (!decipher) {
        if (!(data = input.read(12)) || (data.length ?? 0) < 12) {
          /** 读不够12字节 */
          input.unshift(data);
          return;
        }
        decipher = crypto.createDecipheriv(this.algorithm, this.key, new Uint8Array(data));
        decipher.pipe(output);
      }

      if (decipher.writableNeedDrain) {
        if (writableNeedDrain) {
          // console.log("writableNeedDrain");
          return;
        }
        writableNeedDrain = new Promise<void>(r => decipher.once("drain", r));
        await writableNeedDrain;
        writableNeedDrain = undefined;
      }

      while ((data = input.read()) !== null) {
        curBuffer = Buffer.concat([curBuffer, data]);
        if (writeCurBuffer() === false) return;
      }
    });

    input.once("end", () => {
      writeCurBuffer();
      decipher.setAuthTag(curBuffer.subarray(curBuffer.length - 16));
      curBuffer = Buffer.allocUnsafe(0);
      decipher.end();
    });
  }
}

/** 测试用例 */
// import * as fs from "fs";
// const cipherGCM = new CipherGCM("666");
// const file = __dirname;

// // cipherGCM.encrypt(fs.createReadStream(file), fs.createWriteStream(file + ".enc"));

// cipherGCM.decrypt(fs.createReadStream(file + ".enc"), fs.createWriteStream(file + ".2"));
