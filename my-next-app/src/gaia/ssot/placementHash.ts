// src/gaia/ssot/placementHash.ts
//
// placementHash SSOT
// - placement(slotId, sectorId, rot, rot30) を正規化して安定ハッシュ化する
// - 「評価した盤面」と「表示した盤面」が同一であることを機械的に保証するためのキー
//

import type { SlotPlacement } from "../board/types";

function normalizePlacement(p: SlotPlacement[]) {
  return [...(p ?? [])]
    .map((x: any) => ({
      slotId: String(x?.slotId ?? ""),
      sectorId: String(x?.sectorId ?? ""),
      rot: Number.isFinite(Number(x?.rot)) ? Number(x.rot) : 0,
      rot30: Number.isFinite(Number(x?.rot30)) ? Number(x.rot30) : 0,
    }))
    .sort((a, b) => {
      if (a.slotId !== b.slotId) return a.slotId < b.slotId ? -1 : 1;
      if (a.sectorId !== b.sectorId) return a.sectorId < b.sectorId ? -1 : 1;
      if (a.rot !== b.rot) return a.rot - b.rot;
      return a.rot30 - b.rot30;
    });
}

/**
 * 軽量・高速 FNV-1a (32bit)
 * - 32bit hex 8桁で返す
 */
function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (shift-add で32bit維持)
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

export function computePlacementHash(placement: SlotPlacement[]): string {
  const normalized = normalizePlacement(placement);
  return fnv1a32(JSON.stringify(normalized));
}
