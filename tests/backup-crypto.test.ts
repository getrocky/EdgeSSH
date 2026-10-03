import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  openBackup, parseEnvelope, sealBackup, validatePassphrase, type BackupContents,
} from '../src/accounts/backup-crypto.ts';
import { parsePropfind, validateRemoteName, validateWebDAVURL } from '../src/accounts/backup-webdav.ts';

const contents: BackupContents = {
  hosts: [{ id: '11111111-1111-4111-8111-111111111111', updatedAt: 10, payload: { name: 'tokyo', password: 'secret' } }],
  snippets: [{ id: '22222222-2222-4222-8222-222222222222', updatedAt: 20, payload: { name: 'ls', command: 'ls -al' } }],
  forwardRules: [],
};

test('备份包可用同一口令往返解开', async () => {
  const envelope = await sealBackup(contents, 'correct horse battery');
  assert.equal(envelope.format, 'edgessh-backup');
  // 凭据不能以明文出现在包里。
  assert.ok(!JSON.stringify(envelope).includes('secret'));
  const opened = await openBackup(parseEnvelope(JSON.parse(JSON.stringify(envelope))), 'correct horse battery');
  assert.deepEqual(opened, contents);
});

test('口令错误时解包失败', async () => {
  const envelope = await sealBackup(contents, 'correct horse battery');
  await assert.rejects(() => openBackup(envelope, 'wrong horse battery'), /口令不正确/);
});

test('篡改头部后解包失败', async () => {
  const envelope = await sealBackup(contents, 'correct horse battery');
  // createdAt 进了 AAD，改动后 GCM 校验必须失败。
  await assert.rejects(() => openBackup({ ...envelope, createdAt: envelope.createdAt + 1 }, 'correct horse battery'), /口令不正确/);
});

test('口令长度受限', () => {
  assert.throws(() => validatePassphrase('short'), /至少/);
  assert.throws(() => validatePassphrase('x'.repeat(513)), /不能超过/);
  assert.equal(validatePassphrase('  keeps spaces  '), '  keeps spaces  ');
});

test('拒绝非法备份文件', () => {
  assert.throws(() => parseEnvelope({ format: 'other' }), /不是 EdgeSSH 备份文件/);
  assert.throws(() => parseEnvelope({ format: 'edgessh-backup', version: 99 }), /版本不受支持/);
  // 超大迭代数会耗尽 Worker CPU，必须拦住。
  assert.throws(() => parseEnvelope({
    format: 'edgessh-backup', version: 1, createdAt: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 90_000_000, salt: 'x' },
    cipher: 'AES-GCM', iv: 'x', ciphertext: 'x',
  }), /密钥参数无效/);
});

test('WebDAV 地址必须是 HTTPS 公网地址', () => {
  assert.equal(validateWebDAVURL('https://dav.example.com/backups'), 'https://dav.example.com/backups/');
  assert.equal(validateWebDAVURL('https://dav.example.com/backups/'), 'https://dav.example.com/backups/');
  assert.throws(() => validateWebDAVURL('http://dav.example.com/'), /必须使用 HTTPS/);
  assert.throws(() => validateWebDAVURL('https://user:pass@dav.example.com/'), /不要把账号密码写在地址里/);
});

test('WebDAV 地址拦截内网与元数据目标', () => {
  for (const blocked of [
    'https://localhost/dav', 'https://127.0.0.1/dav', 'https://10.1.2.3/dav',
    'https://192.168.1.1/dav', 'https://172.16.0.1/dav', 'https://169.254.169.254/dav',
    'https://metadata.google.internal/dav', 'https://nas.local/dav', 'https://[::1]/dav',
    'https://[fd00::1]/dav', 'https://[::ffff:10.0.0.1]/dav', 'https://100.64.0.1/dav',
  ]) {
    assert.throws(() => validateWebDAVURL(blocked), /本机或内网地址/, blocked);
  }
});

test('远端文件名拒绝路径穿越', () => {
  assert.equal(validateRemoteName('edgessh-2026-01-01.json'), 'edgessh-2026-01-01.json');
  for (const bad of ['../escape.json', 'a/b.json', '..', '', 'x'.repeat(129)]) {
    assert.throws(() => validateRemoteName(bad), /文件名无效/);
  }
});

test('PROPFIND 解析只返回匹配前缀的文件', () => {
  const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:">
    <response><href>/dav/backups/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
    <response><href>/dav/backups/edgessh-2026-01-01T00-00-00.json</href><propstat><prop>
      <getcontentlength>1234</getcontentlength><getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</getlastmodified>
    </prop></propstat></response>
    <response><href>/dav/backups/other-file.json</href><propstat><prop><getcontentlength>9</getcontentlength></prop></propstat></response>
  </multistatus>`;
  const entries = parsePropfind(xml, 'edgessh-');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'edgessh-2026-01-01T00-00-00.json');
  assert.equal(entries[0].size, 1234);
  assert.ok(entries[0].modifiedAt > 0);
});
