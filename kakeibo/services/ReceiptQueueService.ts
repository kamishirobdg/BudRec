/**
 * レシート画像の一時保存キュー。
 *
 * 役割:
 *  - 撮影／ギャラリー選択した画像 (base64) をデバイスのドキュメントディレクトリに
 *    保存し、登録できたら削除する。
 *  - 画像ごとに状態（OCR 待ち・中止・失敗・確認待ち）と撮影時の代理相手を
 *    `receipt-meta.json` に持つ。アプリが終了されても次回起動時に続きから扱える。
 *
 * 保存場所: `<documentDirectory>/pending-receipts/`
 * ファイル名: `receipt-<timestamp>-<rand>.jpg`
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { ExpenseRow } from './SheetsService';
import { readJsonArray, writeJson } from './jsonFileStore';

const DIR_NAME  = 'pending-receipts';
const META_FILE = 'receipt-meta.json';

/**
 * - `queued`  … OCR 待ち。起動時にも自動で処理する
 * - `stopped` … 中止した。自動では処理しない
 * - `failed`  … OCR が 2 回失敗した。自動では処理しない
 * - `review`  … 2 件以上読めたので保存前の確認待ち（`rows` に読み取り結果）
 */
export type ReceiptStatus = 'queued' | 'stopped' | 'failed' | 'review';

interface ReceiptMeta {
  name:       string;
  status:     ReceiptStatus;
  /** 撮影時に代理入力中だった相手。後から代理入力を切り替えても撮影時の相手で記録する */
  proxyUser?: string;
  error?:     string;
  rows?:      ExpenseRow[];
}

export interface ReceiptItem extends ReceiptMeta {
  uri: string;
}

/** 保存用ディレクトリを取得（存在しなければ作成） */
function getDir(): Directory {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

/** ランダムファイル名を生成 */
function genFilename(): string {
  const ts   = Date.now();
  const rand = Math.floor(Math.random() * 1_000_000).toString(36);
  return `receipt-${ts}-${rand}.jpg`;
}

function nameOf(uri: string): string {
  return new File(uri).name;
}

function readMeta(): ReceiptMeta[] {
  return readJsonArray<ReceiptMeta>(META_FILE);
}

function writeMeta(list: ReceiptMeta[]): void {
  writeJson(META_FILE, list);
}

/**
 * base64 画像を新規ファイルとして保存し、絶対 URI (`file://...`) を返す。
 */
export function saveReceipt(base64: string, proxyUser?: string): string {
  const dir  = getDir();
  const file = new File(dir, genFilename());
  file.create({ overwrite: true });
  file.write(base64, { encoding: 'base64' });
  writeMeta([...readMeta(), { name: file.name, status: 'queued', proxyUser }]);
  return file.uri;
}

/** 保存済みファイルを base64 で読み出す */
export function readReceipt(uri: string): string {
  const file = new File(uri);
  if (!file.exists) {
    throw new Error(`ファイルが存在しません: ${uri}`);
  }
  return file.base64Sync();
}

/** 状態を書き換える。`rows` / `error` は渡さなければ消える */
export function setStatus(
  uri: string,
  status: ReceiptStatus,
  extra: { error?: string; rows?: ExpenseRow[] } = {},
): void {
  // 破棄済みの画像に状態だけ残さない
  if (!new File(uri).exists) return;
  const name = nameOf(uri);
  const list = readMeta();
  const prev = list.find((m) => m.name === name);
  const next: ReceiptMeta = { name, status, proxyUser: prev?.proxyUser, ...extra };
  writeMeta([...list.filter((m) => m.name !== name), next]);
}

/** 指定した状態の画像をまとめて別の状態にする（`except` の画像には触らない） */
export function moveAll(from: ReceiptStatus[], to: ReceiptStatus, except: string[] = []): void {
  for (const item of listItems()) {
    if (from.includes(item.status) && !except.includes(item.uri)) setStatus(item.uri, to);
  }
}

/** 保存済みファイルを削除（存在しなくてもエラーにしない） */
export function deleteReceipt(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // 握りつぶす（既に消えている等）
  }
  const name = nameOf(uri);
  writeMeta(readMeta().filter((m) => m.name !== name));
}

/** ディレクトリ内の全ファイルを削除 */
export function deleteAllReceipts(): void {
  const dir = getDir();
  for (const entry of dir.list()) {
    if (entry instanceof File) {
      try {
        entry.delete();
      } catch {
        // 無視
      }
    }
  }
  writeMeta([]);
}

/**
 * 画像と状態の一覧（撮影の古い順）。
 * 状態が記録されていない画像（この仕組みより前に残ったもの）は `stopped` として扱い、
 * 勝手に OCR し直さない。
 */
export function listItems(): ReceiptItem[] {
  const dir = getDir();
  const files: File[] = [];
  for (const entry of dir.list()) {
    if (entry instanceof File) files.push(entry);
  }
  // ファイル名にタイムスタンプが埋め込まれているので名前順 = 時系列順
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  const meta = new Map(readMeta().map((m) => [m.name, m]));
  return files.map((f) => ({
    ...(meta.get(f.name) ?? { name: f.name, status: 'stopped' as const }),
    uri: f.uri,
  }));
}
