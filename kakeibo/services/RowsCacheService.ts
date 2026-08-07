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

import { File, Paths } from 'expo-file-system';
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

function cacheFile(): File {
  return new File(Paths.document, FILE_NAME);
}

function load(): CacheEntry[] {
  if (cache) return cache;
  try {
    const f = cacheFile();
    cache = f.exists ? (JSON.parse(f.textSync()) as CacheEntry[]) : [];
    if (!Array.isArray(cache)) cache = [];
  } catch (e) {
    // 壊れていても起動は止めない。溜まっていた分は諦める
    console.error('[RowsCache] 読み込み失敗。空として扱う:', e);
    cache = [];
  }
  return cache;
}

function persist(): void {
  try {
    const f = cacheFile();
    if (!f.exists) f.create({ overwrite: true });
    f.write(JSON.stringify(cache ?? []));
  } catch (e) {
    console.error('[RowsCache] 保存失敗:', e);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function nowLabel(): string {
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
