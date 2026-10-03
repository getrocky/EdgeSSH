import { APIError } from './http.ts';

export type BackupFrequency = 'hourly' | 'daily' | 'weekly';

export interface BackupSchedule {
  frequency: BackupFrequency;
  /** 本地时间的小时（0-23）。hourly 时忽略。 */
  hour: number;
  /** 0=周日 … 6=周六，仅 weekly 使用。 */
  weekday: number;
  /** IANA 时区名，决定上面两项如何换算成真实时刻。 */
  timeZone: string;
}

const HOUR_MS = 3_600_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Cron 每小时触发一次，所以回溯/前瞻都以整小时为步长。
const LOOKBACK_HOURS: Record<BackupFrequency, number> = { hourly: 1, daily: 26, weekly: 24 * 8 + 2 };

export const DEFAULT_SCHEDULE: BackupSchedule = { frequency: 'daily', hour: 3, weekday: 0, timeZone: 'UTC' };

function hourStart(instant: number): number {
  return Math.floor(instant / HOUR_MS) * HOUR_MS;
}

export function isValidTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

interface LocalParts { hour: number; weekday: number; day: string }

/** 取某一时刻在指定时区的本地小时、星期与日期键。 */
function localParts(instant: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  // hour12:false 在部分实现里把午夜给成 24，归一化成 0。
  const hour = Number(value('hour')) % 24;
  return {
    hour,
    weekday: WEEKDAYS.indexOf(value('weekday')),
    day: `${value('year')}-${value('month')}-${value('day')}`,
  };
}

/**
 * 判断某个整小时是否为「本周期内第一个到达设定时刻的小时」。
 *
 * 用「达到目标小时且上一小时尚未达到」来判断，而不是要求小时精确相等，
 * 这样夏令时跳过目标小时（例如 2:00 直接跳到 3:00）时当天仍会备份；
 * 回拨导致某小时重复出现时也只认第一次，不会重复备份。
 * 额外比较本地日期，使 hour=0（午夜）同样成立。
 */
function isPeriodStart(instant: number, schedule: BackupSchedule): boolean {
  if (schedule.frequency === 'hourly') return true;
  const current = localParts(instant, schedule.timeZone);
  if (schedule.frequency === 'weekly' && current.weekday !== schedule.weekday) return false;
  if (current.hour < schedule.hour) return false;
  const previous = localParts(instant - HOUR_MS, schedule.timeZone);
  return previous.day !== current.day || previous.hour < schedule.hour;
}

/**
 * 返回当前周期的备份「应当开始的时刻」，尚未到点则返回 null。
 * 与最近一次成功备份比较即可决定这次要不要跑，Worker 错过触发也会在下一小时补上。
 */
export function dueSince(now: number, schedule: BackupSchedule): number | null {
  const current = hourStart(now);
  for (let index = 0; index < LOOKBACK_HOURS[schedule.frequency]; index += 1) {
    const candidate = current - index * HOUR_MS;
    if (isPeriodStart(candidate, schedule)) return candidate;
  }
  return null;
}

/** 下一次备份时刻，用于界面展示。 */
export function nextRunAt(now: number, schedule: BackupSchedule): number | null {
  const start = hourStart(now) + HOUR_MS;
  for (let index = 0; index < LOOKBACK_HOURS[schedule.frequency] + 24; index += 1) {
    const candidate = start + index * HOUR_MS;
    if (isPeriodStart(candidate, schedule)) return candidate;
  }
  return null;
}

/** 到点且这一周期还没成功备份过时才执行；手动备份同样会推迟下一次自动备份。 */
export function shouldRun(now: number, schedule: BackupSchedule, lastSuccessAt: number | null): boolean {
  const due = dueSince(now, schedule);
  if (due === null) return false;
  return lastSuccessAt === null || lastSuccessAt < due;
}

export function validateSchedule(value: unknown, previous?: BackupSchedule): BackupSchedule {
  if (value === undefined || value === null) return previous ?? DEFAULT_SCHEDULE;
  if (typeof value !== 'object' || Array.isArray(value)) throw new APIError('备份时间表格式无效。');
  const raw = value as Record<string, unknown>;
  const frequency = raw.frequency ?? previous?.frequency ?? DEFAULT_SCHEDULE.frequency;
  if (frequency !== 'hourly' && frequency !== 'daily' && frequency !== 'weekly') throw new APIError('备份频率无效。');
  const hour = raw.hour ?? previous?.hour ?? DEFAULT_SCHEDULE.hour;
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new APIError('备份时间必须是 0 到 23 之间的整数小时。');
  const weekday = raw.weekday ?? previous?.weekday ?? DEFAULT_SCHEDULE.weekday;
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new APIError('备份星期无效。');
  const timeZone = raw.timeZone ?? previous?.timeZone ?? DEFAULT_SCHEDULE.timeZone;
  if (typeof timeZone !== 'string' || timeZone.length > 64 || !isValidTimeZone(timeZone)) throw new APIError('时区无效。');
  return { frequency, hour, weekday, timeZone };
}
