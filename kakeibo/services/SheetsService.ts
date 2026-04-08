import axios, { AxiosInstance } from 'axios';
import { getAccessToken } from './AuthService';

// ─── スプレッドシート設定（後で設定） ────────────────────────────────────────
// Google Sheets の URL から取得: https://docs.google.com/spreadsheets/d/{ID}/edit
export const SPREADSHEET_ID = 'REMOVED_SPREADSHEET_ID';
// ─────────────────────────────────────────────────────────────────────────────

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** 1 行分の家計簿エントリ */
export interface ExpenseRow {
  timestamp: string; // ISO 8601 形式
  source:    string; // 'receipt' | 'gmail' | 'suica' | 'manual' など
  user:      string; // 夫 / 妻 など
  store:     string;
  category:  string;
  amount:    number;
  memo:      string;
}

/** ヘッダー行（新規シート作成時に書き込む） */
const HEADER_ROW: readonly string[] = [
  'timestamp', 'source', 'user', 'store', 'category', 'amount', 'memo',
];

/** 設定シート名（先頭の _ で月別シートと区別） */
const SETTINGS_SHEET = '_settings';

/** 初回作成時のデフォルトカテゴリ */
const DEFAULT_CATEGORIES: readonly string[] = [
  '食費', '外食', '日用品', '交通費', '医療',
  '娯楽', '衣類', '光熱費', '通信費', 'その他',
];

// ─── 内部: 認証付き axios インスタンスを作る ─────────────────────────────────

async function createClient(): Promise<AxiosInstance> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('未サインインです。先に signInWithGoogle() を呼んでください。');
  }
  return axios.create({
    baseURL: `${SHEETS_API_BASE}/${SPREADSHEET_ID}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

// ─── 内部: シート名ユーティリティ ────────────────────────────────────────────

/** 年月からシート名を生成（例: 2026-04） */
export function getSheetNameFromDate(date: Date = new Date()): string {
  const year  = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** 指定タイムスタンプからシート名を生成 */
function sheetNameFromTimestamp(isoTimestamp: string): string {
  return getSheetNameFromDate(new Date(isoTimestamp));
}

// ─── 内部: シートの存在確認 / 作成 ───────────────────────────────────────────

/** スプレッドシート内の全シート名を取得 */
async function listSheetNames(client: AxiosInstance): Promise<string[]> {
  const res = await client.get('', { params: { fields: 'sheets.properties.title' } });
  const sheets = res.data.sheets ?? [];
  return sheets.map((s: { properties: { title: string } }) => s.properties.title);
}

/** シートが無ければ新規作成しヘッダー行を書き込む */
async function ensureSheetExists(client: AxiosInstance, sheetName: string): Promise<void> {
  const existing = await listSheetNames(client);
  if (existing.includes(sheetName)) return;

  // シート追加
  await client.post(':batchUpdate', {
    requests: [{ addSheet: { properties: { title: sheetName } } }],
  });

  // ヘッダー行書き込み
  await client.put(
    `/values/${encodeURIComponent(sheetName)}!A1`,
    { values: [HEADER_ROW] },
    { params: { valueInputOption: 'RAW' } },
  );
}

// ─── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 家計簿エントリを 1 行追記する。
 * シート名は timestamp の年月から自動生成され、未作成なら自動で作る。
 */
export async function appendRow(entry: ExpenseRow): Promise<void> {
  const client    = await createClient();
  const sheetName = sheetNameFromTimestamp(entry.timestamp);

  await ensureSheetExists(client, sheetName);

  const row: (string | number)[] = [
    entry.timestamp,
    entry.source,
    entry.user,
    entry.store,
    entry.category,
    entry.amount,
    entry.memo,
  ];

  await client.post(
    `/values/${encodeURIComponent(sheetName)}!A:G:append`,
    { values: [row] },
    {
      params: {
        valueInputOption:    'USER_ENTERED',
        insertDataOption:    'INSERT_ROWS',
      },
    },
  );
}

/**
 * 指定月のデータを全件取得する。
 * @param yearMonth 'YYYY-MM' 形式のシート名。省略時は今月。
 * @returns ExpenseRow の配列（ヘッダー行は除外）。シートが存在しなければ空配列。
 */
export async function getRows(yearMonth?: string): Promise<ExpenseRow[]> {
  const client    = await createClient();
  const sheetName = yearMonth ?? getSheetNameFromDate();

  const existing = await listSheetNames(client);
  if (!existing.includes(sheetName)) return [];

  const res = await client.get(
    `/values/${encodeURIComponent(sheetName)}!A:G`,
  );

  const values: string[][] = res.data.values ?? [];
  if (values.length <= 1) return []; // ヘッダーのみ / 空

  return values.slice(1).map((row) => ({
    timestamp: row[0] ?? '',
    source:    row[1] ?? '',
    user:      row[2] ?? '',
    store:     row[3] ?? '',
    category:  row[4] ?? '',
    amount:    Number(row[5] ?? 0),
    memo:      row[6] ?? '',
  }));
}

// ─── カテゴリ管理 ─────────────────────────────────────────────────────────────

/** _settings シートが無ければ作成しデフォルトカテゴリを書き込む */
async function ensureSettingsSheet(client: AxiosInstance): Promise<void> {
  const existing = await listSheetNames(client);
  if (existing.includes(SETTINGS_SHEET)) return;

  await client.post(':batchUpdate', {
    requests: [{ addSheet: { properties: { title: SETTINGS_SHEET } } }],
  });

  await client.put(
    `/values/${encodeURIComponent(SETTINGS_SHEET)}!A1`,
    {
      values: [
        ['category'],
        ...DEFAULT_CATEGORIES.map((c) => [c]),
      ],
    },
    { params: { valueInputOption: 'RAW' } },
  );
}

/** カテゴリ一覧を取得（_settings シートが無ければ作成してデフォルトを返す） */
export async function getCategories(): Promise<string[]> {
  const client = await createClient();
  await ensureSettingsSheet(client);

  const res = await client.get(
    `/values/${encodeURIComponent(SETTINGS_SHEET)}!A:A`,
  );
  const values: string[][] = res.data.values ?? [];
  return values
    .slice(1)                       // ヘッダー除外
    .map((r) => r[0] ?? '')
    .filter((v) => v.length > 0);
}

/** カテゴリを追加（重複時はスキップ） */
export async function addCategory(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('カテゴリ名が空です');

  const client = await createClient();
  await ensureSettingsSheet(client);

  const current = await getCategories();
  if (current.includes(trimmed)) return;

  await client.post(
    `/values/${encodeURIComponent(SETTINGS_SHEET)}!A:A:append`,
    { values: [[trimmed]] },
    {
      params: {
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
      },
    },
  );
}

/** カテゴリを削除（該当行の値だけ消し、行は詰めない＝シンプル実装） */
export async function removeCategory(name: string): Promise<void> {
  const client = await createClient();
  const current = await getCategories();
  const remaining = current.filter((c) => c !== name);

  // A 列を全クリアしてから書き直す（行数が減るので clear → update が安全）
  await client.post(
    `/values/${encodeURIComponent(SETTINGS_SHEET)}!A:A:clear`,
  );
  await client.put(
    `/values/${encodeURIComponent(SETTINGS_SHEET)}!A1`,
    {
      values: [
        ['category'],
        ...remaining.map((c) => [c]),
      ],
    },
    { params: { valueInputOption: 'RAW' } },
  );
}
