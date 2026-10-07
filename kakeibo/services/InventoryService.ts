/**
 * 家にある食材・商品（在庫）。レシート・メールで買った品目（`_items_YYYY-MM`）を在庫として扱う。
 * 仕様は docs/meal-nutrition-spec.md §5.3。
 *
 * - 日持ちの目安（品目ごとの推定 shelf_days。冷蔵は最低 3 日、冷凍・常温は最低 30 日）を過ぎたら、
 *   操作しなくても在庫から外れる（書き込みはせず、読むときに判定する）
 * - 食事で使った量だけ残りを減らす（個数で数えるものは個数、それ以外は割合）
 * - 残りがほぼ無くなったら「食べきりましたか？」の確認待ち（status = confirm）にする。
 *   在庫の画面で「食べきった」「まだある」を選ぶ
 * - 「食べきった」は在庫の画面からいつでも押せる
 */

import { SheetsInternal, ITEMS_RANGE, getRowsRaw } from './SheetsService';
import { nowLabel } from './jsonFileStore';
import * as Demo from './DemoService';

export type ItemStatus = 'in_stock' | 'confirm' | 'used_up';

export interface InventoryItem {
  itemId:          string;
  entryId:         string;
  sheetName:       string;
  rowIndex:        number;
  purchasedAt:     string;
  purchasedMs:     number;
  user:            string;
  store:           string;
  name:            string;
  quantity:        string;
  kind:            string;
  storage:         'chilled' | 'frozen' | 'ambient' | '';
  shelfDays:       number;
  /** 入り数（数えられないものは null） */
  pieces:          number | null;
  /** 残りの割合（0〜1） */
  remaining:       number;
  remainingPieces: number | null;
  status:          ItemStatus;
  expiresMs:       number;
}

const DAY = 24 * 60 * 60 * 1000;
const MIN_DAYS: Record<string, number> = { chilled: 3, frozen: 30, ambient: 30, '': 7 };
/** これ以下になったら「食べきりましたか？」と聞く */
const NEARLY_EMPTY = 0.1;
/** 在庫として読む月の数（米・常温品は数か月持つ） */
const MONTHS_BACK = 6;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toMs(ts: string): number | null {
  const m = ts.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
}

function parseItem(c: any[], rowIndex: number, sheetName: string): InventoryItem | null {
  const purchasedMs = toMs(String(c[2] ?? ''));
  const kind = String(c[10] ?? '');
  if (!c[0] || purchasedMs === null || kind === 'non_food' || !kind) return null;
  const storage = (['chilled', 'frozen', 'ambient'].includes(String(c[11])) ? String(c[11]) : '') as InventoryItem['storage'];
  const shelf = Math.max(Number(c[12]) || 0, MIN_DAYS[storage]);
  const pieces = Number(c[13]) >= 1 ? Number(c[13]) : null;
  const remaining = c[14] === '' || c[14] === undefined ? 1 : Math.max(0, Math.min(1, Number(c[14]) || 0));
  const remainingPieces = pieces === null ? null : c[15] === '' || c[15] === undefined ? pieces : Math.max(0, Number(c[15]) || 0);
  const status = (['in_stock', 'confirm', 'used_up'].includes(String(c[16])) ? String(c[16]) : 'in_stock') as ItemStatus;
  return {
    itemId: String(c[0]), entryId: String(c[1] ?? ''), sheetName, rowIndex,
    purchasedAt: String(c[2]), purchasedMs, user: String(c[3] ?? ''), store: String(c[4] ?? ''),
    name: String(c[6] || c[5] || ''), quantity: `${c[7] ?? ''}${c[8] ?? ''}`, kind, storage,
    shelfDays: shelf, pieces, remaining, remainingPieces, status,
    expiresMs: purchasedMs + shelf * DAY,
  };
}

/**
 * 在庫の一覧。日持ちを過ぎたもの・食べきったもの・削除したレシートの品目は除く。
 * @param includeConfirm 「食べきりましたか？」の確認待ちも含める
 */
export async function listInventory(includeConfirm = true): Promise<InventoryItem[]> {
  if (await Demo.isDemo()) return [];
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  const now = Date.now();
  const out: InventoryItem[] = [];
  const live = new Set<string>();

  const today = new Date();
  for (let k = 0; k < MONTHS_BACK; k++) {
    const first = new Date(today.getFullYear(), today.getMonth() - k, 1);
    const month = `${first.getFullYear()}-${pad(first.getMonth() + 1)}`;
    const sheet = `_items_${month}`;
    if (!names.includes(sheet)) continue;
    const res = await client.get(`/values/${encodeURIComponent(sheet)}!${ITEMS_RANGE}`, {
      params: { valueRenderOption: 'UNFORMATTED_VALUE' },
    });
    ((res.data.values ?? []) as any[][]).forEach((c, i) => {
      if (i === 0) return;
      const item = parseItem(c, i + 1, sheet);
      if (!item || item.status === 'used_up' || item.expiresMs < now) return;
      if (item.status === 'confirm' && !includeConfirm) return;
      if (item.remaining <= 0 && (item.remainingPieces ?? 0) <= 0) return;
      out.push(item);
    });
    // 削除した支出行の品目は在庫にしない
    for (const r of await getRowsRaw(month)) if (r.entryId) live.add(r.entryId);
  }
  return out
    .filter((i) => live.has(i.entryId))
    .sort((a, b) => b.purchasedMs - a.purchasedMs);
}

/** 「残り 4 本」「残り 60%」 */
export function remainLabel(i: InventoryItem): string {
  if (i.remainingPieces !== null) return `残り ${i.remainingPieces}${i.pieces ? `/${i.pieces}` : ''}`;
  return `残り ${Math.round(i.remaining * 100)}%`;
}

async function writeState(item: InventoryItem, remaining: number, remainingPieces: number | null, status: ItemStatus): Promise<void> {
  const client = await SheetsInternal.createClient();
  // O:Q（remaining / remaining_pieces / status）と S（updated_at）
  await client.post('/values:batchUpdate', {
    valueInputOption: 'RAW',
    data: [
      { range: `'${item.sheetName}'!O${item.rowIndex}:Q${item.rowIndex}`, values: [[remaining, remainingPieces ?? '', status]] },
      { range: `'${item.sheetName}'!S${item.rowIndex}`, values: [[nowLabel()]] },
    ],
  });
}

export interface Consumption {
  itemId: string;
  pieces?: number;
  ratio?:  number;
}

/**
 * 食事で使った分だけ残りを減らす。ほぼ無くなったら確認待ち（confirm）にする。
 * 失敗しても投げない（食事の記録は済んでいる）。
 */
export async function consume(list: Consumption[]): Promise<void> {
  if (list.length === 0) return;
  try {
    const items = await listInventory(true);
    for (const c of list) {
      const item = items.find((i) => i.itemId === c.itemId);
      if (!item) continue;
      let remaining = item.remaining;
      let remainingPieces = item.remainingPieces;
      if (remainingPieces !== null && item.pieces) {
        const used = c.pieces ?? Math.max(1, Math.round((c.ratio ?? 0) * remainingPieces));
        remainingPieces = Math.max(0, remainingPieces - used);
        remaining = remainingPieces / item.pieces;
      } else {
        remaining = Math.max(0, remaining - remaining * (c.ratio ?? 0));
      }
      const nearlyEmpty = remainingPieces !== null ? remainingPieces <= 0 : remaining <= NEARLY_EMPTY;
      await writeState(item, round(remaining), remainingPieces, nearlyEmpty ? 'confirm' : item.status);
    }
  } catch (e) {
    console.warn('[Inventory] 残りを減らせなかった:', e instanceof Error ? e.message : e);
  }
}

/** 「食べきった」 */
export async function markUsedUp(item: InventoryItem): Promise<void> {
  await writeState(item, 0, item.remainingPieces === null ? null : 0, 'used_up');
}

/** 確認待ちに「まだある」と答えた。少し残っている扱いで在庫に戻す */
export async function keepInStock(item: InventoryItem): Promise<void> {
  const pieces = item.remainingPieces === null ? null : Math.max(1, item.remainingPieces);
  const remaining = pieces !== null && item.pieces ? pieces / item.pieces : Math.max(item.remaining, 0.25);
  await writeState(item, round(remaining), pieces, 'in_stock');
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
