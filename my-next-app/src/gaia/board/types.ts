// src/gaia/board/types.ts
import type { Axial } from "./axial";

export type Accepts = "LARGE" | "MIDDLE" | "SMALL";

// PlanetType はあなたのSSOTに沿って拡張可能
export type PlanetType =
  | "BLACK"
  | "BLUE"
  | "BROWN"
  | "ORANGE"
  | "RED"
  | "WHITE"
  | "YELLOW"
  | "GAIA"
  | "TRANSDIM"
  | "EMPTY";

export type SectorCellKind = "planet" | "empty" | "other";

export type SectorCell = {
  // セクター内ローカル座標（Axial）
  q: number;
  r: number;
  kind: SectorCellKind;
  planetType?: PlanetType;
  tags?: string[];
};

export type RawCell = {
  kind: SectorCellKind;
  planet?: string;
  planetType?: PlanetType;
  tags?: string[];
};

export type SectorDef = {
  // Tiles are identified by id like "01", "05b" etc.
  sectorId: string;
  radius?: number;
  // Key: "q,r" in axial coords
  cells: Record<string, RawCell>;
};

export type SlotPos = Axial;

export type SlotDef = {
  slotId: string;          // "L1" "M5" "S3" 等
  accepts: Accepts[];
  pos: SlotPos;            // 盤面上の中心（Axial）
};

export type TemplateDef = {
  templateId: string;      // "LF_3P" 等
  slots: SlotDef[];
};

export type SlotPlacement = {
  slotId: string;
  sectorId: string;
  rot: number;    // 0..5
  rot30: number;  // 30deg steps, + is CW
};

// 正規化後の盤面セル
export type NormalizedCell = {
  q: number;
  r: number;
  coordKey: string;

  slotId: string;
  accepts: Accepts[];
  sectorId: string;

  /** Template-local offset from slot center: \"dq,dr\" */
  tplLocalKey: string;

  /** (legacy) sector-local key: \"dq,dr\" in tile coords */
  localKey?: string;

  kind: SectorCellKind;
  planetType?: PlanetType;
  tags: string[];

  neighbors: string[]; // neighbor coordKeys
};

export type NormalizedBoard = {
  templateId: string;
  cells: NormalizedCell[];
  cellByCoord: Map<string, NormalizedCell>;
  cellsBySlotId: Map<string, NormalizedCell[]>;
  cellsByPlanetType: Map<string, NormalizedCell[]>;
};
