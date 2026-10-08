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
import { nowLabel, readJsonArray, removeFile, writeJson } from './jsonFileStore';
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
  'status', 'updated_at', 'image_url',
];
const RANGE = 'A:T';

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
  /** パッケージ画像（公式ページの og:image）。'' = まだ探していない / '-' = 見つからなかった */
  imageUrl:      string;
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
    imageUrl: String(c[19] ?? ''),
    rowIndex,
  };
}

function toCells(f: Food): (string | number)[] {
  return [
    f.foodId, f.key, f.name, f.chain, f.kind, f.storage, f.shelfDays ?? '', f.pieces ?? '', f.content,
    JSON.stringify(f.nutrients), f.basis, f.source, JSON.stringify(f.sources), f.fetchedAt || '',
    f.purchaseCount, f.lastPrice ?? '', JSON.stringify(f.prices.slice(-10)), f.status, nowLabel(), f.imageUrl,
  ];
}

// ─── 読み出し ─────────────────────────────────────────────────────────────────

let cache: { foods: Map<string, Food>; at: number } | null = null;
const CACHE_MS = 60_000;

let inflight: Promise<Map<string, Food>> | null = null;
/** 書き込むたびに進める。書き込みより前に始まった読み込みの結果をキャッシュに残さないため */
let generation = 0;

export async function loadFoods(force = false): Promise<Map<string, Food>> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.foods;
  // 画像の表示などで同時に何か所からも呼ばれるので、読み込み中なら同じ結果を待つ
  if (!force && inflight) return inflight;
  const task = readFoods().finally(() => { if (inflight === task) inflight = null; });
  inflight = task;
  return task;
}

async function readFoods(): Promise<Map<string, Food>> {
  const gen = generation;
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
        imageUrl: prev.imageUrl || f.imageUrl,
      });
    });
  }
  if (gen === generation) cache = { foods, at: Date.now() };
  return foods;
}

/**
 * チェーン名の別名（レシート・メールの店名が英字や略称のとき）。キーは食品データの chain 列の名前。
 * 短すぎて別の店名にも含まれうる略称（「マック」→ マックスバリュ など）は入れない。
 */
const CHAIN_ALIASES: Record<string, string[]> = {
  'マクドナルド':               ["McDonald's", 'McDonalds'],
  'モスバーガー':               ['MOS BURGER', 'MOSBURGER'],
  'バーガーキング':             ['BURGER KING'],
  'ドトール':                   ['DOUTOR'],
  'すき家':                     ['SUKIYA'],
  'ガスト':                     ['GUSTO'],
  'はま寿司':                   ['HAMA-SUSHI', 'HAMASUSHI', 'はまずし'],
  'ピザハット':                 ['PIZZA HUT', 'PIZZAHUT'],
  'コメダ珈琲店':               ['コメダ', 'KOMEDA'],
  'ケンタッキーフライドチキン': ['KFC', 'ケンタッキー', 'KENTUCKY'],
  'ミスタードーナツ':           ['ミスド', 'MISTER DONUT', 'MISTERDONUT'],
  'サンマルクカフェ':           ['サンマルク', 'ST.MARC', 'SAINT MARC'],
  'ドミノ・ピザ':               ["Domino's", 'DOMINOS'],
  '吉野家':                     ['YOSHINOYA'],
  'なか卯':                     ['NAKAU'],
  'やよい軒':                   ['YAYOIKEN'],
  '松のや':                     ['松乃家', 'MATSUNOYA'],
  'CoCo壱番屋':                 ['ココイチ', 'ココ壱', 'COCOICHI'],
  'リンガーハット':             ['RINGER HUT', 'RINGERHUT'],
  '天丼てんや':                 ['てんや', 'TENYA'],
  '富士そば':                   ['FUJISOBA'],
  'スシロー':                   ['SUSHIRO'],
  'しゃぶ葉':                   ['SHABUYO'],
  '洋麺屋五右衛門':             ['五右衛門', 'GOEMON'],
  'びっくりドンキー':           ['BIKKURI DONKEY'],
  'ペッパーランチ':             ['PEPPER LUNCH'],
  '回転寿司みさき':             ['みさき'],
  '壱角家':                     ['IKKAKUYA'],
  '銚子丸':                     ['CHOSHIMARU'],
  'カレーショップC&C':          ['C&C'],
  'ヴィ・ド・フランス':         ['VIE DE FRANCE'],
};

function chainNames(chain: string): string[] {
  return [chain, ...(CHAIN_ALIASES[chain] ?? [])];
}

/** 店名の照合用に揃える（全角英数を半角に、空白・中黒・アポストロフィ・ハイフンを消し、小文字に） */
function normalizeStore(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９＆．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　・'’\-‐－]/g, '')
    .toLowerCase();
}

/**
 * 飲食店のメニューを引く。店名は「マクドナルド 船橋日大前店」のように店舗名付きなので、
 * 食品データにあるチェーン名のうち店名に含まれるもの（別名を含む）を長い順に試す（自動の調査は店名そのものを
 * チェーン名として保存するので、「マクドナルド 船橋日大前店」と「マクドナルド」の両方がありうる）。
 * 品名はレシートの表記・写真から読んだ名前など、候補を順に試す。
 */
export function findMenu(foods: Map<string, Food>, store: string, names: string[]): Food | undefined {
  const s = normalizeStore(store);
  const chains = new Set<string>([store]);
  for (const f of foods.values()) {
    if (f.chain && !chains.has(f.chain) && chainNames(f.chain).some((n) => s.includes(normalizeStore(n)))) chains.add(f.chain);
  }
  const ordered = [...chains].sort((a, b) => b.length - a.length);
  for (const name of names.filter(Boolean)) {
    for (const chain of ordered) {
      const hit = freshNutrition(foods.get(foodKey(name, chain)));
      if (hit) return hit;
    }
  }
  return undefined;
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
type FoodColumns = 'purchase' | 'nutrition' | 'image';

function rangesFor(f: Food, cols: FoodColumns): { range: string; values: (string | number)[][] }[] {
  const c = toCells(f);
  const r = f.rowIndex;
  const at = (from: string, to: string, a: number, b: number) =>
    ({ range: `'${SHEET}'!${from}${r}:${to}${r}`, values: [c.slice(a, b + 1)] });
  if (cols === 'purchase') return [at('E', 'I', 4, 8), at('O', 'Q', 14, 16), at('S', 'S', 18, 18)];
  if (cols === 'nutrition') return [at('J', 'N', 9, 13), at('R', 'S', 17, 18)];
  return [at('T', 'T', 19, 19)];
}

/** 書き込みの途中で失敗した。`updated` は書けた（書き換えが済んだ）かどうか */
class PartialWriteError extends Error {
  constructor(readonly original: unknown, readonly updated: boolean) {
    super(original instanceof Error ? original.message : String(original));
  }
}

async function writeFoods(updates: Food[], appends: Food[], cols: FoodColumns): Promise<void> {
  if (updates.length === 0 && appends.length === 0) return;
  generation++;
  cache = null;
  try {
    await ensureSheet();
    const client = await SheetsInternal.createClient();
    if (updates.length > 0) {
      await client.post('/values:batchUpdate', {
        valueInputOption: 'RAW',
        data: updates.flatMap((f) => rangesFor(f, cols)),
      });
    }
    if (appends.length > 0) {
      try {
        await client.post(
          `/values/${encodeURIComponent(SHEET)}!${RANGE}:append`,
          { values: appends.map(toCells) },
          { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
        );
      } catch (e) {
        throw new PartialWriteError(e, updates.length > 0);
      }
    }
  } finally {
    generation++;
    cache = null;
  }
}

function newFood(key: string, name: string, chain: string): Food {
  return {
    foodId: newEntryId(), key, name, chain, kind: '', storage: '', shelfDays: null, pieces: null, content: '',
    nutrients: sanitizeNutrients({}), basis: 'package', source: '', sources: [], fetchedAt: 0,
    purchaseCount: 0, lastPrice: null, prices: [], status: 'pending', imageUrl: '', rowIndex: 0,
  };
}

/**
 * 記録できなかった購入（圏外で登録したレシートなど）。通信が戻ったら `flushPendingPurchases` で記録する。
 * 読んで足して書く処理なので、行の追記と違って未送信キューには積めない。
 */
const PENDING_FILE = 'pending-purchases.json';
/** 溜めすぎない（ずっと送れないときに端末のファイルが膨らみ続けないように） */
const PENDING_MAX = 200;

interface PendingPurchase {
  id:    string;
  items: ReceiptItem[];
}

/**
 * レシート・メールの品目を登録したときに呼ぶ。購入回数と価格を記録する（栄養は後で調べる）。
 * 失敗しても投げない（登録は済んでいる）。記録できなかった分は端末に残して後で記録する。
 */
export async function recordPurchases(items: ReceiptItem[]): Promise<void> {
  if (await Demo.isDemo()) return;
  const food = items.filter((it) => it.kind && it.kind !== 'non_food');
  if (food.length === 0) return;
  try {
    await writePurchases(food);
  } catch (e) {
    const rest = e instanceof PurchaseWriteError ? e.remaining : food;
    const cause = e instanceof PurchaseWriteError ? e.original : e;
    // 送り直しても通らない失敗（400 など）は残さない（同期のたびに同じ失敗を繰り返すだけ）
    if (rest.length === 0 || !SheetsInternal.isQueueable(cause)) {
      console.warn('[Food] 購入の記録に失敗:', e instanceof Error ? e.message : e);
      return;
    }
    console.warn('[Food] 購入の記録に失敗。後で記録する:', e instanceof Error ? e.message : e);
    const pending = readJsonArray<PendingPurchase>(PENDING_FILE);
    writeJson(PENDING_FILE, [...pending, { id: newEntryId(), items: rest }].slice(-PENDING_MAX));
  }
}

let flushing: Promise<void> | null = null;

/** 記録できなかった購入をまとめて記録する（App の同期で呼ぶ）。失敗したら残して次回に回す */
export function flushPendingPurchases(): Promise<void> {
  if (flushing) return flushing;
  const task = (async () => {
    try {
      if (await Demo.isDemo()) return;
      const pending = readJsonArray<PendingPurchase>(PENDING_FILE);
      if (pending.length === 0) return;
      // 記録している間に増えた分は残す
      const done = new Set(pending.map((p) => p.id));
      const replace = (extra: PendingPurchase[]) => {
        const rest = [...readJsonArray<PendingPurchase>(PENDING_FILE).filter((p) => !done.has(p.id)), ...extra];
        if (rest.length > 0) writeJson(PENDING_FILE, rest);
        else removeFile(PENDING_FILE);
      };
      try {
        await writePurchases(pending.flatMap((p) => p.items));
        replace([]);
      } catch (e) {
        // 送り直しても通らない失敗なら捨てる。既存の品目の書き換えだけ済んだ場合は、
        // 新しい品目だけ残す（済んだ分を二重に数えない）
        if (e instanceof PurchaseWriteError && !SheetsInternal.isQueueable(e.original)) {
          replace([]);
        } else if (e instanceof PurchaseWriteError && e.remaining.length < pending.flatMap((p) => p.items).length) {
          replace(e.remaining.length > 0 ? [{ id: newEntryId(), items: e.remaining }] : []);
        }
        throw e;
      }
    } catch (e) {
      console.warn('[Food] 未記録の購入を記録できなかった:', e instanceof Error ? e.message : e);
    }
  })();
  // await を通らずに終わる経路があるので、代入してから終わったら外す（`??=` だと終わった Promise が残る）
  flushing = task;
  task.finally(() => { if (flushing === task) flushing = null; });
  return task;
}

/** 購入の記録に失敗した。`remaining` はまだ記録できていない品目 */
class PurchaseWriteError extends Error {
  constructor(readonly original: unknown, readonly remaining: ReceiptItem[]) {
    super(original instanceof Error ? original.message : String(original));
  }
}

/**
 * 読んで足して書くので、この端末の中では 1 つずつ順に行う（起動直後の未記録分の記録と、
 * OCR・Gmail 取り込みの記録が重なると、片方の +1 が消えたり同じ品目の行が 2 行できたりする）
 */
let purchaseChain: Promise<unknown> = Promise.resolve();

function writePurchases(food: ReceiptItem[]): Promise<void> {
  const run = purchaseChain.then(() => writePurchasesNow(food));
  purchaseChain = run.catch(() => undefined);
  return run;
}

async function writePurchasesNow(food: ReceiptItem[]): Promise<void> {
  let foods: Map<string, Food>;
  try {
    foods = await loadFoods(true);
  } catch (e) {
    throw new PurchaseWriteError(e, food);
  }
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
  try {
    await writeFoods([...updates.values()], [...appends.values()], 'purchase');
  } catch (e) {
    if (e instanceof PartialWriteError && e.updated) {
      throw new PurchaseWriteError(e.original, food.filter((it) => appends.has(foodKey(it.normalized ?? it.name))));
    }
    throw new PurchaseWriteError(e instanceof PartialWriteError ? e.original : e, food);
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

/** パッケージ画像の URL を書く（見つからなかったときは '-'） */
export async function saveImageUrls(list: { food: Food; imageUrl: string }[]): Promise<void> {
  const rows = list.filter((x) => x.food.rowIndex > 0).map((x) => ({ ...x.food, imageUrl: x.imageUrl }));
  await writeFoods(rows, [], 'image');
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
