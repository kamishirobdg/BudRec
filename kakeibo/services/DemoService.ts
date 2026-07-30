/**
 * デモモード。
 * 外部の人にアプリを見せるとき、実データのまま画面に出さないための表示差し替え層。
 *
 * 方針:
 * - マスキングは「読み出しの出口」（SheetsService.getRows / getUniqueUsers /
 *   UserService.getCurrentUser）で行う。画面側は何も知らなくて良い。
 * - デモ中の書き込みはスプレッドシートに一切送らず、メモリ上のオーバーレイに溜める。
 *   → デモ中に追加・編集・削除を実演しても実データは汚れない。アプリ再起動で消える。
 * - 同じ行はいつ見ても同じ偽金額になるように、行内容からハッシュで倍率を決める
 *   （リロードごとに金額が変わると不自然なため）。
 */

import { getItem, setItem } from './Storage';
import type { ExpenseRow } from './SheetsService';

/** デモモード中に書き込みを試みたときに投げる */
export class DemoModeError extends Error {
  constructor(message = 'デモモード中はスプレッドシートを変更できません') {
    super(message);
    this.name = 'DemoModeError';
  }
}

export interface DemoConfig {
  enabled:   boolean;
  /** 実名 → デモ表示名。未登録の名前は autoAlias() で自動命名 */
  aliases:   Record<string, string>;
  /** 金額倍率。これに ±20% の行ごとジッターが乗る */
  scale:     number;
  /**
   * カテゴリ表示名 → デモで見せたい合計金額。
   * 指定したカテゴリは倍率・ジッターを無視し、**その月の合計がこの値になるよう
   * 明細を比例配分**する（合計の定義は画面のカテゴリ別カードと同じ＝除外行を含めない
   * countedAmount の合計）。空カテゴリのキーは '未設定'。
   */
  categoryTotals: Record<string, number>;
  /** 店名も架空の名前に差し替える */
  maskStore: boolean;
  /** メモを隠す（個人的なメモや金額の書き込みが残るため既定 ON） */
  hideMemo:  boolean;
}

const KEY_CONFIG = 'demo_config';

const DEFAULT_CONFIG: DemoConfig = {
  enabled:        false,
  aliases:        {},
  scale:          1,
  categoryTotals: {},
  maskStore:      false,
  hideMemo:       true,
};

export const SCALE_OPTIONS: readonly number[] = [0.5, 0.8, 1, 1.5, 2];

let config: DemoConfig = DEFAULT_CONFIG;
let loaded = false;

// ─── 設定の読み書き ───────────────────────────────────────────────────────────

/** Storage から設定を読む（初回のみ実際に読み、以降はキャッシュ） */
export async function loadConfig(): Promise<DemoConfig> {
  if (loaded) return config;
  try {
    const raw = await getItem(KEY_CONFIG);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DemoConfig>;
      config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        aliases:        parsed.aliases ?? {},
        categoryTotals: parsed.categoryTotals ?? {},
      };
    }
  } catch {
    config = DEFAULT_CONFIG; // 壊れていたら初期値
  }
  loaded = true;
  return config;
}

/** 設定を部分更新して保存する */
export async function updateConfig(patch: Partial<DemoConfig>): Promise<DemoConfig> {
  await loadConfig();
  config = { ...config, ...patch };
  if (patch.enabled === false) clearOverlay(); // デモを抜けたら実演の痕跡を捨てる
  await setItem(KEY_CONFIG, JSON.stringify(config));
  return config;
}

/** デモモードが有効か（Storage 未ロードなら読み込む） */
export async function isDemo(): Promise<boolean> {
  const c = await loadConfig();
  return c.enabled;
}

/** 同期版。loadConfig() 済みの前提で使う（描画時の判定用） */
export function isDemoSync(): boolean {
  return config.enabled;
}

export function getConfigSync(): DemoConfig {
  return config;
}

// ─── マスキング ───────────────────────────────────────────────────────────────

/** FNV-1a 32bit。行内容から安定した疑似乱数を作るために使う */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const STORE_POOL: readonly string[] = [
  'スーパーあおば', 'コンビニ さくら', 'ドラッグ みどり', 'カフェ こもれび',
  '書店 ひなた', '衣料 かえで', '家電 つばさ', 'ネット通販 まるいち',
  '定食 やまびこ', '雑貨 このは', 'ベーカリー ひより', '八百屋 なでしこ',
];

/** 未登録の名前に割り当てる自動エイリアス（実名を出さないためのフォールバック） */
function autoAlias(name: string): string {
  const label = String.fromCharCode(65 + (hash(name) % 8)); // A〜H
  return `ユーザー${label}`;
}

export function maskUser(name: string): string {
  if (!name) return name;
  return config.aliases[name] ?? autoAlias(name);
}

function maskStore(store: string): string {
  if (!store) return store;
  return STORE_POOL[hash(store) % STORE_POOL.length];
}

/** 行ごとの金額倍率。同じ行なら常に同じ値になる */
function rowRatio(row: ExpenseRow): number {
  const jitter = (hash(`${row.timestamp}|${row.store}|${row.amount}`) % 41) / 100; // 0〜0.40
  return config.scale * (0.8 + jitter); // scale の ±20%
}

function scaleAmount(value: number, ratio: number): number {
  if (!Number.isFinite(value) || value <= 0) return value;
  return Math.max(10, Math.round((value * ratio) / 10) * 10);
}

/** カテゴリの照合キー。画面表示（空欄は '未設定'）と揃える */
export function catKey(category: string): string {
  return category || '未設定';
}

/**
 * 1 行を表示用に差し替える。
 * amount と countedAmount には同じ倍率を掛ける（一部計上の比率を壊さないため）。
 */
function maskRowWith(row: ExpenseRow, ratio: number): ExpenseRow {
  return {
    ...row,
    user:          maskUser(row.user),
    store:         config.maskStore ? maskStore(row.store) : row.store,
    memo:          config.hideMemo ? '' : row.memo,
    amount:        scaleAmount(row.amount, ratio),
    countedAmount: scaleAmount(row.countedAmount, ratio),
  };
}

/**
 * 1 シート分の行をまとめて表示用に差し替える。
 *
 * カテゴリ別の合計金額が指定されているカテゴリは、倍率ではなく
 * 「指定合計 ÷ 実合計」で比例配分する。行単位では丸め誤差が出るので、
 * 最後にカテゴリ内で一番大きい行に差を寄せて合計を指定値ぴったりに合わせる。
 */
export function maskRows(rows: ExpenseRow[]): ExpenseRow[] {
  const targets = config.categoryTotals;

  // 目標が指定されたカテゴリの実合計（除外行は集計に入れない）
  const actual = new Map<string, number>();
  for (const r of rows) {
    if (r.excluded) continue;
    const key = catKey(r.category);
    if (!(targets[key] > 0)) continue;
    actual.set(key, (actual.get(key) ?? 0) + r.countedAmount);
  }

  const out = rows.map((r) => {
    const key    = catKey(r.category);
    const target = targets[key];
    if (!(target > 0)) return maskRowWith(r, rowRatio(r));
    const act = actual.get(key) ?? 0;
    // 集計対象の行が無いカテゴリは配分できないのでそのまま
    return maskRowWith(r, act > 0 ? target / act : 1);
  });

  // 丸め誤差の吸収
  for (const [key, target] of Object.entries(targets)) {
    if (!(target > 0) || (actual.get(key) ?? 0) <= 0) continue;

    const idx: number[] = [];
    out.forEach((r, i) => {
      if (catKey(r.category) === key && !r.excluded) idx.push(i);
    });
    if (idx.length === 0) continue;

    const sum  = idx.reduce((s, i) => s + out[i].countedAmount, 0);
    const diff = Math.round(target) - sum;
    if (diff === 0) continue;

    let big = idx[0];
    for (const i of idx) if (out[i].countedAmount > out[big].countedAmount) big = i;

    const b = out[big];
    const nextCounted = Math.max(10, b.countedAmount + diff);
    out[big] = {
      ...b,
      countedAmount: nextCounted,
      // 一部計上でない行（amount === countedAmount）は表示金額も揃える
      amount: b.amount === b.countedAmount ? nextCounted : b.amount,
    };
  }

  return out;
}

// ─── 書き込みオーバーレイ（メモリのみ） ───────────────────────────────────────

/** デモ中に追加された行 */
let appended: ExpenseRow[] = [];
/** `${sheetName}:${rowIndex}` → 変更内容。デモ中の編集・削除を保持する */
const patches = new Map<string, Partial<ExpenseRow>>();
/** デモ中の追加行に振る仮の行番号（実在の行と衝突しないよう負値） */
let nextSyntheticIndex = -1;

function patchKey(sheetName: string, rowIndex: number): string {
  return `${sheetName}:${rowIndex}`;
}

export function clearOverlay(): void {
  appended = [];
  patches.clear();
  nextSyntheticIndex = -1;
}

/** デモ中の行追加。実データには書かない */
export function demoAppend(row: ExpenseRow, sheetName: string): void {
  appended.push({
    ...row,
    countedAmount: row.countedAmount > 0 ? row.countedAmount : row.amount,
    deleted:       false,
    sheetName,
    rowIndex:      nextSyntheticIndex--,
  });
}

/** デモ中の行更新。実データには書かない */
export function demoPatch(
  sheetName: string,
  rowIndex: number,
  patch: Partial<ExpenseRow>,
): void {
  const key  = patchKey(sheetName, rowIndex);
  const prev = patches.get(key) ?? {};
  patches.set(key, { ...prev, ...patch });
}

/**
 * 指定シートの行一覧にオーバーレイを適用する。
 * マスキング後の行に対して呼ぶこと（デモ中の編集値はマスク後の空間の値なので）。
 */
export function applyOverlay(sheetName: string, rows: ExpenseRow[]): ExpenseRow[] {
  const merged = [...rows, ...appended.filter((r) => r.sheetName === sheetName)];
  return merged
    .map((r) => {
      if (r.rowIndex === undefined) return r;
      const patch = patches.get(patchKey(sheetName, r.rowIndex));
      return patch ? { ...r, ...patch } : r;
    })
    .filter((r) => !r.deleted);
}
