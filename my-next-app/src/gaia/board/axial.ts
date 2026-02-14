// src/gaia/board/axial.ts
export type Axial = { q: number; r: number };

export const AXIAL_DIRS: ReadonlyArray<Axial> = Object.freeze([
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]);

export function keyOf(q: number, r: number): string {
  return `${q},${r}`;
}

export function add(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

/**
 * Axial distance (hex grid). Uses cube conversion: (x=q, z=r, y=-x-z)
 */
export function axialDistance(a: Axial, b: Axial): number {
  const x1 = a.q;
  const z1 = a.r;
  const y1 = -x1 - z1;

  const x2 = b.q;
  const z2 = b.r;
  const y2 = -x2 - z2;

  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
}
