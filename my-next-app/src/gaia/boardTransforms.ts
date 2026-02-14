// src/GAIA/boardTransforms.ts
import type { Axial, Cell, SectorTileDef } from "./sectorTypes";
import { add, rotate60, key as axialKey } from "./axialMath";
import { axialToPixel, type HexOrientation } from "./hexLayout";

export type SectorPlacement = {
  sectorId: string;
  pos: Axial;   // slot center (logic space, before viewRot)
  rot: number;  // 0..5 (tile rotation)
};

export type LogicBoard = {
  // FINAL: view space coordinates (after viewRot)
  cells: ReadonlyMap<string, Cell>;
};

export type ColumnShiftRule = {
  // 1-based column index -> r shift (+ down)
  shiftsByIndex1: Record<number, number>;
};

export type BuildOptions = {
  viewRot60: number;          // 0..5
  viewMirror: boolean;        // currently false

  orientationForColumnOrder: HexOrientation; // "flat"
  sizeForColumnOrder: number;                // 28 etc (match rendering)

  rule: ColumnShiftRule;
};

function parseKey(k: string): Axial {
  const [q, r] = k.split(",").map(Number);
  return { q, r };
}

function normRot(rot: number): number {
  // Defensive: treat NaN/Infinity as 0 to avoid propagating NaNs into rotate60
  // (which later manifests as "NaN,NaN" collisions).
  if (!Number.isFinite(rot)) return 0;
  return ((rot % 6) + 6) % 6;
}

function snap(v: number, step = 1e-3): number {
  return Math.round(v / step) * step;
}

function sub(a: Axial, b: Axial): Axial {
  return { q: a.q - b.q, r: a.r - b.r };
}

/**
 * タイル単位の「列オフセット」を rot0 の見た目基準で適用し、
 * その“オフセット済み形状”に対して tile rot をかける。
 *
 * 重要: rot によってタイルの“基準点”が動くのを防ぐため、
 * local(0,0) が変換後も原点に来るようにアンカー補正（平行移動）を入れる。
 */
function buildTileCellsWithOffsetThenRot_Anchored(
  def: SectorTileDef,
  placement: SectorPlacement,
  opt: BuildOptions
): Map<string, Cell> {
  const viewRot = normRot(opt.viewRot60);
  const tileRot = normRot(placement.rot);

  // Defensive: size/orientation must be valid to compute stable column order.
  // When misconfigured, axialToPixel can yield NaN which serializes to null and
  // breaks the anchor/column detection (e.g., uniqueX=[null]).
  const sizeForOrder = Number.isFinite(opt.sizeForColumnOrder) && opt.sizeForColumnOrder > 0
    ? opt.sizeForColumnOrder
    : 1;
  const orientForOrder: HexOrientation = (opt.orientationForColumnOrder ?? "flat") as HexOrientation;

  // ----
  // 1) local -> view0（rot0基準）へ写す & x を計算
  // ----
  const items: Array<{ cell: Cell; view0: Axial; xSnap: number; local: Axial }> = [];
  for (const [k, cell] of Object.entries(def.cells)) {
    const local = parseKey(k);
    const view0 = rotate60(local, viewRot);
    const { x } = axialToPixel(view0, sizeForOrder, orientForOrder);
    items.push({ cell, view0, xSnap: snap(x), local });
  }

  // タイル内の列（x）を 1..N に割当
  const uniqueX = Array.from(
    new Set(items.map((it) => it.xSnap).filter((v) => Number.isFinite(v)))
  ).sort((a, b) => a - b);

  // ----
  // 2) (0,0) のアンカーが「列オフセット＋rot」後にどこへ行くか計算
  // ----
  const anchorLocal0: Axial = { q: 0, r: 0 };
  const anchorView0 = rotate60(anchorLocal0, viewRot);
  const { x: anchorX } = axialToPixel(anchorView0, sizeForOrder, orientForOrder);
  const anchorXSnap = snap(anchorX);

  // Determine anchor column.
  // If uniqueX is empty (misconfiguration or degenerate geometry), fall back to col=1.
  // If anchor isn't found due to rounding mismatch, snap to the nearest column instead of throwing.
  let anchorCol1 = 1;
  if (uniqueX.length > 0) {
    const exact = uniqueX.indexOf(anchorXSnap);
    if (exact >= 0) {
      anchorCol1 = exact + 1;
    } else {
      let bestI = 0;
      let bestD = Math.abs(uniqueX[0] - anchorXSnap);
      for (let i = 1; i < uniqueX.length; i++) {
        const d = Math.abs(uniqueX[i] - anchorXSnap);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      anchorCol1 = bestI + 1;
    }
  }

  const anchorShift = opt.rule.shiftsByIndex1[anchorCol1] ?? 0;
  const anchorView0Shifted: Axial = { q: anchorView0.q, r: anchorView0.r + anchorShift };
  const anchorLocalShifted = rotate60(anchorView0Shifted, -viewRot);

  // ここで rot を掛けた後の「アンカー位置」
  const anchorAfterAll = rotate60(anchorLocalShifted, tileRot);

  // ----
  // 3) 各セルへ列オフセットを適用し、local に戻してから rot
  // ----
  const tileCells = new Map<string, Cell>();

  for (const it of items) {
    const col1 = uniqueX.indexOf(it.xSnap) + 1;
    const shift = opt.rule.shiftsByIndex1[col1] ?? 0;

    // view0 空間で「下げ」（r+=shift）
    const view0Shifted: Axial = { q: it.view0.q, r: it.view0.r + shift };

    // local に戻す（rot0基準のオフセット確定）
    const localShifted = rotate60(view0Shifted, -viewRot);

    // rot を適用
    const pTile = rotate60(localShifted, tileRot);

    // ----
    // 4) アンカー補正：local(0,0) が常に (0,0) になるよう平行移動
    // ----
    const anchored = sub(pTile, anchorAfterAll);

    const kk = axialKey(anchored);
    if (tileCells.has(kk)) {
      throw new Error(`Cell collision inside tile (after anchor): ${kk} (sector ${def.id})`);
    }
    tileCells.set(kk, it.cell);
  }

  return tileCells;
}

/**
 * buildLogicBoardWithLocalColumnShift（仕様準拠 + rot時の位置ズレ解消）
 * - 列オフセットは「各タイルの 3/4/5列目」等の“タイル内ルール”で適用（rot0基準）
 * - オフセット済み形状に rot を掛ける
 * - local(0,0) をアンカーとして、rot によるタイル位置ズレを補正
 * - 最後に viewRot を盤面全体へ適用して出力
 */
export function buildLogicBoardWithLocalColumnShift(
  sectorDefs: readonly SectorTileDef[],
  placements: readonly SectorPlacement[],
  opt: BuildOptions
): LogicBoard {
  const defById = new Map<string, SectorTileDef>();
  for (const d of sectorDefs) defById.set(d.id, d);

  const viewRot = normRot(opt.viewRot60);

  // 1) 合成（preView: viewRot をまだ掛けない logic space）
  const preViewCells = new Map<string, Cell>();

  for (const p of placements) {
    const def = defById.get(p.sectorId);
    if (!def) throw new Error(`Unknown sectorId: ${p.sectorId}`);

    const tileCells = buildTileCellsWithOffsetThenRot_Anchored(def, p, opt);

    for (const [kTile, cell] of tileCells.entries()) {
      const aTile = parseKey(kTile);
      const placed = add(aTile, p.pos);
      const kk = axialKey(placed);

      if (preViewCells.has(kk)) {
        throw new Error(`Cell collision at ${kk} (sector ${p.sectorId})`);
      }
      preViewCells.set(kk, cell);
    }
  }

  // 2) 最後に viewRot / viewMirror を適用して FINAL(view space) を返す
  const finalCells = new Map<string, Cell>();

  for (const [k, cell] of preViewCells.entries()) {
    const a = parseKey(k);

    let v = rotate60(a, viewRot);

    if (opt.viewMirror) {
      // mirror は仕様確定後に実装（現状は除外方針）
      throw new Error("viewMirror=true is not supported yet (mirror rule not finalized).");
    }

    const kk = axialKey(v);
    if (finalCells.has(kk)) {
      throw new Error(`Cell collision at ${kk} (after view transform)`);
    }
    finalCells.set(kk, cell);
  }

  return { cells: finalCells };
}
