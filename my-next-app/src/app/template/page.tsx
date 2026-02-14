import { MapTemplateViewer } from "@/components/MapTemplateViewer";
import { TEMPLATE_4P_LOSTFLEET } from "@/gaia/data/templates/4p_lostFleet";

import { BASE_SECTORS } from "@/gaia/sectorTiles_base";
import { EXPANSION_MIDDLE, EXPANSION_LITTLE, EXPANSION_SCOUT } from "@/gaia/sectorTiles_lostfleet";

import {
  buildSectorLookup,
  expandPlacementToBoardCells,
  makeCycledPlacement,
} from "@/gaia/board/previewBoard";

function getSectorIdList(sectors: any[]): string[] {
  const ids: string[] = [];
  for (const s of sectors) {
    const id = (s?.sectorId ?? s?.id) as string | undefined;
    if (id) ids.push(id);
  }
  return ids;
}

export default function Page() {
  // 1) Sector lookup（base + lostfleet）
  const allSectors = [
    ...(BASE_SECTORS as any[]),
    ...(EXPANSION_MIDDLE as any[]),
    ...(EXPANSION_LITTLE as any[]),
    ...(EXPANSION_SCOUT as any[]),
  ];
  const sectorById = buildSectorLookup(allSectors);

  // 2) 循環割当プール
  const largeIds = getSectorIdList(BASE_SECTORS as any[]);
  const middleIds = getSectorIdList(EXPANSION_MIDDLE as any[]);
  const smallIds = [
    ...getSectorIdList(EXPANSION_LITTLE as any[]),
    ...getSectorIdList(EXPANSION_SCOUT as any[]),
  ];

  // 3) Placement生成（rot=0固定で生成 → Middleの一部だけ rot=3 で上書き）
  const basePlacement = makeCycledPlacement({
    slots: TEMPLATE_4P_LOSTFLEET.slots as any,
    largeIds,
    middleIds,
    smallIds,
  });

  // ★ここが本題：180度回転したい Middle の slotId を列挙（rot=3）
  const middleRot180 = new Set<string>(["M5", "M6", "M7", "M8"]);

  const placement = basePlacement.map((p) => {
    if (middleRot180.has(p.slotId)) return { ...p, rot: 3 };
    return p;
  });

  // 4) Board展開（プレビュー）
  const boardCells = expandPlacementToBoardCells({
    slots: TEMPLATE_4P_LOSTFLEET.slots as any,
    placement,
    sectorById,
  });

  // 5) 表示（向きは確定値）
  return (
    <MapTemplateViewer
      template={TEMPLATE_4P_LOSTFLEET}
      hexSize={40}
      boardCells={boardCells}
      placement={placement}
      defaultShowCells={true}
      viewRot={4}
      viewAngleDeg={-30}
    />
  );
}
