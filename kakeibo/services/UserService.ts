/**
 * 端末ローカルの「現在のユーザー」設定。
 * 夫婦で別端末を持つ前提で、各端末の所有者がどちらかを保持する。
 * Source of truth は端末内 Storage（_config では無く各端末ローカル）。
 */

import { getItem, setItem } from './Storage';

const KEY = 'current_user';
const DEFAULT_USER = '夫';

let cache: string | null = null;

export async function getCurrentUser(): Promise<string> {
  if (cache) return cache;
  const v = await getItem(KEY);
  cache = v && v.length > 0 ? v : DEFAULT_USER;
  return cache;
}

export async function setCurrentUser(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  cache = trimmed;
  await setItem(KEY, trimmed);
}
