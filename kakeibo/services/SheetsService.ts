import axios, { AxiosInstance } from 'axios';
import { getAccessToken } from './AuthService';

// ─── スプレッドシート設定（後で設定） ────────────────────────────────────────
// Google Sheets の URL から取得: https://docs.google.com/spreadsheets/d/{ID}/edit
export const SPREADSHEET_ID = 'REMOVED_SPREADSHEET_ID';
// ─────────────────────────────────────────────────────────────────────────────

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** 1 行分の家計簿エントリ */
export interface ExpenseRow {
  timestamp:     string; // ISO 8601 形式
  source:        string; // 'receipt' | 'gmail' | 'suica' | 'manual' など
  user:          string; // 夫 / 妻 など
  store:         string;
  category:      string;
  amount:        number;
  memo:          string;
  countedAmount: number;  // 集計に使う金額（通常は amount と同じ）
  excluded:      boolean; // true なら集計対象外
  confirmed:     boolean; // 重複警告を確認済みとしてマーク
  rowIndex?:     number;  // シート上の行番号（1-based、ヘッダー=1）。getRows で付与
  sheetName?:    string;  // 取得元シート名（YYYY-MM）。getRows で付与
}

/** ヘッダー行（新規シート作成時に書き込む） */
const HEADER_ROW: readonly string[] = [
  'timestamp', 'source', 'user', 'store', 'category',
  'amount', 'memo', 'counted_amount', 'excluded', 'confirmed',
];

/** 月次シートの列範囲 */
const MONTH_RANGE = 'A:J';

/** 設定シート名（先頭の _ で月別シートと区別） */
const SETTINGS_SHEET           = '_settings';
const CONFIG_SHEET              = '_config';
const GMAIL_FILTERS_SHEET      = '_gmail_filters';
const GMAIL_PROCESSED_SHEET    = '_gmail_processed';

/** _config のキー */
const CONFIG_KEY_DEFAULT_PARTIAL_AMOUNT = 'default_partial_amount';
const DEFAULT_PARTIAL_AMOUNT = 1000;

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

// ─── 内部: timestamp ユーティリティ ──────────────────────────────────────────

/**
 * Sheets のシリアル日付（1899-12-30 起算の日数）を 'YYYY/MM/DD HH:MM:SS' に変換。
 * 既存データが USER_ENTERED で書かれて数値化されてしまった行を、読み出し時に
 * 人間可読な文字列へ戻すために使う。
 */
function serialToTimestamp(serial: number): string {
  const baseUtcMs = Date.UTC(1899, 11, 30);
  const d = new Date(baseUtcMs + serial * 86400000);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** タイムスタンプ列の値を文字列形式に正規化（数値文字列はシリアルとして変換） */
function normalizeTimestamp(raw: string): string {
  if (!raw) return '';
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return serialToTimestamp(n);
  }
  return raw;
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
    entry.countedAmount > 0 ? entry.countedAmount : entry.amount,
    entry.excluded ? 'TRUE' : 'FALSE',
    entry.confirmed ? 'TRUE' : 'FALSE',
  ];

  await client.post(
    `/values/${encodeURIComponent(sheetName)}!${MONTH_RANGE}:append`,
    { values: [row] },
    {
      params: {
        valueInputOption:    'RAW',
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
    `/values/${encodeURIComponent(sheetName)}!${MONTH_RANGE}`,
  );

  const values: string[][] = res.data.values ?? [];
  if (values.length <= 1) return []; // ヘッダーのみ / 空

  return values.slice(1).map((row, i) => {
    const amount = Number(row[5] ?? 0);
    const countedRaw = row[7];
    const counted = countedRaw === undefined || countedRaw === ''
      ? amount
      : Number(countedRaw);
    const excludedRaw  = (row[8] ?? '').toString().trim().toUpperCase();
    const confirmedRaw = (row[9] ?? '').toString().trim().toUpperCase();
    return {
      timestamp:     normalizeTimestamp(row[0] ?? ''),
      source:        row[1] ?? '',
      user:          row[2] ?? '',
      store:         row[3] ?? '',
      category:      row[4] ?? '',
      amount,
      memo:          row[6] ?? '',
      countedAmount: Number.isFinite(counted) ? counted : amount,
      excluded:      excludedRaw === 'TRUE',
      confirmed:     confirmedRaw === 'TRUE',
      rowIndex:      i + 2, // ヘッダーが行1なので +2
      sheetName,
    };
  });
}

/** 月次シートの一覧を新しい順に返す（'YYYY-MM' のみ、設定系シートは除外） */
export async function listMonthSheetNames(): Promise<string[]> {
  const client = await createClient();
  const all = await listSheetNames(client);
  return all
    .filter((n) => /^\d{4}-\d{2}$/.test(n))
    .sort((a, b) => (a < b ? 1 : -1));
}

/** 月次シートに含まれる年（YYYY）一覧を新しい順に返す */
export async function listAvailableYears(): Promise<string[]> {
  const months = await listMonthSheetNames();
  const years  = new Set(months.map((m) => m.slice(0, 4)));
  return [...years].sort((a, b) => (a < b ? 1 : -1));
}

/** 範囲指定 */
export type RangeSpec =
  | { type: 'month'; yearMonth: string }
  | { type: 'year';  year:      string }
  | { type: 'all' };

/** 範囲に応じて行を取得する。複数シートをまたいだ場合も sheetName が各行に付く */
export async function getRowsForRange(spec: RangeSpec): Promise<ExpenseRow[]> {
  if (spec.type === 'month') {
    return getRows(spec.yearMonth);
  }
  const months = await listMonthSheetNames();
  const targets =
    spec.type === 'year'
      ? months.filter((m) => m.startsWith(`${spec.year}-`))
      : months;
  const results = await Promise.all(targets.map((m) => getRows(m)));
  return results.flat();
}

/**
 * 指定行の counted_amount / excluded / confirmed を更新する。
 * @param yearMonth シート名（例: '2026-04'）
 * @param rowIndex  シート上の行番号（getRows が返した rowIndex）
 */
export async function updateRowFlags(
  yearMonth: string,
  rowIndex: number,
  patch: { countedAmount: number; excluded: boolean; confirmed: boolean },
): Promise<void> {
  const client = await createClient();
  await client.put(
    `/values/${encodeURIComponent(yearMonth)}!H${rowIndex}:J${rowIndex}`,
    {
      values: [[
        patch.countedAmount,
        patch.excluded ? 'TRUE' : 'FALSE',
        patch.confirmed ? 'TRUE' : 'FALSE',
      ]],
    },
    { params: { valueInputOption: 'RAW' } },
  );
}

/**
 * 指定行の全項目（A:I）を上書きする。
 * timestamp の月を変更しても行は元のシートのまま（移動しない）点に注意。
 */
export async function updateRow(
  yearMonth: string,
  rowIndex: number,
  entry: ExpenseRow,
): Promise<void> {
  const client = await createClient();
  const row: (string | number)[] = [
    entry.timestamp,
    entry.source,
    entry.user,
    entry.store,
    entry.category,
    entry.amount,
    entry.memo,
    entry.countedAmount > 0 ? entry.countedAmount : entry.amount,
    entry.excluded ? 'TRUE' : 'FALSE',
    entry.confirmed ? 'TRUE' : 'FALSE',
  ];
  await client.put(
    `/values/${encodeURIComponent(yearMonth)}!A${rowIndex}:J${rowIndex}`,
    { values: [row] },
    { params: { valueInputOption: 'RAW' } },
  );
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

// ─── 設定値 (_config シート) ─────────────────────────────────────────────────

/** _config シートが無ければ作成しデフォルト値を書き込む */
async function ensureConfigSheet(client: AxiosInstance): Promise<void> {
  const existing = await listSheetNames(client);
  if (existing.includes(CONFIG_SHEET)) return;

  await client.post(':batchUpdate', {
    requests: [{ addSheet: { properties: { title: CONFIG_SHEET } } }],
  });
  await client.put(
    `/values/${encodeURIComponent(CONFIG_SHEET)}!A1`,
    {
      values: [
        ['key', 'value'],
        [CONFIG_KEY_DEFAULT_PARTIAL_AMOUNT, DEFAULT_PARTIAL_AMOUNT],
      ],
    },
    { params: { valueInputOption: 'RAW' } },
  );
}

/** _config から key/value マップを読み出す */
async function readConfig(client: AxiosInstance): Promise<Map<string, string>> {
  await ensureConfigSheet(client);
  const res = await client.get(
    `/values/${encodeURIComponent(CONFIG_SHEET)}!A:B`,
  );
  const values: string[][] = res.data.values ?? [];
  const map = new Map<string, string>();
  for (const r of values.slice(1)) {
    const k = (r[0] ?? '').trim();
    if (k) map.set(k, (r[1] ?? '').toString());
  }
  return map;
}

/** 一部計上のデフォルト金額を取得（未設定なら 1000） */
export async function getDefaultPartialAmount(): Promise<number> {
  const client = await createClient();
  const cfg = await readConfig(client);
  const v = Number(cfg.get(CONFIG_KEY_DEFAULT_PARTIAL_AMOUNT));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PARTIAL_AMOUNT;
}

// ─── Gmail フィルター / 取り込み履歴 ──────────────────────────────────────────

export interface GmailFilter {
  from:    string;
  subject: string;
}

/** _gmail_filters シートが無ければヘッダーのみ作成する */
async function ensureGmailFiltersSheet(client: AxiosInstance): Promise<void> {
  const existing = await listSheetNames(client);
  if (existing.includes(GMAIL_FILTERS_SHEET)) return;

  await client.post(':batchUpdate', {
    requests: [{ addSheet: { properties: { title: GMAIL_FILTERS_SHEET } } }],
  });
  await client.put(
    `/values/${encodeURIComponent(GMAIL_FILTERS_SHEET)}!A1`,
    { values: [['from', 'subject']] },
    { params: { valueInputOption: 'RAW' } },
  );
}

/** _gmail_processed シートが無ければヘッダーのみ作成する */
async function ensureGmailProcessedSheet(client: AxiosInstance): Promise<void> {
  const existing = await listSheetNames(client);
  if (existing.includes(GMAIL_PROCESSED_SHEET)) return;

  await client.post(':batchUpdate', {
    requests: [{ addSheet: { properties: { title: GMAIL_PROCESSED_SHEET } } }],
  });
  await client.put(
    `/values/${encodeURIComponent(GMAIL_PROCESSED_SHEET)}!A1`,
    { values: [['message_id', 'processed_at', 'result']] },
    { params: { valueInputOption: 'RAW' } },
  );
}

/** Gmail フィルター一覧を取得（空の行は除外）。シートが無ければ作成して空配列を返す */
export async function getGmailFilters(): Promise<GmailFilter[]> {
  const client = await createClient();
  await ensureGmailFiltersSheet(client);

  const res = await client.get(
    `/values/${encodeURIComponent(GMAIL_FILTERS_SHEET)}!A:B`,
  );
  const values: string[][] = res.data.values ?? [];
  return values
    .slice(1)
    .map((r) => ({ from: (r[0] ?? '').trim(), subject: (r[1] ?? '').trim() }))
    .filter((f) => f.from.length > 0 || f.subject.length > 0);
}

/**
 * 取り込み済みメッセージID集合を取得（重複防止用）。
 * `error:` で記録された行は次回再試行できるよう除外する。
 */
export async function getProcessedGmailIds(): Promise<Set<string>> {
  const client = await createClient();
  await ensureGmailProcessedSheet(client);

  const res = await client.get(
    `/values/${encodeURIComponent(GMAIL_PROCESSED_SHEET)}!A:C`,
  );
  const values: string[][] = res.data.values ?? [];
  return new Set(
    values
      .slice(1)
      .filter((r) => !(r[2] ?? '').startsWith('error'))
      .map((r) => r[0] ?? '')
      .filter((id) => id.length > 0),
  );
}

/** 取り込み履歴に1件追記する */
export async function markGmailMessageProcessed(
  messageId: string,
  result: string,
): Promise<void> {
  const client = await createClient();
  await ensureGmailProcessedSheet(client);

  const now = new Date().toISOString();
  await client.post(
    `/values/${encodeURIComponent(GMAIL_PROCESSED_SHEET)}!A:C:append`,
    { values: [[messageId, now, result]] },
    {
      params: {
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
      },
    },
  );
}
