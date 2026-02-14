"use client";

import React, { useMemo, useState } from "react";
import GaiaBoardSvg from "../components/GaiaBoardSvg";
import { generateMap } from "../gaia/generator";
import type { Tile } from "../gaia/types";
import { SAMPLE_SLOTS, SAMPLE_TILES } from "../gaia/sampleData";

export default function Page() {
  const [seed, setSeed] = useState("demo-seed");

  const tilesById = useMemo(() => {
    const m = new Map<string, Tile>();
    for (const t of SAMPLE_TILES) m.set(t.id, t);
    return m;
  }, []);

  const result = useMemo(() => {
    return generateMap(SAMPLE_SLOTS, SAMPLE_TILES, { seed, maxBacktracks: 50_000 });
  }, [seed]);

  if (!result.ok) {
    return (
      <div style={{ padding: 16 }}>
        <h2>Gaia Map Generator</h2>
        <div style={{ marginBottom: 12 }}>
          <label>
            Seed:{" "}
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              style={{ border: "1px solid #ccc", padding: 6, borderRadius: 6, width: 240 }}
            />
          </label>
        </div>
        <div style={{ color: "crimson" }}>
          FAILED: {result.reason} (backtracks={result.backtracks})
        </div>
      </div>
    );
  }

  const placements = result.board.toPlacements();

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: "0 0 12px 0" }}>Gaia Map Generator (M1〜M3)</h2>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <label>
          Seed:{" "}
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            style={{ border: "1px solid #ccc", padding: 6, borderRadius: 6, width: 240 }}
          />
        </label>
        <div>backtracks: {result.backtracks}</div>
      </div>

      <GaiaBoardSvg slots={SAMPLE_SLOTS} tilesById={tilesById} placements={placements} hexSize={50} />
    </div>
  );
}
