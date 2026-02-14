// src/GAIA/ScoreCellPicker.tsx
"use client";

import React, { useMemo, useState } from "react";
import type { ScoreKey, ScoreMap } from "@/GAIA/scoreTypes";
import { normalizeScoreMap, stableStringifyScoreMap } from "@/GAIA/scoreTypes";

type Props = {
  templateId: string;

  // テンプレ上に存在する「絶対セル」一覧（採点対象の全集合）
  boardCellKeys: ScoreKey[];

  // 現在のスコア（テンプレ単位）
  scoreMap: ScoreMap;
  onChangeScoreMap: (next: ScoreMap) => void;

  // MapViewer側のクリックと連携するため
  selectedKeys: Set<ScoreKey>;
  onChangeSelectedKeys: (next: Set<ScoreKey>) => void;
};

export default function ScoreCellPicker(props: Props) {
  const { templateId, boardCellKeys, scoreMap, onChangeScoreMap, selectedKeys, onChangeSelectedKeys } = props;

  const [bulkValueText, setBulkValueText] = useState<string>("+1");
  const [exportText, setExportText] = useState<string>("");

  const selectedList = useMemo(() => {
    return Array.from(selectedKeys).sort((a, b) => {
      const [aq, ar] = a.split(",").map(Number);
      const [bq, br] = b.split(",").map(Number);
      if (aq !== bq) return aq - bq;
      return ar - br;
    });
  }, [selectedKeys]);

  function clearSelection() {
    onChangeSelectedKeys(new Set());
  }

  function selectAll() {
    onChangeSelectedKeys(new Set(boardCellKeys));
  }

  function toggleKey(k: ScoreKey) {
    const next = new Set(selectedKeys);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChangeSelectedKeys(next);
  }

  // MapViewerからも使えるようにするなら外に出すが、ここではUI操作として保持
  function applyBulk() {
    const v = Number(bulkValueText);
    if (!Number.isFinite(v)) return;

    const next: ScoreMap = { ...scoreMap };
    for (const k of selectedKeys) next[k] = v;

    onChangeScoreMap(normalizeScoreMap(next));
  }

  function clearScoresOfSelected() {
    const next: ScoreMap = { ...scoreMap };
    for (const k of selectedKeys) delete next[k];
    onChangeScoreMap(normalizeScoreMap(next));
  }

  function exportJson() {
    const text = stableStringifyScoreMap(scoreMap);
    // 「テンプレ単位で貼れる形」も同時に作る
    const wrapped = [
      `// templateId: ${templateId}`,
      `export const SCORE_MAP_${templateId.replace(/[^a-zA-Z0-9_]/g, "_")} = ${text} as const;`,
      "",
      "// or inline (Record<\"q,r\", number>):",
      text,
    ].join("\n");

    setExportText(wrapped);
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 700 }}>採点モード（template: {templateId}）</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          一括スコア
          <input
            value={bulkValueText}
            onChange={(e) => setBulkValueText(e.target.value)}
            style={{ width: 80 }}
            inputMode="numeric"
          />
        </label>

        <button onClick={applyBulk}>選択中に適用</button>
        <button onClick={clearScoresOfSelected}>選択中のスコア削除</button>

        <span style={{ marginLeft: 8, opacity: 0.8 }}>
          選択: {selectedKeys.size} / {boardCellKeys.length}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={selectAll}>全選択</button>
        <button onClick={clearSelection}>選択解除</button>
        <button onClick={exportJson}>スコアJSON出力</button>
      </div>

      <details>
        <summary>選択中セル（q,r）</summary>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 8 }}>
          {selectedList.map((k) => (
            <button
              key={k}
              onClick={() => toggleKey(k as ScoreKey)}
              title="クリックで選択解除"
              style={{ fontFamily: "monospace" }}
            >
              {k}
            </button>
          ))}
          {selectedList.length === 0 && <div style={{ opacity: 0.7 }}>未選択</div>}
        </div>
      </details>

      <details open={exportText.length > 0}>
        <summary>出力（コピーペースト）</summary>
        <textarea
          value={exportText}
          readOnly
          style={{ width: "100%", minHeight: 220, fontFamily: "monospace" }}
        />
      </details>

      <div style={{ opacity: 0.8, fontSize: 12 }}>
        注: 盤面上のセルクリックは MapViewer 側で hover/クリックを検知し、selectedKeys を更新してください。
      </div>
    </div>
  );
}
