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
