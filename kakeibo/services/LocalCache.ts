/**
 * 画面の表示を待たせないための端末内の控え。前に読めた内容をすぐ出し、通信が終わったら差し替える。
 * 厳密に最新である必要の無い読み出し（食事の一覧・表示設定・サプリなど）に使う。書き込みには使わない。
 *
 * 保存場所: `<documentDirectory>/cache/<key>.json`（key ごとに 1 ファイル）
 */

import { Directory, File, Paths } from 'expo-file-system';

function fileFor(key: string): File {
  const dir = new Directory(Paths.document, 'cache');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${key.replace(/[^\w.-]/g, '_')}.json`);
}

/** 控えを読む（無い・壊れていれば null） */
export function readCache<T>(key: string): { value: T; savedAt: number } | null {
  try {
    const f = fileFor(key);
    if (!f.exists) return null;
    const parsed = JSON.parse(f.textSync());
    return parsed && typeof parsed === 'object' && 'value' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** 控えを書く（失敗しても投げない） */
export function writeCache<T>(key: string, value: T): void {
  try {
    const f = fileFor(key);
    if (!f.exists) f.create({ overwrite: true });
    f.write(JSON.stringify({ value, savedAt: Date.now() }));
  } catch (e) {
    console.warn('[LocalCache] 控えを書けなかった:', key, e instanceof Error ? e.message : e);
  }
}

/** 全部消す（サインアウト時） */
export function clearCache(): void {
  try {
    const dir = new Directory(Paths.document, 'cache');
    if (dir.exists) dir.delete();
  } catch {
    // 消せなくても次の書き込みで上書きされる
  }
}

/**
 * 控えをすぐ返し（あれば onCached に渡す）、通信で読み直したら控えを更新して返す。
 * 読み直しに失敗したら、控えがあればそれを返す（無ければ投げる）。
 */
export async function cachedLoad<T>(key: string, load: () => Promise<T>, onCached?: (value: T) => void): Promise<T> {
  const cached = readCache<T>(key);
  if (cached && onCached) onCached(cached.value);
  try {
    const fresh = await load();
    writeCache(key, fresh);
    return fresh;
  } catch (e) {
    if (cached) return cached.value;
    throw e;
  }
}
