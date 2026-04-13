/**
 * 同一支出が複数ソース（例: レシート撮影と Gmail 取り込み）から二重登録された
 * 可能性のある行を検出する。
 *
 * 判定:
 *  - amount が完全一致 (> 0)
 *  - timestamp の差が ±24h 以内
 *  - memo が「近似」: 共通トークン (length>=2) を持つ、または片方が空
 *
 * クラスタ内のいずれか1行でも excluded か confirmed なら、そのクラスタ全体の
 * 警告を解除する（重複ペアが解消されたとみなす）。
 */

import { ExpenseRow } from './SheetsService';

const TIMESTAMP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 時間

/**
 * 'YYYY/MM/DD HH:MM:SS' または 'YYYY-MM-DD HH:MM:SS' を Date に。
 * Hermes はスラッシュ区切りを new Date() でパースできず NaN を返すため、
 * 正規表現で直接フィールドを取り出してから Date を組み立てる。
 */
function parseTimestamp(s: string): Date | null {
  if (!s) return null;
  const m = s.match(
    /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/,
  );
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** memo を 2 文字以上のトークン集合に分解 */
function tokenize(memo: string): Set<string> {
  return new Set(
    memo
      .split(/[,:、 \t\n|]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2),
  );
}

/** 2 つの memo が「近似」かどうか */
function memoSimilar(a: string, b: string): boolean {
  if (!a || !b) return true; // 片方が空なら近似とみなす
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return true;
  for (const t of ta) {
    if (tb.has(t)) return true;
  }
  return false;
}

/** 行のユニークキー */
function rowKey(r: ExpenseRow): string {
  return `${r.sheetName ?? ''}:${r.rowIndex ?? ''}`;
}

/**
 * 警告対象の行のキー集合を返す。
 * 同じ amount のグループ内でペアを総当たり判定する。
 */
export function detectDuplicateWarnings(rows: ExpenseRow[]): Set<string> {
  // amount でグルーピング
  const byAmount = new Map<number, ExpenseRow[]>();
  for (const r of rows) {
    if (!r.amount || r.amount <= 0) continue;
    const list = byAmount.get(r.amount) ?? [];
    list.push(r);
    byAmount.set(r.amount, list);
  }

  // Union-Find っぽくクラスタリング
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let cur = k;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur);
      if (p === undefined) {
        parent.set(cur, cur);
        return cur;
      }
      cur = p;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of rows) parent.set(rowKey(r), rowKey(r));

  for (const group of byAmount.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const da = parseTimestamp(a.timestamp);
        const db = parseTimestamp(b.timestamp);
        if (!da || !db) continue;
        if (Math.abs(da.getTime() - db.getTime()) > TIMESTAMP_WINDOW_MS) continue;
        if (!memoSimilar(a.memo, b.memo)) continue;
        union(rowKey(a), rowKey(b));
      }
    }
  }

  // クラスタ集計
  const clusterRows = new Map<string, ExpenseRow[]>();
  for (const r of rows) {
    const root = find(rowKey(r));
    const arr = clusterRows.get(root) ?? [];
    arr.push(r);
    clusterRows.set(root, arr);
  }

  const warned = new Set<string>();
  for (const cluster of clusterRows.values()) {
    if (cluster.length < 2) continue;
    // クラスタ内のいずれかが excluded か confirmed なら警告解除
    const resolved = cluster.some((r) => r.excluded || r.confirmed);
    if (resolved) continue;
    for (const r of cluster) warned.add(rowKey(r));
  }
  return warned;
}
