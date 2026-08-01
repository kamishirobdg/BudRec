import axios, { AxiosInstance } from 'axios';
import { AuthError, getAccessToken, refreshAccessTokenNow } from './AuthService';
import { attachRetryInterceptor } from './httpRetry';
import * as Demo from './DemoService';

// ─── スプレッドシート設定（.env の EXPO_PUBLIC_SPREADSHEET_ID に設定） ───────
// Google Sheets の URL から取得: https://docs.google.com/spreadsheets/d/{ID}/edit
export const SPREADSHEET_ID = process.env.EXPO_PUBLIC_SPREADSHEET_ID ?? '';
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
  recurring:     boolean; // true なら翌月新規シート作成時に自動コピー（固定費）
  deleted?:      boolean; // 論理削除フラグ。true の行は getRows で除外される
  rowIndex?:     number;  // シート上の行番号（1-based、ヘッダー=1）。getRows で付与
  sheetName?:    string;  // 取得元シート名（YYYY-MM）。getRows で付与
}

/** ヘッダー行（新規シート作成時に書き込む） */
const HEADER_ROW: readonly string[] = [
  'timestamp', 'source', 'user', 'store', 'category',
  'amount', 'memo', 'counted_amount', 'excluded', 'confirmed', 'recurring',
  'deleted',
];

/** 月次シートの列範囲（A:L = timestamp 〜 deleted） */
const MONTH_RANGE = 'A:L';

/** 設定シート名（先頭の _ で月別シートと区別） */
const SETTINGS_SHEET           = '_settings';
const CONFIG_SHEET              = '_config';
const GMAIL_FILTERS_SHEET      = '_gmail_filters';
const GMAIL_PROCESSED_SHEET    = '_gmail_processed';

/** _config のキー */
const CONFIG_KEY_DEFAULT_PARTIAL_AMOUNT = 'default_partial_amount';
const DEFAULT_PARTIAL_AMOUNT = 1000;
const CONFIG_KEY_GMAIL_SEARCH_WINDOW = 'gmail_search_window';
const DEFAULT_GMAIL_SEARCH_WINDOW: GmailSearchWindow = '60d';

/** Gmail 検索ウィンドウの選択肢 */
export type GmailSearchWindow = '30d' | '60d' | '180d' | '1y' | 'all';
export const GMAIL_SEARCH_WINDOW_OPTIONS: GmailSearchWindow[] = [
  '30d', '60d', '180d', '1y', 'all',
];

/** 初回作成時のデフォルトカテゴリ */
const DEFAULT_CATEGORIES: readonly string[] = [
  '食費', '外食', '日用品', '交通費', '医療',
  '娯楽', '衣類', '光熱費', '通信費', 'その他',
];

// ─── 内部: 認証付き axios インスタンスを作る ─────────────────────────────────

/** ネットワークが死んでいるときに無限に待たないための上限 */
const REQUEST_TIMEOUT_MS = 30_000;

async function createClient(): Promise<AxiosInstance> {
  const token = await getAccessToken();
  if (!token) throw new AuthError();
  const client = axios.create({
    baseURL: `${SHEETS_API_BASE}/${SPREADSHEET_ID}`,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  // 期限内のトークンでも Google 側で失効していることがある。
  // 401 が返ったら 1 回だけ取り直して再送し、いきなりサインアウトさせない。
  client.interceptors.response.use(undefined, async (error) => {
    const config = error?.config as (typeof error.config & { _authRetried?: boolean }) | undefined;
    if (error?.response?.status !== 401 || !config || config._authRetried) throw error;

    const fresh = await refreshAccessTokenNow();
    if (!fresh) throw new AuthError();

    config._authRetried = true;
    config.headers = { ...config.headers, Authorization: `Bearer ${fresh}` };
    return client.request(config);
  });

  // 429 / 5xx / 通信断の再送。401 の再認証より後に登録する（401 を先に処理させる）
  attachRetryInterceptor(client);

  return client;
}

/**
 * 同時に投げる Sheets リクエストの上限。
 * 全期間表示は月シートの数だけ読み出しが走るので、そのまま並列にすると 429 を招く。
 */
const FETCH_CONCURRENCY = 4;

/** items を最大 limit 並列で処理する。結果の順序は入力と揃える */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
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

/**
 * タイムスタンプからシート名を生成。
 * 'YYYY/MM/DD ...' または 'YYYY-MM-DD ...' を正規表現で直接パースする。
 * new Date() に頼ると Hermes でスラッシュ区切りが NaN になるため使わない。
 */
function sheetNameFromTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4})[\/\-](\d{2})/);
  if (match) return `${match[1]}-${match[2]}`;
  // フォールバック: ISO 形式など
  return getSheetNameFromDate(new Date(timestamp));
}

// ─── 内部: シートの存在確認 / 作成 ───────────────────────────────────────────

/**
 * シート名一覧の短命キャッシュ。
 * 全期間表示は月シートの数だけ getRows が走り、その 1 回ごとに「そのシートが
 * 存在するか」の問い合わせが発生するため、読み出し用途に限りごく短時間だけ使い回す。
 * シートを追加したら invalidateSheetNames() で必ず捨てること。
 */
const SHEET_NAMES_TTL_MS = 15_000;
let sheetNamesCache: { names: string[]; at: number } | null = null;
let sheetNamesInflight: Promise<string[]> | null = null;

function invalidateSheetNames(): void {
  sheetNamesCache = null;
}

/**
 * スプレッドシート内の全シート名を取得。
 * @param allowCache 直近の取得結果を使い回してよいなら true（読み出し専用の判定に使う）。
 *                   シートを作る前の存在確認では **必ず false**（古い一覧で二重作成しないため）。
 */
async function listSheetNames(
  client: AxiosInstance,
  allowCache = false,
): Promise<string[]> {
  if (allowCache) {
    if (sheetNamesCache && Date.now() - sheetNamesCache.at < SHEET_NAMES_TTL_MS) {
      return sheetNamesCache.names;
    }
    // 並列に呼ばれても実際のリクエストは 1 本にまとめる
    if (sheetNamesInflight) return sheetNamesInflight;
    sheetNamesInflight = fetchSheetNames(client).finally(() => {
      sheetNamesInflight = null;
    });
    return sheetNamesInflight;
  }
  return fetchSheetNames(client);
}

async function fetchSheetNames(client: AxiosInstance): Promise<string[]> {
  const res = await client.get('', { params: { fields: 'sheets.properties.title' } });
  const sheets = res.data.sheets ?? [];
  const names = sheets.map((s: { properties: { title: string } }) => s.properties.title);
  sheetNamesCache = { names, at: Date.now() };
  return names;
}

/** YYYY/MM/DD... のタイムスタンプの年月を targetYearMonth (YYYY-MM) に差し替える */
function shiftTimestampToMonth(ts: string, targetYearMonth: string): string {
  const [y, m] = targetYearMonth.split('-').map(Number);
  const match = ts.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})(.*)/);
  if (!match) return ts;
  const lastDay = new Date(y, m, 0).getDate();
  const day = Math.min(Number(match[3]), lastDay);
  return `${y}/${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}${match[4]}`;
}

/**
 * 直近の月シートから recurring=TRUE の行を取得し targetMonth シートにコピーする。
 * 新規シート作成直後に呼ぶ想定。
 */
async function copyRecurringRowsToNewMonth(
  client: AxiosInstance,
  targetMonth: string,
  allSheetNames: string[],
): Promise<void> {
  const prevMonths = allSheetNames
    .filter((n) => /^\d{4}-\d{2}$/.test(n) && n < targetMonth)
    .sort((a, b) => (a < b ? 1 : -1));

  for (const month of prevMonths) {
    const res = await client.get(
      `/values/${encodeURIComponent(month)}!${MONTH_RANGE}`,
    );
    const values: string[][] = res.data.values ?? [];
    if (values.length <= 1) continue;

    const recurringRows = values.slice(1).filter(
      (row) => (row[10] ?? '').toString().trim().toUpperCase() === 'TRUE',
    );
    if (recurringRows.length === 0) continue;

    const shifted = recurringRows
      // 論理削除済みは固定費コピーしない
      .filter((row) => (row[11] ?? '').toString().trim().toUpperCase() !== 'TRUE')
      .map((row) => [
        shiftTimestampToMonth(row[0] ?? '', targetMonth),
        row[1] ?? '',   // source
        row[2] ?? '',   // user
        row[3] ?? '',   // store
        row[4] ?? '',   // category
        row[5] ?? '0',  // amount
        row[6] ?? '',   // memo
        row[7] ?? '0',  // counted_amount
        'FALSE',        // excluded
        'FALSE',        // confirmed
        'TRUE',         // recurring
        'FALSE',        // deleted
      ]);
    if (shifted.length === 0) continue;

    await client.post(
      `/values/${encodeURIComponent(targetMonth)}!${MONTH_RANGE}:append`,
      { values: shifted },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
    break; // 最新の月だけ使えばよい
  }
}

/**
 * シートが無ければ作る。**作成した場合のみ true** を返す。
 *
 * 存在確認にキャッシュを使う（1 行追記するたびに全シート名を引くとリクエスト数が
 * 倍になり 429 を招くため）。取りこぼし——他端末が直前に作った場合など——は
 * addSheet が「既に存在する」で失敗するので、そこで一覧を取り直して吸収する。
 */
async function ensureSheet(client: AxiosInstance, sheetName: string): Promise<boolean> {
  const existing = await listSheetNames(client, true);
  if (existing.includes(sheetName)) return false;

  try {
    await client.post(':batchUpdate', {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    });
  } catch (e) {
    invalidateSheetNames();
    const fresh = await listSheetNames(client);
    if (fresh.includes(sheetName)) return false; // 競合しただけ。作成済みなので続行してよい
    throw e;
  }

  invalidateSheetNames();
  return true;
}

/** シートが無ければ新規作成しヘッダー行を書き込む。固定費行も自動コピー */
async function ensureSheetExists(client: AxiosInstance, sheetName: string): Promise<void> {
  if (!(await ensureSheet(client, sheetName))) return;

  // ヘッダー行書き込み
  await client.put(
    `/values/${encodeURIComponent(sheetName)}!A1`,
    { values: [HEADER_ROW] },
    { params: { valueInputOption: 'RAW' } },
  );

  // 前月の固定費行をコピー（月次シートのみ対象）
  if (/^\d{4}-\d{2}$/.test(sheetName)) {
    await copyRecurringRowsToNewMonth(client, sheetName, await listSheetNames(client, true));
  }
}

// ─── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 家計簿エントリを 1 行追記する。
 * シート名は timestamp の年月から自動生成され、未作成なら自動で作る。
 */
export async function appendRow(entry: ExpenseRow): Promise<void> {
  const sheetName = sheetNameFromTimestamp(entry.timestamp);

  // デモモード中はシートに書かず、メモリ上のオーバーレイにだけ積む
  if (await Demo.isDemo()) {
    Demo.demoAppend(entry, sheetName);
    return;
  }

  const client = await createClient();
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
    entry.excluded  ? 'TRUE' : 'FALSE',
    entry.confirmed ? 'TRUE' : 'FALSE',
    entry.recurring ? 'TRUE' : 'FALSE',
    entry.deleted   ? 'TRUE' : 'FALSE',
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
  const sheetName = yearMonth ?? getSheetNameFromDate();
  const rows      = await getRowsRaw(sheetName);

  // デモモード: 表示だけ差し替え、デモ中の追加・編集を重ねる
  if (!(await Demo.isDemo())) return rows;
  return Demo.applyOverlay(sheetName, Demo.maskRows(rows));
}

/**
 * 指定月のデータを全件取得する（**デモモードでもマスクしない生データ**）。
 * デモモードの設定画面のように、実際の値を見せる必要がある箇所だけで使う。
 */
export async function getRowsRaw(yearMonth?: string): Promise<ExpenseRow[]> {
  const client    = await createClient();
  const sheetName = yearMonth ?? getSheetNameFromDate();

  const existing = await listSheetNames(client, true);
  if (!existing.includes(sheetName)) return [];

  const res = await client.get(
    `/values/${encodeURIComponent(sheetName)}!${MONTH_RANGE}`,
  );

  const values: string[][] = res.data.values ?? [];
  if (values.length <= 1) return []; // ヘッダーのみ / 空

  return values
    .slice(1)
    .map((row, i) => {
      const amount = Number(row[5] ?? 0);
      const countedRaw = row[7];
      const counted = countedRaw === undefined || countedRaw === ''
        ? amount
        : Number(countedRaw);
      const excludedRaw   = (row[8]  ?? '').toString().trim().toUpperCase();
      const confirmedRaw  = (row[9]  ?? '').toString().trim().toUpperCase();
      const recurringRaw  = (row[10] ?? '').toString().trim().toUpperCase();
      const deletedRaw    = (row[11] ?? '').toString().trim().toUpperCase();
      return {
        timestamp:     normalizeTimestamp(row[0] ?? ''),
        source:        row[1] ?? '',
        user:          row[2] ?? '',
        store:         row[3] ?? '',
        category:      row[4] ?? '',
        amount,
        memo:          row[6] ?? '',
        countedAmount: Number.isFinite(counted) ? counted : amount,
        excluded:      excludedRaw  === 'TRUE',
        confirmed:     confirmedRaw === 'TRUE',
        recurring:     recurringRaw === 'TRUE',
        deleted:       deletedRaw   === 'TRUE',
        rowIndex:      i + 2, // ヘッダーが行1なので +2
        sheetName,
      };
    })
    // 論理削除された行はアプリからは完全に見せない（復活不可）
    .filter((r) => !r.deleted);
}

/** 月次シートの一覧を新しい順に返す（'YYYY-MM' のみ、設定系シートは除外） */
export async function listMonthSheetNames(): Promise<string[]> {
  const client = await createClient();
  const all = await listSheetNames(client, true);
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
  // 全期間表示ではシート数ぶん読み出しが走るので、同時実行数を絞って 429 を避ける
  const results = await mapLimited(targets, FETCH_CONCURRENCY, (m) => getRows(m));
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
  if (await Demo.isDemo()) {
    Demo.demoPatch(yearMonth, rowIndex, patch);
    return;
  }
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
  if (await Demo.isDemo()) {
    Demo.demoPatch(yearMonth, rowIndex, {
      timestamp: entry.timestamp,
      store:     entry.store,
      category:  entry.category,
      amount:    entry.amount,
      memo:      entry.memo,
      countedAmount: entry.countedAmount > 0 ? entry.countedAmount : entry.amount,
      excluded:  entry.excluded,
      confirmed: entry.confirmed,
      recurring: entry.recurring,
    });
    return;
  }
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
    entry.excluded  ? 'TRUE' : 'FALSE',
    entry.confirmed ? 'TRUE' : 'FALSE',
    entry.recurring ? 'TRUE' : 'FALSE',
    entry.deleted   ? 'TRUE' : 'FALSE',
  ];
  await client.put(
    `/values/${encodeURIComponent(yearMonth)}!A${rowIndex}:L${rowIndex}`,
    { values: [row] },
    { params: { valueInputOption: 'RAW' } },
  );
}

/**
 * 指定行を論理削除する。L 列に TRUE を書き込むだけで行は残す。
 * アプリ側の getRows は deleted=TRUE の行を返さないので、アプリからは復活不可。
 * スプレッドシートを直接編集すれば L 列を FALSE に戻すことで復活可能。
 */
export async function markRowDeleted(
  yearMonth: string,
  rowIndex: number,
): Promise<void> {
  if (await Demo.isDemo()) {
    Demo.demoPatch(yearMonth, rowIndex, { deleted: true });
    return;
  }
  const client = await createClient();
  await client.put(
    `/values/${encodeURIComponent(yearMonth)}!L${rowIndex}`,
    { values: [['TRUE']] },
    { params: { valueInputOption: 'RAW' } },
  );
}

/** 指定行の recurring フラグ（K列）のみ更新する */
export async function updateRecurringFlag(
  yearMonth: string,
  rowIndex: number,
  recurring: boolean,
): Promise<void> {
  if (await Demo.isDemo()) {
    Demo.demoPatch(yearMonth, rowIndex, { recurring });
    return;
  }
  const client = await createClient();
  await client.put(
    `/values/${encodeURIComponent(yearMonth)}!K${rowIndex}`,
    { values: [[recurring ? 'TRUE' : 'FALSE']] },
    { params: { valueInputOption: 'RAW' } },
  );
}

// ─── カテゴリ管理 ─────────────────────────────────────────────────────────────

/** _settings シートが無ければ作成しデフォルトカテゴリを書き込む */
async function ensureSettingsSheet(client: AxiosInstance): Promise<void> {
  if (!(await ensureSheet(client, SETTINGS_SHEET))) return;

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
  if (await Demo.isDemo()) throw new Demo.DemoModeError('デモモード中はカテゴリを変更できません');

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
  if (await Demo.isDemo()) throw new Demo.DemoModeError('デモモード中はカテゴリを変更できません');

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
  if (!(await ensureSheet(client, CONFIG_SHEET))) return;

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

/** Gmail 検索ウィンドウを取得（未設定なら 60d） */
export async function getGmailSearchWindow(): Promise<GmailSearchWindow> {
  const client = await createClient();
  const cfg = await readConfig(client);
  const raw = (cfg.get(CONFIG_KEY_GMAIL_SEARCH_WINDOW) ?? '').trim();
  if ((GMAIL_SEARCH_WINDOW_OPTIONS as string[]).includes(raw)) {
    return raw as GmailSearchWindow;
  }
  return DEFAULT_GMAIL_SEARCH_WINDOW;
}

/** _config の key に value を upsert する */
async function upsertConfigValue(
  client: AxiosInstance,
  key: string,
  value: string,
): Promise<void> {
  await ensureConfigSheet(client);
  const res = await client.get(
    `/values/${encodeURIComponent(CONFIG_SHEET)}!A:B`,
  );
  const values: string[][] = res.data.values ?? [];
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if ((values[i][0] ?? '').trim() === key) {
      rowIndex = i + 1; // 1-based
      break;
    }
  }
  if (rowIndex > 0) {
    await client.put(
      `/values/${encodeURIComponent(CONFIG_SHEET)}!B${rowIndex}`,
      { values: [[value]] },
      { params: { valueInputOption: 'RAW' } },
    );
  } else {
    await client.post(
      `/values/${encodeURIComponent(CONFIG_SHEET)}!A:B:append`,
      { values: [[key, value]] },
      {
        params: {
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
        },
      },
    );
  }
}

/** Gmail 検索ウィンドウを更新 */
export async function setGmailSearchWindow(v: GmailSearchWindow): Promise<void> {
  if (await Demo.isDemo()) throw new Demo.DemoModeError('デモモード中は設定を変更できません');

  const client = await createClient();
  await upsertConfigValue(client, CONFIG_KEY_GMAIL_SEARCH_WINDOW, v);
}

// ─── Gmail フィルター / 取り込み履歴 ──────────────────────────────────────────

export interface GmailFilter {
  from:    string;
  subject: string;
}

/** _gmail_filters シートが無ければヘッダーのみ作成する */
async function ensureGmailFiltersSheet(client: AxiosInstance): Promise<void> {
  if (!(await ensureSheet(client, GMAIL_FILTERS_SHEET))) return;

  await client.put(
    `/values/${encodeURIComponent(GMAIL_FILTERS_SHEET)}!A1`,
    { values: [['from', 'subject']] },
    { params: { valueInputOption: 'RAW' } },
  );
}

/** _gmail_processed シートが無ければヘッダーのみ作成する */
async function ensureGmailProcessedSheet(client: AxiosInstance): Promise<void> {
  if (!(await ensureSheet(client, GMAIL_PROCESSED_SHEET))) return;

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

/**
 * "skipped: not a transaction" として記録されたメッセージID一覧を返す。
 */
export async function getSkippedNotTransactionMessageIds(): Promise<{ id: string; processedAt: string }[]> {
  const client = await createClient();
  await ensureGmailProcessedSheet(client);

  const res = await client.get(
    `/values/${encodeURIComponent(GMAIL_PROCESSED_SHEET)}!A:C`,
  );
  const values: string[][] = res.data.values ?? [];
  return values
    .slice(1)
    .filter((r) => (r[2] ?? '') === 'skipped: not a transaction')
    .map((r) => ({ id: r[0] ?? '', processedAt: r[1] ?? '' }))
    .filter((r) => r.id.length > 0);
}

/**
 * "skipped: not a transaction" として記録されたメッセージIDを再試行対象に戻す。
 * result 列を "error: retry-requested" に書き換えることで、次回 runGmailImport で
 * getProcessedGmailIds() の除外対象（error: で始まる行）に組み込まれ再処理される。
 * @returns 書き換えた件数
 */
export async function resetSkippedNotTransactionIds(): Promise<number> {
  if (await Demo.isDemo()) throw new Demo.DemoModeError('デモモード中は再取り込みできません');

  const client = await createClient();
  await ensureGmailProcessedSheet(client);

  const res = await client.get(
    `/values/${encodeURIComponent(GMAIL_PROCESSED_SHEET)}!A:C`,
  );
  const values: string[][] = res.data.values ?? [];

  const data: { range: string; values: string[][] }[] = [];
  for (let i = 1; i < values.length; i++) {
    if ((values[i][2] ?? '') === 'skipped: not a transaction') {
      data.push({
        range: `${GMAIL_PROCESSED_SHEET}!C${i + 1}`,
        values: [['error: retry-requested']],
      });
    }
  }

  if (data.length === 0) return 0;

  await client.post('/values:batchUpdate', {
    valueInputOption: 'RAW',
    data,
  });

  return data.length;
}

/**
 * 直近シートに存在するユーザー名一覧を返す（実際にシートに入っている名前）。
 * デモモードでもマスクしないので、表示用途には getUniqueUsers() を使うこと。
 * デモモードの表示名対応表を作るための入力として使う。
 */
export async function getUniqueUsersRaw(): Promise<string[]> {
  const sheetName = getSheetNameFromDate();
  const client = await createClient();
  try {
    const res = await client.get(`/values/${encodeURIComponent(sheetName)}!C:C`);
    const rows: string[][] = res.data.values ?? [];
    const users = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const cell = rows[i]?.[0];
      if (cell && cell.trim()) users.add(cell.trim());
    }
    return [...users];
  } catch {
    return [];
  }
}

/** 直近シートに存在するユーザー名一覧を返す。代理入力対象の選択に使用 */
export async function getUniqueUsers(): Promise<string[]> {
  const users = await getUniqueUsersRaw();
  if (!(await Demo.isDemo())) return users;
  return [...new Set(users.map(Demo.maskUser))];
}

// ─── 固定費: 月初自動コピー ───────────────────────────────────────────────────

/**
 * 前月の固定費エントリを今月1日付けでコピーする。
 * 既に source='recurring' の同一キー（店舗・カテゴリ・ユーザー・金額）が
 * 今月に存在する場合はスキップする（二重作成防止）。
 * @returns 作成した件数
 */
export async function applyRecurringEntries(): Promise<number> {
  if (await Demo.isDemo()) return 0; // デモ中に実データを増やさない

  const currentMonth = getSheetNameFromDate();

  // 前月シート名
  const nowDate  = new Date();
  const prevDate = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1);
  const prevMonth = getSheetNameFromDate(prevDate);

  // 前月シートが存在しなければスキップ
  const client = await createClient();
  const existing = await listSheetNames(client, true);
  if (!existing.includes(prevMonth)) return 0;

  // 前月の固定費エントリ
  const prevRows      = await getRows(prevMonth);
  const recurringRows = prevRows.filter((r) => r.recurring && !r.deleted);
  if (recurringRows.length === 0) return 0;

  // 今月の既存 recurring エントリのキーセット
  const currentRows = await getRows(currentMonth);
  const alreadyKeys = new Set(
    currentRows
      .filter((r) => r.source === 'recurring')
      .map((r) => `${r.store}|${r.category}|${r.user}|${r.amount}`),
  );

  // 今月1日のタイムスタンプ（YYYY/MM/01 00:00:00）
  const firstDay = `${currentMonth.replace('-', '/')}/01 00:00:00`;

  let created = 0;
  for (const entry of recurringRows) {
    const key = `${entry.store}|${entry.category}|${entry.user}|${entry.amount}`;
    if (alreadyKeys.has(key)) continue;

    await appendRow({
      ...entry,
      timestamp:  firstDay,
      source:     'recurring',
      excluded:   false,
      confirmed:  false,
      deleted:    false,
      rowIndex:   undefined,
      sheetName:  undefined,
    });
    alreadyKeys.add(key); // 同一エントリが複数あっても2回作らない
    created++;
  }

  return created;
}

/** 取り込み履歴に1件追記する */
export async function markGmailMessageProcessed(
  messageId: string,
  result: string,
): Promise<void> {
  if (await Demo.isDemo()) return; // デモ中は Gmail 取り込み自体を止めてある

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
