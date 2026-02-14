// src/gaia/board/sectorCatalog.ts
import { BASE_SECTORS } from "@/gaia/sectorTiles_base";
import { EXPANSION_MIDDLE, EXPANSION_LITTLE, EXPANSION_SCOUT } from "@/gaia/sectorTiles_lostfleet";

type Axial = { q: number; r: number };

function parseKey(key: string): Axial {
  const [q, r] = key.split(",").map((v) => Number(v));
  return { q, r };
}
function keyOf(p: Axial): string {
  return `${p.q},${p.r}`;
}
function fixBaseLocalCoord(radius: number, local: Axial): Axial {
  const shift = Math.floor((local.r + radius) / 2);
  return { q: local.q - shift, r: local.r };
}

function normalizeBaseSector(sector: any): any {
  const radius = sector?.radius;
  if (typeof radius !== "number") return sector;
  const cells = sector?.cells ?? {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cells)) {
    const local0 = parseKey(k);
    const local = fixBaseLocalCoord(radius, local0);
    out[keyOf(local)] = v;
  }
  return { ...sector, sectorId: sector?.sectorId ?? sector?.id, cells: out };
}

export function buildSectorCatalog(): Map<string, any> {
  const m = new Map<string, any>();

  for (const s of BASE_SECTORS as any[]) {
    const id = String(s?.sectorId ?? s?.id);
    if (!id) continue;
    m.set(id, normalizeBaseSector({ ...s, sectorId: id }));
  }

  const exp = [
    ...(EXPANSION_MIDDLE as any[]),
    ...(EXPANSION_LITTLE as any[]),
    ...(EXPANSION_SCOUT as any[]),
  ];
  for (const s of exp) {
    const id = String(s?.sectorId ?? s?.id);
    if (!id) continue;
    m.set(id, { ...s, sectorId: id });
  }
  return m;
}
