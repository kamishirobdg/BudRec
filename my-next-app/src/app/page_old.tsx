import { checkConnectivity } from "../gaia/boardConnectivity";

// ...（既存のまま）

  if (!result.ok) { /* 既存 */ }

  const placements = result.board.toPlacements();

  // 仕様A：スロット隣接での分断チェック
  const connA = checkConnectivity(result.board, SAMPLE_SLOTS, { kind: "SLOT_ADJACENT" });

  // 仕様B：例えばLANEだけを「接続」とみなす場合（将来用）
  // const connB = checkConnectivity(result.board, SAMPLE_SLOTS, { kind: "EDGE_MATCH", allowedEdges: new Set(["LANE"]) });

  return (
    <div style={{ padding: 16 }}>
      {/* 既存 */}

      <div style={{ marginBottom: 12 }}>
        <b>Connectivity(A)</b>: {connA.isConnected ? "Connected" : "Disconnected"}
        {!connA.isConnected && (
          <div style={{ color: "crimson" }}>
            unreachable: {connA.unreachableKeys.join(" / ")}
          </div>
        )}
      </div>

      <GaiaBoardSvg /* 既存 */ />
    </div>
  );
