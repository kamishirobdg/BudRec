// src/gaia/board/evaluate.ts
import { axialDistance } from "./axial";
import type { NormalizedBoard, NormalizedCell } from "./types";

/**
 * Outer/Touch ペナルティ（テンプレ不変座標：templateKey）
 *
 * 狙い:
 * - seed や盤面の (q,r) 原点ズレに影響されない外周評価を可能にする。
 *
 * 前提:
 * - BoardCell から NormalizedCell に slotId/localKey が伝播していること
 *   - templateKey = `${slotId}:${localKey}`
 * - localKey は sector.cells のキー（"dq,dr" ...）で安定
 *
 * 互換:
 * - OUTER/TOUCH に "q,r" 形式（coordKey）が残っていても、refBoard から templateKey に変換して利用する。
 */

export const BASIC_PLANET_TYPES = [
  "BLACK",
  "BLUE",
  "BROWN",
  "ORANGE",
  "RED",
  "WHITE",
  "YELLOW",
] as const;

export type BasicPlanetType = (typeof BASIC_PLANET_TYPES)[number];

const LEGACY_TO_BASIC: Record<string, BasicPlanetType> = {
  TITANIUM: "ORANGE",
  TERRA: "BLUE",
  OXIDE: "BROWN",
  SWAMP: "BLACK",
  VOLCANIC: "RED",
  ICE: "WHITE",
  DESERT: "YELLOW",
};

function normalizePlanetType(pt: string): string {
  return LEGACY_TO_BASIC[pt] ?? pt;
}

function normalizeKeyStr(s: string): string {
  return String(s).trim();
}

/**
 * Template-invariant key for a cell, if available.
 * Expectation: normalized cell carries `slotId` and `localKey`.
 */
function getTemplateKey(cell: NormalizedCell | any): string | null {
  const slotId = (cell as any)?.slotId;

  // Plan A: template-local offset from slot center ("dq,dr")
  const tplLocalKey = (cell as any)?.tplLocalKey;
  if (typeof slotId === "string" && typeof tplLocalKey === "string") {
    return `${slotId}:${normalizeKeyStr(tplLocalKey)}`;
  }

  // Legacy: sector-local key ("dq,dr" in tile coords). This may vary with sector selection.
  const localKey = (cell as any)?.localKey;
  if (typeof slotId === "string" && typeof localKey === "string") {
    return `${slotId}:${normalizeKeyStr(localKey)}`;
  }

  // Fallback: some pipelines may already provide templateKey.
  const tk = (cell as any)?.templateKey;
  if (typeof tk === "string" && tk.includes(":")) return normalizeKeyStr(tk);

  return null;
}

function buildTemplateKeyIndex(board: NormalizedBoard | any): Map<string, any> {
  const idx = new Map<string, any>();
  const cells: any[] = Array.isArray(board?.cells) ? board.cells : [];
  for (const c of cells) {
    const tk = getTemplateKey(c);
    if (tk) idx.set(tk, c);
  }
  return idx;
}

export const OUTER_CELLS_BY_TEMPLATE: Record<string, readonly string[]> = {
  // TODO: templateId ごとに coordKey("q,r") を列挙
  // "3p_base": ["0,0", "1,0", ...],
  // 3p Lost Fleet（Template Inspector: CopyOuterSet の結果）
  "3p_lostFleet": [
"0,11",
"0,12",
"0,13",
"0,14",
"0,15",
"1,10",
"1,15",
"1,8",
"1,9",
"10,0",
"10,13",
"11,0",
"11,12",
"12,-1",
"12,11",
"13,-2",
"13,10",
"14,-2",
"14,10",
"15,-1",
"15,-2",
"15,0",
"15,1",
"15,2",
"15,3",
"15,9",
"16,3",
"16,4",
"16,8",
"17,4",
"17,7",
"18,4",
"18,5",
"18,6",
"2,15",
"2,16",
"2,7",
"3,16",
"3,6",
"4,16",
"4,5",
"5,16",
"5,4",
"6,16",
"6,4",
"7,15",
"7,3",
"8,14",
"8,2",
"9,1",
"9,14",
  ],
};

export const TOUCH_CELLS_BY_TEMPLATE: Record<string, readonly string[]> = {
  // TODO: templateId ごとに coordKey("q,r") を列挙（任意）
  // 未定義の場合は Outer 近傍から派生
  "3p_lostFleet": [
"1,11",
"1,12",
"1,13",
"1,14",
"10,1",
"10,12",
"11,1",
"11,11",
"12,0",
"12,10",
"13,-1",
"13,9",
"14,-1",
"14,0",
"14,1",
"14,2",
"14,3",
"14,4",
"14,9",
"15,4",
"15,5",
"15,8",
"16,5",
"16,7",
"17,5",
"17,6",
"2,10",
"2,14",
"2,8",
"2,9",
"3,14",
"3,15",
"3,7",
"4,15",
"4,6",
"5,15",
"5,5",
"6,15",
"6,5",
"7,14",
"7,4",
"8,13",
"8,3",
"9,13",
"9,2",
  ],
};

const derivedTouchCache = new Map<string, Set<string>>();

/**
 * Outer set expressed in templateKey space.
 *
 * Backward compatibility:
 * - If an entry does NOT contain ':', it is treated as coordKey("q,r") and
 *   mapped to templateKey via refBoard (e.g. seed0 board).
 */
function getOuterSet(templateId: string, refBoard: NormalizedBoard): Set<string> {
  const arr = OUTER_CELLS_BY_TEMPLATE[templateId] ?? [];
  const out = new Set<string>();
  for (const raw of arr) {
    const s = normalizeKeyStr(raw);
    if (!s) continue;
    if (s.includes(":")) {
      out.add(s);
      continue;
    }
    const c = refBoard.cellByCoord.get(s);
    const tk = c ? getTemplateKey(c as any) : null;
    if (tk) out.add(tk);
  }
  return out;
}

function getTouchSet(templateId: string, refBoard: NormalizedBoard, outerTks: Set<string>): Set<string> {
  const explicit = TOUCH_CELLS_BY_TEMPLATE[templateId];
  if (explicit) {
    const out = new Set<string>();
    for (const raw of explicit) {
      const s = normalizeKeyStr(raw);
      if (!s) continue;
      if (s.includes(":")) {
        out.add(s);
      } else {
        const c = refBoard.cellByCoord.get(s);
        const tk = c ? getTemplateKey(c as any) : null;
        if (tk) out.add(tk);
      }
    }
    return out;
  }

  const cached = derivedTouchCache.get(templateId);
  if (cached) return cached;

  const idx = buildTemplateKeyIndex(refBoard);
  const touch = new Set<string>(outerTks);

  for (const tk of outerTks) {
    const cell: any = idx.get(tk);
    if (!cell) continue;

    // Prefer templateNeighbors if upstream provides it.
    const tns: unknown = (cell as any).templateNeighbors;
    if (Array.isArray(tns) && tns.every((x) => typeof x === "string" && (x as string).includes(":"))) {
      for (const ntk of tns as string[]) touch.add(normalizeKeyStr(ntk));
      continue;
    }

    // Fallback: derive from coordKey neighbors.
    const ns: unknown = (cell as any).neighbors;
    if (Array.isArray(ns)) {
      for (const nk of ns as string[]) {
        const nc = refBoard.cellByCoord.get(normalizeKeyStr(nk));
        const ntk = nc ? getTemplateKey(nc as any) : null;
        if (ntk) touch.add(ntk);
      }
    }
  }

  derivedTouchCache.set(templateId, touch);
  return touch;
}

export type EvalOuterPenaltyOptions = {
  /** Outer の重み（減点係数）。penalty = -w * count */
  wOuter?: number;
  /** Touch の重み（減点係数）。penalty = -w * count */
  wTouch?: number;
  /** Touch 派生用の参照ボード（例：SEED=0盤面）。未指定なら現在の board を使う */
  refBoard?: NormalizedBoard;
};

export type EvalOptions = {
  // 評価対象外 planetType
  excludePlanetTypes?: Set<string>; // ex: new Set(["GAIA","TRANSDIM","EMPTY"])
  // kind によるフィルタ
  includeKinds?: Set<string>; // ex: new Set(["planet"])
  // 距離2以内などの閾値
  nearThreshold?: number; // default 2

  // Outer/Touch penalty（SOFT）
  outerPenalty?: EvalOuterPenaltyOptions;
};

export type DistanceMetricsByPlanetType = {
  planetType: string;
  count: number; // セル数
  pairCount: number; // ペア数
  minDist: number | null;
  avgDist: number | null;
  withinThresholdPairs: number; // 閾値以内のペア数
};

export type AdjacencyMetricsByPlanetType = {
  planetType: string;
  degreeSum: number; // 同タイプ近傍の総数（各セルの同タイプ近傍数の合計）
  edgesSameType: number; // 同タイプ隣接エッジ数（重複除去済み）
  edgesDifferentType: number; // 異タイプ隣接エッジ数（重複除去済み、相手が評価対象内の場合）
};

export type DispersionMetricsByPlanetType = {
  planetType: string;
  count: number;
  centroidQ: number | null;
  centroidR: number | null;
  avgDistToCentroid: number | null;
  varDistToCentroid: number | null;
};

export type BoardEvaluation = {
  templateId: string;
  options: Required<Pick<EvalOptions, "nearThreshold">> & Omit<EvalOptions, "nearThreshold">;

  distanceByPlanetType: DistanceMetricsByPlanetType[];
  adjacencyByPlanetType: AdjacencyMetricsByPlanetType[];
  dispersionByPlanetType: DispersionMetricsByPlanetType[];

  // Outer / Touch（基本7種のみ）
  outerPlanetCountByPlanetType: Array<{ planetType: BasicPlanetType; count: number }>;
  touchPlanetCountByPlanetType: Array<{ planetType: BasicPlanetType; count: number }>;

  // 全体サマリ（まずは最小）
  summary: {
    planetCellCount: number;
    edgesPlanetPlanet: number;
    edgesSameType: number;
    edgesDifferentType: number;

    outerPlanetCountAll: number;
    touchPlanetCountAll: number;
    penaltyOuter: number;
    penaltyTouch: number;
    penaltyOuterTouchTotal: number;

    // 観測用（coordKey が効かない原因切り分け）
    outerKeysTotal: number;
    outerKeysHit: number;
    outerKeysMissingSample: string[];
    touchKeysTotal: number;
    touchKeysHit: number;
  };
};

// 互換: 旧コードが isEvaluatedPlanetCellRaw を呼んでいる場合に備える
function isEvaluatedPlanetCellRaw(c: NormalizedCell, opt: Required<EvalOptions>): boolean {
  return isEvaluatedPlanetCell(c, opt);
}


function isEvaluatedPlanetCell(c: NormalizedCell, opt: Required<EvalOptions>): boolean {
  if (opt.includeKinds && !opt.includeKinds.has(c.kind)) return false;
  if (!c.planetType) return false;
  if (opt.excludePlanetTypes.has(c.planetType)) return false;
  if (c.planetType === "UNKNOWN") return false;
  return true;
}

function normalizeOptions(options: EvalOptions): Required<EvalOptions> {
  return {
    excludePlanetTypes: options.excludePlanetTypes ?? new Set(["GAIA", "TRANSDIM", "EMPTY"]),
    includeKinds: options.includeKinds ?? new Set(["planet"]),
    nearThreshold: options.nearThreshold ?? 2,
    outerPenalty: options.outerPenalty ?? {},
  };
}

export function evaluateBoard(board: NormalizedBoard, options: EvalOptions = {}): BoardEvaluation {
  const opt = normalizeOptions(options);

  const planetCells = board.cells.filter((c) => isEvaluatedPlanetCell(c, opt));

  // グルーピング
  const byType = new Map<string, NormalizedCell[]>();
  for (const c of planetCells) {
    const pt = c.planetType!;
    const arr = byType.get(pt) ?? [];
    arr.push(c);
    byType.set(pt, arr);
  }

  const distanceByPlanetType: DistanceMetricsByPlanetType[] = [];
  const dispersionByPlanetType: DispersionMetricsByPlanetType[] = [];

  // 距離＆分散（planetType別）
  for (const [pt, arr] of byType) {
    const n = arr.length;

    // 距離ペア計算（O(n^2)）
    let pairCount = 0;
    let minDist = Infinity;
    let sumDist = 0;
    let within = 0;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        pairCount++;
        const d = axialDistance(arr[i], arr[j]);
        sumDist += d;
        if (d < minDist) minDist = d;
        if (d <= opt.nearThreshold) within++;
      }
    }

    distanceByPlanetType.push({
      planetType: pt,
      count: n,
      pairCount,
      minDist: pairCount > 0 ? minDist : null,
      avgDist: pairCount > 0 ? sumDist / pairCount : null,
      withinThresholdPairs: within,
    });

    // 分散（重心からの距離）
    if (n === 0) {
      dispersionByPlanetType.push({
        planetType: pt,
        count: 0,
        centroidQ: null,
        centroidR: null,
        avgDistToCentroid: null,
        varDistToCentroid: null,
      });
    } else {
      const cq = arr.reduce((s, c) => s + c.q, 0) / n;
      const cr = arr.reduce((s, c) => s + c.r, 0) / n;

      // 重心は整数座標ではないが、距離評価は近似で十分（将来改善余地あり）
      // ここでは「重心の小数座標」を基準に L∞(cube) 距離に相当する axialDistance が使えないため、
      // 近似としてユークリッドではなく「roundした軸へ寄せる」方式を採用。
      const cqR = Math.round(cq);
      const crR = Math.round(cr);

      const dists: number[] = arr.map((c) => axialDistance(c, { q: cqR, r: crR }));
      const avg = dists.reduce((s, x) => s + x, 0) / n;
      const variance = dists.reduce((s, x) => s + (x - avg) * (x - avg), 0) / n;

      dispersionByPlanetType.push({
        planetType: pt,
        count: n,
        centroidQ: cq,
        centroidR: cr,
        avgDistToCentroid: avg,
        varDistToCentroid: variance,
      });
    }
  }

  // 隣接（エッジ数を重複除去して数える）
  // - planet-planet の隣接を片側だけ数えるため、coordKeyを比較して小さい方からのみカウント
  const adjacencyAgg = new Map<string, AdjacencyMetricsByPlanetType>();
  const edgeSeen = new Set<string>();

  let edgesPlanetPlanet = 0;
  let edgesSameType = 0;
  let edgesDifferentType = 0;

  for (const c of planetCells) {
    const pt = c.planetType!;
    if (!adjacencyAgg.has(pt)) {
      adjacencyAgg.set(pt, {
        planetType: pt,
        degreeSum: 0,
        edgesSameType: 0,
        edgesDifferentType: 0,
      });
    }

    for (const nk of c.neighbors) {
      const other = board.cellByCoord.get(nk);
      if (!other) continue;
      if (!isEvaluatedPlanetCell(other, opt)) continue;

      // エッジキー（重複除去）
      const a = c.coordKey < other.coordKey ? c.coordKey : other.coordKey;
      const b = c.coordKey < other.coordKey ? other.coordKey : c.coordKey;
      const ek = `${a}|${b}`;
      if (edgeSeen.has(ek)) continue;
      edgeSeen.add(ek);

      edgesPlanetPlanet++;

      const otherPt = other.planetType!;
      const isSame = otherPt === pt;

      if (isSame) {
        edgesSameType++;
        // 同タイプのエッジは該当typeに加算
        adjacencyAgg.get(pt)!.edgesSameType += 1;
      } else {
        edgesDifferentType++;
        // 異タイプは両方のtypeに加算（“自タイプが他タイプと何本接しているか”）
        adjacencyAgg.get(pt)!.edgesDifferentType += 1;
        if (!adjacencyAgg.has(otherPt)) {
          adjacencyAgg.set(otherPt, {
            planetType: otherPt,
            degreeSum: 0,
            edgesSameType: 0,
            edgesDifferentType: 0,
          });
        }
        adjacencyAgg.get(otherPt)!.edgesDifferentType += 1;
      }
    }
  }

  // degreeSum（同タイプ近傍数の総和）を別途計算（表示用に便利）
  for (const [pt, arr] of byType) {
    let sum = 0;
    for (const c of arr) {
      let sameNeighbors = 0;
      for (const nk of c.neighbors) {
        const other = board.cellByCoord.get(nk);
        if (!other) continue;
        if (!isEvaluatedPlanetCell(other, opt)) continue;
        if (other.planetType === pt) sameNeighbors++;
      }
      sum += sameNeighbors;
    }
    const m = adjacencyAgg.get(pt);
    if (m) m.degreeSum = sum;
  }

  const adjacencyByPlanetType = Array.from(adjacencyAgg.values()).sort((a, b) =>
    a.planetType.localeCompare(b.planetType)
  );

  distanceByPlanetType.sort((a, b) => a.planetType.localeCompare(b.planetType));
  dispersionByPlanetType.sort((a, b) => a.planetType.localeCompare(b.planetType));

  // Outer / Touch（基本7種のみ）
  // Template-invariant outer/touch:
  // - OuterSet is defined in templateKey space.
  // - TouchSet is derived in templateKey space using refBoard's adjacency.
  //   (refBoard is typically a fixed-seed board for the template.)
  const refBoard = opt.outerPenalty?.refBoard ?? board;
  const outerSet = getOuterSet(board.templateId, refBoard);
  const touchSet = getTouchSet(board.templateId, refBoard, outerSet);

  const outerCount: Record<BasicPlanetType, number> = {
    BLACK: 0,
    BLUE: 0,
    BROWN: 0,
    ORANGE: 0,
    RED: 0,
    WHITE: 0,
    YELLOW: 0,
  };

  const touchCount: Record<BasicPlanetType, number> = {
    BLACK: 0,
    BLUE: 0,
    BROWN: 0,
    ORANGE: 0,
    RED: 0,
    WHITE: 0,
    YELLOW: 0,
  };

  // Count on the actual board (seed-dependent placement), but check membership by templateKey.
  const countBoard = board;
  const countPlanetCells: NormalizedCell[] = [];
  for (const c of countBoard.cells) {
    if (!isEvaluatedPlanetCellRaw(c, opt)) continue;
    const pt = normalizePlanetType(c.planetType!);
    countPlanetCells.push({ ...(c as any), planetType: pt });
  }

  // Diagnostics: templateKey hit ratio (useful to detect missing origin fields).
  const idxCount = buildTemplateKeyIndex(countBoard);
  let outerKeysHit = 0;
  const outerKeysMissingSample: string[] = [];
  for (const tk of outerSet) {
    if (idxCount.has(tk)) outerKeysHit++;
    else if (outerKeysMissingSample.length < 8) outerKeysMissingSample.push(tk);
  }
  let touchKeysHit = 0;
  for (const tk of touchSet) {
    if (idxCount.has(tk)) touchKeysHit++;
  }

  for (const c of countPlanetCells) {
    const raw = c.planetType!;
    const pt = raw; // 既に正規化済み
    if (!BASIC_PLANET_TYPES.includes(pt as any)) continue;
    const bpt = pt as BasicPlanetType;

    const tk = getTemplateKey(c as any);
    if (!tk) continue;
    if (outerSet.has(tk)) outerCount[bpt] += 1;
    if (touchSet.has(tk)) touchCount[bpt] += 1;
  }

  const outerPlanetCountByPlanetType = BASIC_PLANET_TYPES.map((pt) => ({ planetType: pt, count: outerCount[pt] }));
  const touchPlanetCountByPlanetType = BASIC_PLANET_TYPES.map((pt) => ({ planetType: pt, count: touchCount[pt] }));

  const outerPlanetCountAll = outerPlanetCountByPlanetType.reduce((s, x) => s + x.count, 0);
  const touchPlanetCountAll = touchPlanetCountByPlanetType.reduce((s, x) => s + x.count, 0);

  const wOuter = Number(opt.outerPenalty?.wOuter ?? 0);
  const wTouch = Number(opt.outerPenalty?.wTouch ?? 0);
  const penaltyOuter = -wOuter * outerPlanetCountAll;
  const penaltyTouch = -wTouch * touchPlanetCountAll;
  const penaltyOuterTouchTotal = penaltyOuter + penaltyTouch;

  return {
    templateId: board.templateId,
    options: opt,
    distanceByPlanetType,
    adjacencyByPlanetType,
    dispersionByPlanetType,
    outerPlanetCountByPlanetType,
    touchPlanetCountByPlanetType,
    summary: {
      planetCellCount: planetCells.length,
      edgesPlanetPlanet,
      edgesSameType,
      edgesDifferentType,
templateId: board.templateId,
      outerPlanetCountAll,
      touchPlanetCountAll,
      penaltyOuter,
      penaltyTouch,
      penaltyOuterTouchTotal,

      outerKeysTotal: outerSet.size,
      outerKeysHit,
      outerKeysMissingSample,
      touchKeysTotal: touchSet.size,
      touchKeysHit,
    },
  };
}
