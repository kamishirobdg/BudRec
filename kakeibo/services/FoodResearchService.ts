/**
 * 食品データの一括調査（設定画面の窓口）。API の無料枠を使わずに、Gemini / Claude のアプリで
 * まとめて調べてもらう。仕様は docs/meal-nutrition-spec.md §8.8.1（方式 A）。
 *
 * 1. `buildResearchRequest` … 過去のレシートからまだ調べていない品目を集め、調査の指示文を付けて返す
 * 2. `importResearchTable` … AI の答え（タブ区切りの表）を `_foods` に取り込む
 */

import { SheetsInternal, ITEMS_RANGE } from './SheetsService';
import { FoodQuery, FoodNutrition } from '../providers/GeminiMeal';
import { Food, foodKey, isStale, loadFoods, loadMenuIndex, saveResearched } from './FoodService';
import { NUTRIENTS, sanitizeNutrients } from './Nutrients';
import { readJsonArray, removeFile, writeJson } from './jsonFileStore';

/** 1 回の文面に載せる品目数 */
const PER_REQUEST = 50;
/**
 * 前回の文面に載せた品名。取り込んだときに、答えに無かったものをしばらく載せないようにする。
 * SecureStore は大きな値を保存できないことがあるのでファイルに置く
 */
const LAST_REQUEST_FILE = 'food-research-request.json';
/**
 * 文面に載せたのに答えに無かった品目（AI が分からなかった・答えが途中で切れた）。30 日は載せない。
 * 食品データを failed にはしない（途中で切れた答えで、空き時間の調査からも永久に外れてしまうため）
 */
const SKIPPED_FILE = 'food-research-skipped.json';
const SKIP_MS = 30 * 24 * 60 * 60 * 1000;

interface Skipped {
  key: string;
  at:  number;
}

/** レシートの品目のうち、食品ではないもの（メモ欄には区別が無いので名前で外す） */
const NON_FOOD = /レジ袋|ポリ袋|袋$|値引|割引|送料|手数料|^部門|^小計|^合計|ポイント/;

export const TABLE_COLUMNS = ['name', 'chain', 'basis', 'official', 'source_url', ...NUTRIENTS.map((n) => n.key)];

interface Candidate {
  name:    string;
  store:   string;
  content: string;
  count:   number;
}

function isDue(f: Food | undefined): boolean {
  if (!f) return true;
  if (f.status === 'pending') return true;
  return f.status === 'done' && isStale(f);
}

/** 月次シートのメモ欄（`品名:価格, …`）と `_items_YYYY-MM` から品目を集める */
async function collectCandidates(): Promise<Candidate[]> {
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  const months = names.filter((n) => /^\d{4}-\d{2}$/.test(n));
  const items = names.filter((n) => /^_items_\d{4}-\d{2}$/.test(n));
  const ranges = [
    ...months.map((s) => `'${s}'!D2:M`),
    ...items.map((s) => `'${s}'!${ITEMS_RANGE}`),
  ];
  if (ranges.length === 0) return [];
  const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const res = await client.get(`/values:batchGet?${query}&valueRenderOption=UNFORMATTED_VALUE`);
  const valueRanges: { values?: any[][] }[] = res.data.valueRanges ?? [];

  const map = new Map<string, Candidate & { stores: Map<string, number> }>();
  const add = (name: string, store: string, content: string) => {
    const n = name.trim();
    if (!n || NON_FOOD.test(n)) return;
    const key = foodKey(n);
    const c = map.get(key) ?? { name: n, store: '', content: '', count: 0, stores: new Map() };
    c.count++;
    if (store) c.stores.set(store, (c.stores.get(store) ?? 0) + 1);
    if (content && !c.content) c.content = content;
    map.set(key, c);
  };

  valueRanges.forEach((vr, i) => {
    const rows = vr.values ?? [];
    if (i < months.length) {
      // D 店名 / E カテゴリ / F 金額 / G メモ / L 削除 / M entry_id。食費・外食など「食」の付くカテゴリだけ
      // （日用品の品目を外す）。entry_id のある行は品目が `_items` にあるのでそちらで数える（二重に数えない）
      for (const r of rows) {
        if (!String(r[1] ?? '').includes('食')) continue;
        if (String(r[8]).toUpperCase() === 'TRUE' || String(r[9] ?? '') !== '') continue;
        for (const part of String(r[3] ?? '').split(/[,、，]\s*/)) {
          const m = part.trim().match(/^(.*?)[:：]\s*-?\d+\s*$/);
          if (m) add(m[1], String(r[0] ?? ''), '');
        }
      }
    } else {
      // `_items`: E 店 / F 品名 / G 正規化した品名 / H 数量 / I 単位 / K 種類
      for (const r of rows.slice(1)) {
        if (String(r[10] ?? '') === 'non_food') continue;
        add(String(r[6] || r[5] || ''), String(r[4] ?? ''), r[7] ? `${r[7]}${r[8] ?? ''}` : '');
      }
    }
  });

  return [...map.values()]
    .map(({ stores, ...c }) => ({ ...c, store: [...stores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 調査用の文面を作る。まだ調べていない品目を購入回数の多い順に 50 件まで載せる。
 * 載せた品目は覚えておき、取り込みのときに答えに無かったものは 30 日載せない。
 */
export async function buildResearchRequest(): Promise<{ text: string; count: number; remaining: number }> {
  const [candidates, foods, menus] = await Promise.all([
    collectCandidates(), loadFoods(true), loadMenuIndex().then((i) => i.menus).catch(() => new Map<string, Food>()),
  ]);
  // 外食のメニュー・店のオリジナル商品は `チェーン名|品名` の鍵で入るので、チェーン名を問わず品名で「調べ済み」を判断する
  const settled = new Set([...foods.values(), ...menus.values()].filter((f) => !isDue(f)).map((f) => foodKey(f.name)));
  const skipped = new Set(readSkipped().map((s) => s.key));
  const due = candidates.filter((c) => !settled.has(foodKey(c.name)) && !skipped.has(foodKey(c.name)));
  const batch = due.slice(0, PER_REQUEST);
  writeJson(LAST_REQUEST_FILE, batch.map((c) => c.name));
  if (batch.length === 0) return { text: '', count: 0, remaining: 0 };

  const list = batch
    .map((c) => `${c.name}${c.content ? `（${c.content}）` : ''}${c.store ? `［買った店: ${c.store}］` : ''}`)
    .join('\n');
  const units = NUTRIENTS.map((n) => `${n.key}=${n.label}(${n.unit})`).join(', ');
  const text = `家計簿アプリに取り込むため、次の食品の栄養成分を調べて表にしてください。品名はレシートの表記なので、略称・半角カナは読み替えてください。

【返し方】
- 表だけを返す（説明文は不要）。コードブロック（\`\`\`）の中に、タブ区切りで、1 行目に次の見出しを書く:
${TABLE_COLUMNS.join('\t')}
- name: 下の一覧の品名をそのまま書く（直さない。（）の内容量と［］の店名は書かない）
- chain: 飲食店のメニューならチェーン名（店舗名は除く。例: マクドナルド）。コンビニ・スーパーで買った商品・食材は空
- basis: piece（複数入り商品の 1 個あたり）/ package（1 個売り・1 パック・飲食店の一人前あたり）/ per100g（肉・魚・野菜など量り売りの食材の 100g あたり）
- official: メーカー・店の公式の栄養成分表示から取った値なら TRUE、推定した値なら FALSE
- source_url: 値を取った公式ページの URL（推定なら空）
- 栄養素の単位: ${units}
- 分からない値は空欄にする（0 と書かない）。単位は書かない
- 食品でないもの・何の品か分からないものは行を出さない

【品目】
${list}`;
  return { text, count: batch.length, remaining: due.length - batch.length };
}

export interface ParsedFood {
  query:   FoodQuery;
  result:  FoodNutrition;
  sources: string[];
}

/** 表を読む。タブ区切りのほか、AI アプリが Markdown の表で返した場合（| 区切り）も受け付ける */
export function parseResearchTable(text: string): { rows: ParsedFood[]; skipped: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('```'));
  // タブが空白に変わった表は読まない（空欄の列が詰まって、値が別の栄養素の列にずれるため）
  const split = (l: string) =>
    l.includes('\t') ? l.split('\t').map((s) => s.trim())
      : l.startsWith('|') ? l.replace(/^\||\|$/g, '').split('|').map((s) => s.trim())
        : null;
  let header: string[] | null = null;
  const rows: ParsedFood[] = [];
  let skipped = 0;
  for (const line of lines) {
    const cells = split(line);
    if (!cells) continue;
    if (!header) {
      if (cells.includes('name')) header = cells;
      continue;
    }
    // Markdown の表の区切り行（|---|---|）
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === '')) continue;
    const get = (col: string) => {
      const i = header!.indexOf(col);
      return i >= 0 ? (cells[i] ?? '') : '';
    };
    const name = get('name');
    const raw: Record<string, string> = {};
    for (const n of NUTRIENTS) {
      // 「Tr」「-」「(0.1)」などは数値の部分だけ読む（読めなければ空）
      const v = get(n.key).replace(/[()（）,]/g, '');
      raw[n.key] = /^\d+(\.\d+)?$/.test(v) ? v : '';
    }
    const nutrients = sanitizeNutrients(raw);
    if (!name || !Object.values(nutrients).some((v) => v !== null)) {
      skipped++;
      continue;
    }
    const b = get('basis').toLowerCase();
    const basis = b === 'per100g' ? 'per100g' : b === 'piece' ? 'piece' : 'package';
    const chain = get('chain');
    const url = get('source_url');
    rows.push({
      query: { name, chain, kind: chain ? 'eat_out' : basis === 'per100g' ? 'ingredient' : 'packaged', content: '' },
      result: { nutrients, basis, official: /^(true|○|yes)$/i.test(get('official')) },
      sources: /^https?:\/\//.test(url) ? [url] : [],
    });
  }
  return { rows, skipped };
}

function readSkipped(): Skipped[] {
  return readJsonArray<Skipped>(SKIPPED_FILE).filter((s) => Date.now() - Number(s.at) < SKIP_MS);
}

/**
 * AI の答えを `_foods` に取り込む。前回の文面に載せたのに答えに無かった品目は 30 日載せない。
 * 表が見つからなければ例外を投げる。
 */
export async function importResearchTable(text: string): Promise<{ imported: number; skipped: number }> {
  const { rows, skipped } = parseResearchTable(text);
  if (rows.length === 0 && skipped === 0) throw new Error('表が見つかりませんでした。答えをまるごと貼り付けてください');

  const asked = readJsonArray<string>(LAST_REQUEST_FILE).map(String);
  const askedKeys = new Set(asked.map((n) => foodKey(n)));
  // AI が「牛乳（1000ml）」のように内容量を付けて返したら、載せた品名に戻す
  for (const r of rows) {
    if (askedKeys.has(foodKey(r.query.name))) continue;
    const bare = r.query.name.replace(/\s*[（(［\[][^）)］\]]*[）)］\]]\s*$/, '');
    if (bare && askedKeys.has(foodKey(bare))) r.query = { ...r.query, name: bare };
  }
  const answered = new Set(rows.map((r) => foodKey(r.query.name)));
  // 前回の文面への答えでない表（別に用意した表など）なら、載せた品目に印を付けない
  const isAnswer = asked.some((name) => answered.has(foodKey(name)));

  // 同じ品目が 2 回出てきたら後の行を使う
  const unique = new Map<string, ParsedFood>();
  for (const r of rows) unique.set(foodKey(r.query.name, r.query.chain), r);
  await saveResearched([...unique.values()]);

  if (isAnswer) {
    const missing = asked.filter((name) => !answered.has(foodKey(name)));
    writeJson(SKIPPED_FILE, [...readSkipped(), ...missing.map((name) => ({ key: foodKey(name), at: Date.now() }))]);
    removeFile(LAST_REQUEST_FILE);
  }
  return { imported: unique.size, skipped };
}
