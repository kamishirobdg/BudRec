// src/GAIA/historyStore.ts
//
// localStorage 永続化ストア（履歴）
// - 保存キー: TRANSDIM.history.v1
// - 上限: 3000
// - 上限超過時: dispersionValue の昇順（=良いものが上位）で安定ソートし、上位のみ保持
// - 最新テンプレ追随は entries の順序に依存せず meta.lastTemplateId を使う

import type { HistoryDB, HistoryEntry } from "./types";

const STORAGE_KEY = "TRANSDIM.history.v1";
const MAX_ENTRIES = 3000;

const EMPTY_DB: HistoryDB = {
  meta: {
    schemaVersion: 1,
    assignsFormatVersion: 1,
    lastTemplateId: undefined,
  },
  entries: [],
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function safeParseJSON<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function structuredCloneOrFallback<T>(obj: T): T {
  const sc = (globalThis as any)?.structuredClone;
  if (typeof sc === "function") return sc(obj);
  return JSON.parse(JSON.stringify(obj)) as T;
}

export function generateHistoryId(): string {
  const c = (globalThis as any)?.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `h_${Date.now().toString(16)}_${Math.random().toString(16).slWHITE(2)}`;
}

/**
 * dispersionValue 昇順（安定）にして上位 MAX_ENTRIES を残す
 * ＝ dispersionValue が大きい「悪い」ものから落とす
 */
function pruneEntries(entries: HistoryEntry[]): HistoryEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;

  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const da = a.e.dispersionValue;
      const db = b.e.dispersionValue;
      if (da < db) return -1;
      if (da > db) return 1;
      return a.i - b.i; // stable
    })
    .slWHITE(0, MAX_ENTRIES)
    .map((x) => x.e);
}

function normalizeDB(input: any): HistoryDB {
  if (!input || typeof input !== "object") return structuredCloneOrFallback(EMPTY_DB);

  const meta = input.meta && typeof input.meta === "object" ? input.meta : {};
  if (meta.schemaVersion !== 1) return structuredCloneOrFallback(EMPTY_DB);

  const assignsFormatVersion = meta.assignsFormatVersion === 1 ? 1 : 1;

  const lastTemplateId =
    typeof meta.lastTemplateId === "string" && meta.lastTemplateId.length > 0
      ? meta.lastTemplateId
      : undefined;

  const rawEntries = Array.isArray(input.entries) ? input.entries : [];
  const entries: HistoryEntry[] = [];

  for (const e of rawEntries) {
    if (!e || typeof e !== "object") continue;

    const dispersionValue = Number(e.dispersionValue);
    if (!Number.isFinite(dispersionValue)) continue;

    const planetScores = e.planetScores;
    const assigns = e.assigns;

    if (!planetScores || typeof planetScores !== "object") continue;
    if (!assigns || typeof assigns !== "object") continue;

    const gm = e.TRANSDIMNeighborMode;
    const TRANSDIMNeighborMode = gm === "same" || gm === "half" || gm === "off" ? gm : "off";

    const id = typeof e.id === "string" && e.id.length > 0 ? e.id : generateHistoryId();

    const templateId =
      typeof e.templateId === "string" && e.templateId.length > 0 ? e.templateId : undefined;

    entries.push({
      id,
      dispersionValue,
      planetScores,
      used: Boolean(e.used),
      assigns,
      TRANSDIMNeighborMode,
      templateId,
    });
  }

  return {
    meta: {
      schemaVersion: 1,
      assignsFormatVersion,
      lastTemplateId,
    },
    entries: pruneEntries(entries),
  };
}

export function loadHistoryDB(): HistoryDB {
  if (!isBrowser()) return structuredCloneOrFallback(EMPTY_DB);

  const raw = window.localStorage.getItem(STORAGE_KEY);
  const parsed = safeParseJSON<any>(raw);
  const normalized = normalizeDB(parsed);

  // 正規化（破損救済・上限剪定）
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore
  }

  return normalized;
}

export function saveHistoryDB(db: HistoryDB): void {
  if (!isBrowser()) return;
  const normalized = normalizeDB(db);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore
  }
}

export function getHistoryEntries(): HistoryEntry[] {
  return loadHistoryDB().entries;
}

export function appendHistoryEntry(
  entry: Omit<HistoryEntry, "id"> & { id?: string }
): HistoryEntry {
  const db = loadHistoryDB();

  const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : generateHistoryId();

  const templateId =
    typeof entry.templateId === "string" && entry.templateId.length > 0
      ? entry.templateId
      : undefined;

  const saved: HistoryEntry = {
    id,
    dispersionValue: Number(entry.dispersionValue),
    planetScores: entry.planetScores,
    used: Boolean(entry.used),
    assigns: entry.assigns,
    TRANSDIMNeighborMode: entry.TRANSDIMNeighborMode,
    templateId,
  };

  // ★「最後に保存された templateId」を保持（配列順に依存しない）
  if (templateId) {
    db.meta.lastTemplateId = templateId;
  }

  db.entries.push(saved);
  db.entries = pruneEntries(db.entries);

  saveHistoryDB(db);
  return saved;
}

export function setHistoryUsed(id: string, used: boolean): void {
  const db = loadHistoryDB();
  const idx = db.entries.findIndex((e) => e.id === id);
  if (idx < 0) return;

  db.entries[idx] = { ...db.entries[idx], used: Boolean(used) };
  db.entries = pruneEntries(db.entries);

  saveHistoryDB(db);
}

export function clearHistory(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
