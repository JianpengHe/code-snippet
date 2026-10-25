import * as crypto from "crypto";
import * as https from "https";
import * as stream from "stream";
import { XML } from "../../tools/dist/node/XML";

import type * as http from "http";
// 定义 XML 解析中需要处理成数组的路径节点
const LIST_ARRAY_KEYS = ["ListBucketResult/Contents", "ListBucketResult/CommonPrefixes"];

// --- 辅助工具函数 ---

/**
 * 腾讯云专用 URL 编码函数（符合 COS 签名规范：空格编码为 %20，保留特定字符）
 */
function cosUrlEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/**
 * 计算 HMAC-SHA1 的十六进制小写字符串
 */
function hmacSha1Hex(key: string, message: string): string {
  return crypto.createHmac("sha1", key).update(message).digest("hex");
}

/**
 * 计算 SHA1 的十六进制小写字符串
 */
function sha1Hex(message: string): string {
  return crypto.createHash("sha1").update(message).digest("hex");
}

/**
 * 确保路径以斜杠开头
 */
const formatPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const streamClose = (stream: stream.Stream) => new Promise((resolve, reject) => stream.once("close", resolve));

const isResOk = ({ statusCode }: http.IncomingMessage) => statusCode && statusCode >= 200 && statusCode < 300;

const getResText = (response: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const body: Buffer[] = [];
    response.on("data", chunk => body.push(chunk));
    response.on("error", reject);
    response.on("end", () => resolve(String(Buffer.concat(body))));
  });

export class QCloudCos {
  private readonly host: string;

  constructor(
    private readonly secretId: string,
    private readonly secretKey: string,
    bucket: string,
    region: string = "ap-guangzhou",
    private readonly commonHeaders: Record<string, string | string[]> = {},
    private readonly agent: https.Agent = new https.Agent({ keepAlive: true })
  ) {
    this.host = `${bucket}.cos.${region}.myqcloud.com`;
  }

  /**
   * 统一的腾讯云 COS 请求方法（内部自动完成 V5 签名并发送请求）
   * @param method HTTP 请求方法 (如 'GET', 'PUT', 'POST', 'DELETE')
   * @param pathname 请求的绝对路径 (如 '/' 或 '/example.png')
   * @param query URL 查询参数对象
   * @param customHeaders 自定义 HTTP 请求头对象
   * @param expires 签名有效时间（秒），默认 5 秒
   * @param body 请求体数据（仅用于 PUT / POST 等写入请求）
   */
  public async request(
    method: string,
    pathname: string,
    query: Record<string, string | number | boolean | null | undefined> = {},
    customHeaders: Record<string, string | string[]> = {},
    expires: number = 5,
    body?: stream.Readable | Buffer | string
  ): Promise<http.IncomingMessage> {
    // 1. 规范化请求头（确保包含小写的 host，并将自定义头转为小写及标准格式）
    const headers: Record<string, string> = {
      host: this.host,
      ...Object.fromEntries(
        (
          Object.entries({ ...this.commonHeaders, ...customHeaders }).map(([k, v]) =>
            v === undefined ? undefined : [k.toLowerCase(), Array.isArray(v) ? v.join(",") : String(v)]
          ) as any
        ).filter(Boolean)
      ),
    };

    // 2. 计算时间戳和 KeyTime（签名有效期）
    const now = Math.floor(Date.now() / 1000);
    const expiredTime = now + expires;
    const keyTime = `${now};${expiredTime}`;

    // 3. 生成 HMAC-SHA1 签名密钥 (SignKey)
    const signKey = hmacSha1Hex(this.secretKey, keyTime);

    // 4. 构造规范化请求串 HttpString
    const httpMethod = method.toLowerCase();

    // 4.1 URL 参数规范化（按 Key 字典序排序，Key 转小写，并进行特定的 URL 编码）
    const sortedQueryKeys = Object.keys(query).sort();
    const canonicalQueryString = sortedQueryKeys
      .map(key => {
        const val = query[key] !== undefined && query[key] !== null ? String(query[key]) : "";
        return `${cosUrlEncode(key.toLowerCase())}=${cosUrlEncode(val)}`;
      })
      .join("&");

    // 4.2 HTTP 头部规范化（按 Key 字典序排序）
    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaderString = sortedHeaderKeys
      .map(key => `${cosUrlEncode(key)}=${cosUrlEncode(headers[key].trim())}`)
      .join("&");

    // 拼接 HttpString（规范化方法\n规范化路径\n规范化Query\n规范化Header\n）
    const httpString = `${httpMethod}\n${pathname}\n${canonicalQueryString}\n${canonicalHeaderString}\n`;

    // 5. 构造待签名字符串 StringToSign 并计算最终签名 (Signature)
    const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
    const signature = hmacSha1Hex(signKey, stringToSign);

    // 6. 组装腾讯云 V5 标准的 Authorization 头部
    headers.authorization = [
      `q-sign-algorithm=sha1`,
      `q-ak=${this.secretId}`,
      `q-sign-time=${keyTime}`,
      `q-key-time=${keyTime}`,
      `q-header-list=${sortedHeaderKeys.join(";")}`,
      `q-url-param-list=${sortedQueryKeys.map(k => k.toLowerCase()).join(";")}`,
      `q-signature=${signature}`,
    ].join("&");

    // 7. 拼接最终请求完整 URL 并通过 https.request 发送，复用 Agent 连接
    const url = `https://${this.host}${pathname}${canonicalQueryString ? "?" + canonicalQueryString : ""}`;

    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = https.request(url, { method, headers, agent: this.agent }, resolve);
      req.on("error", reject);
      if (body instanceof stream.Readable) {
        body.pipe(req);
      } else {
        req.end(body);
      }
    });
  }

  /**
   * 列出某个目录下的文件（对应 GET Bucket / List Objects 接口，支持自动分页）
   * @param prefixPath 目录前缀（如 "images/"）
   * @param isSubdir 是否包含子目录（false 表示只查当前层级，true 表示递归平铺）
   * @param pageSize 最大返回条目数限制
   * @param nextFile 分页游标标记
   */
  public async list(prefixPath = "", isSubdir = false, pageSize = Infinity, nextFile = "") {
    const output: Map<string, { path: string; time: Date | null; size: number; etag: string }> = new Map();
    const setMap = (item: any) =>
      output.set(item.Key || item.Prefix, {
        path: item.Key || item.Prefix,
        time: item.LastModified ? new Date(item.LastModified) : null,
        size: Number(item.Size || 0),
        etag: item.ETag?.replace(/"/g, "") || "",
      });
    if (prefixPath.startsWith("/")) prefixPath = prefixPath.substring(1);
    while (pageSize > 0) {
      const response = await this.request("GET", "/", {
        prefix: prefixPath,
        delimiter: isSubdir ? "" : "/",
        marker: nextFile,
        "max-keys": Math.min(pageSize, 2000),
      });
      const responseText = await getResText(response);

      if (!isResOk(response)) throw new Error(`COS List Failed [${response.statusCode}]: ${responseText}`);

      const { IsTruncated, Contents, CommonPrefixes, MaxKeys, NextMarker } = XML.parse(responseText, ({ path }) =>
        LIST_ARRAY_KEYS.includes(path.join("/"))
      ).ListBucketResult;

      CommonPrefixes?.forEach(setMap);
      Contents?.forEach(setMap);

      if (IsTruncated === "false") break;
      nextFile = NextMarker;
      pageSize -= Number(MaxKeys);
    }

    return [...output.values()];
  }

  /**
   * 上传文件到 COS（对应 PUT Object 接口）
   * @param key 目标对象键（文件在 COS 中的路径，例如 "images/avatar.png"）
   * @param body 文件内容（支持 Buffer、Uint8Array、string、Blob、ReadableStream 等）
   * @param customHeaders 自定义请求头（可传入 content-type 等）
   */
  public async upload(
    key: string,
    body: stream.Readable | Buffer | string,
    customHeaders: Record<string, string | string[]> = {}
  ) {
    const response = await this.request("PUT", formatPath(key), {}, customHeaders, 5, body);
    const responseText = await getResText(response);

    if (!isResOk(response)) throw new Error(`COS Upload Failed [${response.statusCode}]: ${responseText}`);

    return {
      success: true,
      etag: response.headers?.["etag"]?.replace(/"/g, "") || "",
    };
  }

  /**
   * 追加文件内容到 COS（对应 POST Object - Append Object 接口）
   * @param key 对象键（路径，例如 "logs/app.log"）
   * @param body 追加的数据内容（支持 Buffer、string、ReadableStream 等）
   * @param position 追加起始位置（字节偏移量。首次追加传 0，后续追加需传入上一次返回的 nextAppendPosition）
   * @param customHeaders 自定义请求头
   */
  public async append(
    key: string,
    body: stream.Readable | Buffer | string,
    position: number = 0,
    customHeaders: Record<string, string | string[]> = {}
  ) {
    const response = await this.request("PUT", formatPath(key), { append: "", position }, customHeaders, 5, body);
    const responseText = await getResText(response);

    if (!isResOk(response)) throw new Error(`COS Append Failed [${response.statusCode}]: ${responseText}`);

    return {
      success: true,
      etag: response.headers?.["etag"]?.replace(/"/g, "") || "",
      size: Number(response.headers?.["content-length"] || 0),
      nextAppendPosition: Number(response.headers?.["x-cos-next-append-position"] || 0),
    };
  }

  /**
   * 从 COS 下载文件（对应 GET Object 接口）
   * @param key 对象键（文件在 COS 中的路径，例如 "images/avatar.png"）
   * @returns 返回兼容标准 Response 接口的对象，可通过 response.arrayBuffer() 或 response.text() 获取文件内容
   */
  public async download(key: string) {
    const response = await this.request("GET", formatPath(key));

    if (!isResOk(response))
      throw new Error(`COS Download Failed [${response.statusCode}]: ${await getResText(response)}`);

    return {
      success: true,
      etag: response.headers?.["etag"]?.replace(/"/g, "") || "",
      size: Number(response.headers?.["content-length"] || 0),
      stream: response,
    };
  }

  /**
   * 复制 COS 中的对象（对应 PUT Object - Copy 接口）
   * @param sourceKey 源对象键（路径）
   * @param targetKey 目标对象键（路径）
   */
  public async copy(sourceKey: string, targetKey: string) {
    const copySourceHeader = `${this.host}${formatPath(sourceKey).split("/").map(cosUrlEncode).join("/")}`;
    const response = await this.request("PUT", formatPath(targetKey), {}, { "x-cos-copy-source": copySourceHeader });
    const responseText = await getResText(response);

    if (!isResOk(response)) throw new Error(`COS Copy Failed [${response.statusCode}]: ${responseText}`);

    const result = XML.parse(responseText).CopyObjectResult;
    return {
      success: true,
      etag: result?.ETag?.replace(/"/g, "") || "",
      lastModified: result?.LastModified ? new Date(result.LastModified) : null,
    };
  }

  /**
   * 删除 COS 中的对象（对应 DELETE Object 接口）
   * @param key 对象键（路径）
   */
  public async delete(key: string) {
    const response = await this.request("DELETE", formatPath(key));
    const responseText = await getResText(response);

    // DELETE 成功通常返回 204 No Content
    if (!isResOk(response) && response.statusCode !== 204)
      throw new Error(`COS Delete Failed [${response.statusCode}]: ${responseText}`);

    return { success: true };
  }

  /**
   * 重命名 COS 中的对象（通过“复制到新路径 + 删除原路径”组合实现）
   * @param sourceKey 原对象键（路径）
   * @param targetKey 新对象键（路径）
   */
  public async rename(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) return { success: true };

    // 1. 先将文件复制到新路径
    const copyResult = await this.copy(sourceKey, targetKey);

    // 2. 复制成功后，安全删除原路径的文件
    await this.delete(sourceKey);

    return copyResult;
  }

  /**
   * 获取文件元信息
   * @param key 对象键（路径）
   */
  public async head(key: string) {
    const response = await this.request("HEAD", formatPath(key));
    const responseText = await getResText(response);
    if (!isResOk(response)) {
      // 如果文件不存在，返回 null
      if (response.statusCode === 404) return null;
      throw new Error(`COS Head Failed [${response.statusCode}]: ${responseText}`);
    }

    const lastModified = response.headers?.["last-modified"];
    return {
      success: true,
      size: Number(response.headers?.["content-length"] || 0),
      etag: response.headers?.["etag"]?.replace(/"/g, "") || "",
      lastModified: lastModified ? new Date(lastModified) : null,
    };
  }
}

// 测试用例
// import * as fs from "fs";
// async function run() {
//   // 实例化时传入 secretId, secretKey, 存储桶名称(带 appId), 地域
//   const cos = new QCloudCos("xxxxxx", "xxxxxx", "temp-125000000", "ap-guangzhou", {
//     "x-cos-forbid-overwrite": "true",
//   });
//   const result = await cos.list("images/", false, 10);
//   console.log(result, result.length);
//   /** 下载文件 */
//   const writeStream = fs.createWriteStream("./avatar.png");
//   (await cos.download(result[0].path)).stream.pipe(writeStream);
//   await streamClose(writeStream);
//   /** 删除文件 */
//   console.log(await cos.delete("avatar.png"));
//   /** 上传文件 */
//   console.log(await cos.upload("t.png", fs.createReadStream("./avatar.png")));
//   /** 复制文件 */
//   console.log(await cos.copy("t.png", "t2.png"));
//   /** 重命名文件 */
//   console.log(await cos.rename("t2.png", "t3.png"));
//   /** 获取文件元信息 */
//   const headResult = await cos.head("1.txt");
//   console.log(headResult);
//   /** 追加文件 */
//   console.log(await cos.append("1.txt", fs.createReadStream("1.txt"), headResult?.size || 0));
// }

// run();
