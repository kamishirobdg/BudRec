/**
 * 送信できなかった書き込みを端末に溜めておくキュー。
 *
 * 電車の中・地下・機内など通信が不安定な場所でレシートを撮ると、これまでは
 * 「保存失敗」と出て入力が消えていた。httpRetry が数秒粘っても駄目だった書き込みを
 * ここに退避し、通信が戻ったタイミングでまとめて送り直す。
 *
 * 保存場所: `<documentDirectory>/pending-writes.json`
 * （SecureStore は大きな値を保存できないことがあるためファイルに置く。
 *   中身は店名・金額といった家計簿の明細で、認証情報は含まれない）
 *
 * 実際の送信は SheetsService.flushWriteQueue() が行う。ここは「何を送り損ねたか」
 * だけを持つ（SheetsService → WriteQueueService の一方向依存にして循環を避ける）。
 */

import { useEffect, useState } from 'react';
import { File, Paths } from 'expo-file-system';
import type { ExpenseRow } from './SheetsService';

/** counted_amount / excluded / confirmed のまとめ更新 */
export interface RowFlagsPatch {
  countedAmount: number;
  excluded:      boolean;
  confirmed:     boolean;
}

/** 送り損ねた 1 操作。SheetsService の書き込み API と 1 対 1 で対応する */
export type WriteOp =
  | { kind: 'append';       entry: ExpenseRow }
  | { kind: 'updateRow';    sheetName: string; rowIndex: number; entry: ExpenseRow }
  | { kind: 'updateFlags';  sheetName: string; rowIndex: number; patch: RowFlagsPatch }
  | { kind: 'markDeleted';  sheetName: string; rowIndex: number }
  | { kind: 'setRecurring'; sheetName: string; rowIndex: number; recurring: boolean };

export interface QueuedWrite {
  id:        string;
  queuedAt:  string;  // 'YYYY/MM/DD HH:MM:SS'（表示用。パースはしない）
  attempts:  number;
  lastError: string;
  /** 送り直しても直らないと判断した失敗（400 など）。自動送信ではスキップする */
  permanent: boolean;
  op:        WriteOp;
}

/**
 * 書き込みをキューに退避したときに投げる。
 * 呼び出し側は「失敗」ではなく「未送信のまま受け付けた」として扱うこと
 * （画面上の変更を巻き戻さない）。
 */
export class QueuedWriteError extends Error {
  constructor(public readonly reason: string) {
    super('通信できないため、この変更は端末に保存して後で送信します');
    this.name = 'QueuedWriteError';
  }
}

const FILE_NAME = 'pending-writes.json';

/** null = まだファイルを読んでいない */
let queue: QueuedWrite[] | null = null;
let seq = 0;

const listeners = new Set<(items: QueuedWrite[]) => void>();

// ─── 永続化 ───────────────────────────────────────────────────────────────────

function queueFile(): File {
  return new File(Paths.document, FILE_NAME);
}

function load(): QueuedWrite[] {
  if (queue) return queue;
  try {
    const f = queueFile();
    queue = f.exists ? (JSON.parse(f.textSync()) as QueuedWrite[]) : [];
    if (!Array.isArray(queue)) queue = [];
  } catch (e) {
    // 壊れていても起動は止めない。溜まっていた分は諦める
    console.error('[WriteQueue] 読み込み失敗。空として扱う:', e);
    queue = [];
  }
  return queue;
}

function persist(): void {
  try {
    const f = queueFile();
    if (!f.exists) f.create({ overwrite: true });
    f.write(JSON.stringify(queue ?? []));
  } catch (e) {
    console.error('[WriteQueue] 保存失敗:', e);
  }
}

function publish(): void {
  const items = list();
  listeners.forEach((l) => l(items));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function nowLabel(): string {
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ─── 公開 API ─────────────────────────────────────────────────────────────────

/** 未送信の一覧（古い順）。呼び出し側で壊されないようコピーを返す */
export function list(): QueuedWrite[] {
  return [...load()];
}

/** 未送信の件数（送信不能としてマークされたものを含む） */
export function count(): number {
  return load().length;
}

/** 自動送信の対象になる件数（permanent を除く） */
export function sendableCount(): number {
  return load().filter((q) => !q.permanent).length;
}

/** 送り損ねた操作を積む */
export function enqueue(op: WriteOp, error: string): QueuedWrite {
  const items = load();
  const item: QueuedWrite = {
    id:        `${Date.now()}-${seq++}`,
    queuedAt:  nowLabel(),
    attempts:  1,
    lastError: error,
    permanent: false,
    op,
  };
  items.push(item);
  persist();
  publish();
  console.log(`[WriteQueue] 未送信に退避 (${items.length}件): ${op.kind} / ${error}`);
  return item;
}

/** 送信できたので取り除く */
export function remove(id: string): void {
  queue = load().filter((q) => q.id !== id);
  persist();
  publish();
}

/** 送信に失敗した記録を残す */
export function markAttempt(id: string, error: string, permanent: boolean): void {
  const item = load().find((q) => q.id === id);
  if (!item) return;
  item.attempts += 1;
  item.lastError = error;
  item.permanent = permanent;
  persist();
  publish();
}

/** 全部捨てる（設定画面から明示的に選ばれたときだけ） */
export function clear(): void {
  queue = [];
  persist();
  publish();
}

/** 1 件だけ捨てる */
export function discard(id: string): void {
  remove(id);
}

/** 操作の内容を 1 行で説明する（設定画面の一覧用） */
export function describeOp(op: WriteOp): string {
  switch (op.kind) {
    case 'append':
      return `追加: ${op.entry.store || '(店名なし)'} ¥${op.entry.amount.toLocaleString()}`;
    case 'updateRow':
      return `編集: ${op.entry.store || '(店名なし)'} ¥${op.entry.amount.toLocaleString()}`;
    case 'updateFlags':
      return `集計設定の変更: ${op.sheetName} ${op.rowIndex}行目`;
    case 'markDeleted':
      return `削除: ${op.sheetName} ${op.rowIndex}行目`;
    case 'setRecurring':
      return `固定費${op.recurring ? 'に設定' : 'を解除'}: ${op.sheetName} ${op.rowIndex}行目`;
  }
}

/** React フック: 未送信一覧を購読する */
export function useWriteQueue(): QueuedWrite[] {
  const [items, setItems] = useState<QueuedWrite[]>(() => list());
  useEffect(() => {
    const listener = (next: QueuedWrite[]) => setItems(next);
    listeners.add(listener);
    setItems(list()); // マウント時点の最新に同期
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return items;
}
