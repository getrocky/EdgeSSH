import { APIError } from './http.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const BACKUP_FORMAT = 'edgessh-backup';
export const BACKUP_VERSION = 1;
const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 512;

export interface BackupContents {
  hosts: BackupRecord[];
  snippets: BackupRecord[];
  forwardRules: BackupRecord[];
}

export interface BackupRecord {
  id: string;
  updatedAt: number;
  payload: unknown;
}

/** 备份包的外层结构；密文之外的字段都是解密所需的公开参数。 */
export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: 'AES-GCM';
  iv: string;
  ciphertext: string;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function validatePassphrase(value: unknown): string {
  if (typeof value !== 'string') throw new APIError('备份口令格式无效。');
  // 不做 trim：前后空格是口令的一部分，静默删掉会让恢复时对不上。
  if (value.length < MIN_PASSPHRASE_LENGTH) throw new APIError(`备份口令至少需要 ${MIN_PASSPHRASE_LENGTH} 个字符。`);
  if (value.length > MAX_PASSPHRASE_LENGTH) throw new APIError(`备份口令不能超过 ${MAX_PASSPHRASE_LENGTH} 个字符。`);
  return value;
}

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 用独立口令加密备份包，而不是复用 ENCRYPTION_KEY。
 * Cloudflare 不提供 Secret 明文读回，若沿用该密钥，备份在重新部署后将无法解开。
 */
export async function sealBackup(contents: BackupContents, passphrase: string): Promise<BackupEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const createdAt = Date.now();
  const header = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt } as const;
  const key = await derive(passphrase, salt, PBKDF2_ITERATIONS);
  // 头部进 AAD，防止篡改版本或时间戳后仍能解密。
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: encoder.encode(JSON.stringify(header)) },
    key,
    encoder.encode(JSON.stringify(contents)),
  );
  return {
    ...header,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: base64(salt) },
    cipher: 'AES-GCM',
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
}

function records(value: unknown, label: string): BackupRecord[] {
  if (!Array.isArray(value)) throw new APIError(`备份包中的${label}数据已损坏。`);
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new APIError(`备份包中的${label}数据已损坏。`);
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id)) throw new APIError(`备份包中的${label}记录缺少有效标识。`);
    if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) throw new APIError(`备份包中的${label}记录缺少时间。`);
    if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
      throw new APIError(`备份包中的${label}记录内容无效。`);
    }
    return { id: record.id, updatedAt: record.updatedAt, payload: record.payload };
  });
}

export function parseEnvelope(value: unknown): BackupEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new APIError('备份文件格式无效。');
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== BACKUP_FORMAT) throw new APIError('这不是 EdgeSSH 备份文件。');
  if (envelope.version !== BACKUP_VERSION) throw new APIError('备份文件版本不受支持，请使用同版本的 EdgeSSH 恢复。');
  if (typeof envelope.createdAt !== 'number' || !Number.isFinite(envelope.createdAt)) throw new APIError('备份文件缺少创建时间。');
  const kdf = envelope.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || typeof kdf.salt !== 'string') {
    throw new APIError('备份文件的密钥参数无效。');
  }
  // 上限防止构造超大迭代数的文件耗尽 Worker CPU。
  if (typeof kdf.iterations !== 'number' || !Number.isInteger(kdf.iterations) || kdf.iterations < 100_000 || kdf.iterations > 1_000_000) {
    throw new APIError('备份文件的密钥参数无效。');
  }
  if (envelope.cipher !== 'AES-GCM' || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new APIError('备份文件的加密参数无效。');
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: envelope.createdAt,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt: kdf.salt },
    cipher: 'AES-GCM',
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  };
}

export async function openBackup(envelope: BackupEnvelope, passphrase: string): Promise<BackupContents> {
  const header = { format: envelope.format, version: envelope.version, createdAt: envelope.createdAt } as const;
  let plaintext: ArrayBuffer;
  try {
    const key = await derive(passphrase, unbase64(envelope.kdf.salt), envelope.kdf.iterations);
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(envelope.iv), additionalData: encoder.encode(JSON.stringify(header)) },
      key,
      unbase64(envelope.ciphertext),
    );
  } catch {
    throw new APIError('备份口令不正确，或文件已损坏。', 400);
  }
  let contents: unknown;
  try { contents = JSON.parse(decoder.decode(plaintext)); } catch { throw new APIError('备份内容已损坏。'); }
  if (!contents || typeof contents !== 'object' || Array.isArray(contents)) throw new APIError('备份内容已损坏。');
  const parsed = contents as Record<string, unknown>;
  return {
    hosts: records(parsed.hosts, '主机'),
    snippets: records(parsed.snippets, '代码片段'),
    forwardRules: records(parsed.forwardRules, '转发规则'),
  };
}
