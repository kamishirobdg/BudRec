import type { Axial } from "./sectorTypes";

export function axialKey(p: Axial): string {
  return `${p.q},${p.r}`;
}

/**
 * 3,4,5,4,3 形（合計19セル）をAxial(q,r)で生成します。
 *
 * pointy-top axial を想定し、行（上→下）を r = -2..2 として扱います。
 * 各行のセル数は:
 *   r=-2: 3
 *   r=-1: 4
 *   r= 0: 5
 *   r= 1: 4
 *   r= 2: 3
 *
 * それぞれ q の範囲は中央寄せで:
 *   r=-2: q=-1..1
 *   r=-1: q=-2..1
 *   r= 0: q=-2..2
 *   r= 1: q=-2..1
 *   r= 2: q=-1..1
 *
 * ※この形は「radius=2の六角形(19セル)」と近いですが、
 *   あなたの説明に合わせて“行の取り方”を固定しています。
 */
export function coordsSector34543(): Axial[] {
  const rows: Array<{ r: number; qMin: number; qMax: number }> = [
    { r: -2, qMin: -1, qMax: 1 }, // 3
    { r: -1, qMin: -2, qMax: 1 }, // 4
    { r: 0, qMin: -2, qMax: 2 },  // 5
    { r: 1, qMin: -2, qMax: 1 },  // 4
    { r: 2, qMin: -1, qMax: 1 },  // 3
  ];

  const out: Axial[] = [];
  for (const row of rows) {
    for (let q = row.qMin; q <= row.qMax; q++) {
      out.push({ q, r: row.r });
    }
  }
  return out;
}

/**
 * hex距離（Axial）: (|dq|+|dr|+|ds|)/2
 */
export function axialDist(a: Axial, b: Axial): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -(a.q + a.r) - (-(b.q + b.r));
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}
