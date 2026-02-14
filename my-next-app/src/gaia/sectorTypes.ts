// src/GAIA/sectorTypes.ts

export type PlanetType =
  | "BLUE"
  | "YELLOW"
  | "BROWN"
  | "RED"
  | "WHITE"
  | "ORANGE"
  | "BLACK"
  | "GAIA"
  | "TRANSDIM"
  | "PROTO"
  | "ASTEROID"
  | "EMPTY";

export type Axial = { q: number; r: number };

export type Cell =
  | { kind: "planet"; planet: Exclude<PlanetType, "EMPTY">; tags?: string[] }
  | { kind: "empty"; tags?: string[] };

/**
 * 通常セクター（19セル）定義
 * key = "q,r"
 */
export type SectorTileDef = {
  id: string;
  radius: number;
  cells: Record<string, Cell>;
};

/**
 * 拡張タイル（Middle / Little / Scout）向け：疎なセル定義
 * - cells に列挙された座標のみ「存在するセル」として扱う想定
 */
export type TileKind = "SECTOR" | "MIDDLE" | "LITTLE" | "SCOUT";
export type TileFootprint = "tri3" | "single" | "custom";

export type SparseCellDef = {
  at: Axial;
  cell: Cell;
};

export type ExpansionSparseTileDef = {
  id: string;
  kind: Exclude<TileKind, "SECTOR">;
  footprint: TileFootprint;
  cells: ReadonlyArray<SparseCellDef>;
  /**
   * 回転対称（将来の最適化・UIで利用可能）
   * 6: 60度回転で区別、3: 120度単位、1: 回転しても同一
   */
  rotSymmetry?: 6 | 3 | 1;
};

export function axialKey(p: Axial): string {
  return `${p.q},${p.r}`;
}

export function parseAxialKey(k: string): Axial {
  const [qStr, rStr] = k.split(",");
  const q = Number(qStr);
  const r = Number(rStr);
  if (!Number.isFinite(q) || !Number.isFinite(r)) {
    throw new Error(`Invalid axial key: ${k}`);
  }
  return { q, r };
}
