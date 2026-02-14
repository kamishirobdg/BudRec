// src/gaia/board/persistence.ts
import type { SlotPlacement } from "./types";

export type BoardStateV2 = {
  version: 2;
  id: string;
  templateId: string;
  createdAt: string; // ISO
  seed?: string;
  placements: SlotPlacement[];
  note?: string;
};

const LS_KEY_V2 = "gaia.boardStates.v2";
// backward-compat (older builds)
const LS_KEY_V1 = "gaia.boardStates.v1";

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  const g = (globalThis as any).crypto?.randomUUID?.();
  if (typeof g === "string") return g;
  return `bs_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeParse(raw: string | null): any[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Load v2 states; additionally, if v2 is empty and v1 exists, read v1 for visibility.
 * (We do NOT auto-write/migrate v1->v2 to avoid accidental duplication.)
 */
export function loadBoardStates(): BoardStateV2[] {
  const v2 = safeParse(localStorage.getItem(LS_KEY_V2)).filter((x) => x?.version === 2) as BoardStateV2[];
  if (v2.length > 0) return v2;

  // Read v1 as "v2-like" for listing; seed is unknown.
  const v1 = safeParse(localStorage.getItem(LS_KEY_V1)).filter((x) => x?.version === 1) as any[];
  return v1.map((x) => ({
    version: 2 as const,
    id: String(x.id ?? makeId()),
    templateId: String(x.templateId ?? "unknown"),
    createdAt: String(x.createdAt ?? nowIso()),
    seed: undefined,
    placements: Array.isArray(x.placements) ? x.placements : [],
    note: x.note,
  }));
}

export function saveBoardStates(all: BoardStateV2[]): void {
  localStorage.setItem(LS_KEY_V2, JSON.stringify(all));
}

export function createBoardState(
  templateId: string,
  placements: SlotPlacement[],
  seed?: string,
  note?: string
): BoardStateV2 {
  return {
    version: 2,
    id: makeId(),
    templateId,
    createdAt: nowIso(),
    seed: seed?.trim() ? seed.trim() : undefined,
    placements,
    note: note?.trim() ? note.trim() : undefined,
  };
}

export function addBoardState(state: BoardStateV2, maxItems = 200): BoardStateV2[] {
  const all = loadBoardStates().filter((x) => x.version === 2); // avoid v1-derived pseudo entries
  const next = [state, ...all].slice(0, maxItems);
  saveBoardStates(next);
  return next;
}

export function removeBoardState(id: string): BoardStateV2[] {
  const all = loadBoardStates().filter((x) => x.version === 2);
  const next = all.filter((x) => x.id !== id);
  saveBoardStates(next);
  return next;
}

export function clearBoardStates(): void {
  localStorage.removeItem(LS_KEY_V2);
  // also clear old key to keep UI consistent
  localStorage.removeItem(LS_KEY_V1);
}
