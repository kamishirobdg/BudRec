/**
 * 食事の推定に使う Gemini 呼び出し。仕様は docs/meal-nutrition-spec.md §5・§6。
 *
 * 1. `buildDishGuide` / `dishesFromParsed` … 写真の振り分け（PhotoAnalysis）のうち料理の部分
 * 2. `matchReceiptItems` … 料理とレシートの品目を対応付ける（構造化出力・テキストのみ）
 * 3. `lookupNutrition`   … 栄養を求める。チェーン店のメニュー・商品は **Google 検索 grounding** で
 *                          公式の栄養表示を引く。grounding と構造化出力は併用できないモデルがあるので、
 *                          grounding の呼び出しでは JSON を本文で返させて読む
 */

import {
  RECEIPT_ITEM_SCHEMA, ReceiptData, buildPhotoPrompt, parseJson, receiptsFromParsed,
} from './AIProvider';
import { callGemini, callGeminiDetailed } from './GeminiProvider';
import { NUTRIENTS, Nutrients, sanitizeNutrients } from '../services/Nutrients';

export type DishKind = 'eat_out' | 'packaged' | 'home';
export type Eater    = 'photographer' | 'partner' | 'both' | 'unknown';

/** 料理に使った在庫の食材と量 */
export interface UsedItem {
  /** DishContext.inventory の index */
  index:   number;
  /** 個数で数える品目なら食べた個数 */
  pieces?: number;
  /** 個数で数えない品目なら、残りに対して使った割合（0〜1） */
  ratio?:  number;
}

export interface IdentifiedDish {
  name:       string;
  kind:       DishKind;
  /** 一人前か、取り分ける料理（焼肉・寿司・鍋・大皿）か */
  shared:     boolean;
  /** 写っている一人前の数（同じ料理が 2 つなら 2） */
  count:      number;
  eater:      Eater;
  confidence: 'high' | 'medium' | 'low';
  /** 自炊・家で食べた商品のとき、在庫のどれを使ったか */
  used:       UsedItem[];
  /** 在庫のうち、どれなのか見分けられない候補（2 つ以上のときだけ）。ユーザーに後で選んでもらう */
  choices:    number[];
}

/** 在庫の 1 品（写真の料理・食品と突き合わせる候補） */
export interface InventoryLine {
  index:   number;
  name:    string;
  store:   string;
  /** 'M/D' */
  bought:  string;
  storage: string;
  /** 「残り 4 本」「残り 60%」など */
  remain:  string;
}

export interface DishContext {
  photographer: string;
  partner:      string | null;
  /** 似た状況の手修正（「焼肉では夫:妻 = 6:4 に直されることが多い」など）の要約 */
  corrections:  string[];
  /** 家にある食材・商品の候補（冷蔵・冷凍・常温のうち、まだ残っていて日持ちの範囲内のもの） */
  inventory:    InventoryLine[];
}

const DISH_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name:       { type: 'STRING' },
    kind:       { type: 'STRING', enum: ['eat_out', 'packaged', 'home'] },
    shared:     { type: 'BOOLEAN' },
    count:      { type: 'NUMBER' },
    eater:      { type: 'STRING', enum: ['photographer', 'partner', 'both', 'unknown'] },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    used: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          item:   { type: 'NUMBER' },
          pieces: { type: 'NUMBER' },
          ratio:  { type: 'NUMBER' },
        },
        required: ['item'],
      },
    },
    choices: { type: 'ARRAY', items: { type: 'NUMBER' } },
  },
  required: ['name', 'kind', 'shared', 'count', 'eater', 'confidence'],
  propertyOrdering: ['name', 'kind', 'shared', 'count', 'eater', 'confidence', 'used', 'choices'],
};

/** 料理の各項目の説明（写真の振り分けのプロンプトに入れる） */
export function buildDishGuide(ctx: DishContext): string {
  const people = ctx.partner
    ? `この写真を撮ったのは「${ctx.photographer}」。一緒に食べる可能性があるのは「${ctx.partner}」。`
    : `この写真を撮ったのは「${ctx.photographer}」。`;
  const corrections = ctx.corrections.length > 0
    ? `\n過去の手修正の傾向（分け方の参考にする）:\n${ctx.corrections.map((c) => `- ${c}`).join('\n')}\n`
    : '';
  const inventory = ctx.inventory.length > 0
    ? `\n家にある食材・商品（買った物の記録。index: 品名 / 店 / 買った日 / 保存 / 残り）:\n${
      ctx.inventory.map((i) => `${i.index}: ${i.name} / ${i.store} / ${i.bought} / ${i.storage} / ${i.remain}`).join('\n')}\n`
    : '';
  return `${people}
${corrections}${inventory}
写真に写っている料理・食品ごとに 1 つ:
- name: 料理名。チェーン店のメニューと分かる場合は公式のメニュー名に近い名前（例: 牛丼 並盛）。
  家にある商品と分かれば、その品名
- kind: eat_out（飲食店の料理）/ packaged（コンビニ・スーパーの弁当・パン・菓子・飲料・アイスなどの商品）/ home（家で作った料理）
- shared: 焼肉・寿司の盛り合わせ・鍋・大皿料理など、一品で完結せず取り分けて食べるものは true。一人前の料理は false
- count: 同じ一人前の料理がいくつ写っているか（取り分ける料理は 1）
- eater: 誰が食べるか。photographer（撮った人）/ partner（相手）/ both（二人で分ける）/ unknown（判断できない）
  - 一人前の料理が 1 つだけなら photographer
  - 取り分ける料理は both
  - 一人前の料理が人数分あって、どちらの分か写真から判断できなければ unknown
- confidence: 料理の判別の確からしさ。何の料理か分からなければ low
- used: 家で作った料理・家で食べた商品のとき、上の「家にある食材・商品」のどれを使ったか（item に index）。
  個数で数える商品は食べた個数を pieces に、それ以外は残りのうち使った割合を ratio（0〜1）に入れる。
  写真から量を見積もり、残りの量を超えないようにする。飲食店の料理なら空配列
- choices: 家にある食材・商品のうち、**同じ種類の候補が複数あってどれなのか写真から見分けられない**とき、
  その候補の index を全部入れる（例: 冷凍からあげが 2 種類あるとき）。見分けられる・候補が 1 つなら空配列。
  見分けられないときも used には最も可能性の高いものを入れておく

食べ物以外（食器・調味料の容器・メニュー表）は含めない。料理・食品が写っていなければ dishes は空配列。`;
}

/** 写真の振り分けの出力スキーマ（レシートと料理の両方を受ける） */
export function photoSchema(receiptItemSchema: object): object {
  return {
    type: 'OBJECT',
    properties: {
      receipts: { type: 'ARRAY', items: receiptItemSchema },
      dishes:   { type: 'ARRAY', items: DISH_ITEM_SCHEMA },
    },
    required: ['receipts', 'dishes'],
  };
}

/** モデルが返した料理を整える */
export function dishesFromParsed(parsed: any, inventorySize: number): IdentifiedDish[] {
  const list: any[] = Array.isArray(parsed?.dishes) ? parsed.dishes : [];
  const validIndex = (n: unknown) => Number.isInteger(Number(n)) && Number(n) >= 0 && Number(n) < inventorySize;
  return list
    .map((d): IdentifiedDish => ({
      name:       String(d?.name ?? '').trim(),
      kind:       ['eat_out', 'packaged', 'home'].includes(d?.kind) ? d.kind : 'eat_out',
      shared:     d?.shared === true,
      count:      Math.max(1, Math.round(Number(d?.count) || 1)),
      eater:      ['photographer', 'partner', 'both', 'unknown'].includes(d?.eater) ? d.eater : 'unknown',
      confidence: ['high', 'medium', 'low'].includes(d?.confidence) ? d.confidence : 'low',
      used: (Array.isArray(d?.used) ? d.used : [])
        .filter((u: any) => validIndex(u?.item))
        .map((u: any): UsedItem => ({
          index:  Number(u.item),
          pieces: Number(u?.pieces) > 0 ? Number(u.pieces) : undefined,
          ratio:  Number(u?.ratio) > 0 ? Math.min(1, Number(u.ratio)) : undefined,
        })),
      choices: [...new Set<number>((Array.isArray(d?.choices) ? d.choices : []).filter(validIndex).map(Number))],
    }))
    .map((d) => ({ ...d, choices: d.choices.length >= 2 ? d.choices : [] }))
    .filter((d) => d.name.length > 0);
}

export interface PhotoAnalysis {
  receipts: ReceiptData[];
  dishes:   IdentifiedDish[];
}

/**
 * 撮った写真を 1 回の呼び出しでレシートと料理・食品に振り分けて読む（両方写っていれば両方）。
 * レシートの小さい文字のために高解像度で送る。
 */
export async function analyzePhoto(
  imageBase64: string,
  categories: string[],
  ctx: DishContext,
  signal?: AbortSignal,
): Promise<PhotoAnalysis> {
  const raw = await callGemini(
    [
      { text: buildPhotoPrompt(categories, buildDishGuide(ctx)) },
      { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
    ],
    { schema: photoSchema(RECEIPT_ITEM_SCHEMA), highRes: true, signal },
  );
  const parsed = parseJson(raw);
  return {
    receipts: receiptsFromParsed({ receipts: Array.isArray(parsed?.receipts) ? parsed.receipts : [] }, raw, categories),
    dishes:   dishesFromParsed(parsed, ctx.inventory.length),
  };
}

export interface FoodQuery {
  name:  string;
  /** 外食のチェーン名（店頭の商品なら空） */
  chain: string;
  kind:  DishKind | 'ingredient';
  /** レシートの内容量（「300g」「6本」など。分かれば） */
  content: string;
}

export interface FoodNutrition {
  nutrients: Nutrients;
  /** 値の単位。package = 1 個・1 パック・一人前あたり / per100g = 100g あたり（量り売りの食材） */
  basis:     'package' | 'per100g';
  official:  boolean;
}

/**
 * 食品データ（_foods）を作るための調査。商品・メニューは grounding で公式の栄養成分表示を探し、
 * 量り売りの食材は 100g あたりの一般的な値（日本食品標準成分表に相当する値）を返させる。
 */
export async function researchFoods(
  queries: FoodQuery[],
  signal?: AbortSignal,
): Promise<{ results: FoodNutrition[]; sources: string[] }> {
  if (queries.length === 0) return { results: [], sources: [] };
  const list = queries
    .map((q, i) => `${i}: ${q.chain ? `「${q.chain}」の` : ''}「${q.name}」${q.content ? `（${q.content}）` : ''}`)
    .join('\n');
  const prompt = `次の食品の栄養成分を調べ、JSON のみを返してください（説明文は不要）。
- 市販の商品・飲食店のメニューは、Google 検索で**メーカー・店の公式の栄養成分表示**を探して使い、basis を package（1 個・1 パック・一人前あたり）にする。公式の値が見つからなければ一般的な値で推定し、official を false にする
- 肉・魚・野菜など量り売りの食材は、100g あたりの一般的な値（日本食品標準成分表に相当する値）にして basis を per100g、official を false にする

${list}

返す形:
{"results":[{"index":0,"basis":"package","official":true,"nutrients":{"ENERC_KCAL":652,"PROT-":20.1, ...}}]}

nutrients のキーは次のとおり。値が分からないキーは null にする（0 と書かない）:
${NUTRIENT_LIST}`;
  const res = await callGeminiDetailed([{ text: prompt }], { highRes: false, signal, tools: [{ google_search: {} }] });
  const parsed = parseJson(res.text);
  const arr: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
  const results = queries.map((_, i): FoodNutrition => {
    const hit = arr.find((r) => Number(r?.index) === i) ?? arr[i];
    return {
      nutrients: sanitizeNutrients(hit?.nutrients),
      basis:     hit?.basis === 'per100g' ? 'per100g' : 'package',
      official:  hit?.official === true,
    };
  });
  return { results, sources: res.sources };
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
