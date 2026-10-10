/**
 * 食事の改善とサプリの提案（1 週間・1 か月の記録から）。仕様は docs/meal-nutrition-spec.md §11.5。
 *
 * - 集計（栄養素ごとの平均・不足/適正/過剰の日数・サプリの 1 日分・耐容上限量に近い栄養素）はアプリの中で出し、
 *   文章だけ Gemini に書かせる（grounding は使わない。1 回の呼び出し）
 * - 作った提案は `_advice` に残す（両方の端末で見られる。1 か月単位の振り返りにも使う）
 * - 医療の助言ではない旨を添える
 *
 * `_advice`: advice_id | user | period_start | period_end | span | created_at | auto | summary | meals | supplements | caution
 */

import { SheetsInternal, newEntryId } from './SheetsService';
import { nowLabel } from './jsonFileStore';
import { NUTRIENTS, Nutrients, nutrientDef } from './Nutrients';
import { NutrientStatus, ageOf } from './NutritionJudge';
import type { NutritionPrefs } from './NutritionPrefsService';
import type { Supplement } from './SupplementService';
import { callGemini } from '../providers/GeminiProvider';
import { parseJson } from '../providers/AIProvider';
import * as Demo from './DemoService';

const SHEET = '_advice';
const HEADER = ['advice_id', 'user', 'period_start', 'period_end', 'span', 'created_at', 'auto', 'summary', 'meals', 'supplements', 'caution'];
const RANGE = 'A:K';

/** 提案を作るのに要る、記録のある日数 */
export const MIN_RECORDED_DAYS = 7;
/** サプリの 1 日分がこの割合を超えたら「上限に近い」と伝える */
const NEAR_UPPER = 0.8;

export type SupplementAction = 'add' | 'stop' | 'reduce' | 'continue';

export interface SupplementAdvice {
  name:   string;
  action: SupplementAction;
  reason: string;
}

export interface Advice {
  adviceId:    string;
  user:        string;
  /** 'YYYY-MM-DD' */
  periodStart: string;
  periodEnd:   string;
  span:        7 | 30;
  createdAt:   string;
  /** 週の切り替わりに自動で作ったもの */
  auto:        boolean;
  summary:     string;
  meals:       string[];
  supplements: SupplementAdvice[];
  caution:     string;
  rowIndex:    number;
}

export const ADVICE_DISCLAIMER = '記録からの目安です。医療の助言ではありません';

function parseJsonCell<T>(cell: unknown, fallback: T): T {
  try {
    return (JSON.parse(String(cell ?? '')) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function loadAdvice(): Promise<Advice[]> {
  if (await Demo.isDemo()) return [];
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  if (!names.includes(SHEET)) return [];
  const res = await client.get(`/values/${encodeURIComponent(SHEET)}!${RANGE}`);
  const out: Advice[] = [];
  ((res.data.values ?? []) as string[][]).forEach((c, i) => {
    if (i === 0 || !c[0]) return;
    out.push({
      adviceId: c[0], user: c[1] ?? '', periodStart: c[2] ?? '', periodEnd: c[3] ?? '', span: Number(c[4]) === 30 ? 30 : 7,
      createdAt: c[5] ?? '', auto: String(c[6]).toUpperCase() === 'TRUE', summary: c[7] ?? '',
      meals: parseJsonCell<string[]>(c[8], []), supplements: parseJsonCell<SupplementAdvice[]>(c[9], []), caution: c[10] ?? '',
      rowIndex: i + 1,
    });
  });
  return out;
}

async function saveAdvice(a: Omit<Advice, 'adviceId' | 'rowIndex' | 'createdAt'>): Promise<Advice> {
  const row: Advice = { ...a, adviceId: newEntryId(), createdAt: nowLabel(), rowIndex: 0 };
  if (await Demo.isDemo()) return row;
  const client = await SheetsInternal.createClient();
  if (await SheetsInternal.ensureSheet(client, SHEET)) {
    await SheetsInternal.writeHeaderRow(client, SHEET, HEADER);
  }
  await client.post(
    `/values/${encodeURIComponent(SHEET)}!${RANGE}:append`,
    { values: [[
      row.adviceId, row.user, row.periodStart, row.periodEnd, row.span, row.createdAt, row.auto ? 'TRUE' : 'FALSE',
      row.summary, JSON.stringify(row.meals), JSON.stringify(row.supplements), row.caution,
    ]] },
    { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
  );
  return row;
}

/** その人のその期間（7 / 30）の最新の提案 */
export function latestAdvice(list: Advice[], user: string, span: 7 | 30): Advice | null {
  const mine = list.filter((a) => a.user === user && a.span === span);
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (a.periodEnd > b.periodEnd || (a.periodEnd === b.periodEnd && a.createdAt > b.createdAt) ? a : b));
}

// ─── 集計 ─────────────────────────────────────────────────────────────────────

export interface DayJudgement {
  day:      string;
  /** 記録の無い日は null */
  statuses: NutrientStatus[] | null;
}

export interface AdviceInput {
  user:        string;
  prefs:       NutritionPrefs;
  days:        DayJudgement[];
  /** 期間中に飲んでいたサプリと、飲まなかった日数 */
  supplements: { supplement: Supplement; skippedDays: number }[];
}

function fmt(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString('ja-JP') : String(Math.round(n * 10) / 10);
}

/** サプリの 1 日分が耐容上限量（上限の帯）の 80% を超える栄養素 */
export function nearUpperFromSupplements(input: AdviceInput): { key: string; ratio: number }[] {
  const daily: Nutrients = {};
  for (const { supplement } of input.supplements) {
    for (const [k, v] of Object.entries(supplement.nutrients)) {
      if (v !== null) daily[k] = (daily[k] ?? 0) + v * supplement.perDay;
    }
  }
  const out: { key: string; ratio: number }[] = [];
  for (const [k, v] of Object.entries(daily)) {
    if (v === null || v <= 0) continue;
    const upper = input.days.find((d) => d.statuses)?.statuses?.find((s) => s.key === k)?.bandHigh;
    if (upper && v / upper >= NEAR_UPPER) out.push({ key: k, ratio: v / upper });
  }
  return out;
}

/** 提案の材料（Gemini に渡す文章）。記録のある日だけで集計する */
export function buildFacts(input: AdviceInput): string {
  const recorded = input.days.filter((d) => d.statuses);
  const lines: string[] = [];
  const { birthDate, sex, activity } = input.prefs.profile;
  const first = input.days[0]?.day ?? '';
  const last = input.days[input.days.length - 1]?.day ?? '';
  lines.push(`期間: ${first}〜${last}（食事の記録がある日 ${recorded.length} 日）`);
  if (birthDate && sex) {
    const level = activity === 'I' ? '低い' : activity === 'III' ? '高い' : 'ふつう';
    lines.push(`本人: ${sex === 'male' ? '男性' : '女性'} ${ageOf(birthDate)} 歳・身体活動レベル ${level}`);
  }
  lines.push('', '栄養素ごと（1 日平均 / 基準 / 不足・適正・過剰の日数）:');
  for (const n of NUTRIENTS) {
    const list = recorded.map((d) => d.statuses!.find((s) => s.key === n.key)).filter((s): s is NutrientStatus => !!s && s.value !== null);
    if (list.length === 0 || !list[0].standard) continue;
    const avg = list.reduce((a, s) => a + (s.value ?? 0), 0) / list.length;
    const count = (j: NutrientStatus['judgement']) => list.filter((s) => s.judgement === j).length;
    const percent = list.some((s) => s.percent !== undefined)
      ? `（エネルギー比 平均 ${fmt(list.reduce((a, s) => a + (s.percent ?? 0), 0) / list.length)}%）`
      : '';
    lines.push(`- ${n.label}: 平均 ${fmt(avg)}${n.unit}${percent} / 基準 ${list[0].standard} / 不足 ${count('low')}・適正 ${count('ok')}・過剰 ${count('high')}`);
  }
  lines.push('', input.supplements.length > 0 ? 'いま飲んでいるサプリ（1 日分の栄養）:' : 'いま飲んでいるサプリ: なし');
  for (const { supplement, skippedDays } of input.supplements) {
    const parts = Object.entries(supplement.nutrients)
      .filter(([, v]) => v !== null && v > 0)
      .map(([k, v]) => `${nutrientDef(k)?.label ?? k} ${fmt(v! * supplement.perDay)}${nutrientDef(k)?.unit ?? ''}`);
    const note = supplement.note ? `。${supplement.note.split('\n')[0]}` : '';
    lines.push(`- ${supplement.name}（1 日 ${supplement.perDay} ${supplement.unit}）: ${parts.join('、') || '栄養素の登録なし'}${note}` +
      (skippedDays > 0 ? `。飲まなかった日 ${skippedDays}` : ''));
  }
  const near = nearUpperFromSupplements(input);
  lines.push('', `サプリだけで耐容上限量の 80% を超える栄養素: ${near.length > 0
    ? near.map((x) => `${nutrientDef(x.key)?.label ?? x.key}（上限の ${Math.round(x.ratio * 100)}%）`).join('、')
    : 'なし'}`);
  return lines.join('\n');
}

// ─── 提案を作る ───────────────────────────────────────────────────────────────

const ADVICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    meals:   { type: 'ARRAY', items: { type: 'STRING' } },
    supplements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name:   { type: 'STRING' },
          action: { type: 'STRING', enum: ['add', 'stop', 'reduce', 'continue'] },
          reason: { type: 'STRING' },
        },
        required: ['name', 'action', 'reason'],
      },
    },
    caution: { type: 'STRING' },
  },
  required: ['summary', 'meals', 'supplements'],
};

/**
 * 期間の記録から提案を作って `_advice` に残す。記録のある日が足りなければ null。
 * QuotaExceededError などはそのまま投げる（画面で知らせる）。
 */
export async function generateAdvice(input: AdviceInput, span: 7 | 30, auto: boolean): Promise<Advice | null> {
  const recorded = input.days.filter((d) => d.statuses).length;
  if (recorded < MIN_RECORDED_DAYS || input.days.length === 0) return null;
  const facts = buildFacts(input);
  const prompt = `あなたは栄養管理アプリのアシスタントです。次の${span === 7 ? '1 週間' : '1 か月'}の記録から、食事の改善とサプリの提案を日本語で書き、JSON のみを返してください。
- summary: 期間の傾向を 2 文以内で（よかった点と直したい点）
- meals: 食事の改善を 3〜5 個。「不足」が続く栄養素を日本の食材・料理で、買い物・外食・コンビニで実行しやすい形で具体的に（例:「昼のおにぎりに納豆巻きかサラダチキンを足す」）。
  「過剰」が続く栄養素は減らし方を。基準の無い栄養素や 1〜2 日だけの不足は取り上げない
- supplements: いま飲んでいるサプリそれぞれに continue / reduce / stop のどれか（食事で足りている・上限に近い栄養素があれば reduce か stop）。
  食事で補いにくく不足が続く栄養素があれば add（name は栄養素の名前。商品名は書かない）。理由は 1 文
- caution: 耐容上限量に近い栄養素や、医師に相談したほうがよい点があれば 1 文。無ければ空文字
医療上の診断・治療の判断はしない。断定を避け、記録から言えることだけを書く。

${facts}`;
  const raw = await callGemini([{ text: prompt }], { schema: ADVICE_SCHEMA, highRes: false });
  const parsed = parseJson(raw) ?? {};
  const actions: readonly string[] = ['add', 'stop', 'reduce', 'continue'];
  const supplements: SupplementAdvice[] = (Array.isArray(parsed.supplements) ? parsed.supplements : [])
    .map((s: any) => ({
      name: String(s?.name ?? '').trim(),
      action: actions.includes(String(s?.action)) ? (s.action as SupplementAction) : 'continue',
      reason: String(s?.reason ?? '').trim(),
    }))
    .filter((s: SupplementAdvice) => s.name);
  return saveAdvice({
    user: input.user,
    periodStart: input.days[0].day,
    periodEnd: input.days[input.days.length - 1].day,
    span,
    auto,
    summary: String(parsed.summary ?? '').trim(),
    meals: (Array.isArray(parsed.meals) ? parsed.meals : []).map((m: unknown) => String(m).trim()).filter(Boolean),
    supplements,
    caution: String(parsed.caution ?? '').trim(),
  });
}

/** 直前の週（月曜〜日曜）。週の切り替わりの自動作成に使う */
export function lastWeek(todayStr: string): { start: string; end: string } {
  const [y, m, d] = todayStr.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  // 月曜 = 1。今週の月曜まで戻してから 7 日前
  const back = (t.getDay() + 6) % 7;
  const monday = new Date(y, m - 1, d - back - 7);
  const sunday = new Date(y, m - 1, d - back - 1);
  const f = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { start: f(monday), end: f(sunday) };
}
