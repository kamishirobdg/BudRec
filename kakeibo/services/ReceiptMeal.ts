/**
 * レシートから直後の食事を登録する。仕様は docs/meal-nutrition-spec.md §5.7。
 *
 * コンビニの弁当・店内飲食のように「買ってすぐ食べる」買い物（レシートの読み取りで servings = 1 か 2）は、
 * 料理の写真を撮らなくても、レシートの登録に続けて食事として記録する。
 * - 1 人分 → レシートの人（代理入力なら相手）の食事。確認は挟まない
 * - 2 人分 → 主食を 1 つずつ、総菜・菓子は半分ずつ。誰がどちらを食べたかを確かめてもらう（要確認）
 * - 朝 10 時より前に買ったものは昼食（12:00）として入れる。それ以外は買った時刻（`MealProcessing.mealTimeOf`）
 * - 登録した品目は在庫から外す（食べきった扱い）。食事の編集画面の「食べていない」で在庫に戻せる
 * - 後で料理の写真を撮っても二重にならない（`recordMeal` が同じレシートの食事に写真を付けるだけにする）
 */

import type { IdentifiedDish } from '../providers/GeminiMeal';
import { getUniqueUsers } from './SheetsService';
import {
  MealResult, ReceiptCandidate, SavedReceipt, StoredAnalysis, mealForReceipt, mealTimeOf, recordMeal, timestampToEpoch,
} from './MealProcessing';
import { QuotaExceededError } from '../providers/AIProvider';
import axios from 'axios';
import { findMenu, loadMenuIndex } from './FoodService';
import { newMealId } from './MealService';
import { consumeEntryItems } from './InventoryService';
import * as Demo from './DemoService';

/** 直後の食事として登録する取込元（メール・Suica・固定費は買い物の時刻と食べる時刻が結び付かない） */
const EAT_NOW_SOURCES = new Set(['camera', 'proxy_camera', 'manual', 'proxy_manual']);
/** これより古いレシートは、まとめて撮った過去のものとみなして登録しない */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * レシートから直後の食事を登録する。対象でない・既に登録済み・失敗したときは null（レシートの登録は済んでいる）。
 * 無料枠切れ・通信の失敗だけはそのまま投げる（呼び出し側が後でやり直す）。
 * 呼び出し側は、前後の食事にひも付かなかった（`linkReceiptToMeals` が 'none'）ときだけ呼ぶ。
 */
export async function mealFromReceipt(receipt: SavedReceipt, now: number = Date.now()): Promise<MealResult | null> {
  try {
    if (await Demo.isDemo()) return null;
    const { user, source, servings } = receipt;
    if (!user || !source || !EAT_NOW_SOURCES.has(source)) return null;
    if (!servings || servings < 1 || servings > 2) return null;
    const at = timestampToEpoch(receipt.timestamp);
    if (at === null || now - at > MAX_AGE_MS || at - now > 60 * 60 * 1000) return null;

    const food = receipt.items.filter((it) => it.kind !== 'non_food');
    const eatNow = food.map((it, line) => ({ it, line })).filter(({ it }) => it.mealRole && it.mealRole !== 'none');
    if (!eatNow.some(({ it }) => it.mealRole === 'main')) return null;
    if (await mealForReceipt(receipt.entryId, at)) return null;

    const partner = (await getUniqueUsers()).find((u) => u !== user) ?? null;
    const two = servings === 2 && partner !== null;
    const nameOf = (it: typeof food[number]) => it.normalized ?? it.name;

    // 外食か（店内飲食のレシート）: カテゴリに「外食」か、店名がメニューを取り込んだチェーンに当たる
    const menuIndex = await loadMenuIndex().catch(() => null);
    const eatOut = /外食/.test(receipt.category ?? '') ||
      (!!menuIndex && eatNow.some(({ it }) => findMenu(menuIndex, receipt.store, [nameOf(it)]) !== undefined));

    let mainNo = 0;
    const dishes: IdentifiedDish[] = eatNow.map(({ it }): IdentifiedDish => {
      const qty = it.quantity && Number.isInteger(it.quantity) && it.quantity >= 1 && it.quantity <= 4 ? it.quantity : 1;
      const base: Pick<IdentifiedDish, 'name' | 'kind' | 'confidence' | 'used' | 'choices'> = {
        name: nameOf(it), kind: eatOut ? 'eat_out' : 'packaged', confidence: 'high', used: [], choices: [],
      };
      if (!two) return { ...base, shared: false, count: qty, eater: 'photographer' };
      if (it.mealRole === 'main') {
        // 主食が 2 行なら 1 つずつ。1 行に 2 つなら assign が一人 1 つに振る
        const eater = qty >= 2 ? 'unknown' : mainNo++ % 2 === 0 ? 'photographer' : 'partner';
        return { ...base, shared: false, count: qty, eater };
      }
      if (it.mealRole === 'drink' && qty >= 2) return { ...base, shared: false, count: qty, eater: 'unknown' };
      // 総菜・菓子・1 本の飲み物は二人で分ける
      return { ...base, shared: true, count: 1, eater: 'both' };
    });

    const analysis: StoredAnalysis = { receiptRows: [], dishes, inventory: [], mealId: newMealId(), photographer: user, partner };
    const candidate: ReceiptCandidate = {
      entryId: receipt.entryId, store: receipt.store, timestamp: receipt.timestamp, at,
      lines: food.map((it, index) => ({ index, name: nameOf(it), price: it.price })),
    };
    const result = await recordMeal(analysis, mealTimeOf(at), null, candidate, {
      lineMatches: eatNow.map(({ line }) => line),
      forceReview: two,
      assignedBy: 'receipt',
    });
    // 食べた品は在庫に残さない（「食べていない」で戻せる）
    await consumeEntryItems(receipt.entryId, eatNow.map(({ it }) => nameOf(it)));
    return result;
  } catch (e) {
    if (e instanceof QuotaExceededError || (axios.isAxiosError(e) && !e.response)) throw e;
    console.warn('[ReceiptMeal] レシートから食事を登録できなかった:', e instanceof Error ? e.message : e);
    return null;
  }
}
