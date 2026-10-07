/**
 * 食事の記録（`_meals_YYYY-MM`）の読み書き。仕様は docs/meal-nutrition-spec.md §3.3 / §3.5.2。
 *
 * - **1 行 = 1 人 × 1 品。** 二人で分けた品は 2 行（同じ dish_id）になる。
 * - 同時編集の検出: 行ごとに `rev` を持ち、保存の直前にシートの `rev` と読み込み時の値を比べる。
 *   食い違ったら `MealConflictError` を投げ、画面側で「相手の内容を残す / 上書きする」を選ばせる。
 * - 上書きの直前の内容は `_history` に残し、編集画面から戻せる。
 * - 読み直しから書き込みまでの 1 往復の間に相手が保存した場合は検出できない
 *   （Sheets API に条件付き書き込みが無いため。`_history` から戻せる）。
 */

import { SheetsInternal, appendHistoryRow, newEntryId } from './SheetsService';
import { nowLabel } from './jsonFileStore';
import { Nutrients, sanitizeNutrients } from './Nutrients';
import * as Demo from './DemoService';
import * as WriteQueue from './WriteQueueService';

export type MealKind       = 'eat_out' | 'packaged' | 'home';
export type MealStatus     = 'estimated' | 'needs_review' | 'edited';
export type NutrientSource = 'grounding' | 'food_table' | 'estimate';
export type Confidence     = 'high' | 'medium' | 'low';

export interface ItemRef {
  itemId:    string;
  usedRatio: number;
}

export interface MealRow {
  mealId:         string;
  dishId:         string;
  /** 'YYYY/MM/DD HH:MM:SS'（撮影日時） */
  eatenAt:        string;
  user:           string;
  kind:           MealKind;
  store:          string;
  dish:           string;
  /** その人が食べた割合（1 品全体に対して 0〜1） */
  portion:        number;
  /** **その人が食べた分**の栄養 */
  nutrients:      Nutrients;
  nutrientSource: NutrientSource;
  confidence:     Confidence;
  entryId:        string;
  itemRefs:       ItemRef[];
  status:         MealStatus;
  assignedBy:     'auto' | 'manual';
  /** 写真の参照（`local:...` / `shared:<photo_id>`）。1 回の食事に複数枚付けられる */
  photoRefs:      string[];
  rev:            number;
  /** grounding で参照したページ */
  sources:        string[];
  updatedBy:      string;
  updatedAt:      string;
  deleted?:       boolean;
  rowIndex?:      number;
  sheetName?:     string;
}

export const MEALS_HEADER = [
  'meal_id', 'dish_id', 'eaten_at', 'user', 'kind', 'store', 'dish', 'portion', 'nutrients',
  'nutrient_source', 'confidence', 'entry_id', 'item_refs', 'status', 'assigned_by', 'photo_refs',
  'rev', 'sources', 'updated_by', 'updated_at', 'deleted',
];
const MEALS_RANGE = 'A:U';

const HISTORY_SHEET = '_history';

const CORRECTIONS_SHEET  = '_meal_corrections';
const CORRECTIONS_HEADER = ['corrected_at', 'meal_id', 'dish_id', 'field', 'before', 'after', 'context'];

/** 相手が先に保存していた */
export class MealConflictError extends Error {
  constructor(public readonly current: MealRow[], public readonly savedBy: string) {
    super('ほかの端末で先に保存されています');
    this.name = 'MealConflictError';
  }
}

export function mealsSheetName(eatenAt: string): string {
  const m = eatenAt.match(/^(\d{4})[\/\-](\d{2})/);
  return `_meals_${m ? `${m[1]}-${m[2]}` : 'unknown'}`;
}

export function newMealId(): string {
  return newEntryId();
}

function toCells(r: MealRow): (string | number)[] {
  return [
    r.mealId, r.dishId, r.eatenAt, r.user, r.kind, r.store, r.dish, r.portion,
    JSON.stringify(r.nutrients), r.nutrientSource, r.confidence, r.entryId,
    JSON.stringify(r.itemRefs), r.status, r.assignedBy, JSON.stringify(r.photoRefs),
    r.rev, JSON.stringify(r.sources), r.updatedBy, r.updatedAt, r.deleted ? 'TRUE' : 'FALSE',
  ];
}

function parseJsonCell<T>(cell: unknown, fallback: T): T {
  try {
    const v = JSON.parse(String(cell ?? ''));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function fromCells(c: string[], rowIndex: number, sheetName: string): MealRow {
  const portion = Number(c[7]);
  return {
    mealId:         c[0] ?? '',
    dishId:         c[1] ?? '',
    eatenAt:        c[2] ?? '',
    user:           c[3] ?? '',
    kind:           (c[4] as MealKind) || 'eat_out',
    store:          c[5] ?? '',
    dish:           c[6] ?? '',
    portion:        Number.isFinite(portion) ? portion : 1,
    nutrients:      sanitizeNutrients(parseJsonCell(c[8], {})),
    nutrientSource: (c[9] as NutrientSource) || 'estimate',
    confidence:     (c[10] as Confidence) || 'low',
    entryId:        c[11] ?? '',
    itemRefs:       parseJsonCell<ItemRef[]>(c[12], []),
    status:         (c[13] as MealStatus) || 'estimated',
    assignedBy:     c[14] === 'manual' ? 'manual' : 'auto',
    photoRefs:      parseJsonCell<string[]>(c[15], []),
    rev:            Number(c[16]) || 0,
    sources:        parseJsonCell<string[]>(c[17], []),
    updatedBy:      c[18] ?? '',
    updatedAt:      c[19] ?? '',
    deleted:        (c[20] ?? '').toString().toUpperCase() === 'TRUE',
    rowIndex,
    sheetName,
  };
}

// ─── 読み出し ─────────────────────────────────────────────────────────────────

async function readSheet(sheetName: string): Promise<MealRow[]> {
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  if (!names.includes(sheetName)) return [];
  const res = await client.get(`/values/${encodeURIComponent(sheetName)}!${MEALS_RANGE}`);
  const values: string[][] = res.data.values ?? [];
  return values.slice(1).map((c, i) => fromCells(c, i + 2, sheetName)).filter((r) => r.mealId);
}

/** その月の食事（削除済みを除く） */
export async function getMeals(yearMonth: string): Promise<MealRow[]> {
  if (await Demo.isDemo()) return [];
  return (await readSheet(`_meals_${yearMonth}`)).filter((r) => !r.deleted);
}

/** 1 回の食事の行（削除済みを除く） */
export async function getMeal(sheetName: string, mealId: string): Promise<MealRow[]> {
  return (await readSheet(sheetName)).filter((r) => r.mealId === mealId && !r.deleted);
}

/** その食事がもう記録されているか（未送信キューに積んであるものを含む） */
export async function mealExists(sheetName: string, mealId: string): Promise<boolean> {
  const queued = WriteQueue.list().some((q) =>
    q.op.kind === 'appendRaw' && q.op.sheetName === sheetName && q.op.rows.some((r) => r[0] === mealId));
  if (queued) return true;
  return (await getMeal(sheetName, mealId)).length > 0;
}

export function mealRev(rows: MealRow[]): number {
  return rows.reduce((m, r) => Math.max(m, r.rev), 0);
}

// ─── 書き込み ─────────────────────────────────────────────────────────────────

/**
 * 新しい食事を追記する。通信できなければ未送信キューに積む（QueuedWriteError を投げる）。
 */
export async function appendMeal(rows: MealRow[]): Promise<void> {
  if (rows.length === 0 || (await Demo.isDemo())) return;
  const sheetName = mealsSheetName(rows[0].eatenAt);
  await SheetsInternal.writeOrQueue({
    kind:   'appendRaw',
    sheetName,
    header: MEALS_HEADER,
    range:  MEALS_RANGE,
    label:  `食事の追加: ${rows[0].store || rows[0].dish}`,
    rows:   rows.map((r) => toCells({ ...r, rev: r.rev || 1 })),
  });
}

/**
 * 食事を保存する（行の追加・変更・削除をまとめて）。
 *
 * @param baseRev 画面に読み込んだときの rev。シートの rev と違えば MealConflictError
 * @param force   true なら食い違っても上書きする（「自分の内容で上書きする」を選んだとき）
 *
 * 行の対応は dish_id + user で取る。新しい行には rowIndex が無くてよい。
 * 通信できない場合はキューに積まずに投げる（後から流すと相手の編集を黙って上書きしうるため）。
 */
export async function saveMeal(
  sheetName: string,
  mealId: string,
  next: MealRow[],
  baseRev: number,
  savedBy: string,
  opts: { force?: boolean } = {},
): Promise<MealRow[]> {
  if (await Demo.isDemo()) return next;
  const client = await SheetsInternal.createClient();
  const current = await getMeal(sheetName, mealId);
  const currentRev = mealRev(current);
  if (currentRev !== baseRev && !opts.force) {
    const by = current.find((r) => r.rev === currentRev)?.updatedBy ?? '';
    throw new MealConflictError(current, by);
  }

  // 上書きする直前の内容を残す（戻せるように）
  if (current.length > 0) {
    await appendHistory(`meal:${mealId}`, currentRev, sheetName, current);
  }

  const rev = currentRev + 1;
  const now = nowLabel();
  const keyOf = (r: MealRow) => `${r.dishId}|${r.user}`;
  const currentByKey = new Map(current.map((r) => [keyOf(r), r]));
  const nextKeys = new Set(next.map(keyOf));

  const updates: { range: string; values: (string | number)[][] }[] = [];
  const appends: (string | number)[][] = [];
  const saved: MealRow[] = [];

  for (const r of next) {
    const row: MealRow = { ...r, mealId, rev, updatedBy: savedBy, updatedAt: now, deleted: false };
    const existing = currentByKey.get(keyOf(r));
    if (existing?.rowIndex) {
      updates.push({ range: `'${sheetName}'!A${existing.rowIndex}:U${existing.rowIndex}`, values: [toCells(row)] });
      saved.push({ ...row, rowIndex: existing.rowIndex, sheetName });
    } else {
      appends.push(toCells(row));
      saved.push({ ...row, sheetName });
    }
  }
  // 消えた行は論理削除にする（行番号をずらさない）
  for (const r of current) {
    if (nextKeys.has(keyOf(r)) || !r.rowIndex) continue;
    const row: MealRow = { ...r, rev, updatedBy: savedBy, updatedAt: now, deleted: true };
    updates.push({ range: `'${sheetName}'!A${r.rowIndex}:U${r.rowIndex}`, values: [toCells(row)] });
  }

  if (updates.length > 0) {
    await client.post('/values:batchUpdate', { valueInputOption: 'RAW', data: updates });
  }
  if (appends.length > 0) {
    if (await SheetsInternal.ensureSheet(client, sheetName)) {
      await SheetsInternal.writeHeaderRow(client, sheetName, MEALS_HEADER);
    }
    await client.post(
      `/values/${encodeURIComponent(sheetName)}!${MEALS_RANGE}:append`,
      { values: appends },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
  }
  return saved;
}

/** 食事を丸ごと削除する（論理削除） */
export async function deleteMeal(
  sheetName: string, mealId: string, baseRev: number, savedBy: string, opts: { force?: boolean } = {},
): Promise<void> {
  await saveMeal(sheetName, mealId, [], baseRev, savedBy, opts);
}

// ─── 履歴 ─────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  rev:     number;
  savedBy: string;
  savedAt: string;
  rows:    MealRow[];
}

async function appendHistory(key: string, rev: number, sheet: string, rows: MealRow[]): Promise<void> {
  // 参照 URL は品ごとに重複していて大きい。1 セル 5 万文字に収まるよう履歴には残さない
  const snapshot = rows.map(({ rowIndex: _r, sheetName: _s, sources: _src, ...rest }) => ({ ...rest, sources: [] }));
  await appendHistoryRow(key, rev, sheet, JSON.stringify(snapshot));
}

/** 食事の過去の内容（新しい順） */
export async function getMealHistory(mealId: string): Promise<HistoryEntry[]> {
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  if (!names.includes(HISTORY_SHEET)) return [];
  const res = await client.get(`/values/${encodeURIComponent(HISTORY_SHEET)}!A:F`);
  const values: string[][] = res.data.values ?? [];
  return values
    .slice(1)
    .filter((c) => c[0] === `meal:${mealId}`)
    .map((c) => ({
      rev:     Number(c[1]) || 0,
      savedBy: c[2] ?? '',
      savedAt: c[3] ?? '',
      rows:    parseJsonCell<MealRow[]>(c[5], []).map((r) => ({ ...r, nutrients: sanitizeNutrients(r.nutrients) })),
    }))
    .sort((a, b) => b.rev - a.rev);
}

// ─── 手修正の履歴（段階 4 で推定に使う） ─────────────────────────────────────

export interface Correction {
  mealId:  string;
  dishId:  string;
  field:   'user' | 'portion' | 'dish' | 'amount';
  before:  string;
  after:   string;
  context: string;
}

export async function logCorrections(list: Correction[]): Promise<void> {
  if (list.length === 0 || (await Demo.isDemo())) return;
  const at = nowLabel();
  try {
    await SheetsInternal.writeOrQueue({
      kind:   'appendRaw',
      sheetName: CORRECTIONS_SHEET,
      header: CORRECTIONS_HEADER,
      range:  'A:G',
      label:  `食事の修正履歴 ${list.length}件`,
      rows:   list.map((c) => [at, c.mealId, c.dishId, c.field, c.before, c.after, c.context]),
    });
  } catch (e) {
    // 履歴が残らないだけ。保存自体は済んでいる
    console.warn('[Meal] 修正履歴を書けなかった:', e instanceof Error ? e.message : e);
  }
}

/** 直近の手修正（新しい順、最大 limit 件）。推定の指示文に添える */
export async function recentCorrections(limit = 20): Promise<Correction[]> {
  try {
    const client = await SheetsInternal.createClient();
    const names = await SheetsInternal.listSheetNames(client, true);
    if (!names.includes(CORRECTIONS_SHEET)) return [];
    const res = await client.get(`/values/${encodeURIComponent(CORRECTIONS_SHEET)}!A:G`);
    const values: string[][] = res.data.values ?? [];
    return values.slice(1).reverse().slice(0, limit).map((c) => ({
      mealId: c[1] ?? '', dishId: c[2] ?? '', field: (c[3] as Correction['field']) ?? 'user',
      before: c[4] ?? '', after: c[5] ?? '', context: c[6] ?? '',
    }));
  } catch {
    return [];
  }
}
