// src/gaia/logicalMap/geom.ts

export type Axial = { q: number; r: number };
export type Cube = { x: number; y: number; z: number };

export const AXIAL_DIRS: readonly Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
] as const;

export function keyOf(a: Axial): string {
  return `${a.q},${a.r}`;
}

export function add(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function sub(a: Axial, b: Axial): Axial {
  return { q: a.q - b.q, r: a.r - b.r };
}

export function axialToCube(a: Axial): Cube {
  const x = a.q;
  const z = a.r;
  const y = -x - z;
  return { x, y, z };
}

export function cubeToAxial(c: Cube): Axial {
  return { q: c.x, r: c.z };
}

export function cubeRound(c: { x: number; y: number; z: number }): Cube {
  let rx = Math.round(c.x);
  let ry = Math.round(c.y);
  let rz = Math.round(c.z);

  const xDiff = Math.abs(rx - c.x);
  const yDiff = Math.abs(ry - c.y);
  const zDiff = Math.abs(rz - c.z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return { x: rx, y: ry, z: rz };
}

export function rotate60CW(a: Axial, stepsCW: number): Axial {
  // Cube CW: (x,y,z) -> (-z, -x, -y)
  const s = ((stepsCW % 6) + 6) % 6;
  let c = axialToCube(a);
  for (let i = 0; i < s; i++) {
    c = { x: -c.z, y: -c.x, z: -c.y };
  }
  return cubeToAxial(c);
}
