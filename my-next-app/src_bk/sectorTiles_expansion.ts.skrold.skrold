// src/GAIA/sectorTiles_expansion.ts
import type { Axial, ExpansionSparseTileDef, SparseCellDef, PlanetType } from "./sectorTypes";

/**
 * Expansion tiles (SSOT)
 *
 * 方針（確定）:
 * - Middle Sector: 3セルのみ（tri3）。座標は固定で (0,0) (1,0) (0,1)
 * - Little Sector: 1セルのみ（single）。重複配置しない（ユニーク）
 * - Scout Ship: 1セルのみ（single）。4種は毎回必ず配置し、重複なし（毎回必須）
 *
 * NOTE:
 * - 7-1（タイル内容の埋め）は後続タスクのため、現時点では 11a/11b のみ反映し、他は empty スタブです。
 */

export const EXPANSION_MIDDLE_IDS = [
  "11a","11b","12a","12b","13a","13b","14a","14b","15a","15b","16a","16b","17a","17b","18a","18b",
] as const;

export const EXPANSION_LITTLE_IDS = ["19", "20"] as const;

export const EXPANSION_SCOUT_IDS = ["twilight", "eclipse", "rebellion", "tfmars"] as const;

const TRI3_AXIALS: readonly Axial[] = [
  { q: 0, r: 0 },
  { q: 1, r: 0 },
  { q: 0, r: 1 },
] as const;

const SINGLE_AXIAL: Axial = { q: 0, r: 0 };

function emptyCell(at: Axial): SparseCellDef {
  return { at, cell: { kind: "empty", tags: [] } };
}

function planetCell(at: Axial, planet: PlanetType): SparseCellDef {
  return { at, cell: { kind: "planet", planet, tags: [`planet:${planet}`] } };
}

/**
 * Middle tiles
 * - 11a:
 *   (0,0)= PROTO
 *   (1,0)= ASTEROID
 *   (0,1)= empty
 * - 11b:
 *   (0,0)= empty
 *   (1,0)= ASTEROID
 *   (0,1)= empty
 * - others: empty stub (to be filled in 7-1)
 */
export const EXPANSION_MIDDLE_TILES: readonly ExpansionSparseTileDef[] = EXPANSION_MIDDLE_IDS.map((id) => {
  const base: ExpansionSparseTileDef = {
    id,
    kind: "MIDDLE",
    footprint: "tri3",
    rotSymmetry: 6,
    cells: TRI3_AXIALS.map((a) => emptyCell(a)),
  };

  if (id === "11a") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "PROTO"),
        planetCell({ q: 1, r: 0 }, "ASTEROID"),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "11b") {
    return {
      ...base,
      cells: [
        emptyCell({ q: 0, r: 0 }),
        planetCell({ q: 1, r: 0 }, "ASTEROID"),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "12a") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "TRANSDIM"),
        planetCell({ q: 1, r: 0 }, "PROTO"),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "12b") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "ASTEROID"),
        emptyCell({ q: 1, r: 0 }),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "13a") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "TRANSDIM"),
        emptyCell({ q: 1, r: 0 }),
        planetCell({ q: 0, r: 1 }, "ASTEROID"),
      ],
    };
  }

  if (id === "13b") {
    return {
      ...base,
      cells: [
        emptyCell({ q: 0, r: 0 }),
        emptyCell({ q: 1, r: 0 }),
        planetCell({ q: 0, r: 1 }, "ASTEROID"),
      ],
    };
  }

  if (id === "14a") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "PROTO"),
        emptyCell({ q: 1, r: 0 }),
        planetCell({ q: 0, r: 1 }, "ASTEROID"),
      ],
    };
  }

  if (id === "14b") {
    return {
      ...base,
      cells: [
        emptyCell({ q: 0, r: 0 }),
        emptyCell({ q: 1, r: 0 }),
        planetCell({ q: 0, r: 1 }, "ASTEROID"),
      ],
    };
  }

  if (id === "15a") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "PROTO"),
        emptyCell({ q: 1, r: 0 }),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "15b") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "PROTO"),
        emptyCell({ q: 1, r: 0 }),
        planetCell({ q: 0, r: 1 }, "ASTEROID"),
      ],
    };
  }

  if (id === "16a") {
    return {
      ...base,
      cells: [
        emptyCell({ q: 0, r: 0 }),
        emptyCell({ q: 1, r: 0 }),
        planetCell({ q: 0, r: 1 }, "ASTEROID"),
      ],
    };
  }

  if (id === "16b") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "ASTEROID"),
        emptyCell({ q: 1, r: 0 }),
        planetCell({ q: 0, r: 1 }, "ASTEROID"),
      ],
    };
  }

  if (id === "17a") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "TRANSDIM"),
        emptyCell({ q: 1, r: 0 }),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "17b") {
    return {
      ...base,
      cells: [
        emptyCell({ q: 0, r: 0 }),
        planetCell({ q: 1, r: 0 }, "ASTEROID"),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "18a") {
    return {
      ...base,
      cells: [
        planetCell({ q: 0, r: 0 }, "PROTO"),
        emptyCell({ q: 1, r: 0 }),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }

  if (id === "18b") {
    return {
      ...base,
      cells: [
        emptyCell({ q: 0, r: 0 }),
        planetCell({ q: 1, r: 0 }, "ASTEROID"),
        emptyCell({ q: 0, r: 1 }),
      ],
    };
  }


  return base;
});

export const EXPANSION_LITTLE_TILES: readonly ExpansionSparseTileDef[] =
  EXPANSION_LITTLE_IDS.map((id) => ({
    id,
    kind: "LITTLE",
    footprint: "single",
    rotSymmetry: 6,
    cells: [emptyCell(SINGLE_AXIAL)],
  }));

export const EXPANSION_SCOUT_TILES: readonly ExpansionSparseTileDef[] =
  EXPANSION_SCOUT_IDS.map((id) => ({
    id,
    kind: "SCOUT",
    footprint: "single",
    rotSymmetry: 6,
    cells: [emptyCell(SINGLE_AXIAL)],
  }));

export const EXPANSION_TILES_ALL: readonly ExpansionSparseTileDef[] = [
  ...EXPANSION_MIDDLE_TILES,
  ...EXPANSION_LITTLE_TILES,
  ...EXPANSION_SCOUT_TILES,
];
