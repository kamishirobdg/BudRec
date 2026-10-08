/**
 * 食品のパッケージの栄養成分表示を写真から読む（食事の編集・在庫から使う）。
 * 読んだ値は表示の単位（1 袋あたり・1 本あたり・100g あたりなど）のまま返し、食べた量は画面で掛ける。
 */

import { NUTRIENTS, Nutrients, sanitizeNutrients } from './Nutrients';
import { callGemini } from '../providers/GeminiProvider';
import { parseJson } from '../providers/AIProvider';

export interface NutritionLabel {
  /** 商品名（読めなければ空） */
  name:      string;
  /** 表示の単位の説明（「1 袋（45g）あたり」「100g あたり」など） */
  unitLabel: string;
  /** 食品データに入れるときの単位 */
  basis:     'piece' | 'package' | 'per100g';
  /** 内容量（「45g」「6 本」など。読めなければ空） */
  content:   string;
  /** 表示の単位あたりの栄養 */
  nutrients: Nutrients;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    name:      { type: 'STRING' },
    unitLabel: { type: 'STRING' },
    basis:     { type: 'STRING', enum: ['piece', 'package', 'per100g'] },
    content:   { type: 'STRING' },
    nutrients: {
      type: 'OBJECT',
      properties: Object.fromEntries(NUTRIENTS.map((n) => [n.key, { type: 'NUMBER' }])),
    },
  },
  required: ['unitLabel', 'basis', 'nutrients'],
};

/** 栄養成分表示の写真を読む。表示が見つからなければ例外を投げる */
export async function readNutritionLabel(imageBase64: string, signal?: AbortSignal): Promise<NutritionLabel> {
  const list = NUTRIENTS.map((n) => `${n.key}（${n.label}・${n.unit}）`).join(', ');
  const prompt = `食品のパッケージの写真です。栄養成分表示を読み、JSON のみを返してください。
- name: 商品名（写っていれば。日本語で）
- unitLabel: 表示の単位をそのまま（「1 袋（45g）あたり」「1 本あたり」「100g あたり」など）
- basis: 表示の単位が「1 袋・1 個・1 食・1 パック」なら package、「複数入りの 1 本・1 個」なら piece、「100g・100ml あたり」なら per100g
- content: 内容量（「45g」「6 本」など。書いていなければ空）
- nutrients: 表示の単位あたりの値。キーは次のとおりで、表示に無いものは省く:
${list}
「熱量」「エネルギー」は ENERC_KCAL、「食塩相当量」は NACL_EQ、「炭水化物」は CHOCDF-、「糖質」は CHOAVLDF-。
ナトリウムしか書いていなければ NA に入れ、NACL_EQ はナトリウム（mg）× 2.54 ÷ 1000 で求める。栄養成分表示が写っていなければ nutrients は空にする。`;
  const raw = await callGemini(
    [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }],
    { schema: SCHEMA, highRes: true, signal },
  );
  const parsed = parseJson(raw) ?? {};
  const nutrients = sanitizeNutrients(parsed.nutrients);
  if (!Object.values(nutrients).some((v) => v !== null)) throw new Error('栄養成分表示を読めませんでした');
  const basis = parsed.basis === 'per100g' ? 'per100g' : parsed.basis === 'piece' ? 'piece' : 'package';
  return {
    name: String(parsed.name ?? '').trim(),
    unitLabel: String(parsed.unitLabel ?? '').trim() || (basis === 'per100g' ? '100g あたり' : '1 個あたり'),
    basis,
    content: String(parsed.content ?? '').trim(),
    nutrients,
  };
}
