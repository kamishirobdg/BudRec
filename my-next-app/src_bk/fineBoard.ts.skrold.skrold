// src/GAIA/fineBoard.ts
import type { Axial, Cell, SectorTileDef } from "./sectorTypes";
import { add, key, rotate60 } from "./axialMath";

export type SectorPlacement = {
  sectorId: string; // "01" 等
  pos: Axial;       // セクター中心のグローバル座標
  rot: number;      // 0..5
};

export type FineBoard = {
  cells: ReadonlyMap<string, Cell>; // key = "q,r" (global)
};

/**
 * セクター配置（大タイル）から、細分セル盤面へ展開します。
 * - 同一グローバル座標に2セルが衝突した場合は例外（配置が不正）
 */
export function buildFineBoard(
  sectors: readonly SectorTileDef[],
  placements: readonly SectorPlacement[]
): FineBoard {
  const byId = new Map(sectors.map((s) => [s.id, s] as const));
  const out = new Map<string, Cell>();

  for (const pl of placements) {
    const sector = byId.get(pl.sectorId);
    if (!sector) throw new Error(`Unknown sectorId: ${pl.sectorId}`);

    for (const [kLocal, cell] of Object.entries(sector.cells)) {
      const [qStr, rStr] = kLocal.split(",");
      const local: Axial = { q: Number(qStr), r: Number(rStr) };

      const rotated = rotate60(local, pl.rot);
      const global = add(pl.pos, rotated);
      const kg = key(global);

      if (out.has(kg)) {
        throw new Error(`Cell collision at ${kg} (sector ${pl.sectorId})`);
      }
      out.set(kg, cell);
    }
  }

  return { cells: out };
}
