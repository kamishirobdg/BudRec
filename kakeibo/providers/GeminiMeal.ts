/**
 * 食事の推定に使う Gemini 呼び出し。仕様は docs/meal-nutrition-spec.md §5・§6。
 *
 * 1. `identifyDishes`   … 写真から料理を列挙する（構造化出力）
 * 2. `matchReceiptItems` … 料理とレシートの品目を対応付ける（構造化出力・テキストのみ）
 * 3. `lookupNutrition`   … 栄養を求める。チェーン店のメニュー・商品は **Google 検索 grounding** で
 *                          公式の栄養表示を引く。grounding と構造化出力は併用できないモデルがあるので、
 *                          grounding の呼び出しでは JSON を本文で返させて読む
 */

import { parseJson } from './AIProvider';
import { callGemini, callGeminiDetailed } from './GeminiProvider';
import { NUTRIENTS, Nutrients, sanitizeNutrients } from '../services/Nutrients';

export type DishKind = 'eat_out' | 'packaged' | 'home';
export type Eater    = 'photographer' | 'partner' | 'both' | 'unknown';

export interface IdentifiedDish {
  name:       string;
  kind:       DishKind;
  /** 一人前か、取り分ける料理（焼肉・寿司・鍋・大皿）か */
  shared:     boolean;
  /** 写っている一人前の数（同じ料理が 2 つなら 2） */
  count:      number;
  eater:      Eater;
  confidence: 'high' | 'medium' | 'low';
}

export interface DishContext {
  photographer: string;
  partner:      string | null;
  /** 似た状況の手修正（「焼肉では夫:妻 = 6:4 に直されることが多い」など）の要約 */
  corrections:  string[];
}

const DISH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    dishes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name:       { type: 'STRING' },
          kind:       { type: 'STRING', enum: ['eat_out', 'packaged', 'home'] },
          shared:     { type: 'BOOLEAN' },
          count:      { type: 'NUMBER' },
          eater:      { type: 'STRING', enum: ['photographer', 'partner', 'both', 'unknown'] },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        },
        required: ['name', 'kind', 'shared', 'count', 'eater', 'confidence'],
        propertyOrdering: ['name', 'kind', 'shared', 'count', 'eater', 'confidence'],
      },
    },
  },
  required: ['dishes'],
};

/** 写真から料理を列挙する */
export async function identifyDishes(
  imageBase64: string,
  ctx: DishContext,
  signal?: AbortSignal,
): Promise<IdentifiedDish[]> {
  const people = ctx.partner
    ? `この写真を撮ったのは「${ctx.photographer}」。一緒に食べる可能性があるのは「${ctx.partner}」。`
    : `この写真を撮ったのは「${ctx.photographer}」。`;
  const corrections = ctx.corrections.length > 0
    ? `\n過去の手修正の傾向（分け方の参考にする）:\n${ctx.corrections.map((c) => `- ${c}`).join('\n')}\n`
    : '';
  const prompt = `あなたは食事記録のアシスタントです。写真に写っている料理を列挙し、JSON のみを返してください。
${people}
${corrections}
各料理について:
- name: 料理名。チェーン店のメニューと分かる場合は公式のメニュー名に近い名前（例: 牛丼 並盛）
- kind: eat_out（飲食店の料理）/ packaged（コンビニ等の弁当・パン・菓子・飲料などの商品）/ home（家で作った料理）
- shared: 焼肉・寿司の盛り合わせ・鍋・大皿料理など、一品で完結せず取り分けて食べるものは true。一人前の料理は false
- count: 同じ一人前の料理がいくつ写っているか（取り分ける料理は 1）
- eater: 誰が食べるか。photographer（撮った人）/ partner（相手）/ both（二人で分ける）/ unknown（判断できない）
  - 一人前の料理が 1 つだけなら photographer
  - 取り分ける料理は both
  - 一人前の料理が人数分あって、どちらの分か写真から判断できなければ unknown
- confidence: 料理の判別の確からしさ。何の料理か分からなければ low

食べ物以外（食器・調味料の容器・メニュー表）は含めない。`;
  const raw = await callGemini(
    [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }],
    { schema: DISH_SCHEMA, highRes: false, signal },
  );
  const parsed = parseJson(raw);
  const list: any[] = Array.isArray(parsed?.dishes) ? parsed.dishes : [];
  return list
    .map((d): IdentifiedDish => ({
      name:       String(d?.name ?? '').trim(),
      kind:       ['eat_out', 'packaged', 'home'].includes(d?.kind) ? d.kind : 'eat_out',
      shared:     d?.shared === true,
      count:      Math.max(1, Math.round(Number(d?.count) || 1)),
      eater:      ['photographer', 'partner', 'both', 'unknown'].includes(d?.eater) ? d.eater : 'unknown',
      confidence: ['high', 'medium', 'low'].includes(d?.confidence) ? d.confidence : 'low',
    }))
    .filter((d) => d.name.length > 0);
}

export interface ReceiptLine {
  index: number;
  name:  string;
  price: number;
}

/** 料理とレシートの品目を対応付ける。戻り値は料理の index → 品目の index（対応なしは null） */
export async function matchReceiptItems(
  store: string,
  dishes: string[],
  lines: ReceiptLine[],
  signal?: AbortSignal,
): Promise<(number | null)[]> {
  if (dishes.length === 0 || lines.length === 0) return dishes.map(() => null);
  const prompt = `店「${store}」で撮った料理の写真から読み取った料理名と、その店のレシートの品目があります。
各料理がどの品目にあたるかを対応付け、JSON のみを返してください。
- matches: 料理と同じ順に、対応する品目の index（対応する品目が無ければ -1）
- レシートの略称・半角カナも読み替えて判断する。セットメニューは主な料理に対応付ける

料理:
${dishes.map((d, i) => `${i}: ${d}`).join('\n')}

レシートの品目:
${lines.map((l) => `${l.index}: ${l.name}（${l.price}円）`).join('\n')}`;
  const raw = await callGemini([{ text: prompt }], {
    schema: {
      type: 'OBJECT',
      properties: { matches: { type: 'ARRAY', items: { type: 'NUMBER' } } },
      required: ['matches'],
    },
    highRes: false,
    signal,
  });
  const matches: unknown[] = parseJson(raw)?.matches ?? [];
  const valid = new Set(lines.map((l) => l.index));
  return dishes.map((_, i) => {
    const m = Number(matches[i]);
    return Number.isInteger(m) && valid.has(m) ? m : null;
  });
}

export interface NutritionQuery {
  /** 店名（自炊なら空） */
  store: string;
  name:  string;
  kind:  DishKind;
}

export interface NutritionResult {
  /** 一人前（商品は 1 個）あたり */
  nutrients: Nutrients;
  /** 公式の栄養表示が見つかった */
  official:  boolean;
}

const NUTRIENT_LIST = NUTRIENTS.map((n) => `${n.key}（${n.label}・${n.unit}）`).join(', ');

/**
 * 栄養を求める。
 * - 飲食店・商品は grounding で公式の栄養表示を検索させる
 * - 自炊は検索しても公式値が無いので、写真を見て一般的な値で推定させる（grounding を使わない）
 */
export async function lookupNutrition(
  queries: NutritionQuery[],
  opts: { imageBase64?: string; signal?: AbortSignal } = {},
): Promise<{ results: NutritionResult[]; sources: string[] }> {
  if (queries.length === 0) return { results: [], sources: [] };
  const grounded = queries.some((q) => q.kind !== 'home');

  const list = queries
    .map((q, i) => `${i}: ${q.store ? `店「${q.store}」の` : ''}「${q.name}」（${q.kind === 'packaged' ? '商品 1 個' : '一人前'}）`)
    .join('\n');
  const prompt = `次の食事の栄養成分を求め、JSON のみを返してください（説明文は不要）。
${grounded ? 'チェーン店のメニューや市販の商品は、Google 検索で**店・メーカーの公式の栄養成分表示**を探して、その値を使ってください。公式の値が見つからなければ一般的な値で推定し、official を false にしてください。' : '家で作った料理なので、写真と料理名から一般的な分量・値で推定し、official は false にしてください。'}

${list}

返す形:
{"results":[{"index":0,"official":true,"nutrients":{"ENERC_KCAL":652,"PROT-":20.1, ...}}]}

nutrients のキーは次のとおり。値が分からないキーは null にする（0 と書かない）:
${NUTRIENT_LIST}`;

  const parts: object[] = [{ text: prompt }];
  if (opts.imageBase64 && !grounded) parts.push({ inline_data: { mime_type: 'image/jpeg', data: opts.imageBase64 } });

  const res = await callGeminiDetailed(parts, {
    highRes: false,
    signal:  opts.signal,
    ...(grounded ? { tools: [{ google_search: {} }] } : { schema: undefined }),
  });
  const parsed = parseJson(res.text);
  const arr: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
  const results = queries.map((_, i): NutritionResult => {
    const hit = arr.find((r) => Number(r?.index) === i) ?? arr[i];
    return {
      nutrients: sanitizeNutrients(hit?.nutrients),
      official:  grounded && hit?.official === true,
    };
  });
  return { results, sources: res.sources };
}
