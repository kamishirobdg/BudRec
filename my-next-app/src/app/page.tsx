"use client";

import React, { useMemo, useState } from "react";
import SectorDigitizer from "../components/SectorDigitizer";

export default function Page() {
  const [sectorId, setSectorId] = useState("02");
  const imageUrl = useMemo(() => `/sectors/${sectorId}.png`, [sectorId]);

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: "0 0 12px 0" }}>Sector Digitizer (3-4-5-4-3)</h2>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <label>
          Sector ID:
          <select
            value={sectorId}
            onChange={(e) => setSectorId(e.target.value)}
            style={{ marginLeft: 8, padding: 6, borderRadius: 6, border: "1px solid #ccc" }}
          >
            {["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"].map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>

        <div style={{ color: "#666" }}>image: {imageUrl}</div>
      </div>

      <SectorDigitizer sectorId={sectorId} imageUrl={imageUrl} />
    </div>
  );
}
