// src/gaia/search.ts
//
// SSOT search pipeline:
// seed -> buildLogicalMap -> extractForEval -> checkHardConstraints -> evaluateSoft -> Top-K
//
import { buildLogicalMap } from "./logicalMap/buildLogicalMap";
import { extractForEval, type HardParams } from "./eval/extractForEval";
import { checkHardConstraints, type HardFailReason } from "./constraints";
import { evaluateSoft, type SoftParams, type SoftEvalResult } from "./eval/evaluateSoft";

// ★普段は必ず false
const DEBUG_DUMP_ALL_KEYS = false;
const DEBUG_DUMP_OUTER_AUDIT = false;

export type SearchOptions = {
  trials: number;
  keepTop: number;
  seedStart?: number;
  hard: HardParams;
  soft: SoftParams;
  yieldEvery?: number;
};

export type FailKey = HardFailReason | "BUILD_LOGICAL_MAP_FAILED" | "EXTRACT_FAILED";

export type RankedResult = {
  seed: number;
  score: number;

  // ★重要：評価した placement をそのまま返す（UIはこれを表示する）
  placement: Array<{ slotId: string; sectorId: string; rot: number; rot30?: number }>;

  // ★追跡用
  placementHash: string;

  breakdown: SoftEvalResult["breakdown"];
  audit: {
    placementHash: string;
    outerNormalCount: number;
    touchNormalCount: number;
  };

  hardSnapshot: HardParams;
  softSnapshot: SoftParams;
};

export type SearchDiagnostics = {
  trials: number;
  passedHard: number;
  hardFailBy: Record<FailKey, number>;
  options: SearchOptions;

  logicalMapAllKeys?: string[];
  outerAudit?: Array<{
    key: string;
    exists: boolean;
    kind?: string;
    tags: string[];
    planetType: string | null;
  }>;
};

function pushTopK(best: RankedResult[], cand: RankedResult, keepTop: number) {
  best.push(cand);
  best.sort((a, b) => b.score - a.score || a.seed - b.seed);
  if (best.length > keepTop) best.length = keepTop;
}

export async function runSearch(
  templateId: string,
  options: SearchOptions,
  onProgress?: (done: number, best: RankedResult[]) => void
): Promise<{ results: RankedResult[]; diagnostics: SearchDiagnostics }> {
  const seed0 = options.seedStart ?? 1;
  const yieldEvery = options.yieldEvery ?? 25;

  const hardFailBy: Record<FailKey, number> = {
    H1_MIN_DIST: 0,
    H2_OUTER_CAP: 0,
    H4_CENTER_LARGE14: 0,
    BUILD_LOGICAL_MAP_FAILED: 0,
    EXTRACT_FAILED: 0,
  };

  const best: RankedResult[] = [];
  let passedHard = 0;

  for (let i = 0; i < options.trials; i++) {
    const seed = seed0 + i;

    // 1) LogicalMap
    let logicalMap: any;
    try {
      logicalMap = buildLogicalMap({ seed, templateId });
    } catch {
      hardFailBy.BUILD_LOGICAL_MAP_FAILED += 1;
      if (onProgress && i % yieldEvery === 0) onProgress(i + 1, best);
      continue;
    }

    // ★評価に使った placement を確保（これをUIへ返す）
    const placement: Array<{ slotId: string; sectorId: string; rot: number; rot30?: number }> =
      Array.isArray(logicalMap?.placement) ? logicalMap.placement : [];

    if (DEBUG_DUMP_ALL_KEYS) {
      const allCellKeys = Array.from(logicalMap?.cellsByKey?.keys?.() ?? []);
      console.log("=== LOGICALMAP ALL CELL KEYS ===", { seed, count: allCellKeys.length });

      return {
        results: [],
        diagnostics: {
          trials: options.trials,
          passedHard,
          hardFailBy,
          options,
          logicalMapAllKeys: allCellKeys,
        },
      };
    }

    // 2) Extract
    let extracted: any;
    try {
      extracted = extractForEval(logicalMap, options.hard);
    } catch {
      hardFailBy.EXTRACT_FAILED += 1;
      if (onProgress && i % yieldEvery === 0) onProgress(i + 1, best);
      continue;
    }

    if (DEBUG_DUMP_OUTER_AUDIT) {
      const outerAudit: any[] = [];
      const outerKeys = extracted.outerCells instanceof Set ? Array.from(extracted.outerCells) : (extracted.outerCells ?? []);
      for (const key of outerKeys) {
        const cell = logicalMap?.cellsByKey?.get?.(key);
        outerAudit.push({
          key,
          exists: !!cell,
          kind: cell?.kind,
          tags: cell?.tags ?? [],
          planetType: cell?.planetKind ?? null,
        });
      }
      console.log("=== LOGICAL OUTER AUDIT ===", { seed, count: outerAudit.length });

      return {
        results: [],
        diagnostics: {
          trials: options.trials,
          passedHard,
          hardFailBy,
          options,
          outerAudit,
        },
      };
    }

    // 3) Hard（LogicalMap基準）
    const hard = checkHardConstraints(extracted, placement as any, options.hard);
    if (!hard.pass) {
      for (const r of hard.reasons) {
        hardFailBy[r.reason] = (hardFailBy[r.reason] ?? 0) + 1;
      }
      if (onProgress && i % yieldEvery === 0) onProgress(i + 1, best);
      continue;
    }
    passedHard += 1;

    // 4) Soft
    const evaluation = evaluateSoft(extracted, options.soft);

    const outerNormalCount =
      (evaluation.breakdown as any)?.audit?.outerCountByType
        ? Object.values((evaluation.breakdown as any).audit.outerCountByType).reduce((a: any, b: any) => a + Number(b || 0), 0)
        : 0;

    const touchNormalCount =
      (evaluation.breakdown as any)?.audit?.touchCountByType
        ? Object.values((evaluation.breakdown as any).audit.touchCountByType).reduce((a: any, b: any) => a + Number(b || 0), 0)
        : 0;

    const placementHash = String((evaluation.breakdown as any)?.placementHash ?? extracted.placementHash ?? "-");

    pushTopK(
      best,
      {
        seed,
        score: evaluation.score,
        placement, // ★ここが肝
        placementHash,
        breakdown: evaluation.breakdown,
        audit: { placementHash, outerNormalCount, touchNormalCount },
        hardSnapshot: options.hard,
        softSnapshot: options.soft,
      },
      options.keepTop
    );

    if (onProgress && i % yieldEvery === 0) onProgress(i + 1, best);
  }

  return {
    results: best,
    diagnostics: {
      trials: options.trials,
      passedHard,
      hardFailBy,
      options,
    },
  };
}
