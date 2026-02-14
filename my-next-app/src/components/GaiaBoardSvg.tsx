"use client";

import React, { useMemo, useState } from "react";
import type { Axial, Placement } from "../gaia/types";
import { axialToPixel, hexPolygonPoints, hexEdgeMidpoints } from "../gaia/renderHex";
import { Board } from "../gaia/board";
import { key, oppositeEdgeIdx } from "../gaia/hex";
import type { Tile } from "../gaia/types";

type Props = {
  slots: readonly Axial[];
  tilesById: ReadonlyMap<string, Tile>;
  placements: readonly Placement[]; // from board.toPlacements()
  hexSize?: number; // px
};

type Selected = {
  pos: Axial;
  tileId: string;
  rot: number;
  edgesOnBoard: string[]; // 0..5
};

function normalizeToViewBox(points: { x: number; y: number }[], padding = 30) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

// Minimal edge styling for MVP (no color specification requested)
// Use dash patterns to distinguish edge types.
function edgeStyle(edge: string) {
  switch (edge) {
    case "LANE":
      return { strokeDasharray: "0" }; // solid
    case "SPACE":
      return { strokeDasharray: "6 6" }; // dashed
    case "WORMHOLE":
      return { strokeDasharray: "2 4" }; // dotted-ish
    case "BLOCKED":
      return { strokeDasharray: "0" };
    default:
      return { strokeDasharray: "6 6" };
  }
}

export default function GaiaBoardSvg(props: Props) {
  const hexSize = props.hexSize ?? 50;

  // Build a Board instance from props (for edgeAt compatibility with your earlier class)
  const board = useMemo(() => {
    const b = new Board(props.slots);
    for (const p of props.placements) {
      const tile = props.tilesById.get(p.tileId);
      if (!tile) throw new Error(`Tile not found: ${p.tileId}`);
      b.place(tile, p.rot, p.pos);
    }
    return b;
  }, [props.slots, props.placements, props.tilesById]);

  const [selected, setSelected] = useState<Selected | null>(null);

  const slotCenters = useMemo(() => {
    return props.slots.map((s) => {
      const pix = axialToPixel(s, hexSize);
      return { pos: s, x: pix.x, y: pix.y, k: key(s) };
    });
  }, [props.slots, hexSize]);

  const viewBox = useMemo(() => {
    const pts = slotCenters.map((c) => ({ x: c.x, y: c.y }));
    return normalizeToViewBox(pts, hexSize + 30);
  }, [slotCenters, hexSize]);

  function onClickHex(pos: Axial) {
    const pt = board.get(pos);
    if (!pt) {
      setSelected(null);
      return;
    }
    const edgesOnBoard = Array.from({ length: 6 }, (_, i) => String(board.edgeAt(pos, i) ?? ""));
    setSelected({
      pos,
      tileId: pt.tile.id,
      rot: pt.rot,
      edgesOnBoard,
    });
  }

  // Optional: basic consistency warning for the selected tile's neighbors (local view)
  const neighborDiagnostics = useMemo(() => {
    if (!selected) return [];
    const out: { dir: number; neighborKey: string; ok: boolean; a: string; b: string }[] = [];
    for (let dir = 0; dir < 6; dir++) {
      const a = String(board.edgeAt(selected.pos, dir) ?? "");
      // neighbor exists?
      // Board.isSlot checks; easiest is to call board.get on neighbor if the slot exists
      // We'll approximate: if neighbor not placed, skip diagnostic
      // (You can improve later to include slot detection)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { add, DIRS } = require("../gaia/hex");
      const npos = add(selected.pos, DIRS[dir]);
      const npt = board.get(npos);
      if (!npt) continue;

      const b = String(board.edgeAt(npos, oppositeEdgeIdx(dir)) ?? "");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { edgesCompatible } = require("../gaia/board");
      const ok = edgesCompatible(a, b);
      out.push({ dir, neighborKey: key(npos), ok, a, b });
    }
    return out;
  }, [selected, board]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
      <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 8, overflow: "auto" }}>
        <svg
          viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}`}
          width="100%"
          style={{ height: "70vh" }}
        >
          {slotCenters.map((c) => {
            const poly = hexPolygonPoints(c.x, c.y, hexSize);

            const placed = board.get(c.pos);
            const isSelected =
              selected && selected.pos.q === c.pos.q && selected.pos.r === c.pos.r;

            // edge segments (visual debug)
            const { corners, mids } = hexEdgeMidpoints(c.x, c.y, hexSize);

            return (
              <g key={c.k} onClick={() => onClickHex(c.pos)} style={{ cursor: "pointer" }}>
                <polygon
                  points={poly}
                  fill="white"
                  stroke={isSelected ? "black" : "#999"}
                  strokeWidth={isSelected ? 3 : 1}
                />

                {/* Draw 6 short edge segments using edgeAt(pos, dir) */}
                {placed &&
                  Array.from({ length: 6 }, (_, dir) => {
                    const edge = String(board.edgeAt(c.pos, dir) ?? "");
                    const style = edgeStyle(edge);
                    // Draw from corner->mid->next corner as a short line near the edge midpoint
                    const a = corners[dir];
                    const b = corners[(dir + 1) % 6];
                    const mid = mids[dir];

                    // Shorten segment around the midpoint (to avoid drawing full edge)
                    const t = 0.25;
                    const p1 = { x: mid.x + (a.x - mid.x) * t, y: mid.y + (a.y - mid.y) * t };
                    const p2 = { x: mid.x + (b.x - mid.x) * t, y: mid.y + (b.y - mid.y) * t };

                    return (
                      <line
                        key={`${c.k}-e${dir}`}
                        x1={p1.x}
                        y1={p1.y}
                        x2={p2.x}
                        y2={p2.y}
                        stroke="black"
                        strokeWidth={2}
                        {...style}
                      />
                    );
                  })}

                {/* Text label */}
                {placed ? (
                  <>
                    <text x={c.x} y={c.y - 6} textAnchor="middle" fontSize={14} fill="black">
                      {placed.tile.id}
                    </text>
                    <text x={c.x} y={c.y + 14} textAnchor="middle" fontSize={12} fill="black">
                      rot:{placed.rot}
                    </text>
                  </>
                ) : (
                  <text x={c.x} y={c.y + 4} textAnchor="middle" fontSize={12} fill="#999">
                    empty
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Debug</div>

        {!selected ? (
          <div style={{ color: "#666" }}>タイルをクリックすると詳細が表示されます。</div>
        ) : (
          <>
            <div style={{ marginBottom: 8 }}>
              <div><b>pos</b>: {selected.pos.q},{selected.pos.r}</div>
              <div><b>tile</b>: {selected.tileId}</div>
              <div><b>rot</b>: {selected.rot}</div>
            </div>

            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Edges on board (dir 0..5)</div>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {selected.edgesOnBoard.map((e, i) => (
                  <li key={i}>
                    {i}: {e || "(none)"}
                  </li>
                ))}
              </ol>
            </div>

            {neighborDiagnostics.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Neighbor consistency (placed only)</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {neighborDiagnostics.map((d, idx) => (
                    <li key={idx}>
                      dir {d.dir} ↔ {d.neighborKey}: {d.ok ? "OK" : "NG"} ({d.a} vs {d.b})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
