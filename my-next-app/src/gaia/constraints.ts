// src/gaia/constraints.ts
import type { ExtractedForEval, HardParams } from "./eval/extractForEval";
import { axialDistance } from "./hex";

export type HardFailReason = "H1_MIN_DIST" | "H2_OUTER_CAP" | "H4_CENTER_LARGE14";

export type HardCheckResult =
  | { pass: true }
  | { pass: false; reasons: Array<{ reason: HardFailReason; detail: string }> };

export function checkHardConstraints(
  extracted: ExtractedForEval,
  placement: Array<{ slotId: string; sectorId: string; rot: number; rotSeed?: number }>,
  params: HardParams
): HardCheckResult {
  const reasons: Array<{ reason: HardFailReason; detail: string }> = [];

  const h1 = checkH1MinDist(extracted, params.minSameColorDist);
  if (!h1.pass) reasons.push(...h1.reasons);

  const h2 = checkH2OuterColorCap(extracted, params.outerSameColorMax);
  if (!h2.pass) reasons.push(...h2.reasons);

  const h4 = checkH4CenterLarge14(extracted, placement, params.centerMode);
  if (!h4.pass) reasons.push(...h4.reasons);

  return reasons.length ? { pass: false, reasons } : { pass: true };
}

export function checkH1MinDist(extracted: ExtractedForEval, minDist: number): HardCheckResult {
  const reasons: Array<{ reason: HardFailReason; detail: string }> = [];

  // SSOT: LogicalMap抽出(normalPlanetCells)から色別に再構成して判定する
  // - extracted.normalPlanetsByColor が欠けていても Hard が無効化されないようにする
  const cells = Array.isArray((extracted as any)?.normalPlanetCells) ? ((extracted as any).normalPlanetCells as any[]) : [];

  const byColor: Record<string, Array<{ q: number; r: number; key?: string }>> = {};
  for (const c of cells) {
    const ck = String((c as any)?.colorKey ?? "");
    if (!ck) continue;
    const q = Number((c as any)?.q);
    const r = Number((c as any)?.r);
    if (!Number.isFinite(q) || !Number.isFinite(r)) continue;
    (byColor[ck] ??= []).push({ q, r, key: (c as any)?.key });
  }

  for (const [color, list] of Object.entries(byColor)) {
    let best = Infinity;
    let bestPair: { a?: string; b?: string; d?: number } | null = null;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = axialDistance(list[i].q, list[i].r, list[j].q, list[j].r);
        if (d < best) {
          best = d;
          bestPair = { a: list[i].key, b: list[j].key, d };
        }
        if (best < minDist) break;
      }
      if (best < minDist) break;
    }

    if (best < minDist) {
      const a = bestPair?.a ?? "?";
      const b = bestPair?.b ?? "?";
      const d = bestPair?.d ?? best;
      reasons.push({
        reason: "H1_MIN_DIST",
        detail: `color=${color} minDist=${d} < ${minDist} (pair ${a} - ${b})`,
      });
    }
  }

  return reasons.length ? { pass: false, reasons } : { pass: true };
}

export function checkH2OuterColorCap(extracted: ExtractedForEval, cap: number): HardCheckResult {
  const reasons: Array<{ reason: HardFailReason; detail: string }> = [];

  const cntByColor: Record<string, number> = {};
  for (const cell of extracted.normalPlanetCells ?? []) {
    if (!extracted.outerCells?.has?.(cell.key)) continue;
    const ck = cell.colorKey!;
    cntByColor[ck] = (cntByColor[ck] ?? 0) + 1;
  }

  for (const [color, cnt] of Object.entries(cntByColor)) {
    if (cnt > cap) {
      reasons.push({
        reason: "H2_OUTER_CAP",
        detail: `color=${color} outerCnt=${cnt} > cap=${cap}`,
      });
    }
  }

  return reasons.length ? { pass: false, reasons } : { pass: true };
}

export function checkH4CenterLarge14(
  extracted: ExtractedForEval,
  placement: Array<{ slotId: string; sectorId: string; rot: number }>,
  centerMode: HardParams["centerMode"]
): HardCheckResult {
  if (centerMode === "NONE") return { pass: true };

  const reasons: Array<{ reason: HardFailReason; detail: string }> = [];
  const mustBe = new Set(["01", "02", "03", "04"]);

  for (const p of placement ?? []) {
    if (!extracted.centralSlotIds?.has?.(p.slotId)) continue;
    const sid = String(p.sectorId).padStart(2, "0");
    if (!mustBe.has(sid)) {
      reasons.push({
        reason: "H4_CENTER_LARGE14",
        detail: `slot=${p.slotId} sector=${sid} not in {01..04}`,
      });
    }
  }

  return reasons.length ? { pass: false, reasons } : { pass: true };
}
