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
//
// **これは「起動のたびに通信しない」ための端末ローカルの目印にすぎない。**
// 実際に今月ぶんを作ってよいかの判断はスプレッドシートの `_config` 側が持つ
// （端末ごとの目印だけだと、2 台が月初にほぼ同時に起動したとき両方が未適用と
//  判断して固定費を二重に作ってしまうため。`SheetsService.applyRecurringEntries` 参照）。

const RECURRING_APPLIED_MONTH = 'recurring_applied_month';

/** この端末が最後に固定費の月初コピーを試みた月（'YYYY-MM'）を返す */
export async function getRecurringAppliedMonth(): Promise<string | null> {
  return getItem(RECURRING_APPLIED_MONTH);
}

/** この端末が今月ぶんを試み終えたことを記録する */
export async function setRecurringAppliedMonth(month: string): Promise<void> {
  await setItem(RECURRING_APPLIED_MONTH, month);
}
