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
import { nowLabel, readJsonArray, writeJson } from './jsonFileStore';
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

function load(): QueuedWrite[] {
  if (queue) return queue;
  queue = readJsonArray<QueuedWrite>(FILE_NAME);
  return queue;
}

function persist(): void {
  writeJson(FILE_NAME, queue ?? []);
}

function publish(): void {
  const items = list();
  listeners.forEach((l) => l(items));
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

// ─── 直接書き込みとの整合 ─────────────────────────────────────────────────────
//
// 未送信の項目は「積んだ時点のスナップショット」を持っている。通信が戻ったあとに
// 同じ行を編集して**その書き込みだけ先に成功**すると、あとから流れる古いキュー項目が
// 新しい内容を上書きしてしまう（例: オフラインで除外をトグル → キューに退避 →
// 復帰後に同じ行の除外を戻す → 直接成功 → 後からキューが流れて除外に戻る）。
//
// 各操作が書く列は決まっているので、重なる列だけを新しい値で潰す。
//   updateRow    A:L（全部）
//   updateFlags  H:J（counted_amount / excluded / confirmed）
//   setRecurring K
//   markDeleted  L
//
// **別端末からの編集は対象外**。検知には行ごとのバージョン管理が要り、Sheets 相手では過剰。

type FieldGroup = 'main' | 'flags' | 'recurring' | 'deleted';

function groupsOf(op: WriteOp): FieldGroup[] {
  switch (op.kind) {
    case 'append':       return [];
    case 'updateRow':    return ['main', 'flags', 'recurring', 'deleted'];
    case 'updateFlags':  return ['flags'];
    case 'setRecurring': return ['recurring'];
    case 'markDeleted':  return ['deleted'];
  }
}

/** その操作が対象にしている行（append はまだ行番号が無いので null） */
function rowTargetOf(op: WriteOp): { sheetName: string; rowIndex: number } | null {
  return op.kind === 'append' ? null : { sheetName: op.sheetName, rowIndex: op.rowIndex };
}

/**
 * 成功した書き込みに合わせて、同じ行のキュー項目から重なる列を取り除く。
 * 全部の列が上書きされたら null（＝もう送る必要が無い）。
 */
function narrowOp(queued: WriteOp, succeeded: WriteOp): WriteOp | null {
  const covered = new Set(groupsOf(succeeded));
  const mine    = groupsOf(queued);
  if (mine.length === 0 || mine.every((g) => covered.has(g))) return null;

  // 部分的にしか重ならないのは updateRow（A:L をまとめて書く）だけ。
  // 列を削れないので、重なる列の値だけ新しいものに差し替えて送る
  if (queued.kind !== 'updateRow') return queued;

  let entry = queued.entry;
  if (succeeded.kind === 'updateFlags')  entry = { ...entry, ...succeeded.patch };
  if (succeeded.kind === 'setRecurring') entry = { ...entry, recurring: succeeded.recurring };
  if (succeeded.kind === 'markDeleted')  entry = { ...entry, deleted: true };
  return entry === queued.entry ? queued : { ...queued, entry };
}

/**
 * 直接書き込みが成功したときに呼ぶ。同じ行の未送信項目を新しい内容に合わせて畳む。
 * **キューからの再送では呼ばないこと**（キュー内は積んだ順に送るので畳む必要が無い）。
 */
export function reconcileAfterDirectWrite(succeeded: WriteOp): void {
  const target = rowTargetOf(succeeded);
  if (!target) return;

  const items = load();
  if (items.length === 0) return;

  const next: QueuedWrite[] = [];
  let changed = false;

  for (const item of items) {
    const t = rowTargetOf(item.op);
    if (!t || t.sheetName !== target.sheetName || t.rowIndex !== target.rowIndex) {
      next.push(item);
      continue;
    }
    const narrowed = narrowOp(item.op, succeeded);
    if (narrowed === null) {
      changed = true;
      continue; // 新しい書き込みに完全に上書きされたので捨てる
    }
    if (narrowed !== item.op) {
      item.op = narrowed;
      changed = true;
    }
    next.push(item);
  }

  if (!changed) return;
  const removed = items.length - next.length;
  if (removed > 0) console.log(`[WriteQueue] 新しい書き込みに追い越された ${removed} 件を破棄`);
  queue = next;
  persist();
  publish();
}

/**
 * サーバーから読んだ行に、未送信の変更を重ねて返す。
 * 「前回の登録」のようにシートを読み直す画面が、退避中の変更を無かったことにして
 * 古い値で上書き保存してしまうのを防ぐ。
 */
export function applyPendingTo(row: ExpenseRow): ExpenseRow {
  if (!row.sheetName || row.rowIndex === undefined) return row;
  const items = load();
  if (items.length === 0) return row;

  let next = row;
  for (const item of items) {
    const t = rowTargetOf(item.op);
    if (!t || t.sheetName !== row.sheetName || t.rowIndex !== row.rowIndex) continue;
    switch (item.op.kind) {
      case 'updateRow':
        next = { ...item.op.entry, sheetName: row.sheetName, rowIndex: row.rowIndex };
        break;
      case 'updateFlags':  next = { ...next, ...item.op.patch }; break;
      case 'setRecurring': next = { ...next, recurring: item.op.recurring }; break;
      case 'markDeleted':  next = { ...next, deleted: true }; break;
      case 'append':       break;
    }
  }
  return next;
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
