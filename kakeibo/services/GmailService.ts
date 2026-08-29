/**
 * Gmail 連携サービス。
 *
 * フロー:
 *  1. _gmail_filters シートからフィルター（from / subject）を取得
 *  2. 各フィルターで Gmail 検索（newer_than:60d で過去60日に絞る）
 *  3. _gmail_processed と突き合わせて未処理のみ抽出
 *  4. メッセージ本文を取得 → Gemini で構造化 → スプレッドシートに追記
 *  5. _gmail_processed に結果を記録
 *
 * 起動時にバックグラウンドで一度だけ動かす想定。UI 表示は無し、エラーは
 * console にログするのみ。
 */

import axios from 'axios';
import { AuthError, getAccessToken, refreshAccessTokenNow } from './AuthService';
import { withRetry } from './httpRetry';
import {
  appendRow,
  ExpenseRow,
  GmailFilter,
  GmailSearchWindow,
  getGmailFilters,
  getGmailSearchWindow,
  getProcessedGmailIds,
  markGmailMessageProcessed,
} from './SheetsService';
import { getCategories } from './CategoryService';
import { getCurrentUser } from './UserService';
import { getProvider } from '../providers';
import * as Progress from './GmailProgressService';
import * as Demo from './DemoService';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** 1 フィルターあたりの Gmail 検索 maxResults（API 上限 500） */
const MAX_PER_FILTER = 500;

/** 1 回の runGmailImport で処理する最大件数（総合） */
const MAX_TOTAL_PER_RUN = 500;

/** Gemini に渡す本文の最大文字数（長すぎるメールは切り詰め） */
const BODY_TRUNCATE = 5000;

/** 取り込み元の source 値 */
const SOURCE_LABEL = 'gmail';

interface GmailMessageRef {
  id:       string;
  threadId: string;
}

interface GmailMessage {
  id:           string;
  internalDate?: string; // Unix ms（文字列）
  payload:      GmailPayload;
}

interface GmailPayload {
  mimeType?: string;
  headers?:  { name: string; value: string }[];
  body?:     { data?: string; size?: number };
  parts?:    GmailPayload[];
}

// ─── 公開API ────────────────────────────────────────────────────────────────

/**
 * Gmail から取引メールを取り込んでスプレッドシートに反映する。
 * 1 回の実行で最大 `MAX_TOTAL_PER_RUN` 件まで処理する。超過分は次回に持ち越す
 * （`_gmail_processed` で重複防止）。
 * エラーは内部で捕捉して console.error に出す。
 */
export async function runGmailImport(): Promise<void> {
  // 既に別インスタンスが走っているなら何もしない
  if (Progress.getSnapshot().running) {
    console.log('[Gmail] 既に取り込み中のためスキップ');
    return;
  }

  // デモモード中は実行しない（実メールを読んで実データを増やしてしまうため）
  if (await Demo.isDemo()) {
    console.log('[Gmail] デモモード中のためスキップ');
    return;
  }

  Progress.begin('準備中...');

  let imported = 0;
  let skipped  = 0;
  let failed   = 0;

  try {
    const filters = await getGmailFilters();
    if (filters.length === 0) {
      console.log('[Gmail] フィルター未設定のためスキップ');
      Progress.finish({ imported: 0, skipped: 0, failed: 0 });
      return;
    }

    const [processedIds, categories, currentUser, searchWindow] = await Promise.all([
      getProcessedGmailIds(),
      getCategories(),
      getCurrentUser(),
      getGmailSearchWindow(),
    ]);
    const provider = getProvider();

    // 各フィルターで未処理メッセージを集める
    Progress.update({ phase: '検索中...' });
    const queue: GmailMessageRef[] = [];
    for (const filter of filters) {
      const query = buildQuery(filter, searchWindow);
      try {
        const refs = await searchMessages(query, MAX_PER_FILTER);
        for (const ref of refs) {
          if (!processedIds.has(ref.id) && !queue.some((q) => q.id === ref.id)) {
            queue.push(ref);
          }
        }
      } catch (e) {
        console.error('[Gmail] 検索失敗:', query, e);
      }
    }

    // 上限を適用
    const targets = queue.slice(0, MAX_TOTAL_PER_RUN);
    const total = targets.length;
    Progress.update({ total, current: 0, phase: total === 0 ? '未処理なし' : `処理中 0/${total}` });

    if (total === 0) {
      console.log('[Gmail] 未処理メール無し');
      Progress.finish({ imported, skipped, failed });
      return;
    }

    for (let i = 0; i < targets.length; i++) {
      const ref = targets[i];
      Progress.update({ current: i, phase: `処理中 ${i + 1}/${total}` });

      try {
        const message = await getMessage(ref.id);
        const text    = extractTextBody(message.payload);
        if (!text) {
          await markGmailMessageProcessed(ref.id, 'skipped: empty body');
          skipped++;
          continue;
        }

        const truncated = text.slice(0, BODY_TRUNCATE);
        const data = await provider.extractEmail(truncated, categories);

        if (!data.amount || data.amount <= 0) {
          await markGmailMessageProcessed(ref.id, 'skipped: not a transaction');
          skipped++;
          continue;
        }

        const memo = (data.items ?? [])
          .map((it) => `${it.name}:${it.price}`)
          .join(',')
          .slice(0, 500);

        const timestamp = formatGmailTimestamp(message.internalDate);
        const row: ExpenseRow = {
          timestamp,
          source:        SOURCE_LABEL,
          user:          currentUser,
          store:         data.store,
          category:      data.category,
          amount:        data.amount,
          memo,
          countedAmount: data.amount,
          excluded:      false,
          confirmed:     false,
          recurring:     false,
        };
        await appendRow(row);
        await markGmailMessageProcessed(ref.id, 'ok');
        imported++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Gmail] 1件処理失敗:', ref.id, msg);
        try {
          await markGmailMessageProcessed(ref.id, `error: ${msg}`.slice(0, 200));
        } catch {
          // 履歴記録失敗は無視
        }
        failed++;
      }

      Progress.update({ current: i + 1 });
    }

    console.log(`[Gmail] 取り込み完了: imported=${imported}, skipped=${skipped}, failed=${failed}`);
    Progress.finish({ imported, skipped, failed });
  } catch (e) {
    if (e instanceof AuthError) throw e; // App.tsx 側でサインイン画面に戻す
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Gmail] runGmailImport 失敗:', e);
    Progress.fail(msg);
  }
}

// ─── 公開: スキップ済みメール確認 ────────────────────────────────────────────

export interface SkippedMessageSummary {
  id:          string;
  processedAt: string;
  subject:     string;
  date:        string;
  bodyPreview: string; // 先頭 300 文字
}

/**
 * 指定された message ID のメール件名・日時・本文プレビューを取得する。
 * 1 件取得に失敗しても他の件は続ける（エラー時は summary に reason を入れる）。
 */
export async function getSkippedMessageSummaries(
  items: { id: string; processedAt: string }[],
): Promise<SkippedMessageSummary[]> {
  // デモモード中は実メールの件名・本文を画面に出さない
  if (await Demo.isDemo()) return [];

  const results: SkippedMessageSummary[] = [];
  for (const item of items) {
    try {
      const message = await getMessage(item.id);
      const headers = message.payload?.headers ?? [];
      const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '(件名なし)';
      const dateFmt = formatGmailTimestamp(message.internalDate);
      const text    = extractTextBody(message.payload);
      const preview = text.trim().slice(0, 300).replace(/\s+/g, ' ');
      results.push({ id: item.id, processedAt: item.processedAt, subject, date: dateFmt, bodyPreview: preview });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      results.push({ id: item.id, processedAt: item.processedAt, subject: '(取得失敗)', date: '', bodyPreview: reason });
    }
  }
  return results;
}

// ─── 内部: クエリ構築 ────────────────────────────────────────────────────────

function buildQuery(filter: GmailFilter, window: GmailSearchWindow): string {
  const parts: string[] = [];
  // 'all' の場合は newer_than 句を付けず Gmail 側でフィルタしない
  if (window !== 'all') parts.push(`newer_than:${window}`);
  if (filter.from)    parts.push(`from:(${filter.from})`);
  if (filter.subject) parts.push(`subject:(${filter.subject})`);
  return parts.join(' ');
}

// ─── 内部: Gmail API 呼び出し ────────────────────────────────────────────────

async function gmailGet<T>(path: string, params?: object): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new AuthError();

  const url = `${GMAIL_API_BASE}${path}`;
  const send = (bearer: string) =>
    axios.get<T>(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      params,
      timeout: 30_000,
    });

  // Gmail は取り込み中に大量の GET を投げるので 429 を受けやすい。
  // GET は何度投げても副作用が無いため、通信断・タイムアウトでも再送してよい
  return withRetry(
    async () => {
      try {
        return (await send(token)).data;
      } catch (e) {
        // 期限内でも失効していることがあるので、401 は 1 回だけ取り直して再送する
        if (!axios.isAxiosError(e) || e.response?.status !== 401) throw e;
        const fresh = await refreshAccessTokenNow();
        if (!fresh) throw new AuthError();
        return (await send(fresh)).data;
      }
    },
    { idempotent: true, label: `GET ${path}` },
  );
}

async function searchMessages(query: string, maxResults: number): Promise<GmailMessageRef[]> {
  const data = await gmailGet<{ messages?: GmailMessageRef[] }>(`/messages`, {
    q: query,
    maxResults,
  });
  return data.messages ?? [];
}

async function getMessage(id: string): Promise<GmailMessage> {
  return gmailGet<GmailMessage>(`/messages/${id}`, { format: 'full' });
}

// ─── 内部: 本文抽出 ──────────────────────────────────────────────────────────

/** Gmail の MIME ツリーを再帰的に walk して本文テキストを取り出す */
function extractTextBody(payload: GmailPayload | undefined): string {
  if (!payload) return '';

  // text/plain を最優先で探す（再帰）
  const plain = findFirstByMime(payload, 'text/plain');
  if (plain) return decodeBase64Url(plain);

  // フォールバック: text/html を探してタグを剥がす
  const html = findFirstByMime(payload, 'text/html');
  if (html) return stripHtml(decodeBase64Url(html));

  return '';
}

function findFirstByMime(payload: GmailPayload, mimeType: string): string | null {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return payload.body.data;
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const found = findFirstByMime(p, mimeType);
      if (found) return found;
    }
  }
  return null;
}

/** Gmail の base64url エンコード本文を UTF-8 文字列にデコード */
function decodeBase64Url(s: string): string {
  const b64    = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  // React Native (Hermes) には atob / TextDecoder が利用可能
  const binary = atob(padded);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g,    ' ')
    .trim();
}

// ─── 内部: timestamp ─────────────────────────────────────────────────────────

/** Gmail の internalDate (Unix ms 文字列) から 'YYYY/MM/DD HH:MM:SS' を組み立てる */
function formatGmailTimestamp(internalDate?: string): string {
  const ms = Number(internalDate ?? '0');
  const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date();
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
