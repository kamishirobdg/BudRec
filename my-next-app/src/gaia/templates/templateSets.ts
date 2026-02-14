// src/gaia/templates/templateSets.ts
import type { AxialKey } from "../eval/extractForEval";

// テンプレごとに切り出す想定（まずは最小でswitch）
export function getTemplateOuterTouchSets(templateId: string): {
  outerCells: Set<AxialKey>;
  touchCells: Set<AxialKey>;
} {
  switch (templateId) {
    case "3p_lostfleet":
    case "3p_lostFleet_lostfleet": 
    case "3p_lostFleet_lf":
    case "3p_lostFleet":{
      const OUTER: AxialKey[] = [
       "0,11",
       "0,12",
       "0,13",
       "0,14",
       "0,15",
       "1,10",
       "1,15",
       "1,8",
       "1,9",
       "10,0",
       "10,13",
       "11,0",
       "11,12",
       "12,-1",
       "12,11",
       "13,-2",
       "13,10",
       "14,-2",
       "14,10",
       "15,-1",
       "15,-2",
       "15,0",
       "15,1",
       "15,2",
       "15,3",
       "15,9",
       "16,3",
       "16,4",
       "16,8",
       "17,4",
       "17,7",
       "18,4",
       "18,5",
       "18,6",
       "2,15",
       "2,16",
       "2,7",
       "3,16",
       "3,6",
       "4,16",
       "4,5",
       "5,16",
       "5,4",
       "6,16",
       "6,4",
       "7,15",
       "7,3",
       "8,14",
       "8,2",
       "9,1",
       "9,14",
      ];
      const TOUCH: AxialKey[] = [
       "1,11",
       "1,12",
       "1,13",
       "1,14",
       "10,1",
       "10,12",
       "11,1",
       "11,11",
       "12,0",
       "12,10",
       "13,-1",
       "13,9",
       "14,-1",
       "14,0",
       "14,1",
       "14,2",
       "14,3",
       "14,4",
       "14,9",
       "15,4",
       "15,5",
       "15,8",
       "16,5",
       "16,7",
       "17,5",
       "17,6",
       "2,10",
       "2,14",
       "2,8",
       "2,9",
       "3,14",
       "3,15",
       "3,7",
       "4,15",
       "4,6",
       "5,15",
       "5,5",
       "6,15",
       "6,5",
       "7,14",
       "7,4",
       "8,13",
       "8,3",
       "9,13",
       "9,2",
      ];
      return { outerCells: new Set(OUTER), touchCells: new Set(TOUCH) };
    }
    default:
      return { outerCells: new Set(), touchCells: new Set() };
  }
}
