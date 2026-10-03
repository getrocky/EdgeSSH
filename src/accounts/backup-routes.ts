import type { Env } from '../types.ts';
import { APIError, json, readJSON } from './http.ts';
import { parseEnvelope, sealBackup, validatePassphrase } from './backup-crypto.ts';
import { validateRemoteName, verifyTarget } from './backup-webdav.ts';
import {
  backupCounts, clearSettings, collectBackup, lastSuccessAt, listRemote, listRuns, loadSettings, openEnvelope,
  publicSettings, readRemoteEnvelope, remoteName, restoreBackup, runBackup, saveSettings,
  target, validateBackupSettings,
} from './backup.ts';
import { nextRunAt } from './backup-schedule.ts';

function restoreMode(value: unknown): 'merge' | 'replace' {
  if (value === undefined || value === 'merge') return 'merge';
  if (value === 'replace') return 'replace';
  throw new APIError('恢复方式无效。');
}

async function settingsOrFail(env: Env, accountId: string) {
  const settings = await loadSettings(env, accountId);
  if (!settings) throw new APIError('尚未配置 WebDAV 备份。', 409);
  return settings;
}

export async function backupRoute(request: Request, env: Env, accountId: string, pathname: string): Promise<Response> {
  const match = /^\/api\/backup(?:\/(settings|test|run|history|remote|restore|export|import))?$/.exec(pathname);
  if (!match) throw new APIError('接口不存在。', 404);
  const action = match[1];

  if (!action || action === 'settings') {
    if (request.method === 'GET') {
      const [settings, history, lastSuccess] = await Promise.all([
        loadSettings(env, accountId), listRuns(env, accountId), lastSuccessAt(env, accountId),
      ]);
      return json({
        settings: publicSettings(settings),
        history,
        lastSuccessAt: lastSuccess,
        // 下次自动备份时刻由时间表算出，仅用于界面展示。
        nextRunAt: settings?.enabled ? nextRunAt(Date.now(), settings.schedule) : null,
      });
    }
    if (request.method === 'PUT') {
      const previous = await loadSettings(env, accountId);
      const settings = validateBackupSettings(await readJSON(request), previous ?? undefined);
      await saveSettings(env, accountId, settings);
      return json({
        settings: publicSettings(settings),
        nextRunAt: settings.enabled ? nextRunAt(Date.now(), settings.schedule) : null,
      });
    }
    if (request.method === 'DELETE') {
      await clearSettings(env, accountId);
      return json({ ok: true });
    }
    throw new APIError('不支持此请求方法。', 405);
  }

  if (action === 'test') {
    if (request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
    // 允许用未保存的配置先测连通性，避免把错误配置写进数据库。
    const body = await readJSON(request);
    const previous = await loadSettings(env, accountId);
    const settings = validateBackupSettings(body, previous ?? undefined);
    await verifyTarget(target(settings));
    return json({ ok: true });
  }

  if (action === 'run') {
    if (request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
    const settings = await settingsOrFail(env, accountId);
    const run = await runBackup(env, accountId, settings, 'manual');
    return json({
      run, history: await listRuns(env, accountId),
      nextRunAt: settings.enabled ? nextRunAt(Date.now(), settings.schedule) : null,
    });
  }

  if (action === 'history') {
    if (request.method !== 'GET') throw new APIError('不支持此请求方法。', 405);
    return json({ history: await listRuns(env, accountId) });
  }

  if (action === 'remote') {
    if (request.method !== 'GET') throw new APIError('不支持此请求方法。', 405);
    const settings = await settingsOrFail(env, accountId);
    return json({ files: await listRemote(settings) });
  }

  if (action === 'export') {
    if (request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
    // 本地导出用一次性口令，不依赖 WebDAV 配置，作为零外部依赖的兜底方案。
    const body = await readJSON(request);
    const passphrase = validatePassphrase(body.passphrase);
    const contents = await collectBackup(env, accountId);
    const envelope = await sealBackup(contents, passphrase);
    return json({ envelope, filename: remoteName('edgessh', envelope.createdAt), counts: backupCounts(contents) });
  }

  if (action === 'import') {
    if (request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
    // 备份包含密文与完整记录，放宽到 4MB；readJSON 默认上限按单条记录设计。
    const body = await readJSON(request, 4 * 1024 * 1024);
    const passphrase = validatePassphrase(body.passphrase);
    const mode = restoreMode(body.mode);
    const contents = await openEnvelope(parseEnvelope(body.envelope), passphrase);
    const summary = await restoreBackup(env, accountId, contents, mode);
    return json({ summary, counts: backupCounts(contents), createdAt: parseEnvelope(body.envelope).createdAt });
  }

  if (action === 'restore') {
    if (request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
    const body = await readJSON(request);
    const settings = await settingsOrFail(env, accountId);
    const name = validateRemoteName(body.name);
    const mode = restoreMode(body.mode);
    // 恢复口令默认沿用已保存的备份口令；跨部署恢复时可显式传入旧口令。
    const passphrase = body.passphrase === undefined || body.passphrase === ''
      ? settings.passphrase : validatePassphrase(body.passphrase);
    const envelope = await readRemoteEnvelope(settings, name);
    const contents = await openEnvelope(envelope, passphrase);
    const summary = await restoreBackup(env, accountId, contents, mode);
    return json({ summary, counts: backupCounts(contents), createdAt: envelope.createdAt });
  }

  throw new APIError('接口不存在。', 404);
}
