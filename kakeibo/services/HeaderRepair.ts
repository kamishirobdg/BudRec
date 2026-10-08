/**
 * シートの見出し（1 行目）を補う。列を後から足したシート（月次シートの M〜O 列など）は、古いシートの見出しが
 * 足した列の分だけ空のままになる。値は列の位置で読むので動作には関係ないが、見出しの無い列に値が入って
 * 見づらいので、アプリを開いたときに足りない見出しを書く。
 *
 * - 今ある見出しが、正しい見出しの先頭部分と一致するときだけ書く（空の列は不問）。違う内容が入っていたら触らない
 * - 1 回の読み出し（batchGet）で全シートの 1 行目を見る
 */

import { SheetsInternal, HEADER_ROW, ITEMS_HEADER_ROW, USERS_HEADER } from './SheetsService';
import { MEALS_HEADER } from './MealService';
import { FOOD_HEADER, MENU_SHEET } from './FoodService';
import * as Demo from './DemoService';

function expectedHeader(sheet: string): readonly string[] | null {
  if (/^\d{4}-\d{2}$/.test(sheet)) return HEADER_ROW;
  if (/^_items_\d{4}-\d{2}$/.test(sheet)) return ITEMS_HEADER_ROW;
  if (/^_meals_\d{4}-\d{2}$/.test(sheet)) return MEALS_HEADER;
  if (sheet === '_foods' || sheet === MENU_SHEET) return FOOD_HEADER;
  if (sheet === '_users') return USERS_HEADER;
  return null;
}

function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

let done = false;

/** 足りない見出しを書く（アプリを開いたときに 1 回）。直したシートの数を返す。失敗しても投げない */
export async function repairHeaders(): Promise<number> {
  if (done || (await Demo.isDemo())) return 0;
  try {
    const client = await SheetsInternal.createClient();
    const names = await SheetsInternal.listSheetNames(client, true);
    const targets = names
      .map((sheet) => ({ sheet, header: expectedHeader(sheet) }))
      .filter((t): t is { sheet: string; header: readonly string[] } => t.header !== null);
    if (targets.length === 0) {
      done = true;
      return 0;
    }
    const query = targets
      .map((t) => `ranges=${encodeURIComponent(`'${t.sheet}'!A1:${columnLetter(t.header.length)}1`)}`)
      .join('&');
    const res = await client.get(`/values:batchGet?${query}`);
    const ranges: { values?: string[][] }[] = res.data.valueRanges ?? [];
    const data: { range: string; values: string[][] }[] = [];
    targets.forEach((t, i) => {
      const row = (ranges[i]?.values?.[0] ?? []).map((c) => String(c ?? '').trim());
      // 空のシート（行が 1 つも無い）は、書き込むときに作られるので触らない
      if (row.length === 0) return;
      const complete = t.header.every((h, j) => row[j] === h);
      const compatible = row.every((c, j) => c === '' || c === t.header[j]);
      if (complete || !compatible) return;
      data.push({ range: `'${t.sheet}'!A1:${columnLetter(t.header.length)}1`, values: [[...t.header]] });
    });
    if (data.length > 0) await client.post('/values:batchUpdate', { valueInputOption: 'RAW', data });
    done = true;
    return data.length;
  } catch (e) {
    console.warn('[HeaderRepair] 見出しを補えなかった:', e instanceof Error ? e.message : e);
    return 0;
  }
}
