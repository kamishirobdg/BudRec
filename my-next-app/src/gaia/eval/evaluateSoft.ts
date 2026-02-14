// src/gaia/eval/evaluateSoft.ts
import type { ExtractedForEval, PlanetKind } from "./extractForEval";
import { axialDistance } from "../hex";

export type PlanetType =
  | "BLACK"
  | "BLUE"
  | "BROWN"
  | "ORANGE"
  | "RED"
  | "WHITE"
  | "YELLOW";

// Lost Fleet: PROTO / ASTEROID are not part of BASIC planet colors.
// They are included in Scout evaluation/audit, but do not affect imbalance score for now.
export type ScoutExtraKind = "PROTO" | "ASTEROID";

export type AxisByType = Record<PlanetType, number>;
export type CountByType = Record<PlanetType, number>;

export type SoftParams = {
  wOuter: number;
  wTouch: number;
  wScout: number;
  wScoutCore?: number;

  wImbalance: number;
  imbalanceMetric?: "std" | "range";

  scoutRadius: number;
};

export type SoftBreakdown = {
  // ★追跡用（SSOT）
  placementHash: string;

  axesByType: {
    outer: AxisByType;
    touch: AxisByType;
    scout: AxisByType;
    scoutCore: AxisByType;
  };

  planetTypeTotals: AxisByType;

  imbalance: {
    metric: "std" | "range";
    value: number;
    score: number;
  };

  audit: {
    // ★追跡用（SSOT）
    placementHash: string;

    outerCountByType: CountByType;
    touchCountByType: CountByType;

    outerHits: Array<{
      cellKey: string;
      planetType: PlanetType;
      kind: any;
      slotId: string;
      sectorId: string;
      tags: string[];
    }>;
    touchHits: Array<{
      cellKey: string;
      planetType: PlanetType;
      kind: any;
      slotId: string;
      sectorId: string;
      tags: string[];
    }>;

    // ★Scout監査（必須）
    scout: {
      radius: number;

      // scoutAxisと同義（見やすさのため残す）
      byType: AxisByType;

      // Scoutセルごとの内訳
      perScout: Array<{
        scoutKey: string;
        byType: AxisByType;
        total: number;
        // Lost Fleet extras (PROTO / ASTEROID)
        extraByKind: Record<ScoutExtraKind, { total: number; hits: number }>;
      }>;

      // 距離別ヒット件数（d=1..radius）
      distanceHistogram: Record<number, number>;

      // Lost Fleet extras (PROTO / ASTEROID)
      extraByKind: Record<ScoutExtraKind, { total: number; hits: number }>;

      // best-effort: Extract側が持っていればそのまま採用
      excludedPlanetCounts?: Record<string, number>;

      scoutHits: Array<{
        scoutKey: string;
        planetKey: string;
        planetType: PlanetType | "(EXTRA)";
        planetKind?: string;
        distance: number;
        value: number;
        planet: { kind: any; slotId: string; sectorId: string; tags: string[] };
        scout: { kind: any; slotId: string; sectorId: string; tags: string[] };
      }>;
    };
  };

  debug?: any;
};

export type SoftEvalResult = {
  score: number;
  breakdown: SoftBreakdown;
};

const PLANET_TYPES: PlanetType[] = ["BLACK", "BLUE", "BROWN", "ORANGE", "RED", "WHITE", "YELLOW"];

function zeroAxis(): AxisByType {
  return { BLACK: 0, BLUE: 0, BROWN: 0, ORANGE: 0, RED: 0, WHITE: 0, YELLOW: 0 };
}

function num(v: any, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v: any, fallback: number, min: number, max: number): number {
  const n = Math.floor(num(v, fallback));
  return Math.max(min, Math.min(max, n));
}

function addAxis(a: AxisByType, b: AxisByType): AxisByType {
  const out = zeroAxis();
  for (const t of PLANET_TYPES) out[t] = (a[t] ?? 0) + (b[t] ?? 0);
  return out;
}

function axisValues(a: AxisByType): number[] {
  return PLANET_TYPES.map((t) => a[t] ?? 0);
}

function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - mean) * (x - mean), 0) / values.length;
  return Math.sqrt(v);
}

function range(values: number[]): number {
  if (values.length === 0) return 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (const x of values) {
    if (x < mn) mn = x;
    if (x > mx) mx = x;
  }
  return mx - mn;
}

function toPlanetType(kind?: PlanetKind, colorKey?: string): PlanetType | null {
  const s = (colorKey ?? kind ?? "").toString().toUpperCase();
  if (s === "BLACK") return "BLACK";
  if (s === "BLUE") return "BLUE";
  if (s === "BROWN") return "BROWN";
  if (s === "ORANGE") return "ORANGE";
  if (s === "RED") return "RED";
  if (s === "WHITE") return "WHITE";
  if (s === "YELLOW") return "YELLOW";
  return null;
}

function scoutValue(d: number, wScout: number, R: number): number {
  if (d < 1 || d > R) return 0;
  const v = wScout - (d - 1);
  return v > 0 ? v : 0;
}

function incNumRecord(rec: Record<number, number>, k: number, delta: number = 1) {
  const key = Number(k);
  rec[key] = (rec[key] ?? 0) + delta;
}

function collectExcludedPlanetCountsBestEffort(extracted: ExtractedForEval): Record<string, number> | undefined {
  // Extract側が既に用意しているならそれを最優先で採用（SSOTはextractForEval）
  const fromExtract =
    (extracted as any)?.audit?.excludedPlanetCounts ??
    (extracted as any)?.audit?.excludedCounts ??
    (extracted as any)?.excludedPlanetCounts;

  if (fromExtract && typeof fromExtract === "object") return fromExtract as Record<string, number>;

  // 無理に推定しない（将来PROTO/ASTEROIDも評価対象にするため、ここで「除外=悪」と決めない）
  return undefined;
}

export function evaluateSoft(extracted: ExtractedForEval, params: SoftParams): SoftEvalResult {
  const wOuter = num(params.wOuter, 0);
  const wTouch = num(params.wTouch, 0);
  const wScout = num(params.wScout, 0);
  const wScoutCore = num(params.wScoutCore, 0);
  const wImbalance = num(params.wImbalance, 0);

  const metric: "std" | "range" =
    params.imbalanceMetric === "range" || params.imbalanceMetric === "std" ? params.imbalanceMetric : "std";

  const scoutRadius = clampInt(params.scoutRadius, 2, 0, 6);

  // outer / touch（SSOT: normalPlanetCellsのみ）
  const outerCountByType: CountByType = zeroAxis();
  const touchCountByType: CountByType = zeroAxis();

  const outerHits: any[] = [];
  const touchHits: any[] = [];

  for (const p of extracted.normalPlanetCells) {
    const t = toPlanetType(p.planetKind as any, (p as any).colorKey);
    if (!t) continue;

    if (extracted.outerCells.has(p.key)) {
      outerCountByType[t] += 1;
      outerHits.push({
        cellKey: p.key,
        planetType: t,
        kind: (p as any).kind,
        slotId: (p as any).slotId,
        sectorId: (p as any).sectorId,
        tags: (p as any).tags ?? [],
      });
    }

    if (extracted.touchCells.has(p.key)) {
      touchCountByType[t] += 1;
      touchHits.push({
        cellKey: p.key,
        planetType: t,
        kind: (p as any).kind,
        slotId: (p as any).slotId,
        sectorId: (p as any).sectorId,
        tags: (p as any).tags ?? [],
      });
    }
  }

  const outerAxis = zeroAxis();
  const touchAxis = zeroAxis();
  for (const t of PLANET_TYPES) {
    outerAxis[t] = -wOuter * outerCountByType[t];
    touchAxis[t] = -wTouch * touchCountByType[t];
  }

  // scout（SSOT拡張: planetCellsを対象にして PROTO/ASTEROID も拾う）
  const scoutAxis: AxisByType = zeroAxis();
  const perScout: Array<{
    scoutKey: string;
    byType: AxisByType;
    total: number;
    extraByKind: Record<ScoutExtraKind, { total: number; hits: number }>;
  }> = [];
  const scoutHits: any[] = [];

  const distanceHistogram: Record<number, number> = {};

  const extraTotalByKind: Record<ScoutExtraKind, { total: number; hits: number }> = {
    PROTO: { total: 0, hits: 0 },
    ASTEROID: { total: 0, hits: 0 },
  };

  for (const s of extracted.scoutCells) {
    const byType = zeroAxis();

    const extraByKind: Record<ScoutExtraKind, { total: number; hits: number }> = {
      PROTO: { total: 0, hits: 0 },
      ASTEROID: { total: 0, hits: 0 },
    };

    // Scout targets: all non-excluded planets (includes PROTO/ASTEROID)
    for (const p of extracted.planetCells) {
      const t = toPlanetType(p.planetKind as any, (p as any).colorKey);

      const d = axialDistance(s.q, s.r, p.q, p.r);
      const contrib = scoutValue(d, wScout, scoutRadius);
      if (contrib <= 0) continue;

      if (t) {
        byType[t] += contrib;
        scoutAxis[t] += contrib;
      } else {
        const k = String((p as any).planetKind ?? "").toUpperCase();
        if (k === "PROTO" || k === "ASTEROID") {
          const kk = k as ScoutExtraKind;
          extraByKind[kk].total += contrib;
          extraByKind[kk].hits += 1;
          extraTotalByKind[kk].total += contrib;
          extraTotalByKind[kk].hits += 1;
        }
      }

      incNumRecord(distanceHistogram, d, 1);

      scoutHits.push({
        scoutKey: s.key,
        planetKey: p.key,
        planetType: t ?? "(EXTRA)",
        planetKind: (p as any).planetKind,
        distance: d,
        value: contrib,
        planet: {
          kind: (p as any).kind,
          slotId: (p as any).slotId,
          sectorId: (p as any).sectorId,
          tags: (p as any).tags ?? [],
        },
        scout: {
          kind: (s as any).kind,
          slotId: (s as any).slotId,
          sectorId: (s as any).sectorId,
          tags: (s as any).tags ?? [],
        },
      });
    }

    const total = axisValues(byType).reduce((a, b) => a + b, 0);
    perScout.push({ scoutKey: s.key, byType, total, extraByKind });
  }

  // scoutCore（現状0寄与）
  const scoutCoreAxis: AxisByType = zeroAxis();
  if (wScoutCore !== 0) {
    for (const t of PLANET_TYPES) scoutCoreAxis[t] = 0;
  }

  // deterministic ordering for debugging
  outerHits.sort((a: any, b: any) => String(a.cellKey).localeCompare(String(b.cellKey)));
  touchHits.sort((a: any, b: any) => String(a.cellKey).localeCompare(String(b.cellKey)));
  scoutHits.sort((a: any, b: any) => {
    const k = String(a.scoutKey).localeCompare(String(b.scoutKey));
    if (k !== 0) return k;
    return String(a.planetKey).localeCompare(String(b.planetKey));
  });

  // totals & imbalance（SSOT: BASIC色のみの totals の乖離のみが score）
  const planetTypeTotals = addAxis(addAxis(outerAxis, touchAxis), addAxis(scoutAxis, scoutCoreAxis));

  const values = axisValues(planetTypeTotals);
  const imbalanceValue = metric === "range" ? range(values) : std(values);
  const imbalanceScore = -wImbalance * imbalanceValue;

  const excludedPlanetCounts = collectExcludedPlanetCountsBestEffort(extracted);

  return {
    score: imbalanceScore,
    breakdown: {
      placementHash: extracted.placementHash,

      axesByType: { outer: outerAxis, touch: touchAxis, scout: scoutAxis, scoutCore: scoutCoreAxis },
      planetTypeTotals,
      imbalance: { metric, value: imbalanceValue, score: imbalanceScore },
      audit: {
        placementHash: extracted.placementHash,

        outerCountByType,
        touchCountByType,
        outerHits,
        touchHits,
        scout: {
          radius: scoutRadius,
          perScout,
          byType: scoutAxis,

          distanceHistogram,
          extraByKind: extraTotalByKind,
          excludedPlanetCounts,

          scoutHits,
        },
      },
      debug: (extracted as any).audit,
    },
  };
}
