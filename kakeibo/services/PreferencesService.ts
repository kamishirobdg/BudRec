/**
 * 端末ローカルの UI 設定を保持する。
 * （ユーザー名は UserService 側、こちらは画面の見栄え系）
 */

import { getItem, setItem } from './Storage';

export type SortKey = 'timestamp' | 'amount' | 'category';

const SORT_KEY = 'list_sort_key';
const DEFAULT_SORT: SortKey = 'timestamp';

export async function getSortKey(): Promise<SortKey> {
  const v = await getItem(SORT_KEY);
  if (v === 'timestamp' || v === 'amount' || v === 'category') return v;
  return DEFAULT_SORT;
}

export async function setSortKey(key: SortKey): Promise<void> {
  await setItem(SORT_KEY, key);
}

// ─── 固定費 月次適用 ──────────────────────────────────────────────────────────

const RECURRING_APPLIED_MONTH = 'recurring_applied_month';

/** 最後に固定費を月初コピーした月（'YYYY-MM'）を返す */
export async function getRecurringAppliedMonth(): Promise<string | null> {
  return getItem(RECURRING_APPLIED_MONTH);
}

/** 固定費コピー済み月を記録する */
export async function setRecurringAppliedMonth(month: string): Promise<void> {
  await setItem(RECURRING_APPLIED_MONTH, month);
}
