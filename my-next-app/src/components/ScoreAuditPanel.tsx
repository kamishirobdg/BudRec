// src/components/ScoreAuditPanel.tsx
import React, { useMemo } from "react";
import type { BoardEvaluation } from "@/gaia/board/evaluate";

type Props = {
  evalResult: BoardEvaluation | null;
};

function fmt(n: number | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

export default function ScoreAuditPanel({ evalResult }: Props) {
  const rows = useMemo(() => {
    if (!evalResult) return [];

    const dist = new Map(evalResult.distanceByPlanetType.map((x) => [x.planetType, x]));
    const adj = new Map(evalResult.adjacencyByPlanetType.map((x) => [x.planetType, x]));
    const disp = new Map(evalResult.dispersionByPlanetType.map((x) => [x.planetType, x]));

    const types = Array.from(
      new Set([
        ...evalResult.distanceByPlanetType.map((x) => x.planetType),
        ...evalResult.adjacencyByPlanetType.map((x) => x.planetType),
        ...evalResult.dispersionByPlanetType.map((x) => x.planetType),
      ])
    ).sort();

    return types.map((pt) => ({
      pt,
      count: dist.get(pt)?.count ?? disp.get(pt)?.count ?? 0,
      minDist: dist.get(pt)?.minDist ?? null,
      avgDist: dist.get(pt)?.avgDist ?? null,
      within2: dist.get(pt)?.withinThresholdPairs ?? 0,
      edgesSame: adj.get(pt)?.edgesSameType ?? 0,
      edgesDiff: adj.get(pt)?.edgesDifferentType ?? 0,
      avgToCent: disp.get(pt)?.avgDistToCentroid ?? null,
      varToCent: disp.get(pt)?.varDistToCentroid ?? null,
    }));
  }, [evalResult]);

  if (!evalResult) {
    return (
      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
        <div style={{ fontWeight: 600 }}>Score Audit</div>
        <div style={{ opacity: 0.8, marginTop: 6 }}>評価結果がありません。</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <div style={{ fontWeight: 700 }}>Score Audit</div>
        <div style={{ opacity: 0.8, fontSize: 12 }}>
          template: {evalResult.templateId} / planets: {evalResult.summary.planetCellCount} / edges:{" "}
          {evalResult.summary.edgesPlanetPlanet} (same {evalResult.summary.edgesSameType}, diff{" "}
          {evalResult.summary.edgesDifferentType})
        </div>
      </div>

      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
          <thead>
            <tr>
              {[
                "PlanetType",
                "Count",
                "MinDist",
                "AvgDist",
                `Pairs<=${evalResult.options.nearThreshold}`,
                "EdgesSame",
                "EdgesDiff",
                "AvgDistToCent",
                "VarDistToCent",
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    borderBottom: "1px solid #ddd",
                    padding: "8px 10px",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pt}>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", fontWeight: 600 }}>
                  {r.pt}
                </td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{r.count}</td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{fmt(r.minDist, 0)}</td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{fmt(r.avgDist, 2)}</td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{r.within2}</td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{r.edgesSame}</td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{r.edgesDiff}</td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{fmt(r.avgToCent, 2)}</td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>{fmt(r.varToCent, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
        注: rot30 は評価座標には適用していません（30°はAxial格子の厳密回転にならないため）。必要になった時点で方針を分離して設計します。
      </div>
    </div>
  );
}
