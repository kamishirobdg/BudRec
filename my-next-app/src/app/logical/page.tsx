"use client";

import React, { useMemo, useState, useEffect } from "react";

import { buildLogicalMap } from "@/gaia/logicalMap/buildLogicalMap";
import { dumpLogicalMap } from "@/gaia/logicalMap/dumpLogicalMap";

// NEW: evaluate.ts の outer/touch SSOT を参照して背景色付け
import { OUTER_CELLS_BY_TEMPLATE, TOUCH_CELLS_BY_TEMPLATE } from "@/gaia/board/evaluate";

type Axial = { q: number; r: number };

// ===== Template choices (label/id SSOT for UI) =====
const TEMPLATE_CHOICES = [
  { id: "3p_lostFleet", label: "3p Lost Fleet" },
  { id: "4p_lostFleet", label: "4p Lost Fleet" },
] as const;

function templateLabelOf(id: string) {
  return TEMPLATE_CHOICES.find((t) => t.id === id)?.label ?? id;
}

// === Rendering primitives (GLOBAL DEFAULT = flat-top, i.e. 30° CW from pointy-top) ===
// flat-top axial->pixel (RedBlobGames):
// x = size * 3/2 * q
// y = size * sqrt(3) * (r + q/2)
function axialToPixelFlatTop(a: Axial, size: number) {
  const x = size * 1.5 * a.q;
  const y = size * Math.sqrt(3) * (a.r + a.q / 2);
  return { x, y };
}

// Returns vertices in order, so edge i is (vi -> v(i+1))
function hexVertsFlatTop(cx: number, cy: number, size: number): Array<{ x: number; y: number }> {
  const verts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i);
    verts.push({ x: cx + size * Math.cos(ang), y: cy + size * Math.sin(ang) });
  }
  return verts;
}

function vertsToPoints(verts: Array<{ x: number; y: number }>) {
  return verts.map((v) => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(" ");
}

const AXIAL_DIRS: Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function keyOf(a: Axial) {
  return `${a.q},${a.r}`;
}
function add(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

function safeNum(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortPlanet(p: string) {
  return p;
}

async function copyText(text: string): Promise<boolean> {
  // Clipboard API is stable on https/localhost; fallback for others.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * evaluate.ts の outer/touch SSOT は templateKey ("slotId:localKey") が主。
 * ただし ":" が無いエントリがあれば "q,r" として扱う（将来の座標SSOT移行にも対応）。
 */
function buildOuterTouchSets(templateId: string) {
  const outerRaw = (OUTER_CELLS_BY_TEMPLATE as any)?.[templateId] ?? [];
  const touchRaw = (TOUCH_CELLS_BY_TEMPLATE as any)?.[templateId] ?? [];

  const outerTk = new Set<string>();
  const outerCoord = new Set<string>();

  for (const x of outerRaw) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    if (s.includes(":")) outerTk.add(s);
    else outerCoord.add(s);
  }

  const touchTk = new Set<string>();
  const touchCoord = new Set<string>();

  for (const x of touchRaw) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    if (s.includes(":")) touchTk.add(s);
    else touchCoord.add(s);
  }

  return { outerTk, outerCoord, touchTk, touchCoord };
}

export default function LogicalMapPage() {
  const [seed, setSeed] = useState<string>("0");
  const [templateId, setTemplateId] = useState<string>("3p_lostFleet");

  const [dumpText, setDumpText] = useState<string>("");
  const [error, setError] = useState<string>("");

  const [hexSize, setHexSize] = useState<number>(26);
  const [showAllCells, setShowAllCells] = useState<boolean>(true);
  const [showTextDump, setShowTextDump] = useState<boolean>(false);
  const [showPlacement, setShowPlacement] = useState<boolean>(true);
  const [showTileOutline, setShowTileOutline] = useState<boolean>(true);

  // NEW: outer/touch 背景を表示
  const [showOuterTouchBg, setShowOuterTouchBg] = useState<boolean>(true);

  // NEW: Scout 表示（最小：Scoutスロットの中心セルのみ）
  const [showScoutLabel, setShowScoutLabel] = useState<boolean>(true);

  // toast for copy feedback
  const [toast, setToast] = useState<string>("");

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 900);
    return () => clearTimeout(t);
  }, [toast]);

  const outerTouchSets = useMemo(() => buildOuterTouchSets(templateId), [templateId]);

  const result = useMemo(() => {
    try {
      setError("");
      const m = buildLogicalMap({ templateId, seed });
      if (showTextDump) {
        const s = dumpLogicalMap(m as any, { cellWidth: 10, showCoords: true, emptyToken: "." });
        setDumpText(s);
      } else {
        setDumpText("");
      }
      return m as any;
    } catch (e: any) {
      setDumpText("");
      setError(String(e?.message ?? e));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, templateId, showTextDump]);

  const placementText = useMemo(() => {
    if (!result?.placement) return "";
    const list = Array.isArray(result.placement) ? result.placement.slice() : [];
    list.sort((a: any, b: any) => String(a.slotId).localeCompare(String(b.slotId)));
    return list
      .map((p: any) => {
        const slotId = String(p.slotId);
        const sectorId = String(p.sectorId);
        const rot = safeNum(p.rot, 0);
        return `${slotId}\t${sectorId}\trot=${rot}`;
      })
      .join("\n");
  }, [result]);

  const svg = useMemo(() => {
    if (!result?.cellsByKey) return null;

    const cellsByKey: Map<string, any> = result.cellsByKey;

    const entries: Array<[string, any]> = [];
    cellsByKey.forEach((cell, k) => {
      if (showAllCells) entries.push([k, cell]);
      else if (cell?.kind === "planet") entries.push([k, cell]);
    });

    // Compute viewBox bounds
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    const size = hexSize;

    for (const [k] of entries) {
      const [qStr, rStr] = k.split(",");
      const q = safeNum(qStr, 0);
      const r = safeNum(rStr, 0);
      const { x, y } = axialToPixelFlatTop({ q, r }, size);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    if (!Number.isFinite(minX)) {
      minX = minY = 0;
      maxX = maxY = 0;
    }

    const pad = size * 3.2 + 30;
    const viewMinX = minX - pad;
    const viewMinY = minY - pad;
    const viewW = maxX - minX + pad * 2;
    const viewH = maxY - minY + pad * 2;

    // Tile-outline edges (thick): edges where neighbor is missing OR belongs to different slotId
    type Seg = { x1: number; y1: number; x2: number; y2: number };
    const segKey = (s: Seg) => {
      const a = `${s.x1.toFixed(1)},${s.y1.toFixed(1)}`;
      const b = `${s.x2.toFixed(1)},${s.y2.toFixed(1)}`;
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    };

    const outlineSegsMap = new Map<string, Seg>();

    if (showTileOutline) {
      for (const [k, cell] of entries) {
        const slotId = cell?.slotId ? String(cell.slotId) : "";
        if (!slotId) continue;

        const [qStr, rStr] = k.split(",");
        const q = safeNum(qStr, 0);
        const r = safeNum(rStr, 0);

        const { x, y } = axialToPixelFlatTop({ q, r }, size);
        const verts = hexVertsFlatTop(x, y, size);

        for (let i = 0; i < 6; i++) {
          const dir = AXIAL_DIRS[i];
          const nk = keyOf(add({ q, r }, dir));
          const nCell = cellsByKey.get(nk);

          const nSlotId = nCell?.slotId ? String(nCell.slotId) : "";
          const isBoundary = !nCell || nSlotId !== slotId;
          if (!isBoundary) continue;

          const v1 = verts[i];
          const v2 = verts[(i + 1) % 6];
          const seg: Seg = { x1: v1.x, y1: v1.y, x2: v2.x, y2: v2.y };
          outlineSegsMap.set(segKey(seg), seg);
        }
      }
    }

    const outlineSegs = Array.from(outlineSegsMap.values());

    return (
      <svg
        width="100%"
        height="auto"
        viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
        style={{ border: "1px solid #ddd", borderRadius: 12, background: "#fff" }}
      >
        {/* Base cells */}
        {entries.map(([k, cell]) => {
          const [qStr, rStr] = k.split(",");
          const q = safeNum(qStr, 0);
          const r = safeNum(rStr, 0);
          const { x, y } = axialToPixelFlatTop({ q, r }, size);
          const verts = hexVertsFlatTop(x, y, size);
          const pts = vertsToPoints(verts);

          const isPlanet = cell?.kind === "planet";
          const stroke = isPlanet ? "#111" : "#c7c7c7";
          const strokeW = isPlanet ? 2.4 : 1.1;

          // === Outer / Touch 背景色 ===
          let fill = "#fff";
          if (showOuterTouchBg) {
            const slotId = String(cell?.slotId ?? "");
            const localKey = String(cell?.localKey ?? "");
            const templateKey = slotId && localKey ? `${slotId}:${localKey}` : "";

            const isOuter =
              outerTouchSets.outerCoord.has(k) || (templateKey ? outerTouchSets.outerTk.has(templateKey) : false);
            const isTouch =
              outerTouchSets.touchCoord.has(k) || (templateKey ? outerTouchSets.touchTk.has(templateKey) : false);

            if (isOuter) fill = "#fee2e2"; // thin red
            else if (isTouch) fill = "#fef9c3"; // thin yellow
          }

          // === Scout 表示（最小） ===
          const slotId = String(cell?.slotId ?? "");
          const localKey = String(cell?.localKey ?? "");
          const isScoutCenter = showScoutLabel && slotId.startsWith("S") && localKey === "0,0";

          const label = isPlanet ? String(cell.planetType ?? "") : isScoutCenter ? "Scout" : "";

          return (
            <g
              key={k}
              style={{ cursor: "pointer" }}
              onClick={async () => {
                const ok = await copyText(k);
                setToast(ok ? `Copied: ${k}` : `Copy failed: ${k}`);
              }}
            >
              <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={strokeW} />
              {label ? (
                <text
                  x={x}
                  y={y + 4}
                  textAnchor="middle"
                  fontSize={Math.max(10, size * 0.40)}
                  fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
                  fill="#111"
                >
                  {isPlanet ? shortPlanet(label) : label}
                </text>
              ) : null}

              <title>
                {`pos=${k}\nslot=${String(cell?.slotId ?? "")} sector=${String(cell?.sectorId ?? "")} rot=${String(
                  cell?.rot ?? ""
                )}\nlocal=${String(cell?.localKey ?? "")}\n(click to copy q,r)`}
              </title>
            </g>
          );
        })}

        {/* Tile outlines (thick) */}
        {showTileOutline &&
          outlineSegs.map((s, idx) => (
            <line
              key={idx}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke="#000"
              strokeWidth={4.2}
              strokeLinecap="round"
              opacity={0.9}
            />
          ))}
      </svg>
    );
  }, [result, hexSize, showAllCells, showTileOutline, showOuterTouchBg, showScoutLabel, outerTouchSets]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>Logical Map (Seed → Placement → Cells)</h1>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {/* Template: label select + id display */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontWeight: 700 }}>Template</span>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6 }}
          >
            {TEMPLATE_CHOICES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            id: <code>{templateId}</code>
          </span>
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Seed</span>
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            style={{ width: 180, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Hex size</span>
          <input
            type="number"
            value={hexSize}
            min={18}
            max={60}
            onChange={(e) => setHexSize(Number(e.target.value))}
            style={{ width: 90, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showAllCells} onChange={(e) => setShowAllCells(e.target.checked)} />
          <span>Show all cells (else only planets)</span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showTileOutline} onChange={(e) => setShowTileOutline(e.target.checked)} />
          <span>Show tile outline (thick)</span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showPlacement} onChange={(e) => setShowPlacement(e.target.checked)} />
          <span>Show placement list</span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showTextDump} onChange={(e) => setShowTextDump(e.target.checked)} />
          <span>Show text dump</span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showOuterTouchBg} onChange={(e) => setShowOuterTouchBg(e.target.checked)} />
          <span>Outer=red / Touch=yellow</span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showScoutLabel} onChange={(e) => setShowScoutLabel(e.target.checked)} />
          <span>Show Scout label</span>
        </label>
      </div>

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      {result ? (
        <>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            <span>
              label=<code>{templateLabelOf(String(result.templateId))}</code>, templateId=<code>{String(
                result.templateId
              )}</code>, seed=<code>{String(result.seed)}</code>, cells=<code>{String(
                result.cellsByKey?.size ?? 0
              )}</code>, collisions=<code>{String(result.collisionCount ?? 0)}</code>
            </span>
          </div>

          <h2 style={{ fontSize: 14, fontWeight: 700 }}>Fine Board (Rendered – flat-top default)</h2>

          <div style={{ position: "relative", maxWidth: 1200 }}>
            {toast ? (
              <div
                style={{
                  position: "absolute",
                  top: 10,
                  left: 10,
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: "rgba(0,0,0,0.75)",
                  color: "#fff",
                  fontSize: 12,
                  zIndex: 10,
                }}
              >
                {toast}
              </div>
            ) : null}

            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
              セルをクリックすると <code>q,r</code> をコピーします（Outer=薄赤 / Touch=薄黄）
            </div>

            {svg}
          </div>

          {showPlacement ? (
            <>
              <h2 style={{ fontSize: 14, fontWeight: 700 }}>Placement (slotId → sectorId, rot)</h2>
              <pre
                style={{
                  width: "100%",
                  background: "#111",
                  color: "#c8ffb0",
                  padding: 12,
                  borderRadius: 8,
                  overflow: "auto",
                  whiteSpace: "pre",
                }}
              >
                {placementText || "(no placement)"}
              </pre>
            </>
          ) : null}

          {showTextDump ? (
            <>
              <h2 style={{ fontSize: 14, fontWeight: 700 }}>Text Dump</h2>
              <textarea
                value={dumpText}
                readOnly
                rows={26}
                style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              />
            </>
          ) : null}

          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Notes:
            <ul>
              <li>
                This page uses <strong>flat-top</strong> hex rendering as the global default (top edge horizontal).
              </li>
              <li>
                Tile outline is computed from <code>cell.slotId</code>: an edge is thick if the neighbor is missing or belongs
                to a different slot.
              </li>
              <li>
                Outer/Touch coloring references <code>evaluate.ts</code> SSOT sets (templateKey or coord).
              </li>
              <li>
                Scout label is shown only for <code>S*</code> slots at <code>localKey="0,0"</code> (minimal, non-intrusive).
              </li>
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
