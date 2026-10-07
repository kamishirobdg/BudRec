/**
 * 栄養素の定義。キーは日本食品標準成分表の成分識別子（INFOODS タグ）に揃える。
 *
 * - **取れた栄養素はすべて保存する。** どれを画面に出すかは保存と切り離す。
 * - 値が分からない項目は `null`。**0 とは区別する**（合計で null を 0 として足さない）。
 */

export interface NutrientDef {
  key:   string;
  label: string;
  unit:  string;
}

export const NUTRIENTS: readonly NutrientDef[] = [
  { key: 'ENERC_KCAL', label: 'エネルギー',     unit: 'kcal' },
  { key: 'PROT-',      label: 'たんぱく質',     unit: 'g' },
  { key: 'FAT-',       label: '脂質',           unit: 'g' },
  { key: 'CHOCDF-',    label: '炭水化物',       unit: 'g' },
  { key: 'CHOAVLDF-',  label: '糖質',           unit: 'g' },
  { key: 'FIB-',       label: '食物繊維',       unit: 'g' },
  { key: 'NACL_EQ',    label: '食塩相当量',     unit: 'g' },
  { key: 'FASAT',      label: '飽和脂肪酸',     unit: 'g' },
  { key: 'FAMS',       label: '一価不飽和脂肪酸', unit: 'g' },
  { key: 'FAPU',       label: '多価不飽和脂肪酸', unit: 'g' },
  { key: 'CHOLE',      label: 'コレステロール', unit: 'mg' },
  { key: 'NA',         label: 'ナトリウム',     unit: 'mg' },
  { key: 'K',          label: 'カリウム',       unit: 'mg' },
  { key: 'CA',         label: 'カルシウム',     unit: 'mg' },
  { key: 'MG',         label: 'マグネシウム',   unit: 'mg' },
  { key: 'P',          label: 'リン',           unit: 'mg' },
  { key: 'FE',         label: '鉄',             unit: 'mg' },
  { key: 'ZN',         label: '亜鉛',           unit: 'mg' },
  { key: 'CU',         label: '銅',             unit: 'mg' },
  { key: 'MN',         label: 'マンガン',       unit: 'mg' },
  { key: 'ID',         label: 'ヨウ素',         unit: 'µg' },
  { key: 'SE',         label: 'セレン',         unit: 'µg' },
  { key: 'CR',         label: 'クロム',         unit: 'µg' },
  { key: 'MO',         label: 'モリブデン',     unit: 'µg' },
  { key: 'VITA_RAE',   label: 'ビタミンA',      unit: 'µg' },
  { key: 'VITD',       label: 'ビタミンD',      unit: 'µg' },
  { key: 'TOCPHA',     label: 'ビタミンE',      unit: 'mg' },
  { key: 'VITK',       label: 'ビタミンK',      unit: 'µg' },
  { key: 'THIA',       label: 'ビタミンB1',     unit: 'mg' },
  { key: 'RIBF',       label: 'ビタミンB2',     unit: 'mg' },
  { key: 'NIA',        label: 'ナイアシン',     unit: 'mg' },
  { key: 'VITB6A',     label: 'ビタミンB6',     unit: 'mg' },
  { key: 'VITB12',     label: 'ビタミンB12',    unit: 'µg' },
  { key: 'FOL',        label: '葉酸',           unit: 'µg' },
  { key: 'PANTAC',     label: 'パントテン酸',   unit: 'mg' },
  { key: 'BIOT',       label: 'ビオチン',       unit: 'µg' },
  { key: 'VITC',       label: 'ビタミンC',      unit: 'mg' },
];

export const NUTRIENT_KEYS: readonly string[] = NUTRIENTS.map((n) => n.key);

/** 何も設定していないときに画面に出す項目 */
export const DEFAULT_VISIBLE: readonly string[] = ['ENERC_KCAL', 'PROT-', 'FAT-', 'CHOCDF-', 'NACL_EQ'];

export type Nutrients = Record<string, number | null>;

/** モデルの返答などから、既知のキーだけを数値か null に揃える */
export function sanitizeNutrients(raw: unknown): Nutrients {
  const out: Nutrients = {};
  const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  for (const key of NUTRIENT_KEYS) {
    const v = src[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    out[key] = Number.isFinite(n) && n >= 0 ? n : null;
  }
  return out;
}

/** 割合を掛ける（null は null のまま） */
export function scaleNutrients(n: Nutrients, ratio: number): Nutrients {
  const out: Nutrients = {};
  for (const [k, v] of Object.entries(n)) out[k] = v === null ? null : round(v * ratio);
  return out;
}

export interface NutrientTotal {
  value:   number;
  /** 合計に含めた食事のうち、この項目が不明だったものがある */
  partial: boolean;
}

/** 合計する。null は足さずに「一部不明」の印にする */
export function sumNutrients(list: Nutrients[]): Record<string, NutrientTotal> {
  const out: Record<string, NutrientTotal> = {};
  for (const key of NUTRIENT_KEYS) {
    let value = 0;
    let partial = false;
    let any = false;
    for (const n of list) {
      const v = n[key];
      if (v === null || v === undefined) partial = true;
      else { value += v; any = true; }
    }
    if (any || list.length > 0) out[key] = { value: round(value), partial: partial || !any };
  }
  return out;
}

export function nutrientDef(key: string): NutrientDef | undefined {
  return NUTRIENTS.find((n) => n.key === key);
}

/** 保存し直すたびに「行の値 ÷ 割合」で 1 品全体に戻すので、丸めすぎると小さい値がずれていく */
function round(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
