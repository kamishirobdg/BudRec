// src/gaia/logicalMap/evaluateLogicalMap.ts
import type { LogicalMap } from "./buildLogicalMap";
import { extractForEval, type HardParams } from "../eval/extractForEval";

export type EvalOuterTouchPenaltyOptions = {
  wOuter: number;
  wTouch: number;
};

export type EvaluateLogicalMapOptions = {
  hardParams: HardParams; // centerMode等のSSOTをここで渡す（extractで必要）
  outerTouchPenalty?: Partial<EvalOuterTouchPenaltyOptions>;
};

export type EvalOuterTouchPenaltyBreakdown = {
  outerPlanetCountAll: number;
  touchPlanetCountAll: number;
  penaltyOuter: number;
  penaltyTouch: number;
  penaltyTotal: number;
};

export type EvalBreakdown = {
  outerTouchPenalty: EvalOuterTouchPenaltyBreakdown;
};

export type EvalResult = {
  total: number;
  breakdown: EvalBreakdown;
};

export function evaluateLogicalMap(logicalMap: LogicalMap, opts: EvaluateLogicalMapOptions): EvalResult {
  const extracted = extractForEval(logicalMap, opts.hardParams);

  const wOuter = Number(opts?.outerTouchPenalty?.wOuter ?? 0);
  const wTouch = Number(opts?.outerTouchPenalty?.wTouch ?? 0);

  const outerPlanetCountAll = extracted.audit.outerNormalCount;
  const touchPlanetCountAll = extracted.audit.touchNormalCount;

  const penaltyOuter = -wOuter * outerPlanetCountAll;
  const penaltyTouch = -wTouch * touchPlanetCountAll;
  const penaltyTotal = penaltyOuter + penaltyTouch;

  return {
    total: penaltyTotal,
    breakdown: {
      outerTouchPenalty: {
        outerPlanetCountAll,
        touchPlanetCountAll,
        penaltyOuter,
        penaltyTouch,
        penaltyTotal,
      },
    },
  };
}
