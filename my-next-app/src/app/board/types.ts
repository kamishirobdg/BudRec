import type { Axial } from "./axial";

export type Accepts = "LARGE" | "MIDDLE" | "SMALL";

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
  | string;

export type SectorCellKind = "planet" | "space" | "special" | string;

export type SectorCell = {
  q: number;
  r: number;
  kind: SectorCellKind;
  planetType?: PlanetType;
  tags?: string[];
};

export type SectorDef = {
  sectorId: string;
  radius?: number; // ★Base(LARGE)補正用
  cells: SectorCell[];
};

export type SlotPos = Axial;

export type SlotDef = {
  slotId: string;
  accepts: Accepts | Accepts[]; // ★配列も許容
  pos: Axial;
};

export type TemplateDef = {
  templateId: string;
  slots: SlotDef[];
};

export type SlotPlacement = {
  slotId: string;
  sectorId: string;
  rot: number; // 0..5
  rot30: number; // 表示寄り（評価座標には反映しない方針）
};

export type NormalizedCell = {
  q: number;
  r: number;
  coordKey: string;

  slotId: string;
  accepts: Accepts;
  sectorId: string;

  /** Template-local offset from slot center: \"dq,dr\" */
  tplLocalKey: string;

  /** (legacy) sector-local key. kept for compatibility */
  localKey?: string;

  kind: SectorCellKind;
  planetType?: PlanetType;
  tags: string[];

  neighbors: string[];
};

export type NormalizedBoard = {
  templateId: string;
  cells: NormalizedCell[];
  cellByCoord: Map<string, NormalizedCell>;
  cellsBySlotId: Map<string, NormalizedCell[]>;
  cellsByPlanetType: Map<string, NormalizedCell[]>;
};
