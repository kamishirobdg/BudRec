// src/gaia/logicalMap/outerTouch.ts
import { OUTER_CELLS_BY_TEMPLATE, TOUCH_CELLS_BY_TEMPLATE } from "../board/evaluate";

export type OuterTouchSets = {
  outerTk: Set<string>;
  outerCoord: Set<string>;
  touchTk: Set<string>;
  touchCoord: Set<string>;
};

export function buildOuterTouchSets(templateId: string): OuterTouchSets {
  const outerRaw = (OUTER_CELLS_BY_TEMPLATE as any)?.[templateId] ?? [];
  const touchRaw = (TOUCH_CELLS_BY_TEMPLATE as any)?.[templateId] ?? [];

  const outerTk = new Set<string>();
  const outerCoord = new Set<string>();
  for (const x of outerRaw) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    if (s.includes(":")) outerTk.add(s);
    else outerCoord.add(s); // "q,r"
  }

  const touchTk = new Set<string>();
  const touchCoord = new Set<string>();
  for (const x of touchRaw) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    if (s.includes(":")) touchTk.add(s);
    else touchCoord.add(s); // "q,r"
  }

  return { outerTk, outerCoord, touchTk, touchCoord };
}

export function isOuterCell(
  sets: OuterTouchSets,
  cell: { pos: { q: number; r: number }; slotId?: string; localKey?: string }
): boolean {
  const coord = `${cell.pos.q},${cell.pos.r}`;
  if (sets.outerCoord.has(coord)) return true;
  const slotId = String(cell.slotId ?? "");
  const localKey = String(cell.localKey ?? "");
  if (slotId && localKey) {
    const tk = `${slotId}:${localKey}`;
    if (sets.outerTk.has(tk)) return true;
  }
  return false;
}

export function isTouchCell(
  sets: OuterTouchSets,
  cell: { pos: { q: number; r: number }; slotId?: string; localKey?: string }
): boolean {
  const coord = `${cell.pos.q},${cell.pos.r}`;
  if (sets.touchCoord.has(coord)) return true;
  const slotId = String(cell.slotId ?? "");
  const localKey = String(cell.localKey ?? "");
  if (slotId && localKey) {
    const tk = `${slotId}:${localKey}`;
    if (sets.touchTk.has(tk)) return true;
  }
  return false;
}
