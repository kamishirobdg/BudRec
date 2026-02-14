import { Axial, Tile } from "./types";

// Simple small board: center + 6 around (7 slots)
export const SAMPLE_SLOTS: readonly Axial[] = Object.freeze([
  { q: 0, r: 0 },
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]);

// For MVP, use only SPACE/LANE edges; generation checks that adjacent edges match.
// These tiles are intentionally made compatible in multiple ways.
export const SAMPLE_TILES: readonly Tile[] = Object.freeze([
  { id: "T1", edges: ["LANE", "SPACE", "SPACE", "LANE", "SPACE", "SPACE"] },
  { id: "T2", edges: ["SPACE", "LANE", "SPACE", "SPACE", "LANE", "SPACE"] },
  { id: "T3", edges: ["SPACE", "SPACE", "LANE", "SPACE", "SPACE", "LANE"] },
  { id: "T4", edges: ["LANE", "LANE", "SPACE", "SPACE", "SPACE", "SPACE"] },
  { id: "T5", edges: ["SPACE", "SPACE", "SPACE", "LANE", "LANE", "SPACE"] },
  { id: "T6", edges: ["SPACE", "LANE", "LANE", "SPACE", "SPACE", "SPACE"] },
  { id: "T7", edges: ["SPACE", "SPACE", "SPACE", "SPACE", "LANE", "LANE"] },
]);
