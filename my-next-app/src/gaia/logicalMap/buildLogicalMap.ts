// src/gaia/logicalMap/buildLogicalMap.ts
//
// LogicalMap generator (decoupled from rendering):
// - SSOT: placement(slotId, sectorId, rot)
// - buildLogicalMapFromPlacement is the primary path
//
// NOTE:
// - seed -> placement の生成固定値は ssot/searchPlacementConfig.ts に集約（将来 4p / base 拡張を容易にする）
//

import type { SlotPlacement } from "../board/types";

import { BASE_SECTORS } from "../sectorTiles_base";
import {
  EXPANSION_MIDDLE,
  EXPANSION_LITTLE,
  EXPANSION_SCOUT,
} from "../sectorTiles_lostfleet";

import {
  SLOT_CENTERS_3P_LOSTFLEET,
  MIDDLE_SLOT_OFFSET_BY_ROT_SEED,
} from "../templates/3p_lostfleet_slotCenters";

import { makeSearchPlacementFromSeed } from "../ssot/searchPlacementConfig";

import { computePlacementHash } from "../ssot/placementHash";

export type Axial = { q: number; r: number };

export type LogicalCell = {
  pos: Axial;
  kind: "planet" | "space" | "special";
  planetType?: string;
  tags: string[];

  slotId: string;
  sectorId: string;

  /**
   * rot used for LogicalMap geometry/drawing.
   * - Middle: custom mapping (r0->1, r1->0, r2->5, r3->4, r4->3, r5->2)
   * - Non-middle: keep existing mapping
   */
  rot: number; // 0..5

  /** seed-provided rot (SSOT; placementFromSeed output) */
  rotSeed: number;

  localKey: string;
  isLostFleet: boolean;
};

export type CollisionRecord = {
  key: string; // "q,r"
  pos: Axial;

  a: { slotId: string; sectorId: string; rot: number; rotSeed: number; localKey: string; slotCenter: Axial };
  b: { slotId: string; sectorId: string; rot: number; rotSeed: number; localKey: string; slotCenter: Axial };
};

export type LogicalMap = {
  templateId: string;
  seed?: number;
  placement: SlotPlacement[];
  placementHash: string;
  cellsByKey: Map<string, LogicalCell>;
  bounds: { minQ: number; maxQ: number; minR: number; maxR: number };

  collisions: CollisionRecord[];
  collisionCount: number;
  collisionsBySlot: Record<string, number>;
};

const AXIAL_DIRS: Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

const ALLOW_LF_SINGLE_COMPONENT = true;

function keyOf(p: Axial) {
  return `${p.q},${p.r}`;
}
function axialAdd(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}
function axialSub(a: Axial, b: Axial): Axial {
  return { q: a.q - b.q, r: a.r - b.r };
}
function parseKey(k: string): Axial {
  const [q, r] = k.split(",").map((v) => Number(v));
  return { q, r };
}

// cube helpers
type Cube = { x: number; y: number; z: number };
function axialToCube(a: Axial): Cube {
  const x = a.q;
  const z = a.r;
  const y = -x - z;
  return { x, y, z };
}
function cubeToAxial(c: Cube): Axial {
  return { q: c.x, r: c.z };
}
function cubeRound(c: { x: number; y: number; z: number }): Cube {
  let rx = Math.round(c.x);
  let ry = Math.round(c.y);
  let rz = Math.round(c.z);

  const dx = Math.abs(rx - c.x);
  const dy = Math.abs(ry - c.y);
  const dz = Math.abs(rz - c.z);

  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;

  return { x: rx, y: ry, z: rz };
}
function meanCubes(cs: Cube[]): Cube {
  const n = cs.length || 1;
  let sx = 0, sy = 0, sz = 0;
  for (const c of cs) { sx += c.x; sy += c.y; sz += c.z; }
  return { x: sx / n, y: sy / n, z: sz / n };
}

/** Rotate axial(q,r) by 60° steps (CW) */
function rotate60(ax: Axial, stepsCW: number): Axial {
  let q = ax.q;
  let r = ax.r;
  const s = ((stepsCW % 6) + 6) % 6;

  for (let i = 0; i < s; i++) {
    const x = q;
    const z = r;
    const y = -x - z;

    // cube CW: (x,y,z) -> (-z, -x, -y)
    const nx = -z;
    const ny = -x;
    const nz = -y;

    q = nx;
    r = nz;
  }
  return { q, r };
}

function normalizeRawCell(raw: any): { kind: "planet" | "space" | "special"; planetType?: string; tags: string[] } {
  const tags = Array.isArray(raw?.tags) ? raw.tags : [];
  if (raw?.kind === "planet") {
    const pt = (raw?.planetType ?? raw?.planet) as string | undefined;
    return { kind: "planet", planetType: pt, tags };
  }
  if (raw?.kind === "special") return { kind: "special", tags };
  return { kind: "space", tags };
}

/** Extract local cells from a sector definition (object-map only) */
function extractLocalCells(sectorDef: any): Array<{ local: Axial; rawCell: any; localKey: string }> {
  const out: Array<{ local: Axial; rawCell: any; localKey: string }> = [];
  if (sectorDef?.cells && !Array.isArray(sectorDef.cells)) {
    for (const [k, rawCell] of Object.entries(sectorDef.cells as Record<string, any>)) {
      out.push({ local: parseKey(k), rawCell, localKey: k });
    }
  }
  return out;
}

/** Connected components on axial grid */
function connectedComponents(points: Axial[]): Axial[][] {
  const set = new Map<string, Axial>();
  for (const p of points) set.set(keyOf(p), p);

  const seen = new Set<string>();
  const comps: Axial[][] = [];

  for (const p of points) {
    const k0 = keyOf(p);
    if (seen.has(k0)) continue;

    const stack: Axial[] = [p];
    seen.add(k0);
    const comp: Axial[] = [];

    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const d of AXIAL_DIRS) {
        const nb = axialAdd(cur, d);
        const kn = keyOf(nb);
        if (seen.has(kn)) continue;
        if (!set.has(kn)) continue;
        seen.add(kn);
        stack.push(set.get(kn)!);
      }
    }

    comps.push(comp);
  }

  return comps;
}

/**
 * LostFleet normalization:
 * - find connected components (must be exactly 3; or 1 allowed temporarily)
 * - each component centroid (cube mean -> round)
 * - centroid of those centroids is origin shift
 * - subtract shift from all locals
 */
function normalizeLostFleetLocalCoords(locals: Axial[]): { normalized: Axial[]; originShift: Axial; compCount: number } {
  const comps = connectedComponents(locals);

  if (comps.length !== 3) {
    if (!(ALLOW_LF_SINGLE_COMPONENT && comps.length === 1)) {
      throw new Error(`LostFleet tile: expected 3 connected components, got ${comps.length}`);
    }
  }

  const compCenters: Axial[] = comps.map((comp) => {
    const mean = meanCubes(comp.map(axialToCube));
    return cubeToAxial(cubeRound(mean));
  });

  const originShift = cubeToAxial(cubeRound(meanCubes(compCenters.map(axialToCube))));
  const normalized = locals.map((p) => axialSub(p, originShift));
  return { normalized, originShift, compCount: comps.length };
}

/** Sector lookup: id -> sectorDef, and whether LF */
function buildSectorById(): Map<string, { def: any; isLostFleet: boolean }> {
  const m = new Map<string, { def: any; isLostFleet: boolean }>();

  for (const s of BASE_SECTORS as any[]) {
    const id = String(s?.id ?? s?.sectorId ?? "");
    if (!id) continue;
    m.set(id, { def: s, isLostFleet: false });
  }

  for (const s of (EXPANSION_MIDDLE as any[]) ?? []) {
    const id = String(s?.id ?? s?.sectorId ?? "");
    if (!id) continue;
    m.set(id, { def: s, isLostFleet: true });
  }
  for (const s of (EXPANSION_LITTLE as any[]) ?? []) {
    const id = String(s?.id ?? s?.sectorId ?? "");
    if (!id) continue;
    m.set(id, { def: s, isLostFleet: true });
  }
  for (const s of (EXPANSION_SCOUT as any[]) ?? []) {
    const id = String(s?.id ?? s?.sectorId ?? "");
    if (!id) continue;
    m.set(id, { def: s, isLostFleet: true });
  }

  return m;
}

function incCounter(obj: Record<string, number>, key: string) {
  obj[key] = (obj[key] ?? 0) + 1;
}

/**
 * Middle rot mapping (LogicalMap only)
 * r0->1, r1->0, r2->5, r3->4, r4->3, r5->2
 */
function toMiddleRotLogical(rotSeed: number): number {
  return (1 - rotSeed + 6) % 6;
}

/** Large/Small current mapping (keep existing behavior) */
function toNonMiddleRotLogical(rotSeed: number): number {
  return (5 - rotSeed + 6) % 6;
}

/** Middle slotCenter offset by rotSeed (calibrated in templates file) */
function getMiddleSlotCenterOffset(rotSeed: number): Axial {
  return MIDDLE_SLOT_OFFSET_BY_ROT_SEED[rotSeed] ?? { q: 0, r: 0 };
}

/**
 * PRIMARY:
 * placement -> LogicalMap
 * - seed はラベル用途（任意）
 */
export function buildLogicalMapFromPlacement(args: {
  templateId: string;
  placement: SlotPlacement[];
  seed?: number | string;
}): LogicalMap {
  const { templateId, placement, seed } = args;

  const placementHash = computePlacementHash(placement);

  if (templateId !== "3p_lostFleet") {
    throw new Error(`buildLogicalMapFromPlacement: currently supports only templateId="3p_lostFleet"`);
  }

  // Build logical cells (collisions collected)
  const sectorById = buildSectorById();
  const slotCenters = SLOT_CENTERS_3P_LOSTFLEET;

  const cellsByKey = new Map<string, LogicalCell>();
  const collisions: CollisionRecord[] = [];
  const collisionsBySlot: Record<string, number> = {};

  let minQ = Infinity, maxQ = -Infinity, minR = Infinity, maxR = -Infinity;

  for (const p of placement) {
    const slotId = String((p as any).slotId);
    const sectorId = String((p as any).sectorId);

    const slotCenterBase = slotCenters[slotId];
    if (!slotCenterBase) throw new Error(`slot center not found: slotId=${slotId}`);

    const sec = sectorById.get(sectorId);
    if (!sec) throw new Error(`sector not found: sectorId=${sectorId}`);

    const locals = extractLocalCells(sec.def);

    let lfLocalNormalized: Map<string, Axial> | null = null;
    if (sec.isLostFleet) {
      const rawLocals = locals.map((x) => x.local);
      const n = normalizeLostFleetLocalCoords(rawLocals);
      lfLocalNormalized = new Map<string, Axial>();
      for (let i = 0; i < locals.length; i++) {
        lfLocalNormalized.set(locals[i].localKey, n.normalized[i]);
      }
    }

    const rotSeed = ((Number((p as any).rot ?? 0) % 6) + 6) % 6;
    const isMiddleSlot = slotId[0] === "M";

    // rot mapping: Middle only
    const rotLogical = isMiddleSlot ? toMiddleRotLogical(rotSeed) : toNonMiddleRotLogical(rotSeed);

    // slotCenter offset: Middle only (by rotSeed)
    const slotCenter = isMiddleSlot
      ? axialAdd(slotCenterBase, getMiddleSlotCenterOffset(rotSeed))
      : slotCenterBase;

    for (const lc of locals) {
      const norm = normalizeRawCell(lc.rawCell);

      const localForRot = sec.isLostFleet
        ? (lfLocalNormalized?.get(lc.localKey) ?? lc.local)
        : lc.local;

      const rotated = rotate60(localForRot, rotLogical);
      const abs = axialAdd(slotCenter, rotated);
      const k = keyOf(abs);

      minQ = Math.min(minQ, abs.q);
      maxQ = Math.max(maxQ, abs.q);
      minR = Math.min(minR, abs.r);
      maxR = Math.max(maxR, abs.r);

      const cell: LogicalCell = {
        pos: abs,
        kind: norm.kind,
        planetType: norm.planetType,
        tags: norm.tags,

        slotId,
        sectorId,
        rot: rotLogical,
        rotSeed,
        localKey: lc.localKey,
        isLostFleet: sec.isLostFleet,
      };

      const existing = cellsByKey.get(k);
      if (!existing) {
        cellsByKey.set(k, cell);
      } else {
        const existingSlotCenterBase = slotCenters[existing.slotId];
        const existingIsMiddle = existing.slotId[0] === "M";
        const existingSlotCenter = existingIsMiddle
          ? axialAdd(existingSlotCenterBase, getMiddleSlotCenterOffset(existing.rotSeed))
          : existingSlotCenterBase;

        collisions.push({
          key: k,
          pos: abs,
          a: {
            slotId: existing.slotId,
            sectorId: existing.sectorId,
            rot: existing.rot,
            rotSeed: existing.rotSeed,
            localKey: existing.localKey,
            slotCenter: existingSlotCenter,
          },
          b: {
            slotId,
            sectorId,
            rot: rotLogical,
            rotSeed,
            localKey: lc.localKey,
            slotCenter,
          },
        });
        incCounter(collisionsBySlot, slotId);
      }
    }
  }

  return {
    templateId,
    seed: seed === undefined ? undefined : typeof seed === "number" ? seed : Number(seed),
    placement,
    placementHash,
    cellsByKey,
    bounds: { minQ, maxQ, minR, maxR },
    collisions,
    collisionCount: collisions.length,
    collisionsBySlot,
  };
}

/**
 * COMPAT wrapper:
 * seed -> placement -> LogicalMap
 * - 検索の正系統は search.ts 側で seed->placement を行うのが推奨だが、
 *   既存コード互換のためラッパーとして残す。
 */
export function buildLogicalMap(args: { seed: number | string; templateId: string }): LogicalMap {
  const { seed, templateId } = args;

  const { placement } = makeSearchPlacementFromSeed({ templateId, seed });
  return buildLogicalMapFromPlacement({ templateId, seed, placement });
}
