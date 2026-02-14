import type { SectorTileDef } from "./sectorTypes";
import { SECTOR_LOCAL_KEYS } from "./sectorTiles_base";

export function validateSectorTile(tile: SectorTileDef): void {
  // 7マスが全部埋まっているか
  for (const k of SECTOR_LOCAL_KEYS) {
    if (!tile.cells[k]) {
      throw new Error(`Sector ${tile.id}: missing cell ${k}`);
    }
  }

  // 余計なキーがないか（ヒューマンエラー防止）
  for (const k of Object.keys(tile.cells)) {
    if (!SECTOR_LOCAL_KEYS.includes(k as any)) {
      throw new Error(`Sector ${tile.id}: unexpected cell key ${k}`);
    }
  }
}

export function validateSectorSet(tiles: readonly SectorTileDef[]): void {
  const ids = new Set<string>();
  for (const t of tiles) {
    if (ids.has(t.id)) throw new Error(`Duplicate sector id: ${t.id}`);
    ids.add(t.id);
    validateSectorTile(t);
  }
}
