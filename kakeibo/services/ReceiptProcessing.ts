/**
 * レシート画像 → 書き込み用の行 → シートへ保存、までの画面に依存しない処理。
 * 撮影画面と裏で回る OCR（`OcrWorker`）の両方から使う。
 */

import { appendRow, ExpenseRow, newEntryId } from './SheetsService';
import { QueuedWriteError } from './WriteQueueService';
import { AuthError } from './AuthService';
import { getCurrentUser } from './UserService';
import * as CategoryService from './CategoryService';
import * as LastBatch from './LastBatchService';
import * as Demo from './DemoService';
import { getProvider } from '../providers';
import type { ReceiptData } from '../providers';

/**
 * 画像を OCR して書き込み用の行にする。金額を読めなかったものは捨てる（0 円の行を作らない）。
 * 1 件も残らなければ例外を投げる。
 */
export async function extractRows(
  base64: string,
  proxyUser: string | undefined,
  signal?: AbortSignal,
): Promise<ExpenseRow[]> {
  const categories = await CategoryService.getCategories();
  const receipts = await getProvider().extractReceipts(base64, categories, signal);
  const valid = receipts.filter((r) => r.amount > 0);
  if (valid.length === 0) throw new Error('レシートを読み取れませんでした');

  const user   = proxyUser ?? await getCurrentUser();
  const source = proxyUser ? 'proxy_camera' : 'camera';
  return valid.map((data) => toExpenseRow(data, user, source));
}

export interface SaveResult {
  message:  string;
  /** 書き込めた（未送信に回ったものを含む）行の ID。写真のひも付けに使う */
  entryIds: string[];
}

/**
 * 行をスプレッドシートに書き込む。1 件でも入れば成功として扱い、結果メッセージを返す。
 * 全滅したときだけ例外を投げる。
 */
export async function saveReceiptRows(rows: ExpenseRow[]): Promise<SaveResult> {
  const saved: ExpenseRow[] = [];
  let queued = 0;
  let failed = 0;

  // ID を先に振っておく（未送信に回った行も、写真や品目と同じ ID で後から届く）
  for (const row of rows.map((r) => ({ ...r, entryId: r.entryId || newEntryId() }))) {
    try {
      await appendRow(row);
      saved.push(row);
    } catch (e) {
      // 通信できないだけなら端末に退避済み。OCR をやり直させる必要はない
      if (e instanceof QueuedWriteError) {
        saved.push(row);
        queued++;
        continue;
      }
      // 再サインインが必要なら残りも全部失敗するので即中断する
      if (e instanceof AuthError) throw e;
      // 1 件の失敗で他のレシートまで巻き添えにしない。件数だけ伝える
      console.error('[Receipt] 1件の書き込みに失敗:', e);
      failed++;
    }
  }

  if (saved.length === 0) throw new Error('スプレッドシートに書き込めませんでした');
  // 一覧の「前回の登録」から後で見直せるようにする。
  // デモ中は appendRow がメモリ上のオーバーレイに積むだけで実データは書かれないが、
  // saved にはマスク前の実データ（店名・金額）が入っているため、
  // ここに保存すると端末ファイルに実データが残ってしまう。デモ中は保存しない
  if (!(await Demo.isDemo())) LastBatch.saveLastBatch(saved.map(({ items: _items, ...r }) => r));
  return {
    message:  buildSaveMessage(saved, queued, failed),
    entryIds: saved.map((r) => r.entryId!),
  };
}

/** OCR 結果 1 件を書き込み用の行に変換する */
function toExpenseRow(data: ReceiptData, user: string, source: string): ExpenseRow {
  return {
    timestamp:     formatTimestamp(data.date, data.time),
    source,
    user,
    store:         data.store,
    category:      data.category,
    amount:        data.amount,
    memo:          summarizeItems(data.items),
    countedAmount: data.amount,
    excluded:      false,
    confirmed:     false,
    recurring:     false,
    items:         data.items,
  };
}

/**
 * 保存結果をトーストの文面にする。
 * 1 件なら日時・カテゴリまで見せ、複数なら店名と金額を並べる。
 */
function buildSaveMessage(saved: ExpenseRow[], queued: number, failed: number): string {
  const notes: string[] = [];
  if (failed > 0) notes.push(`${failed}件は書き込めませんでした`);

  if (saved.length === 1) {
    const r = saved[0];
    return [
      queued > 0 ? '未送信で保存しました（通信が戻ったら自動送信）' : '記録しました',
      `${r.store || '(店名なし)'}  ¥${r.amount.toLocaleString()}`,
      `${r.category} · ${r.timestamp}`,
      ...notes,
    ].join('\n');
  }

  const lines = saved
    .slice(0, 3)
    .map((r) => `${r.store || '(店名なし)'}  ¥${r.amount.toLocaleString()}`);
  if (saved.length > 3) lines.push(`ほか ${saved.length - 3} 件`);
  if (queued > 0) notes.unshift(`うち ${queued} 件は未送信（通信が戻ったら自動送信）`);

  return [`${saved.length}件を記録しました`, ...lines, ...notes].join('\n');
}

/**
 * レシートの日付として受け入れる過去の幅（日）。
 * これより古いものは年の誤読とみなす。
 */
const MAX_PAST_DAYS = 400;

/**
 * レシートから抽出した日付・時刻で 'YYYY/MM/DD HH:MM:SS' 形式の timestamp を作る。
 * 日付は AIProvider 側で YYYY-MM-DD に正規化済み。ここでは採用してよい値かだけ見る。
 */
function formatTimestamp(receiptDate: string, receiptTime?: string): string {
  const now = new Date();
  const accepted = acceptableDate(receiptDate, now);
  const datePart = accepted
    ? accepted.replace(/-/g, '/')
    : `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  let timePart: string;
  if (receiptTime && /^\d{1,2}:\d{2}(:\d{2})?$/.test(receiptTime)) {
    const [h, m, s] = receiptTime.split(':');
    timePart = `${pad(Number(h))}:${pad(Number(m))}:${pad(Number(s ?? 0))}`;
  } else {
    timePart = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  return `${datePart} ${timePart}`;
}

/**
 * 読み取った日付を採用してよいか。駄目なら null（＝撮影日を使う）。
 *
 * 未来日は有効期限や次回来店期限を購入日と取り違えたケース、極端に古い日付は年の
 * 誤読が多い。そのまま書くと別の月シートに入って一覧から消えたように見えるので、
 * 撮影日に寄せる方が事故が小さい。
 */
function acceptableDate(date: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const [y, m, d] = date.split('-').map(Number);
  const parsed  = new Date(y, m - 1, d).getTime();
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDay = (parsed - today) / 86_400_000;

  if (diffDay > 1) { // 時差ぶんだけ 1 日は許容する
    console.warn('[OCR] 未来の日付だったので撮影日を使う:', date);
    return null;
  }
  if (diffDay < -MAX_PAST_DAYS) {
    console.warn('[OCR] 古すぎる日付だったので撮影日を使う:', date);
    return null;
  }
  return date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function summarizeItems(items?: { name: string; price: number }[]): string {
  if (!items || items.length === 0) return '';
  return items.map((it) => `${it.name}:${it.price}`).join(', ');
}
