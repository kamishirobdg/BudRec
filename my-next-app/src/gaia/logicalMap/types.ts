// src/gaia/logicalMap/types.ts

import type { Axial } from "./geom";

export type LogicalCellKind = "planet" | "space" | "special" | "scout";

export type LogicalCell = {
  pos: Axial;            // board axial
  kind: LogicalCellKind;
  planetType?: string;   // e.g. "BLACK"
  tags: string[];

  // provenance (debug/trace)
  slotId: string;
  sectorId: string;
  rot: number;
  localKey: string;      // as defined in sectorTiles_*
  tplLocalKey: string;   // `${slotId}:${localKey}` (raw) OR `${slotId}:${dq,dr}` after normalization
};

export type LogicalMap = {
  templateId: string;
  seed: string | number;
  cells: Map<string, LogicalCell>; // key = "q,r"
};
