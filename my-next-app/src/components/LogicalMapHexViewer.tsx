"use client";

import * as React from "react";

export type Axial = { q: number; r: number };

export type LogicalCell = {
  pos: Axial;
  kind?: string;
  planetType?: string | null;
  slotId?: string;
  sectorId?: string;
};

type Props = {
  cellsByKey: Map<string, LogicalCell>;
  hexSize?: number; // default 16
  showLabels?: boolean; // default true
};

/** "q,r" */
function coordKey(q: number, r: number) {
  return `${q},${r}`;
}

/** pointy-top axial -> pixel */
function axialToPixel(q: number, r: number, size: number) {
  return {
    x: size * Math.sqrt(3) * (q + r / 2),
    y: size * 1.5 * r,
  };
}

function hexPolygonPoints(cx: number, cy: number, size: number) {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${cx + size * Math.cos(a)},${cy + size * Math.sin(a)}`);
  }
  return pts.join(" ");
}

function cellFill(c: LogicalCell) {
  const u = String(c.planetType ?? "").toUpperCase();
  // デバッグ用途：視認性優先
  if (u === "BLACK") return "#111827";
  if (u === "BLUE") return "#2563eb";
  if (u === "BROWN") return "#92400e";
  if (u === "ORANGE") return "#f97316";
  if (u === "RED") return "#dc2626";
  if (u === "WHITE") return "#e5e7eb";
  if (u === "YELLOW") return "#facc15";
  if (u === "GAIA") return "#10b981";
  if (u === "TRANSDIM") return "#7c3aed";

  // planetType不明の planet は灰、空は薄灰
  if (String(c.kind).toLowerCase() === "planet") return "#9ca3af";
  return "#d1d5db";
}

function labelChar(c: LogicalCell) {
  const u = String(c.planetType ?? "").toUpperCase();
  // 1文字で被りにくい割当（既存の legend に合わせたいならここだけ調整）
  if (u === "BLACK") return "K";
  if (u === "BLUE") return "U";
  if (u === "BROWN") return "N";
  if (u === "ORANGE") return "O";
  if (u === "RED") return "R";
  if (u === "WHITE") return "W";
  if (u === "YELLOW") return "Y";
  if (u === "GAIA") return "G";
  if (u === "TRANSDIM") return "T";
  return "";
}

async function copyText(text: string) {
  // Clipboard API は https / localhost 前提。失敗時は fallback。
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

export function LogicalMapHexViewer({ cellsByKey, hexSize = 16, showLabels = true }: Props) {
  const cells = React.useMemo(() => Array.from(cellsByKey.values()), [cellsByKey]);

  // bounds (pixel)
  const { minX, maxX, minY, maxY } = React.useMemo(() => {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    for (const c of cells) {
      const { x, y } = axialToPixel(c.pos.q, c.pos.r, hexSize);
      // polygon外周分の余白を加味
      minX = Math.min(minX, x - hexSize * 1.2);
      maxX = Math.max(maxX, x + hexSize * 1.2);
      minY = Math.min(minY, y - hexSize * 1.2);
      maxY = Math.max(maxY, y + hexSize * 1.2);
    }
    if (!cells.length) {
      minX = 0;
      maxX = 300;
      minY = 0;
      maxY = 200;
    }
    return { minX, maxX, minY, maxY };
  }, [cells, hexSize]);

  const width = Math.max(100, maxX - minX);
  const height = Math.max(100, maxY - minY);

  const [toast, setToast] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 900);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div style={{ position: "relative" }}>
      {toast && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            padding: "6px 10px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.75)",
            color: "white",
            fontSize: 12,
            zIndex: 10,
          }}
        >
          {toast}
        </div>
      )}

      <svg
        width="100%"
        height={Math.ceil(height)}
        viewBox={`${minX} ${minY} ${width} ${height}`}
        style={{ border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}
      >
        {cells.map((c) => {
          const { x, y } = axialToPixel(c.pos.q, c.pos.r, hexSize);
          const pts = hexPolygonPoints(x, y, hexSize);
          const key = coordKey(c.pos.q, c.pos.r);
          const title = `${key} | ${c.planetType ?? ""} | ${c.slotId ?? ""} | ${c.sectorId ?? ""}`;

          return (
            <g
              key={key}
              style={{ cursor: "pointer" }}
              onClick={async () => {
                const ok = await copyText(key);
                setToast(ok ? `Copied: ${key}` : `Copy failed: ${key}`);
              }}
            >
              <title>{title}</title>
              <polygon points={pts} fill={cellFill(c)} stroke="#111827" strokeWidth={0.6} opacity={0.95} />
              {showLabels && (
                <text
                  x={x}
                  y={y + 4}
                  textAnchor="middle"
                  fontSize={12}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
                  fill="#111827"
                >
                  {labelChar(c)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div style={{ marginTop: 8, fontSize: 12, color: "#374151" }}>
        セルをクリックすると <code>q,r</code> をコピーします（例: <code>12,-3</code>）
      </div>
    </div>
  );
}
