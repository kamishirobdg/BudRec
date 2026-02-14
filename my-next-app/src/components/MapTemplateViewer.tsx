"use client";

import * as React from "react";
import type { TemplateDef } from "@/gaia/data/templates/types";
import type { BoardCell } from "@/gaia/board/previewBoard";

type SlotAccept = "LARGE" | "MIDDLE" | "SMALL";
type PlacementItem = { slotId: string; sectorId: string; rot: number };
type Axial = { q: number; r: number };

function axialToPixelPointy(pos: Axial, size: number) {
  // pointy-top axial -> pixel
  const x = size * Math.sqrt(3) * (pos.q + pos.r / 2);
  const y = size * (3 / 2) * pos.r;
  return { x, y };
}

function axialRotateCCW(pos: Axial, rot: number): Axial {
  // CCW by 60deg * rot using cube rotation
  let x = pos.q;
  let z = pos.r;
  let y = -x - z;

  const r = ((rot % 6) + 6) % 6;
  for (let i = 0; i < r; i++) {
    // (x,y,z) -> (-z, -x, -y)
    const nx = -z;
    const ny = -x;
    const nz = -y;
    x = nx;
    y = ny;
    z = nz;
  }
  return { q: x, r: z };
}

function acceptToColor(a: SlotAccept) {
  if (a === "LARGE") return "#2563eb";
  if (a === "MIDDLE") return "#16a34a";
  return "#f97316";
}

function computeBoundsByPoints(points: Array<{ x: number; y: number }>, pad: number) {
  if (points.length === 0) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function shortPlanetLabel(planetType?: string) {
  if (!planetType) return "?";
  const up = String(planetType).toUpperCase();
  return up.length <= 2 ? up : up.slice(0, 2);
}

export function MapTemplateViewer(props: {
  template: TemplateDef;
  hexSize?: number;
  boardCells?: BoardCell[];
  placement?: PlacementItem[];
  defaultShowCells?: boolean;

  // 60度刻みの表示回転（Axial回転）
  viewRot?: number; // 0..5

  // 微回転（度数）：SVG側で回す。時計回りは負の値。
  viewAngleDeg?: number;
}) {
  const {
    template,
    hexSize = 40,
    boardCells = [],
    placement = [],
    defaultShowCells = true,

    // あなたの指示：4 を基準（= CCW240 = CW120）
    viewRot = 4,

    // あなたの指示：時計回り30度
    viewAngleDeg = -30,
  } = props;

  const [showCells, setShowCells] = React.useState(defaultShowCells);
  const [showSlots, setShowSlots] = React.useState(true);

  const placementBySlot = React.useMemo(() => {
    const m = new Map<string, PlacementItem>();
    for (const p of placement) m.set(p.slotId, p);
    return m;
  }, [placement]);

  // viewRot（60度刻み）だけを先に適用した点群で bounds を取る（微回転は bounds に入れない）
  // ※ viewAngleDeg は描画の見た目だけの補正なので、boundsは少し余裕を持たせる
  const slotPoints = React.useMemo(() => {
    return template.slots.map((s) => {
      const vr = axialRotateCCW(s.pos as any, viewRot);
      return axialToPixelPointy(vr, hexSize);
    });
  }, [template.slots, hexSize, viewRot]);

  const cellPoints = React.useMemo(() => {
    return boardCells.map((c) => {
      const vr = axialRotateCCW(c.pos as any, viewRot);
      return axialToPixelPointy(vr, hexSize);
    });
  }, [boardCells, hexSize, viewRot]);

  const bounds = React.useMemo(() => {
    const points = [...(showSlots ? slotPoints : []), ...(showCells ? cellPoints : [])];
    // 微回転で端が切れないよう pad は大きめ
    return computeBoundsByPoints(points, 220);
  }, [slotPoints, cellPoints, showSlots, showCells]);

  const viewBox = `${bounds.minX} ${bounds.minY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`;

  return (
    <div style={{ width: "100%", height: "calc(100vh - 24px)" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", padding: 12 }}>
        <div style={{ fontWeight: 700 }}>
          {template.label} <span style={{ fontWeight: 400, opacity: 0.7 }}>({template.templateId})</span>
        </div>
        <div style={{ opacity: 0.8 }}>
          players={template.playerCount} / expansion={template.expansion} / slots={template.slots.length} / viewRot={viewRot} / viewAngle={viewAngleDeg}°
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={showSlots} onChange={(e) => setShowSlots(e.target.checked)} />
            <span style={{ color: "#e5e7eb" }}>Slots</span>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={showCells} onChange={(e) => setShowCells(e.target.checked)} />
            <span style={{ color: "#e5e7eb" }}>Cells</span>
          </label>
        </div>
      </div>

      <svg width="100%" height="100%" viewBox={viewBox} style={{ background: "#0b1020" }}>
        {/* 微回転（30°）は描画全体に適用 */}
        <g transform={`rotate(${viewAngleDeg})`}>
          {/* 原点 */}
          <g transform={`translate(0,0)`}>
            <circle r={4} fill="#e5e7eb" />
            <text x={8} y={-8} fontSize={12} fill="#e5e7eb">
              (0,0)
            </text>
          </g>

          {/* Cells（planet文字） */}
          {showCells &&
            boardCells.map((c) => {
              const p = axialRotateCCW(c.pos as any, viewRot);
              const { x, y } = axialToPixelPointy(p, hexSize);

              const label = c.kind === "planet" ? shortPlanetLabel(c.planetType) : c.kind === "special" ? "SP" : "·";
              const fill = c.kind === "planet" ? "#e5e7eb" : "#9ca3af";

              return (
                <g key={`${c.pos.q},${c.pos.r}`} transform={`translate(${x},${y})`}>
                  <circle r={6} fill="#111827" stroke="#1f2937" strokeWidth={2} />
                  <text y={4} fontSize={10} textAnchor="middle" fill={fill}>
                    {label}
                  </text>
                </g>
              );
            })}

          {/* Slots（点＋ラベル） */}
          {showSlots &&
            template.slots.map((slot) => {
              const p = axialRotateCCW(slot.pos as any, viewRot);
              const { x, y } = axialToPixelPointy(p, hexSize);

              const a0 = slot.accepts[0] as SlotAccept;
              const fill = acceptToColor(a0);

              const pl = placementBySlot.get(slot.slotId);
              const assign = pl ? `${pl.sectorId}@r${pl.rot}` : "-";

              return (
                <g key={slot.slotId} transform={`translate(${x},${y})`}>
                  <circle r={7} fill={fill} stroke="#0b1020" strokeWidth={2} />
                  <text y={-12} fontSize={12} textAnchor="middle" fill="#e5e7eb">
                    {slot.slotId}
                  </text>
                  <text y={18} fontSize={10} textAnchor="middle" fill="#9ca3af">
                    {a0} ({slot.pos.q},{slot.pos.r}) / {assign}
                  </text>
                </g>
              );
            })}
        </g>
      </svg>
    </div>
  );
}
