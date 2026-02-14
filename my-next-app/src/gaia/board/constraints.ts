// src/gaia/board/constraints.ts
import type { SlotDef, SlotPlacement } from "./types";

export type DuplicatePolicy = {
  LARGE: "forbid";
  MIDDLE: "forbid";
  SCOUT: "forbid";
  LITTLE: "allow";
};

export type ExclusiveGroup = {
  kind: "LARGE" | "MIDDLE";
  key: string;
  variants: string[];
};

export type PoolSummary = {
  need: { LARGE: number; MIDDLE: number; SMALL: number };
  candidates: { LARGE: number; MIDDLE: number; SCOUT: number; LITTLE: number };
  units: { LARGE: number; MIDDLE: number };
  groups: { LARGE: ExclusiveGroup[]; MIDDLE: ExclusiveGroup[] };
};

export type BoardAudit = {
  duplicates: {
    LARGE: string[];
    MIDDLE: string[];
    SCOUT: string[];
    LITTLE: { id: string; count: number }[];
  };
  middleABConflicts: { base: string; used: string[] }[];
  unknownSmall: string[];
};

export type ConstraintReport = {
  policy: DuplicatePolicy;
  pool: PoolSummary;
  audit: BoardAudit;
};

const POLICY: DuplicatePolicy = {
  LARGE: "forbid",
  MIDDLE: "forbid",
  SCOUT: "forbid",
  LITTLE: "allow",
};

function countNeed(slots: SlotDef[]): { LARGE: number; MIDDLE: number; SMALL: number } {
  let large = 0, middle = 0, small = 0;
  for (const s of slots) {
    const a = Array.isArray((s as any).accepts) ? (s as any).accepts[0] : (s as any).accepts;
    if (a === "LARGE") large++;
    else if (a === "MIDDLE") middle++;
    else small++;
  }
  return { LARGE: large, MIDDLE: middle, SMALL: small };
}

function inferLargeGroups(largeIds: string[]): ExclusiveGroup[] {
  const set = new Set(largeIds);
  const groups: ExclusiveGroup[] = [];
  for (const n of ["5", "6", "7"]) {
    const base1 = n;
    const alt1 = `${n}b`;
    const base2 = `0${n}`;
    const alt2 = `0${n}b`;

    if (set.has(base1) && set.has(alt1)) groups.push({ kind: "LARGE", key: n, variants: [base1, alt1] });
    else if (set.has(base2) && set.has(alt2)) groups.push({ kind: "LARGE", key: base2, variants: [base2, alt2] });
  }
  return groups;
}

function inferMiddleGroups(middleIds: string[]): ExclusiveGroup[] {
  const set = new Set(middleIds);
  const used = new Set<string>();
  const groups: ExclusiveGroup[] = [];
  for (const id of middleIds) {
    if (used.has(id)) continue;
    const last = id.slice(-1);
    if (last !== "a" && last !== "b") continue;
    const base = id.slice(0, -1);
    const other = base + (last === "a" ? "b" : "a");
    if (set.has(other)) {
      used.add(id);
      used.add(other);
      groups.push({ kind: "MIDDLE", key: base, variants: [base + "a", base + "b"] });
    }
  }
  groups.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return groups;
}

function countUnits(ids: string[], groups: ExclusiveGroup[]): number {
  const inGroup = new Set<string>();
  for (const g of groups) for (const v of g.variants) inGroup.add(v);
  const singletonCount = ids.filter((id) => !inGroup.has(id)).length;
  return groups.length + singletonCount;
}

function collectDuplicates(list: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const x of list) {
    if (seen.has(x)) dups.add(x);
    else seen.add(x);
  }
  return Array.from(dups.values()).sort();
}

function countOccurrences(list: string[]): { id: string; count: number }[] {
  const m = new Map<string, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  const arr = Array.from(m.entries()).map(([id, count]) => ({ id, count }));
  arr.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return arr.filter((x) => x.count >= 2);
}

export function computeConstraintReport(args: {
  slots: SlotDef[];
  placements: SlotPlacement[];
  largeIds: string[];
  middleIds: string[];
  scoutIds: string[];
  littleIds: string[];
}): ConstraintReport {
  const { slots, placements, largeIds, middleIds, scoutIds, littleIds } = args;

  const need = countNeed(slots);
  const largeGroups = inferLargeGroups(largeIds);
  const middleGroups = inferMiddleGroups(middleIds);

  const pool: PoolSummary = {
    need,
    candidates: {
      LARGE: largeIds.length,
      MIDDLE: middleIds.length,
      SCOUT: scoutIds.length,
      LITTLE: littleIds.length,
    },
    units: {
      LARGE: countUnits(largeIds, largeGroups),
      MIDDLE: countUnits(middleIds, middleGroups),
    },
    groups: {
      LARGE: largeGroups,
      MIDDLE: middleGroups,
    },
  };

  const slotAccepts = new Map<string, "LARGE" | "MIDDLE" | "SMALL">();
  for (const s of slots) {
    const a = Array.isArray((s as any).accepts) ? (s as any).accepts[0] : (s as any).accepts;
    slotAccepts.set(s.slotId, a === "LARGE" ? "LARGE" : a === "MIDDLE" ? "MIDDLE" : "SMALL");
  }

  const scoutSet = new Set(scoutIds);
  const littleSet = new Set(littleIds);

  const usedLarge: string[] = [];
  const usedMiddle: string[] = [];
  const usedScout: string[] = [];
  const usedLittle: string[] = [];
  const unknownSmall: string[] = [];

  const middleBaseToVariants = new Map<string, Set<string>>();

  for (const p of placements) {
    const a = slotAccepts.get(p.slotId) ?? "SMALL";
    if (a === "LARGE") usedLarge.push(p.sectorId);
    else if (a === "MIDDLE") {
      usedMiddle.push(p.sectorId);
      const id = p.sectorId;
      const last = id.slice(-1);
      if (last === "a" || last === "b") {
        const base = id.slice(0, -1);
        const set = middleBaseToVariants.get(base) ?? new Set<string>();
        set.add(last);
        middleBaseToVariants.set(base, set);
      }
    } else {
      if (scoutSet.has(p.sectorId)) usedScout.push(p.sectorId);
      else if (littleSet.has(p.sectorId)) usedLittle.push(p.sectorId);
      else unknownSmall.push(p.sectorId);
    }
  }

  const middleABConflicts: { base: string; used: string[] }[] = [];
  for (const [base, vars] of middleBaseToVariants.entries()) {
    if (vars.has("a") && vars.has("b")) middleABConflicts.push({ base, used: [base + "a", base + "b"] });
  }
  middleABConflicts.sort((a, b) => a.base.localeCompare(b.base, "en", { numeric: true }));

  const audit: BoardAudit = {
    duplicates: {
      LARGE: collectDuplicates(usedLarge),
      MIDDLE: collectDuplicates(usedMiddle),
      SCOUT: collectDuplicates(usedScout),
      LITTLE: countOccurrences(usedLittle),
    },
    middleABConflicts,
    unknownSmall: unknownSmall.sort(),
  };

  return { policy: POLICY, pool, audit };
}
