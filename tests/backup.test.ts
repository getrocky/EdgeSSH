import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Env } from '../src/types.ts';
import { encryptHost, decryptHost } from '../src/accounts/crypto.ts';
import {
  backupCounts, collectBackup, lastSuccessAt, loadSettings, publicSettings, recordRun, restoreBackup,
  saveSettings, validateBackupSettings, type BackupSettings,
} from '../src/accounts/backup.ts';
import { shouldRun } from '../src/accounts/backup-schedule.ts';
import { openBackup, sealBackup } from '../src/accounts/backup-crypto.ts';
import type { HostPayload } from '../src/accounts/hosts.ts';

// 用真实 SQLite 跑迁移与参数化 SQL，而不是字符串匹配模拟数据库。
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_accounts.sql', '0003_snippets.sql', '0004_forward_rules.sql', '0005_backup.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const prepare = (sql: string) => {
    let params: (string | number | null)[] = [];
    const query = sqlite.prepare(sql);
    const statement = {
      bind(...values: (string | number | null)[]) { params = values; return statement; },
      async first() { return query.get(...params) ?? null; },
      async all() { return { results: query.all(...params) }; },
      execute() { return { meta: { changes: Number(query.run(...params).changes) } }; },
      async run() { return statement.execute(); },
    };
    return statement;
  };
  const env = {
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DB: {
      prepare,
      async batch(statements: ReturnType<typeof prepare>[]) {
        sqlite.exec('BEGIN');
        try { const results = statements.map((s) => s.execute()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    },
  } as unknown as Env;
  return { env, sqlite };
}

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const SNIPPET_ID = '22222222-2222-4222-8222-222222222222';

function hostPayload(overrides: Partial<HostPayload> = {}): HostPayload {
  return {
    name: 'Tokyo', group: '个人', host: 'example.com', port: 22, username: 'root',
    authMethod: 'password', password: 'super-secret', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint: '', location: null, system: null, ...overrides,
  };
}

async function seed(env: Env, accountId = 'owner'): Promise<void> {
  await env.DB.prepare('INSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES (?, ?, ?, ?)')
    .bind(HOST_ID, accountId, await encryptHost(hostPayload(), env.ENCRYPTION_KEY, accountId, HOST_ID), 100).run();
  await env.DB.prepare('INSERT INTO snippets(id, account_id, encrypted_payload, updated_at) VALUES (?, ?, ?, ?)')
    .bind(SNIPPET_ID, accountId, await encryptHost({ name: '列目录', command: 'ls -al' }, env.ENCRYPTION_KEY, accountId, `snippet:${SNIPPET_ID}`), 200).run();
}

test('备份收集全部表并保留凭据，恢复后密文可解开', async () => {
  const { env } = fixture();
  await seed(env);
  const contents = await collectBackup(env, 'owner');
  assert.deepEqual(backupCounts(contents), { hosts: 1, snippets: 1, forwardRules: 0 });
  assert.equal((contents.hosts[0].payload as HostPayload).password, 'super-secret');

  // 换一个 ENCRYPTION_KEY 的新库恢复，验证备份不依赖原密钥。
  const fresh = fixture();
  const envelope = await sealBackup(contents, 'a strong backup passphrase');
  const reopened = await openBackup(envelope, 'a strong backup passphrase');
  const summary = await restoreBackup(fresh.env, 'owner', reopened, 'merge');
  assert.deepEqual(summary.hosts, { restored: 1, skipped: 0 });

  const row = await fresh.env.DB.prepare('SELECT encrypted_payload FROM hosts WHERE id = ?').bind(HOST_ID)
    .first<{ encrypted_payload: string }>();
  const restored = await decryptHost<HostPayload>(row!.encrypted_payload, fresh.env.ENCRYPTION_KEY, 'owner', HOST_ID);
  assert.equal(restored.password, 'super-secret');
  assert.equal(restored.host, 'example.com');
});

test('合并恢复不覆盖更新的现有记录', async () => {
  const { env } = fixture();
  await seed(env);
  const contents = await collectBackup(env, 'owner');
  // 备份后本地改名并把时间推后，旧备份不应覆盖它。
  await env.DB.prepare('UPDATE hosts SET encrypted_payload = ?, updated_at = ? WHERE id = ?')
    .bind(await encryptHost(hostPayload({ name: 'Renamed' }), env.ENCRYPTION_KEY, 'owner', HOST_ID), 500, HOST_ID).run();

  await restoreBackup(env, 'owner', contents, 'merge');
  const row = await env.DB.prepare('SELECT encrypted_payload FROM hosts WHERE id = ?').bind(HOST_ID)
    .first<{ encrypted_payload: string }>();
  const payload = await decryptHost<HostPayload>(row!.encrypted_payload, env.ENCRYPTION_KEY, 'owner', HOST_ID);
  assert.equal(payload.name, 'Renamed');
});

test('覆盖恢复删除备份外的记录', async () => {
  const { env } = fixture();
  await seed(env);
  const contents = await collectBackup(env, 'owner');
  const extra = '33333333-3333-4333-8333-333333333333';
  await env.DB.prepare('INSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES (?, ?, ?, ?)')
    .bind(extra, 'owner', await encryptHost(hostPayload({ name: 'Extra' }), env.ENCRYPTION_KEY, 'owner', extra), 300).run();

  await restoreBackup(env, 'owner', contents, 'replace');
  const rows = await env.DB.prepare('SELECT id FROM hosts WHERE account_id = ?').bind('owner').all<{ id: string }>();
  assert.deepEqual(rows.results.map((row) => row.id), [HOST_ID]);
});

test('恢复跳过内容非法的记录', async () => {
  const { env } = fixture();
  const summary = await restoreBackup(env, 'owner', {
    hosts: [{ id: HOST_ID, updatedAt: 1, payload: { name: 'bad', host: 'not a host!!', port: 70000 } }],
    snippets: [{ id: SNIPPET_ID, updatedAt: 1, payload: { name: '', command: '' } }],
    forwardRules: [],
  }, 'merge');
  assert.deepEqual(summary.hosts, { restored: 0, skipped: 1 });
  assert.deepEqual(summary.snippets, { restored: 0, skipped: 1 });
});

test('恢复会标记片段库，避免默认片段回填', async () => {
  const { env } = fixture();
  await restoreBackup(env, 'owner', { hosts: [], snippets: [], forwardRules: [] }, 'replace');
  const marker = await env.DB.prepare('SELECT account_id FROM snippet_libraries WHERE account_id = ?').bind('owner').first();
  assert.ok(marker);
});

test('配置加密保存，密码与口令不回传前端', async () => {
  const { env } = fixture();
  const settings = validateBackupSettings({
    url: 'https://dav.example.com/edgessh', username: 'me', password: 'dav-pass',
    passphrase: 'a strong backup passphrase', keep: 5,
  });
  await saveSettings(env, 'owner', settings);
  const loaded = await loadSettings(env, 'owner');
  assert.equal(loaded?.password, 'dav-pass');
  assert.equal(loaded?.url, 'https://dav.example.com/edgessh/');

  const safe = publicSettings(loaded) as Record<string, unknown>;
  assert.equal(safe.hasPassword, true);
  assert.equal(safe.hasPassphrase, true);
  assert.ok(!('password' in safe));
  assert.ok(!('passphrase' in safe));

  // 数据库里不应出现明文凭据。
  const row = await env.DB.prepare('SELECT encrypted_payload FROM backup_settings WHERE account_id = ?').bind('owner')
    .first<{ encrypted_payload: string }>();
  assert.ok(!row!.encrypted_payload.includes('dav-pass'));
});

test('留空密码与口令时沿用已保存的值', () => {
  const previous = {
    enabled: true, url: 'https://dav.example.com/x/', username: 'me', password: 'old-pass',
    passphrase: 'a strong backup passphrase', prefix: 'edgessh', keep: 7,
  } satisfies BackupSettings;
  const next = validateBackupSettings({ url: 'https://dav.example.com/x', username: 'me' }, previous);
  assert.equal(next.password, 'old-pass');
  assert.equal(next.passphrase, 'a strong backup passphrase');
  assert.throws(() => validateBackupSettings({ url: 'https://dav.example.com/x', username: 'me' }), /请填写 WebDAV 密码/);
});

test('保留份数与前缀受限', () => {
  const base = { url: 'https://dav.example.com/x', username: 'me', password: 'p', passphrase: 'a strong backup passphrase' };
  assert.throws(() => validateBackupSettings({ ...base, keep: 0 }), /保留份数/);
  assert.throws(() => validateBackupSettings({ ...base, keep: 99 }), /保留份数/);
  assert.throws(() => validateBackupSettings({ ...base, prefix: 'bad/prefix' }), /前缀/);
  assert.equal(validateBackupSettings(base).prefix, 'edgessh');
});

test('旧配置缺少时间表时补默认值，不让自动备份停摆', async () => {
  const { env } = fixture();
  const { encryptHost } = await import('../src/accounts/crypto.ts');
  // 模拟时间表功能上线前写入的配置。
  const legacy = { enabled: true, url: 'https://dav.example.com/x/', username: 'me', password: 'p', passphrase: 'a strong backup passphrase', prefix: 'edgessh', keep: 7 };
  await env.DB.prepare('INSERT INTO backup_settings(account_id, encrypted_payload, updated_at) VALUES (?, ?, ?)')
    .bind('owner', await encryptHost(legacy, env.ENCRYPTION_KEY, 'owner', 'backup:settings'), Date.now()).run();
  const loaded = await loadSettings(env, 'owner');
  assert.deepEqual(loaded?.schedule, { frequency: 'daily', hour: 3, weekday: 0, timeZone: 'UTC' });
});

test('时间表随配置加密保存并回传给前端', async () => {
  const { env } = fixture();
  const settings = validateBackupSettings({
    url: 'https://dav.example.com/edgessh', username: 'me', password: 'dav-pass',
    passphrase: 'a strong backup passphrase',
    schedule: { frequency: 'weekly', hour: 23, weekday: 6, timeZone: 'Asia/Shanghai' },
  });
  await saveSettings(env, 'owner', settings);
  const loaded = await loadSettings(env, 'owner');
  assert.deepEqual(loaded?.schedule, { frequency: 'weekly', hour: 23, weekday: 6, timeZone: 'Asia/Shanghai' });
  // 时间表不含敏感信息，可以回传。
  const safe = publicSettings(loaded) as Record<string, unknown>;
  assert.deepEqual(safe.schedule, { frequency: 'weekly', hour: 23, weekday: 6, timeZone: 'Asia/Shanghai' });
});

test('lastSuccessAt 只看成功记录，并与时间表共同决定是否执行', async () => {
  const { env } = fixture();
  const schedule = { frequency: 'daily' as const, hour: 3, weekday: 0, timeZone: 'UTC' };
  assert.equal(await lastSuccessAt(env, 'owner'), null);
  // 没有任何成功记录时应当执行。
  assert.equal(shouldRun(Date.parse('2026-03-10T03:30:00Z'), schedule, await lastSuccessAt(env, 'owner')), true);

  // 失败记录不算已备份。
  await recordRun(env, 'owner', {
    startedAt: Date.parse('2026-03-10T03:05:00Z'), trigger: 'scheduled', status: 'failure',
    remoteName: null, size: null, counts: null, error: 'WebDAV 存储空间不足。',
  });
  assert.equal(await lastSuccessAt(env, 'owner'), null);
  assert.equal(shouldRun(Date.parse('2026-03-10T04:30:00Z'), schedule, await lastSuccessAt(env, 'owner')), true);

  // 成功后同一周期内不再重复。
  await recordRun(env, 'owner', {
    startedAt: Date.parse('2026-03-10T04:35:00Z'), trigger: 'scheduled', status: 'success',
    remoteName: 'edgessh-a.json', size: 2048, counts: { hosts: 1, snippets: 0, forwardRules: 0 }, error: null,
  });
  assert.equal(await lastSuccessAt(env, 'owner'), Date.parse('2026-03-10T04:35:00Z'));
  assert.equal(shouldRun(Date.parse('2026-03-10T05:30:00Z'), schedule, await lastSuccessAt(env, 'owner')), false);
  // 次日到点后恢复执行。
  assert.equal(shouldRun(Date.parse('2026-03-11T03:30:00Z'), schedule, await lastSuccessAt(env, 'owner')), true);
});
