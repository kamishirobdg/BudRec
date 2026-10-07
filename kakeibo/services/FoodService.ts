/**
 * 食品データ（`_foods`）。品目・メニューごとに栄養（と、使い道が決まるまで記録するだけの価格）を持ち、
 * 同じ食品が何度出てきても検索は最初の 1 回で済ませる。仕様は docs/meal-nutrition-spec.md §3.7。
 *
 * - レシート・メールの品目を登録したら、購入回数と価格を記録する（栄養はまだ無い = pending）
 * - 栄養が要るときはまずここを引く。無ければ grounding で調べて足す
 * - 空き時間（OCR の待ちが無いとき）に、pending を購入回数の多い順に少しずつ調べる（1 日の上限あり）
 * - 調べてから 180 日経ったら調べ直す。在庫・食事の画面の「調べ直す」でいつでも調べ直せる
 */

import { SheetsInternal, newEntryId } from './SheetsService';
import { nowLabel } from './jsonFileStore';
import { getItem, setItem } from './Storage';
import { Nutrients, sanitizeNutrients } from './Nutrients';
import { researchFoods, FoodQuery, FoodNutrition } from '../providers/GeminiMeal';
import { QuotaExceededError } from '../providers/AIProvider';
import type { ReceiptItem } from '../providers/AIProvider';
import * as Demo from './DemoService';

const SHEET = '_foods';
const HEADER = [
  'food_id', 'key', 'name', 'chain', 'kind', 'storage', 'shelf_days', 'pieces', 'content',
  'nutrients', 'basis', 'source', 'sources', 'fetched_at', 'purchase_count', 'last_price', 'prices',
  'status', 'updated_at',
];
const RANGE = 'A:S';

const REFRESH_MS = 180 * 24 * 60 * 60 * 1000;
/** 空き時間に 1 日に調べる品目数の上限（grounding の無料枠を通常の OCR に残すため） */
const DAILY_RESEARCH_LIMIT = 30;
/** 1 回の grounding でまとめて調べる品目数 */
const BATCH = 5;
const RESEARCH_COUNTER_KEY = 'food_research_counter';

export type FoodStatus = 'pending' | 'done' | 'failed';

export interface Food {
  foodId:        string;
  key:           string;
  name:          string;
  chain:         string;
  kind:          string;
  storage:       string;
  shelfDays:     number | null;
  pieces:        number | null;
  content:       string;
  nutrients:     Nutrients;
  basis:         'piece' | 'package' | 'per100g';
  source:        'grounding' | 'estimate' | '';
  sources:       string[];
  fetchedAt:     number;
  purchaseCount: number;
  lastPrice:     number | null;
  prices:        number[];
  status:        FoodStatus;
  rowIndex:      number;
}

/** 品名（とチェーン名）から引く鍵。表記の揺れは Gemini の正規化に任せ、ここでは空白と大小文字だけ揃える */
export function foodKey(name: string, chain = ''): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return chain ? `${norm(chain)}|${norm(name)}` : norm(name);
}

function parseJsonCell<T>(cell: unknown, fallback: T): T {
  try {
    return (JSON.parse(String(cell ?? '')) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function fromCells(c: any[], rowIndex: number): Food {
  const num = (v: unknown) => (v === '' || v === undefined || v === null ? null : Number(v));
  return {
    foodId: String(c[0] ?? ''), key: String(c[1] ?? ''), name: String(c[2] ?? ''), chain: String(c[3] ?? ''),
    kind: String(c[4] ?? ''), storage: String(c[5] ?? ''), shelfDays: num(c[6]), pieces: num(c[7]),
    content: String(c[8] ?? ''), nutrients: sanitizeNutrients(parseJsonCell(c[9], {})),
    basis: c[10] === 'per100g' ? 'per100g' : c[10] === 'piece' ? 'piece' : 'package',
    source: c[11] === 'grounding' || c[11] === 'estimate' ? c[11] : '',
    sources: parseJsonCell<string[]>(c[12], []), fetchedAt: Number(c[13]) || 0,
    purchaseCount: Number(c[14]) || 0, lastPrice: num(c[15]), prices: parseJsonCell<number[]>(c[16], []),
    status: c[17] === 'done' || c[17] === 'failed' ? c[17] : 'pending',
    rowIndex,
  };
}

function toCells(f: Food): (string | number)[] {
  return [
    f.foodId, f.key, f.name, f.chain, f.kind, f.storage, f.shelfDays ?? '', f.pieces ?? '', f.content,
    JSON.stringify(f.nutrients), f.basis, f.source, JSON.stringify(f.sources), f.fetchedAt || '',
    f.purchaseCount, f.lastPrice ?? '', JSON.stringify(f.prices.slice(-10)), f.status, nowLabel(),
  ];
}

// ─── 読み出し ─────────────────────────────────────────────────────────────────

let cache: { foods: Map<string, Food>; at: number } | null = null;
const CACHE_MS = 60_000;

export async function loadFoods(force = false): Promise<Map<string, Food>> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.foods;
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  const foods = new Map<string, Food>();
  if (names.includes(SHEET)) {
    const res = await client.get(`/values/${encodeURIComponent(SHEET)}!${RANGE}`, {
      params: { valueRenderOption: 'UNFORMATTED_VALUE' },
    });
    ((res.data.values ?? []) as any[][]).forEach((c, i) => {
      if (i === 0 || !c[1]) return;
      const f = fromCells(c, i + 1);
      const prev = foods.get(f.key);
      if (!prev) {
        foods.set(f.key, f);
        return;
      }
      // 二人の端末が同じ品目を同時に足すと同じ鍵の行が 2 行できる。最初の行に寄せ、
      // 栄養は調べ済みの方を、購入回数は多い方を使う
      const nutrition = prev.status === 'done' ? prev : f.status === 'done' ? f : prev;
      foods.set(f.key, {
        ...prev,
        nutrients: nutrition.nutrients, basis: nutrition.basis, source: nutrition.source,
        sources: nutrition.sources, fetchedAt: nutrition.fetchedAt, status: nutrition.status,
        purchaseCount: Math.max(prev.purchaseCount, f.purchaseCount),
      });
    });
  }
  cache = { foods, at: Date.now() };
  return foods;
}

/** 調べ済みで新しい栄養があれば返す */
export function freshNutrition(f: Food | undefined): Food | null {
  if (!f || f.status !== 'done' || Date.now() - f.fetchedAt > REFRESH_MS) return null;
  return Object.values(f.nutrients).some((v) => v !== null) ? f : null;
}

// ─── 書き込み ─────────────────────────────────────────────────────────────────

async function ensureSheet(): Promise<void> {
  const client = await SheetsInternal.createClient();
  if (await SheetsInternal.ensureSheet(client, SHEET)) {
    await SheetsInternal.writeHeaderRow(client, SHEET, HEADER);
  }
}

/**
 * 書き換えるのは役割ごとの列だけにする。購入の記録（E〜I・O〜Q）と栄養の調査（J〜N・R）が同時に走っても、
 * 相手が書いた列を古い値で上書きしない。
 */
type FoodColumns = 'purchase' | 'nutrition';

function rangesFor(f: Food, cols: FoodColumns): { range: string; values: (string | number)[][] }[] {
  const c = toCells(f);
  const r = f.rowIndex;
  const at = (from: string, to: string, a: number, b: number) =>
    ({ range: `'${SHEET}'!${from}${r}:${to}${r}`, values: [c.slice(a, b + 1)] });
  return cols === 'purchase'
    ? [at('E', 'I', 4, 8), at('O', 'Q', 14, 16), at('S', 'S', 18, 18)]
    : [at('J', 'N', 9, 13), at('R', 'S', 17, 18)];
}

async function writeFoods(updates: Food[], appends: Food[], cols: FoodColumns): Promise<void> {
  if (updates.length === 0 && appends.length === 0) return;
  await ensureSheet();
  const client = await SheetsInternal.createClient();
  if (updates.length > 0) {
    await client.post('/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: updates.flatMap((f) => rangesFor(f, cols)),
    });
  }
  if (appends.length > 0) {
    await client.post(
      `/values/${encodeURIComponent(SHEET)}!${RANGE}:append`,
      { values: appends.map(toCells) },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
  }
  cache = null;
}

function newFood(key: string, name: string, chain: string): Food {
  return {
    foodId: newEntryId(), key, name, chain, kind: '', storage: '', shelfDays: null, pieces: null, content: '',
    nutrients: sanitizeNutrients({}), basis: 'package', source: '', sources: [], fetchedAt: 0,
    purchaseCount: 0, lastPrice: null, prices: [], status: 'pending', rowIndex: 0,
  };
}

/**
 * レシート・メールの品目を登録したときに呼ぶ。購入回数と価格を記録する（栄養は後で調べる）。
 * 失敗しても投げない（登録は済んでいる）。
 */
export async function recordPurchases(items: ReceiptItem[]): Promise<void> {
  try {
    if (await Demo.isDemo()) return;
    const food = items.filter((it) => it.kind && it.kind !== 'non_food');
    if (food.length === 0) return;
    const foods = await loadFoods(true);
    const updates = new Map<string, Food>();
    const appends = new Map<string, Food>();
    for (const it of food) {
      const name = it.normalized ?? it.name;
      const key = foodKey(name);
      const base = updates.get(key) ?? appends.get(key) ?? foods.get(key) ?? newFood(key, name, '');
      const next: Food = {
        ...base,
        kind: it.kind ?? base.kind,
        storage: it.storage ?? base.storage,
        shelfDays: it.shelfDays ?? base.shelfDays,
        pieces: it.pieces ?? base.pieces,
        content: it.quantity ? `${it.quantity}${it.unit ?? ''}` : base.content,
        purchaseCount: base.purchaseCount + 1,
        lastPrice: it.price || base.lastPrice,
        prices: it.price ? [...base.prices, it.price] : base.prices,
      };
      if (next.rowIndex > 0) updates.set(key, next);
      else appends.set(key, next);
    }
    await writeFoods([...updates.values()], [...appends.values()], 'purchase');
  } catch (e) {
    console.warn('[Food] 購入の記録に失敗:', e instanceof Error ? e.message : e);
  }
}

/** 調べた栄養を保存する（無ければ作る） */
export async function saveResearched(entries: { query: FoodQuery; result: FoodNutrition; sources: string[] }[]): Promise<void> {
  if (entries.length === 0) return;
  const foods = await loadFoods(true);
  const updates: Food[] = [];
  const appends: Food[] = [];
  for (const { query, result, sources } of entries) {
    const key = foodKey(query.name, query.chain);
    const base = foods.get(key) ?? newFood(key, query.name, query.chain);
    const got = Object.values(result.nutrients).some((v) => v !== null);
    const next: Food = {
      ...base,
      kind: base.kind || query.kind,
      nutrients: got ? result.nutrients : base.nutrients,
      basis: got ? result.basis : base.basis,
      source: got ? (result.official ? 'grounding' : 'estimate') : base.source,
      sources: got ? sources : base.sources,
      fetchedAt: Date.now(),
      // 調べ直して見つからなくても、前に調べた値は使い続ける
      status: got || base.status === 'done' ? 'done' : 'failed',
    };
    (next.rowIndex > 0 ? updates : appends).push(next);
  }
  await writeFoods(updates, appends, 'nutrition');
}

/** 調べ直す（在庫・食事の画面の「調べ直す」）。調べた結果を返す */
export async function researchNow(query: FoodQuery): Promise<Food | null> {
  const { results, sources } = await researchFoods([query]);
  await saveResearched([{ query, result: results[0], sources }]);
  return (await loadFoods(true)).get(foodKey(query.name, query.chain)) ?? null;
}

// ─── 空き時間の調査 ───────────────────────────────────────────────────────────

async function todayCount(): Promise<{ date: string; count: number }> {
  const today = new Date().toDateString();
  try {
    const saved = JSON.parse((await getItem(RESEARCH_COUNTER_KEY)) ?? '{}');
    if (saved?.date === today) return { date: today, count: Number(saved.count) || 0 };
  } catch {
    // 壊れていたら 0 から
  }
  return { date: today, count: 0 };
}

/**
 * まだ栄養の無い品目（と 180 日経った品目）を、購入回数の多い順に 1 回ぶん（最大 5 品）調べる。
 * 調べたら true。上限に達した・調べるものが無いときは false。QuotaExceededError はそのまま投げる。
 */
export async function researchSomePending(signal?: AbortSignal): Promise<boolean> {
  if (await Demo.isDemo()) return false;
  const counter = await todayCount();
  if (counter.count >= DAILY_RESEARCH_LIMIT) return false;

  const foods = [...(await loadFoods(true)).values()];
  const due = foods
    .filter((f) => f.status === 'pending' || (f.status === 'done' && Date.now() - f.fetchedAt > REFRESH_MS))
    .sort((a, b) => b.purchaseCount - a.purchaseCount)
    .slice(0, Math.min(BATCH, DAILY_RESEARCH_LIMIT - counter.count));
  if (due.length === 0) return false;

  const queries: FoodQuery[] = due.map((f) => ({
    name: f.name, chain: f.chain, kind: (f.kind as FoodQuery['kind']) || 'packaged', content: f.content,
  }));
  // 呼ぶ前に数える。失敗（読み取りの失敗・保存の失敗）を数えないと、同じ品目を何度も調べて無料枠を使い続ける
  await setItem(RESEARCH_COUNTER_KEY, JSON.stringify({ date: counter.date, count: counter.count + due.length }));
  try {
    const { results, sources } = await researchFoods(queries, signal);
    await saveResearched(queries.map((query, i) => ({ query, result: results[i], sources })));
  } catch (e) {
    // 無料枠切れなら今日はもう調べない
    if (e instanceof QuotaExceededError) {
      await setItem(RESEARCH_COUNTER_KEY, JSON.stringify({ date: counter.date, count: DAILY_RESEARCH_LIMIT }));
    }
    throw e;
  }
  return true;
}
