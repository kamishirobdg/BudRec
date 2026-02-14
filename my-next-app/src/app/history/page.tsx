// src/app/history/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

import type { PlanetType } from "@/gaia/sectorTypes";
import type { MapLayoutTemplate, SlotAssignment } from "@/gaia/mapTemplates";
import { placementsFromTemplate } from "@/gaia/mapTemplates";
import { loadTemplates } from "@/gaia/templateStore";

import type { HistoryDB, HistoryEntry, PersistedAssigns } from "@/gaia/types";
import { getHistoryEntries, loadHistoryDB, saveHistoryDB, setHistoryUsed } from "@/gaia/historyStore";

import { BASE_SECTORS } from "@/gaia/sectorTiles_base";
import { buildLogicBoardWithLocalColumnShift, type SectorPlacement } from "@/gaia/boardTransforms";
import { axialToPixel, hexPoints, parseKey, type HexOrientation } from "@/gaia/hexLayout";
import { rotate60 } from "@/gaia/axialMath";

// MapViewer と合わせる
const ORIENTATION: HexOrientation = "flat";
const HEX_SIZE = 28;

// MapViewer と合わせる（240°）
const VIEW_ROT60 = 4;
const VIEW_MIRROR = false;

// MapViewer と合わせる（列シフト規則）
const RULE = { shiftsByIndex1: { 3: 1, 4: 1, 5: 2 } } as const;

// Tile 表示（MapViewer デフォルトに合わせる）
const TILE_IMG_FACTOR = 8.6;
const TILE_ROT_DIR: 1 | -1 = 1;
const TILE_ROT_OFFSET60 = 2;
const TILE_ROT_OFFSET_DEG = 0;

type RenderMode = "cells" | "tiles";

type RankedItem = {
  entry: HistoryEntry;
  rankAll: number;
  rankUnused: number | null;
};

function stableSortByDispersion(entries: HistoryEntry[]): HistoryEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const da = a.e.dispersionValue;
      const db = b.e.dispersionValue;
      if (da < db) return -1;
      if (da > db) return 1;
      return a.i - b.i; // stable
    })
    .map((x) => x.e);
}

function buildRanks(entries: HistoryEntry[]): RankedItem[] {
  const allSorted = stableSortByDispersion(entries);
  const rankAllMap = new Map<string, number>();
  allSorted.forEach((e, idx) => rankAllMap.set(e.id, idx + 1));

  const unusedSorted = stableSortByDispersion(entries.filter((e) => !e.used));
  const rankUnusedMap = new Map<string, number>();
  unusedSorted.forEach((e, idx) => rankUnusedMap.set(e.id, idx + 1));

  return entries.map((entry) => ({
    entry,
    rankAll: rankAllMap.get(entry.id) ?? 999999,
    rankUnused: rankUnusedMap.get(entry.id) ?? null,
  }));
}

function toRuntimeAssigns(persisted: PersistedAssigns, slotCount: number): SlotAssignment[] {
  const out: SlotAssignment[] = [];
  for (let i = 0; i < slotCount; i++) {
    const k = String(i);
    const p = persisted[k];
    if (!p) throw new Error(`Missing persisted assigns for slot index=${i}`);
    out.push({
      sectorId: p.tileId,
      rot: p.rot,
    } as SlotAssignment);
  }
  return out;
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function planetLabel(p: PlanetType): string {
  return p;
}

function getTemplateId(entry: HistoryEntry): string | null {
  const t = (entry as any).templateId;
  return typeof t === "string" && t.length > 0 ? t : null;
}

export default function HistoryPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [templates, setTemplates] = useState<MapLayoutTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  const [unusedOnly, setUnusedOnly] = useState<boolean>(true);

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");

  // Tile / 文字（デフォルトは Tile）
  const [renderMode, setRenderMode] = useState<RenderMode>("tiles");

  // 初回のみ：最新テンプレに追随（手動でテンプレ変更したら停止）
  const [autoTemplateApplied, setAutoTemplateApplied] = useState(false);

  // MapViewer と同様：各セルに tile:XX タグを付与
  const SECTORS_WITH_TILE_TAG = useMemo(() => {
    return BASE_SECTORS.map((s) => ({
      ...s,
      cells: Object.fromEntries(
        Object.entries(s.cells).map(([k, c]) => [
          k,
          {
            ...c,
            tags: Array.from(new Set([...(c as any).tags ?? [], `tile:${s.id}`])),
          },
        ])
      ) as any,
    }));
  }, []);

  function refreshEntries() {
    setEntries(getHistoryEntries());
  }

  useEffect(() => {
    const tpls = loadTemplates();
    setTemplates(tpls);
    refreshEntries();

    // 初回テンプレ選択の既定（空なら先頭）
    if (tpls.length > 0) setSelectedTemplateId((prev) => prev || tpls[0].id);
  }, []);

  /**
   * ★初回のみ：DBメタ lastTemplateId に追随（entriesの順序には依存しない）
   */
  useEffect(() => {
    if (autoTemplateApplied) return;
    if (templates.length === 0) return;

    const db = loadHistoryDB();
    const tplId = db.meta.lastTemplateId;

    if (!tplId) return;
    if (!templates.some((t) => t.id === tplId)) return;

    setSelectedTemplateId(tplId);
    setAutoTemplateApplied(true);
  }, [templates, autoTemplateApplied]);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId]
  );

  /**
   * ★テンプレ別に絞った母集団（templateId無しの旧履歴は出さない）
   */
  const entriesOfTemplate = useMemo(() => {
    if (!selectedTemplateId) return [];
    return entries.filter((e) => getTemplateId(e) === selectedTemplateId);
  }, [entries, selectedTemplateId]);

  /**
   * ★ランキングもテンプレ別
   */
  const rankedItems = useMemo(() => buildRanks(entriesOfTemplate), [entriesOfTemplate]);

  const visibleItems = useMemo(() => {
    let items = rankedItems;
    if (unusedOnly) items = items.filter((x) => !x.entry.used);

    if (unusedOnly) {
      items = items
        .filter((x) => x.rankUnused !== null)
        .sort((a, b) => a.rankUnused! - b.rankUnused!);
    } else {
      items = items.sort((a, b) => a.rankAll - b.rankAll);
    }
    return items;
  }, [rankedItems, unusedOnly]);

  /**
   * selectedId 整合（テンプレ切替で候補が変わるので）
   */
  useEffect(() => {
    if (!selectedTemplateId) return;

    if (selectedId && entriesOfTemplate.some((e) => e.id === selectedId)) return;

    if (entriesOfTemplate.length === 0) {
      setSelectedId("");
      return;
    }

    const ranked = buildRanks(entriesOfTemplate);
    const bestUnused = ranked
      .filter((x) => x.rankUnused !== null)
      .sort((a, b) => a.rankUnused! - b.rankUnused!)
      .map((x) => x.entry)[0];

    const bestAll = ranked.sort((a, b) => a.rankAll - b.rankAll).map((x) => x.entry)[0];

    setSelectedId((bestUnused ?? bestAll)?.id ?? "");
  }, [selectedTemplateId, entriesOfTemplate, selectedId]);

  const selectedItem = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId]
  );

  /**
   * board と placements を同時に構築（Tile描画で placements が必要）
   */
  const built = useMemo(() => {
    if (!selectedTemplate || !selectedItem) return { board: null as any, placements: [] as SectorPlacement[] };

    const itemTpl = getTemplateId(selectedItem);
    if (itemTpl && itemTpl !== selectedTemplate.id) {
      return { board: null as any, placements: [] as SectorPlacement[] };
    }

    try {
      const assigns = toRuntimeAssigns(selectedItem.assigns, selectedTemplate.slots.length);
      const placements: SectorPlacement[] = placementsFromTemplate(selectedTemplate, assigns);

      const board = buildLogicBoardWithLocalColumnShift(SECTORS_WITH_TILE_TAG, placements, {
        viewRot60: VIEW_ROT60,
        viewMirror: VIEW_MIRROR,
        orientationForColumnOrder: "flat",
        sizeForColumnOrder: HEX_SIZE,
        rule: RULE,
      });

      return { board, placements };
    } catch (err) {
      console.error("History build failed:", err);
      return { board: null as any, placements: [] as SectorPlacement[] };
    }
  }, [selectedTemplate, selectedItem, SECTORS_WITH_TILE_TAG]);

  const board = built.board;
  const placements = built.placements;

  const vb = useMemo(() => {
    if (!board || board.cells.size === 0) return { x: -400, y: -300, w: 800, h: 600 };

    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    for (const k of board.cells.keys()) {
      const a = parseKey(k);
      const { x, y } = axialToPixel(a, HEX_SIZE, ORIENTATION);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    const pad = HEX_SIZE * 2.2;
    return {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxX - minX + pad * 2,
    };
  }, [board]);

  function onToggleUsed(nextUsed: boolean) {
    if (!selectedItem) return;

    if (!nextUsed) {
      const ok = window.confirm("使用済みを解除します。よろしいですか？");
      if (!ok) return;
    }

    setHistoryUsed(selectedItem.id, nextUsed);
    refreshEntries();
  }

  function onExport() {
    try {
      const db: HistoryDB = loadHistoryDB();
      const json = JSON.stringify(db, null, 2);
      downloadText("gaia-history.json", json, "application/json");
    } catch (e) {
      console.error(e);
      window.alert("Exportに失敗しました。");
    }
  }

  async function onImportFile(file: File) {
    try {
      const ok = window.confirm("Importすると現在の履歴は上書きされます。よろしいですか？");
      if (!ok) return;

      const text = await file.text();
      const parsed = JSON.parse(text);

      saveHistoryDB(parsed as HistoryDB);
      refreshEntries();

      // Import後も「最新テンプレ追随」を働かせたいので、再適用可能にする
      setAutoTemplateApplied(false);

      window.alert("Importが完了しました。");
    } catch (e) {
      console.error(e);
      window.alert("Importに失敗しました。JSON形式を確認してください。");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onClickImport() {
    fileInputRef.current?.click();
  }

  return (
    <div style={{ display: "flex", gap: 12, padding: 12 }}>
      {/* Left: List */}
      <div style={{ width: 380, minWidth: 340, border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ padding: 10, borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 700 }}>履歴</div>

          <button
            onClick={onExport}
            style={{ marginLeft: "auto", padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", cursor: "pointer" }}
          >
            Export
          </button>

          <button
            onClick={onClickImport}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", cursor: "pointer" }}
          >
            Import
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
            }}
          />
        </div>

        <div style={{ padding: 10, borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} />
            未使用のみ
          </label>
        </div>

        <div style={{ padding: 10, borderBottom: "1px solid #eee", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "#555", width: 72 }}>Template</div>
          <select
            value={selectedTemplateId}
            onChange={(e) => {
              setSelectedTemplateId(e.target.value);
              setAutoTemplateApplied(true); // 手動操作を優先
            }}
            style={{ flex: 1, padding: 6, borderRadius: 6 }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name ?? t.id}
              </option>
            ))}
          </select>
        </div>

        <div style={{ maxHeight: "calc(100vh - 190px)", overflow: "auto" }}>
          {visibleItems.length === 0 && <div style={{ padding: 12, color: "#777" }}>このTemplateの履歴がありません</div>}

          {visibleItems.map((x) => {
            const e = x.entry;
            const isSelected = e.id === selectedId;

            const rankUnusedStr = x.rankUnused !== null ? `#${x.rankUnused}` : "--";
            const rankAllStr = `#${x.rankAll}`;

            return (
              <div
                key={e.id}
                onClick={() => setSelectedId(e.id)}
                style={{
                  cursor: "pointer",
                  padding: "8px 10px",
                  borderBottom: "1px solid #f2f2f2",
                  background: isSelected ? "#f5f7ff" : "transparent",
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                }}
              >
                <div style={{ width: 66, fontVariantNumeric: "tabular-nums" }}>
                  {unusedOnly ? rankUnusedStr : rankAllStr}
                </div>

                {!unusedOnly && (
                  <div style={{ width: 58, fontVariantNumeric: "tabular-nums", color: "#666" }}>{rankUnusedStr}</div>
                )}

                <div style={{ flex: 1, fontVariantNumeric: "tabular-nums" }}>{e.dispersionValue.toFixed(4)}</div>

                <div style={{ width: 62, textAlign: "right", fontSize: 12, color: e.used ? "#b00" : "#0a0" }}>
                  {e.used ? "USED" : "NEW"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Detail */}
      <div style={{ flex: 1, border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ padding: 10, borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 700 }}>詳細</div>

          <div style={{ marginLeft: 12, display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" name="renderMode" value="tiles" checked={renderMode === "tiles"} onChange={() => setRenderMode("tiles")} />
              Tile
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" name="renderMode" value="cells" checked={renderMode === "cells"} onChange={() => setRenderMode("cells")} />
              文字
            </label>
          </div>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {selectedItem && (
              <>
                <button
                  onClick={() => onToggleUsed(true)}
                  disabled={selectedItem.used}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", cursor: "pointer" }}
                >
                  使用済みにする
                </button>
                <button
                  onClick={() => onToggleUsed(false)}
                  disabled={!selectedItem.used}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", cursor: "pointer" }}
                >
                  使用済み解除
                </button>
              </>
            )}
          </div>
        </div>

        {!selectedTemplate && <div style={{ padding: 12, color: "#777" }}>テンプレートがありません。</div>}
        {selectedTemplate && !selectedItem && <div style={{ padding: 12, color: "#777" }}>履歴がありません。</div>}

        {selectedTemplate && selectedItem && (
          <div style={{ display: "flex", gap: 12, padding: 12 }}>
            <div style={{ flex: 2, minWidth: 520 }}>
              <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
                dispersion: <b>{selectedItem.dispersionValue.toFixed(4)}</b> / GAIA mode: <b>{selectedItem.gaiaNeighborMode}</b>
              </div>

              <div style={{ border: "1px solid #eee", borderRadius: 8, overflow: "auto" }}>
                {!board || board.cells.size === 0 ? (
                  <div style={{ padding: 12, color: "#777" }}>No render (build error / template mismatch)</div>
                ) : (
                  <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} width={Math.max(900, vb.w)} height={Math.max(650, vb.h)}>
                    {renderMode === "cells" &&
                      Array.from(board.cells.keys()).map((k) => {
                        const cell = board.cells.get(k)!;
                        const a = parseKey(k);
                        const { x, y } = axialToPixel(a, HEX_SIZE, ORIENTATION);
                        const fill = cell.kind === "planet" ? "#fff" : "#fafafa";
                        const stroke = "#999";
                        const label = cell.kind === "planet" ? cell.planet : "";
                        return (
                          <g key={k}>
                            <polygon points={hexPoints(x, y, HEX_SIZE, ORIENTATION)} fill={fill} stroke={stroke} strokeWidth={1} />
                            <text x={x} y={y + 4} textAnchor="middle" fontSize={10} fill="#333">
                              {label}
                            </text>
                          </g>
                        );
                      })}

                    {renderMode === "tiles" &&
                      placements.map((p, i) => {
                        const tileMapRot60 = 0;
                        const viewPos = rotate60(p.pos, (VIEW_ROT60 + tileMapRot60 + 600) % 6);
                        const { x, y } = axialToPixel(viewPos, HEX_SIZE, ORIENTATION);
                        const imgSize = HEX_SIZE * TILE_IMG_FACTOR;
                        const deg =
                          TILE_ROT_DIR * ((p.rot + TILE_ROT_OFFSET60 + VIEW_ROT60 + tileMapRot60) * 60) + TILE_ROT_OFFSET_DEG;

                        return (
                          <g
                            key={i}
                            transform={`translate(${x}, ${y}) rotate(${deg}) translate(${-imgSize / 2}, ${-imgSize / 2})`}
                          >
                            <image href={`/sectors/${p.sectorId}.png`} width={imgSize} height={imgSize} preserveAspectRatio="xMidYMid meet" />
                          </g>
                        );
                      })}
                  </svg>
                )}
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>planetScores</div>
              <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>分散計算に投入した惑星別の最終評価値</div>

              <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 10 }}>
                {Object.entries(selectedItem.planetScores).map(([pt, v]) => (
                  <div key={pt} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                    <div style={{ fontVariantNumeric: "tabular-nums" }}>{planetLabel(pt as PlanetType)}</div>
                    <div style={{ fontVariantNumeric: "tabular-nums" }}>{Number(v).toFixed(3)}</div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
