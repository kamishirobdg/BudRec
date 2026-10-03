/**
 * 端末ローカルの「現在のユーザー」設定。
 * 夫婦で別端末を持つ前提で、各端末の所有者がどちらかを保持する。
 * Source of truth は端末内 Storage（_config では無く各端末ローカル）。
 */

import { getItem, setItem } from './Storage';
import * as Demo from './DemoService';

const KEY = 'current_user';
const DEFAULT_USER = '夫';

let cache: string | null = null;

/** 端末に保存されている実際のユーザー名（デモモードでもマスクしない） */
export async function getCurrentUserRaw(): Promise<string> {
  if (cache) return cache;
  const v = await getItem(KEY);
  if (v && v.length > 0) {
    cache = v;
    return v;
  }
  // 未設定時の既定名はキャッシュしない（isUserNameSet の判定を壊さないため）
  return DEFAULT_USER;
}

/**
 * 端末にユーザー名が保存済みか。
 * 未設定のまま Gmail 取り込みが走ると既定名のレコードが作られてしまうため、
 * 初回起動時はこれが true になるまでアプリ本体へ進ませない。
 */
export async function isUserNameSet(): Promise<boolean> {
  if (cache) return true;
  const v = await getItem(KEY);
  return !!v && v.length > 0;
}

/**
 * 現在のユーザー名。
 * デモモード中はデモ表示名を返す（一覧の行と名前が食い違わないよう、
 * 新規入力もこの名前で行われる。デモ中の書き込みは実データに届かない）。
 */
export async function getCurrentUser(): Promise<string> {
  const name = await getCurrentUserRaw();
  if (!(await Demo.isDemo())) return name;
  return Demo.maskUser(name);
}

export async function setCurrentUser(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  cache = trimmed;
  await setItem(KEY, trimmed);
}
