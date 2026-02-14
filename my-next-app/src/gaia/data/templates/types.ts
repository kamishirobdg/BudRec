export type Axial = { q: number; r: number };
export type SlotAccept = "LARGE" | "MIDDLE" | "SMALL";

export type TemplateDef = {
  templateId: string;
  label: string;
  playerCount: 3 | 4;
  expansion: "base" | "lostFleet";
  radius: number;
  slots: Array<{
    slotId: string;
    pos: Axial;
    accepts: SlotAccept[];
  }>;
};
