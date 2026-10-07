/**
 * OCR 待ちのレシート画像を裏で 1 枚ずつ処理する。
 *
 * 撮影画面とは独立したモジュール単位の状態で動くので、撮影を続けても・タブを切り替えても
 * 止まらない。OCR 中はフォアグラウンドサービス（通知に「OCR 処理中」が出る）で
 * プロセスを生かし、ほかのアプリに切り替えても Android に凍結・終了されないようにする。
 *
 * 処理ループ自体は JS 側で回し、サービスは「プロセスを生かしておく」ためだけに使う。
 * サービスの起動に失敗しても（バックグラウンドからの起動制限など）OCR は進む。
 *
 * 1 枚の結果:
 * - 1 件だけ読めた → そのまま保存して画像を消す（`saved` イベントでトーストを出す）
 * - 2 件以上読めた → `review`（撮影画面の「要確認」から確認して保存）
 * - 2 回失敗した   → `failed`
 * - 中止された     → `stopped`（中止を押した時点の OCR 待ちもすべて `stopped`）
 * - 認証切れ       → `queued` のまま止めて `auth-failed` を出す（再ログイン後に続きから）
 */

import BackgroundService from 'react-native-background-actions';
import { AuthError } from './AuthService';
import { CancelledError } from '../providers/AIProvider';
import * as ReceiptQueue from './ReceiptQueueService';
import { extractRows, saveReceiptRows } from './ReceiptProcessing';

export type WorkerEvent =
  | { type: 'changed' }
  | { type: 'saved'; message: string }
  | { type: 'auth-failed' };

export interface WorkerProgress {
  running: boolean;
  /** この回の処理で終えた枚数 */
  done:    number;
  /** この回の処理の総枚数（処理中に撮り足したぶんも含む） */
  total:   number;
}

const listeners = new Set<(e: WorkerEvent) => void>();
let running = false;
let done    = 0;
let currentAbort: AbortController | null = null;
let currentUri:   string | null = null;

export function subscribe(fn: (e: WorkerEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(e: WorkerEvent): void {
  for (const fn of listeners) {
    try { fn(e); } catch (err) { console.warn('[OcrWorker] listener error:', err); }
  }
}

function queuedCount(): number {
  return ReceiptQueue.listItems().filter((i) => i.status === 'queued').length;
}

export function getProgress(): WorkerProgress {
  return { running, done, total: done + queuedCount() };
}

/** 画像を OCR 待ちに積んで処理を始める */
export function enqueue(base64: string, proxyUser?: string): void {
  ReceiptQueue.saveReceipt(base64, proxyUser);
  emit({ type: 'changed' });
  kick();
}

/** 中止・失敗した画像を OCR 待ちに戻して処理を始める */
export function requeue(uris: string[]): void {
  for (const uri of uris) ReceiptQueue.setStatus(uri, 'queued');
  emit({ type: 'changed' });
  kick();
}

/**
 * いま処理中の 1 枚と、OCR 待ちの残りをすべて止める（画像は `stopped` で残る）。
 * 処理中の 1 枚は、処理側が手を離した時点で `stopped` にする。先に変えると、シートへの
 * 書き込み中に「要確認」へ出てしまい、手入力・破棄と書き込みがぶつかる。
 */
export function cancel(): void {
  ReceiptQueue.moveAll(['queued'], 'stopped', currentUri ? [currentUri] : []);
  currentAbort?.abort();
  emit({ type: 'changed' });
}

/** OCR 待ちがあれば処理を始める。既に動いていれば何もしない */
export function kick(): void {
  if (running || queuedCount() === 0) return;
  void runLoop();
}

async function runLoop(): Promise<void> {
  running = true;
  done    = 0;
  emit({ type: 'changed' });
  const serviceStarted = startService();
  let stopLoop = false;
  try {
    for (;;) {
      const next = ReceiptQueue.listItems().find((i) => i.status === 'queued');
      if (!next) break;
      updateNotification();
      const outcome = await processOne(next);
      if (outcome === 'auth-failed') {
        stopLoop = true;
        emit({ type: 'auth-failed' });
        break;
      }
      if (outcome === 'done') done++;
      emit({ type: 'changed' });
    }
  } catch (e) {
    // 同じ理由で延々と回り直さないよう、次の kick（撮影・起動）まで止める
    stopLoop = true;
    console.error('[OcrWorker] 想定外の失敗:', e);
  } finally {
    // 止め終わるまで running を下ろさない。下ろしてから止めると、その間に始まった
    // 次の回のサービスまで止めてしまう（ライブラリの停止は直近に起動したものに効く）
    await stopService(serviceStarted);
    running = false;
    done    = 0;
    emit({ type: 'changed' });
    // 止めている間に積まれたぶん
    if (!stopLoop) kick();
  }
}

async function processOne(item: ReceiptQueue.ReceiptItem): Promise<'done' | 'cancelled' | 'auth-failed'> {
  const abort = new AbortController();
  currentAbort = abort;
  currentUri   = item.uri;
  const cancelled = (): 'cancelled' => {
    ReceiptQueue.setStatus(item.uri, 'stopped');
    return 'cancelled';
  };
  try {
    let base64: string;
    try {
      base64 = ReceiptQueue.readReceipt(item.uri);
    } catch {
      ReceiptQueue.setStatus(item.uri, 'failed', { error: '画像を読み込めませんでした' });
      return 'done';
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await extractRows(base64, item.proxyUser, abort.signal);
        // OCR が返った直後に中止された場合。ここを過ぎたら書き込みは最後まで行う
        if (abort.signal.aborted) return cancelled();
        if (rows.length > 1) {
          // 誤読が起きやすいので保存前に見せる
          ReceiptQueue.setStatus(item.uri, 'review', { rows });
          return 'done';
        }
        const { message, entryIds } = await saveReceiptRows(rows);
        ReceiptQueue.completeReceipt(item.uri, entryIds);
        emit({ type: 'saved', message });
        return 'done';
      } catch (e) {
        if (e instanceof AuthError) return 'auth-failed';
        if (e instanceof CancelledError || abort.signal.aborted) return cancelled();
        if (attempt >= 1) {
          ReceiptQueue.setStatus(item.uri, 'failed', { error: e instanceof Error ? e.message : String(e) });
          return 'done';
        }
        console.warn('[OcrWorker] OCR 1回目失敗、リトライ:', e);
        await new Promise((r) => setTimeout(r, 1000));
        if (abort.signal.aborted) return cancelled();
      }
    }
  } finally {
    currentAbort = null;
    currentUri   = null;
  }
}

// ─── フォアグラウンドサービス ─────────────────────────────────────────────────

const SERVICE_OPTIONS = {
  taskName:  'ocr',
  taskTitle: 'OCR 処理中',
  taskDesc:  '',
  taskIcon:  { name: 'ic_launcher', type: 'mipmap' },
  color:     '#2e7d32',
  foregroundServiceType: ['dataSync' as const],
};

/**
 * サービスを起動する。起動に失敗しても投げない（OCR は通常どおり進める）。
 *
 * サービス側のタスクは自分では終わらせず、`stopService` の `BackgroundService.stop()` で
 * 終わらせる。タスクが終わるとライブラリが自動で `stop()` を呼ぶが、その停止は
 * 「直近に起動したサービス」に効くため、遅れて走ると次の回のサービスを止めてしまう。
 */
function startService(): Promise<void> {
  return BackgroundService.start(
    () => new Promise<void>(() => {}),
    { ...SERVICE_OPTIONS, taskDesc: progressLabel() },
  ).catch((e) => console.warn('[OcrWorker] フォアグラウンドサービスを起動できなかった:', e));
}

/** 起動の完了を待ってから止める（先に止めると、後から起動が完了して残り続ける） */
async function stopService(started: Promise<void>): Promise<void> {
  await started;
  try {
    if (BackgroundService.isRunning()) await BackgroundService.stop();
  } catch (e) {
    console.warn('[OcrWorker] フォアグラウンドサービスを止められなかった:', e);
  }
}

function progressLabel(): string {
  const { done: d, total } = getProgress();
  return `${d + 1} / ${total} 枚目`;
}

function updateNotification(): void {
  if (!BackgroundService.isRunning()) return;
  BackgroundService.updateNotification({ taskDesc: progressLabel() }).catch(() => {});
}
