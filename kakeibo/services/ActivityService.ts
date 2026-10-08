/**
 * からだの記録（歩数・睡眠・活動カロリー・運動・体重）。Android のヘルスコネクトから読み、1 日 1 行で
 * `_activity` に残す（夫婦で見られる。端末を替えても残る）。仕様は docs/meal-nutrition-spec.md §12。
 *
 * `_activity`: user | date（YYYY-MM-DD）| steps | sleep_min | active_kcal | exercise_min | weight_kg | updated_at
 *
 * - スマートリング（b.ring など）・スマホの歩数・体重計のアプリがヘルスコネクトに書いたものを読む（書き込みはしない）
 * - 日付は 0 時区切り。睡眠は「その日の朝に起きた分」（前日 18 時〜当日 18 時に終わった睡眠）
 * - 権限の確認はユーザーが「連携する」を押したときだけ出す。起動時は許可済みのときだけ黙って読む
 */

import {
  SdkAvailabilityStatus, aggregateRecord, getGrantedPermissions, getSdkStatus, initialize, openHealthConnectSettings,
  readRecords, requestPermission,
} from 'react-native-health-connect';
import type { Permission } from 'react-native-health-connect';
import { SheetsInternal } from './SheetsService';
import { nowLabel } from './jsonFileStore';
import { shiftDay, toDay } from './NutritionJudge';
import * as Demo from './DemoService';

const SHEET = '_activity';
export const ACTIVITY_HEADER = ['user', 'date', 'steps', 'sleep_min', 'active_kcal', 'exercise_min', 'weight_kg', 'updated_at'];
/** 起動時・からだタブで読み直す日数 */
const SYNC_DAYS = 14;

export interface DayActivity {
  user:        string;
  date:        string;
  steps:       number | null;
  sleepMin:    number | null;
  activeKcal:  number | null;
  exerciseMin: number | null;
  weightKg:    number | null;
}

const PERMISSIONS: Permission[] = [
  { accessType: 'read', recordType: 'Steps' },
  { accessType: 'read', recordType: 'SleepSession' },
  { accessType: 'read', recordType: 'ActiveCaloriesBurned' },
  { accessType: 'read', recordType: 'ExerciseSession' },
  { accessType: 'read', recordType: 'Weight' },
];

export type HealthStatus = 'unavailable' | 'needs_update' | 'not_connected' | 'connected';

/** ヘルスコネクトが使えるか・許可済みか */
export async function healthStatus(): Promise<HealthStatus> {
  try {
    const sdk = await getSdkStatus();
    if (sdk === SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) return 'needs_update';
    if (sdk !== SdkAvailabilityStatus.SDK_AVAILABLE) return 'unavailable';
    if (!(await initialize())) return 'unavailable';
    const granted = await getGrantedPermissions();
    return granted.some((p) => p.recordType === 'Steps' || p.recordType === 'SleepSession') ? 'connected' : 'not_connected';
  } catch {
    return 'unavailable';
  }
}

/** 連携する（権限の確認を出す）。1 つでも許可されたら true */
export async function connectHealth(): Promise<boolean> {
  if (!(await initialize())) return false;
  const granted = await requestPermission(PERMISSIONS);
  return granted.length > 0;
}

export function openHealthSettings(): void {
  openHealthConnectSettings();
}

function localMidnight(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    // 許可されていない種類・データが無いときは null（ほかの項目は読む）
    return null;
  }
}

/** ヘルスコネクトから、その日の記録を読む */
async function readDay(user: string, day: string, sleeps: { end: number; minutes: number }[], weights: { at: number; kg: number }[]): Promise<DayActivity> {
  const start = localMidnight(day);
  const end = localMidnight(shiftDay(day, 1));
  const timeRangeFilter = { operator: 'between' as const, startTime: start.toISOString(), endTime: end.toISOString() };
  const [steps, active, exercise] = await Promise.all([
    safe(() => aggregateRecord({ recordType: 'Steps', timeRangeFilter })),
    safe(() => aggregateRecord({ recordType: 'ActiveCaloriesBurned', timeRangeFilter })),
    safe(() => aggregateRecord({ recordType: 'ExerciseSession', timeRangeFilter })),
  ]);
  // 睡眠: 前日 18 時〜当日 18 時に終わったもの（その日の朝に起きた分）
  const sleepFrom = start.getTime() - 6 * 3600_000;
  const sleepTo = start.getTime() + 18 * 3600_000;
  const sleepMin = sleeps.filter((s) => s.end >= sleepFrom && s.end < sleepTo).reduce((a, s) => a + s.minutes, 0);
  // 体重: その日の最後に量った値
  const weight = weights.filter((w) => w.at >= start.getTime() && w.at < end.getTime()).sort((a, b) => b.at - a.at)[0];
  const stepCount = steps?.COUNT_TOTAL ?? 0;
  const activeKcal = active?.ACTIVE_CALORIES_TOTAL?.inKilocalories ?? 0;
  const exerciseSec = exercise?.EXERCISE_DURATION_TOTAL?.inSeconds ?? 0;
  return {
    user, date: day,
    steps: stepCount > 0 ? Math.round(stepCount) : null,
    sleepMin: sleepMin > 0 ? Math.round(sleepMin) : null,
    activeKcal: activeKcal > 0 ? Math.round(activeKcal) : null,
    exerciseMin: exerciseSec > 0 ? Math.round(exerciseSec / 60) : null,
    weightKg: weight ? Math.round(weight.kg * 10) / 10 : null,
  };
}

/** 直近の日をヘルスコネクトから読む（今日を含む。古い順） */
export async function readRecentDays(user: string, days = SYNC_DAYS, now: Date = new Date()): Promise<DayActivity[]> {
  const todayStr = toDay(now);
  const first = shiftDay(todayStr, -(days - 1));
  const rangeStart = new Date(localMidnight(first).getTime() - 6 * 3600_000).toISOString();
  const rangeEnd = new Date(now.getTime() + 60_000).toISOString();
  const timeRangeFilter = { operator: 'between' as const, startTime: rangeStart, endTime: rangeEnd };
  const [sleepRes, weightRes] = await Promise.all([
    safe(() => readRecords('SleepSession', { timeRangeFilter })),
    safe(() => readRecords('Weight', { timeRangeFilter })),
  ]);
  const sleeps = (sleepRes?.records ?? []).map((r) => {
    const s = Date.parse(r.startTime);
    const e = Date.parse(r.endTime);
    // 寝ていなかった段階（起きている・ベッドの外）を除く
    const awake = (r.stages ?? [])
      .filter((st) => st.stage === 1 || st.stage === 3)
      .reduce((a, st) => a + (Date.parse(st.endTime) - Date.parse(st.startTime)), 0);
    return { end: e, minutes: Math.max(0, (e - s - awake) / 60_000) };
  });
  const weights = (weightRes?.records ?? []).map((r) => ({ at: Date.parse(r.time), kg: r.weight.inKilograms }));
  const out: DayActivity[] = [];
  for (let d = first; d <= todayStr; d = shiftDay(d, 1)) out.push(await readDay(user, d, sleeps, weights));
  return out;
}

// ─── `_activity` ─────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  const n = Number(v);
  return v === '' || v === undefined || v === null || !Number.isFinite(n) ? null : n;
}

/** 全員の記録（日付の古い順） */
export async function loadActivity(): Promise<DayActivity[]> {
  if (await Demo.isDemo()) return [];
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  if (!names.includes(SHEET)) return [];
  const res = await client.get(`/values/${encodeURIComponent(SHEET)}!A:H`, { params: { valueRenderOption: 'UNFORMATTED_VALUE' } });
  const byKey = new Map<string, DayActivity>();
  ((res.data.values ?? []) as any[][]).forEach((c, i) => {
    if (i === 0 || !c[0] || !c[1]) return;
    byKey.set(`${c[0]}|${c[1]}`, {
      user: String(c[0]), date: String(c[1]), steps: num(c[2]), sleepMin: num(c[3]), activeKcal: num(c[4]),
      exerciseMin: num(c[5]), weightKg: num(c[6]),
    });
  });
  return [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function toCells(a: DayActivity): (string | number)[] {
  return [a.user, a.date, a.steps ?? '', a.sleepMin ?? '', a.activeKcal ?? '', a.exerciseMin ?? '', a.weightKg ?? '', nowLabel()];
}

/** 読んだ日を `_activity` に書く（同じ人・同じ日の行があれば書き換える） */
async function saveDays(list: DayActivity[]): Promise<void> {
  if (list.length === 0) return;
  const client = await SheetsInternal.createClient();
  if (await SheetsInternal.ensureSheet(client, SHEET)) {
    await SheetsInternal.writeHeaderRow(client, SHEET, ACTIVITY_HEADER);
  }
  const res = await client.get(`/values/${encodeURIComponent(SHEET)}!A:B`);
  const rowOf = new Map<string, number>();
  ((res.data.values ?? []) as string[][]).forEach((c, i) => { if (i > 0 && c[0]) rowOf.set(`${c[0]}|${c[1]}`, i + 1); });
  const updates = list.filter((a) => rowOf.has(`${a.user}|${a.date}`));
  const appends = list.filter((a) => !rowOf.has(`${a.user}|${a.date}`));
  if (updates.length > 0) {
    await client.post('/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: updates.map((a) => {
        const r = rowOf.get(`${a.user}|${a.date}`)!;
        return { range: `'${SHEET}'!A${r}:H${r}`, values: [toCells(a)] };
      }),
    });
  }
  if (appends.length > 0) {
    await client.post(
      `/values/${encodeURIComponent(SHEET)}!A:H:append`,
      { values: appends.map(toCells) },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
  }
}

let syncing: Promise<boolean> | null = null;

/**
 * ヘルスコネクトの直近の記録を `_activity` に写す。許可されていなければ何もしない（確認は出さない）。
 * 写したら true。失敗しても投げない
 */
export function syncActivity(user: string): Promise<boolean> {
  if (syncing) return syncing;
  const task = (async () => {
    try {
      if (!user || (await Demo.isDemo()) || (await healthStatus()) !== 'connected') return false;
      const days = (await readRecentDays(user))
        .filter((d) => d.steps !== null || d.sleepMin !== null || d.activeKcal !== null || d.exerciseMin !== null || d.weightKg !== null);
      await saveDays(days);
      return days.length > 0;
    } catch (e) {
      console.warn('[Activity] ヘルスコネクトから写せなかった:', e instanceof Error ? e.message : e);
      return false;
    }
  })();
  syncing = task;
  task.finally(() => { if (syncing === task) syncing = null; });
  return task;
}

// ─── 目安と活動レベル ─────────────────────────────────────────────────────────

/** 1 日の歩数の目安（健康づくりのための身体活動・運動ガイド 2023: 成人 8,000 歩・高齢者 6,000 歩） */
export function stepGoal(age: number | null): number {
  return age !== null && age >= 65 ? 6000 : 8000;
}

/** 睡眠の目安（健康づくりのための睡眠ガイド 2023: 成人はおおむね 6 時間以上） */
export const SLEEP_GOAL_MIN = 6 * 60;

/**
 * 直近 14 日の歩数の平均から、身体活動レベル（食事摂取基準の I・II・III）を決める。記録が 3 日に満たなければ null。
 * 目安: 6,000 歩未満 = I（低い）/ 10,000 歩未満 = II（ふつう）/ それ以上 = III（高い）
 */
export function autoActivityLevel(list: DayActivity[], user: string, today: string): 'I' | 'II' | 'III' | null {
  const from = shiftDay(today, -14);
  const steps = list.filter((a) => a.user === user && a.date >= from && a.date < today && a.steps !== null).map((a) => a.steps!);
  if (steps.length < 3) return null;
  const avg = steps.reduce((x, y) => x + y, 0) / steps.length;
  return avg < 6000 ? 'I' : avg < 10000 ? 'II' : 'III';
}
