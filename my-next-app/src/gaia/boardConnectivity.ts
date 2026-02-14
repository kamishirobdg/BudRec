import type { Axial, EdgeType } from "./types";
import { DIRS, add, key, oppositeEdgeIdx } from "./hex";
import { Board } from "./board";

export type ConnectivityMode =
  | { kind: "SLOT_ADJACENT" } // 仕様A：スロット隣接なら接続
  | { kind: "EDGE_MATCH"; allowedEdges: ReadonlySet<EdgeType> }; // 仕様B：allowedEdgesで一致する場合のみ接続

export type ConnectivityResult = {
  isConnected: boolean;
  visitedKeys: ReadonlySet<string>;
  unreachableKeys: string[];
  startKey: string;
};

/**
 * Check if all slots are connected.
 * - SLOT_ADJACENT: adjacency depends only on slot layout.
 * - EDGE_MATCH: adjacency exists only when both tiles are placed and their touching edges match,
 *              and the edge type is in allowedEdges.
 */
export function checkConnectivity(
  board: Board,
  slots: readonly Axial[],
  mode: ConnectivityMode,
  startPos?: Axial
): ConnectivityResult {
  if (slots.length === 0) {
    return { isConnected: true, visitedKeys: new Set(), unreachableKeys: [], startKey: "" };
  }

  const slotSet = new Set(slots.map(key));

  // Choose start: provided -> otherwise prefer (0,0) if present -> otherwise first slot
  const start =
    (startPos && slotSet.has(key(startPos)) ? startPos : undefined) ??
    (slotSet.has("0,0") ? { q: 0, r: 0 } : slots[0]);

  const startKey = key(start);

  const visited = new Set<string>();
  const queue: Axial[] = [start];
  visited.add(startKey);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curKey = key(cur);

    for (let dir = 0; dir < 6; dir++) {
      const nxt = add(cur, DIRS[dir]);
      const nxtKey = key(nxt);
      if (!slotSet.has(nxtKey)) continue;

      // Decide if an edge exists between cur and nxt
      let hasConnection = false;

      if (mode.kind === "SLOT_ADJACENT") {
        hasConnection = true;
      } else {
        // EDGE_MATCH mode:
        // Require both tiles placed; touching edges must match and be allowed.
        const a = board.edgeAt(cur, dir) as EdgeType | undefined;
        const b = board.edgeAt(nxt, oppositeEdgeIdx(dir)) as EdgeType | undefined;

        if (a && b && a === b && mode.allowedEdges.has(a)) {
          hasConnection = true;
        }
      }

      if (!hasConnection) continue;

      if (!visited.has(nxtKey)) {
        visited.add(nxtKey);
        queue.push(nxt);
      }
    }
  }

  const unreachableKeys = slots.map((s) => key(s)).filter((k) => !visited.has(k));

  return {
    isConnected: unreachableKeys.length === 0,
    visitedKeys: visited,
    unreachableKeys,
    startKey,
  };
}
