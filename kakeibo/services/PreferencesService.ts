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

// ─── タブの表示と並び順 ───────────────────────────────────────────────────────
//
// 端末ごと。少なくとも 1 つは表示する（全部消すと画面が無くなる）

export const TAB_KEYS = ['Camera', 'Meals', 'Body', 'Summary'] as const;
export type TabKey = typeof TAB_KEYS[number];
export const TAB_LABELS: Record<TabKey, string> = { Camera: '撮影', Meals: '食事', Body: 'からだ', Summary: '一覧' };

export interface TabLayout {
  /** 表示する順（隠したタブも含む） */
  order:  TabKey[];
  hidden: TabKey[];
}

const TAB_LAYOUT = 'tab_layout';
const DEFAULT_TAB_LAYOUT: TabLayout = { order: [...TAB_KEYS], hidden: [] };
const tabListeners = new Set<(layout: TabLayout) => void>();

function sanitizeTabLayout(raw: unknown): TabLayout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<TabLayout>;
  const isKey = (k: unknown): k is TabKey => (TAB_KEYS as readonly unknown[]).includes(k);
  const order = (Array.isArray(r.order) ? r.order.filter(isKey) : []).filter((k, i, a) => a.indexOf(k) === i);
  // 後から増えたタブは、既定の並びで前にあるタブの後ろに差し込む（からだは食事の隣）
  TAB_KEYS.forEach((k, i) => {
    if (order.includes(k)) return;
    const prev = TAB_KEYS.slice(0, i).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, k);
  });
  const hidden = Array.isArray(r.hidden) ? r.hidden.filter(isKey) : [];
  return { order, hidden: hidden.length >= order.length ? [] : hidden };
}

export async function getTabLayout(): Promise<TabLayout> {
  try {
    return sanitizeTabLayout(JSON.parse((await getItem(TAB_LAYOUT)) ?? 'null'));
  } catch {
    return DEFAULT_TAB_LAYOUT;
  }
}

export async function setTabLayout(layout: TabLayout): Promise<void> {
  const next = sanitizeTabLayout(layout);
  await setItem(TAB_LAYOUT, JSON.stringify(next));
  for (const l of tabListeners) l(next);
}

/** 設定画面で変えたら、すぐにタブへ反映するために使う */
export function subscribeTabLayout(listener: (layout: TabLayout) => void): () => void {
  tabListeners.add(listener);
  return () => { tabListeners.delete(listener); };
}

// ─── 写真の保存期間 ───────────────────────────────────────────────────────────
//
// レシート・食事の写真は端末にしか無いので、設定も端末ごと。0 = 無期限（既定）

const PHOTO_RETENTION_DAYS = 'photo_retention_days';
export const PHOTO_RETENTION_OPTIONS = [0, 90, 180, 365] as const;

export async function getPhotoRetentionDays(): Promise<number> {
  const v = Number(await getItem(PHOTO_RETENTION_DAYS));
  return (PHOTO_RETENTION_OPTIONS as readonly number[]).includes(v) ? v : 0;
}

export async function setPhotoRetentionDays(days: number): Promise<void> {
  await setItem(PHOTO_RETENTION_DAYS, String(days));
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
