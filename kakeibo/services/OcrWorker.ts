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
 * - 無料枠切れ     → `deferred`（OCR 待ちの残りもすべて）。枠が戻る時刻を過ぎたら `kick` で再開する
 *
 * アプリを開いていなくても、Android の定期実行（`BackgroundOcr.ts`）から `runPending` が呼ばれる。
 */

import BackgroundService from 'react-native-background-actions';
import { AuthError } from './AuthService';
import { CancelledError, QuotaExceededError } from '../providers/AIProvider';
import * as ReceiptQueue from './ReceiptQueueService';
import { saveReceiptRows } from './ReceiptProcessing';
import {
  MealResult, StoredAnalysis, analyzeCapturedPhoto, epochToTimestamp, linkReceiptToMeals, receiptCandidateOf, recordMeal,
} from './MealProcessing';
import { archiveMealPhoto, mealPhotoRef } from './PhotoStore';
import { mealExists, mealsSheetName } from './MealService';
import { existingEntryIds } from './SheetsService';
import { ensureMealShared } from './SharedPhotos';
import { researchSomePending } from './FoodService';
import { fillSomeImages } from './FoodImages';
import type { ExpenseRow } from './SheetsService';

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
let loopPromise:  Promise<void> | null = null;

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
  const uri = ReceiptQueue.saveReceipt(base64, proxyUser);
  // 無料枠切れで止まっている間は、送っても通らないので同じ時刻まで待たせる
  const waitUntil = ReceiptQueue.nextDeferredAt();
  if (waitUntil !== null && waitUntil > Date.now()) {
    ReceiptQueue.setStatus(uri, 'deferred', { notBefore: waitUntil });
  }
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

/**
 * OCR 待ちがあれば処理を始める。既に動いていれば何もしない。
 * 推定待ちで時刻を過ぎたものは、ここで OCR 待ちに戻す。
 */
export function kick(): void {
  if (ReceiptQueue.promoteDeferred() > 0) emit({ type: 'changed' });
  if (running || queuedCount() === 0) return;
  loopPromise = runLoop();
}

/** 定期実行から呼ぶ。処理が終わるまで待つ（定期実行はこの Promise が終わると打ち切られる） */
export async function runPending(): Promise<void> {
  kick();
  while (loopPromise) {
    const p = loopPromise;
    await p;
    if (loopPromise === p) break;
  }
}

let researching = false;

/**
 * 空き時間に食品データの栄養を少しずつ調べる（1 日の上限あり）。OCR が動いていれば何もしない。
 * 無料枠切れになったらその日は止める。失敗しても投げない。
 */
export async function researchIdle(): Promise<void> {
  if (running || researching) return;
  researching = true;
  try {
    for (let i = 0; i < 6 && !running && queuedCount() === 0; i++) {
      if (!(await researchSomePending())) break;
    }
  } catch (e) {
    if (!(e instanceof QuotaExceededError)) console.warn('[OcrWorker] 食品データの調査に失敗:', e instanceof Error ? e.message : e);
  }
  // パッケージ画像は公式ページを読むだけで AI の無料枠を使わないので、調査が止まっても進める
  try {
    for (let i = 0; i < 4 && !running && queuedCount() === 0; i++) {
      if (!(await fillSomeImages())) break;
    }
  } catch (e) {
    console.warn('[OcrWorker] パッケージ画像を探せなかった:', e instanceof Error ? e.message : e);
  } finally {
    researching = false;
  }
}

/** 推定待ちのうち、いちばん早く処理し直せる時刻（無ければ null） */
export function nextDeferredAt(): number | null {
  return ReceiptQueue.nextDeferredAt();
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
      if (outcome === 'quota') {
        // 残りも同じ理由で通らない。時刻が来たら kick で再開する
        stopLoop = true;
        break;
      }
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
    loopPromise = null;
    emit({ type: 'changed' });
    // 止めている間に積まれたぶん
    if (!stopLoop) kick();
  }
}

type Outcome = 'done' | 'cancelled' | 'auth-failed' | 'quota';

/** 無料枠切れ。この 1 枚と OCR 待ちの残りを推定待ちにする */
function deferAll(retryAt: number): Outcome {
  for (const item of ReceiptQueue.listItems()) {
    if (item.status === 'queued') ReceiptQueue.setStatus(item.uri, 'deferred', { notBefore: retryAt });
  }
  return 'quota';
}

async function processOne(item: ReceiptQueue.ReceiptItem): Promise<Outcome> {
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

    // 前回、書き込みの途中で終了されていれば、振り分けの結果が残っている。Gemini を呼び直さず続きから書く
    let analysis: StoredAnalysis | null = item.analysis ?? null;
    for (let attempt = 0; ; attempt++) {
      try {
        if (!analysis) {
          analysis = await analyzeCapturedPhoto(base64, item.proxyUser, abort.signal);
          // 読み取りが返った直後に中止された場合。ここを過ぎたら書き込みは最後まで行う
          if (abort.signal.aborted) return cancelled();
          if (analysis.receiptRows.length === 0 && analysis.dishes.length === 0) {
            analysis = null;
            throw new Error('レシートも料理・食品も読み取れませんでした');
          }
          // ID を振った結果を残してから書き始める（途中で終了されても二重に登録しないため）
          ReceiptQueue.setStatus(item.uri, 'queued', { analysis });
        }
        // 書き始めたら中止を効かせない（途中で止めると、書けたものと書けていないものが混ざる）
        return await writeAnalysis(item, analysis);
      } catch (e) {
        if (e instanceof AuthError) return 'auth-failed';
        if (e instanceof CancelledError || abort.signal.aborted) return cancelled();
        if (e instanceof QuotaExceededError) return deferAll(e.retryAt);
        if (attempt >= 1) {
          // 振り分けの結果は残す（レシートが書けていれば、手入力・再開で二重に登録しないため）
          ReceiptQueue.setStatus(item.uri, 'failed', { error: e instanceof Error ? e.message : String(e) });
          return 'done';
        }
        console.warn('[OcrWorker] 1回目失敗、リトライ:', e);
        await new Promise((r) => setTimeout(r, 1000));
        if (abort.signal.aborted) return cancelled();
      }
    }
  } finally {
    currentAbort = null;
    currentUri   = null;
  }
}

/**
 * 振り分けた結果を書く。何度呼ばれても同じ結果になるように、書けているものは飛ばす
 * （支出行は ID がシート・未送信キューにあるか、食事は meal_id があるかで見る）。
 *
 * - レシート 1 件 → 登録。2 件以上 → 保存前の確認（「要確認」）
 * - 料理・食品 → 食事として記録（同じ写真のレシートがあればそれにひも付ける）
 * - 写真: 食事の写真としてコピーを残し、レシートとして登録したものはレシートの写真として移す
 */
async function writeAnalysis(item: ReceiptQueue.ReceiptItem, a: StoredAnalysis): Promise<Outcome> {
  const shotAt = item.shotAt ?? Date.now();
  const messages: string[] = [];

  let saved: ExpenseRow[] = [];
  if (a.receiptRows.length === 1) {
    const existing = await existingEntryIds(a.receiptRows);
    saved = a.receiptRows.filter((r) => existing.has(r.entryId ?? ''));
    const remaining = a.receiptRows.filter((r) => !existing.has(r.entryId ?? ''));
    if (remaining.length > 0) {
      const res = await saveReceiptRows(remaining);
      saved = [...saved, ...res.saved];
      messages.push(res.message);
    }
  }

  let meal: MealResult | null = null;
  // 食事の写真は記録より先にコピーしておく（記録の後で終了されると、再開時に記録済みとして飛ばされ写真が残らない）。
  // 同じ名前のファイルがあれば何もしないので、何度呼んでもよい
  if (a.dishes.length > 0) archiveMealPhoto(item.uri, true);
  if (a.dishes.length > 0 && !(await mealExists(mealsSheetName(epochToTimestamp(shotAt)), a.mealId))) {
    meal = await recordMeal(a, shotAt, mealPhotoRef(item.uri), saved[0] ? receiptCandidateOf(saved[0]) : null);
    const dishes = [...new Set(meal.rows.map((x) => x.dish))];
    messages.push([
      meal.needsReview ? '食事を記録しました（要確認）' : '食事を記録しました',
      dishes.slice(0, 3).join('・') + (dishes.length > 3 ? ` ほか ${dishes.length - 3} 品` : ''),
    ].join('\n'));
  }

  if (a.receiptRows.length > 1) {
    // 誤読が起きやすいので保存前に見せる
    ReceiptQueue.setStatus(item.uri, 'review', { rows: a.receiptRows });
  } else if (saved.length > 0) {
    ReceiptQueue.completeReceipt(item.uri, saved.map((r) => r.entryId!).filter(Boolean));
  } else {
    // 食事だけの写真。保存先にコピー済みなので OCR 待ちのフォルダからは消す
    ReceiptQueue.deleteReceipt(item.uri);
  }

  if (messages.length > 0) emit({ type: 'saved', message: messages.join('\n') });
  // この写真の食事に付けたレシートを、ほかの食事にまで付けない
  if (saved.length > 0 && a.dishes.length === 0) await linkSavedReceipts(saved);
  // 未送信に積んだうえで再サインインが要る状態になった。記録は後で届くので、ここで止める
  if (meal?.authFailed) return 'auth-failed';
  if (meal?.sharedMeal) await ensureMealShared(meal.rows, meal.rows[0]?.updatedBy ?? '');
  return 'done';
}

/** 登録したレシートを、前後の時間の食事にひも付け直す（品目のあるものだけ） */
export async function linkSavedReceipts(saved: ExpenseRow[]): Promise<void> {
  for (const row of saved) {
    if (!row.entryId || !row.items || row.items.length === 0) continue;
    await linkReceiptToMeals({ entryId: row.entryId, timestamp: row.timestamp, store: row.store, items: row.items });
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
