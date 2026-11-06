/**
 * 日本食品標準成分表（八訂）増補2023年（文部科学省）を同梱して引く。
 *
 * - データは `assets/foodTable2023.json`（private/food-research/work/food_table/build.py で Excel から生成。手で直さない）。
 *   値は可食部 100g あたり。不明な値は null。
 * - どの食品にあたるかは Gemini に成分表の書き方の食品名（「にわとり 若どり もも 皮つき 生」）を書かせ、ここで語の一致で探す。
 *   食品番号をモデルに直接答えさせると、それらしい別の番号を返すため。
 * - 利用条件: 出典の表示（設定画面に載せている。`FOOD_TABLE_CREDIT`）。
 */

import { Nutrients, NUTRIENT_KEYS } from './Nutrients';

export const FOOD_TABLE_CREDIT = '日本食品標準成分表（八訂）増補2023年から引用';

/**
 * 照合の決まりを直したら今の時刻に進める。これより前に成分表から入れた食品データは調べ直す
 * （成分表の値そのものは変わらないので、ふだんは調べ直さない）
 */
export const TABLE_MATCH_SINCE = 0;

export interface TableFood {
  id:   string;
  name: string;
  /** 可食部 100g あたり */
  nutrients: Nutrients;
}

interface Entry extends TableFood {
  /** 照合用に揃えた食品名の語（分類の見出し「＜畜肉類＞」「（たまねぎ類）」は除く） */
  words: string[];
}

/** 水（成分表に無い。栄養は 0） */
const WATER: TableFood = { id: '-', name: '水', nutrients: Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) };

/**
 * よく使う調味料の短い呼び名 → 食品番号。成分表の書き方で答えないことが多く、
 * 語の一致だけだと「塩 → 塩豆」「しょうゆ → しょうゆ豆」のように別の食品に当たるため
 */
const ALIASES: Record<string, string> = {
  '塩': '17012', '食塩': '17012', 'しお': '17012',
  'しょうゆ': '17007', '醤油': '17007', 'しょう油': '17007',
  '砂糖': '03003', 'さとう': '03003',
  'みそ': '17045', '味噌': '17045',
  '酢': '17015', '食酢': '17015',
  'みりん': '16025',
  '酒': '16001', '料理酒': '16001', '日本酒': '16001',
  '油': '14006', 'サラダ油': '14006', '植物油': '14006', 'サラダ油 調合油': '14006',
  'こしょう': '17065', '胡椒': '17065',
  '片栗粉': '02034', 'かたくり粉': '02034',
  'バター': '14017',
  'マヨネーズ': '17042',
};
const WATER_NAMES = new Set(['水', 'お湯', '湯', '水道水']);

let entries: Entry[] | null = null;
let byId: Map<string, Entry> | null = null;

function load(): Entry[] {
  if (entries) return entries;
  const raw = require('../assets/foodTable2023.json') as { keys: string[]; foods: (string | number | null)[][] };
  entries = raw.foods.map((f) => {
    const nutrients: Nutrients = {};
    for (const key of NUTRIENT_KEYS) {
      const i = raw.keys.indexOf(key);
      const v = i < 0 ? null : f[i + 2];
      nutrients[key] = typeof v === 'number' ? v : null;
    }
    const name = String(f[1]);
    // 分類の見出しは照合しない（「＜和生菓子・和半生菓子類＞」の「生」が「ぎゅう もも 生」に当たる）
    const words = splitWords(name.replace(/＜[^＞]*＞|（[^）]*）/g, ' '));
    return { id: String(f[0]), name, nutrients, words };
  });
  byId = new Map(entries.map((e) => [e.id, e]));
  return entries;
}

/** 全角・カタカナ・括弧の違いを無視して語に分ける */
function splitWords(s: string): string[] {
  return s
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase()
    .replace(/[<>()[\]{}＜＞（）［］【】・、,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function toFood(e: Entry): TableFood {
  return { id: e.id, name: e.name, nutrients: e.nutrients };
}

/**
 * 成分表の書き方の食品名から食品を探す。
 * - 先頭の語（食品そのもの）は食品名の語と**完全に一致**すること（「ぎゅう」が「ぎゅうひ」に当たらないように）
 * - ほかの語は語の一部でもよい。すべて（3 語以上なら 1 語を除いて）当たること
 * - 当たった語の数 → 完全に一致した語の数 → 余分な語の少なさ → 食品名の短さ の順で選び、それでも並ぶなら選ばない
 */
export function findTableFood(tableName: string): TableFood | null {
  const all = load();
  const trimmed = tableName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (WATER_NAMES.has(trimmed)) return WATER;
  const alias = ALIASES[trimmed];
  if (alias) return byId!.get(alias) ? toFood(byId!.get(alias)!) : null;

  const words = splitWords(tableName);
  if (words.length === 0) return null;
  const need = words.length >= 3 ? words.length - 1 : words.length;
  type Score = { e: Entry; hit: number; exact: number; extra: number };
  let best: Score | null = null;
  let tie = false;
  for (const e of all) {
    if (!e.words.includes(words[0])) continue;
    let hit = 0;
    let exact = 0;
    for (const w of words) {
      if (e.words.includes(w)) { hit++; exact++; }
      else if (e.words.some((ew) => ew.includes(w))) hit++;
    }
    if (hit < need) continue;
    const extra = e.words.filter((ew) => !words.some((w) => ew.includes(w))).length;
    const s: Score = { e, hit, exact, extra };
    // 最後は食品名の短いもの（括弧書きの但し書きが無い、一般的なもの。「木綿豆腐」と「木綿豆腐（凝固剤：塩化マグネシウム）」）
    const cmp = !best ? 1
      : s.hit !== best.hit ? s.hit - best.hit
        : s.exact !== best.exact ? s.exact - best.exact
          : s.extra !== best.extra ? best.extra - s.extra
            : best.e.name.length - s.e.name.length;
    if (cmp > 0) { best = s; tie = false; }
    else if (cmp === 0) tie = true;
  }
  return best && !tie ? toFood(best.e) : null;
}

/** 出どころとして食事・食品データの sources に残す文字列（誤りに気づいたとき確かめられるように） */
export function tableSourceLabel(f: TableFood): string {
  return `成分表 ${f.id} ${f.name}`;
}

/**
 * エネルギーが大きく食い違うときは別の食品に当たったとみなす。
 * 差が 15kcal 未満なら比べない（野菜・調味料の少量は比が大きく振れるため）
 */
export function kcalAgrees(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return true;
  if (Math.abs(a - b) < 15) return true;
  if (a <= 0 || b <= 0) return false;
  const r = a / b;
  return r >= 0.5 && r <= 2;
}
