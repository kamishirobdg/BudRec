"use client";

import React, { useMemo, useState } from "react";
import { BASE_SECTORS } from "@/gaia/sectorTiles_base";
import {
  EXPANSION_MIDDLE,
  EXPANSION_LITTLE,
  EXPANSION_SCOUT,
  EXPANSION_MIDDLE_IDS,
  EXPANSION_LITTLE_IDS,
  EXPANSION_SCOUT_IDS,
} from "@/gaia/sectorTiles_lostfleet";

type Axial = { q: number; r: number };

function parseLocalKey(k: string): Axial {
  const [q, r] = k.split(",").map((v) => Number(v));
  return { q, r };
}

function keyOf(a: Axial) {
  return `${a.q},${a.r}`;
}

// cube rotation (CW) for axial coords
function rotate60(ax: Axial, stepsCW: number): Axial {
  let q = ax.q;
  let r = ax.r;
  const s = ((stepsCW % 6) + 6) % 6;

  for (let i = 0; i < s; i++) {
    const x = q;
    const z = r;
    const y = -x - z;

    // cube CW: (x,y,z) -> (-z, -x, -y)
    const nx = -z;
    const ny = -x;
    const nz = -y;

    q = nx;
    r = nz;
  }
  return { q, r };
}

// pointy-top axial->pixel
function axialToPixelPointy(a: Axial, size: number) {
  const x = size * Math.sqrt(3) * (a.q + a.r / 2);
  const y = size * 1.5 * a.r;
  return { x, y };
}
function hexPointsPointy(cx: number, cy: number, size: number) {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    pts.push([cx + size * Math.cos(ang), cy + size * Math.sin(ang)]);
  }
  return pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

// flat-top axial->pixel
function axialToPixelFlat(a: Axial, size: number) {
  const x = size * 1.5 * a.q;
  const y = size * Math.sqrt(3) * (a.r + a.q / 2);
  return { x, y };
}
function hexPointsFlat(cx: number, cy: number, size: number) {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i);
    pts.push([cx + size * Math.cos(ang), cy + size * Math.sin(ang)]);
  }
  return pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

type TileDefLike = {
  id: string;
  radius?: number;
  cells: Record<string, any>;
};

function buildLookup() {
  const m = new Map<string, { def: TileDefLike; source: "base" | "lf_middle" | "lf_little" | "lf_scout" }>();

  for (const t of BASE_SECTORS as any[]) m.set(String(t.id), { def: t, source: "base" });
  for (const t of EXPANSION_MIDDLE as any[]) m.set(String(t.id), { def: t, source: "lf_middle" });
  for (const t of EXPANSION_LITTLE as any[]) m.set(String(t.id), { def: t, source: "lf_little" });
  for (const t of EXPANSION_SCOUT as any[]) m.set(String(t.id), { def: t, source: "lf_scout" });

  return m;
}

function planetTypeOf(raw: any): string | null {
  if (!raw) return null;
  if (raw.kind === "planet") return String(raw.planetType ?? raw.planet ?? "");
  return null;
}

function isEmptyCell(raw: any): boolean {
  if (!raw) return true;
  return raw.kind === "empty" || raw.kind === "space";
}

/**
 * Display-only transform (does NOT change localKey truth).
 * This is for matching your intended "visual columns" without mutating sectorTiles_*.
 */
type DisplayTransformId = "identity" | "swap_qr" | "neg_q" | "neg_r" | "swap_negq" | "swap_negr";
function applyDisplayTransform(a: Axial, t: DisplayTransformId): Axial {
  switch (t) {
    case "identity":
      return a;
    case "swap_qr":
      return { q: a.r, r: a.q };
    case "neg_q":
      return { q: -a.q, r: a.r };
    case "neg_r":
      return { q: a.q, r: -a.r };
    case "swap_negq":
      return { q: -a.r, r: a.q };
    case "swap_negr":
      return { q: a.r, r: -a.q };
    default:
      return a;
  }
}

export default function Page() {
  const lookup = useMemo(() => buildLookup(), []);

  const [tileId, setTileId] = useState<string>("02");
  const [rot, setRot] = useState<number>(0);
  const [layout, setLayout] = useState<"pointy" | "flat">("flat");
  const [displayTf, setDisplayTf] = useState<DisplayTransformId>("identity");
  const [showEmpty, setShowEmpty] = useState<boolean>(true);
  const [showLocalKey, setShowLocalKey] = useState<boolean>(true);
  const [showRotatedPos, setShowRotatedPos] = useState<boolean>(false);
  const [showDisplayPos, setShowDisplayPos] = useState<boolean>(true);
  const [size, setSize] = useState<number>(32);

  const tile = lookup.get(tileId)?.def ?? null;
  const source = lookup.get(tileId)?.source ?? null;

  const prepared = useMemo(() => {
    if (!tile) return null;

    const entries = Object.entries(tile.cells ?? {}).map(([localKey, rawCell]) => {
      const local = parseLocalKey(localKey);
      const rotated = rotate60(local, rot);
      const displayAx = applyDisplayTransform(rotated, displayTf);
      const pt = planetTypeOf(rawCell);
      const empty = isEmptyCell(rawCell);

      return { localKey, rawCell, local, rotated, displayAx, planetType: pt, empty };
    });

    const filtered = showEmpty ? entries : entries.filter((e) => !e.empty);

    // bounds in pixel space (based on displayAx)
    const toPix = layout === "flat" ? axialToPixelFlat : axialToPixelPointy;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of filtered) {
      const p = toPix(e.displayAx, size);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;

    const pad = size * 2.4;
    const view = {
      minX: minX - pad,
      minY: minY - pad,
      w: (maxX - minX) + pad * 2,
      h: (maxY - minY) + pad * 2,
    };

    // sanity: duplicates in display positions can happen if transform is degenerate (shouldn't),
    // but we still detect duplicates in rotated positions (must never happen in a single tile).
    const seenRot = new Map<string, string>();
    const rotCollisions: Array<{ pos: string; a: string; b: string }> = [];
    for (const e of filtered) {
      const k = keyOf(e.rotated);
      const prev = seenRot.get(k);
      if (prev && prev !== e.localKey) rotCollisions.push({ pos: k, a: prev, b: e.localKey });
      else seenRot.set(k, e.localKey);
    }

    return { entries: filtered, view, rotCollisions };
  }, [tile, rot, layout, displayTf, showEmpty, size]);

  const allIds = useMemo(() => Array.from(lookup.keys()).sort(), [lookup]);
  const baseIds = useMemo(() => (BASE_SECTORS as any[]).map((t) => String(t.id)).sort(), []);
  const lfIds = useMemo(
    () => [...EXPANSION_MIDDLE_IDS, ...EXPANSION_LITTLE_IDS, ...EXPANSION_SCOUT_IDS].map(String).sort(),
    []
  );

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" }}>
      <h2>Tile Address Debug (localKey is the source of truth)</h2>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Tile ID:
          <input
            value={tileId}
            onChange={(e) => setTileId(e.target.value.trim())}
            style={{ marginLeft: 8, padding: 6, width: 110 }}
          />
        </label>

        <label>
          Pick:
          <select value={tileId} onChange={(e) => setTileId(e.target.value)} style={{ marginLeft: 8, padding: 6 }}>
            <optgroup label="Base">
              {baseIds.map((id) => (
                <option key={`b-${id}`} value={id}>
                  {id}
                </option>
              ))}
            </optgroup>
            <optgroup label="Lost Fleet">
              {lfIds.map((id) => (
                <option key={`lf-${id}`} value={id}>
                  {id}
                </option>
              ))}
            </optgroup>
            <optgroup label="All (sorted)">
              {allIds.map((id) => (
                <option key={`a-${id}`} value={id}>
                  {id}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label>
          rot (CW 60° steps):
          <select value={rot} onChange={(e) => setRot(Number(e.target.value))} style={{ marginLeft: 8, padding: 6 }}>
            {[0, 1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>

        <label>
          Layout:
          <select value={layout} onChange={(e) => setLayout(e.target.value as any)} style={{ marginLeft: 8, padding: 6 }}>
            <option value="flat">flat-top</option>
            <option value="pointy">pointy-top</option>
          </select>
        </label>

        <label>
          Display transform:
          <select value={displayTf} onChange={(e) => setDisplayTf(e.target.value as any)} style={{ marginLeft: 8, padding: 6 }}>
            <option value="identity">identity</option>
            <option value="swap_qr">swap(q,r)</option>
            <option value="neg_q">neg q</option>
            <option value="neg_r">neg r</option>
            <option value="swap_negq">swap then neg q (q=-r,r=q)</option>
            <option value="swap_negr">swap then neg r (q=r,r=-q)</option>
          </select>
        </label>

        <label>
          Hex size:
          <input
            type="number"
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            style={{ marginLeft: 8, padding: 6, width: 90 }}
            min={18}
            max={60}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          show empty
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showLocalKey} onChange={(e) => setShowLocalKey(e.target.checked)} />
          show localKey
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showRotatedPos} onChange={(e) => setShowRotatedPos(e.target.checked)} />
          show rotated(q,r)
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={showDisplayPos} onChange={(e) => setShowDisplayPos(e.target.checked)} />
          show display(q,r)
        </label>
      </div>

      <div style={{ marginTop: 10, color: "#333" }}>
        <div>
          <strong>source:</strong> {source ?? "(not found)"}{" "}
          {tile ? (
            <>
              <strong style={{ marginLeft: 12 }}>radius:</strong> {String((tile as any).radius ?? "?")}{" "}
              <strong style={{ marginLeft: 12 }}>cells:</strong> {Object.keys(tile.cells ?? {}).length}
            </>
          ) : (
            <span style={{ marginLeft: 12, color: "#a00" }}>tile not found</span>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          localKey is read from sectorTiles_* (truth). We apply rot (for preview), then apply a display-only transform so you can match your intended visual axis without mutating data.
        </div>
      </div>

      {prepared && (
        <>
          {prepared.rotCollisions.length > 0 && (
            <pre style={{ marginTop: 12, background: "#2b0000", color: "#ffd0d0", padding: 12, overflow: "auto" }}>
              INTERNAL COLLISION INSIDE TILE (should not happen):
              {"\n"}
              {prepared.rotCollisions.map((c, i) => `#${i + 1} at ${c.pos}: ${c.a} vs ${c.b}`).join("\n")}
            </pre>
          )}

          <h3 style={{ marginTop: 16 }}>Tile (Rendered)</h3>
          <div style={{ maxWidth: 900 }}>
            <svg
              width="100%"
              height="auto"
              viewBox={`${prepared.view.minX} ${prepared.view.minY} ${prepared.view.w} ${prepared.view.h}`}
              style={{ border: "1px solid #ddd", borderRadius: 12, background: "#fff" }}
            >
              {prepared.entries.map((e) => {
                const toPix = layout === "flat" ? axialToPixelFlat : axialToPixelPointy;
                const ptsFn = layout === "flat" ? hexPointsFlat : hexPointsPointy;

                const p = toPix(e.displayAx, size);
                const pts = ptsFn(p.x, p.y, size);

                const pt = e.planetType;
                const isPlanet = !!pt;

                const stroke = isPlanet ? "#111" : "#c7c7c7";
                const strokeW = isPlanet ? 2.6 : 1.2;

                return (
                  <g key={e.localKey}>
                    <polygon points={pts} fill="#fff" stroke={stroke} strokeWidth={strokeW} />

                    {isPlanet && (
                      <text
                        x={p.x}
                        y={p.y - 10}
                        textAnchor="middle"
                        fontSize={Math.max(10, size * 0.34)}
                        fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
                        fill="#111"
                      >
                        {pt}
                      </text>
                    )}

                    {showLocalKey && (
                      <text
                        x={p.x}
                        y={p.y + 6}
                        textAnchor="middle"
                        fontSize={Math.max(9, size * 0.28)}
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                        fill="#111"
                      >
                        {e.localKey}
                      </text>
                    )}

                    {showRotatedPos && (
                      <text
                        x={p.x}
                        y={p.y + 22}
                        textAnchor="middle"
                        fontSize={Math.max(9, size * 0.26)}
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                        fill="#444"
                      >
                        rot:{keyOf(e.rotated)}
                      </text>
                    )}

                    {showDisplayPos && (
                      <text
                        x={p.x}
                        y={p.y + 38}
                        textAnchor="middle"
                        fontSize={Math.max(9, size * 0.26)}
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                        fill="#666"
                      >
                        disp:{keyOf(e.displayAx)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <h3 style={{ marginTop: 16 }}>Address List (localKey → rotated → display)</h3>
          <pre style={{ background: "#111", color: "#c8ffb0", padding: 12, overflow: "auto", maxHeight: 420 }}>
            {prepared.entries
              .slice()
              .sort((a, b) => a.localKey.localeCompare(b.localKey))
              .map((e) => {
                const pt = e.planetType ? ` planet=${e.planetType}` : "";
                return `${e.localKey} -> rot${rot} ${keyOf(e.rotated)} -> disp ${keyOf(e.displayAx)}${pt}`;
              })
              .join("\n")}
          </pre>
        </>
      )}
    </div>
  );
}
