/**
 * 直近に登録した 1 バッチ（1 回の撮影・手入力で入れた行）を覚えておく。
 *
 * 一覧画面の「前回の登録」から、入れたばかりの行だけをまとめて見直せるようにするための記録。
 * 追加した時点ではシート上の行番号が分からないので、**行を特定するためのキー**だけを持ち、
 * 表示するときにシートから探し直す。
 *
 * 保存場所: `<documentDirectory>/last-batch.json`
 */

import { File, Paths } from 'expo-file-system';
import { sheetNameFromTimestamp, type ExpenseRow } from './SheetsService';

/** シート上の行を特定するためのキー */
export interface LastBatchKey {
  sheetName: string;
  timestamp: string;
  store:     string;
  amount:    number;
}

const FILE_NAME = 'last-batch.json';

/** 1 バッチで覚えておく上限。これを超える枚数を 1 回で入れることは想定しない */
const MAX_KEYS = 30;

function batchFile(): File {
  return new File(Paths.document, FILE_NAME);
}

/** 直近に登録した行を記録する（前のバッチは上書きする） */
export function saveLastBatch(rows: ExpenseRow[]): void {
  const keys: LastBatchKey[] = rows.slice(0, MAX_KEYS).map((r) => ({
    sheetName: r.sheetName ?? sheetNameFromTimestamp(r.timestamp),
    timestamp: r.timestamp,
    store:     r.store,
    amount:    r.amount,
  }));

  try {
    const f = batchFile();
    if (!f.exists) f.create({ overwrite: true });
    f.write(JSON.stringify(keys));
  } catch (e) {
    // 記録できなくても登録自体は成功しているので握りつぶす
    console.error('[LastBatch] 保存失敗:', e);
  }
}

/** 直近に登録した行のキー一覧（無ければ空配列） */
export function getLastBatch(): LastBatchKey[] {
  try {
    const f = batchFile();
    if (!f.exists) return [];
    const parsed = JSON.parse(f.textSync());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[LastBatch] 読み込み失敗:', e);
    return [];
  }
}

export function clearLastBatch(): void {
  try {
    const f = batchFile();
    if (f.exists) f.delete();
  } catch {
    // ignore
  }
}

/** シートから読んだ行が、記録したキーと同じものか */
export function matchesKey(row: ExpenseRow, key: LastBatchKey): boolean {
  return row.timestamp === key.timestamp
    && row.store === key.store
    && row.amount === key.amount;
}

/** 記録したキーに対応する行を rows から拾う（キーの順序を保つ） */
export function pickBatchRows(rows: ExpenseRow[], keys: LastBatchKey[]): ExpenseRow[] {
  const used = new Set<string>();
  const found: ExpenseRow[] = [];

  for (const key of keys) {
    // 同じ内容の行が複数あっても 1 行ずつ対応させる
    const hit = rows.find((r) => {
      const id = `${r.sheetName ?? ''}:${r.rowIndex ?? ''}`;
      return !used.has(id) && matchesKey(r, key);
    });
    if (!hit) continue;
    used.add(`${hit.sheetName ?? ''}:${hit.rowIndex ?? ''}`);
    found.push(hit);
  }
  return found;
}
