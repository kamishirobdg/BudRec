// src/GAIA/sectorTiles_base.ts
import type { SectorTileDef } from "./sectorTypes";

export const BASE_SECTORS: readonly SectorTileDef[] = [
  {
    id: "01",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "planet", planet: "YELLOW", tags: ["planet:YELLOW"] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "planet", planet: "BROWN", tags: ["planet:BROWN"] },
      "-1,1": { kind: "empty", tags: [] },
      "-1,2": { kind: "empty", tags: [] },

      "0,-2": { kind: "empty", tags: [] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "planet", planet: "RED", tags: ["planet:RED"] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1":{ kind: "planet", planet: "BLUE", tags: ["planet:BLUE"] },
      "1,0": { kind: "empty", tags: [] },
      "1,1": { kind: "planet", planet: "ORANGE", tags: ["planet:ORANGE"] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1":{ kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] }, 
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "02",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "planet", planet: "ORANGE", tags: ["planet:ORANGE"] },
      "-1,0": { kind: "empty", tags: [] },
      "-1,1": { kind: "planet", planet: "BROWN", tags: ["planet:BROWN"] },
      "-1,2": { kind: "planet", planet: "RED", tags: ["planet:RED"] },

      "0,-2": { kind: "planet", planet: "BLACK", tags: ["planet:BLACK"] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1": { kind: "planet", planet: "WHITE", tags: ["planet:WHITE"] },
      "1,0": { kind: "empty", tags: [] },
      "1,1": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1": { kind: "planet", planet: "YELLOW", tags: ["planet:YELLOW"] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "03",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] }, 
      "-1,1": { kind: "empty", tags: [] },
      "-1,2": { kind: "planet", planet: "BLUE", tags: ["planet:BLUE"] }, 

      "0,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] }, 
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "planet", planet: "YELLOW", tags: ["planet:YELLOW"] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "planet", planet: "WHITE", tags: ["planet:WHITE"] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1":{ kind: "planet", planet: "BLACK", tags: ["planet:BLACK"] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "04",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "planet", planet: "WHITE", tags: ["planet:WHITE"] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "empty", tags: [] },
      "-1,1": { kind: "planet", planet: "ORANGE", tags: ["planet:ORANGE"] },
      "-1,2": { kind: "empty", tags: [] },

      "0,-2": { kind: "planet", planet: "BLACK", tags: ["planet:BLACK"] },
      "0,-1": { kind: "planet", planet: "RED", tags: ["planet:RED"] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "planet", planet: "BROWN", tags: ["planet:BROWN"] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "planet", planet: "BLUE", tags: ["planet:BLUE"] },
    },
  },
  {
    id: "05",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] }, 
      "-1,1": { kind: "empty", tags: [] },
      "-1,2": { kind: "planet", planet: "ORANGE", tags: ["planet:ORANGE"] },

      "0,-2": { kind: "planet", planet: "WHITE", tags: ["planet:WHITE"] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "planet", planet: "YELLOW", tags: ["planet:YELLOW"] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "empty", tags: [] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "2,-1": { kind: "planet", planet: "RED", tags: ["planet:RED"] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "06",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "planet", planet: "BROWN", tags: ["planet:BROWN"] },
      "-1,1": { kind: "empty", tags: [] },
      "-1,2": { kind: "empty", tags: [] },

      "0,-2": { kind: "empty", tags: [] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] }, 
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "1,-1": { kind: "planet", planet: "BLUE", tags: ["planet:BLUE"] },
      "1,0": { kind: "empty", tags: [] },
      "1,1": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "planet", planet: "YELLOW", tags: ["planet:YELLOW"] },
    },
  },
  {
    id: "07",
    radius: 2,
    cells: {
      "-2,0": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "empty", tags: [] },
      "-1,1": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] }, 
      "-1,2": { kind: "empty", tags: [] },

      "0,-2": { kind: "empty", tags: [] },
      "0,-1": { kind: "planet", planet: "RED", tags: ["planet:RED"] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "planet", planet: "BLACK", tags: ["planet:BLACK"] },

      "1,-2": { kind: "planet", planet: "BROWN", tags: ["planet:BROWN"] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "05b",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] }, 
      "-1,1": { kind: "empty", tags: [] },
      "-1,2": { kind: "planet", planet: "ORANGE", tags: ["planet:ORANGE"] },

      "0,-2": { kind: "planet", planet: "WHITE", tags: ["planet:WHITE"] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "empty", tags: [] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "2,-1": { kind: "planet", planet: "RED", tags: ["planet:RED"] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "06b",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "empty", tags: [] },
      "-1,1": { kind: "empty", tags: [] },
      "-1,2": { kind: "empty", tags: [] },

      "0,-2": { kind: "empty", tags: [] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] }, 
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "1,-1": { kind: "planet", planet: "BLUE", tags: ["planet:BLUE"] },
      "1,0": { kind: "empty", tags: [] },
      "1,1": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "planet", planet: "YELLOW", tags: ["planet:YELLOW"] },
    },
  },
  {
    id: "07b",
    radius: 2,
    cells: {
      "-2,0": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "empty", tags: [] },
      "-1,1": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] }, 
      "-1,2": { kind: "empty", tags: [] },

      "0,-2": { kind: "empty", tags: [] },
      "0,-1": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "planet", planet: "BLACK", tags: ["planet:BLACK"] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "planet", planet: "BROWN", tags: ["planet:BROWN"] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "empty", tags: [] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "08",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "empty", tags: [] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "empty", tags: [] },
      "-1,1": { kind: "planet", planet: "ORANGE", tags: ["planet:ORANGE"] },
      "-1,2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },

      "0,-2": { kind: "planet", planet: "BLUE", tags: ["planet:BLUE"] },
      "0,-1": { kind: "planet", planet: "WHITE", tags: ["planet:WHITE"] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "empty", tags: [] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "planet", planet: "BLACK", tags: ["planet:BLACK"] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "09",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "planet", planet: "BROWN", tags: ["planet:BROWN"] },

      "-1,-1": { kind: "planet", planet: "ORANGE", tags: ["planet:ORANGE"] },
      "-1,0": { kind: "empty", tags: [] },
      "-1,1": { kind: "planet", planet: "BLACK", tags: ["planet:BLACK"] },
      "-1,2": { kind: "empty", tags: [] },

      "0,-2": { kind: "empty", tags: [] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "planet", planet: "WHITE", tags: ["planet:WHITE"] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
  {
    id: "10",
    radius: 2,
    cells: {
      "-2,0": { kind: "empty", tags: [] },
      "-2,1": { kind: "empty", tags: [] },
      "-2,2": { kind: "planet", planet: "BLUE", tags: ["planet:BLUE"] },

      "-1,-1": { kind: "empty", tags: [] },
      "-1,0": { kind: "planet", planet: "YELLOW", tags: ["planet:YELLOW"] },
      "-1,1": { kind: "empty", tags: [] }, 
      "-1,2": { kind: "planet", planet: "RED", tags: ["planet:RED"] },

      "0,-2": { kind: "empty", tags: [] },
      "0,-1": { kind: "empty", tags: [] },
      "0,0": { kind: "empty", tags: [] },
      "0,1": { kind: "empty", tags: [] },
      "0,2": { kind: "empty", tags: [] },

      "1,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "1,-1": { kind: "empty", tags: [] },
      "1,0": { kind: "planet", planet: "GAIA", tags: ["planet:GAIA"] },
      "1,1": { kind: "empty", tags: [] },

      "2,-2": { kind: "planet", planet: "TRANSDIM", tags: ["planet:TRANSDIM"] },
      "2,-1": { kind: "empty", tags: [] },
      "2,0": { kind: "empty", tags: [] },
    },
  },
];
