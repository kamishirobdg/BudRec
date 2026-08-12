/**
 * 直近に登録した 1 バッチ（1 回の撮影・手入力で入れた行）を覚えておく。
 *
 * 一覧画面の「前回の登録」から、入れたばかりの行だけをまとめて見直せるようにするための記録。
 * 追加した時点ではシート上の行番号が分からないので、**行を特定するためのキー**だけを持ち、
 * 表示するときにシートから探し直す。
 *
 * 保存場所: `<documentDirectory>/last-batch.json`
 */

import { readJsonArray, removeFile, writeJson } from './jsonFileStore';
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

/** 直近に登録した行を記録する（前のバッチは上書きする） */
export function saveLastBatch(rows: ExpenseRow[]): void {
  const keys: LastBatchKey[] = rows.slice(0, MAX_KEYS).map((r) => ({
    sheetName: r.sheetName ?? sheetNameFromTimestamp(r.timestamp),
    timestamp: r.timestamp,
    store:     r.store,
    amount:    r.amount,
  }));
  // 記録できなくても登録自体は成功しているので、失敗しても投げない
  writeJson(FILE_NAME, keys);
}

/** 直近に登録した行のキー一覧（無ければ空配列） */
export function getLastBatch(): LastBatchKey[] {
  return readJsonArray<LastBatchKey>(FILE_NAME);
}

export function clearLastBatch(): void {
  removeFile(FILE_NAME);
}

/** シートから読んだ行が、記録したキーと同じものか */
export function matchesKey(row: ExpenseRow, key: LastBatchKey): boolean {
  return row.timestamp === key.timestamp
    && row.store === key.store
    && row.amount === key.amount;
}

/**
 * 記録したキーに対応する行を rows から拾う（キーの順序を保つ）。
 *
 * @param overlay 未送信の変更を重ねた行を返す関数。渡した場合は
 *   **シート上の値と、未送信を重ねた値のどちらで照合しても拾い、返すのは重ねたほう**になる。
 *   キーがどちらの値で記録されているかは経路によって違うため（一覧の編集モーダル経由の
 *   未送信はキーが古いまま、「前回の登録」経由の未送信はキーが新しくなっている）。
 */
export function pickBatchRows(
  rows: ExpenseRow[],
  keys: LastBatchKey[],
  overlay?: (row: ExpenseRow) => ExpenseRow,
): ExpenseRow[] {
  const used = new Set<string>();
  const found: ExpenseRow[] = [];

  for (const key of keys) {
    // 同じ内容の行が複数あっても 1 行ずつ対応させる
    const hit = rows.find((r) => {
      const id = `${r.sheetName ?? ''}:${r.rowIndex ?? ''}`;
      if (used.has(id)) return false;
      return matchesKey(r, key) || (overlay ? matchesKey(overlay(r), key) : false);
    });
    if (!hit) continue;
    used.add(`${hit.sheetName ?? ''}:${hit.rowIndex ?? ''}`);
    found.push(overlay ? overlay(hit) : hit);
  }
  return found;
}
