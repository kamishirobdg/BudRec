// src/components/LayoutEditor.tsx
"use client";

import React, { useCallback, useMemo, useState } from "react";

import type { Axial } from "@/gaia/sectorTypes";
import type { MapLayoutTemplate } from "@/gaia/mapTemplates";
import { loadTemplates, upsertTemplate } from "@/gaia/templateStore";
import { axialToPixel } from "@/gaia/hexLayout";

type TemplateId = string;

type Cube = { x: number; y: number; z: number };

function cubeRound(c: { x: number; y: number; z: number }): Cube {
  let rx = Math.round(c.x);
  let ry = Math.round(c.y);
  let rz = Math.round(c.z);

  const xDiff = Math.abs(rx - c.x);
  const yDiff = Math.abs(ry - c.y);
  const zDiff = Math.abs(rz - c.z);

  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
  else if (yDiff > zDiff) ry = -rx - rz;
  else rz = -rx - ry;

  return { x: rx, y: ry, z: rz };
}

function cubeToAxial(c: Cube): Axial {
  return { q: c.x, r: c.z };
}

/**
 * Pixel -> Axial (pointy-top)
 * Must match gaia/hexLayout.ts axialToPixel() assumptions.
 */
function pixelToAxialPointy(px: { x: number; y: number }, size: number): Axial {
  const sqrt3 = Math.sqrt(3);
  const q = (sqrt3 / 3 * px.x - 1 / 3 * px.y) / size;
  const r = (2 / 3 * px.y) / size;
  const cube = cubeRound({ x: q, y: -q - r, z: r });
  return cubeToAxial(cube);
}

function keyOf(a: Axial): string {
  return `${a.q},${a.r}`;
}

function addAxial(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

/**
 * Hex points with extra rotation (deg).
 * gaia/hexLayout.hexPoints uses startDeg = -30 for pointy.
 * User request: selectable hex should be rotated ~90deg relative to current.
 */
function hexPointsRot(cx: number, cy: number, size: number, rotDeg: number): string {
  // base pointy start (-30deg), then add extra rotation
  const startDeg = -30 + rotDeg;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i + startDeg);
    pts.push([cx + size * Math.cos(ang), cy + size * Math.sin(ang)]);
  }
  return pts.map(([x, y]) => `${x},${y}`).join(" ");
}

/** Radius-2 footprint (19 cells) used by normal sector tiles. */
function radius2Footprint(): Axial[] {
  const out: Axial[] = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= 2) out.push({ q, r });
    }
  }
  return out;
}

const FOOTPRINT_SECTOR = radius2Footprint();
const FOOTPRINT_MIDDLE: Axial[] = [
  { q: 0, r: 0 },
  { q: 1, r: 0 },
  { q: 0, r: 1 },
];
const FOOTPRINT_SMALL: Axial[] = [{ q: 0, r: 0 }];

function footprintForKind(kind: string): Axial[] {
  if (kind === "MIDDLE") return FOOTPRINT_MIDDLE;
  if (kind === "SMALL") return FOOTPRINT_SMALL; // Scout/Little
  return FOOTPRINT_SECTOR; // default SECTOR
}

export default function LayoutEditor() {
  const [templates, setTemplates] = useState<MapLayoutTemplate[]>(() => loadTemplates());
  const [templateId, setTemplateId] = useState<TemplateId>(() => templates[0]?.id ?? "");
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | "">("");
  const [hoverAxial, setHoverAxial] = useState<Axial | null>(null);
  const [lastClickAxial, setLastClickAxial] = useState<Axial | null>(null);

  const activeTemplate = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId]
  );

  // Visual scale (stable)
  const size = 34;

  // Center view around current slot anchors so you can always see/edit the existing layout.
  const origin = useMemo(() => {
    if (!activeTemplate) return { x: 520, y: 360 };
    const ps = activeTemplate.slots.map((s) => axialToPixel(s.pos, size, "pointy"));
    const cx = ps.reduce((a, p) => a + (Number.isFinite(p.x) ? p.x : 0), 0) / Math.max(1, ps.length);
    const cy = ps.reduce((a, p) => a + (Number.isFinite(p.y) ? p.y : 0), 0) / Math.max(1, ps.length);
    return { x: 520 - cx, y: 360 - cy };
  }, [activeTemplate, size]);

  const gridRadius = useMemo(() => {
    if (!activeTemplate) return 10;
    const qs = activeTemplate.slots.map((s) => s.pos.q);
    const rs = activeTemplate.slots.map((s) => s.pos.r);
    const maxAbs = Math.max(3, ...qs.map((v) => Math.abs(v)), ...rs.map((v) => Math.abs(v)));
    return Math.min(34, Math.max(12, maxAbs + 8));
  }, [activeTemplate]);

  const gridCells = useMemo(() => {
    const cells: Axial[] = [];
    for (let q = -gridRadius; q <= gridRadius; q++) {
      for (let r = -gridRadius; r <= gridRadius; r++) {
        const s = -q - r;
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= gridRadius) {
          cells.push({ q, r });
        }
      }
    }
    return cells;
  }, [gridRadius]);

  const slotAnchors = useMemo(() => {
    if (!activeTemplate) return [];
    return activeTemplate.slots.map((s, i) => ({ i, kind: s.kind, pos: s.pos }));
  }, [activeTemplate]);

  const persistTemplate = useCallback((next: MapLayoutTemplate) => {
    upsertTemplate(next);
    const reloaded = loadTemplates();
    setTemplates(reloaded);
    setTemplateId(next.id);
  }, []);

  const onPickTemplate = useCallback((id: string) => {
    setTemplateId(id);
    setSelectedSlotIndex("");
    setHoverAxial(null);
    setLastClickAxial(null);
  }, []);

  const svgPointToLocal = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left - origin.x;
      const y = e.clientY - rect.top - origin.y;
      return { x, y };
    },
    [origin.x, origin.y]
  );

  const onSvgMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const p = svgPointToLocal(e);
      const a = pixelToAxialPointy(p, size);
      setHoverAxial(a);
    },
    [svgPointToLocal, size]
  );

  const onSvgLeave = useCallback(() => setHoverAxial(null), []);

  const onSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!activeTemplate) return;
      if (selectedSlotIndex === "") return;

      const p = svgPointToLocal(e);
      const a = pixelToAxialPointy(p, size);

      setLastClickAxial(a);

      const next: MapLayoutTemplate = {
        ...activeTemplate,
        slots: activeTemplate.slots.map((s, i) => (i === selectedSlotIndex ? { ...s, pos: a } : s)),
      };
      persistTemplate(next);
    },
    [activeTemplate, selectedSlotIndex, svgPointToLocal, size, persistTemplate]
  );

  const onNudge = useCallback(
    (dq: number, dr: number) => {
      if (!activeTemplate) return;
      if (selectedSlotIndex === "") return;

      const cur = activeTemplate.slots[selectedSlotIndex]?.pos ?? { q: 0, r: 0 };
      const nextPos = { q: cur.q + dq, r: cur.r + dr };

      const next: MapLayoutTemplate = {
        ...activeTemplate,
        slots: activeTemplate.slots.map((s, i) => (i === selectedSlotIndex ? { ...s, pos: nextPos } : s)),
      };
      persistTemplate(next);
    },
    [activeTemplate, selectedSlotIndex, persistTemplate]
  );

  // ViewBox around current grid only; origin centers on slots so slots remain visible.
  const vb = useMemo(() => {
    const pts = gridCells.map((a) => {
      const p = axialToPixel(a, size, "pointy");
      return { x: p.x + origin.x, y: p.y + origin.y };
    });

    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);

    const minX = Math.min(...xs) - size * 2.5;
    const maxX = Math.max(...xs) + size * 2.5;
    const minY = Math.min(...ys) - size * 2.5;
    const maxY = Math.max(...ys) + size * 2.5;

    const w = Math.max(900, maxX - minX);
    const h = Math.max(650, maxY - minY);
    return { x: minX, y: minY, w, h };
  }, [gridCells, origin.x, origin.y, size]);

  const selectedSlot = useMemo(() => {
    if (!activeTemplate) return null;
    if (selectedSlotIndex === "") return null;
    return { i: selectedSlotIndex, slot: activeTemplate.slots[selectedSlotIndex] };
  }, [activeTemplate, selectedSlotIndex]);

  const infoLine = useMemo(() => {
    const s = selectedSlot;
    const hover = hoverAxial ? `hover=(${hoverAxial.q},${hoverAxial.r})` : "hover=(none)";
    const last = lastClickAxial ? `lastClick=(${lastClickAxial.q},${lastClickAxial.r})` : "lastClick=(none)";
    const sel = s ? `selected=[${s.i}] ${s.slot.kind} pos=(${s.slot.pos.q},${s.slot.pos.r})` : "selected=(none)";
    return `${sel} / ${hover} / ${last}`;
  }, [selectedSlot, hoverAxial, lastClickAxial]);

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      <div style={{ width: 380 }}>
        <h2 style={{ margin: "8px 0 12px" }}>Layout Editor</h2>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Template</div>
          <select value={templateId} onChange={(e) => onPickTemplate(e.target.value)} style={{ width: "100%", padding: 6 }}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} [{t.id}]
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Slot</div>
          <select
            value={selectedSlotIndex}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedSlotIndex(v === "" ? "" : Number(v));
            }}
            style={{ width: "100%", padding: 6 }}
          >
            <option value="">(select slotIndex)</option>
            {activeTemplate?.slots.map((s, i) => (
              <option key={i} value={i}>
                [{i}] {s.kind} (q={s.pos.q}, r={s.pos.r})
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>手順: slotIndex を選択 → 盤面セルをクリック（pos更新）</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 10 }}>
          <button onClick={() => onNudge(0, -1)} disabled={selectedSlotIndex === ""}>
            ↑ (r-)
          </button>
          <button onClick={() => onNudge(-1, 0)} disabled={selectedSlotIndex === ""}>
            q-
          </button>
          <button onClick={() => onNudge(1, 0)} disabled={selectedSlotIndex === ""}>
            q+
          </button>
          <button onClick={() => onNudge(0, 1)} disabled={selectedSlotIndex === ""}>
            ↓ (r+)
          </button>
          <button disabled style={{ opacity: 0.6 }}>
            {" "}
          </button>
          <button disabled style={{ opacity: 0.6 }}>
            {" "}
          </button>
        </div>

        <div style={{ fontSize: 12, opacity: 0.85, padding: 8, border: "1px solid #ddd", borderRadius: 8, background: "#fff" }}>
          {infoLine}
        </div>

        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 10 }}>
          仕様:
          <ul style={{ margin: "6px 0 0 18px" }}>
            <li>hoverセル/クリックセルをハイライト表示</li>
            <li>各slotは footprint（Sector=19, Middle=3, Small=1）で表示</li>
            <li>選択可能グリッドは90度回転（視認性合わせ）</li>
          </ul>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 720 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 10, overflow: "auto", height: "82vh" }}>
          <svg
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            width={vb.w}
            height={vb.h}
            onMouseMove={onSvgMove}
            onMouseLeave={onSvgLeave}
            onClick={onSvgClick}
            style={{ display: "block", background: "#fafafa", cursor: selectedSlotIndex === "" ? "default" : "crosshair" }}
          >
            {/* Click target grid (rotated as requested) */}
            {gridCells.map((a) => {
              const p = axialToPixel(a, size, "pointy");
              const cx = p.x + origin.x;
              const cy = p.y + origin.y;

              const isHover = hoverAxial ? a.q === hoverAxial.q && a.r === hoverAxial.r : false;
              const isLast = lastClickAxial ? a.q === lastClickAxial.q && a.r === lastClickAxial.r : false;

              const points = hexPointsRot(cx, cy, size, 90);

              return (
                <polygon
                  key={`grid-${keyOf(a)}`}
                  points={points}
                  fill={isLast ? "#ffe082" : isHover ? "#f5f5f5" : "white"}
                  stroke={isLast ? "#ffb300" : isHover ? "#9e9e9e" : "#e0e0e0"}
                  strokeWidth={isLast ? 2 : 1}
                />
              );
            })}

            {/* Slot footprints (drawn on top of grid) */}
            {slotAnchors.map((s) => {
              const fp = footprintForKind(s.kind);
              const isSelected = selectedSlotIndex !== "" && s.i === selectedSlotIndex;

              return (
                <g key={`fp-${s.i}`} pointerEvents="none">
                  {fp.map((local, idx) => {
                    const a = addAxial(s.pos, local);
                    const p = axialToPixel(a, size, "pointy");
                    const cx = p.x + origin.x;
                    const cy = p.y + origin.y;
                    const points = hexPointsRot(cx, cy, size * 0.98, 0);
                    return (
                      <polygon
                        key={`fp-${s.i}-${idx}`}
                        points={points}
                        fill={isSelected ? "rgba(255,213,79,0.25)" : "rgba(97,97,97,0.10)"}
                        stroke={isSelected ? "#ff8f00" : "#616161"}
                        strokeWidth={isSelected ? 2 : 1}
                      />
                    );
                  })}
                </g>
              );
            })}

            {/* Slot anchor markers */}
            {slotAnchors.map((s) => {
              const p = axialToPixel(s.pos, size, "pointy");
              const cx = p.x + origin.x;
              const cy = p.y + origin.y;

              const isSelected = selectedSlotIndex !== "" && s.i === selectedSlotIndex;

              return (
                <g key={`slot-${s.i}`} pointerEvents="none">
                  <circle cx={cx} cy={cy} r={size * 0.30} fill={isSelected ? "#ffb300" : "#424242"} opacity={0.92} />
                  <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fill="white">
                    {s.i}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
