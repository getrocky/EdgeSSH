import {
  exportBackup, importBackup, listRemoteBackups, loadBackupSettings, removeBackupSettings,
  restoreRemoteBackup, runBackupNow, saveBackupSettings, testBackupTarget,
  type BackupFrequency, type BackupRun, type BackupSettingsInput, type BackupSettingsView,
  type RemoteBackupFile, type RestoreResult,
} from './cloud-api';
import './backup-page.css';

const MIN_PASSPHRASE_LENGTH = 12;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 浏览器时区直接作为默认值，用户选的「3 点」就是他本地的 3 点。
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function when(value: number): string {
  if (!value) return '时间未知';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function size(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function summarize(result: RestoreResult): string {
  const parts = [
    `主机 ${result.summary.hosts.restored}`,
    `片段 ${result.summary.snippets.restored}`,
    `转发规则 ${result.summary.forwardRules.restored}`,
  ];
  const skipped = result.summary.hosts.skipped + result.summary.snippets.skipped + result.summary.forwardRules.skipped;
  return `已恢复 ${parts.join(' · ')}${skipped ? `，跳过 ${skipped} 条无效记录` : ''}（备份时间 ${when(result.createdAt)}）。`;
}

/** 在线备份页：配置 WebDAV、手动备份、从远端或本地文件恢复。 */
export class BackupPage {
  readonly root = document.createElement('main');
  private settings: BackupSettingsView | null = null;
  private history: BackupRun[] = [];
  private remote: RemoteBackupFile[] = [];
  private busy = false;
  private loaded = false;
  private nextRun: number | null = null;
  private pendingRestore?: { kind: 'remote'; name: string } | { kind: 'file'; envelope: unknown; label: string };
  private readonly form: HTMLFormElement;
  private readonly restoreDialog: HTMLDialogElement;
  private readonly restoreForm: HTMLFormElement;
  private readonly picker: HTMLInputElement;

  constructor() {
    this.root.className = 'backup-page';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="home-section-heading"><div><p class="home-eyebrow">ENCRYPTED OFFSITE COPY</p>
        <h1 tabindex="-1">在线备份</h1><p>把主机、代码片段和转发规则加密备份到你自己的 WebDAV 空间。</p></div>
        <button class="home-button primary" type="button" data-run disabled>立即备份</button></header>
      <div class="backup-grid">
        <section class="backup-card" aria-labelledby="backup-config-heading">
          <h2 id="backup-config-heading">WebDAV 配置</h2>
          <p>支持坚果云、Nextcloud、ownCloud 等标准 WebDAV 服务。地址必须是 HTTPS，且不能指向内网。</p>
          <div class="backup-note"><strong>备份口令独立于服务器密钥</strong>
            <p>备份文件用这个口令单独加密，与 Worker 的 ENCRYPTION_KEY 无关。因此换账户、重新部署后也能恢复 —— 但口令丢失后没有任何办法解开备份，请离线保存。</p></div>
          <form id="backup-config-form" autocomplete="off"><div class="backup-fields">
            <label class="wide">WebDAV 地址<input name="url" type="url" required placeholder="https://dav.jianguoyun.com/dav/edgessh" spellcheck="false">
              <small>备份文件会放在该目录下，目录不存在时自动创建。</small></label>
            <label>账号<input name="username" required maxlength="256" spellcheck="false" autocomplete="off"></label>
            <label>密码 / 应用密码<input name="password" type="password" maxlength="512" autocomplete="new-password">
              <small data-password-hint>部分网盘需使用应用密码。</small></label>
            <label class="wide">备份口令<input name="passphrase" type="password" maxlength="512" autocomplete="new-password" minlength="${MIN_PASSPHRASE_LENGTH}">
              <small data-passphrase-hint>至少 ${MIN_PASSPHRASE_LENGTH} 个字符，用于加密备份文件。</small></label>
            <label>文件名前缀<input name="prefix" maxlength="48" value="edgessh" spellcheck="false"></label>
            <label>保留份数<input name="keep" type="number" min="1" max="60" value="7" required>
              <small>超出份数时自动删除最旧的备份。</small></label>
            <label class="backup-toggle"><input name="enabled" type="checkbox" checked>启用自动备份</label>
            <div class="backup-schedule wide" data-schedule>
              <div class="backup-schedule-fields">
                <label>频率<select name="frequency">
                  <option value="hourly">每小时</option><option value="daily" selected>每天</option><option value="weekly">每周</option>
                </select></label>
                <label data-weekday-field>星期<select name="weekday">${WEEKDAYS.map((day, index) => `<option value="${index}">${day}</option>`).join('')}</select></label>
                <label data-hour-field>时间<select name="hour">${Array.from({ length: 24 }, (_, hour) => `<option value="${hour}"${hour === 3 ? ' selected' : ''}>${String(hour).padStart(2, '0')}:00</option>`).join('')}</select></label>
              </div>
              <small data-schedule-hint></small>
            </div>
          </div>
          <div class="backup-actions"><button class="home-button primary" type="submit">保存配置</button>
            <button class="home-button" type="button" data-test>测试连接</button>
            <button class="home-button" type="button" data-forget hidden>删除配置</button></div>
          <p class="backup-next" data-next-run></p>
          <p class="backup-status" data-config-status role="status" aria-live="polite"></p></form>
        </section>
        <section class="backup-card" aria-labelledby="backup-local-heading">
          <h2 id="backup-local-heading">本地备份文件</h2>
          <p>不配置 WebDAV 也可以用：导出一份加密文件自己保存，需要时再上传恢复。</p>
          <div class="backup-actions" style="border-top: 0; padding-top: 0; margin-top: 0;">
            <button class="home-button" type="button" data-export>导出到本地</button>
            <button class="home-button" type="button" data-import>从文件恢复</button></div>
          <p class="backup-status" data-local-status role="status" aria-live="polite"></p>
        </section>
        <section class="backup-card" aria-labelledby="backup-remote-heading">
          <h2 id="backup-remote-heading">远端备份</h2>
          <p>WebDAV 目录中的备份文件，可直接恢复。</p>
          <div class="backup-list" data-remote></div>
          <p class="backup-status" data-remote-status role="status" aria-live="polite"></p>
        </section>
        <section class="backup-card" aria-labelledby="backup-history-heading">
          <h2 id="backup-history-heading">备份记录</h2>
          <p>最近的自动与手动备份结果。</p>
          <div class="backup-list" data-history></div>
        </section>
      </div>
      <dialog class="host-dialog backup-restore-dialog" aria-labelledby="backup-restore-title">
        <form autocomplete="off"><div class="dialog-heading"><div><p class="home-eyebrow">RESTORE</p>
          <h2 id="backup-restore-title">恢复备份</h2></div></div>
          <p class="dialog-intro" data-restore-target></p>
          <div class="backup-fields">
            <label>备份口令<input name="passphrase" type="password" maxlength="512" autocomplete="off">
              <small data-restore-hint>留空表示使用当前保存的备份口令。</small></label>
          </div>
          <div class="backup-modes">
            <label class="backup-mode"><input name="mode" type="radio" value="merge" checked>
              <span>合并恢复<small>按记录时间取较新的一份，不会删除现有主机。推荐。</small></span></label>
            <label class="backup-mode"><input name="mode" type="radio" value="replace">
              <span>覆盖恢复<small>先清空当前主机、片段和转发规则，再写入备份内容。备份之后的新增会丢失。</small></span></label>
          </div>
          <p class="host-form-error" data-restore-error role="alert" hidden></p>
          <div class="dialog-actions"><button class="home-button" type="button" data-cancel-restore>取消</button>
            <button class="home-button primary" type="submit">开始恢复</button></div>
        </form>
      </dialog>
      <input type="file" accept="application/json,.json" data-picker hidden>`;

    this.form = this.get('#backup-config-form');
    this.restoreDialog = this.get('.backup-restore-dialog');
    this.restoreForm = this.restoreDialog.querySelector('form')!;
    this.picker = this.get('[data-picker]');

    this.form.addEventListener('submit', (event) => { event.preventDefault(); void this.save(); });
    for (const name of ['frequency', 'hour', 'weekday', 'enabled']) {
      (this.form.elements.namedItem(name) as HTMLElement).addEventListener('change', () => this.renderSchedule());
    }
    this.renderSchedule();
    this.get('[data-test]').addEventListener('click', () => void this.test());
    this.get('[data-forget]').addEventListener('click', () => void this.forget());
    this.get('[data-run]').addEventListener('click', () => void this.runNow());
    this.get('[data-export]').addEventListener('click', () => void this.exportLocal());
    this.get('[data-import]').addEventListener('click', () => this.picker.click());
    this.picker.addEventListener('change', () => void this.pickFile());
    this.get('[data-cancel-restore]').addEventListener('click', () => { if (!this.busy) this.restoreDialog.close(); });
    this.restoreDialog.addEventListener('cancel', (event) => { if (this.busy) event.preventDefault(); });
    this.restoreForm.addEventListener('submit', (event) => { event.preventDefault(); void this.restore(); });
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private field(name: string): HTMLInputElement { return this.form.elements.namedItem(name) as HTMLInputElement; }
  private select(name: string): HTMLSelectElement { return this.form.elements.namedItem(name) as HTMLSelectElement; }

  /** 频率决定星期与小时是否可选，并同步说明文案。 */
  private renderSchedule(): void {
    const frequency = this.select('frequency').value as BackupFrequency;
    this.get('[data-weekday-field]').hidden = frequency !== 'weekly';
    this.get('[data-hour-field]').hidden = frequency === 'hourly';
    const hour = `${String(Number(this.select('hour').value)).padStart(2, '0')}:00`;
    const when = frequency === 'hourly' ? '每小时整点备份一次'
      : frequency === 'daily' ? `每天 ${hour} 备份`
      : `每${WEEKDAYS[Number(this.select('weekday').value)]} ${hour} 备份`;
    this.get('[data-schedule-hint]').textContent = `${when}（按你的本地时区 ${LOCAL_TIME_ZONE}）。保存后立即生效，不需要重新部署。`;
    this.get('[data-schedule]').hidden = !this.field('enabled').checked;
  }

  private renderNextRun(): void {
    const node = this.get('[data-next-run]');
    if (!this.settings) { node.textContent = ''; return; }
    if (!this.settings.enabled) { node.textContent = '自动备份已关闭，可随时手动备份。'; return; }
    node.textContent = this.nextRun ? `下次自动备份：${when(this.nextRun)}` : '';
  }

  private status(selector: string, message: string, kind: 'ok' | 'error' | 'plain' = 'plain'): void {
    const node = this.get(selector);
    node.textContent = message;
    node.classList.toggle('is-error', kind === 'error');
    node.classList.toggle('is-ok', kind === 'ok');
  }

  private message(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  show(): void {
    this.root.hidden = false;
    this.get<HTMLElement>('h1').focus();
    if (!this.loaded) void this.load();
  }

  hide(): void { this.root.hidden = true; }

  clear(): void {
    this.settings = null; this.history = []; this.remote = []; this.loaded = false; this.nextRun = null;
    this.renderHistory(); this.renderRemote(); this.renderNextRun();
  }

  private async load(): Promise<void> {
    try {
      const { settings, history, nextRunAt } = await loadBackupSettings();
      this.loaded = true;
      this.settings = settings; this.history = history; this.nextRun = nextRunAt;
      this.applySettings();
      this.renderHistory();
      if (settings) void this.refreshRemote();
      else this.renderRemote();
    } catch (error) {
      this.status('[data-config-status]', this.message(error, '无法读取备份配置。'), 'error');
    }
  }

  private applySettings(): void {
    const settings = this.settings;
    this.get('[data-forget]').hidden = !settings;
    this.get<HTMLButtonElement>('[data-run]').disabled = !settings;
    if (!settings) return;
    this.field('url').value = settings.url;
    this.field('username').value = settings.username;
    this.field('prefix').value = settings.prefix;
    this.field('keep').value = String(settings.keep);
    this.field('enabled').checked = settings.enabled;
    this.select('frequency').value = settings.schedule.frequency;
    this.select('hour').value = String(settings.schedule.hour);
    this.select('weekday').value = String(settings.schedule.weekday);
    this.renderSchedule(); this.renderNextRun();
    // 已保存的密码与口令不回传，留空即沿用。
    if (settings.hasPassword) {
      this.field('password').placeholder = '已保存，留空则不修改';
      this.get('[data-password-hint]').textContent = '已保存。留空则沿用现有密码。';
    }
    if (settings.hasPassphrase) {
      this.field('passphrase').placeholder = '已保存，留空则不修改';
      this.field('passphrase').removeAttribute('minlength');
      this.get('[data-passphrase-hint]').textContent = '已保存。留空则沿用现有口令；修改后旧备份需用旧口令恢复。';
    }
  }

  private collect(): BackupSettingsInput | null {
    if (!this.form.reportValidity()) return null;
    const passphrase = this.field('passphrase').value;
    if (!this.settings?.hasPassphrase && passphrase.length < MIN_PASSPHRASE_LENGTH) {
      this.status('[data-config-status]', `备份口令至少需要 ${MIN_PASSPHRASE_LENGTH} 个字符。`, 'error');
      return null;
    }
    return {
      enabled: this.field('enabled').checked,
      url: this.field('url').value.trim(),
      username: this.field('username').value.trim(),
      prefix: this.field('prefix').value.trim() || 'edgessh',
      keep: Number(this.field('keep').value),
      schedule: {
        frequency: this.select('frequency').value as BackupFrequency,
        hour: Number(this.select('hour').value),
        weekday: Number(this.select('weekday').value),
        // 时区取浏览器当前值，用户选的小时就是本地小时。
        timeZone: LOCAL_TIME_ZONE,
      },
      ...(this.field('password').value ? { password: this.field('password').value } : {}),
      ...(passphrase ? { passphrase } : {}),
    };
  }

  private async withBusy(button: HTMLButtonElement, label: string, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const original = button.textContent;
    button.disabled = true; button.textContent = label;
    try { await work(); } finally {
      this.busy = false; button.textContent = original;
      button.disabled = button.hasAttribute('data-run') ? !this.settings : false;
    }
  }

  private async save(): Promise<void> {
    const input = this.collect();
    if (!input) return;
    await this.withBusy(this.get('[type="submit"]'), '保存中…', async () => {
      try {
        const { settings, nextRunAt } = await saveBackupSettings(input);
        this.settings = settings; this.nextRun = nextRunAt;
        this.field('password').value = ''; this.field('passphrase').value = '';
        this.applySettings();
        this.status('[data-config-status]', '配置已加密保存。', 'ok');
        await this.refreshRemote();
      } catch (error) {
        this.status('[data-config-status]', this.message(error, '保存失败。'), 'error');
      }
    });
  }

  private async test(): Promise<void> {
    const input = this.collect();
    if (!input) return;
    await this.withBusy(this.get('[data-test]'), '测试中…', async () => {
      this.status('[data-config-status]', '正在写入测试文件…');
      try {
        await testBackupTarget(input);
        this.status('[data-config-status]', 'WebDAV 连接正常，读写权限可用。', 'ok');
      } catch (error) {
        this.status('[data-config-status]', this.message(error, '连接测试失败。'), 'error');
      }
    });
  }

  private async forget(): Promise<void> {
    if (!confirm('删除 WebDAV 备份配置？已上传的备份文件不会被删除。')) return;
    await this.withBusy(this.get('[data-forget]'), '删除中…', async () => {
      try {
        await removeBackupSettings();
        this.settings = null; this.remote = []; this.nextRun = null;
        this.form.reset(); this.applySettings(); this.renderSchedule(); this.renderNextRun(); this.renderRemote();
        this.status('[data-config-status]', '配置已删除，自动备份已停止。', 'ok');
      } catch (error) {
        this.status('[data-config-status]', this.message(error, '删除失败。'), 'error');
      }
    });
  }

  private async runNow(): Promise<void> {
    await this.withBusy(this.get('[data-run]'), '备份中…', async () => {
      this.status('[data-config-status]', '正在收集数据并上传…');
      try {
        const { run, history, nextRunAt } = await runBackupNow();
        this.history = history; this.nextRun = nextRunAt;
        this.renderHistory(); this.renderNextRun();
        const counts = run.counts;
        this.status('[data-config-status]',
          `备份完成：${run.remoteName}${counts ? `（主机 ${counts.hosts} · 片段 ${counts.snippets} · 转发规则 ${counts.forwardRules}）` : ''}`, 'ok');
        await this.refreshRemote();
      } catch (error) {
        this.status('[data-config-status]', this.message(error, '备份失败。'), 'error');
        try { this.history = (await loadBackupSettings()).history; this.renderHistory(); } catch { /* 记录稍后刷新 */ }
      }
    });
  }

  private async exportLocal(): Promise<void> {
    const passphrase = prompt(`设置备份口令（至少 ${MIN_PASSPHRASE_LENGTH} 个字符），恢复时需要它：`);
    if (passphrase === null) return;
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      this.status('[data-local-status]', `口令至少需要 ${MIN_PASSPHRASE_LENGTH} 个字符。`, 'error');
      return;
    }
    await this.withBusy(this.get('[data-export]'), '导出中…', async () => {
      try {
        const { envelope, filename, counts } = await exportBackup(passphrase);
        const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = filename; link.click();
        URL.revokeObjectURL(url);
        this.status('[data-local-status]',
          `已导出 ${filename}：主机 ${counts.hosts} · 片段 ${counts.snippets} · 转发规则 ${counts.forwardRules}。请妥善保存口令。`, 'ok');
      } catch (error) {
        this.status('[data-local-status]', this.message(error, '导出失败。'), 'error');
      }
    });
  }

  private async pickFile(): Promise<void> {
    const file = this.picker.files?.[0];
    this.picker.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      this.status('[data-local-status]', '备份文件过大。', 'error');
      return;
    }
    let envelope: unknown;
    try { envelope = JSON.parse(await file.text()); } catch {
      this.status('[data-local-status]', '这不是有效的备份文件。', 'error');
      return;
    }
    this.status('[data-local-status]', '');
    this.openRestore({ kind: 'file', envelope, label: file.name });
  }

  private openRestore(pending: NonNullable<BackupPage['pendingRestore']>): void {
    this.pendingRestore = pending;
    this.restoreForm.reset();
    const fromFile = pending.kind === 'file';
    this.get('[data-restore-target]').textContent = fromFile
      ? `将从本地文件 ${pending.label} 恢复。`
      : `将从远端备份 ${pending.name} 恢复。`;
    // 本地文件可能来自其他部署，口令未知，必须显式输入。
    this.get('[data-restore-hint]').textContent = fromFile || !this.settings?.hasPassphrase
      ? '请输入该备份文件的口令。' : '留空表示使用当前保存的备份口令。';
    this.get('[data-restore-error]').hidden = true;
    this.restoreDialog.showModal();
  }

  private async restore(): Promise<void> {
    const pending = this.pendingRestore;
    if (!pending) return;
    const passphrase = (this.restoreForm.elements.namedItem('passphrase') as HTMLInputElement).value;
    const mode = (this.restoreForm.querySelector<HTMLInputElement>('[name="mode"]:checked')?.value ?? 'merge') as 'merge' | 'replace';
    if (pending.kind === 'file' && !passphrase) {
      this.showRestoreError('请输入该备份文件的口令。');
      return;
    }
    if (mode === 'replace' && !confirm('覆盖恢复会先清空当前的主机、代码片段和转发规则，再写入备份内容。确定继续？')) return;
    const submit = this.restoreDialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
    await this.withBusy(submit, '恢复中…', async () => {
      try {
        const result = pending.kind === 'remote'
          ? await restoreRemoteBackup(pending.name, mode, passphrase || undefined)
          : await importBackup(pending.envelope, passphrase, mode);
        this.restoreDialog.close();
        this.status(pending.kind === 'remote' ? '[data-remote-status]' : '[data-local-status]', summarize(result), 'ok');
        // 恢复改写了主机与片段，通知主界面重新拉取。
        window.dispatchEvent(new Event('backup-restored'));
      } catch (error) {
        this.showRestoreError(this.message(error, '恢复失败。'));
      }
    });
  }

  private showRestoreError(message: string): void {
    const node = this.get('[data-restore-error]');
    node.textContent = message; node.hidden = false;
  }

  private async refreshRemote(): Promise<void> {
    if (!this.settings) { this.remote = []; this.renderRemote(); return; }
    this.status('[data-remote-status]', '正在读取远端目录…');
    try {
      this.remote = await listRemoteBackups();
      this.status('[data-remote-status]', '');
    } catch (error) {
      this.remote = [];
      this.status('[data-remote-status]', this.message(error, '无法读取远端目录。'), 'error');
    }
    this.renderRemote();
  }

  private renderRemote(): void {
    const list = this.get('[data-remote]');
    list.replaceChildren();
    if (!this.settings) {
      list.append(this.empty('配置 WebDAV 后，这里会列出远端的备份文件。'));
      return;
    }
    if (!this.remote.length) {
      list.append(this.empty('远端还没有备份文件，点右上角「立即备份」创建第一份。'));
      return;
    }
    for (const file of this.remote) {
      const row = document.createElement('article');
      row.className = 'backup-row';
      const copy = document.createElement('div');
      copy.className = 'backup-row-copy';
      const name = document.createElement('strong');
      name.textContent = file.name; name.title = file.name;
      const meta = document.createElement('small');
      meta.textContent = [when(file.modifiedAt), size(file.size)].filter(Boolean).join(' · ');
      copy.append(name, meta);
      const restore = document.createElement('button');
      restore.type = 'button'; restore.className = 'home-button'; restore.textContent = '恢复';
      restore.setAttribute('aria-label', `从 ${file.name} 恢复`);
      restore.addEventListener('click', () => this.openRestore({ kind: 'remote', name: file.name }));
      row.append(copy, restore);
      list.append(row);
    }
  }

  private renderHistory(): void {
    const list = this.get('[data-history]');
    list.replaceChildren();
    if (!this.history.length) {
      list.append(this.empty('还没有备份记录。'));
      return;
    }
    for (const run of this.history) {
      const row = document.createElement('article');
      row.className = 'backup-row';
      const dot = document.createElement('span');
      dot.className = `backup-dot${run.status === 'failure' ? ' is-failure' : ''}`;
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', run.status === 'failure' ? '失败' : '成功');
      const copy = document.createElement('div');
      copy.className = 'backup-row-copy';
      const title = document.createElement('strong');
      title.textContent = when(run.startedAt);
      title.style.fontFamily = 'inherit';
      const meta = document.createElement('small');
      const trigger = run.trigger === 'scheduled' ? '自动' : '手动';
      meta.textContent = run.status === 'failure'
        ? `${trigger} · ${run.error ?? '失败'}`
        : `${trigger} · ${run.counts ? `主机 ${run.counts.hosts} · 片段 ${run.counts.snippets} · 规则 ${run.counts.forwardRules}` : ''}${run.size ? ` · ${size(run.size)}` : ''}`;
      copy.append(title, meta);
      row.append(dot, copy);
      list.append(row);
    }
  }

  private empty(message: string): HTMLElement {
    const node = document.createElement('p');
    node.className = 'backup-empty';
    node.textContent = message;
    return node;
  }
}
