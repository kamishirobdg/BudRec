/**
 * 登録済みのレシート写真を端末内に残す。
 *
 * 保存先: `<documentDirectory>/photos/receipts/`
 * 対応表: `<documentDirectory>/photo-index.json`（支出行の entry_id → 写真の参照）
 *
 * 写真はこの端末にしか無いので、参照は共有シートではなく端末内の対応表に持つ。
 * 参照は `local:<documentDirectory からの相対パス>` の形にしてあり、Google Drive に置く
 * 写真（`drive:<fileId>`）を後から足せる（docs/meal-nutrition-spec.md §3.5）。
 */

import { Directory, File, Paths } from 'expo-file-system';
import { readJsonArray, writeJson } from './jsonFileStore';

const INDEX_FILE  = 'photo-index.json';
const RECEIPT_DIR = ['photos', 'receipts'] as const;
const MEAL_DIR    = ['photos', 'meals'] as const;

interface PhotoIndexEntry {
  entryId: string;
  ref:     string;
}

function receiptDir(): Directory {
  const dir = new Directory(Paths.document, ...RECEIPT_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * OCR 待ちのフォルダにある画像を保存先へ移し、支出行とひも付ける。
 * 1 枚に複数のレシートが写っていた場合は、全部の行を同じ写真にひも付ける。
 * 失敗しても投げない（登録自体は済んでいるので、写真が残らないだけにする）。
 */
export function archiveReceiptPhoto(uri: string, entryIds: string[]): void {
  if (entryIds.length === 0) return;
  try {
    const src = new File(uri);
    if (!src.exists) return;
    const dir = receiptDir();
    src.move(dir);
    const ref = `local:${RECEIPT_DIR.join('/')}/${src.name}`;
    const index = readJsonArray<PhotoIndexEntry>(INDEX_FILE)
      .filter((e) => !entryIds.includes(e.entryId));
    writeJson(INDEX_FILE, [...index, ...entryIds.map((entryId) => ({ entryId, ref }))]);
  } catch (e) {
    console.warn('[PhotoStore] レシート写真を残せなかった:', e instanceof Error ? e.message : e);
  }
}

/** 支出行にひも付いた写真の参照（この端末に無ければ null） */
export function receiptPhotoRef(entryId: string | undefined): string | null {
  if (!entryId) return null;
  return readJsonArray<PhotoIndexEntry>(INDEX_FILE).find((e) => e.entryId === entryId)?.ref ?? null;
}

/** 支出行にひも付いた写真の URI（この端末に無ければ null） */
export function receiptPhotoUri(entryId: string | undefined): string | null {
  return localUri(receiptPhotoRef(entryId));
}

/**
 * 食事の写真を OCR 待ちのフォルダから保存先へ移し、参照（`local:...`）を返す。
 * 失敗したら null（記録は写真なしで続ける）。
 */
export function archiveMealPhoto(uri: string, keepOriginal = false): string | null {
  try {
    const src = new File(uri);
    if (!src.exists) return null;
    const dir = new Directory(Paths.document, ...MEAL_DIR);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const name = src.name;
    if (keepOriginal) src.copy(dir);
    else src.move(dir);
    return `local:${MEAL_DIR.join('/')}/${name}`;
  } catch (e) {
    console.warn('[PhotoStore] 食事の写真を残せなかった:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** `local:` の参照を、この端末のファイル URI にする（無ければ null） */
export function localUri(ref: string | null | undefined): string | null {
  if (!ref?.startsWith('local:')) return null;
  try {
    const file = new File(Paths.document, ...ref.slice('local:'.length).split('/'));
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}
