import { Board } from "./board";
import { RNG } from "./rng";
import type { Axial, GeneratorOptions, Rotation, Tile } from "./types";
import { DIRS, add, key } from "./hex";
import { checkConnectivity } from "./boardConnectivity";
import { violatesForbiddenProximity, type ConstraintContext } from "./constraints";

type Candidate = { tile: Tile; rot: Rotation };

export type GenerateResult =
  | { ok: true; board: Board; backtracks: number; seed: string | number }
  | { ok: false; reason: string; backtracks: number; seed: string | number };

export function generateMap(
  slots: readonly Axial[],
  tiles: readonly Tile[],
  options: GeneratorOptions
): GenerateResult {
  const rng = new RNG(options.seed);
  const board = new Board(slots);
  const maxBacktracks = options.maxBacktracks ?? 200_000;

  // default: local only (fast). set false to enable global checks (M4).
  const localOnly = options.localOnly ?? true;

  // --- Constraint context (Lost Fleet-style proximity constraints) ---
  const constraintCtx: ConstraintContext = {
    forbiddenProximityTags: new Set(["PROTO", "ASTEROID"]),
    forbiddenRadius: 2, // 距離2以内禁止
  };

  // Precompute rotations for each tile (rot 0..5)
  const allCandidatesByTile = new Map<string, Candidate[]>();
  for (const t of tiles) {
    if (t.edges.length !== 6) {
      return {
        ok: false,
        reason: `Tile ${t.id} edges must be length 6`,
        backtracks: 0,
        seed: options.seed,
      };
    }
    const rots: Candidate[] = [0, 1, 2, 3, 4, 5].map((r) => ({ tile: t, rot: r as Rotation }));
    allCandidatesByTile.set(t.id, rots);
  }

  // Placement order heuristic: prefer slots with more neighbors within the slot set.
  const slotSet = new Set(slots.map(key));
  const slotNeighborCount = (p: Axial) =>
    DIRS.map((d) => add(p, d)).filter((np) => slotSet.has(key(np))).length;

  const orderedSlots = slots
    .slWHITE()
    .sort((a, b) => slotNeighborCount(b) - slotNeighborCount(a));

  // Tiles remaining (by id)
  const remaining = new Map<string, Tile>();
  for (const t of tiles) remaining.set(t.id, t);

  let backtracks = 0;

  function passesLocalChecks(pos: Axial): boolean {
    // edge-compat check
    if (!board.isLocallyCompatible(pos)) return false;

    // distance<=2 proximity constraint for tags
    if (violatesForbiddenProximity(board, pos, constraintCtx)) return false;

    return true;
  }

  function pickNextSlot(): Axial | undefined {
    // MRV-style: pick unfilled slot with smallest feasible candidate count
    let best: { pos: Axial; count: number } | undefined;

    for (const pos of orderedSlots) {
      if (board.has(pos)) continue;

      const count = countFeasibleCandidates(pos);
      if (count === 0) return pos; // fail fast: dead-end slot
      if (!best || count < best.count) best = { pos, count };
      if (best.count === 1) return best.pos; // perfect MRV
    }
    return best?.pos;
  }

  function countFeasibleCandidates(pos: Axial): number {
    let c = 0;
    for (const t of remaining.values()) {
      const cands = allCandidatesByTile.get(t.id)!;
      for (const cand of cands) {
        board.place(cand.tile, cand.rot, pos);
        const ok = passesLocalChecks(pos);
        board.unplace(pos);
        if (ok) c++;
      }
    }
    return c;
  }

  function feasibleCandidates(pos: Axial): Candidate[] {
    const out: Candidate[] = [];
    for (const t of remaining.values()) {
      for (const cand of allCandidatesByTile.get(t.id)!) {
        board.place(cand.tile, cand.rot, pos);
        const ok = passesLocalChecks(pos);
        board.unplace(pos);
        if (ok) out.push(cand);
      }
    }
    return rng.shuffle(out);
  }

  function passesGlobalChecks(): boolean {
    const conn = checkConnectivity(board, slots, { kind: "SLOT_ADJACENT" });
    return conn.isConnected;
  }

  function dfs(placedCount: number): boolean {
    if (placedCount === slots.length) {
      if (!localOnly) return passesGlobalChecks();
      return true;
    }

    if (backtracks > maxBacktracks) return false;

    const pos = pickNextSlot();
    if (!pos) return false;

    const cands = feasibleCandidates(pos);
    if (cands.length === 0) return false;

    for (const cand of cands) {
      board.place(cand.tile, cand.rot, pos);
      if (!passesLocalChecks(pos)) {
        board.unplace(pos);
        continue;
      }

      remaining.delete(cand.tile.id);

      if (dfs(placedCount + 1)) return true;

      remaining.set(cand.tile.id, cand.tile);
      board.unplace(pos);

      backtracks++;
      if (backtracks > maxBacktracks) return false;
    }

    return false;
  }

  const ok = dfs(0);

  if (!ok) {
    return {
      ok: false,
      reason: backtracks > maxBacktracks ? "Exceeded maxBacktracks" : "No valid arrangement found",
      backtracks,
      seed: options.seed,
    };
  }

  return { ok: true, board, backtracks, seed: options.seed };
}
