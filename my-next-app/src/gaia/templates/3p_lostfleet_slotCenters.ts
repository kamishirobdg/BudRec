// src/gaia/templates/3p_lostfleet_slotCenters.ts
// SSOT: slotId -> logical board center (axial q,r)
// 初期値：現行テンプレの pos をそのまま転記（後でここだけ手修正して確定させる）

export const SLOT_CENTERS_3P_LOSTFLEET: Record<string, { q: number; r: number }> = {
  // LARGE 9
  L1: { q: 8, r: 4 },
  L2: { q: 3, r: 8 },
  L3: { q: 13, r: 0 },
  L4: { q: 16, r: 6 },
  L5: { q: 11, r: 10 },
  L6: { q: 6, r: 14 },
  L7: { q: 12, r: 5 },
  L8: { q: 7, r:  9 },
  L9: { q: 2, r: 13 },

  // MIDDLE 8
  M1: { q: 0, r: 11 },
  M2: { q: 15, r: 3 },
  M3: { q: 14, r: 9 },
  M4: { q:  9, r: 13 },
  M5: { q: 14, r: 2 },
  M6: { q: 9, r: 1 },
  M7: { q:  4, r: 5 },
  M8: { q:  2, r: 16 },

  // SMALL 8
  S1: { q: 6, r: 7 },
  S2: { q: 11, r: 3 },
  S3: { q:  4, r: 10 },
  S4: { q:  9, r: 6 },
  S5: { q: 5, r: 12 },
  S6: { q: 8, r: 11 },
  S7: { q: 10, r: 8 },
  S8: { q: 13, r: 7 },
} as const;

//L4	L5	L6
//L9	L7	L8
//L3	L1	L2

//L2	L1	L3
//L9	L8	L7
//L6	L5	L4

/**
 * Middle tiles (Lost Fleet) need a per-rotation translation on LogicalMap
 * because their 3-component geometry shifts the apparent origin when rotated.
 *
 * NOTE:
 * - Key is rotSeed (placementFromSeed output), kept as SSOT.
 * - Value is an axial (q,r) offset added to SLOT_CENTERS_3P_LOSTFLEET[slotId]
 *   before rotating local cells.
 * - Start with all zeros, then calibrate visually per rotSeed.
 */
export const MIDDLE_SLOT_OFFSET_BY_ROT_SEED: Record<number, { q: number; r: number }> = {
  0: { q: 0, r: 0 },
  1: { q: 0, r: 0 },
  2: { q: 0, r: 1 },
  3: { q: 1, r: 0 },
  4: { q: 1, r: 0 },
  5: { q: 1, r: -1 },
} as const;
