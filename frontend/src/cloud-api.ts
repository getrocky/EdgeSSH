import { demoApiResult } from './demo-hosts';

export interface HostLocation {
  ip?: string; city: string; region?: string; country: string; countryCode: string; latitude: number; longitude: number;
}

export interface HostSystemInfo {
  family: 'linux' | 'darwin' | 'freebsd' | 'windows' | 'unknown';
  distribution: string;
  name: string;
  version: string;
  architecture: string;
}

export interface CloudHost {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  initialCommand: string;
  termType: string;
  encoding: string;
  fingerprint: string;
  location: HostLocation | null;
  system: HostSystemInfo | null;
  hasCredential: boolean;
  updatedAt: number;
}

export interface Credentials { password?: string; privateKey?: string }
export type HostInput = Omit<CloudHost, 'id' | 'location' | 'system' | 'hasCredential' | 'updatedAt'> & Credentials;

export class APIError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const result = demoApiResult(path, method);
    if (result !== undefined) return result as T;
  }
  const response = await fetch(path, {
    method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    window.dispatchEvent(new Event('auth-required'));
    throw new APIError('登录已过期，请重新登录。', 401);
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('auth-required'));
    throw new APIError(typeof data.error === 'string' ? data.error : '请求失败，请重试。', response.status);
  }
  return data as T;
}

export const listHosts = async (): Promise<CloudHost[]> => (await api<{ hosts: CloudHost[] }>('/api/hosts')).hosts;
export const hostCredentials = (id: string): Promise<Credentials> => api(`/api/hosts/${id}/credentials`, 'POST');
export const refreshHostLocation = async (id: string): Promise<CloudHost> =>
  (await api<{ host: CloudHost }>(`/api/hosts/${id}/location`, 'POST')).host;
export const updateHostSystem = async (id: string, system: HostSystemInfo): Promise<CloudHost> =>
  (await api<{ host: CloudHost }>(`/api/hosts/${id}/system`, 'POST', system)).host;
export const saveHost = async (input: HostInput, id?: string): Promise<CloudHost> =>
  (await api<{ host: CloudHost }>(id ? `/api/hosts/${id}` : '/api/hosts', id ? 'PUT' : 'POST', input)).host;
export const removeHost = (id: string): Promise<{ ok: boolean }> => api(`/api/hosts/${id}`, 'DELETE');

export type BackupFrequency = 'hourly' | 'daily' | 'weekly';

export interface BackupSchedule {
  frequency: BackupFrequency;
  hour: number;
  weekday: number;
  timeZone: string;
}

export interface BackupSettingsView {
  enabled: boolean;
  url: string;
  username: string;
  prefix: string;
  keep: number;
  schedule: BackupSchedule;
  hasPassword: boolean;
  hasPassphrase: boolean;
}

export interface BackupSettingsInput {
  enabled: boolean;
  url: string;
  username: string;
  password?: string;
  passphrase?: string;
  prefix: string;
  keep: number;
  schedule: BackupSchedule;
}

export interface BackupCounts { hosts: number; snippets: number; forwardRules: number }

export interface BackupRun {
  id: string;
  startedAt: number;
  trigger: 'manual' | 'scheduled';
  status: 'success' | 'failure';
  remoteName: string | null;
  size: number | null;
  counts: BackupCounts | null;
  error: string | null;
}

export interface RemoteBackupFile { name: string; size: number; modifiedAt: number }

export interface RestoreSummary {
  hosts: { restored: number; skipped: number };
  snippets: { restored: number; skipped: number };
  forwardRules: { restored: number; skipped: number };
}

export interface RestoreResult { summary: RestoreSummary; counts: BackupCounts; createdAt: number }

export const loadBackupSettings = (): Promise<{
  settings: BackupSettingsView | null; history: BackupRun[]; lastSuccessAt: number | null; nextRunAt: number | null;
}> => api('/api/backup/settings');
export const saveBackupSettings = (input: BackupSettingsInput): Promise<{ settings: BackupSettingsView; nextRunAt: number | null }> =>
  api('/api/backup/settings', 'PUT', input);
export const removeBackupSettings = (): Promise<{ ok: boolean }> => api('/api/backup/settings', 'DELETE');
export const testBackupTarget = (input: BackupSettingsInput): Promise<{ ok: boolean }> => api('/api/backup/test', 'POST', input);
export const runBackupNow = (): Promise<{ run: BackupRun; history: BackupRun[]; nextRunAt: number | null }> =>
  api('/api/backup/run', 'POST');
export const listRemoteBackups = async (): Promise<RemoteBackupFile[]> =>
  (await api<{ files: RemoteBackupFile[] }>('/api/backup/remote')).files;
export const restoreRemoteBackup = (name: string, mode: 'merge' | 'replace', passphrase?: string): Promise<RestoreResult> =>
  api('/api/backup/restore', 'POST', { name, mode, ...(passphrase ? { passphrase } : {}) });
export const exportBackup = (passphrase: string): Promise<{ envelope: unknown; filename: string; counts: BackupCounts }> =>
  api('/api/backup/export', 'POST', { passphrase });
export const importBackup = (envelope: unknown, passphrase: string, mode: 'merge' | 'replace'): Promise<RestoreResult> =>
  api('/api/backup/import', 'POST', { envelope, passphrase, mode });
