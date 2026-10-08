import axios, { AxiosInstance } from 'axios';
import {
  AuthError,
  TransientAuthError,
  getAccessToken,
  refreshAccessTokenNow,
} from './AuthService';
import { attachRetryInterceptor } from './httpRetry';
import * as Demo from './DemoService';
import * as WriteQueue from './WriteQueueService';
import * as Crypto from 'expo-crypto';
import type { ReceiptItem } from '../providers/AIProvider';
import { nowLabel } from './jsonFileStore';
import { getCurrentUserRaw } from './UserService';
import { getItem, setItem } from './Storage';
import * as Application from 'expo-application';
import * as Device from 'expo-device';

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
  /** 行の ID（M 列）。品目・食事から参照する。追加時に振る。2026-10 より前の行は空 */
  entryId?:      string;
  /** 同時編集の検出用（N 列）。書き換えるたびに 1 増える。2026-10 より前の行は 0 */
  rev?:          number;
  /** 購入品目。追加時だけ使い、月次シートには書かず `_items_YYYY-MM` に書く */
  items?:        ReceiptItem[];
  rowIndex?:     number;  // シート上の行番号（1-based、ヘッダー=1）。getRows で付与
  sheetName?:    string;  // 取得元シート名（YYYY-MM）。getRows で付与
}

/** ヘッダー行（新規シート作成時に書き込む） */
export const HEADER_ROW: readonly string[] = [
  'timestamp', 'source', 'user', 'store', 'category',
  'amount', 'memo', 'counted_amount', 'excluded', 'confirmed', 'recurring',
  'deleted', 'entry_id', 'rev', 'writer',
];

/** 月次シートの列範囲（A:O = timestamp 〜 writer） */
const MONTH_RANGE = 'A:O';

/** 購入品目のシート名（購入した月ごと） */
function itemsSheetName(monthSheet: string): string {
  return `_items_${monthSheet}`;
}

/**
 * 購入品目の列（仕様書 §3.2）。在庫として使う列（remaining 以降）は InventoryService が更新する。
 */
export const ITEMS_HEADER_ROW: readonly string[] = [
  'item_id', 'entry_id', 'purchased_at', 'user', 'store', 'name_raw', 'name',
  'quantity', 'unit', 'amount', 'food_kind', 'storage', 'shelf_days', 'pieces',
  'remaining', 'remaining_pieces', 'status', 'food_id', 'updated_at',
];
export const ITEMS_RANGE = 'A:S';

export function itemsSheetNameOf(monthSheet: string): string {
  return itemsSheetName(monthSheet);
}

export function newEntryId(): string {
  return Crypto.randomUUID();
}

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
/** 固定費を月初コピー済みの月（'YYYY-MM'）。**端末ローカルではなく共有**に置く。
 *  端末ごとに持つと、夫婦の2台が月初にほぼ同時に起動したとき両方が「まだ未適用」と
 *  判断して同じ固定費行を2つ作ってしまうため（2026-08-12 修正） */
const CONFIG_KEY_RECURRING_APPLIED_MONTH = 'recurring_applied_month';

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
export function sheetNameFromTimestamp(timestamp: string): string {
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

    const writer = await getDeviceId();
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
        newEntryId(),   // entry_id（コピー元とは別の行なので振り直す）
        1,              // rev
        writer,         // writer
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

/** シート名から sheetId を引く（行の挿入など、名前では指定できない操作用） */
async function fetchSheetId(client: AxiosInstance, sheetName: string): Promise<number | null> {
  const res = await client.get('', {
    params: { fields: 'sheets.properties(sheetId,title)' },
  });
  const sheets: { properties: { sheetId: number; title: string } }[] = res.data.sheets ?? [];
  return sheets.find((s) => s.properties.title === sheetName)?.properties.sheetId ?? null;
}

/**
 * 新規作成したシートにヘッダー行を書く。
 *
 * **1 行目を無条件に上書きしてはいけない。** シートを作ってからヘッダーを書くまでの間に、
 * 別プロセス（夫婦のもう一方の端末、または同一端末の Gmail 取り込みと固定費コピー）が
 * 「シートはもう在る＝ヘッダーも書かれている」と判断して先に 1 行を追記することがある。
 * ヘッダーがまだ無いのでその追記は 1 行目に入り、後から確定するヘッダー PUT に消される。
 * 月初に二人がほぼ同時に最初の支出を登録した場合に起こりうる（2026-08-12 修正）。
 */
async function writeHeaderRow(
  client: AxiosInstance,
  sheetName: string,
  header: readonly string[] = HEADER_ROW,
): Promise<void> {
  const res = await client.get(`/values/${encodeURIComponent(sheetName)}!A1:L1`);
  const firstRow: string[] = res.data.values?.[0] ?? [];

  if (firstRow.length === 0) {
    // 通常はこちら。まだ誰も書いていない
    await client.put(
      `/values/${encodeURIComponent(sheetName)}!A1`,
      { values: [header] },
      { params: { valueInputOption: 'RAW' } },
    );
    return;
  }

  // 誰かがヘッダーを書き終えていたなら何もしない
  if (firstRow[0] === header[0]) return;

  // 明細行が入ってしまっている。上書きすると消えるので、上に 1 行差し込んでから書く
  const sheetId = await fetchSheetId(client, sheetName);
  if (sheetId === null) {
    console.error(`[Sheets] ${sheetName} の sheetId が引けずヘッダーを書けなかった`);
    return;
  }
  await client.post(':batchUpdate', {
    requests: [{
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        inheritFromBefore: false,
      },
    }],
  });
  await client.put(
    `/values/${encodeURIComponent(sheetName)}!A1`,
    { values: [header] },
    { params: { valueInputOption: 'RAW' } },
  );
}

/** シートが無ければ新規作成しヘッダー行を書き込む。固定費行も自動コピー */
async function ensureSheetExists(client: AxiosInstance, sheetName: string): Promise<void> {
  if (!(await ensureSheet(client, sheetName))) return;

  await writeHeaderRow(client, sheetName);

  // 前月の固定費行をコピー（月次シートのみ対象）
  if (/^\d{4}-\d{2}$/.test(sheetName)) {
    await copyRecurringRowsToNewMonth(client, sheetName, await listSheetNames(client, true));
  }
}

// ─── 書き込みの実行と退避 ─────────────────────────────────────────────────────

/**
 * ExpenseRow をシートの 1 行（A:L）に変換する。M 列の entry_id は含めない
 * （編集で書き戻すときに ID を消さないよう、追加時だけ別に足す）
 */
function toSheetRow(entry: ExpenseRow): (string | number)[] {
  return [
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
}

/**
 * 1 操作をスプレッドシートへ送る。
 * 初回の書き込みと、キューからの再送の両方がここを通る。
 */
async function execWrite(op: WriteQueue.WriteOp): Promise<number | void> {
  const client = await createClient();

  switch (op.kind) {
    case 'append': {
      const sheetName = sheetNameFromTimestamp(op.entry.timestamp);
      await ensureSheetExists(client, sheetName);
      await client.post(
        `/values/${encodeURIComponent(sheetName)}!${MONTH_RANGE}:append`,
        { values: [[...toSheetRow(op.entry), op.entry.entryId ?? '', 1, await getDeviceId()]] },
        { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
      );
      return;
    }
    case 'appendItems': {
      if (await ensureSheet(client, op.sheetName)) {
        await writeHeaderRow(client, op.sheetName, ITEMS_HEADER_ROW);
      }
      await client.post(
        `/values/${encodeURIComponent(op.sheetName)}!${ITEMS_RANGE}:append`,
        { values: op.rows },
        { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
      );
      return;
    }
    case 'appendRaw': {
      if (await ensureSheet(client, op.sheetName)) {
        await writeHeaderRow(client, op.sheetName, op.header);
      }
      await client.post(
        `/values/${encodeURIComponent(op.sheetName)}!${op.range}:append`,
        { values: op.rows },
        { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
      );
      return;
    }
    case 'updateRow':
    case 'updateFlags':
    case 'markDeleted':
    case 'setRecurring':
      return writeRowWithRev(client, op);
  }
}

/**
 * 既存の行を書き換える。同時編集の検出のため、書く前に行を読み、N 列の rev が
 * 画面に読み込んだときの値（op.baseRev）と同じか確かめる。
 *
 * **違っていても、最後に書いたのがこの端末（O 列の writer）なら競合にしない。** 自分の直前の
 * 書き込み（同じ行を続けて操作した・古いオフラインキャッシュから操作した・届いたのに応答が
 * 返らずに送り直した）と食い違っているだけなので。相手が最後に書いていたときだけ
 * ExpenseConflictError を投げる。
 *
 * 書くのは「その操作の列から O 列まで」の連続した範囲を 1 回の PUT で
 * （PUT は通信断でも再送してよい扱いなので、POST の batchUpdate にしない）。
 * 間に挟まる列は、いま読んだ値をそのまま書き戻す。
 *
 * 編集と削除は、上書きする直前の内容を `_history` に残す（以前の内容に戻せるように）。
 * 書き込みが成功してから残す（送り直しのたびに履歴が増えないように）。
 */
async function writeRowWithRev(
  client: AxiosInstance,
  op: Extract<WriteQueue.WriteOp, { rowIndex: number }>,
): Promise<number> {
  const r = op.rowIndex;
  const me = await getDeviceId();
  const res = await client.get(`/values/${encodeURIComponent(op.sheetName)}!A${r}:O${r}`);
  const cells: string[] = res.data.values?.[0] ?? [];
  const currentRev = Number(cells[13]) || 0;
  const lastWriter = cells[14] ?? '';
  if (op.baseRev !== undefined && !op.force && currentRev !== op.baseRev && !(await isMyWriterId(lastWriter))) {
    throw new ExpenseConflictError(currentRev, cells.length > 0 ? parseRow(cells, r, op.sheetName) : null);
  }
  const rev = currentRev + 1;
  const cell = (i: number) => cells[i] ?? '';

  let range: string;
  let values: (string | number)[];
  switch (op.kind) {
    case 'updateRow':
      range  = `A${r}:O${r}`;
      values = [...toSheetRow(op.entry), cell(12), rev, me];
      break;
    case 'updateFlags':
      range  = `H${r}:O${r}`;
      values = [
        op.patch.countedAmount,
        op.patch.excluded  ? 'TRUE' : 'FALSE',
        op.patch.confirmed ? 'TRUE' : 'FALSE',
        cell(10), cell(11), cell(12), rev, me,
      ];
      break;
    case 'setRecurring':
      range  = `K${r}:O${r}`;
      values = [op.recurring ? 'TRUE' : 'FALSE', cell(11), cell(12), rev, me];
      break;
    case 'markDeleted':
      range  = `L${r}:O${r}`;
      values = ['TRUE', cell(12), rev, me];
      break;
  }

  await client.put(
    `/values/${encodeURIComponent(op.sheetName)}!${range}`,
    { values: [values] },
    { params: { valueInputOption: 'RAW' } },
  );
  if ((op.kind === 'updateRow' || op.kind === 'markDeleted') && cells.length > 0) {
    await appendHistoryRow(`entry:${op.sheetName}:${r}`, currentRev, op.sheetName, JSON.stringify(cells));
  }
  return rev;
}

// ─── この端末の識別子（O 列 writer） ─────────────────────────────────────────

/**
 * O 列の writer がこの端末か。端末 ID を ANDROID_ID に切り替える前に保存していた乱数の ID も
 * 自分として扱う（切り替え直後に、自分の書き込みを相手の変更と取り違えないように）。
 */
async function isMyWriterId(id: string): Promise<boolean> {
  if (!id) return false;
  if (id === (await getDeviceId())) return true;
  return id === (await getItem(DEVICE_ID_KEY));
}

const DEVICE_ID_KEY = 'device_id';
let deviceIdCache: string | null = null;

/**
 * 端末の ID。同時編集の検出（最後に書いたのが自分か）と、再インストール後の名前の自動選択に使う。
 * Android の ANDROID_ID はアプリの署名ごとに決まり、同じ署名なら再インストールしても変わらない
 * （EAS ビルドは毎回同じ署名）。取れなければ端末に保存した乱数を使う（再インストールで変わる）。
 */
export async function getDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache;
  try {
    const androidId = Application.getAndroidId();
    if (androidId) {
      deviceIdCache = androidId;
      return androidId;
    }
  } catch {
    // Android 以外・取れない場合は下の保存した ID を使う
  }
  const saved = await getItem(DEVICE_ID_KEY);
  if (saved) {
    deviceIdCache = saved;
    return saved;
  }
  const id = newEntryId();
  await setItem(DEVICE_ID_KEY, id);
  deviceIdCache = id;
  return id;
}

/** ほかの端末が先にこの行を変更していた */
export class ExpenseConflictError extends Error {
  constructor(public readonly currentRev: number, public readonly current: ExpenseRow | null) {
    super('ほかの端末で先に変更されています');
    this.name = 'ExpenseConflictError';
  }
}

// ─── 履歴（上書きの直前の内容） ───────────────────────────────────────────────

const HISTORY_SHEET  = '_history';
const HISTORY_HEADER = ['key', 'rev', 'saved_by', 'saved_at', 'sheet', 'rows_json'];

/** 上書きの直前の内容を残す。失敗しても投げない（書き込み自体は続ける） */
export async function appendHistoryRow(key: string, rev: number, sheet: string, json: string): Promise<void> {
  try {
    const client = await createClient();
    if (await ensureSheet(client, HISTORY_SHEET)) {
      await writeHeaderRow(client, HISTORY_SHEET, HISTORY_HEADER);
    }
    const savedBy = await getCurrentUserRaw();
    await client.post(
      `/values/${encodeURIComponent(HISTORY_SHEET)}!A:F:append`,
      { values: [[key, rev, savedBy, nowLabel(), sheet, json]] },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
  } catch (e) {
    console.warn('[Sheets] 履歴を残せなかった:', describeError(e));
  }
}

export interface ExpenseHistoryEntry {
  rev:     number;
  savedBy: string;
  savedAt: string;
  row:     ExpenseRow;
}

/** 支出行の過去の内容（新しい順） */
export async function getExpenseHistory(sheetName: string, rowIndex: number): Promise<ExpenseHistoryEntry[]> {
  // デモ中は実データ（店名・金額）を見せない
  if (await Demo.isDemo()) return [];
  const client = await createClient();
  const names = await listSheetNames(client, true);
  if (!names.includes(HISTORY_SHEET)) return [];
  const res = await client.get(`/values/${encodeURIComponent(HISTORY_SHEET)}!A:F`);
  const values: string[][] = res.data.values ?? [];
  const key = `entry:${sheetName}:${rowIndex}`;
  const out: ExpenseHistoryEntry[] = [];
  for (const c of values.slice(1)) {
    if (c[0] !== key) continue;
    try {
      const cells = JSON.parse(c[5] ?? '[]') as string[];
      out.push({ rev: Number(c[1]) || 0, savedBy: c[2] ?? '', savedAt: c[3] ?? '', row: parseRow(cells, rowIndex, sheetName) });
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out.sort((a, b) => b.rev - a.rev);
}

/** 後で送り直せば成功しうる失敗か（＝キューに積む価値があるか） */
function isQueueable(e: unknown): boolean {
  if (e instanceof Demo.DemoModeError) return false;
  // 再サインインすれば送れる。積んでおけば次のサインイン後に自動で流れる
  if (e instanceof AuthError || e instanceof TransientAuthError) return true;
  if (!axios.isAxiosError(e)) return false;

  const status = e.response?.status;
  if (status === undefined) return true;   // 通信断・タイムアウト
  return status === 429 || status >= 500;  // クォータ超過・サーバー側の障害
}

/** キュー一覧に出す短いエラー説明 */
function describeError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const status = e.response?.status;
    if (status) return `HTTP ${status}`;
    return e.code === 'ECONNABORTED' ? 'タイムアウト' : 'ネットワークエラー';
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * 書き込みを実行し、一時的な失敗なら端末のキューへ退避する。
 *
 * 退避したときは QueuedWriteError を投げる（＝画面側は変更を巻き戻さない）。
 * ただし AuthError だけは元のまま投げてサインアウト処理をさせる。
 * キューには積んであるので、再ログイン後に自動で送られる。
 */
async function writeOrQueue(op: WriteQueue.WriteOp): Promise<number | void> {
  let rev: number | void;
  try {
    rev = await execWrite(op);
  } catch (e) {
    if (!isQueueable(e)) throw e;
    const reason = describeError(e);
    WriteQueue.enqueue(op, reason);
    if (e instanceof AuthError) throw e;
    throw new WriteQueue.QueuedWriteError(reason);
  }
  // 今の書き込みは、同じ行に溜まっている未送信項目より新しい。
  // そのまま流すと古い値で上書きされるので、重なる列を潰しておく
  WriteQueue.reconcileAfterDirectWrite(op);
  // 残った同じ行の未送信項目は、今書いた rev を基準にする（自分の書き込みと競合扱いにしない）
  if (typeof rev === 'number' && 'rowIndex' in op) WriteQueue.advanceBaseRev(op.sheetName, op.rowIndex, rev);
  return rev;
}

export interface FlushResult {
  sent:      number;
  remaining: number;
}

let flushInflight: Promise<FlushResult> | null = null;

/**
 * 端末に溜まった未送信の書き込みを古い順に送る。
 * 1 件でも失敗したらそこで止める（同じ行に対する操作の順序を崩さないため）。
 */
export async function flushWriteQueue(): Promise<FlushResult> {
  if (flushInflight) return flushInflight;

  flushInflight = (async () => {
    // デモ中に実データへ書き込まない（デモを抜けてから送る）
    if (await Demo.isDemo()) return { sent: 0, remaining: WriteQueue.count() };

    let sent = 0;
    let authError: AuthError | null = null;
    // 競合で止めた行。同じ行の後続を先に送ると、上書きを選んだときに順番が崩れるので送らない
    const blocked = new Set<string>();
    const rowKey = (op: WriteQueue.WriteOp) => ('rowIndex' in op ? `${op.sheetName}:${op.rowIndex}` : null);
    // 同じ ID の行が既にシートにある追加は送らない（登録の途中で終了されたあと、圏外で保存し直した場合など）。
    // その行の品目も送らない（最初の登録で書けている）
    const idsBySheet = new Map<string, Set<string>>();
    const skippedEntries = new Set<string>();
    const alreadyInSheet = async (entry: ExpenseRow): Promise<boolean> => {
      if (!entry.entryId) return false;
      const sheet = sheetNameFromTimestamp(entry.timestamp);
      if (!idsBySheet.has(sheet)) {
        const client = await createClient();
        const names = await listSheetNames(client, true);
        const ids = new Set<string>();
        if (names.includes(sheet)) {
          const res = await client.get(`/values/${encodeURIComponent(sheet)}!M:M`);
          for (const c of (res.data.values ?? []) as string[][]) if (c[0]) ids.add(c[0]);
        }
        idsBySheet.set(sheet, ids);
      }
      return idsBySheet.get(sheet)!.has(entry.entryId);
    };
    for (const item of WriteQueue.list()) {
      const key = rowKey(item.op);
      if (item.permanent) {
        // 送り直しても直らないと分かっているものは飛ばす
        if (key && WriteQueue.isConflict(item)) blocked.add(key);
        continue;
      }
      if (key && blocked.has(key)) continue;
      try {
        if (item.op.kind === 'appendItems' && skippedEntries.has(item.op.entryId)) {
          WriteQueue.remove(item.id);
          continue;
        }
        if (item.op.kind === 'append' && (await alreadyInSheet(item.op.entry))) {
          skippedEntries.add(item.op.entry.entryId!);
          WriteQueue.remove(item.id);
          continue;
        }
        const rev = await execWrite(item.op);
        if (item.op.kind === 'append' && item.op.entry.entryId) {
          idsBySheet.get(sheetNameFromTimestamp(item.op.entry.timestamp))?.add(item.op.entry.entryId);
        }
        WriteQueue.remove(item.id);
        if (typeof rev === 'number' && 'rowIndex' in item.op) {
          WriteQueue.advanceBaseRev(item.op.sheetName, item.op.rowIndex, rev);
        }
        sent++;
      } catch (e) {
        // ほかの端末が先に変更していた。勝手に上書きせず、設定画面で選んでもらう。
        // ほかの行の項目は順番に影響しないので先へ進む
        if (e instanceof ExpenseConflictError) {
          WriteQueue.markAttempt(item.id, `${WriteQueue.CONFLICT_PREFIX}: ほかの端末で先に変更されています`, true);
          if (key) blocked.add(key);
          continue;
        }
        WriteQueue.markAttempt(item.id, describeError(e), !isQueueable(e));
        // AuthError は他の一時的な失敗と違い「送り直せば直る」ものではないので、
        // ここで握りつぶさず呼び出し元へ伝えてサインアウト処理をさせる
        // （writeOrQueue の直接書き込み経路と同じ扱いに揃える）
        if (e instanceof AuthError) authError = e;
        break;
      }
    }
    if (sent > 0) console.log(`[WriteQueue] ${sent}件を送信した`);
    if (authError) throw authError;
    return { sent, remaining: WriteQueue.count() };
  })().finally(() => {
    flushInflight = null;
  });

  return flushInflight;
}

/**
 * 食事・共有写真などの別サービスが、同じスプレッドシートを読み書きするための入口。
 * 認証・再送・シート作成の扱いをここに揃える（各サービスで写経しない）。
 */
export const SheetsInternal = {
  createClient,
  ensureSheet,
  writeHeaderRow,
  listSheetNames,
  fetchSheetId,
  invalidateSheetNames,
  writeOrQueue,
  describeError,
  isQueueable,
};

// ─── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 家計簿エントリを 1 行追記する。
 * シート名は timestamp の年月から自動生成され、未作成なら自動で作る。
 * 通信できなかった場合は端末に退避して QueuedWriteError を投げる。
 */
export async function appendRow(entry: ExpenseRow): Promise<string> {
  const { items, ...rest } = entry;
  const expense: ExpenseRow = { ...rest, entryId: entry.entryId || newEntryId() };
  const entryId = expense.entryId!;

  // デモモード中はシートに書かず、メモリ上のオーバーレイにだけ積む（品目も書かない）
  if (await Demo.isDemo()) {
    Demo.demoAppend(expense, sheetNameFromTimestamp(expense.timestamp));
    return entryId;
  }

  const itemsOp = buildItemsOp(expense, items ?? []);
  try {
    await writeOrQueue({ kind: 'append', entry: expense });
  } catch (e) {
    // 支出行が未送信に回ったなら、品目もその後ろに積む（送る順番を保つ）
    if (itemsOp && (e instanceof WriteQueue.QueuedWriteError || e instanceof AuthError)) {
      WriteQueue.enqueue(itemsOp, describeError(e));
    }
    throw e;
  }

  // 支出行は書けている。品目の失敗で呼び出し元に失敗を返すと、レシートを読み直して
  // 支出行を二重に作られるので、ここで止めて投げない（一時的な失敗は未送信に積まれる）
  if (itemsOp) {
    try {
      await writeOrQueue(itemsOp);
    } catch (e) {
      console.warn('[Sheets] 品目を書き込めなかった:', describeError(e));
    }
  }
  return entryId;
}

/**
 * 指定した ID の支出行のうち、既にシートにある（または未送信キューに積まれている）ものを返す。
 * 登録の途中でアプリが終了されたあと、同じ行を二重に追加しないために使う。
 */
export async function existingEntryIds(rows: ExpenseRow[]): Promise<Set<string>> {
  const ids = new Set(rows.map((r) => r.entryId).filter((x): x is string => !!x));
  const found = new Set<string>();
  for (const q of WriteQueue.list()) {
    if (q.op.kind === 'append' && q.op.entry.entryId && ids.has(q.op.entry.entryId)) found.add(q.op.entry.entryId);
  }
  const client = await createClient();
  const names = await listSheetNames(client, true);
  for (const sheet of new Set(rows.map((r) => sheetNameFromTimestamp(r.timestamp)))) {
    if (!names.includes(sheet)) continue;
    const res = await client.get(`/values/${encodeURIComponent(sheet)}!M:M`);
    for (const c of (res.data.values ?? []) as string[][]) {
      if (c[0] && ids.has(c[0])) found.add(c[0]);
    }
  }
  return found;
}

/** 品目の追記操作を作る。食品以外も含めて全部残す（家計簿側の検索・集計にも使う） */
function buildItemsOp(expense: ExpenseRow, items: ReceiptItem[]): WriteQueue.WriteOp | null {
  if (items.length === 0) return null;
  const rows = items.map((it) => [
    newEntryId(),             // item_id
    expense.entryId ?? '',
    expense.timestamp,        // purchased_at
    expense.user,
    expense.store,
    it.name,                  // name_raw
    it.normalized ?? it.name, // name
    it.quantity ?? '',
    it.unit ?? '',
    it.price,
    it.kind ?? '',
    it.storage ?? '',
    it.shelfDays ?? '',
    it.pieces ?? '',
    1,                        // remaining（割合）
    it.pieces ?? '',          // remaining_pieces
    it.kind === 'non_food' ? '' : 'in_stock',
    '',                       // food_id（食品データと対応付けたら入る）
    nowLabel(),
  ]);
  return {
    kind: 'appendItems',
    sheetName: itemsSheetName(sheetNameFromTimestamp(expense.timestamp)),
    entryId: expense.entryId ?? '',
    store: expense.store,
    rows,
  };
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
    .map((row, i) => parseRow(row, i + 2, sheetName)) // ヘッダーが行1なので +2
    // 論理削除された行はアプリからは完全に見せない（復活不可）
    .filter((r) => !r.deleted);
}

/** 月次シートの 1 行（A:N）を ExpenseRow にする */
function parseRow(row: string[], rowIndex: number, sheetName: string): ExpenseRow {
  const amount = Number(row[5] ?? 0);
  const countedRaw = row[7];
  const counted = countedRaw === undefined || countedRaw === ''
    ? amount
    : Number(countedRaw);
  const flag = (i: number) => (row[i] ?? '').toString().trim().toUpperCase() === 'TRUE';
  return {
    timestamp:     normalizeTimestamp(row[0] ?? ''),
    source:        row[1] ?? '',
    user:          row[2] ?? '',
    store:         row[3] ?? '',
    category:      row[4] ?? '',
    amount,
    memo:          row[6] ?? '',
    countedAmount: Number.isFinite(counted) ? counted : amount,
    excluded:      flag(8),
    confirmed:     flag(9),
    recurring:     flag(10),
    deleted:       flag(11),
    entryId:       row[12] ? String(row[12]) : undefined,
    rev:           Number(row[13]) || 0,
    rowIndex,
    sheetName,
  };
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
  guard: RevOptions = {},
): Promise<number | void> {
  if (await Demo.isDemo()) {
    Demo.demoPatch(yearMonth, rowIndex, patch);
    return;
  }
  return writeOrQueue({ kind: 'updateFlags', sheetName: yearMonth, rowIndex, patch, ...guard });
}

/**
 * 同時編集の検出。`baseRev` は画面に読み込んだときの行の rev（ExpenseRow.rev）。
 * シートの rev と違えば ExpenseConflictError を投げる。`force` で確かめずに上書きする。
 * 成功したら新しい rev を返す（未送信に回った場合は QueuedWriteError）。
 */
export interface RevOptions {
  baseRev?: number;
  force?:   boolean;
}

/**
 * 指定行の全項目（A:I）を上書きする。
 * timestamp の月を変更しても行は元のシートのまま（移動しない）点に注意。
 */
export async function updateRow(
  yearMonth: string,
  rowIndex: number,
  entry: ExpenseRow,
  opts: { force?: boolean } = {},
): Promise<number | void> {
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
  const { items: _items, ...rest } = entry;
  return writeOrQueue({ kind: 'updateRow', sheetName: yearMonth, rowIndex, entry: rest, baseRev: entry.rev, force: opts.force });
}

/**
 * 指定行を論理削除する。L 列に TRUE を書き込むだけで行は残す。
 * アプリ側の getRows は deleted=TRUE の行を返さないので、アプリからは復活不可。
 * スプレッドシートを直接編集すれば L 列を FALSE に戻すことで復活可能。
 */
export async function markRowDeleted(
  yearMonth: string,
  rowIndex: number,
  guard: RevOptions = {},
): Promise<number | void> {
  if (await Demo.isDemo()) {
    Demo.demoPatch(yearMonth, rowIndex, { deleted: true });
    return;
  }
  return writeOrQueue({ kind: 'markDeleted', sheetName: yearMonth, rowIndex, ...guard });
}

/** 指定行の recurring フラグ（K列）のみ更新する */
export async function updateRecurringFlag(
  yearMonth: string,
  rowIndex: number,
  recurring: boolean,
  guard: RevOptions = {},
): Promise<number | void> {
  if (await Demo.isDemo()) {
    Demo.demoPatch(yearMonth, rowIndex, { recurring });
    return;
  }
  return writeOrQueue({ kind: 'setRecurring', sheetName: yearMonth, rowIndex, recurring, ...guard });
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

/** _config の値を読む（無ければ ''）。チェーン店の候補探しの条件など、二人で共有する設定に使う */
export async function getConfigValue(key: string): Promise<string> {
  const client = await createClient();
  return (await readConfig(client)).get(key) ?? '';
}

/** _config に値を書く */
export async function setConfigValue(key: string, value: string): Promise<void> {
  const client = await createClient();
  await upsertConfigValue(client, key, value);
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
 * シートに実際に入っているユーザー名の一覧を返す。
 * 当月シートを見て、1 人分しか居なければ前月シートも足す
 * （月が替わった直後は相手がまだ 1 件も記録しておらず代理入力が使えないため）。
 * デモモードでもマスクしないので、表示用途には getUniqueUsers() を使うこと。
 */
export async function getUniqueUsersRaw(): Promise<string[]> {
  const client = await createClient();

  const users = await readUsersFromSheet(client, getSheetNameFromDate());
  for (const u of await readRegisteredUsers(client)) users.add(u);

  // 当月に 1 人分しか記録が無いと代理入力の相手が出てこない。
  // 月が替わった直後は毎月この状態になるので、前月シートも見て補う。
  if (users.size <= 1) {
    const now  = new Date();
    const prev = getSheetNameFromDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    for (const u of await readUsersFromSheet(client, prev)) users.add(u);
  }

  return [...users];
}

/** 指定シートの C 列（user）に現れる名前を集める。シートが無ければ空集合 */
async function readUsersFromSheet(
  client: AxiosInstance,
  sheetName: string,
): Promise<Set<string>> {
  const users = new Set<string>();
  try {
    const res = await client.get(`/values/${encodeURIComponent(sheetName)}!C:C`);
    const rows: string[][] = res.data.values ?? [];
    for (let i = 1; i < rows.length; i++) {
      const cell = rows[i]?.[0];
      if (cell && cell.trim()) users.add(cell.trim());
    }
  } catch {
    // シートが無い・読めない場合は何も足さない
  }
  return users;
}

// ─── ユーザー名の登録（_users） ───────────────────────────────────────────────
//
// 端末のユーザー名は端末ローカルにしか無いので、各端末がサインイン時に自分の名前を
// ここへ登録する。代理入力の相手を「シートにその人の記録があるか」に頼らず選べる。

const USERS_SHEET  = '_users';
export const USERS_HEADER = ['user', 'registered_at', 'device_id', 'device_name', 'last_seen'];

export interface RegisteredUser {
  name:       string;
  deviceId:   string;
  deviceName: string;
  /** 最後にその端末でアプリを開いた日時（エポックミリ秒。古い行は 0） */
  lastSeen:   number;
  rowIndex:   number;
}

async function readUserRows(client: AxiosInstance): Promise<RegisteredUser[]> {
  const existing = await listSheetNames(client, true);
  if (!existing.includes(USERS_SHEET)) return [];
  const res = await client.get(`/values/${encodeURIComponent(USERS_SHEET)}!A:E`, {
    params: { valueRenderOption: 'UNFORMATTED_VALUE' },
  });
  const rows: any[][] = res.data.values ?? [];
  return rows.slice(1).map((r, i) => ({
    name:       String(r?.[0] ?? '').trim(),
    deviceId:   String(r?.[2] ?? ''),
    deviceName: String(r?.[3] ?? ''),
    lastSeen:   Number(r?.[4]) || 0,
    rowIndex:   i + 2,
  }));
}

async function readRegisteredUsers(client: AxiosInstance): Promise<Set<string>> {
  const users = new Set<string>();
  try {
    for (const u of await readUserRows(client)) if (u.name) users.add(u.name);
  } catch {
    // 読めなくても代理入力の候補が減るだけ
  }
  return users;
}

/** 登録されている端末と名前の一覧（初回の名前選びで使う） */
export async function listRegisteredUsers(): Promise<RegisteredUser[]> {
  if (await Demo.isDemo()) return [];
  const client = await createClient();
  return (await readUserRows(client)).filter((u) => u.name);
}

let registerInflight: Promise<void> | null = null;

/**
 * この端末のユーザー名を登録する（端末ごとに 1 行。名前を変えたらその行を書き換える）。
 * アプリを開くたびに呼び、最終利用日時も更新する。
 * 同時に呼ばれたら（初回の名前入力と起動時の登録など）順に実行する。並べて走らせると、
 * どちらも自分の行を見つけられずに 2 行追加してしまう。
 * @param previous 名前を変えた場合の旧名。端末 ID の無い旧形式の行に残っていれば空にする
 */
export async function registerUser(name: string, previous?: string): Promise<void> {
  const prior = registerInflight;
  const p = (prior ? prior.catch(() => {}) : Promise.resolve()).then(() => registerUserOnce(name, previous));
  registerInflight = p;
  p.finally(() => { if (registerInflight === p) registerInflight = null; }).catch(() => {});
  return p;
}

async function registerUserOnce(name: string, previous?: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || (await Demo.isDemo())) return;
  const client = await createClient();
  if (await ensureSheet(client, USERS_SHEET)) {
    await writeHeaderRow(client, USERS_SHEET, USERS_HEADER);
  }
  const me = await getDeviceId();
  const row = [trimmed, nowLabel(), me, deviceName(), Date.now()];
  const rows = await readUserRows(client);
  // 端末 ID の無い旧形式の行に旧名が残っていれば空にする（代理入力の候補に残らないように）
  const legacy = previous ? rows.filter((u) => !u.deviceId && u.name === previous.trim() && u.name !== trimmed) : [];
  for (const u of legacy) {
    await client.put(
      `/values/${encodeURIComponent(USERS_SHEET)}!A${u.rowIndex}:E${u.rowIndex}`,
      { values: [['', '', '', '', '']] },
      { params: { valueInputOption: 'RAW' } },
    );
  }
  const mine = rows.find((u) => u.deviceId === me);
  if (mine) {
    await client.put(
      `/values/${encodeURIComponent(USERS_SHEET)}!A${mine.rowIndex}:E${mine.rowIndex}`,
      { values: [row] },
      { params: { valueInputOption: 'RAW' } },
    );
    return;
  }
  await client.post(
    `/values/${encodeURIComponent(USERS_SHEET)}!A:E:append`,
    { values: [row] },
    { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
  );
}

/** 「Pixel 8」のような端末名（取れなければ空） */
function deviceName(): string {
  return Device.modelName ?? '';
}

/** シートに存在するユーザー名一覧を返す。代理入力の相手を選ぶのに使う */
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

  // 他の端末が今月ぶんを済ませていないか、共有の _config を見る
  const cfg = await readConfig(client);
  if ((cfg.get(CONFIG_KEY_RECURRING_APPLIED_MONTH) ?? '').trim() === currentMonth) return 0;

  // 前月の固定費エントリ
  const prevRows      = await getRows(prevMonth);
  const recurringRows = prevRows.filter((r) => r.recurring && !r.deleted);
  if (recurringRows.length === 0) return 0;

  // **コピーする前に「今月はこの端末がやる」と共有側へ書いておく。**
  // 済ませてから書くと、その間に起動したもう一方の端末も未適用と判断してしまう。
  // 途中で失敗したら消して、次回起動時にやり直せるようにする
  await upsertConfigValue(client, CONFIG_KEY_RECURRING_APPLIED_MONTH, currentMonth);

  try {
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

      try {
        await appendRow({
          ...entry,
          timestamp:  firstDay,
          source:     'recurring',
          excluded:   false,
          confirmed:  false,
          deleted:    false,
          entryId:    undefined, // コピー元とは別の行なので振り直す
          rowIndex:   undefined,
          sheetName:  undefined,
        });
      } catch (e) {
        // 通信できず端末に退避された場合も「作成済み」として進める。
        // ここで止めると、呼び出し側が適用済みフラグを立てられず、
        // 次回起動時にキュー内の未送信ぶんと二重に作ってしまう
        if (!(e instanceof WriteQueue.QueuedWriteError)) throw e;
      }
      alreadyKeys.add(key); // 同一エントリが複数あっても2回作らない
      created++;
    }

    return created;
  } catch (e) {
    // 確保だけして作れなかった状態を残さない（残すと今月ぶんが永久に作られない）
    try {
      await upsertConfigValue(client, CONFIG_KEY_RECURRING_APPLIED_MONTH, '');
    } catch {
      console.error('[Recurring] 適用済みフラグを戻せなかった。今月ぶんは手動で確認が必要');
    }
    throw e;
  }
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
