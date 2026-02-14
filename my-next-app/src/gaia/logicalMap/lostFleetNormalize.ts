// src/gaia/logicalMap/lostFleetNormalize.ts
//
// Lost Fleet (middle) tiles are "non-hex" shapes. We normalize their local coordinates by:
// 1) Split into connected components under axial 6-neighborhood.
// 2) Compute each component center (cube-average -> cubeRound).
// 3) Compute the centroid of component centers (cube-average -> cubeRound).
// 4) Shift all local cells so that this centroid becomes (0,0).
//
// Notes:
// - If components count is neither 1 nor 3, we THROW (strict mode).
// - This matches the "centroid is the origin" requirement while tolerating current data where
//   a tile may be a single triangle component (3 cells) rather than 3 separated clusters.

import { AXIAL_DIRS, add, axialToCube, cubeRound, cubeToAxial, keyOf, sub, type Axial } from "./geom";

export type NormalizeLfArgs = {
  localCells: Axial[]; // axial coords as-authored in sectorTiles_lostfleet
  strictComponents?: boolean; // default true
};

function connectedComponents(points: Axial[]): Axial[][] {
  const set = new Map<string, Axial>();
  for (const p of points) set.set(keyOf(p), p);

  const seen = new Set<string>();
  const comps: Axial[][] = [];

  for (const p of points) {
    const k = keyOf(p);
    if (seen.has(k)) continue;

    const q: Axial[] = [p];
    seen.add(k);

    const comp: Axial[] = [];
    while (q.length) {
      const cur = q.pop()!;
      comp.push(cur);

      for (const d of AXIAL_DIRS) {
        const nb = add(cur, d);
        const nk = keyOf(nb);
        if (seen.has(nk)) continue;
        if (!set.has(nk)) continue;
        seen.add(nk);
        q.push(set.get(nk)!);
      }
    }
    comps.push(comp);
  }

  return comps;
}

function centroidAxial(points: Axial[]): Axial {
  if (points.length === 0) return { q: 0, r: 0 };
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const p of points) {
    const c = axialToCube(p);
    sx += c.x;
    sy += c.y;
    sz += c.z;
  }
  const n = points.length;
  const rounded = cubeRound({ x: sx / n, y: sy / n, z: sz / n });
  return cubeToAxial(rounded);
}

export function normalizeLostFleetLocal({ localCells, strictComponents = true }: NormalizeLfArgs): {
  shift: Axial;
  normalized: Axial[];
  componentCount: number;
} {
  const comps = connectedComponents(localCells);
  const cnt = comps.length;

  if (strictComponents && cnt !== 1 && cnt !== 3) {
    throw new Error(`LostFleet tile component count must be 1 or 3, got ${cnt}`);
  }

  const compCenters = comps.map((c) => centroidAxial(c));
  const shift = centroidAxial(compCenters);
  const normalized = localCells.map((p) => sub(p, shift));

  return { shift, normalized, componentCount: cnt };
}
