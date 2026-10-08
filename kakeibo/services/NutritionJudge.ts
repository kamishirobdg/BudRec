/**
 * 1 日の栄養の判定（不足 / 適正 / 過剰）。仕様は docs/meal-nutrition-spec.md §11。
 *
 * 基準は「日本人の食事摂取基準（2025 年版）」の年齢・性別・身体活動レベルの値（`dri2025.ts`）。
 * 自分で目標を入れた栄養素はそちらを優先する。線引きは一般的な栄養管理アプリに合わせる:
 * - ビタミン・ミネラル・食物繊維など: 推奨量（無ければ目安量・目標量の下限）の 80% 未満で不足。耐容上限量を超えたら過剰
 * - エネルギー: 推定エネルギー必要量の ±10% を適正
 * - たんぱく質・脂質・炭水化物・飽和脂肪酸: エネルギー比が目標量の範囲か（たんぱく質は推奨量の 80% 未満も不足）
 * - 食塩相当量など上限だけのもの: 目標量（未満）を超えたら過剰。不足は出さない
 */

import { DRI_2025, DriValue } from './dri2025';
import { NUTRIENTS, nutrientDef } from './Nutrients';
import type { NutritionPrefs } from './NutritionPrefsService';

export type Judgement = 'low' | 'ok' | 'high' | 'none';

export interface NutrientStatus {
  key:       string;
  label:     string;
  unit:      string;
  /** その日の摂取量（分からなければ null） */
  value:     number | null;
  /** 基準の表示（「65g 以上」「7.5g 未満」「2,480〜3,030kcal」「13〜20%」） */
  standard:  string;
  judgement: Judgement;
  /** 基準に対する割合（棒の長さに使う。基準が無ければ null） */
  ratio:     number | null;
  /** エネルギー比で判定した栄養素のエネルギー比（%） */
  percent?:  number;
  /** グラフに描く値（エネルギー比で判定するものは %）と、その単位 */
  plot:      number | null;
  plotUnit:  string;
  /** グラフに重ねる適正の帯（plot と同じ単位。上限が無ければ bandHigh は無し） */
  bandLow?:  number;
  bandHigh?: number;
}

/** 年齢区分（食事摂取基準の成人の区分） */
export function ageGroup(birthYear: number, now: Date = new Date()): string {
  const age = now.getFullYear() - birthYear;
  if (age < 30) return '18-29';
  if (age < 50) return '30-49';
  if (age < 65) return '50-64';
  if (age < 75) return '65-74';
  return '75-';
}

/** エネルギー比で判定する栄養素（1g あたりの kcal） */
const ENERGY_RATIO: Record<string, number> = { 'PROT-': 4, 'FAT-': 9, 'CHOCDF-': 4, FASAT: 9 };
/** 上限だけで判定する栄養素（自分の目標も上限として扱う） */
const UPPER_ONLY = new Set(['NACL_EQ', 'FASAT', 'CHOLE', 'NA']);
/** 判定しない（食塩相当量で見る） */
const SKIP = new Set(['NA']);

const LOW_RATIO = 0.8;

function fmt(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString('ja-JP') : String(Math.round(n * 10) / 10);
}

function driFor(key: string, prefs: NutritionPrefs, now: Date): DriValue | undefined {
  const { birthYear, sex, activity } = prefs.profile;
  if (!birthYear || !sex) return undefined;
  const table = DRI_2025[key];
  if (!table) return undefined;
  const group = ageGroup(birthYear, now);
  // 75 歳以上の「高い」は表に無いので「ふつう」に寄せる
  return key === 'ENERC_KCAL'
    ? table[`${sex}|${group}|${activity}`] ?? table[`${sex}|${group}|II`]
    : table[`${sex}|${group}`];
}

function judgeOne(key: string, value: number | null, kcal: number | null, prefs: NutritionPrefs, now: Date): NutrientStatus {
  const def = nutrientDef(key)!;
  const base: NutrientStatus = {
    key, label: def.label, unit: def.unit, value, standard: '', judgement: 'none', ratio: null,
    plot: value, plotUnit: def.unit,
  };
  if (SKIP.has(key)) return base;
  const dri = driFor(key, prefs, now);
  const target = prefs.targets[key];
  /** 量で判定する（low 未満で不足・high 超えで過剰。ratio は ratioBase に対する割合） */
  const byAmount = (standard: string, low: number | undefined, high: number | undefined, ratioBase: number,
    opts: { highInclusive?: boolean; bandLow?: number } = {}): NutrientStatus => {
    const band = { bandLow: opts.bandLow ?? low ?? 0, bandHigh: high };
    if (value === null) return { ...base, standard, ...band };
    const over = high !== undefined && (opts.highInclusive ? value >= high : value > high);
    const judgement: Judgement = low !== undefined && value < low ? 'low' : over ? 'high' : 'ok';
    return { ...base, standard, judgement, ratio: value / ratioBase, ...band };
  };
  /** エネルギー比で判定する */
  const byPercent = (standard: string, low: number | undefined, high: number, ratioKcal: number, extraLow = false): NutrientStatus => {
    const band = { bandLow: low ?? 0, bandHigh: high, plotUnit: '%' };
    if (value === null || !kcal) {
      // エネルギーが分からなくても、量で不足と分かるもの（たんぱく質の推奨量）は不足にする
      return { ...base, standard, ...band, plot: null, judgement: extraLow ? 'low' : 'none' };
    }
    const percent = (value * ratioKcal / kcal) * 100;
    const judgement: Judgement = (low !== undefined && percent < low) || extraLow ? 'low' : percent > high ? 'high' : 'ok';
    return { ...base, standard, percent, judgement, ratio: percent / high, plot: percent, ...band };
  };

  // エネルギー: 推定エネルギー必要量（または自分の目標）の ±10%
  if (key === 'ENERC_KCAL') {
    const center = target ?? dri?.EAR;
    if (!center) return base;
    return byAmount(`${fmt(center * 0.9)}〜${fmt(center * 1.1)}kcal`, center * 0.9, center * 1.1, center);
  }

  // 上限だけのもの（食塩・飽和脂肪酸など）。自分の目標は上限として使う
  if (UPPER_ONLY.has(key)) {
    const ratioKcal = ENERGY_RATIO[key];
    if (target) return byAmount(`${fmt(target)}${def.unit} 以下`, undefined, target, target);
    if (ratioKcal && dri?.DG_HIGH !== undefined) return byPercent(`エネルギーの ${fmt(dri.DG_HIGH)}% 以下`, undefined, dri.DG_HIGH, ratioKcal);
    if (dri?.DG_HIGH !== undefined) {
      return byAmount(`${fmt(dri.DG_HIGH)}${def.unit} 未満`, undefined, dri.DG_HIGH, dri.DG_HIGH, { highInclusive: true });
    }
    return base;
  }

  // 自分の目標がある: その 80% 未満で不足（上限は食事摂取基準の耐容上限量）
  if (target) return byAmount(`${fmt(target)}${def.unit} 以上`, target * LOW_RATIO, dri?.UL, target);

  // たんぱく質・脂質・炭水化物: エネルギー比が目標量の範囲か（たんぱく質は推奨量の 80% 未満も不足）
  const ratioKcal = ENERGY_RATIO[key];
  if (ratioKcal && dri?.dgUnit === '%E' && dri.DG_LOW !== undefined && dri.DG_HIGH !== undefined) {
    const lowByAmount = value !== null && dri.RDA !== undefined && value < dri.RDA * LOW_RATIO;
    return byPercent(`エネルギーの ${fmt(dri.DG_LOW)}〜${fmt(dri.DG_HIGH)}%`, dri.DG_LOW, dri.DG_HIGH, ratioKcal, lowByAmount);
  }

  // そのほか: 推奨量 → 目安量 → 目標量の下限。上限は耐容上限量 → 目標量の上限
  if (!dri) return base;
  const lower = dri.RDA ?? dri.AI ?? (dri.dgUnit === def.unit ? dri.DG_LOW : undefined);
  const upper = dri.UL ?? (dri.dgUnit === def.unit ? dri.DG_HIGH : undefined);
  if (lower === undefined && upper === undefined) return base;
  const standard = lower !== undefined
    ? `${fmt(lower)}${def.unit} 以上${upper !== undefined ? `（上限 ${fmt(upper)}）` : ''}`
    : `${fmt(upper!)}${def.unit} 以下`;
  return byAmount(standard, lower !== undefined ? lower * LOW_RATIO : undefined, upper, lower ?? upper!);
}

/** その日の合計を判定する。表示する栄養素（設定の visible）を先に、ほかを後に並べる */
export function judgeDay(totals: Record<string, number | null>, prefs: NutritionPrefs, now: Date = new Date()): NutrientStatus[] {
  const kcal = totals['ENERC_KCAL'] ?? null;
  const order = [...prefs.visible, ...NUTRIENTS.map((n) => n.key).filter((k) => !prefs.visible.includes(k))];
  return order
    .filter((k) => nutrientDef(k) && !SKIP.has(k))
    .map((k) => judgeOne(k, totals[k] ?? null, kcal, prefs, now));
}

/** プロフィールが入っているか（入っていなければ、自分の目標の分しか判定できない） */
export function hasProfile(prefs: NutritionPrefs): boolean {
  return !!prefs.profile.birthYear && !!prefs.profile.sex;
}

/**
 * 食事の日付（朝 4 時で区切る。夜ふかしして食べた分は前の日に入れる）。
 * 'YYYY/MM/DD HH:MM:SS' → 'YYYY-MM-DD'。Hermes で日付文字列を new Date に渡さない
 */
export function dayOf(eatenAt: string): string {
  const m = eatenAt.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}))?/);
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (m[4] !== undefined && +m[4] < 4) d.setDate(d.getDate() - 1);
  return toDay(d);
}

export function toDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今日（朝 4 時まではまだ前の日） */
export function today(now: Date = new Date()): string {
  const d = new Date(now);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  return toDay(d);
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return toDay(new Date(y, m - 1, d + delta));
}
