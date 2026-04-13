/**
 * レシート画像の一時保存キュー。
 *
 * 役割:
 *  - 撮影／ギャラリー選択した画像 (base64) をデバイスのドキュメントディレクトリに
 *    保存し、OCR 処理に成功したら削除する。
 *  - OCR が失敗してアプリが kill された場合でも次回起動時に未処理ファイルを
 *    拾い上げて再処理／手動入力／破棄を選べるようにする。
 *
 * 保存場所: `<documentDirectory>/pending-receipts/`
 * ファイル名: `receipt-<timestamp>-<rand>.jpg`
 */

import { Directory, File, Paths } from 'expo-file-system';

const DIR_NAME = 'pending-receipts';

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

/**
 * base64 画像を新規ファイルとして保存し、絶対 URI (`file://...`) を返す。
 */
export function saveReceipt(base64: string): string {
  const dir  = getDir();
  const file = new File(dir, genFilename());
  file.create({ overwrite: true });
  file.write(base64, { encoding: 'base64' });
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

/** 保存済みファイルを削除（存在しなくてもエラーにしない） */
export function deleteReceipt(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // 握りつぶす（既に消えている等）
  }
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
}

/** 未処理ファイルの URI 一覧を返す（作成日時の古い順） */
export function listPendingReceipts(): string[] {
  const dir = getDir();
  const files: File[] = [];
  for (const entry of dir.list()) {
    if (entry instanceof File) files.push(entry);
  }
  // ファイル名にタイムスタンプが埋め込まれているので名前順 = 時系列順
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  return files.map((f) => f.uri);
}
