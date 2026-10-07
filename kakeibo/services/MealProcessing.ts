/**
 * 食事写真 → 料理の判別 → レシートとのひも付け → 栄養の推定 → 誰が食べたか → 記録、までの処理。
 * 仕様は docs/meal-nutrition-spec.md §5・§6。裏の OCR（OcrWorker）から呼ぶ。
 *
 * レシートは「料理を撮ってからレシートを撮る」順が普通なので、両方向で突き合わせる:
 * - 食事を処理するときに、撮影時刻の前後 3 時間のレシートが既にあればひも付ける
 * - レシートを登録したときに、前後 3 時間の食事でまだレシートの無いものがあればひも付け直す
 */

import { SheetsInternal, ExpenseRow, getRowsRaw, getUniqueUsers, newEntryId } from './SheetsService';
import { AuthError } from './AuthService';
import type { ReceiptItem } from '../providers/AIProvider';
import { getCurrentUser } from './UserService';
import {
  analyzePhoto, lookupNutrition, matchReceiptItems,
  IdentifiedDish, InventoryLine, NutritionQuery, NutritionResult, ReceiptLine, UsedItem,
} from '../providers/GeminiMeal';
import { listInventory, remainLabel, consume, InventoryItem } from './InventoryService';
import { Food, foodKey, freshNutrition, loadFoods, saveResearched } from './FoodService';
import { rowsFromReceipts } from './ReceiptProcessing';
import * as CategoryService from './CategoryService';
import {
  MealRow, Confidence, ItemChoice, ItemRef, appendMeal, getMeals, mealRev, mealsSheetName, newMealId,
  recentCorrections, saveMeal, MealConflictError,
} from './MealService';
import { Nutrients, scaleNutrients } from './Nutrients';
import * as Demo from './DemoService';
import { ensureMealShared } from './SharedPhotos';

/** 食事写真とレシートを突き合わせる時間幅 */
const LINK_WINDOW_MS = 3 * 60 * 60 * 1000;

// ─── 時刻 ─────────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function epochToTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'YYYY/MM/DD HH:MM:SS' → エポックミリ秒（Hermes の文字列パースに頼らない） */
export function timestampToEpoch(ts: string): number | null {
  const m = ts.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
}

/** 前後の月のシート名（境目をまたぐ突き合わせ用） */
function monthsAround(ms: number): string[] {
  const d = new Date(ms);
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const name = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}`;
  const set = new Set([name(d)]);
  if (d.getDate() === 1) set.add(name(prev));
  if (new Date(ms + LINK_WINDOW_MS).getMonth() !== d.getMonth()) set.add(name(next));
  return [...set];
}

// ─── レシートの品目 ───────────────────────────────────────────────────────────

export interface ReceiptCandidate {
  entryId:   string;
  store:     string;
  timestamp: string;
  at:        number;
  lines:     ReceiptLine[];
}

/** 撮影時刻の前後 3 時間で、食品の品目があるレシートのうち最も近いもの */
async function findReceiptNear(shotAt: number): Promise<ReceiptCandidate | null> {
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  const byEntry = new Map<string, ReceiptCandidate>();

  for (const month of monthsAround(shotAt)) {
    const sheet = `_items_${month}`;
    if (!names.includes(sheet)) continue;
    const res = await client.get(`/values/${encodeURIComponent(sheet)}!A:S`);
    const values: string[][] = res.data.values ?? [];
    for (const c of values.slice(1)) {
      const entryId = c[1] ?? '';
      const at = timestampToEpoch(c[2] ?? '');
      if (!entryId || at === null || Math.abs(at - shotAt) > LINK_WINDOW_MS) continue;
      if ((c[10] ?? '') === 'non_food') continue;
      const cand = byEntry.get(entryId) ?? { entryId, store: c[4] ?? '', timestamp: c[2] ?? '', at, lines: [] };
      cand.lines.push({ index: cand.lines.length, name: c[6] || c[5] || '', price: Number(c[9]) || 0 });
      byEntry.set(entryId, cand);
    }
  }
  // 削除した支出行の品目は _items に残るので、月次シートで生きている行だけにする
  const live = new Set<string>();
  for (const month of monthsAround(shotAt)) {
    for (const r of await getRowsRaw(month)) if (r.entryId) live.add(r.entryId);
  }
  const list = [...byEntry.values()].filter((c) => live.has(c.entryId));
  if (list.length === 0) return null;
  list.sort((a, b) => Math.abs(a.at - shotAt) - Math.abs(b.at - shotAt));
  return list[0];
}

// ─── 割り振り ─────────────────────────────────────────────────────────────────

interface Serving {
  dishIndex: number;
  /** 一品を二人で分けるなら 2 行（portion 0.5 ずつ） */
  eaters:    { user: string; portion: number }[];
  /** 割り振りに自信が無い */
  unsure:    boolean;
}

/**
 * 料理を人に割り振る。判別に困るときだけ unsure を立てる（確認を挟むのはその場合だけ）。
 * - 取り分ける料理 → 二人で半分ずつ
 * - 一人前が 1 つだけ → 撮った人
 * - 同じ一人前が 2 つ → 一人 1 つずつ
 * - 一人前が人数分あってどちらの分か分からない → 仮に交互に割り当てて unsure
 */
function assign(dishes: IdentifiedDish[], photographer: string, partner: string | null): Serving[] {
  const servings: Serving[] = [];
  const singles: { dishIndex: number; eater: IdentifiedDish['eater'] }[] = [];

  dishes.forEach((d, i) => {
    if (d.shared || d.eater === 'both') {
      servings.push({
        dishIndex: i,
        eaters: partner
          ? [{ user: photographer, portion: 0.5 }, { user: partner, portion: 0.5 }]
          : [{ user: photographer, portion: 1 }],
        unsure: false,
      });
      return;
    }
    for (let k = 0; k < d.count; k++) singles.push({ dishIndex: i, eater: d.eater });
  });

  const onlyOne = singles.length === 1;
  const unknownCount = singles.filter((s) => s.eater === 'unknown').length;
  // 同じ料理がちょうど 2 つ → 一人 1 つずつ、で迷わない
  const pairOfSame = partner && singles.length === 2 && singles[0].dishIndex === singles[1].dishIndex;

  let toggle = 0;
  singles.forEach((s, k) => {
    let user = photographer;
    let unsure = false;
    if (s.eater === 'partner' && partner) user = partner;
    else if (s.eater === 'photographer') user = photographer;
    else if (onlyOne) user = photographer;
    else if (pairOfSame) user = k === 0 ? photographer : partner!;
    else if (partner) {
      user = toggle++ % 2 === 0 ? photographer : partner;
      unsure = unknownCount > 0;
    }
    servings.push({ dishIndex: s.dishIndex, eaters: [{ user, portion: 1 }], unsure });
  });
  return servings;
}


// ─── 写真の振り分け ───────────────────────────────────────────────────────────

/** 在庫の候補（振り分けの指示文に渡した順。料理の used / choices の index はこの並び） */
export interface InventoryRef {
  index:           number;
  itemId:          string;
  name:            string;
  store:           string;
  bought:          string;
  pieces:          number | null;
  remaining:       number;
  remainingPieces: number | null;
}

/**
 * 振り分けの結果。画像の状態ファイルに保存しておき、書き込みの途中でアプリが終了されても
 * Gemini を呼び直さずに続きから書けるようにする（ID は先に振ってある）。
 */
export interface StoredAnalysis {
  /** ID 付きの支出行（レシートが写っていなければ空） */
  receiptRows:  ExpenseRow[];
  dishes:       IdentifiedDish[];
  inventory:    InventoryRef[];
  mealId:       string;
  photographer: string;
  partner:      string | null;
}

/** 在庫の候補として振り分けに渡す件数の上限（指示文が長くなりすぎないように） */
const MAX_INVENTORY = 80;

/**
 * 撮った写真を 1 回の呼び出しでレシートと料理・食品に振り分けて読む。
 * QuotaExceededError / CancelledError はそのまま投げる。
 */
export async function analyzeCapturedPhoto(
  base64: string,
  proxyUser: string | undefined,
  signal: AbortSignal,
): Promise<StoredAnalysis> {
  const photographer = proxyUser ?? await getCurrentUser();
  const partner = (await getUniqueUsers()).find((u) => u !== photographer) ?? null;
  const corrections = (await recentCorrections(20))
    .map((c) => `${c.context}: ${fieldLabel(c.field)}を「${c.before}」→「${c.after}」に修正`);

  let stock: InventoryItem[] = [];
  try {
    stock = (await listInventory(false)).slice(0, MAX_INVENTORY);
  } catch (e) {
    console.warn('[Meal] 在庫を読めなかった:', e instanceof Error ? e.message : e);
  }
  const inventory: InventoryRef[] = stock.map((it, index) => ({
    index, itemId: it.itemId, name: it.name, store: it.store,
    bought: `${new Date(it.purchasedMs).getMonth() + 1}/${new Date(it.purchasedMs).getDate()}`,
    pieces: it.pieces, remaining: it.remaining, remainingPieces: it.remainingPieces,
  }));
  const lines: InventoryLine[] = stock.map((it, index) => ({
    index, name: it.name, store: it.store, bought: inventory[index].bought,
    storage: it.storage === 'chilled' ? '冷蔵' : it.storage === 'frozen' ? '冷凍' : it.storage === 'ambient' ? '常温' : '',
    remain: remainLabel(it),
  }));

  const categories = await CategoryService.getCategories();
  const res = await analyzePhoto(base64, categories, { photographer, partner, corrections, inventory: lines }, signal);
  const receiptRows = (await rowsFromReceipts(res.receipts, proxyUser))
    .map((r) => ({ ...r, entryId: newEntryId() }));
  return { receiptRows, dishes: res.dishes, inventory, mealId: newMealId(), photographer, partner };
}

// ─── 食事の記録 ───────────────────────────────────────────────────────────────

export interface MealResult {
  mealId:      string;
  sheetName:   string;
  needsReview: boolean;
  /** 二人にまたがる食事か（写真を相手と共有する対象） */
  sharedMeal:  boolean;
  rows:        MealRow[];
  /** 未送信に積んだうえで再サインインが要る状態になった（記録は後で届く） */
  authFailed:  boolean;
}

/**
 * 使った在庫の量を「1 パック（入り数ぶん）のうちの割合」にする。
 * 解釈できない（入り数の無い品目に個数が返った・量が無い）ときは null（栄養は検索に回す）。
 */
function packageFraction(ref: InventoryRef, used: UsedItem): number | null {
  if (used.pieces && ref.pieces) return used.pieces / ref.pieces;
  if (used.ratio && used.ratio > 0) return used.ratio * ref.remaining;
  return null;
}

/** 食品データの栄養（単位つき）から、食べた分の栄養を出す。出せなければ null */
function nutrientsFromFood(food: Food, ref: InventoryRef, used: UsedItem): Nutrients | null {
  // 複数入りの商品の公式表示は 1 個あたりが普通なので、個数を直接掛ける
  if (food.basis === 'piece') return used.pieces ? scaleNutrients(food.nutrients, used.pieces) : null;
  if (food.basis !== 'package') return null;
  const f = packageFraction(ref, used);
  return f === null ? null : scaleNutrients(food.nutrients, f);
}

/**
 * 振り分けで見つかった料理・食品を食事として記録する。
 * @param receipt 同じ写真に写っていて登録したレシート（あればそれにひも付ける。無ければ前後 3 時間から探す）
 */
export async function recordMeal(
  a: StoredAnalysis,
  shotAt: number,
  photoRef: string | null,
  receipt: ReceiptCandidate | null,
  signal?: AbortSignal,
): Promise<MealResult> {
  const { dishes, inventory, mealId, photographer, partner } = a;
  const linked = receipt ?? (dishes.some((d) => d.kind !== 'home' && d.used.length === 0) ? await findReceiptNear(shotAt) : null);
  // 自炊の料理はレシートの品目と突き合わせない（「親子丼」が「鶏もも肉」にならないように）
  const targets = dishes.map((_, i) => i).filter((i) => dishes[i].kind !== 'home' && dishes[i].used.length === 0);
  const matches: (number | null)[] = dishes.map(() => null);
  if (linked && targets.length > 0) {
    const m = await matchReceiptItems(linked.store, targets.map((i) => dishes[i].name), linked.lines, signal);
    targets.forEach((i, k) => { matches[i] = m[k]; });
  }
  const nameOf = (i: number) => (matches[i] !== null && linked ? linked.lines[matches[i]!].name : dishes[i].name);
  const storeOf = (i: number) => (dishes[i].kind !== 'home' && linked && matches[i] !== null ? linked.store : '');

  // 栄養: 食品データにあればそれを使い、無いものだけまとめて調べる
  const foods = await loadFoods();
  const whole: (NutritionResult | null)[] = dishes.map((d, i) => {
    // 家にある商品を食べた（1 品だけ・見分けられている）→ 食品データ × 食べた割合
    if (d.kind === 'packaged' && d.used.length === 1 && d.choices.length === 0) {
      const ref = inventory[d.used[0].index];
      const food = ref && freshNutrition(foods.get(foodKey(ref.name)));
      const n = food ? nutrientsFromFood(food, ref, d.used[0]) : null;
      if (food && n) return { nutrients: n, official: food.source === 'grounding' };
    }
    if (d.kind !== 'home' && d.used.length === 0) {
      const food = freshNutrition(foods.get(foodKey(nameOf(i), d.kind === 'eat_out' ? storeOf(i) : '')));
      if (food && food.basis === 'package') return { nutrients: food.nutrients, official: food.source === 'grounding' };
    }
    return null;
  });
  const todo = dishes.map((_, i) => i).filter((i) => whole[i] === null);
  let sources: string[] = [];
  if (todo.length > 0) {
    const queries: NutritionQuery[] = todo.map((i) => {
      const d = dishes[i];
      const used = d.used
        .filter((u) => inventory[u.index])
        .map((u) => {
          const f = packageFraction(inventory[u.index], u);
          const amount = u.pieces ? `${u.pieces}個` : f !== null ? `1 パックの約${Math.round(f * 100)}%` : '量は不明';
          return `${inventory[u.index].name} ${amount}`;
        });
      // 家にある商品を食べた: その量で。家で作った料理: 使った食材を添える
      if (d.kind === 'packaged' && used.length === 1) {
        return { store: '', name: nameOf(i), kind: d.kind, amount: used[0] };
      }
      return {
        store: storeOf(i),
        name:  used.length > 0 ? `${nameOf(i)}（使った食材: ${used.join('、')}）` : nameOf(i),
        kind:  d.kind,
      };
    });
    const res = await lookupNutrition(queries, { signal });
    sources = res.sources;
    todo.forEach((i, k) => { whole[i] = res.results[k]; });
    // 外食のメニュー・家の外で買った商品は食品データに足す（次からは調べずに済む）
    await saveResearched(todo
      .map((i, k) => ({ i, k }))
      .filter(({ i }) => dishes[i].kind !== 'home' && dishes[i].used.length === 0)
      .map(({ i, k }) => ({
        query: { name: nameOf(i), chain: dishes[i].kind === 'eat_out' ? storeOf(i) : '', kind: dishes[i].kind, content: '' },
        result: { nutrients: res.results[k].nutrients, basis: 'package' as const, official: res.results[k].official },
        sources: res.sources,
      })),
    ).catch((e) => console.warn('[Meal] 食品データに足せなかった:', e instanceof Error ? e.message : e));
  }

  const servings = assign(dishes, photographer, partner);
  const eatenAt = epochToTimestamp(shotAt);
  const unmatched = linked !== null && dishes.some((d, i) => d.kind !== 'home' && d.used.length === 0 && matches[i] === null);
  const needsReview =
    servings.some((s) => s.unsure) ||
    dishes.some((d) => d.confidence === 'low' || d.choices.length > 0) ||
    unmatched;

  const rows: MealRow[] = [];
  for (const s of servings) {
    const d = dishes[s.dishIndex];
    const dishId = newMealId();
    const itemRefs: ItemRef[] = d.used
      .filter((u) => inventory[u.index])
      .map((u) => ({ itemId: inventory[u.index].itemId, usedPieces: u.pieces, usedRatio: u.ratio }));
    const choices: ItemChoice[] = d.choices
      .filter((c) => inventory[c])
      .map((c) => ({ itemId: inventory[c].itemId, name: inventory[c].name, store: inventory[c].store, bought: inventory[c].bought }));
    for (const e of s.eaters) {
      rows.push(buildRow({
        mealId, dishId, eatenAt, user: e.user, portion: e.portion,
        dish: nameOf(s.dishIndex), kind: d.kind, store: storeOf(s.dishIndex),
        result: whole[s.dishIndex]!, dishConfidence: d.confidence,
        entryId: d.kind !== 'home' && matches[s.dishIndex] !== null && linked ? linked.entryId : '',
        photoRef, sources, updatedBy: photographer, itemRefs, choices,
      }));
    }
  }
  if (needsReview) for (const r of rows) r.status = 'needs_review';

  // 未送信に回っただけなら記録は届く。AuthError も未送信に積んでから投げられる
  let authFailed = false;
  try {
    await appendMeal(rows);
  } catch (e) {
    if (e instanceof AuthError) authFailed = true;
    else if (!(e instanceof Error && e.name === 'QueuedWriteError')) throw e;
  }

  // 在庫の残りを減らす。見分けられなかった候補の品だけは、選んでもらってから減らす
  await consume(dishes.flatMap((d) => d.used
    .filter((u) => inventory[u.index] && !d.choices.includes(u.index))
    .map((u) => ({ itemId: inventory[u.index].itemId, pieces: u.pieces, ratio: u.ratio }))));

  return {
    mealId,
    sheetName: mealsSheetName(eatenAt),
    needsReview,
    sharedMeal: new Set(rows.map((r) => r.user)).size > 1,
    rows,
    authFailed,
  };
}

/** 同じ写真に写っていたレシートを、食事のひも付け先の形にする */
export function receiptCandidateOf(row: ExpenseRow): ReceiptCandidate | null {
  const food = (row.items ?? []).filter((it) => it.kind !== 'non_food');
  if (!row.entryId || food.length === 0) return null;
  return {
    entryId: row.entryId,
    store: row.store,
    timestamp: row.timestamp,
    at: timestampToEpoch(row.timestamp) ?? 0,
    lines: food.map((it, index) => ({ index, name: it.normalized ?? it.name, price: it.price })),
  };
}

function buildRow(p: {
  mealId: string; dishId: string; eatenAt: string; user: string; portion: number;
  dish: string; kind: IdentifiedDish['kind']; store: string;
  result: NutritionResult; dishConfidence: IdentifiedDish['confidence'];
  entryId: string; photoRef: string | null; sources: string[]; updatedBy: string;
  itemRefs: ItemRef[]; choices: ItemChoice[];
}): MealRow {
  const confidence: Confidence =
    p.dishConfidence === 'low' ? 'low' :
    p.result.official ? p.dishConfidence : 'low';
  return {
    mealId: p.mealId, dishId: p.dishId, eatenAt: p.eatenAt, user: p.user,
    kind: p.kind, store: p.store, dish: p.dish, portion: p.portion,
    nutrients: scaleNutrients(p.result.nutrients, p.portion),
    nutrientSource: p.result.official ? 'grounding' : 'estimate',
    confidence,
    entryId: p.entryId, itemRefs: p.itemRefs, status: 'estimated', assignedBy: 'auto',
    photoRefs: p.photoRef ? [p.photoRef] : [],
    rev: 1, sources: p.sources, updatedBy: p.updatedBy, updatedAt: p.eatenAt, choices: p.choices,
  };
}

function fieldLabel(f: string): string {
  return f === 'user' ? '食べた人' : f === 'portion' ? '割合' : f === 'dish' ? '料理名' : '量';
}

// ─── レシート登録時のひも付け直し ─────────────────────────────────────────────

export interface SavedReceipt {
  entryId:   string;
  timestamp: string;
  store:     string;
  items:     ReceiptItem[];
}

/**
 * 登録したレシートの前後 3 時間に、まだレシートの無い外食・商品の食事があればひも付け、
 * レシートの正式な品名で栄養を引き直す。失敗しても投げない（レシートの登録は済んでいる）。
 * 相手が同じ食事を編集していたら触らない（rev が変わっていれば保存を諦める）。
 */
export async function linkReceiptToMeals(receipt: SavedReceipt, signal?: AbortSignal): Promise<void> {
  try {
    if (await Demo.isDemo()) return;
    const food = receipt.items.filter((it) => it.kind !== 'non_food');
    const at = timestampToEpoch(receipt.timestamp);
    if (food.length === 0 || at === null) return;

    const rows = (await Promise.all(monthsAround(at).map((m) => getMeals(m)))).flat();
    // 食事単位で見る。どの行にもまだレシートが無く、手で直されていない、外食・商品を含む食事だけ
    const byMeal = new Map<string, MealRow[]>();
    for (const r of rows) byMeal.set(r.mealId, [...(byMeal.get(r.mealId) ?? []), r]);
    const candidates = [...byMeal.values()]
      .filter((list) =>
        list.every((r) => !r.entryId && r.status !== 'edited') &&
        list.some((r) => r.kind !== 'home'))
      .map((list) => list[0])
      .filter((r) => {
        const t = timestampToEpoch(r.eatenAt);
        return t !== null && Math.abs(t - at) <= LINK_WINDOW_MS;
      });
    if (candidates.length === 0) return;

    // いちばん近い食事 1 回分だけにひも付ける
    const nearest = candidates.reduce((a, b) =>
      Math.abs(timestampToEpoch(a.eatenAt)! - at) <= Math.abs(timestampToEpoch(b.eatenAt)! - at) ? a : b);
    const mealRows = rows.filter((r) => r.mealId === nearest.mealId);
    const sheetName = nearest.sheetName ?? mealsSheetName(nearest.eatenAt);
    const baseRev = mealRev(mealRows);

    const dishIds = [...new Set(mealRows.map((r) => r.dishId))];
    const dishNames = dishIds.map((id) => mealRows.find((r) => r.dishId === id)!.dish);
    const lines: ReceiptLine[] = food.map((it, i) => ({ index: i, name: it.normalized ?? it.name, price: it.price }));
    const matches = await matchReceiptItems(receipt.store, dishNames, lines, signal);

    // 自炊の品はレシートに対応付けない
    const matchedIdx = dishIds.map((_, i) => i).filter((i) =>
      matches[i] !== null && mealRows.find((r) => r.dishId === dishIds[i])!.kind !== 'home');
    if (matchedIdx.length === 0) return;
    const queries: NutritionQuery[] = matchedIdx.map((i) => ({
      store: receipt.store,
      name:  lines[matches[i]!].name,
      kind:  mealRows.find((r) => r.dishId === dishIds[i])!.kind,
    }));
    const { results, sources } = await lookupNutrition(queries, { signal });

    const next = mealRows.map((r) => {
      const di = dishIds.indexOf(r.dishId);
      const qi = matchedIdx.indexOf(di);
      // 対応しなかった品は触らない（別のレシートの品かもしれない）
      if (qi < 0) return r;
      const res = results[qi];
      // 栄養が 1 つも取れなかったら、今の値を消さずにひも付けだけする
      const gotAny = Object.values(res.nutrients).some((v) => v !== null);
      return {
        ...r,
        entryId: receipt.entryId,
        store:   receipt.store,
        dish:    queries[qi].name,
        ...(gotAny ? {
          nutrients: scaleNutrients(res.nutrients, r.portion),
          nutrientSource: res.official ? 'grounding' as const : 'estimate' as const,
          confidence: res.official ? 'high' as const : r.confidence,
          sources,
        } : {}),
      };
    });
    const user = await getCurrentUser();
    const saved = await saveMeal(sheetName, nearest.mealId, next, baseRev, user);
    // 二人の食事なら、ひも付いたレシートの写真も相手に見せる
    await ensureMealShared(saved, user);
  } catch (e) {
    if (e instanceof MealConflictError) return; // 相手が編集中。そちらを優先する
    console.warn('[Meal] レシートとのひも付けに失敗:', e instanceof Error ? e.message : e);
  }
}
