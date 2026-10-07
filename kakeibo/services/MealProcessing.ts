/**
 * 食事写真 → 料理の判別 → レシートとのひも付け → 栄養の推定 → 誰が食べたか → 記録、までの処理。
 * 仕様は docs/meal-nutrition-spec.md §5・§6。裏の OCR（OcrWorker）から呼ぶ。
 *
 * レシートは「料理を撮ってからレシートを撮る」順が普通なので、両方向で突き合わせる:
 * - 食事を処理するときに、撮影時刻の前後 3 時間のレシートが既にあればひも付ける
 * - レシートを登録したときに、前後 3 時間の食事でまだレシートの無いものがあればひも付け直す
 */

import { SheetsInternal, getRowsRaw, getUniqueUsers } from './SheetsService';
import { AuthError } from './AuthService';
import type { ReceiptItem } from '../providers/AIProvider';
import { getCurrentUser } from './UserService';
import {
  identifyDishes, lookupNutrition, matchReceiptItems,
  IdentifiedDish, NutritionQuery, NutritionResult, ReceiptLine,
} from '../providers/GeminiMeal';
import {
  MealRow, Confidence, appendMeal, getMeals, mealRev, mealsSheetName, newMealId, recentCorrections, saveMeal,
  MealConflictError,
} from './MealService';
import { scaleNutrients } from './Nutrients';
import { archiveMealPhoto, mealPhotoRef } from './PhotoStore';
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

interface ReceiptCandidate {
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
    const res = await client.get(`/values/${encodeURIComponent(sheet)}!A:N`);
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

// ─── 食事写真の処理 ───────────────────────────────────────────────────────────

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
 * 食事写真を 1 枚処理して記録する。写真は端末の保存先へ移す。
 * QuotaExceededError / CancelledError / AuthError はそのまま投げる（OcrWorker が扱う）。
 */
export async function processMealPhoto(
  uri: string,
  base64: string,
  shotAt: number,
  proxyUser: string | undefined,
  signal: AbortSignal,
  opts: { mealId?: string; keepOriginal?: (needsReview: boolean) => boolean } = {},
): Promise<MealResult> {
  const photographer = proxyUser ?? await getCurrentUser();
  const partner = (await getUniqueUsers()).find((u) => u !== photographer) ?? null;

  const corrections = (await recentCorrections(20))
    .map((c) => `${c.context}: ${fieldLabel(c.field)}を「${c.before}」→「${c.after}」に修正`);

  const dishes = await identifyDishes(base64, { photographer, partner, corrections }, signal);
  if (dishes.length === 0) throw new Error('料理を判別できませんでした');

  // 既にレシートがあればひも付ける（無ければ、後でレシートを登録したときに付け直す）
  const receipt = dishes.some((d) => d.kind !== 'home') ? await findReceiptNear(shotAt) : null;
  const matches = receipt
    ? await matchReceiptItems(receipt.store, dishes.map((d) => d.name), receipt.lines, signal)
    : dishes.map(() => null);

  const queries: NutritionQuery[] = dishes.map((d, i) => ({
    store: d.kind !== 'home' ? receipt?.store ?? '' : '',
    name:  matches[i] !== null ? receipt!.lines[matches[i]!].name : d.name,
    kind:  d.kind,
  }));
  const { results, sources } = await lookupNutrition(queries, { imageBase64: base64, signal });

  const servings = assign(dishes, photographer, partner);
  const mealId = opts.mealId ?? newMealId();
  const eatenAt = epochToTimestamp(shotAt);
  const unmatched = receipt !== null && dishes.some((d, i) => d.kind !== 'home' && matches[i] === null);
  const needsReview =
    servings.some((s) => s.unsure) ||
    dishes.some((d) => d.confidence === 'low') ||
    unmatched;
  // 写真は記録を書いてから移す（書けなかったときに画像が OCR 待ちのフォルダから消えないように）
  const photoRef = mealPhotoRef(uri);

  const rows: MealRow[] = [];
  for (const s of servings) {
    const d = dishes[s.dishIndex];
    const r = results[s.dishIndex];
    const dishId = newMealId();
    for (const e of s.eaters) {
      rows.push(buildRow({
        mealId, dishId, eatenAt, user: e.user, portion: e.portion,
        dish: queries[s.dishIndex].name, kind: d.kind, store: queries[s.dishIndex].store,
        result: r, dishConfidence: d.confidence,
        entryId: matches[s.dishIndex] !== null ? receipt!.entryId : '',
        photoRef, sources, updatedBy: photographer,
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
  // 確認待ちにする場合は、確認画面で見せるため元の画像も残す
  archiveMealPhoto(uri, opts.keepOriginal?.(needsReview) ?? false);
  return {
    authFailed,
    mealId,
    sheetName: mealsSheetName(eatenAt),
    needsReview,
    sharedMeal: new Set(rows.map((r) => r.user)).size > 1,
    rows,
  };
}

function buildRow(p: {
  mealId: string; dishId: string; eatenAt: string; user: string; portion: number;
  dish: string; kind: IdentifiedDish['kind']; store: string;
  result: NutritionResult; dishConfidence: IdentifiedDish['confidence'];
  entryId: string; photoRef: string | null; sources: string[]; updatedBy: string;
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
    entryId: p.entryId, itemRefs: [], status: 'estimated', assignedBy: 'auto',
    photoRefs: p.photoRef ? [p.photoRef] : [],
    rev: 1, sources: p.sources, updatedBy: p.updatedBy, updatedAt: p.eatenAt,
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
