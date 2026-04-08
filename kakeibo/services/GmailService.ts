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
import { getAccessToken } from './AuthService';
import {
  appendRow,
  ExpenseRow,
  GmailFilter,
  getGmailFilters,
  getProcessedGmailIds,
  markGmailMessageProcessed,
} from './SheetsService';
import { getCategories } from './CategoryService';
import { getCurrentUser } from './UserService';
import { getProvider } from '../providers';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** 取得対象期間（Gmail 検索クエリの newer_than 値） */
const SEARCH_WINDOW = '60d';

/** 1フィルターあたりの最大メール件数 */
const MAX_PER_FILTER = 30;

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
 * バックグラウンド実行想定で、エラーは内部で捕捉して console.error に出す。
 */
export async function runGmailImport(): Promise<void> {
  try {
    const filters = await getGmailFilters();
    if (filters.length === 0) {
      console.log('[Gmail] フィルター未設定のためスキップ');
      return;
    }

    const processedIds = await getProcessedGmailIds();
    const categories   = await getCategories();
    const provider     = getProvider();
    const currentUser  = await getCurrentUser();

    let imported = 0;
    let skipped  = 0;
    let failed   = 0;

    for (const filter of filters) {
      const query = buildQuery(filter);
      let messageRefs: GmailMessageRef[] = [];
      try {
        messageRefs = await searchMessages(query, MAX_PER_FILTER);
      } catch (e) {
        console.error('[Gmail] 検索失敗:', query, e);
        continue;
      }

      for (const ref of messageRefs) {
        if (processedIds.has(ref.id)) continue;

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
            .map((i) => `${i.name}:${i.price}`)
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
      }
    }

    console.log(`[Gmail] 取り込み完了: imported=${imported}, skipped=${skipped}, failed=${failed}`);
  } catch (e) {
    console.error('[Gmail] runGmailImport 失敗:', e);
  }
}

// ─── 内部: クエリ構築 ────────────────────────────────────────────────────────

function buildQuery(filter: GmailFilter): string {
  const parts: string[] = [`newer_than:${SEARCH_WINDOW}`];
  if (filter.from)    parts.push(`from:(${filter.from})`);
  if (filter.subject) parts.push(`subject:(${filter.subject})`);
  return parts.join(' ');
}

// ─── 内部: Gmail API 呼び出し ────────────────────────────────────────────────

async function gmailGet<T>(path: string, params?: object): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error('未サインインです');

  const res = await axios.get<T>(`${GMAIL_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  return res.data;
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
