/**
 * `<documentDirectory>/*.json` への読み書きの共通処理。
 *
 * 未送信キュー・オフラインキャッシュ・「前回の登録」はいずれも
 * 「JSON を 1 ファイルに置き、壊れていたら諦めて空として扱う」という同じ形をしていて、
 * 各サービスに同じコードが写経されていた。片方だけ直して片方を直し忘れる事故を避けるため
 * ここにまとめる。
 *
 * SecureStore ではなくファイルを使うのは、大きな値を保存できないことがあるため。
 * **置くのは家計簿の明細だけで、認証情報は含めないこと。**
 */

import { File, Paths } from 'expo-file-system';

function fileFor(fileName: string): File {
  return new File(Paths.document, fileName);
}

/**
 * JSON 配列として読む。ファイルが無い・壊れている場合は空配列を返す（例外は投げない）。
 * 起動時に呼ばれるので、壊れたファイル 1 つでアプリが立ち上がらなくならないようにしている。
 */
export function readJsonArray<T>(fileName: string): T[] {
  try {
    const f = fileFor(fileName);
    if (!f.exists) return [];
    const parsed = JSON.parse(f.textSync());
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (e) {
    console.error(`[jsonFileStore] ${fileName} の読み込みに失敗。空として扱う:`, e);
    return [];
  }
}

/**
 * JSON として書く。失敗しても投げない（呼び出し元の処理自体は成功しているため）。
 */
export function writeJson(fileName: string, data: unknown): void {
  try {
    const f = fileFor(fileName);
    if (!f.exists) f.create({ overwrite: true });
    f.write(JSON.stringify(data));
  } catch (e) {
    console.error(`[jsonFileStore] ${fileName} の保存に失敗:`, e);
  }
}

/** 消す（無ければ何もしない）。失敗しても投げない */
export function removeFile(fileName: string): void {
  try {
    const f = fileFor(fileName);
    if (f.exists) f.delete();
  } catch (e) {
    console.error(`[jsonFileStore] ${fileName} の削除に失敗:`, e);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 'YYYY/MM/DD HH:MM:SS'。**表示用でパースはしない**
 * （Hermes ではこの形式を `new Date()` に渡すと NaN になる）。
 */
export function nowLabel(): string {
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
