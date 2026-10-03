import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dueSince, nextRunAt, shouldRun, validateSchedule, type BackupSchedule,
} from '../src/accounts/backup-schedule.ts';

const at = (iso: string) => Date.parse(iso);
const schedule = (overrides: Partial<BackupSchedule> = {}): BackupSchedule =>
  ({ frequency: 'daily', hour: 3, weekday: 0, timeZone: 'UTC', ...overrides });

test('每日：dueSince 指向最近一个已到达的周期起点', () => {
  const daily = schedule({ hour: 3 });
  // 当天还没到点时，仍指向前一天那次——它才是「当前应当存在」的备份。
  assert.equal(dueSince(at('2026-03-10T02:30:00Z'), daily), at('2026-03-09T03:00:00Z'));
  assert.equal(dueSince(at('2026-03-10T03:05:00Z'), daily), at('2026-03-10T03:00:00Z'));
  // 当天过了点以后仍指向同一个周期起点，不会每小时重复备份。
  assert.equal(dueSince(at('2026-03-10T21:00:00Z'), daily), at('2026-03-10T03:00:00Z'));
});

test('每日：未到点且前一周期已备份则不执行', () => {
  const daily = schedule({ hour: 3 });
  // 02:30 指向前一天 03:00；已备份过就不该再跑。
  assert.equal(shouldRun(at('2026-03-10T02:30:00Z'), daily, at('2026-03-09T03:10:00Z')), false);
  // 但前一周期也漏了，就应该补上。
  assert.equal(shouldRun(at('2026-03-10T02:30:00Z'), daily, at('2026-03-08T03:10:00Z')), true);
});

test('每日：同一周期只跑一次，跨周期再跑', () => {
  const daily = schedule({ hour: 3 });
  const due = at('2026-03-10T03:00:00Z');
  assert.equal(shouldRun(at('2026-03-10T03:10:00Z'), daily, null), true);
  assert.equal(shouldRun(at('2026-03-10T03:10:00Z'), daily, due), false);
  assert.equal(shouldRun(at('2026-03-10T23:00:00Z'), daily, due), false);
  // 次日到点后应再次备份。
  assert.equal(shouldRun(at('2026-03-11T03:10:00Z'), daily, due), true);
});

test('每日：错过触发会在下一小时补跑', () => {
  const daily = schedule({ hour: 3 });
  // Worker 在 3 点那一小时没跑成，4 点醒来仍应补上当天备份。
  assert.equal(shouldRun(at('2026-03-10T04:05:00Z'), daily, at('2026-03-09T03:00:00Z')), true);
});

test('午夜 hour=0 能正确触发', () => {
  const midnight = schedule({ hour: 0 });
  assert.equal(dueSince(at('2026-03-10T00:30:00Z'), midnight), at('2026-03-10T00:00:00Z'));
  assert.equal(shouldRun(at('2026-03-10T00:30:00Z'), midnight, at('2026-03-09T00:00:00Z')), true);
  assert.equal(shouldRun(at('2026-03-10T05:00:00Z'), midnight, at('2026-03-10T00:00:00Z')), false);
});

test('每小时：每次触发都执行', () => {
  const hourly = schedule({ frequency: 'hourly' });
  const due = dueSince(at('2026-03-10T07:20:00Z'), hourly);
  assert.equal(due, at('2026-03-10T07:00:00Z'));
  assert.equal(shouldRun(at('2026-03-10T07:20:00Z'), hourly, at('2026-03-10T06:00:00Z')), true);
  // 同一小时内已备份过就不再重复。
  assert.equal(shouldRun(at('2026-03-10T07:40:00Z'), hourly, at('2026-03-10T07:05:00Z')), false);
});

test('每周：只在指定星期触发', () => {
  const weekly = schedule({ frequency: 'weekly', weekday: 1, hour: 2 });
  // 2026-03-09 是周一。
  assert.equal(dueSince(at('2026-03-09T02:30:00Z'), weekly), at('2026-03-09T02:00:00Z'));
  // 周二到周日都指向本周一那次，不会另起一次。
  assert.equal(dueSince(at('2026-03-11T12:00:00Z'), weekly), at('2026-03-09T02:00:00Z'));
  assert.equal(shouldRun(at('2026-03-11T12:00:00Z'), weekly, at('2026-03-09T02:00:00Z')), false);
  assert.equal(shouldRun(at('2026-03-16T02:30:00Z'), weekly, at('2026-03-09T02:00:00Z')), true);
});

test('按时区换算本地时间', () => {
  const shanghai = schedule({ hour: 3, timeZone: 'Asia/Shanghai' });
  // 上海 03:00 == 前一天 19:00 UTC。
  assert.equal(dueSince(at('2026-03-09T19:30:00Z'), shanghai), at('2026-03-09T19:00:00Z'));
  assert.equal(dueSince(at('2026-03-09T18:30:00Z'), shanghai), at('2026-03-08T19:00:00Z'));
  // 半小时偏移时区同样成立（印度 UTC+5:30，03:00 == 21:30 UTC）。
  const kolkata = schedule({ hour: 3, timeZone: 'Asia/Kolkata' });
  const due = dueSince(at('2026-03-09T22:00:00Z'), kolkata);
  assert.equal(due, at('2026-03-09T22:00:00Z'));
});

test('夏令时前跳：跳过的目标小时当天仍会备份', () => {
  // 纽约 2026-03-08 02:00 不存在（直接跳到 03:00）。
  const spring = schedule({ hour: 2, timeZone: 'America/New_York' });
  const due = dueSince(at('2026-03-08T12:00:00Z'), spring);
  assert.notEqual(due, null);
  // 该时刻的本地日期必须是 3-08，证明是当天补上而不是落到前一天。
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(due!));
  assert.equal(local, '2026-03-08');
  assert.equal(shouldRun(at('2026-03-08T12:00:00Z'), spring, at('2026-03-07T07:00:00Z')), true);
});

test('夏令时回拨：重复出现的小时只备份一次', () => {
  // 纽约 2026-11-01 01:00 出现两次。
  const fall = schedule({ hour: 1, timeZone: 'America/New_York' });
  const first = dueSince(at('2026-11-01T05:30:00Z'), fall);   // 第一次 01:00 EDT
  const second = dueSince(at('2026-11-01T06:30:00Z'), fall);  // 第二次 01:00 EST
  assert.equal(first, second, '两次都应归到同一个周期起点');
  assert.equal(shouldRun(at('2026-11-01T06:30:00Z'), fall, first!), false);
});

test('nextRunAt 给出未来的下一次时刻', () => {
  const daily = schedule({ hour: 3 });
  assert.equal(nextRunAt(at('2026-03-10T05:00:00Z'), daily), at('2026-03-11T03:00:00Z'));
  assert.equal(nextRunAt(at('2026-03-10T01:00:00Z'), daily), at('2026-03-10T03:00:00Z'));
  const hourly = schedule({ frequency: 'hourly' });
  assert.equal(nextRunAt(at('2026-03-10T05:10:00Z'), hourly), at('2026-03-10T06:00:00Z'));
  const weekly = schedule({ frequency: 'weekly', weekday: 1, hour: 2 });
  assert.equal(nextRunAt(at('2026-03-10T05:00:00Z'), weekly), at('2026-03-16T02:00:00Z'));
});

test('校验时间表并保留既有值', () => {
  assert.deepEqual(validateSchedule(undefined), { frequency: 'daily', hour: 3, weekday: 0, timeZone: 'UTC' });
  assert.deepEqual(validateSchedule({ frequency: 'weekly', weekday: 5, hour: 22, timeZone: 'Asia/Shanghai' }),
    { frequency: 'weekly', hour: 22, weekday: 5, timeZone: 'Asia/Shanghai' });
  // 只传部分字段时沿用之前的设置。
  const previous = schedule({ frequency: 'weekly', hour: 9, weekday: 3, timeZone: 'Europe/Paris' });
  assert.deepEqual(validateSchedule({ hour: 10 }, previous),
    { frequency: 'weekly', hour: 10, weekday: 3, timeZone: 'Europe/Paris' });
  assert.throws(() => validateSchedule({ frequency: 'yearly' }), /备份频率无效/);
  assert.throws(() => validateSchedule({ hour: 24 }), /0 到 23/);
  assert.throws(() => validateSchedule({ hour: 1.5 }), /0 到 23/);
  assert.throws(() => validateSchedule({ weekday: 7 }), /星期无效/);
  assert.throws(() => validateSchedule({ timeZone: 'Not/AZone' }), /时区无效/);
});
