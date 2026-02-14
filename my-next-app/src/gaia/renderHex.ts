import type { Axial } from "./types";

// pointy-top axial -> pixel
export function axialToPixel(pos: Axial, size: number): { x: number; y: number } {
  // pointy-top layout
  // x = size * sqrt(3) * (q + r/2)
  // y = size * 3/2 * r
  const x = size * Math.sqrt(3) * (pos.q + pos.r / 2);
  const y = size * (3 / 2) * pos.r;
  return { x, y };
}

export function hexCorner(centerX: number, centerY: number, size: number, i: number) {
  // pointy-top: 30deg offset
  const angle = ((Math.PI / 180) * (60 * i - 30));
  return {
    x: centerX + size * Math.cos(angle),
    y: centerY + size * Math.sin(angle),
  };
}

export function hexPolygonPoints(centerX: number, centerY: number, size: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => hexCorner(centerX, centerY, size, i));
  return pts.map((p) => `${p.x},${p.y}`).join(" ");
}

// Edge midpoints for drawing 6 edge segments (index 0..5)
export function hexEdgeMidpoints(centerX: number, centerY: number, size: number) {
  const corners = Array.from({ length: 6 }, (_, i) => hexCorner(centerX, centerY, size, i));
  const mids = Array.from({ length: 6 }, (_, i) => {
    const a = corners[i];
    const b = corners[(i + 1) % 6];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
  return { corners, mids };
}
