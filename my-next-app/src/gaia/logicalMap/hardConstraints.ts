// src/gaia/logicalMap/hardConstraints.ts
import { buildOuterTouchSets, isOuterCell } from "./outerTouch";

export type Axial = { q: number; r: number };

export type LogicalCell = {
  pos: Axial;
  kind: string;
  planetType?: string | null;
  slotId: string;
  sectorId: string;
  localKey: string;
};

export type LogicalMap = {
  templateId: string;
  seed: number;
  cellsByKey: Map<string, LogicalCell>;
  placement: Array<{ slotId: string; sectorId: string; rot: number }>;
};

export type HardViolation = {
  ruleId: "H1" | "H2" | "H4";
  message: string;
  evidence?: any;
};

export type CenterMode = "NONE" | "CENTER_7_9" | "CENTER_8";

export type HardOptions = {
  // H1
  minSameColorDist: number; // default 3

  // H2
  outerSameColorMax: number; // default 2（UI入力）

  // H4
  centerMode: CenterMode; // UI選択
};

export type HardResult = {
  ok: boolean;
  violations: HardViolation[];
};

const BASIC_PLANET_TYPES = new Set([
  "BLACK",
  "BLUE",
  "BROWN",
  "ORANGE",
  "RED",
  "WHITE",
  "YELLOW",
]);

function isNormalPlanet(cell: LogicalCell): boolean {
  if (String(cell.kind).toLowerCase() !== "planet") return false;
  const pt = String(cell.planetType ?? "").toUpperCase();
  return BASIC_PLANET_TYPES.has(pt);
}

function hexDist(a: Axial, b: Axial): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = dq + dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}

/**
 * H1: 同色最短距離（通常惑星のみ）
 * 低コスト版：全ペア（惑星数が少ない前提）。探索が重いなら近傍チェック版へ差し替え可能。
 */
function checkH1(map: LogicalMap, minDist: number): HardViolation[] {
  const byType = new Map<string, LogicalCell[]>();

  for (const c of map.cellsByKey.values()) {
    if (!isNormalPlanet(c)) continue;
    const t = String(c.planetType ?? "").toUpperCase();
    const arr = byType.get(t) ?? [];
    arr.push(c);
    byType.set(t, arr);
  }

  const out: HardViolation[] = [];

  for (const [t, arr] of byType.entries()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const d = hexDist(arr[i].pos, arr[j].pos);
        if (d < minDist) {
          out.push({
            ruleId: "H1",
            message: `H1 violation: same color ${t} distance ${d} < ${minDist}`,
            evidence: {
              planetType: t,
              a: { pos: arr[i].pos, slotId: arr[i].slotId, sectorId: arr[i].sectorId, localKey: arr[i].localKey },
              b: { pos: arr[j].pos, slotId: arr[j].slotId, sectorId: arr[j].sectorId, localKey: arr[j].localKey },
            },
          });
          // 1件でもあれば不合格なので早期returnしてよい（探索高速化）
          return out;
        }
      }
    }
  }

  return out;
}

/**
 * H2: outer 同色上限（通常惑星のみ）
 * - outer集合は evaluate.ts の SSOT を参照（outerTouch.ts 経由）
 * - 色別にカウントして upper bound を適用
 */
function checkH2(map: LogicalMap, outerSameColorMax: number): HardViolation[] {
  const sets = buildOuterTouchSets(String(map.templateId));

  const counts = new Map<string, number>();
  for (const c of map.cellsByKey.values()) {
    if (!isNormalPlanet(c)) continue;
    if (!isOuterCell(sets, c)) continue;

    const t = String(c.planetType ?? "").toUpperCase();
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  for (const [t, n] of counts.entries()) {
    if (n > outerSameColorMax) {
      return [
        {
          ruleId: "H2",
          message: `H2 violation: outer same color ${t} count ${n} > ${outerSameColorMax}`,
          evidence: { planetType: t, count: n, outerSameColorMax },
        },
      ];
    }
  }

  return [];
}

/**
 * H4: 中央スロット制約
 * - 3人戦: {L7,L8,L9} を中央とみなすか、{L8} のみか、無しかを UI で選択
 * - 中央スロットでは Large 1-4 を必ず使用
 */
function checkH4(map: LogicalMap, centerMode: CenterMode): HardViolation[] {
  if (centerMode === "NONE") return [];

  const centerSlots = centerMode === "CENTER_8" ? new Set(["L8"]) : new Set(["L7", "L8", "L9"]);
  const requiredLargeIds = new Set(["01", "02", "03", "04"]); // SSOT: Large 1-4

  const placementBySlot = new Map<string, { sectorId: string }>();
  for (const p of map.placement ?? []) {
    placementBySlot.set(String((p as any).slotId), { sectorId: String((p as any).sectorId) });
  }

  for (const slotId of centerSlots) {
    const p = placementBySlot.get(slotId);
    if (!p) continue; // 念のため
    if (!requiredLargeIds.has(p.sectorId)) {
      return [
        {
          ruleId: "H4",
          message: `H4 violation: center slot ${slotId} must be one of Large 1-4 (01-04), got ${p.sectorId}`,
          evidence: { slotId, sectorId: p.sectorId, required: Array.from(requiredLargeIds) },
        },
      ];
    }
  }

  return [];
}

export function applyHardConstraints(map: LogicalMap, options?: Partial<HardOptions>): HardResult {
  const minSameColorDist = Number(options?.minSameColorDist ?? 3);
  const outerSameColorMax = Number(options?.outerSameColorMax ?? 2);
  const centerMode = (options?.centerMode ?? "NONE") as CenterMode;

  // 軽い順に（探索を想定）
  const vH4 = checkH4(map, centerMode);
  if (vH4.length) return { ok: false, violations: vH4 };

  const vH2 = checkH2(map, outerSameColorMax);
  if (vH2.length) return { ok: false, violations: vH2 };

  const vH1 = checkH1(map, minSameColorDist);
  if (vH1.length) return { ok: false, violations: vH1 };

  return { ok: true, violations: [] };
}
