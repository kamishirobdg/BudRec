/**
 * サプリ。登録したサプリの 1 日分を、毎日の栄養の合計に自動で足す（飲まなかった日だけ外せる）。
 * 仕様は docs/meal-nutrition-spec.md §11。
 *
 * `_supplements`:      supplement_id | user | name | unit | nutrients（1 単位あたり）| per_day | started | ended | note | updated_at
 * `_supplement_skips`: user | date（YYYY-MM-DD）| supplement_id
 *
 * started〜ended（空なら今も飲んでいる）の日に、per_day 単位分を足す。登録より前の日には足さない。
 */

import { SheetsInternal, newEntryId } from './SheetsService';
import { nowLabel } from './jsonFileStore';
import { NUTRIENTS, Nutrients, sanitizeNutrients, scaleNutrients } from './Nutrients';
import { callGemini } from '../providers/GeminiProvider';
import { parseJson } from '../providers/AIProvider';
import { shiftDay, today } from './NutritionJudge';
import * as Demo from './DemoService';

const SHEET = '_supplements';
const HEADER = ['supplement_id', 'user', 'name', 'unit', 'nutrients', 'per_day', 'started', 'ended', 'note', 'updated_at'];
const SKIP_SHEET = '_supplement_skips';
const SKIP_HEADER = ['user', 'date', 'supplement_id'];

export interface Supplement {
  supplementId: string;
  user:         string;
  name:         string;
  /** 「粒」「包」「錠」など */
  unit:         string;
  /** 1 単位あたり */
  nutrients:    Nutrients;
  perDay:       number;
  /** 'YYYY-MM-DD' */
  started:      string;
  /** 'YYYY-MM-DD'（空なら今も飲んでいる） */
  ended:        string;
  note:         string;
  rowIndex:     number;
}

export interface SupplementSkip {
  user:         string;
  date:         string;
  supplementId: string;
  rowIndex:     number;
}

function toCells(s: Supplement): (string | number)[] {
  return [s.supplementId, s.user, s.name, s.unit, JSON.stringify(s.nutrients), s.perDay, s.started, s.ended, s.note, nowLabel()];
}

export async function loadSupplements(): Promise<{ supplements: Supplement[]; skips: SupplementSkip[] }> {
  if (await Demo.isDemo()) return { supplements: [], skips: [] };
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  const supplements: Supplement[] = [];
  const skips: SupplementSkip[] = [];
  if (names.includes(SHEET)) {
    const res = await client.get(`/values/${encodeURIComponent(SHEET)}!A:J`);
    ((res.data.values ?? []) as string[][]).forEach((c, i) => {
      if (i === 0 || !c[0]) return;
      let nutrients: Nutrients = sanitizeNutrients({});
      try { nutrients = sanitizeNutrients(JSON.parse(c[4] ?? '{}')); } catch { /* 壊れていたら空 */ }
      supplements.push({
        supplementId: c[0], user: c[1] ?? '', name: c[2] ?? '', unit: c[3] ?? '', nutrients,
        perDay: Number(c[5]) > 0 ? Number(c[5]) : 1, started: c[6] ?? '', ended: c[7] ?? '', note: c[8] ?? '', rowIndex: i + 1,
      });
    });
  }
  if (names.includes(SKIP_SHEET)) {
    const res = await client.get(`/values/${encodeURIComponent(SKIP_SHEET)}!A:C`);
    ((res.data.values ?? []) as string[][]).forEach((c, i) => {
      if (i === 0 || !c[0] || !c[2]) return;
      skips.push({ user: c[0], date: c[1] ?? '', supplementId: c[2], rowIndex: i + 1 });
    });
  }
  return { supplements, skips };
}

/** 登録・変更する */
export async function saveSupplement(s: Omit<Supplement, 'supplementId' | 'rowIndex'> & { supplementId?: string; rowIndex?: number }): Promise<void> {
  if (await Demo.isDemo()) return;
  const client = await SheetsInternal.createClient();
  if (await SheetsInternal.ensureSheet(client, SHEET)) {
    await SheetsInternal.writeHeaderRow(client, SHEET, HEADER);
  }
  const row: Supplement = { ...s, supplementId: s.supplementId || newEntryId(), rowIndex: s.rowIndex ?? 0 };
  if (row.rowIndex > 0) {
    await client.put(
      `/values/${encodeURIComponent(SHEET)}!A${row.rowIndex}:J${row.rowIndex}`,
      { values: [toCells(row)] },
      { params: { valueInputOption: 'RAW' } },
    );
  } else {
    await client.post(
      `/values/${encodeURIComponent(SHEET)}!A:J:append`,
      { values: [toCells(row)] },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
  }
}

/** やめる（それまでの日の記録には足したまま残す） */
export async function stopSupplement(s: Supplement): Promise<void> {
  await saveSupplement({ ...s, ended: today() });
}

/** その日に飲まなかった・飲んだに切り替える */
export async function setSkipped(user: string, date: string, supplementId: string, skipped: boolean): Promise<void> {
  if (await Demo.isDemo()) return;
  const client = await SheetsInternal.createClient();
  if (skipped) {
    if (await SheetsInternal.ensureSheet(client, SKIP_SHEET)) {
      await SheetsInternal.writeHeaderRow(client, SKIP_SHEET, SKIP_HEADER);
    }
    await client.post(
      `/values/${encodeURIComponent(SKIP_SHEET)}!A:C:append`,
      { values: [[user, date, supplementId]] },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
    return;
  }
  // 飲んだに戻す: その日の印を全部消す（行は残して中身を空にする。行番号をずらさない）。
  // 画面の内容（端末の控えのこともある）の行番号は古いことがあるので、シートを読み直して中身で探す
  const names = await SheetsInternal.listSheetNames(client, true);
  if (!names.includes(SKIP_SHEET)) return;
  const res = await client.get(`/values/${encodeURIComponent(SKIP_SHEET)}!A:C`);
  const rows = ((res.data.values ?? []) as string[][])
    .map((c, i) => ({ c, rowIndex: i + 1 }))
    .filter(({ c, rowIndex }) => rowIndex > 1 && c[0] === user && c[1] === date && c[2] === supplementId);
  if (rows.length === 0) return;
  await client.post('/values:batchUpdate', {
    valueInputOption: 'RAW',
    data: rows.map((k) => ({ range: `'${SKIP_SHEET}'!A${k.rowIndex}:C${k.rowIndex}`, values: [['', '', '']] })),
  });
}

/**
 * CSV から読んだサプリをまとめて登録する。同じ名前のサプリが既にあれば置き換える
 * （量・成分が変わっていれば、昨日までは前の内容のまま残して今日から新しい内容にする。同じなら触らない）。
 * 戻り値は 登録した数・変えた数・同じだった数
 */
export async function importSupplements(
  user: string,
  list: { name: string; unit: string; perDay: number; nutrients: Nutrients; note: string }[],
  existing: Supplement[],
): Promise<{ added: number; updated: number; same: number }> {
  let added = 0, updated = 0, same = 0;
  const day = today();
  for (const s of list) {
    const nutrients = sanitizeNutrients(s.nutrients);
    const base = existing.find((e) => e.user === user && e.name === s.name && (!e.ended || e.ended >= day));
    if (!base) {
      await saveSupplement({ user, name: s.name, unit: s.unit, perDay: s.perDay, nutrients, started: day, ended: '', note: s.note });
      added++;
      continue;
    }
    const changed = base.perDay !== s.perDay || base.unit !== s.unit ||
      JSON.stringify(sanitizeNutrients(base.nutrients)) !== JSON.stringify(nutrients);
    if (!changed) { same++; continue; }
    if (base.started < day) {
      await saveSupplement({ ...base, ended: shiftDay(day, -1) });
      await saveSupplement({ user, name: s.name, unit: s.unit, perDay: s.perDay, nutrients, started: day, ended: '', note: s.note || base.note });
    } else {
      await saveSupplement({ ...base, unit: s.unit, perDay: s.perDay, nutrients, note: s.note || base.note });
    }
    updated++;
  }
  return { added, updated, same };
}

/** その日に足すサプリ（飲まなかった日の印が付いているものは skipped） */
export function supplementsOn(
  user: string, date: string, supplements: Supplement[], skips: SupplementSkip[],
): { supplement: Supplement; skipped: boolean }[] {
  return supplements
    .filter((s) => s.user === user && s.started && s.started <= date && (!s.ended || date <= s.ended))
    .map((supplement) => ({
      supplement,
      skipped: skips.some((k) => k.user === user && k.date === date && k.supplementId === supplement.supplementId),
    }));
}

/** その日にサプリから取った栄養 */
export function supplementNutrients(list: { supplement: Supplement; skipped: boolean }[]): Nutrients[] {
  return list.filter((x) => !x.skipped).map((x) => scaleNutrients(x.supplement.nutrients, x.supplement.perDay));
}

// ─── ラベルを読む ─────────────────────────────────────────────────────────────

const LABEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name:      { type: 'STRING' },
    unit:      { type: 'STRING' },
    perDay:    { type: 'NUMBER' },
    perUnit:   { type: 'NUMBER' },
    nutrients: {
      type: 'OBJECT',
      properties: Object.fromEntries(NUTRIENTS.map((n) => [n.key, { type: 'NUMBER' }])),
    },
  },
  required: ['name', 'unit', 'nutrients'],
};

/**
 * サプリのパッケージ（栄養成分表示）の写真から、商品名・1 日の目安量・1 単位（1 粒など）あたりの栄養を読む。
 * 表示が「1 日 3 粒あたり」なら、3 で割って 1 粒あたりにする。
 */
export async function readSupplementLabel(imageBase64: string): Promise<{ name: string; unit: string; perDay: number; nutrients: Nutrients }> {
  const list = NUTRIENTS.map((n) => `${n.key}（${n.label}・${n.unit}）`).join(', ');
  const prompt = `サプリメントのパッケージの写真です。栄養成分表示を読み、JSON のみを返してください。
- name: 商品名
- unit: 数える単位（粒・錠・包・本など）
- perDay: 1 日の目安量（単位の数。書いていなければ 1）
- perUnit: 栄養成分表示が何単位あたりか（「1 日 3 粒（900mg）あたり」なら 3）
- nutrients: 表示されている栄養成分を perUnit 単位あたりの値のまま。キーは次のとおりで、表示に無いものは省く:
${list}
単位が違うもの（ビタミン A の IU、ビタミン E の α-トコフェロール以外など）は上の単位に直す。直せなければ省く。`;
  const raw = await callGemini(
    [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }],
    { schema: LABEL_SCHEMA, highRes: true },
  );
  const parsed = parseJson(raw) ?? {};
  const perUnit = Number(parsed.perUnit) > 0 ? Number(parsed.perUnit) : 1;
  return {
    name: String(parsed.name ?? '').trim(),
    unit: String(parsed.unit ?? '粒').trim() || '粒',
    perDay: Number(parsed.perDay) > 0 ? Number(parsed.perDay) : 1,
    nutrients: scaleNutrients(sanitizeNutrients(parsed.nutrients), 1 / perUnit),
  };
}
