// src/gaia/hex.ts
// Axial distance on hex grid.
export function axialDistance(q1: number, r1: number, q2: number, r2: number): number {
  const dq = q2 - q1;
  const dr = r2 - r1;
  const ds = (q2 + r2) - (q1 + r1);
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}
