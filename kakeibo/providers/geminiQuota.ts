/**
 * Gemini の 429（クォータ超過）を分類する。
 *
 * 429 の本文には `google.rpc.QuotaFailure`（どの枠か）と `google.rpc.RetryInfo`（待ち時間）が入る。
 * - 分単位の枠（`...PerMinute...`）: 待ち時間だけ待てば同じモデルで通る
 * - 日単位の枠（`...PerDay...`）  : その日は通らない。リセット後に処理し直す
 *
 * 日単位の枠のリセットは米国太平洋時間の 0 時。RetryInfo に待ち時間があればそちらを優先し、
 * 無いときだけ次の太平洋時間 0 時を計算する（時刻をコードに決め打ちしない）。
 */

import axios from 'axios';

export type QuotaScope = 'minute' | 'day' | 'unknown';

export interface QuotaInfo {
  scope:        QuotaScope;
  /** RetryInfo の待ち時間（ミリ秒）。無ければ null */
  retryDelayMs: number | null;
}

/** 429 なら分類を返す。429 でなければ null */
export function classifyQuotaError(e: unknown): QuotaInfo | null {
  if (!axios.isAxiosError(e) || e.response?.status !== 429) return null;
  const details: any[] = (e.response.data as any)?.error?.details ?? [];

  let scope: QuotaScope = 'unknown';
  let retryDelayMs: number | null = null;
  for (const d of details) {
    const type = String(d?.['@type'] ?? '');
    if (type.endsWith('QuotaFailure')) {
      const ids = (d?.violations ?? []).map((v: any) => String(v?.quotaId ?? '')).join(' ');
      if (/PerDay/i.test(ids)) scope = 'day';
      else if (/PerMinute/i.test(ids) && scope !== 'day') scope = 'minute';
    }
    if (type.endsWith('RetryInfo')) {
      const m = String(d?.retryDelay ?? '').match(/^(\d+(?:\.\d+)?)s$/);
      if (m) retryDelayMs = Math.ceil(Number(m[1]) * 1000);
    }
  }
  return { scope, retryDelayMs };
}

/** 再処理してよい時刻（エポックミリ秒）。全モデルが枠切れだったときに使う */
export function quotaRetryAt(info: QuotaInfo, now: number = Date.now()): number {
  if (info.scope !== 'day') {
    // 分単位（または不明）の枠は待ち時間が短い。待っても通らなかったので少し長めに空ける
    return now + Math.max(info.retryDelayMs ?? 0, 5 * 60_000);
  }
  // 日単位の枠の RetryInfo は短すぎる値が返ることがあるので、10 分未満なら採用しない
  if (info.retryDelayMs !== null && info.retryDelayMs >= 10 * 60_000) return now + info.retryDelayMs;
  return nextPacificMidnight(now) + 5 * 60_000; // リセット直後は避けて 5 分おく
}

/**
 * 次の米国太平洋時間 0 時（エポックミリ秒）。
 * Hermes の Intl のタイムゾーン対応に頼らず、夏時間（3 月第 2 日曜〜11 月第 1 日曜）を自前で判定する。
 */
export function nextPacificMidnight(now: number): number {
  const offsetHours = isPacificDst(now) ? 7 : 8; // UTC からの差（UTC = PT + offset）
  const pt = new Date(now - offsetHours * 3_600_000);
  const nextMidnightUtcAsPt = Date.UTC(pt.getUTCFullYear(), pt.getUTCMonth(), pt.getUTCDate() + 1);
  return nextMidnightUtcAsPt + offsetHours * 3_600_000;
}

function isPacificDst(now: number): boolean {
  const year  = new Date(now).getUTCFullYear();
  // 夏時間の開始: 3 月第 2 日曜 2:00 PST（= 10:00 UTC）、終了: 11 月第 1 日曜 2:00 PDT（= 9:00 UTC）
  const start = Date.UTC(year, 2, nthSunday(year, 2, 2), 10);
  const end   = Date.UTC(year, 10, nthSunday(year, 10, 1), 9);
  return now >= start && now < end;
}

/** その月の第 n 日曜の日付 */
function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}
