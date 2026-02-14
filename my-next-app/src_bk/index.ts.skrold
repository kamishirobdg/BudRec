import { generateMap } from "./GAIA/generator";
import { SAMPLE_SLOTS, SAMPLE_TILES } from "./GAIA/sampleData";

const res = generateMap(SAMPLE_SLOTS, SAMPLE_TILES, { seed: "demo-seed", maxBacktracks: 50_000 });

if (!res.ok) {
  console.error("FAILED:", res.reason, "backtracks=", res.backtracks);
  process.exit(1);
}

console.log("OK backtracks=", res.backtracks);
console.table(
  res.board.toPlacements().map((p) => ({
    pos: `${p.pos.q},${p.pos.r}`,
    tile: p.tileId,
    rot: p.rot,
  }))
);
