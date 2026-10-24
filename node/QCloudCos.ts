import * as crypto from "crypto";
import * as stream from "stream";
import { XML } from "../../tools/dist/node/XML";

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
export class QCloudCos {
  private readonly host: string;

  constructor(
    private readonly secretId: string,
    private readonly secretKey: string,
    bucket: string,
    region: string = "ap-guangzhou"
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
    body?: BodyInit | null
  ): Promise<Response> {
    // 1. 规范化请求头（确保包含小写的 host，并将自定义头转为小写及标准格式）
    const headers: Record<string, string> = {
      host: this.host,
      ...Object.fromEntries(
        (
          Object.entries(customHeaders).map(([k, v]) =>
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

    // 7. 拼接最终请求完整 URL 并通过原生 fetch 发送
    const url = `https://${this.host}${pathname}${canonicalQueryString ? "?" + canonicalQueryString : ""}`;

    return fetch(url, {
      method: httpMethod,
      headers,
      body,
      ...(body ? { duplex: "half" } : {}),
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

    while (pageSize > 0) {
      const response = await this.request("GET", "/", {
        prefix: prefixPath,
        delimiter: isSubdir ? "" : "/",
        marker: nextFile,
        "max-keys": Math.min(pageSize, 2000),
      });

      if (!response.ok) throw new Error(`COS List Failed [${response.status}]: ${await response.text()}`);

      const { IsTruncated, Contents, CommonPrefixes, MaxKeys, NextMarker } = XML.parse(
        await response.text(),
        ({ path }) => LIST_ARRAY_KEYS.includes(path.join("/"))
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
  public async upload(key: string, body: BodyInit, customHeaders: Record<string, string | string[]> = {}) {
    // 确保 COS 对象路径以斜杠开头
    const pathname = key.startsWith("/") ? key : `/${key}`;

    // 上传文件使用 PUT 方法，赋予较长的签名有效期（如 300 秒）
    const response = await this.request("PUT", pathname, {}, customHeaders, 300, body);

    if (!response.ok) throw new Error(`COS Upload Failed [${response.status}]: ${await response.text()}`);

    // 返回状态码和文件的 ETag 标识
    return {
      status: response.status,
      etag: response.headers.get("etag")?.replace(/"/g, "") || "",
    };
  }

  /**
   * 从 COS 下载文件（对应 GET Object 接口）
   * @param key 对象键（文件在 COS 中的路径，例如 "images/avatar.png"）
   * @returns 返回 fetch 的 Response 对象，可通过 response.arrayBuffer() 或 response.text() 获取文件内容
   */
  public async download(key: string): Promise<Response> {
    // 确保 COS 对象路径以斜杠开头
    const pathname = key.startsWith("/") ? key : `/${key}`;

    const response = await this.request("GET", pathname);

    if (!response.ok) throw new Error(`COS Download Failed [${response.status}]: ${await response.text()}`);

    return response;
  }
}

export const ResponseBodyToReadableStream = stream.Readable.fromWeb as unknown as (
  response: ReadableStream<any>
) => stream.Readable;

export const ReadableStreamToRequestBody = stream.Readable.toWeb as unknown as (stream: stream.Readable) => BodyInit;

// 测试用例
// import * as fs from "fs";
// async function run() {
//   // 实例化时传入 secretId, secretKey, 存储桶名称(带 appId), 地域
//   const cos = new QCloudCos("xxxxxx", "xxxxxx", "temp-125xxxxxx", "ap-guangzhou");
//   const result = await cos.list("images/", false, 10);
//   console.log(result, result.length);
//   /** 下载文件 */
//   ResponseBodyToReadableStream((await cos.download(result[0].path)).body!).pipe(fs.createWriteStream("./avatar.png"));
//   /** 上传文件 */
//   console.log(await cos.upload("t.png", ReadableStreamToRequestBody(fs.createReadStream("./avatar.png"))));
// }

// run();
