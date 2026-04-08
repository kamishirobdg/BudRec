import * as SheetsService from './SheetsService';

/**
 * カテゴリのローカルキャッシュ層。
 * Source of Truth は Google Sheets の _settings シート。
 * 起動中は同一プロセスのメモリにキャッシュし、API 呼び出しを減らす。
 */

let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

/**
 * 最新のカテゴリ一覧を取得。
 * キャッシュがあればそれを返し、無ければスプレッドシートから取得。
 */
export async function getCategories(): Promise<string[]> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = SheetsService.getCategories()
    .then((list) => {
      cache = list;
      return list;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** スプレッドシートを再取得しキャッシュを更新 */
export async function refresh(): Promise<string[]> {
  cache = null;
  return getCategories();
}

/** カテゴリを追加してキャッシュを更新 */
export async function addCategory(name: string): Promise<void> {
  await SheetsService.addCategory(name);
  await refresh();
}

/** カテゴリを削除してキャッシュを更新 */
export async function removeCategory(name: string): Promise<void> {
  await SheetsService.removeCategory(name);
  await refresh();
}
