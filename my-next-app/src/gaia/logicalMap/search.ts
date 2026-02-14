// src/gaia/logicalMap/search.ts
import { buildLogicalMap } from "./buildLogicalMap";
import { applyHardConstraints, type CenterMode, type HardViolation } from "./hardConstraints";
import { evaluateLogicalMap, type EvalResult } from "./evaluateLogicalMap";

export type SearchOptions = {
  templateId: string;

  // Hard (SSOT)
  minSameColorDist?: number;     // H1 default 3
  outerSameColorMax?: number;    // H2 default 2 (UI入力)
  centerMode?: CenterMode;       // H4 default "NONE" | "CENTER_7_9" | "CENTER_8"

  // Soft (Outer/Touch penalty)
  wOuter?: number;               // default 0
  wTouch?: number;               // default 0

  // perf
  yieldEvery?: number;           // default 0
};

export type SearchResult = {
  seed: string;
  logicalMap: any;
  hardOk: true;
  evaluation: EvalResult;
};

export type SearchDiagnostics = {
  trials: number;
  rejectCounts: {
    buildLogicalMapFailed: number;
    hardH1: number;
    hardH2: number;
    hardH4: number;
  };
  firstBuildError?: { seed: string; message: string };
  firstHardViolation?: { seed: string; violation: HardViolation };
  options: SearchOptions;
};

export async function runSearch(
  options: SearchOptions,
  trials: number,
  keepTop: number,
  onProgress?: (done: number, best: SearchResult[]) => void
): Promise<{ results: SearchResult[]; diagnostics: SearchDiagnostics }> {
  const rejectCounts = {
    buildLogicalMapFailed: 0,
    hardH1: 0,
    hardH2: 0,
    hardH4: 0,
  };

  let firstBuildError: SearchDiagnostics["firstBuildError"];
  let firstHardViolation: SearchDiagnostics["firstHardViolation"];

  const best: SearchResult[] = [];

  const yieldEvery = options.yieldEvery ?? 0;
  const templateId = String(options.templateId);

  for (let i = 0; i < trials; i++) {
    const seed = `${i}_0`;

    // 1) build logical map
    let lm: any;
    try {
      lm = buildLogicalMap({ templateId, seed });
    } catch (e: any) {
      rejectCounts.buildLogicalMapFailed++;
      if (!firstBuildError) firstBuildError = { seed, message: String(e?.message ?? e) };

      if (onProgress && i % 25 === 0) onProgress(i + 1, best);
      if (yieldEvery && i % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
      continue;
    }

    // 2) hard constraints
    const hard = applyHardConstraints(lm, {
      minSameColorDist: options.minSameColorDist ?? 3,
      outerSameColorMax: options.outerSameColorMax ?? 2,
      centerMode: options.centerMode ?? "NONE",
    });

    if (!hard.ok) {
      const v = hard.violations[0];
      if (!firstHardViolation) firstHardViolation = { seed, violation: v };

      if (v.ruleId === "H1") rejectCounts.hardH1++;
      else if (v.ruleId === "H2") rejectCounts.hardH2++;
      else if (v.ruleId === "H4") rejectCounts.hardH4++;

      if (onProgress && i % 25 === 0) onProgress(i + 1, best);
      if (yieldEvery && i % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
      continue;
    }

    // 3) soft eval (currently outer/touch penalties only)
    const evaluation = evaluateLogicalMap(lm, {
      outerTouchPenalty: {
        wOuter: options.wOuter ?? 0,
        wTouch: options.wTouch ?? 0,
      },
    });

    // 4) keep top
    best.push({ seed, logicalMap: lm, hardOk: true, evaluation });
    best.sort((a, b) => b.evaluation.total - a.evaluation.total);
    if (best.length > keepTop) best.length = keepTop;

    if (onProgress && i % 25 === 0) onProgress(i + 1, best);
    if (yieldEvery && i % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
  }

  return {
    results: best,
    diagnostics: {
      trials,
      rejectCounts,
      firstBuildError,
      firstHardViolation,
      options,
    },
  };
}
