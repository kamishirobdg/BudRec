/**
 * 栄養の表示設定（`_nutrition_prefs`）。ユーザーごとに、表示する栄養素と 1 日の目標値を持つ。
 * 両方の端末で同じ設定にするため共有シートに置く。仕様は docs/meal-nutrition-spec.md §3.6。
 *
 * | user | visible（栄養素キーの JSON 配列） | targets（{"ENERC_KCAL": 2000, ...}。任意） |
 * | birth_year | sex（male / female） | activity（I / II / III。身体活動レベル） |
 *
 * 生年・性別・活動レベルから、食事摂取基準の値（年齢区分）を決める（§11）。
 */

import { SheetsInternal } from './SheetsService';
import { DEFAULT_VISIBLE, NUTRIENT_KEYS } from './Nutrients';
import * as Demo from './DemoService';

const SHEET = '_nutrition_prefs';
export const NUTRITION_PREFS_HEADER = ['user', 'visible', 'targets', 'birth_year', 'sex', 'activity'];

export type Sex = 'male' | 'female';
export type Activity = 'I' | 'II' | 'III';

export interface NutritionProfile {
  birthYear: number | null;
  sex:       Sex | null;
  activity:  Activity;
}

export interface NutritionPrefs {
  visible: string[];
  /** 1 日の目標値。設定していない栄養素は持たない */
  targets: Record<string, number>;
  profile: NutritionProfile;
}

export const DEFAULT_PROFILE: NutritionProfile = { birthYear: null, sex: null, activity: 'II' };
export const DEFAULT_PREFS: NutritionPrefs = { visible: [...DEFAULT_VISIBLE], targets: {}, profile: DEFAULT_PROFILE };

function parseProfile(birthYear: unknown, sex: unknown, activity: unknown): NutritionProfile {
  const y = Number(birthYear);
  return {
    birthYear: Number.isInteger(y) && y > 1900 && y < 2100 ? y : null,
    sex: sex === 'male' || sex === 'female' ? sex : null,
    activity: activity === 'I' || activity === 'III' ? activity : 'II',
  };
}

function parse(visible: unknown, targets: unknown, profile: NutritionProfile = DEFAULT_PROFILE): NutritionPrefs {
  let v: string[] = [];
  let t: Record<string, number> = {};
  try {
    const raw = JSON.parse(String(visible ?? ''));
    if (Array.isArray(raw)) v = raw.map(String).filter((k) => NUTRIENT_KEYS.includes(k));
  } catch {
    // 壊れていたら既定
  }
  try {
    const raw = JSON.parse(String(targets ?? ''));
    if (raw && typeof raw === 'object') {
      for (const [k, n] of Object.entries(raw as Record<string, unknown>)) {
        if (NUTRIENT_KEYS.includes(k) && Number(n) > 0) t[k] = Number(n);
      }
    }
  } catch {
    t = {};
  }
  return { visible: v.length > 0 ? v : [...DEFAULT_VISIBLE], targets: t, profile };
}

/** 全員の設定（設定の無い人は既定） */
export async function loadPrefs(): Promise<Map<string, NutritionPrefs>> {
  const out = new Map<string, NutritionPrefs>();
  if (await Demo.isDemo()) return out;
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  if (!names.includes(SHEET)) return out;
  const res = await client.get(`/values/${encodeURIComponent(SHEET)}!A:F`);
  ((res.data.values ?? []) as string[][]).forEach((c, i) => {
    if (i === 0 || !c[0]) return;
    out.set(c[0], parse(c[1], c[2], parseProfile(c[3], c[4], c[5])));
  });
  return out;
}

/** 設定を保存する（その人の行があれば書き換え、無ければ足す） */
export async function savePrefs(user: string, prefs: NutritionPrefs): Promise<void> {
  if (await Demo.isDemo()) return;
  const client = await SheetsInternal.createClient();
  if (await SheetsInternal.ensureSheet(client, SHEET)) {
    await SheetsInternal.writeHeaderRow(client, SHEET, NUTRITION_PREFS_HEADER);
  }
  const res = await client.get(`/values/${encodeURIComponent(SHEET)}!A:A`);
  const rows = (res.data.values ?? []) as string[][];
  // 二台が同時に初めて保存すると同じ人の行が 2 行できうる。読むときは後の行を使うので、書くのも後の行にする
  let index = -1;
  rows.forEach((c, i) => { if (i > 0 && c[0] === user) index = i; });
  const p = prefs.profile;
  const values = [[
    user, JSON.stringify(prefs.visible), JSON.stringify(prefs.targets), p.birthYear ?? '', p.sex ?? '', p.activity,
  ]];
  if (index > 0) {
    await client.put(
      `/values/${encodeURIComponent(SHEET)}!A${index + 1}:F${index + 1}`,
      { values },
      { params: { valueInputOption: 'RAW' } },
    );
  } else {
    await client.post(
      `/values/${encodeURIComponent(SHEET)}!A:F:append`,
      { values },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
  }
}
