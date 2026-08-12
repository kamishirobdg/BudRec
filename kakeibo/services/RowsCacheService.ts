/**
 * オフライン対応（読み取り側）。
 *
 * WriteQueueService が「送れなかった書き込み」を端末に退避するのに対し、こちらは
 * 「最後に読み込めた一覧」を表示範囲（月/年/全期間）ごとに端末へ残しておく。
 * 通信できずに一覧取得が失敗したとき、この端末内キャッシュがあればそれを表示することで
 * 電波が無い場所でも直近のデータを見られるようにする（読み取り専用。書き込みには使わない）。
 *
 * 保存場所: `<documentDirectory>/rows-cache.json`
 */

import { nowLabel, readJsonArray, writeJson } from './jsonFileStore';
import type { ExpenseRow, RangeSpec } from './SheetsService';

const FILE_NAME = 'rows-cache.json';
/** 直近に見た範囲だけ持てば足りる（月・年・全期間を行ったり来たりしても数件で収まる） */
const MAX_ENTRIES = 8;

interface CacheEntry {
  key:     string;
  savedAt: string; // 'YYYY/MM/DD HH:MM:SS'
  rows:    ExpenseRow[];
}

/** null = まだファイルを読んでいない */
let cache: CacheEntry[] | null = null;

function load(): CacheEntry[] {
  if (cache) return cache;
  cache = readJsonArray<CacheEntry>(FILE_NAME);
  return cache;
}

function persist(): void {
  writeJson(FILE_NAME, cache ?? []);
}

/** 表示範囲をキャッシュのキーに変換する */
export function rangeKey(range: RangeSpec): string {
  if (range.type === 'month') return `month:${range.yearMonth}`;
  if (range.type === 'year')  return `year:${range.year}`;
  return 'all';
}

/** 取得できた一覧をこの端末に残す */
export function save(range: RangeSpec, rows: ExpenseRow[]): void {
  const key = rangeKey(range);
  const items = load().filter((e) => e.key !== key);
  items.unshift({ key, savedAt: nowLabel(), rows });
  cache = items.slice(0, MAX_ENTRIES);
  persist();
}

/** この範囲のキャッシュがあれば返す（無ければ null） */
export function get(range: RangeSpec): { rows: ExpenseRow[]; savedAt: string } | null {
  const entry = load().find((e) => e.key === rangeKey(range));
  return entry ? { rows: entry.rows, savedAt: entry.savedAt } : null;
}

/** 全部捨てる（サインアウト時。同じ端末で別アカウントに切り替えたときに前アカウントの
 *  データがオフラインキャッシュとして残らないようにする） */
export function clear(): void {
  cache = [];
  persist();
}
