// src/gaia/logicalMap/dumpLogicalMap.ts

import type { LogicalMap } from "./types";

type DumpOptions = {
  showCoords?: boolean;
  cellWidth?: number; // fixed column width
  emptyToken?: string; // for space cells
  missingToken?: string; // for cells that do not exist
};

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

export function dumpLogicalMap(map: LogicalMap, opts: DumpOptions = {}): string {
  const showCoords = opts.showCoords ?? true;
  const w = opts.cellWidth ?? 10;
  const emptyToken = opts.emptyToken ?? ".";
  const missingToken = opts.missingToken ?? "";

  const cells = [...map.cells.values()];
  if (cells.length === 0) return "(no cells)";

  let minQ = Infinity,
    maxQ = -Infinity,
    minR = Infinity,
    maxR = -Infinity;

  for (const c of cells) {
    minQ = Math.min(minQ, c.pos.q);
    maxQ = Math.max(maxQ, c.pos.q);
    minR = Math.min(minR, c.pos.r);
    maxR = Math.max(maxR, c.pos.r);
  }

  const lines: string[] = [];
  lines.push(`logicalMap templateId=${map.templateId} seed=${String(map.seed)}`);
  lines.push(`range q:[${minQ},${maxQ}] r:[${minR},${maxR}] cells=${cells.length}`);

  if (showCoords) {
    // header q
    let header = pad("r\\q", w);
    for (let q = minQ; q <= maxQ; q++) header += pad(String(q), w);
    lines.push(header);
  }

  for (let r = maxR; r >= minR; r--) {
    let row = showCoords ? pad(String(r), w) : "";
    for (let q = minQ; q <= maxQ; q++) {
      const k = `${q},${r}`;
      const c = map.cells.get(k);
      if (!c) {
        row += pad(missingToken, w);
        continue;
      }
      if (c.kind === "planet") {
        row += pad(String(c.planetType ?? "PLANET"), w);
      } else if (c.kind === "scout") {
        row += pad("SCOUT", w);
      } else if (c.kind === "special") {
        row += pad("SPECIAL", w);
      } else {
        row += pad(emptyToken, w);
      }
    }
    lines.push(row);
  }

  return lines.join("\n");
}
