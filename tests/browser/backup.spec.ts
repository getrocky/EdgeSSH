import { test, expect, type Page } from '@playwright/test';

interface StoredSettings {
  enabled: boolean; url: string; username: string; prefix: string; keep: number;
  schedule: { frequency: string; hour: number; weekday: number; timeZone: string };
  hasPassword: boolean; hasPassphrase: boolean;
}

// 只在测试浏览器内模拟备份 API，不访问真实 WebDAV，也不增加生产认证绕过。
async function fixture(page: Page, options: { configured?: boolean; remoteError?: string } = {}) {
  const state: { settings: StoredSettings | null; history: unknown[]; files: unknown[]; lastSave?: Record<string, unknown> } = {
    settings: options.configured
      ? { enabled: true, url: 'https://dav.example.com/edgessh/', username: 'me', prefix: 'edgessh', keep: 7,
          schedule: { frequency: 'weekly', hour: 22, weekday: 5, timeZone: 'Asia/Shanghai' }, hasPassword: true, hasPassphrase: true }
      : null,
    history: options.configured
      ? [{ id: 'r1', startedAt: 1_790_000_000_000, trigger: 'scheduled', status: 'success', remoteName: 'edgessh-old.json', size: 2048, counts: { hosts: 2, snippets: 3, forwardRules: 1 }, error: null }]
      : [],
    files: options.configured
      ? [{ name: 'edgessh-2026-01-02T00-00-00.json', size: 2048, modifiedAt: 1_790_000_000_000 }]
      : [],
  };
  const imported: Array<Record<string, unknown>> = [];
  const restored: Array<Record<string, unknown>> = [];
  let exportCalls = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/hosts') return route.fulfill({ json: { hosts: [] } });
    if (path === '/api/snippets') return route.fulfill({ json: { snippets: [] } });

    if (path === '/api/backup/settings') {
      if (method === 'GET') return route.fulfill({ json: {
        settings: state.settings, history: state.history,
        lastSuccessAt: state.settings ? 1_790_000_000_000 : null,
        nextRunAt: state.settings?.enabled ? 1_790_003_600_000 : null,
      } });
      if (method === 'PUT') {
        const body = request.postDataJSON();
        state.lastSave = body;
        state.settings = {
          enabled: body.enabled, url: `${body.url.replace(/\/+$/, '')}/`, username: body.username,
          prefix: body.prefix, keep: body.keep, schedule: body.schedule, hasPassword: true, hasPassphrase: true,
        };
        return route.fulfill({ json: { settings: state.settings, nextRunAt: body.enabled ? 1_790_003_600_000 : null } });
      }
      if (method === 'DELETE') { state.settings = null; state.files = []; return route.fulfill({ json: { ok: true } }); }
    }
    if (path === '/api/backup/test') {
      const body = request.postDataJSON();
      // 还原服务端的内网拦截，确认前端把错误原样显示出来。
      if (/127\.0\.0\.1|localhost|192\.168\./.test(String(body.url))) {
        return route.fulfill({ status: 400, json: { error: '不允许备份到本机或内网地址。' } });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/backup/run') {
      const run = { id: 'r2', startedAt: Date.now(), trigger: 'manual', status: 'success',
        remoteName: 'edgessh-new.json', size: 3072, counts: { hosts: 2, snippets: 3, forwardRules: 1 }, error: null };
      state.history = [run, ...state.history];
      state.files = [{ name: 'edgessh-new.json', size: 3072, modifiedAt: Date.now() }, ...state.files];
      return route.fulfill({ json: { run, history: state.history, nextRunAt: 1_790_003_600_000 } });
    }
    if (path === '/api/backup/remote') {
      if (options.remoteError) return route.fulfill({ status: 502, json: { error: options.remoteError } });
      return route.fulfill({ json: { files: state.files } });
    }
    if (path === '/api/backup/export') {
      exportCalls += 1;
      return route.fulfill({ json: {
        envelope: { format: 'edgessh-backup', version: 1, createdAt: 1_790_000_000_000, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310_000, salt: 'c2FsdA==' }, cipher: 'AES-GCM', iv: 'aXZpdml2', ciphertext: 'Y2lwaGVy' },
        filename: 'edgessh-2026-01-03T00-00-00.json',
        counts: { hosts: 2, snippets: 3, forwardRules: 1 },
      } });
    }
    if (path === '/api/backup/import') {
      const body = request.postDataJSON();
      imported.push(body);
      if (body.passphrase === 'wrong passphrase') {
        return route.fulfill({ status: 400, json: { error: '备份口令不正确，或文件已损坏。' } });
      }
      return route.fulfill({ json: {
        summary: { hosts: { restored: 2, skipped: 1 }, snippets: { restored: 3, skipped: 0 }, forwardRules: { restored: 1, skipped: 0 } },
        counts: { hosts: 3, snippets: 3, forwardRules: 1 }, createdAt: 1_790_000_000_000,
      } });
    }
    if (path === '/api/backup/restore') {
      restored.push(request.postDataJSON());
      return route.fulfill({ json: {
        summary: { hosts: { restored: 2, skipped: 0 }, snippets: { restored: 3, skipped: 0 }, forwardRules: { restored: 1, skipped: 0 } },
        counts: { hosts: 2, snippets: 3, forwardRules: 1 }, createdAt: 1_790_000_000_000,
      } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto('/');
  return { state, imported, restored, exports: () => exportCalls };
}

test('未配置时展示空状态，保存配置后出现远端列表与立即备份', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture_ = await fixture(page);

  await page.locator('#rail-backup').click();
  await expect(page.locator('#rail-backup')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: '在线备份' })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'backup');
  const backup = page.locator('.backup-page');
  const config = page.locator('#backup-config-form');
  // 未配置时不能点「立即备份」，远端区域给出引导。
  await expect(backup.getByRole('button', { name: '立即备份' })).toBeDisabled();
  await expect(config.getByRole('button', { name: '删除配置' })).toBeHidden();
  await expect(backup.getByText('配置 WebDAV 后，这里会列出远端的备份文件。')).toBeVisible();
  await expect(backup.getByText('还没有备份记录。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('backup-empty.png'), fullPage: true });

  // 口令太短时被原生校验拦住，不发保存请求。
  await config.getByLabel('WebDAV 地址').fill('https://dav.example.com/edgessh');
  await config.getByLabel('账号').fill('me');
  await config.getByLabel('密码 / 应用密码').fill('dav-pass');
  await config.getByLabel('备份口令').fill('short');
  await config.getByRole('button', { name: '保存配置' }).click();
  expect(await config.getByLabel('备份口令').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  expect(fixture_.state.settings).toBeNull();

  await config.getByLabel('备份口令').fill('a strong backup passphrase');
  await config.getByRole('button', { name: '保存配置' }).click();
  await expect(backup.locator('[data-config-status]')).toContainText('配置已加密保存');
  // 保存后密码与口令输入框清空，不在 DOM 里留明文。
  await expect(config.getByLabel('密码 / 应用密码')).toHaveValue('');
  await expect(config.getByLabel('备份口令')).toHaveValue('');
  expect(fixture_.state.lastSave?.passphrase).toBe('a strong backup passphrase');
  await expect(config.getByRole('button', { name: '删除配置' })).toBeVisible();

  const run = backup.getByRole('button', { name: '立即备份' });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(backup.locator('[data-config-status]')).toContainText('备份完成：edgessh-new.json');
  await expect(backup.locator('[data-remote] .backup-row')).toHaveCount(1);
  await expect(backup.locator('[data-history] .backup-row')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('backup-configured.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('已配置时回填配置、脱敏凭据并列出远端备份与历史', async ({ page }, testInfo) => {
  await fixture(page, { configured: true });
  await page.locator('#rail-backup').click();
  const backup = page.locator('.backup-page');
  const config = page.locator('#backup-config-form');
  await expect(config.getByLabel('WebDAV 地址')).toHaveValue('https://dav.example.com/edgessh/');
  await expect(config.getByLabel('账号')).toHaveValue('me');
  await expect(config.getByLabel('保留份数')).toHaveValue('7');
  // 已保存的凭据不回传，只显示占位提示。
  await expect(config.getByLabel('密码 / 应用密码')).toHaveValue('');
  await expect(config.getByLabel('密码 / 应用密码')).toHaveAttribute('placeholder', '已保存，留空则不修改');
  await expect(config.getByLabel('备份口令')).toHaveAttribute('placeholder', '已保存，留空则不修改');
  await expect(backup.locator('[data-remote] .backup-row')).toHaveCount(1);
  await expect(backup.locator('[data-remote]')).toContainText('edgessh-2026-01-02T00-00-00.json');
  await expect(backup.locator('[data-history]')).toContainText('自动');
  await expect(backup.locator('[data-history]')).toContainText('主机 2');
  await page.screenshot({ path: testInfo.outputPath('backup-existing.png'), fullPage: true });
});

test('测试连接把服务端的内网拦截显示给用户', async ({ page }) => {
  await fixture(page);
  await page.locator('#rail-backup').click();
  const backup = page.locator('.backup-page');
  const config = page.locator('#backup-config-form');
  await config.getByLabel('WebDAV 地址').fill('https://192.168.1.50/dav');
  await config.getByLabel('账号').fill('me');
  await config.getByLabel('密码 / 应用密码').fill('dav-pass');
  await config.getByLabel('备份口令').fill('a strong backup passphrase');
  await config.getByRole('button', { name: '测试连接' }).click();
  await expect(backup.locator('[data-config-status]')).toContainText('不允许备份到本机或内网地址');
  await expect(backup.locator('[data-config-status]')).toHaveClass(/is-error/);

  await config.getByLabel('WebDAV 地址').fill('https://dav.example.com/edgessh');
  await config.getByRole('button', { name: '测试连接' }).click();
  await expect(backup.locator('[data-config-status]')).toContainText('连接正常');
});

test('从远端备份恢复：默认合并，覆盖需二次确认', async ({ page }, testInfo) => {
  const fixture_ = await fixture(page, { configured: true });
  await page.locator('#rail-backup').click();
  const backup = page.locator('.backup-page');
  const config = page.locator('#backup-config-form');
  await backup.getByRole('button', { name: '从 edgessh-2026-01-02T00-00-00.json 恢复' }).click();
  const dialog = page.getByRole('dialog', { name: '恢复备份' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('将从远端备份 edgessh-2026-01-02T00-00-00.json 恢复。')).toBeVisible();
  // 已保存口令时允许留空，合并是默认选项。
  await expect(dialog.getByText('留空表示使用当前保存的备份口令。')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /合并恢复/ })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('backup-restore-dialog.png') });
  await dialog.getByRole('button', { name: '开始恢复' }).click();
  await expect(dialog).toBeHidden();
  await expect(backup.locator('[data-remote-status]')).toContainText('已恢复 主机 2 · 片段 3 · 转发规则 1');
  expect(fixture_.restored).toEqual([{ name: 'edgessh-2026-01-02T00-00-00.json', mode: 'merge' }]);

  // 覆盖模式必须二次确认；取消则不发请求。
  await backup.getByRole('button', { name: '从 edgessh-2026-01-02T00-00-00.json 恢复' }).click();
  await page.getByRole('dialog', { name: '恢复备份' }).getByRole('radio', { name: /覆盖恢复/ }).check();
  page.once('dialog', (confirm) => confirm.dismiss());
  await page.getByRole('dialog', { name: '恢复备份' }).getByRole('button', { name: '开始恢复' }).click();
  expect(fixture_.restored).toHaveLength(1);

  page.once('dialog', (confirm) => confirm.accept());
  await page.getByRole('dialog', { name: '恢复备份' }).getByRole('button', { name: '开始恢复' }).click();
  await expect.poll(() => fixture_.restored.length).toBe(2);
  expect(fixture_.restored[1].mode).toBe('replace');
});

test('本地导出下载加密文件，上传文件后可恢复并校验口令', async ({ page }, testInfo) => {
  const fixture_ = await fixture(page);
  await page.locator('#rail-backup').click();
  const backup = page.locator('.backup-page');
  const config = page.locator('#backup-config-form');

  // 导出：口令太短时前端拦住，不请求后端。
  page.once('dialog', (prompt) => prompt.accept('short'));
  await backup.getByRole('button', { name: '导出到本地' }).click();
  await expect(backup.locator('[data-local-status]')).toContainText('至少需要 12 个字符');
  expect(fixture_.exports()).toBe(0);

  page.once('dialog', (prompt) => prompt.accept('a strong backup passphrase'));
  const download = page.waitForEvent('download');
  await backup.getByRole('button', { name: '导出到本地' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('edgessh-2026-01-03T00-00-00.json');
  await expect(backup.locator('[data-local-status]')).toContainText('已导出');
  await expect(backup.locator('[data-local-status]')).toContainText('主机 2 · 片段 3 · 转发规则 1');
  await page.screenshot({ path: testInfo.outputPath('backup-exported.png'), fullPage: true });

  // 非备份文件应被前端挡住。
  await page.locator('[data-picker]').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('not json at all') });
  await expect(backup.locator('[data-local-status]')).toContainText('这不是有效的备份文件');

  const envelope = Buffer.from(JSON.stringify({ format: 'edgessh-backup', version: 1, createdAt: 1_790_000_000_000 }));
  await page.locator('[data-picker]').setInputFiles({ name: 'edgessh-backup.json', mimeType: 'application/json', buffer: envelope });
  const dialog = page.getByRole('dialog', { name: '恢复备份' });
  await expect(dialog.getByText('将从本地文件 edgessh-backup.json 恢复。')).toBeVisible();
  // 本地文件可能来自其他部署，必须显式输入口令。
  await expect(dialog.getByText('请输入该备份文件的口令。')).toBeVisible();
  await dialog.getByRole('button', { name: '开始恢复' }).click();
  await expect(dialog.locator('[data-restore-error]')).toContainText('请输入该备份文件的口令。');

  await dialog.getByLabel('备份口令').fill('wrong passphrase');
  await dialog.getByRole('button', { name: '开始恢复' }).click();
  await expect(dialog.locator('[data-restore-error]')).toContainText('备份口令不正确');

  await dialog.getByLabel('备份口令').fill('a strong backup passphrase');
  await dialog.getByRole('button', { name: '开始恢复' }).click();
  await expect(dialog).toBeHidden();
  // 跳过的无效记录要告诉用户。
  await expect(backup.locator('[data-local-status]')).toContainText('跳过 1 条无效记录');
});

test('删除配置后停止自动备份并恢复空状态', async ({ page }) => {
  await fixture(page, { configured: true });
  await page.locator('#rail-backup').click();
  const backup = page.locator('.backup-page');
  const config = page.locator('#backup-config-form');
  page.once('dialog', (confirm) => confirm.accept());
  await config.getByRole('button', { name: '删除配置' }).click();
  await expect(backup.locator('[data-config-status]')).toContainText('配置已删除，自动备份已停止');
  await expect(backup.getByRole('button', { name: '立即备份' })).toBeDisabled();
  await expect(backup.getByText('配置 WebDAV 后，这里会列出远端的备份文件。')).toBeVisible();
});

test('远端目录读取失败时显示原因而不是空列表', async ({ page }) => {
  await fixture(page, { configured: true, remoteError: 'WebDAV 账号或密码不正确。' });
  await page.locator('#rail-backup').click();
  const backup = page.locator('.backup-page');
  const config = page.locator('#backup-config-form');
  await expect(backup.locator('[data-remote-status]')).toContainText('WebDAV 账号或密码不正确');
  await expect(backup.locator('[data-remote-status]')).toHaveClass(/is-error/);
});

test('内容高于一屏时整页可滚动，四个区块都能看到', async ({ page }, testInfo) => {
  await fixture(page, { configured: true });
  await page.locator('#rail-backup').click();
  const history = page.locator('[aria-labelledby="backup-history-heading"]');
  await expect(page.locator('[data-remote] .backup-row')).toHaveCount(1);
  // style.css 把 body 锁成 height:100%/overflow:hidden（终端需要），
  // 备份页比一屏高，必须确认历史卡片真的能滚到可见区域而不是被裁掉。
  await history.scrollIntoViewIfNeeded();
  await expect(history).toBeInViewport();
  await expect(history.getByRole('heading', { name: '备份记录' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('backup-scrolled.png') });
  // 返回总览后不应残留高度覆盖。
  await page.locator('#rail-overview').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'dashboard');
  expect(await page.evaluate(() => Math.round(document.body.getBoundingClientRect().height) <= innerHeight)).toBe(true);
});

test('时间表可读取、修改并即时生效，频率决定可选字段', async ({ page }, testInfo) => {
  const fixture_ = await fixture(page, { configured: true });
  await page.locator('#rail-backup').click();
  const config = page.locator('#backup-config-form');

  // 已保存的每周时间表应回填到控件上。
  await expect(config.getByLabel('频率')).toHaveValue('weekly');
  await expect(config.getByLabel('星期')).toHaveValue('5');
  await expect(config.getByLabel('时间')).toHaveValue('22');
  await expect(config.locator('[data-schedule-hint]')).toContainText('每周五 22:00 备份');
  await expect(config.locator('[data-next-run]')).toContainText('下次自动备份');

  // 每天：隐藏星期，保留小时。
  await config.getByLabel('频率').selectOption('daily');
  await expect(config.locator('[data-weekday-field]')).toBeHidden();
  await expect(config.getByLabel('时间')).toBeVisible();
  await config.getByLabel('时间').selectOption('5');
  await expect(config.locator('[data-schedule-hint]')).toContainText('每天 05:00 备份');

  // 每小时：星期与小时都无意义，一并隐藏。
  await config.getByLabel('频率').selectOption('hourly');
  await expect(config.locator('[data-weekday-field]')).toBeHidden();
  await expect(config.locator('[data-hour-field]')).toBeHidden();
  await expect(config.locator('[data-schedule-hint]')).toContainText('每小时整点备份一次');

  // 保存后把时间表与本地时区一起提交。
  await config.getByLabel('频率').selectOption('daily');
  await config.getByLabel('时间').selectOption('1');
  await config.getByRole('button', { name: '保存配置' }).click();
  await expect(config.locator('[data-config-status]')).toContainText('配置已加密保存');
  expect(fixture_.state.lastSave?.schedule).toEqual({
    frequency: 'daily', hour: 1, weekday: 5,
    timeZone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  });
  await page.screenshot({ path: testInfo.outputPath('backup-schedule.png'), fullPage: true });
});

test('关闭自动备份后隐藏时间表并说明仍可手动备份', async ({ page }) => {
  const fixture_ = await fixture(page, { configured: true });
  await page.locator('#rail-backup').click();
  const config = page.locator('#backup-config-form');
  await expect(config.locator('[data-schedule]')).toBeVisible();
  await config.getByLabel('启用自动备份').uncheck();
  await expect(config.locator('[data-schedule]')).toBeHidden();
  await config.getByRole('button', { name: '保存配置' }).click();
  await expect(config.locator('[data-next-run]')).toContainText('自动备份已关闭，可随时手动备份');
  expect(fixture_.state.lastSave?.enabled).toBe(false);
  // 关闭自动备份不影响手动备份。
  await expect(page.locator('.backup-page').getByRole('button', { name: '立即备份' })).toBeEnabled();
});
