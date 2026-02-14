// src/gaia/board/previewBoard.ts
//
// Preview expansion: (slotId, sectorId, rot) placements -> absolute board cells.
// Used by UI/Debug rendering, so keep it deterministic.
//
// Coordinate policy (CONFIRMED for TEMPLATE_3P_LOSTFLEET):
// - template.slots[].pos is written in an "offset-like" board coordinate (col,row).
// - We convert slot.pos -> axial by odd-r offset conversion:
//     axialQ = col - floor(row/2), axialR = row
// - Sector local cell keys are treated as axial as-authored (NO extra shift).
//   (Both base and lostfleet sector definitions in current repo form valid radius=2 axial layouts.)

export type Axial = { q: number; r: number };

export type SlotAccept = "LARGE" | "MIDDLE" | "SMALL";
export type Slot = { slotId: string; pos: Axial; accepts: SlotAccept[] };

type AnySector = any;

export type PlacementItem = {
  slotId: string;
  sectorId: string;
  rot: number; // 0..5 (60deg steps)
};

export type BoardCell = {
  pos: Axial; // board absolute (axial)
  kind: "planet" | "space" | "special";
  planetType?: string;
  tags: string[];
  slotId: string;
  sectorId: string;
  localKey?: string; // raw key from sector.cells (or derived)
};

function parseKey(key: string): Axial {
  const [q, r] = key.split(",").map((v) => Number(v));
  return { q, r };
}

function keyOf(p: Axial) {
  return `${p.q},${p.r}`;
}

export function axialAdd(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

/** Convert template slot position (col,row) to axial. */
function slotPosToAxial(pos: Axial): Axial {
  // odd-r offset -> axial
  return { q: pos.q - Math.floor(pos.r / 2), r: pos.r };
}

/** Rotate axial(q,r) by 60° steps (CW) using cube rotation. */
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

function normalizeCell(raw: any): { kind: "planet" | "space" | "special"; planetType?: string; tags: string[] } {
  const k = raw?.kind;
  const tags = Array.isArray(raw?.tags) ? raw.tags : [];

  if (k === "planet") {
    const pt = (raw?.planetType ?? raw?.planet) as string | undefined;
    return { kind: "planet", planetType: pt, tags };
  }
  if (k === "special") return { kind: "special", tags };
  // empty / space
  return { kind: "space", tags };
}

export function buildSectorLookup(sectors: AnySector[]): Map<string, AnySector> {
  const m = new Map<string, AnySector>();
  for (const s of sectors) {
    const id = (s?.sectorId ?? s?.id) as string | undefined;
    if (!id) continue;
    m.set(id, { ...s, sectorId: id });
  }
  return m;
}

export function expandPlacementToBoardCells(args: {
  slots: Slot[];
  placement: PlacementItem[];
  sectorById: Map<string, AnySector>;
}): BoardCell[] {
  const { slots, placement, sectorById } = args;
  const slotById = new Map(slots.map((s) => [s.slotId, s]));

  const out: BoardCell[] = [];

  for (const p of placement) {
    const slot = slotById.get(p.slotId);
    const sector = sectorById.get(p.sectorId);
    if (!slot || !sector) continue;

    const slotPos = slotPosToAxial(slot.pos);
    const rot = Number((p as any).rot ?? 0);

    // Case A: classic sector tiles (object map)
    if (sector.cells && !Array.isArray(sector.cells)) {
      const cells: Record<string, any> = sector.cells ?? {};
      for (const [k, rawCell] of Object.entries(cells)) {
        const localAx = parseKey(k); // treat as axial as-authored
        const rotated = rotate60(localAx, rot);
        const abs = axialAdd(slotPos, rotated);
        const norm = normalizeCell(rawCell);

        out.push({
          pos: abs,
          kind: norm.kind,
          planetType: norm.planetType,
          tags: norm.tags,
          slotId: p.slotId,
          sectorId: p.sectorId,
          localKey: k,
        });
      }
    }
    // Case B: sparse tiles (array of {at, cell})
    else if (Array.isArray(sector.cells)) {
      for (const sc of sector.cells as any[]) {
        const at = sc?.at;
        const rawCell = sc?.cell;
        if (!at || rawCell == null) continue;

        const localAx: Axial = { q: Number(at.q), r: Number(at.r) };
        const rotated = rotate60(localAx, rot);
        const abs = axialAdd(slotPos, rotated);
        const norm = normalizeCell(rawCell);

        out.push({
          pos: abs,
          kind: norm.kind,
          planetType: norm.planetType,
          tags: norm.tags,
          slotId: p.slotId,
          sectorId: p.sectorId,
          localKey: `${localAx.q},${localAx.r}`,
        });
      }
    }
  }

  // Preview: last write wins on duplicate coords.
  const uniq = new Map<string, BoardCell>();
  for (const c of out) uniq.set(keyOf(c.pos), c);
  return [...uniq.values()];
}

/**
 * Template helper (used by src/app/template/page.tsx):
 * Assign sector IDs cyclically by slot.accepts, with rot=0.
 *
 * This must remain exported to avoid build breakage.
 */
export function makeCycledPlacement(args: {
  slots: Slot[];
  largeIds: string[];
  middleIds: string[];
  smallIds: string[];
}): PlacementItem[] {
  const { slots, largeIds, middleIds, smallIds } = args;

  let iL = 0;
  let iM = 0;
  let iS = 0;

  return slots.map((s) => {
    const a0 = s.accepts[0];
    let sectorId = "";

    if (a0 === "LARGE") {
      sectorId = largeIds[iL % Math.max(1, largeIds.length)] ?? "";
      iL++;
    } else if (a0 === "MIDDLE") {
      sectorId = middleIds[iM % Math.max(1, middleIds.length)] ?? "";
      iM++;
    } else {
      sectorId = smallIds[iS % Math.max(1, smallIds.length)] ?? "";
      iS++;
    }

    return { slotId: s.slotId, sectorId, rot: 0 };
  });
}
