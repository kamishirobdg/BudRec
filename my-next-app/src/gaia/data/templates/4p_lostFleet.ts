import type { TemplateDef } from "./types";

export const TEMPLATE_4P_LOSTFLEET: TemplateDef = {
  templateId: "4p_lostFleet",
  label: "4人 Lost Fleet",
  playerCount: 4,
  expansion: "lostFleet",
  slots: [
    // LARGE 9
    { slotId: "L1", pos: { q: 11, r: 10 }, accepts: ["LARGE"] },
    { slotId: "L2", pos: { q: 16, r:  6 }, accepts: ["LARGE"] },
    { slotId: "L3", pos: { q: 6, r: 14 }, accepts: ["LARGE"] },
    { slotId: "L4", pos: { q: 3, r: 8 }, accepts: ["LARGE"] },
    { slotId: "L5", pos: { q: 8, r: 4 }, accepts: ["LARGE"] },
    { slotId: "L6", pos: { q: 13, r: 0 }, accepts: ["LARGE"] },
    { slotId: "L7", pos: { q: 7, r:  9 }, accepts: ["LARGE"] },
    { slotId: "L8", pos: { q: 12, r: 5 }, accepts: ["LARGE"] },
    { slotId: "L9", pos: { q: 17, r: 1 }, accepts: ["LARGE"] },
    { slotId: "L10", pos: { q: 2, r: 13}, accepts: ["LARGE"] },

    // MIDDLE 8
    { slotId: "M1", pos: { q: 17, r:3 }, accepts: ["MIDDLE"] },
    { slotId: "M2", pos: { q: 1, r: 16 }, accepts: ["MIDDLE"] },
    { slotId: "M3", pos: { q: 3, r:  5 }, accepts: ["MIDDLE"] },
    { slotId: "M4", pos: { q: 8, r:  1 }, accepts: ["MIDDLE"] },
    { slotId: "M5", pos: { q: 0, r: 11 }, accepts: ["MIDDLE"] },
    { slotId: "M6", pos: { q: 9, r: 13 }, accepts: ["MIDDLE"] },
    { slotId: "M7", pos: { q: 14, r: 9 }, accepts: ["MIDDLE"] },
    { slotId: "M8", pos: { q: 16, r:-2 }, accepts: ["MIDDLE"] },

    // SMALL 8
    { slotId: "S1", pos: { q: 12, r:  7 }, accepts: ["SMALL"] },
    { slotId: "S2", pos: { q: 7, r: 11 }, accepts: ["SMALL"] },
    { slotId: "S3", pos: { q: 14, r: 4 }, accepts: ["SMALL"] },
    { slotId: "S4", pos: { q: 9, r: 8 }, accepts: ["SMALL"] },
    { slotId: "S5", pos: { q: 13, r: 2 }, accepts: ["SMALL"] },
    { slotId: "S6", pos: { q: 10, r: 3 }, accepts: ["SMALL"] },
    { slotId: "S7", pos: { q: 8, r: 6 }, accepts: ["SMALL"] },
    { slotId: "S8", pos: { q: 5, r: 7 }, accepts: ["SMALL"] },
    { slotId: "S9", pos: { q: 3, r: 10}, accepts: ["SMALL"] },
    { slotId: "S10", pos: { q: 4, r: 12}, accepts: ["SMALL"] },
  ],
};
