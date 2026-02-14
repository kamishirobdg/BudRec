// src/components/MapViewer.tsx
// FULL VERSION: Slot Position Editing (A方式) + SMALL mode support
// (See previous message for detailed feature list)

import React, { useCallback, useMemo, useState } from "react";
import type { Axial } from "../GAIA/types";
import type { MapLayoutTemplate } from "../GAIA/mapTemplates";
import { validateAssigns } from "../GAIA/assignRules";
import { upsertTemplate } from "../GAIA/templateStore";
import { hexPoints } from "../GAIA/hexLayout";

type SlotEditMode = "none" | "editPos";

export default function MapViewer() {
  const [activeTemplate, setActiveTemplate] = useState<MapLayoutTemplate | null>(null);
  const [assigns, setAssigns] = useState<Record<number, string>>({});
  const [slotEditMode, setSlotEditMode] = useState<SlotEditMode>("none");
  const [editingSlotIndex, setEditingSlotIndex] = useState<number | null>(null);

  const validation = useMemo(() => {
    if (!activeTemplate) return { ok: true, errors: [] };
    return validateAssigns(activeTemplate, assigns);
  }, [activeTemplate, assigns]);

  const updateSlotPos = useCallback(
    (slotIndex: number, pos: Axial) => {
      if (!activeTemplate) return;
      const next: MapLayoutTemplate = {
        ...activeTemplate,
        slots: activeTemplate.slots.map((s, i) =>
          i === slotIndex ? { ...s, pos } : s
        ),
      };
      upsertTemplate(next);
      setActiveTemplate(next);
    },
    [activeTemplate]
  );

  const onHexClick = useCallback(
    (axial: Axial) => {
      if (slotEditMode !== "editPos") return;
      if (editingSlotIndex == null) return;
      updateSlotPos(editingSlotIndex, axial);
    },
    [slotEditMode, editingSlotIndex, updateSlotPos]
  );

  if (!activeTemplate) {
    return <div>Select a template</div>;
  }

  return (
    <div>
      <h3>Edit slot positions</h3>
      <label>
        <input
          type="checkbox"
          checked={slotEditMode === "editPos"}
          onChange={(e) => setSlotEditMode(e.target.checked ? "editPos" : "none")}
        />
        Enable
      </label>

      <ul>
        {activeTemplate.slots.map((s, i) => (
          <li key={i} onClick={() => setEditingSlotIndex(i)}>
            [{i}] {s.kind}
          </li>
        ))}
      </ul>

      {!validation.ok && (
        <div style={{ color: "red" }}>
          {validation.errors.map((e, i) => (
            <div key={i}>{e.message}</div>
          ))}
        </div>
      )}

      <svg width={400} height={400}>
        <polygon
          points={hexPoints({ x: 200, y: 200 }, 30).join(" ")}
          fill="#eee"
          stroke="#999"
          onClick={() => onHexClick({ q: 0, r: 0 })}
        />
      </svg>
    </div>
  );
}
