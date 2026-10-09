/**
 * サプリの CSV / TSV の取り込み。仕様は docs/meal-nutrition-spec.md §11.3。
 *
 * 2 つの形を受け付ける（見出しの名前で見分ける。列の並びは問わない）:
 * - 縦長: 1 行 = 1 商品 × 1 成分。商品名・成分名・含有量・単位（・基準量・1 日量）の列
 * - 横長: 1 行 = 1 商品。成分ごとの列（見出しが「ビタミンC(mg)」のように栄養素名）
 *
 * 成分名・見出しの揺れ（「V.C」「ビタミンＣ」「VITC」「熱量」など）は別名表で栄養素のキーに当てる。
 * 化合物（塩）の重さで書かれたビタミン B1・B6 は純量に直す。IU は µg / mg に直す。
 * 栄養素に当たらない成分（アミノ酸・DHA・乳酸菌・生薬など）は登録せず、メモに名前を残す。
 */

import { NUTRIENTS, NUTRIENT_KEYS, Nutrients, nutrientDef } from './Nutrients';

export interface ImportedSupplement {
  name:   string;
  unit:   string;
  perDay: number;
  /** 表示が何単位あたりか（1 単位あたりに割る前の数） */
  perUnit: number;
  /** 1 単位あたり */
  nutrients: Nutrients;
  /** 栄養素に当たらなかった成分（名前と量） */
  others: string[];
  note:   string;
}

export interface ImportResult {
  supplements: ImportedSupplement[];
  /** 読めなかった行の数 */
  skipped: number;
}

// ─── 表の読み取り ─────────────────────────────────────────────────────────────

/** CSV / TSV を行 × 列に分ける（引用符の中のカンマ・改行を許す） */
export function parseTable(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const delim = (src.split('\n')[0] ?? '').includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

// ─── 見出しの別名 ─────────────────────────────────────────────────────────────

type Column = 'name' | 'nutrient' | 'amount' | 'unit' | 'perUnit' | 'perDay' | 'note';

const COLUMN_ALIASES: Record<Column, string[]> = {
  name:     ['商品名', '製品名', 'サプリ名', '名前', '名称', 'name', 'product'],
  nutrient: ['成分名', '栄養素', '栄養素名', '成分', '項目', '項目名', 'nutrient', 'component'],
  amount:   ['表示含有量', '含有量', '配合量', '量', '値', '数値', 'amount', 'value', 'content'],
  unit:     ['単位', 'unit'],
  perUnit:  ['表示の基準量', '基準量', '表示量', '表示基準', '目安量', '何粒あたり', 'perunit', 'serving', 'basis'],
  perDay:   ['本人の1日摂取量', '1日摂取量', '1日の量', '1日量', '一日量', '摂取量', 'perday', 'daily'],
  note:     ['備考', 'メモ', 'note', 'remarks'],
};

/** 見出し・成分名を比べやすくする（全角→半角・小文字・空白と記号を除く） */
function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s　・･\-_/]/g, '');
}

/** 見出しの括弧書き（「ビタミンC(mg)」の (mg)）を外す。単位は別に返す */
function splitHeader(h: string): { label: string; unit: string } {
  const m = h.match(/^(.*?)\s*[（(]\s*([a-zA-Zµμ]+)\s*[)）]\s*$/);
  return m ? { label: m[1].trim(), unit: m[2] } : { label: h.trim(), unit: '' };
}

function findColumns(header: string[]): Partial<Record<Column, number>> {
  const out: Partial<Record<Column, number>> = {};
  (Object.keys(COLUMN_ALIASES) as Column[]).forEach((col) => {
    const aliases = COLUMN_ALIASES[col].map(norm);
    // 完全一致を先に、無ければ含むもの（「表示含有量」は amount の別名にあるので「含有量」より先に当たる）
    let idx = header.findIndex((h) => aliases.includes(norm(h)));
    if (idx < 0) idx = header.findIndex((h) => aliases.some((a) => norm(h).includes(a)));
    if (idx >= 0) out[col] = idx;
  });
  // 「量」のような短い別名が成分名の列に当たらないよう、同じ列を 2 役にしない
  const used = new Set<number>();
  for (const col of ['name', 'nutrient', 'unit', 'perUnit', 'perDay', 'note', 'amount'] as Column[]) {
    const i = out[col];
    if (i === undefined) continue;
    if (used.has(i)) delete out[col];
    else used.add(i);
  }
  return out;
}

// ─── 成分名 → 栄養素のキー ────────────────────────────────────────────────────

/** 別名（norm を通した形で比べる） */
const NUTRIENT_ALIASES: Record<string, string[]> = {
  ENERC_KCAL: ['エネルギー', '熱量', 'カロリー', 'energy', 'kcal'],
  'PROT-':    ['たんぱく質', 'タンパク質', '蛋白質', 'protein'],
  'FAT-':     ['脂質', 'fat', '脂肪'],
  'CHOCDF-':  ['炭水化物', 'carbohydrate', 'carb', 'carbs'],
  'CHOAVLDF-': ['糖質', 'sugar', 'sugars'],
  'FIB-':     ['食物繊維', 'fiber', 'fibre', 'dietaryfiber'],
  NACL_EQ:    ['食塩相当量', '食塩', '塩分', 'salt', 'saltequivalent'],
  FASAT:      ['飽和脂肪酸', 'saturatedfat'],
  FAMS:       ['一価不飽和脂肪酸', 'monounsaturatedfat'],
  // DHA・EPA は n-3 系の多価不飽和脂肪酸なので、ここに足す
  FAPU:       ['多価不飽和脂肪酸', 'polyunsaturatedfat', 'n3系脂肪酸', 'オメガ3', 'omega3', 'dha+epa', 'dhaepa', 'dha', 'epa',
               'ドコサヘキサエン酸', 'エイコサペンタエン酸', 'αリノレン酸', 'リノール酸'],
  CHOLE:      ['コレステロール', 'cholesterol'],
  NA:         ['ナトリウム', 'sodium', 'na'],
  K:          ['カリウム', 'potassium', 'k'],
  CA:         ['カルシウム', 'calcium', 'ca'],
  MG:         ['マグネシウム', 'magnesium', 'mg'],
  P:          ['リン', 'phosphorus', 'p'],
  FE:         ['鉄', '鉄分', 'iron', 'fe', 'ヘム鉄'],
  ZN:         ['亜鉛', 'zinc', 'zn'],
  CU:         ['銅', 'copper', 'cu'],
  MN:         ['マンガン', 'manganese', 'mn'],
  ID:         ['ヨウ素', 'ヨード', 'iodine', 'i'],
  SE:         ['セレン', 'selenium', 'se'],
  CR:         ['クロム', 'chromium', 'cr'],
  MO:         ['モリブデン', 'molybdenum', 'mo'],
  VITA_RAE:   ['ビタミンa', 'v.a', 'va', 'vitamina', 'レチノール', 'retinol', 'βカロテン', 'ベータカロテン', 'betacarotene'],
  VITD:       ['ビタミンd', 'v.d', 'vd', 'vitamind', 'ビタミンd3', 'vitamind3', 'コレカルシフェロール'],
  TOCPHA:     ['ビタミンe', 'v.e', 've', 'vitamine', 'αトコフェロール', 'トコフェロール', 'tocopherol'],
  VITK:       ['ビタミンk', 'v.k', 'vk', 'vitamink', 'ビタミンk2', 'メナキノン'],
  THIA:       ['ビタミンb1', 'v.b1', 'vb1', 'vitaminb1', 'チアミン', 'thiamin', 'thiamine'],
  RIBF:       ['ビタミンb2', 'v.b2', 'vb2', 'vitaminb2', 'リボフラビン', 'riboflavin'],
  NIA:        ['ナイアシン', 'niacin', 'ビタミンb3', 'vb3', 'ニコチン酸', 'ニコチン酸アミド', 'ナイアシンアミド', 'nicotinamide'],
  VITB6A:     ['ビタミンb6', 'v.b6', 'vb6', 'vitaminb6', 'ピリドキシン', 'pyridoxine'],
  VITB12:     ['ビタミンb12', 'v.b12', 'vb12', 'vitaminb12', 'シアノコバラミン', 'cobalamin'],
  FOL:        ['葉酸', 'folate', 'folicacid', 'ビタミンb9'],
  PANTAC:     ['パントテン酸', 'pantothenicacid', 'ビタミンb5', 'パントテン酸ca', 'パントテン酸カルシウム'],
  BIOT:       ['ビオチン', 'biotin', 'ビタミンb7', 'ビタミンh'],
  VITC:       ['ビタミンc', 'v.c', 'vc', 'vitaminc', 'アスコルビン酸', 'ascorbicacid', 'laスコルビン酸'],
};

/**
 * 化合物（塩）の重さで書かれているときの純量への換算（分子量の比）。
 * 成分名にこれらの語があれば掛ける
 */
const SALT_FACTORS: { key: string; words: string[]; factor: number }[] = [
  { key: 'THIA',   words: ['チアミン硝化物', '硝酸チアミン', 'チアミン塩化物塩酸塩', 'チアミン塩酸塩'], factor: 265.35 / 327.36 },
  { key: 'VITB6A', words: ['ピリドキシン塩酸塩'], factor: 169.18 / 205.64 },
  { key: 'VITC',   words: ['アスコルビン酸ナトリウム', 'アスコルビン酸na', 'アスコルビン酸カルシウム', 'アスコルビン酸ca'], factor: 176.12 / 198.11 },
];

export interface MappedNutrient {
  key:    string;
  /** アプリの単位での値 */
  value:  number;
}

/** 成分名と単位つきの値を、栄養素のキーとアプリの単位の値に当てる。当たらなければ null */
export function mapNutrient(rawName: string, value: number, rawUnit: string): MappedNutrient | null {
  if (!Number.isFinite(value)) return null;
  const nfkc = rawName.normalize('NFKC');
  // 「L-アスコルビン酸ナトリウム（L-アスコルビン酸として）」→ 括弧の中の「〜として」を優先する
  const asMatch = nfkc.match(/[（(]\s*(.+?)\s*として\s*[)）]/);
  const label = asMatch ? asMatch[1] : nfkc.replace(/[（(][^）)]*[）)]/g, '');
  const n = norm(label);
  if (!n) return null;

  let key = findKey(n) ?? findKey(norm(nfkc));
  if (!key) return null;

  let v = value;
  // 塩の重さ → 純量（「〜として」が付いていれば既に純量）
  if (!asMatch) {
    const salt = SALT_FACTORS.find((s) => s.key === key && s.words.some((w) => norm(nfkc).includes(norm(w))));
    if (salt) v *= salt.factor;
  }
  const target = nutrientDef(key)!.unit;
  const converted = convertUnit(v, rawUnit, target, key);
  if (converted === null) return null;
  return { key, value: Math.round(converted * 10_000) / 10_000 };
}

function findKey(n: string): string | null {
  // 完全一致を先に（「ビタミンb12」が「ビタミンb1」に含まれるため）
  for (const key of NUTRIENT_KEYS) {
    const aliases = [norm(nutrientDef(key)!.label), ...(NUTRIENT_ALIASES[key] ?? []).map(norm)];
    if (aliases.includes(n)) return key;
  }
  // 「総ビタミンa」「ナイアシン当量」のように余分な語が付いたもの: 長い別名から順に、先頭か末尾に一致。
  // 短い別名では比べない（「リン」が「バリン」「プロリン」の末尾に当たる）
  const candidates: { key: string; alias: string }[] = [];
  for (const key of NUTRIENT_KEYS) {
    for (const a of [norm(nutrientDef(key)!.label), ...(NUTRIENT_ALIASES[key] ?? []).map(norm)]) {
      if (a.length >= 4 && (n.startsWith(a) || n.endsWith(a))) candidates.push({ key, alias: a });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.alias.length - a.alias.length);
  // 「ビタミンb12」の末尾「b12」と「ビタミンb1」が両方当たるときは、長く当たったほう
  return candidates[0].key;
}

/** 単位の表記を揃える（NFKC でマイクロ記号 µ はギリシャ文字の μ になる。mcg・ug も μg） */
function normUnit(u: string): string {
  return u.normalize('NFKC').toLowerCase().replace(/\s/g, '').replace(/^(u|mc)g$/, 'μg');
}

/** 単位を直す。直せなければ null */
function convertUnit(v: number, from: string, to: string, key: string): number | null {
  const f = normUnit(from);
  const t = normUnit(to);
  if (!f || f === t) return v;
  const scale: Record<string, number> = { g: 1, mg: 1e-3, 'μg': 1e-6, kg: 1e3 };
  if (f in scale && t in scale) return v * scale[f] / scale[t];
  if (f === 'iu') {
    // 国際単位 → 質量（ビタミン A はレチノール、E は d-α-トコフェロールとして）
    const iu: Record<string, number> = { VITD: 0.025, VITA_RAE: 0.3, TOCPHA: 0.67 };
    const per = iu[key];
    return per === undefined ? null : v * per;
  }
  if (f === 'kcal' && t === 'kcal') return v;
  if (f === 'kj' && t === 'kcal') return v / 4.184;
  return null;
}

// ─── 商品ごとにまとめる ──────────────────────────────────────────────────────

/** 「3粒」「4粒（半量）」「9錠（成人1回3錠×1日3回）」→ { count: 3, unit: '粒' } */
export function parseServing(s: string): { count: number; unit: string } | null {
  const m = s.normalize('NFKC').match(/(\d+(?:\.\d+)?)\s*(粒|錠|包|本|カプセル|cap|カプセル|袋|g|ml|回分|個|枚|スティック)?/i);
  if (!m) return null;
  return { count: Number(m[1]), unit: m[2] ? m[2].replace(/^cap$/i, 'カプセル') : '' };
}

export function parseSupplementTable(text: string): ImportResult {
  const rows = parseTable(text);
  if (rows.length < 2) return { supplements: [], skipped: rows.length };
  const header = rows[0];
  const cols = findColumns(header);
  if (cols.name === undefined) return { supplements: [], skipped: rows.length - 1 };
  return cols.nutrient !== undefined && cols.amount !== undefined
    ? fromLong(rows.slice(1), cols as { name: number; nutrient: number; amount: number } & Partial<Record<Column, number>>)
    : fromWide(header, rows.slice(1), cols);
}

interface Acc {
  name: string; unit: string; perUnit: number; perDay: number;
  nutrients: Nutrients; others: { name: string; amount: number; unit: string }[]; notes: string[];
}

function newAcc(name: string): Acc {
  return { name, unit: '', perUnit: 1, perDay: 1, nutrients: {}, others: [], notes: [] };
}

function finish(acc: Acc): ImportedSupplement {
  const nutrients: Nutrients = {};
  for (const key of NUTRIENT_KEYS) {
    const v = acc.nutrients[key];
    nutrients[key] = v === undefined || v === null ? null : Math.round(v / acc.perUnit * 10_000) / 10_000;
  }
  // 当たらなかった成分は表示の基準量あたりのまま残す（「3 粒あたり DHA 510mg」）
  const others = acc.others.map((o) => `${o.name} ${trimNumber(o.amount)}${o.unit}`);
  const note = [
    others.length > 0 ? `${acc.perUnit} ${acc.unit || '粒'}あたり: ${others.join('、')}` : '',
    ...acc.notes,
  ].filter(Boolean).join('\n');
  return { name: acc.name, unit: acc.unit || '粒', perDay: acc.perDay, perUnit: acc.perUnit, nutrients, others, note };
}

/** 1 行 = 1 商品 × 1 成分 */
function fromLong(rows: string[][], cols: { name: number; nutrient: number; amount: number } & Partial<Record<Column, number>>): ImportResult {
  const accs = new Map<string, Acc>();
  let skipped = 0;
  for (const r of rows) {
    const name = r[cols.name] ?? '';
    if (!name) { skipped++; continue; }
    let acc = accs.get(name);
    if (!acc) {
      acc = newAcc(name);
      // 基準量・1 日量は商品ごとに同じはずなので、最初の行で読む
      const serving = cols.perUnit !== undefined ? parseServing(r[cols.perUnit] ?? '') : null;
      const daily = cols.perDay !== undefined ? parseServing(r[cols.perDay] ?? '') : null;
      if (serving && serving.count > 0) { acc.perUnit = serving.count; acc.unit = serving.unit; }
      if (daily && daily.count > 0) { acc.perDay = daily.count; acc.unit = acc.unit || daily.unit; }
      else if (serving && serving.count > 0) acc.perDay = serving.count;
      accs.set(name, acc);
    }
    const nutrientName = r[cols.nutrient] ?? '';
    const amount = parseFloat((r[cols.amount] ?? '').normalize('NFKC').replace(/,/g, ''));
    const unit = cols.unit !== undefined ? r[cols.unit] ?? '' : '';
    if (!nutrientName) { skipped++; continue; }
    // 原材料・添加物の行（量が無い）は飛ばす
    if (!Number.isFinite(amount)) { if (!/原材料|添加物|全量/.test(nutrientName)) skipped++; continue; }
    const mapped = mapNutrient(nutrientName, amount, unit);
    if (mapped) {
      acc.nutrients[mapped.key] = (acc.nutrients[mapped.key] ?? 0) + mapped.value;
    } else {
      addOther(acc, nutrientName.replace(/[（(][^）)]*[）)]/g, '').trim(), amount, unit);
    }
  }
  return { supplements: [...accs.values()].map(finish), skipped };
}

/** 栄養素に当たらなかった成分を名前ごとにまとめる（「ビフィズス菌」が 2 行あれば量を足す） */
function addOther(acc: Acc, name: string, amount: number, unit: string): void {
  const i = acc.others.findIndex((o) => o.name === name && o.unit === unit);
  if (i >= 0) acc.others[i] = { ...acc.others[i], amount: acc.others[i].amount + amount };
  else acc.others.push({ name, amount, unit });
}

/** 1 行 = 1 商品。成分ごとの列 */
function fromWide(header: string[], rows: string[][], cols: Partial<Record<Column, number>>): ImportResult {
  const fixed = new Set(Object.values(cols).filter((i): i is number => i !== undefined));
  const nutrientCols = header
    .map((h, i) => ({ i, ...splitHeader(h) }))
    .filter((c) => !fixed.has(c.i) && c.label);
  let skipped = 0;
  const supplements: ImportedSupplement[] = [];
  for (const r of rows) {
    const name = cols.name !== undefined ? r[cols.name] ?? '' : '';
    if (!name) { skipped++; continue; }
    const acc = newAcc(name);
    const serving = cols.perUnit !== undefined ? parseServing(r[cols.perUnit] ?? '') : null;
    const daily = cols.perDay !== undefined ? parseServing(r[cols.perDay] ?? '') : null;
    const unitCol = cols.unit !== undefined ? r[cols.unit] ?? '' : '';
    if (serving && serving.count > 0) { acc.perUnit = serving.count; acc.unit = serving.unit; }
    if (daily && daily.count > 0) { acc.perDay = daily.count; acc.unit = acc.unit || daily.unit; }
    else if (serving && serving.count > 0) acc.perDay = serving.count;
    acc.unit = acc.unit || unitCol;
    if (cols.note !== undefined && r[cols.note]) acc.notes.push(r[cols.note]);
    for (const c of nutrientCols) {
      const raw = (r[c.i] ?? '').normalize('NFKC');
      if (!raw) continue;
      // 「12mg」のように値に単位が付いていれば、それを使う
      const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Zµμ]+)?$/);
      const amount = m ? Number(m[1]) : parseFloat(raw.replace(/,/g, ''));
      if (!Number.isFinite(amount)) continue;
      const mapped = mapNutrient(c.label, amount, m?.[2] ?? c.unit);
      if (mapped) acc.nutrients[mapped.key] = (acc.nutrients[mapped.key] ?? 0) + mapped.value;
      else addOther(acc, c.label, amount, m?.[2] ?? c.unit);
    }
    supplements.push(finish(acc));
  }
  return { supplements, skipped };
}

function trimNumber(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** 画面に出す要約（栄養素の数と当たらなかった成分） */
export function describeImported(s: ImportedSupplement): string {
  const got = NUTRIENTS.filter((n) => s.nutrients[n.key] !== null).map((n) => n.label);
  return [
    `1 日 ${s.perDay} ${s.unit}`,
    got.length > 0 ? `${got.length} 項目: ${got.slice(0, 6).join('・')}${got.length > 6 ? ' …' : ''}` : '栄養素なし',
    s.others.length > 0 ? `対象外: ${s.others.map((o) => o.split(' ')[0]).join('・')}` : '',
  ].filter(Boolean).join('\n');
}
