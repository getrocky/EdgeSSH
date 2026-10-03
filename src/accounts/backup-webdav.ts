import { APIError } from './http.ts';

export interface WebDAVTarget {
  url: string;
  username: string;
  password: string;
}

export interface RemoteEntry {
  name: string;
  size: number;
  modifiedAt: number;
}

const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_REMOTE_BYTES = 8 * 1024 * 1024;

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata', 'metadata.google.internal', 'metadata.goog',
]);

function isBlockedIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;            // 链路本地，含云厂商 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;              // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;  // 运营商级 NAT
  if (a >= 224) return true;                          // 组播与保留段
  return false;
}

function isBlockedIPv6(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!address.includes(':')) return false;
  if (address === '::' || address === '::1') return true;
  if (/^f[cd]/.test(address)) return true;            // fc00::/7 唯一本地
  if (address.startsWith('fe80')) return true;        // 链路本地
  if (address.startsWith('ff')) return true;          // 组播
  // IPv4 映射地址必须按内嵌的 IPv4 判断，否则可绕过上面的私网拦截。
  // URL 会把 ::ffff:10.0.0.1 归一化成十六进制的 ::ffff:a00:1，两种写法都要覆盖。
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) return isBlockedIPv4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex) {
    const high = Number.parseInt(hex[1], 16), low = Number.parseInt(hex[2], 16);
    return isBlockedIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'));
  }
  return false;
}

/**
 * WebDAV 地址由用户填写，会变成 Worker 的出站请求；必须在这里拦截内网目标，
 * 不能依赖运行时自身的限制，否则备份配置会变成 SSRF 入口。
 */
export function validateWebDAVURL(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new APIError('请填写 WebDAV 地址。');
  if (value.length > 2048) throw new APIError('WebDAV 地址过长。');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new APIError('WebDAV 地址格式无效。'); }
  if (url.protocol !== 'https:') throw new APIError('WebDAV 地址必须使用 HTTPS。');
  if (url.username || url.password) throw new APIError('请不要把账号密码写在地址里，使用下方的账号与密码字段。');
  if (url.search || url.hash) throw new APIError('WebDAV 地址不能包含查询参数或片段。');
  const hostname = url.hostname.toLowerCase();
  if (!hostname) throw new APIError('WebDAV 地址缺少主机名。');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new APIError('不允许备份到本机或内网地址。');
  }
  if (isBlockedIPv4(hostname) || isBlockedIPv6(hostname)) throw new APIError('不允许备份到本机或内网地址。');
  // 统一以 / 结尾，后续拼接文件名时不必再处理两种形态。
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/`;
}

export function validateRemoteName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new APIError('备份文件名无效。');
  if (value === '.' || value === '..') throw new APIError('备份文件名无效。');
  return value;
}

function authorization(target: WebDAVTarget): string {
  return `Basic ${btoa(`${target.username}:${target.password}`)}`;
}

async function send(target: WebDAVTarget, path: string, init: RequestInit & { depth?: string }): Promise<Response> {
  const { depth, ...options } = init;
  const headers = new Headers(options.headers);
  headers.set('Authorization', authorization(target));
  if (depth) headers.set('Depth', depth);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    // redirect: 'manual' 阻止 3xx 把请求带去未经校验的地址，绕过上面的内网检查。
    return await fetch(`${target.url}${path}`, { ...options, headers, redirect: 'manual', signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new APIError('WebDAV 服务器响应超时。', 504);
    throw new APIError('无法连接 WebDAV 服务器，请检查地址与网络。', 502);
  }
}

function assertOK(response: Response, action: string): void {
  if (response.status >= 300 && response.status < 400) throw new APIError(`WebDAV ${action}被重定向，请改用最终地址。`, 502);
  if (response.status === 401 || response.status === 403) throw new APIError('WebDAV 账号或密码不正确。', 502);
  if (response.status === 507 || response.status === 413) throw new APIError('WebDAV 存储空间不足。', 502);
  if (!response.ok) throw new APIError(`WebDAV ${action}失败（HTTP ${response.status}）。`, 502);
}

/** 目录可能已存在；MKCOL 返回 405/301 都视为可用。 */
export async function ensureCollection(target: WebDAVTarget): Promise<void> {
  const response = await send(target, '', { method: 'MKCOL' });
  if (response.ok || response.status === 405 || response.status === 301) return;
  assertOK(response, '创建目录');
}

export async function putFile(target: WebDAVTarget, name: string, body: string): Promise<void> {
  const response = await send(target, encodeURIComponent(name), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assertOK(response, '上传');
}

export async function getFile(target: WebDAVTarget, name: string): Promise<string> {
  const response = await send(target, encodeURIComponent(name), { method: 'GET' });
  if (response.status === 404) throw new APIError('远端备份文件不存在。', 404);
  assertOK(response, '下载');
  const declared = Number(response.headers.get('Content-Length') ?? 0);
  if (declared > MAX_REMOTE_BYTES) throw new APIError('远端备份文件过大。', 413);
  if (!response.body) throw new APIError('远端备份文件为空。', 502);
  // 不信任 Content-Length，边读边限制实际大小。
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_REMOTE_BYTES) { await reader.cancel(); throw new APIError('远端备份文件过大。', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function deleteFile(target: WebDAVTarget, name: string): Promise<void> {
  const response = await send(target, encodeURIComponent(name), { method: 'DELETE' });
  if (response.status === 404) return;
  assertOK(response, '删除');
}

/** 用正则解析 PROPFIND：Workers 没有 XML 解析器，备份清单结构足够简单。 */
export function parsePropfind(xml: string, prefix: string): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  for (const block of xml.split(/<\/(?:[a-zA-Z0-9]+:)?response>/)) {
    if (/<(?:[a-zA-Z0-9]+:)?collection\s*\/?>/.test(block)) continue;
    const href = /<(?:[a-zA-Z0-9]+:)?href>([^<]*)<\/(?:[a-zA-Z0-9]+:)?href>/.exec(block);
    if (!href) continue;
    let name: string;
    try { name = decodeURIComponent(href[1].replace(/\/+$/, '').split('/').pop() ?? ''); } catch { continue; }
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const size = /<(?:[a-zA-Z0-9]+:)?getcontentlength>(\d+)<\/(?:[a-zA-Z0-9]+:)?getcontentlength>/.exec(block);
    const modified = /<(?:[a-zA-Z0-9]+:)?getlastmodified>([^<]*)<\/(?:[a-zA-Z0-9]+:)?getlastmodified>/.exec(block);
    const timestamp = modified ? Date.parse(modified[1]) : Number.NaN;
    entries.push({
      name,
      size: size ? Number(size[1]) : 0,
      modifiedAt: Number.isFinite(timestamp) ? timestamp : 0,
    });
  }
  return entries;
}

export async function listFiles(target: WebDAVTarget, prefix: string): Promise<RemoteEntry[]> {
  const response = await send(target, '', {
    method: 'PROPFIND',
    depth: '1',
    headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>`,
  });
  if (response.status === 404) return [];
  assertOK(response, '读取目录');
  return parsePropfind(await response.text(), prefix);
}

export async function verifyTarget(target: WebDAVTarget): Promise<void> {
  await ensureCollection(target);
  const probe = `.edgessh-write-test-${crypto.randomUUID()}.json`;
  await putFile(target, probe, JSON.stringify({ probe: true, at: Date.now() }));
  await deleteFile(target, probe);
}
