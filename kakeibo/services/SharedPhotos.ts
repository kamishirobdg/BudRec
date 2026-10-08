/**
 * 二人でした食事の写真と、それにひも付くレシートの写真を、スプレッドシートの共有用シートに
 * 一時的に置いて相手の端末からも見られるようにする。仕様は docs/meal-nutrition-spec.md §3.5.1。
 *
 * - Sheets API には画像を貼る操作が無いので、縮小した JPEG を base64 にしてセルに入れる。
 *   **1 セル 5 万文字の上限**があるので 4 万文字ずつ横に分ける。
 * - 共有用シートは非表示にする（ブラウザで開いても文字の羅列が目に入らない）。
 * - 撮った本人の端末では元の写真を見る。ここに置くのは相手のための縮小版だけ。
 * - 消すタイミング: どちらかの端末で食事を保存してから 7 日、または共有から 14 日の早い方。
 *   行は削除せず値を空にする（行番号をずらさない。二人が同時に消しても別の行を消さない）。
 *   空にした行は次の共有で使い回す（追記を OVERWRITE にしている）。
 */

import { File, Directory, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { SheetsInternal, newEntryId } from './SheetsService';
import { localUri, receiptPhotoRef } from './PhotoStore';
import { isMealShared } from './MealService';
import type { MealRow } from './MealService';
import * as Demo from './DemoService';

const SHEET = '_shared_photos';
const HEADER = ['photo_id', 'meal_id', 'entry_id', 'kind', 'shared_by', 'shared_at', 'settled_at', 'chunk_count', 'source_ref'];
const INDEX_RANGE = 'A:I';
const CHUNK_SIZE = 40_000;
const MAX_CHUNKS = 25;
/** 目録 9 列 ＋ チャンク 25 列 */
const COLUMN_COUNT = 9 + MAX_CHUNKS;
/** 1 行ぶん（目録 A:I ＋ チャンク J 列から 25 列） */
const ROW_RANGE = (row: number) => `A${row}:AH${row}`;

const SETTLED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHARED_TTL_MS  = 14 * 24 * 60 * 60 * 1000;

const CACHE_DIR = ['photos', 'shared'] as const;

export interface SharedPhoto {
  photoId:   string;
  mealId:    string;
  entryId:   string;
  kind:      'meal' | 'receipt';
  sharedBy:  string;
  sharedAt:  number;
  settledAt: number | null;
  chunks:    number;
  sourceRef: string;
  rowIndex:  number;
}

// ─── 目録 ─────────────────────────────────────────────────────────────────────

async function ensureSheet(): Promise<void> {
  const client = await SheetsInternal.createClient();
  if (!(await SheetsInternal.ensureSheet(client, SHEET))) return;
  await SheetsInternal.writeHeaderRow(client, SHEET, HEADER);
  const sheetId = await SheetsInternal.fetchSheetId(client, SHEET);
  if (sheetId === null) return;
  // 新しいシートは既定で 26 列（A〜Z）しか無い。チャンクを置く AH 列まで広げておかないと、
  // 範囲を AH まで指定した読み出し・消去が「グリッドの範囲外」で失敗する
  await client.post(':batchUpdate', {
    requests: [{
      updateSheetProperties: {
        properties: { sheetId, hidden: true, gridProperties: { columnCount: COLUMN_COUNT } },
        fields: 'hidden,gridProperties.columnCount',
      },
    }],
  });
}

/** 共有中の写真の一覧（画像本体は読まない） */
export async function listShared(): Promise<SharedPhoto[]> {
  if (await Demo.isDemo()) return [];
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  if (!names.includes(SHEET)) return [];
  // 日時はエポックミリ秒の数値で入れている。既定の表示形式で読むと指数表記に丸められうるので生の値で読む
  const res = await client.get(`/values/${encodeURIComponent(SHEET)}!${INDEX_RANGE}`, {
    params: { valueRenderOption: 'UNFORMATTED_VALUE' },
  });
  const values: string[][] = res.data.values ?? [];
  const out: SharedPhoto[] = [];
  values.forEach((c, i) => {
    if (i === 0 || !c[0]) return;
    out.push({
      photoId:   c[0],
      mealId:    c[1] ?? '',
      entryId:   c[2] ?? '',
      kind:      c[3] === 'receipt' ? 'receipt' : 'meal',
      sharedBy:  c[4] ?? '',
      sharedAt:  Number(c[5]) || 0,
      settledAt: c[6] ? Number(c[6]) || null : null,
      chunks:    Number(c[7]) || 0,
      sourceRef: c[8] ?? '',
      rowIndex:  i + 1,
    });
  });
  return out;
}

// ─── 共有する ─────────────────────────────────────────────────────────────────

/** 相手に見せる縮小版を作る。圧縮しすぎると見にくいので、種類ごとに大きさを変える */
async function compress(uri: string, kind: 'meal' | 'receipt'): Promise<string> {
  const probe = await manipulateAsync(uri, [], {});
  const resize =
    kind === 'receipt'
      // レシートは縦に長いので横幅で揃える（長辺で揃えると文字が潰れる）
      ? { width: Math.min(1000, probe.width) }
      : probe.width >= probe.height
        ? { width: Math.min(1600, probe.width) }
        : { height: Math.min(1600, probe.height) };
  for (const quality of [0.75, 0.6, 0.45]) {
    const out = await manipulateAsync(uri, [{ resize }], { compress: quality, format: SaveFormat.JPEG, base64: true });
    if (out.base64 && out.base64.length <= CHUNK_SIZE * MAX_CHUNKS) return out.base64;
  }
  throw new Error('写真が大きすぎて共有できませんでした');
}

async function upload(p: {
  localRef: string; kind: 'meal' | 'receipt'; mealId: string; entryId: string; sharedBy: string;
}): Promise<void> {
  const uri = localUri(p.localRef);
  if (!uri) return;
  const base64 = await compress(uri, p.kind);
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) chunks.push(base64.slice(i, i + CHUNK_SIZE));

  await ensureSheet();
  const client = await SheetsInternal.createClient();
  await client.post(
    `/values/${encodeURIComponent(SHEET)}!A:AH:append`,
    { values: [[newEntryId(), p.mealId, p.entryId, p.kind, p.sharedBy, Date.now(), '', chunks.length, p.localRef, ...chunks]] },
    // INSERT_ROWS だと、空にした行がある位置に差し込まれて下の行の行番号がずれる。
    // OVERWRITE なら表の直後の空行（空にした行）を使い回すので、ほかの行は動かない
    { params: { valueInputOption: 'RAW', insertDataOption: 'OVERWRITE' } },
  );
}

/**
 * 二人にまたがる食事なら、この端末にある写真（食事・ひも付くレシート）を共有用シートに置く。
 * 既に置いたものは置き直さない。失敗しても投げない（記録は済んでいる）。
 */
export async function ensureMealShared(rows: MealRow[], sharedBy: string): Promise<void> {
  try {
    if (rows.length === 0 || (await Demo.isDemo())) return;
    // 共有する食事（二人で食べた・編集画面で共有にした）だけ相手に写真を見せる
    if (!isMealShared(rows.filter((r) => !r.deleted))) return;
    const mealId = rows[0].mealId;
    const shared = await listShared();
    const already = new Set(shared.filter((s) => s.mealId === mealId).map((s) => s.sourceRef));

    const mealRefs = [...new Set(rows.flatMap((r) => r.photoRefs))].filter((r) => r.startsWith('local:'));
    for (const ref of mealRefs) {
      if (already.has(ref) || !localUri(ref)) continue;
      await upload({ localRef: ref, kind: 'meal', mealId, entryId: '', sharedBy });
    }
    for (const entryId of new Set(rows.map((r) => r.entryId).filter(Boolean))) {
      const ref = receiptPhotoRef(entryId);
      if (!ref || already.has(ref) || !localUri(ref)) continue;
      await upload({ localRef: ref, kind: 'receipt', mealId, entryId, sharedBy });
    }
  } catch (e) {
    console.warn('[SharedPhotos] 共有できなかった:', e instanceof Error ? e.message : e);
  }
}

// ─── 見る ─────────────────────────────────────────────────────────────────────

function cacheFile(photoId: string): File {
  const dir = new Directory(Paths.document, ...CACHE_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${photoId}.jpg`);
}

/** 端末に保存済みなら、その URI（共有用シートから消えた後も見られる） */
export function cachedUri(photoId: string): string | null {
  const f = cacheFile(photoId);
  return f.exists ? f.uri : null;
}

/** 共有用シートから読み出して端末に保存し、URI を返す */
export async function fetchShared(photo: SharedPhoto): Promise<string | null> {
  const cached = cachedUri(photo.photoId);
  if (cached) return cached;
  const client = await SheetsInternal.createClient();
  const res = await client.get(`/values/${encodeURIComponent(SHEET)}!${ROW_RANGE(photo.rowIndex)}`);
  const row: string[] = res.data.values?.[0] ?? [];
  // 一覧を読んでから今までの間に、期限切れで消された・別の写真に使い回された場合
  if (row[0] !== photo.photoId) return null;
  const base64 = row.slice(9, 9 + photo.chunks).join('');
  const f = cacheFile(photo.photoId);
  f.create({ overwrite: true });
  f.write(base64, { encoding: 'base64' });
  return f.uri;
}

// ─── 片付け ───────────────────────────────────────────────────────────────────

/** 食事を保存したとき（変更なしの「確定」も含む）に呼ぶ。消すまでの 7 日はここから数える */
export async function markSettled(mealId: string): Promise<void> {
  try {
    const shared = (await listShared()).filter((s) => s.mealId === mealId);
    if (shared.length === 0) return;
    const now = Date.now();
    const client = await SheetsInternal.createClient();
    await client.post('/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: shared.map((s) => ({ range: `'${SHEET}'!G${s.rowIndex}`, values: [[now]] })),
    });
  } catch (e) {
    console.warn('[SharedPhotos] 確定日時を書けなかった:', e instanceof Error ? e.message : e);
  }
}

/** 期限を過ぎた共有写真を消す。アプリを開いたときに呼ぶ。失敗しても投げない */
export async function cleanupExpired(): Promise<void> {
  try {
    const now = Date.now();
    const expired = (await listShared()).filter((s) =>
      (s.settledAt !== null && now - s.settledAt > SETTLED_TTL_MS) || now - s.sharedAt > SHARED_TTL_MS);
    if (expired.length === 0) return;
    const client = await SheetsInternal.createClient();
    await client.post('/values:batchClear', {
      ranges: expired.map((s) => `'${SHEET}'!${ROW_RANGE(s.rowIndex)}`),
    });
  } catch (e) {
    console.warn('[SharedPhotos] 期限切れの写真を消せなかった:', e instanceof Error ? e.message : e);
  }
}
