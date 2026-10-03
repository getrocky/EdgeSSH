import type { Env } from '../types.ts';
import { decryptHost, encryptHost } from './crypto.ts';
import { APIError } from './http.ts';
import {
  openBackup, parseEnvelope, sealBackup, validatePassphrase,
  type BackupContents, type BackupEnvelope, type BackupRecord,
} from './backup-crypto.ts';
import {
  deleteFile, ensureCollection, getFile, listFiles, putFile, validateRemoteName, validateWebDAVURL,
  type WebDAVTarget,
} from './backup-webdav.ts';
import { validateSnippet } from './snippets.ts';
import { validateForwardRule } from './forward-rules.ts';
import { validateHostPayload } from './hosts.ts';
import { DEFAULT_SCHEDULE, validateSchedule, type BackupSchedule } from './backup-schedule.ts';

export interface BackupSettings {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  passphrase: string;
  prefix: string;
  keep: number;
  schedule: BackupSchedule;
}

export interface BackupRunRecord {
  id: string;
  startedAt: number;
  trigger: 'manual' | 'scheduled';
  status: 'success' | 'failure';
  remoteName: string | null;
  size: number | null;
  counts: { hosts: number; snippets: number; forwardRules: number } | null;
  error: string | null;
}

type Table = 'hosts' | 'snippets' | 'forward_rules';

interface Row { id: string; encrypted_payload: string; updated_at: number }

const SETTINGS_AAD = 'backup:settings';
const MAX_KEEP = 60;
const RUN_HISTORY_LIMIT = 20;

/** 各表的 AAD 前缀必须与原有读写路径一致，否则恢复后的密文解不开。 */
const AAD_PREFIX: Record<Table, (id: string) => string> = {
  hosts: (id) => id,
  snippets: (id) => `snippet:${id}`,
  forward_rules: (id) => `forward-rule:${id}`,
};

function sanitizePrefix(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'edgessh';
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,48}$/.test(value)) throw new APIError('文件名前缀只能包含字母、数字、点、下划线和短横线。');
  return value;
}

export function validateBackupSettings(body: Record<string, unknown>, previous?: BackupSettings): BackupSettings {
  const url = validateWebDAVURL(body.url);
  const username = body.username;
  if (typeof username !== 'string' || !username || username.length > 256) throw new APIError('请填写 WebDAV 账号。');
  // 密码与口令留空表示沿用已保存的值，避免每次改配置都要重新输入。
  const password = body.password === undefined || body.password === ''
    ? previous?.password : body.password;
  if (typeof password !== 'string' || !password || password.length > 512) throw new APIError('请填写 WebDAV 密码。');
  const rawPassphrase = body.passphrase === undefined || body.passphrase === ''
    ? previous?.passphrase : body.passphrase;
  if (rawPassphrase === undefined) throw new APIError('请设置备份口令，用于加密备份文件。');
  const passphrase = validatePassphrase(rawPassphrase);
  const keepValue = body.keep ?? previous?.keep ?? 7;
  if (typeof keepValue !== 'number' || !Number.isInteger(keepValue) || keepValue < 1 || keepValue > MAX_KEEP) {
    throw new APIError(`保留份数必须是 1 到 ${MAX_KEEP} 之间的整数。`);
  }
  return {
    enabled: body.enabled === undefined ? previous?.enabled ?? true : body.enabled === true,
    url, username, password, passphrase,
    prefix: sanitizePrefix(body.prefix ?? previous?.prefix),
    keep: keepValue,
    schedule: validateSchedule(body.schedule, previous?.schedule),
  };
}

export function target(settings: BackupSettings): WebDAVTarget {
  return { url: settings.url, username: settings.username, password: settings.password };
}

export async function loadSettings(env: Env, accountId: string): Promise<BackupSettings | null> {
  const row = await env.DB.prepare('SELECT encrypted_payload FROM backup_settings WHERE account_id = ?')
    .bind(accountId).first<{ encrypted_payload: string }>();
  if (!row) return null;
  const settings = await decryptHost<BackupSettings>(row.encrypted_payload, env.ENCRYPTION_KEY, accountId, SETTINGS_AAD);
  // 早于时间表功能的配置没有该字段，按默认每日补齐，避免自动备份直接停摆。
  return { ...settings, schedule: settings.schedule ?? DEFAULT_SCHEDULE };
}

export async function saveSettings(env: Env, accountId: string, settings: BackupSettings): Promise<void> {
  const encrypted = await encryptHost(settings, env.ENCRYPTION_KEY, accountId, SETTINGS_AAD);
  await env.DB.prepare(`INSERT INTO backup_settings(account_id, encrypted_payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at`)
    .bind(accountId, encrypted, Date.now()).run();
}

export async function clearSettings(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM backup_settings WHERE account_id = ?').bind(accountId).run();
}

/** 配置对前端脱敏：密码与备份口令只回报是否已设置。 */
export function publicSettings(settings: BackupSettings | null) {
  if (!settings) return null;
  const { password, passphrase, ...safe } = settings;
  return { ...safe, hasPassword: Boolean(password), hasPassphrase: Boolean(passphrase) };
}

async function collectTable(env: Env, accountId: string, table: Table): Promise<BackupRecord[]> {
  const rows = await env.DB.prepare(`SELECT id, encrypted_payload, updated_at FROM ${table} WHERE account_id = ? ORDER BY updated_at DESC, id`)
    .bind(accountId).all<Row>();
  return Promise.all(rows.results.map(async (row) => ({
    id: row.id,
    updatedAt: row.updated_at,
    // 解成明文再用备份口令重新加密，这样换部署、换 ENCRYPTION_KEY 后依然能恢复。
    payload: await decryptHost<unknown>(row.encrypted_payload, env.ENCRYPTION_KEY, accountId, AAD_PREFIX[table](row.id)),
  })));
}

export async function collectBackup(env: Env, accountId: string): Promise<BackupContents> {
  const [hosts, snippets, forwardRules] = await Promise.all([
    collectTable(env, accountId, 'hosts'),
    collectTable(env, accountId, 'snippets'),
    collectTable(env, accountId, 'forward_rules'),
  ]);
  return { hosts, snippets, forwardRules };
}

export function backupCounts(contents: BackupContents) {
  return { hosts: contents.hosts.length, snippets: contents.snippets.length, forwardRules: contents.forwardRules.length };
}

export function remoteName(prefix: string, createdAt: number): string {
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${prefix}-${stamp}.json`;
}

export async function recordRun(env: Env, accountId: string, run: Omit<BackupRunRecord, 'id'>): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO backup_runs(id, account_id, started_at, trigger, status, remote_name, size, counts, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id, accountId, run.startedAt, run.trigger, run.status,
      run.remoteName, run.size, run.counts ? JSON.stringify(run.counts) : null, run.error,
    ),
    // 只保留最近若干条，历史表不会随定时任务无限增长。
    env.DB.prepare(`DELETE FROM backup_runs WHERE account_id = ? AND id NOT IN (
      SELECT id FROM backup_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?)`)
      .bind(accountId, accountId, RUN_HISTORY_LIMIT),
  ]);
}

/** 最近一次成功备份的时间；手动备份同样计入，会推迟下一次自动备份。 */
export async function lastSuccessAt(env: Env, accountId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT started_at FROM backup_runs WHERE account_id = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1",
  ).bind(accountId).first<{ started_at: number }>();
  return row ? row.started_at : null;
}

export async function listRuns(env: Env, accountId: string): Promise<BackupRunRecord[]> {
  const rows = await env.DB.prepare(`SELECT id, started_at, trigger, status, remote_name, size, counts, error
    FROM backup_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`)
    .bind(accountId, RUN_HISTORY_LIMIT).all<{
      id: string; started_at: number; trigger: string; status: string;
      remote_name: string | null; size: number | null; counts: string | null; error: string | null;
    }>();
  return rows.results.map((row) => {
    let counts: BackupRunRecord['counts'] = null;
    if (row.counts) { try { counts = JSON.parse(row.counts); } catch { counts = null; } }
    return {
      id: row.id, startedAt: row.started_at,
      trigger: row.trigger === 'scheduled' ? 'scheduled' : 'manual',
      status: row.status === 'success' ? 'success' : 'failure',
      remoteName: row.remote_name, size: row.size, counts, error: row.error,
    };
  });
}

/** 超出保留份数时删掉最旧的包；清理失败不影响本次备份结果。 */
async function prune(settings: BackupSettings): Promise<void> {
  const files = await listFiles(target(settings), `${settings.prefix}-`);
  const expired = files
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name))
    .slice(settings.keep);
  for (const entry of expired) await deleteFile(target(settings), entry.name);
}

export async function runBackup(
  env: Env, accountId: string, settings: BackupSettings, trigger: 'manual' | 'scheduled',
): Promise<BackupRunRecord> {
  const startedAt = Date.now();
  try {
    const contents = await collectBackup(env, accountId);
    const envelope = await sealBackup(contents, settings.passphrase);
    const body = JSON.stringify(envelope);
    const name = remoteName(settings.prefix, envelope.createdAt);
    await ensureCollection(target(settings));
    await putFile(target(settings), name, body);
    const run = {
      startedAt, trigger, status: 'success' as const, remoteName: name,
      size: new TextEncoder().encode(body).length, counts: backupCounts(contents), error: null,
    };
    await recordRun(env, accountId, run);
    try { await prune(settings); } catch { /* 清理旧包失败不影响本次备份 */ }
    return { id: '', ...run };
  } catch (error) {
    // 非 APIError 多为运行时限制或实现缺陷（例如 PBKDF2 迭代数超出 Workers 上限）。
    // 把异常类型与消息一并记入历史并打到日志，否则界面只剩无法排查的兜底文案。
    const message = error instanceof APIError
      ? error.message
      : `备份失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    if (!(error instanceof APIError)) console.error('backup failed', error);
    await recordRun(env, accountId, {
      startedAt, trigger, status: 'failure', remoteName: null, size: null, counts: null,
      error: message.slice(0, 500),
    });
    throw error instanceof APIError ? error : new APIError(message, 502);
  }
}

export interface RestoreSummary {
  hosts: { restored: number; skipped: number };
  snippets: { restored: number; skipped: number };
  forwardRules: { restored: number; skipped: number };
}

/** 恢复前重新校验每条明文，拒绝备份文件里被改坏或构造的记录。 */
function revalidate(table: Table, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new APIError('备份记录内容无效。');
  const value = payload as Record<string, unknown>;
  if (table === 'snippets') return validateSnippet(value) as unknown as Record<string, unknown>;
  if (table === 'forward_rules') return validateForwardRule(value) as unknown as Record<string, unknown>;
  return validateHostPayload(value) as unknown as Record<string, unknown>;
}

async function restoreTable(
  env: Env, accountId: string, table: Table, records: BackupRecord[], mode: 'merge' | 'replace',
): Promise<{ restored: number; skipped: number }> {
  let skipped = 0;
  const statements = [];
  if (mode === 'replace') {
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE account_id = ?`).bind(accountId));
  }
  for (const record of records) {
    let payload: Record<string, unknown>;
    try { payload = revalidate(table, record.payload); } catch { skipped += 1; continue; }
    const encrypted = await encryptHost(payload, env.ENCRYPTION_KEY, accountId, AAD_PREFIX[table](record.id));
    // 合并时按 updated_at 取较新的一份，不让旧备份覆盖现有的新改动。
    statements.push(env.DB.prepare(
      `INSERT INTO ${table}(id, account_id, encrypted_payload, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at
       WHERE ${table}.account_id = excluded.account_id AND ${table}.updated_at <= excluded.updated_at`,
    ).bind(record.id, accountId, encrypted, record.updatedAt));
  }
  if (statements.length) await env.DB.batch(statements);
  return { restored: records.length - skipped, skipped };
}

export async function restoreBackup(
  env: Env, accountId: string, contents: BackupContents, mode: 'merge' | 'replace',
): Promise<RestoreSummary> {
  // 片段库标记必须存在，否则恢复后的空库会被默认片段重新填充。
  await env.DB.prepare('INSERT INTO snippet_libraries(account_id) VALUES (?) ON CONFLICT DO NOTHING').bind(accountId).run();
  const [hosts, snippets, forwardRules] = [
    await restoreTable(env, accountId, 'hosts', contents.hosts, mode),
    await restoreTable(env, accountId, 'snippets', contents.snippets, mode),
    await restoreTable(env, accountId, 'forward_rules', contents.forwardRules, mode),
  ];
  return { hosts, snippets, forwardRules };
}

export async function readRemoteEnvelope(settings: BackupSettings, name: string): Promise<BackupEnvelope> {
  const body = await getFile(target(settings), validateRemoteName(name));
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new APIError('远端备份文件不是有效的 JSON。'); }
  return parseEnvelope(parsed);
}

export async function openEnvelope(envelope: BackupEnvelope, passphrase: string): Promise<BackupContents> {
  return openBackup(envelope, validatePassphrase(passphrase));
}

export async function listRemote(settings: BackupSettings) {
  const files = await listFiles(target(settings), `${settings.prefix}-`);
  return files.sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
}
