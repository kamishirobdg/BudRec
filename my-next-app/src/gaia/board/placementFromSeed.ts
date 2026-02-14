// src/gaia/board/placementFromSeed.ts
import { mulberry32, hashSeed, shuffleSeeded } from "./rng";
import type { SlotDef, SlotPlacement } from "./types";

export type PlacementFromSeedArgs = {
  slots: SlotDef[];
  largeIds: string[];
  middleIds: string[];
  scoutIds: string[];  // SMALL (Scout) - no duplicates
  littleIds: string[]; // SMALL (Little) - duplicates allowed
  seed: string | number;

  // SSOT / UI passthrough
  scoutCount?: number; // default 4

  /**
   * IMPORTANT:
   * littleFixedCounts は「上限」ではなく「固定枚数」。
   * 例: { "19":2, "20":1, "21":1 }
   * - これらは可能な限り「ちょうど」配置する
   * - 残りの Little 枠は littleIds から埋める（重複可）
   */
  littleFixedCounts?: Record<string, number>;
};

type Unit = { ids: string[] };

function buildUnits(ids: string[], kind: "LARGE" | "MIDDLE"): Unit[] {
  const set = new Set(ids);
  const used = new Set<string>();
  const units: Unit[] = [];

  const addPair = (a: string, b: string) => {
    if (used.has(a) || used.has(b)) return;
    used.add(a);
    used.add(b);
    units.push({ ids: [a, b] });
  };

  for (const id of ids) {
    if (used.has(id)) continue;

    if (kind === "LARGE") {
      const m = /^(.*?)(0?)([567])b?$/.exec(id);
      if (m) {
        const prefix = m[1] ?? "";
        const z = m[2] ?? "";
        const n = m[3] ?? "";
        const base = `${prefix}${z}${n}`;
        const alt = `${base}b`;
        if (set.has(base) && set.has(alt)) {
          addPair(base, alt);
          continue;
        }
      }
    }

    if (kind === "MIDDLE") {
      const last = id.slice(-1);
      if (last === "a" || last === "b") {
        const base = id.slice(0, -1);
        const other = base + (last === "a" ? "b" : "a");
        if (set.has(other)) {
          addPair(id, other);
          continue;
        }
      }
    }

    used.add(id);
    units.push({ ids: [id] });
  }

  return units;
}

function pickFromUnit(u: Unit, rng: () => number): string {
  if (!u || u.ids.length === 0) return "";
  if (u.ids.length === 1) return u.ids[0];
  return u.ids[Math.floor(rng() * u.ids.length)];
}

/**
 * Rotation search (SSOT)
 * - LARGE: 0..5 (60°)
 * - MIDDLE: {0,2,4} (120°)
 * - SMALL: no search rot (keep 0), rot30 handled separately
 */
function pickRotLarge(rng: () => number): number {
  return Math.floor(rng() * 6) % 6; // 0..5
}
function pickRotMiddleForSlot(slotId: string, rng: () => number): number {
  // SSOT:
  // - M1–M4: {0,2,4}
  // - M5–M8: {1,3,5}
  const isLateMiddle = slotId === "M5" || slotId === "M6" || slotId === "M7" || slotId === "M8";
  const opts = isLateMiddle ? [1, 3, 5] : [0, 2, 4];
  return opts[Math.floor(rng() * opts.length)];
}

/**
 * Scout slot candidate sets (CONFIRMED).
 */
const SCOUT_SLOT_CANDIDATES_3P: string[][] = [
  ["S1", "S2", "S5", "S7"],
  ["S1", "S2", "S5", "S8"],
  ["S1", "S2", "S6", "S8"],
  ["S2", "S3", "S6", "S8"],
  ["S3", "S4", "S6", "S8"],
];

const SCOUT_SLOT_CANDIDATES_4P: string[][] = [
  ["S1", "S2", "S5", "S7"],
  ["S1", "S2", "S5", "S8"],
  ["S1", "S2", "S5", "S9"],
  ["S1", "S5", "S7", "S9"],
  ["S1", "S5", "S7", "S10"],
  ["S1", "S6", "S8", "S10"],
  ["S2", "S3", "S6", "S8"],
  ["S2", "S3", "S6", "S9"],
  ["S2", "S5", "S7", "S9"],
  ["S3", "S4", "S6", "S8"],
  ["S3", "S4", "S6", "S9"],
  ["S3", "S4", "S6", "S10"],
  ["S3", "S6", "S8", "S10"],
  ["S4", "S5", "S8", "S10"],
];

function is4pTemplate(slots: SlotDef[]): boolean {
  return slots.some((s: any) => String(s?.slotId) === "S9");
}

function chooseScoutSlotSet(slots: SlotDef[], rng: () => number, scoutCount: number): Set<string> {
  if (scoutCount !== 4) {
    const small = slots
      .filter((s: any) => {
        const a = Array.isArray((s as any).accepts) ? (s as any).accepts[0] : (s as any).accepts;
        return a !== "LARGE" && a !== "MIDDLE";
      })
      .map((s: any) => String(s.slotId));
    const shuffled = shuffleSeeded(small, rng);
    return new Set(shuffled.slice(0, Math.min(scoutCount, shuffled.length)));
  }

  const candidates = is4pTemplate(slots) ? SCOUT_SLOT_CANDIDATES_4P : SCOUT_SLOT_CANDIDATES_3P;
  if (candidates.length === 0) return new Set<string>();

  const idx = Math.floor(rng() * candidates.length);
  return new Set<string>(candidates[idx]);
}

/**
 * Build a deterministic LITTLE pick bag:
 * - Place fixed counts of 19/20/21 (as many as requested).
 * - Fill the remaining Little assignments with other Little IDs.
 */
function buildLittleBag(
  littleIds: string[],
  rng: () => number,
  fixed: Record<string, number> | undefined,
  littleNeeded: number
): string[] {
  const base = shuffleSeeded(littleIds, rng);

  if (littleNeeded <= 0) return [];

  const bag: string[] = [];

  const fixedIds = fixed ? Object.keys(fixed) : [];
  const fixedSet = new Set(fixedIds);

  // 1) fixed part (acts like a multiset deck: duplicates only if explicitly requested)
  if (fixed) {
    for (const id of fixedIds) {
      const n = Math.max(0, Number(fixed[id] ?? 0));
      if (n <= 0) continue;

      if (!base.includes(id)) {
        throw new Error(`littleFixedCounts contains id not in littleIds: ${id}`);
      }
      for (let i = 0; i < n; i++) bag.push(id);
    }
  }

  if (bag.length > littleNeeded) {
    throw new Error(
      `littleFixedCounts total (${bag.length}) exceeds little slots (${littleNeeded}).`
    );
  }

  // 2) fill remaining with "other" ids WITHOUT replacement (shuffle already applied)
  const remain = littleNeeded - bag.length;
  const others = base.filter((x) => !fixedSet.has(x));

  if (remain > others.length) {
    throw new Error(
      `Not enough non-fixed littleIds to fill little slots: need ${remain}, have ${others.length}.`
    );
  }

  for (let i = 0; i < remain; i++) bag.push(others[i]);

  // 3) final shuffle for distribution across slots
  return shuffleSeeded(bag, rng);
}


export function placementFromSeed({
  slots,
  largeIds,
  middleIds,
  scoutIds,
  littleIds,
  seed,
  scoutCount = 4,
  littleFixedCounts,
}: PlacementFromSeedArgs): SlotPlacement[] {
  const seedNum = typeof seed === "number" ? (seed >>> 0) : hashSeed(String(seed));
  const rng = mulberry32(seedNum);

  const largeUnits = shuffleSeeded(buildUnits(largeIds, "LARGE"), rng);
  const middleUnits = shuffleSeeded(buildUnits(middleIds, "MIDDLE"), rng);

  const scout = shuffleSeeded(scoutIds, rng);
  const little = shuffleSeeded(littleIds, rng);

  const largeSlots = slots.filter((s) => {
    const a = Array.isArray((s as any).accepts) ? (s as any).accepts[0] : (s as any).accepts;
    return a === "LARGE";
  }).length;

  const middleSlots = slots.filter((s) => {
    const a = Array.isArray((s as any).accepts) ? (s as any).accepts[0] : (s as any).accepts;
    return a === "MIDDLE";
  }).length;

  const smallSlots = slots.length - largeSlots - middleSlots;

  if (largeUnits.length < largeSlots) {
    throw new Error(
      `Not enough LARGE tiles under exclusivity constraints: need ${largeSlots}, have ${largeUnits.length} units.`
    );
  }
  if (middleUnits.length < middleSlots) {
    throw new Error(
      `Not enough MIDDLE tiles under a/b exclusivity constraints: need ${middleSlots}, have ${middleUnits.length} units.`
    );
  }
  if (little.length === 0 && smallSlots > 0 && scout.length === 0) {
    throw new Error("No SMALL tiles available (both Little and Scout lists are empty).");
  }

  // Scout slots chosen from confirmed candidates
  const scoutSlotSet = chooseScoutSlotSet(slots, rng, scoutCount);

  // Track used
  const usedLarge = new Set<string>();
  const usedMiddle = new Set<string>();
  const usedScout = new Set<string>();

  let li = 0,
    mi = 0,
    siScout = 0;

  // Determine how many LITTLE slots exist (SMALL minus chosen scout slots)
  const smallSlotIds = slots
    .filter((s: any) => {
      const a = Array.isArray((s as any).accepts) ? (s as any).accepts[0] : (s as any).accepts;
      return a !== "LARGE" && a !== "MIDDLE";
    })
    .map((s: any) => String(s.slotId));

  const littleSlotCount = Math.max(0, smallSlotIds.filter((sid) => !scoutSlotSet.has(sid)).length);

  // Build Little bag with fixed counts + fillers
  const littleBag = buildLittleBag(littleIds, rng, littleFixedCounts, littleSlotCount);
  let littleBagIdx = 0;

  const placements: SlotPlacement[] = [];

  for (const slot of slots) {
    const accepts = Array.isArray((slot as any).accepts) ? (slot as any).accepts[0] : (slot as any).accepts;

    let sectorId = "";
    let rot = 0;

    if (accepts === "LARGE") {
      const u = largeUnits[li++];
      sectorId = pickFromUnit(u, rng);

      if (usedLarge.has(sectorId) && u.ids.length > 1) {
        sectorId = u.ids.find((x) => x !== sectorId) ?? sectorId;
      }
      usedLarge.add(sectorId);

      // rotation search (SSOT)
      rot = pickRotLarge(rng);
    } else if (accepts === "MIDDLE") {
      const u = middleUnits[mi++];
      sectorId = pickFromUnit(u, rng);

      if (usedMiddle.has(sectorId) && u.ids.length > 1) {
        sectorId = u.ids.find((x) => x !== sectorId) ?? sectorId;
      }
      usedMiddle.add(sectorId);

      // rotation search (SSOT)
      rot = pickRotMiddleForSlot(String(slot.slotId), rng);
    } else {
      // SMALL
      const sid = String(slot.slotId);
      const wantScoutHere = scoutSlotSet.has(sid) && scout.length > 0;

      if (wantScoutHere) {
        while (siScout < scout.length && usedScout.has(String(scout[siScout]))) siScout++;
        if (siScout < scout.length) {
          sectorId = scout[siScout++];
          usedScout.add(String(sectorId));
        }
      }

      if (!sectorId) {
        if (littleBag.length > 0) {
          if (littleBagIdx >= littleBag.length) {
            throw new Error("Little bag exhausted (check littleFixedCounts / littleIds / scoutCount).");
          }
          sectorId = littleBag[littleBagIdx++];
        } else if (little.length > 0) {
          sectorId = little[0]; // fallback
        } else {
          while (siScout < scout.length && usedScout.has(String(scout[siScout]))) siScout++;
          if (siScout < scout.length) {
            sectorId = scout[siScout++];
            usedScout.add(String(sectorId));
          } else {
            throw new Error("SMALL tiles exhausted (no Little and Scout unique exhausted).");
          }
        }
      }

      // SMALL has no 60° rotation search; rot stays 0. rot30 handled later.
      rot = 0;
    }

    placements.push({
      slotId: slot.slotId,
      sectorId,
      rot,
      rot30: 0,
    });
  }

  // SSOT:
  // - Middle rotations are selected per-slot:
  //   - M1–M4: {0,2,4}
  //   - M5–M8: {1,3,5}
  // - Small rot30=+1
  for (const p of placements) {
    if (p.slotId.startsWith("S")) p.rot30 = 1;
  }

  return placements;
}
