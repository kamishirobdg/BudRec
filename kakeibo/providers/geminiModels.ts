/**
 * 使える Gemini モデルを実行時に解決する。
 *
 * モデル名をコードに固定すると、そのモデルが提供終了・無料枠 0・リージョン非対応に
 * なった瞬間にアプリが壊れる（実測: `gemini-2.0-flash` はこのキーでは 429 になる）。
 * そこで ListModels で**今そのキーで使えるモデル**を取得し、優先順で選ぶ。
 *
 * - 結果は端末に 24 時間キャッシュする（OCR のたびに一覧を引かない）
 * - 呼び出しが 429 / 404 で落ちたら、そのモデルを除外して選び直す
 */

import axios from 'axios';
import { getItem, setItem } from '../services/Storage';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const CACHE_KEY    = 'gemini_model_cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 優先順に試すモデル。
 * 先頭 2 つは Google 側が中身を差し替え続けるエイリアスなので、
 * 世代交代しても勝手に追従する（＝ここを更新し忘れても壊れにくい）。
 */
export const PREFERRED_MODELS: readonly string[] = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

/** 最後の頼み。一覧が引けないときだけ使う */
const LAST_RESORT_MODEL = PREFERRED_MODELS[0];

/** レシート OCR に使えない（またはコストが見合わない）モデルを弾く */
function isUsableForOcr(name: string): boolean {
  if (!/^gemini-/.test(name)) return false; // gemma / lyria / nano-banana など
  return !/(image|tts|audio|embedding|robotics|computer-use|deep-research|omni)/i.test(name);
}

/** 汎用フォールバック時の優先度。小さいほど優先 */
function fallbackRank(name: string): number {
  if (/flash-lite/.test(name)) return 0; // 安い・速い・無料枠がある傾向
  if (/flash/.test(name))      return 1;
  if (/pro/.test(name))        return 2;
  return 3;
}

interface ModelCache {
  model: string;
  at:    number;
}

async function readCache(): Promise<ModelCache | null> {
  try {
    const raw = await getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelCache;
    if (typeof parsed?.model !== 'string' || typeof parsed?.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(model: string): Promise<void> {
  try {
    await setItem(CACHE_KEY, JSON.stringify({ model, at: Date.now() } satisfies ModelCache));
  } catch {
    // キャッシュできなくても動作には影響しない
  }
}

export async function invalidateModelCache(): Promise<void> {
  try {
    await setItem(CACHE_KEY, '');
  } catch {
    // ignore
  }
}

/** そのキーで generateContent が使えるモデル名の一覧 */
export async function listAvailableModels(apiKey: string): Promise<string[]> {
  const res = await axios.get(`${API_BASE}/models`, {
    params: { key: apiKey, pageSize: 200 },
    timeout: 15_000,
  });
  const models: { name?: string; supportedGenerationMethods?: string[] }[] =
    res.data?.models ?? [];
  return models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter((n) => n.length > 0);
}

/**
 * 今使うべきモデル名を返す。
 * @param exclude 直前に失敗したモデル（429 など）。候補から外す
 * @param force   true ならキャッシュを無視して一覧を引き直す
 */
export async function resolveModel(
  apiKey: string,
  opts: { exclude?: string[]; force?: boolean } = {},
): Promise<string> {
  const exclude = new Set(opts.exclude ?? []);

  if (!opts.force) {
    const cached = await readCache();
    if (
      cached &&
      cached.model &&
      !exclude.has(cached.model) &&
      Date.now() - cached.at < CACHE_TTL_MS
    ) {
      return cached.model;
    }
  }

  let available: string[];
  try {
    available = await listAvailableModels(apiKey);
  } catch (e) {
    // 一覧が引けなくても OCR 自体は試させる（古いキャッシュ → 既定値の順）
    console.warn('[Gemini] モデル一覧の取得に失敗、既定値にフォールバック', e);
    const cached = await readCache();
    if (cached?.model && !exclude.has(cached.model)) return cached.model;
    const fallback = PREFERRED_MODELS.find((m) => !exclude.has(m));
    return fallback ?? LAST_RESORT_MODEL;
  }

  const availableSet = new Set(available);

  // 1) 優先リストのうち、実際に使えるもの
  const preferred = PREFERRED_MODELS.find((m) => availableSet.has(m) && !exclude.has(m));
  if (preferred) {
    await writeCache(preferred);
    return preferred;
  }

  // 2) 優先リストが全滅しても、一覧から使えそうなものを拾う（世代交代への保険）
  // 同じ種別なら名前の降順＝新しい世代を先に試す（古い世代は無料枠が枯れている傾向）
  const picked = available
    .filter((m) => isUsableForOcr(m) && !exclude.has(m))
    .sort((a, b) => fallbackRank(a) - fallbackRank(b) || b.localeCompare(a))[0];

  if (picked) {
    console.log('[Gemini] 優先モデルが使えないため自動選択:', picked);
    await writeCache(picked);
    return picked;
  }

  throw new Error('利用可能な Gemini モデルが見つかりませんでした');
}

/** そのエラーは「別のモデルなら通るかもしれない」種類か */
export function shouldTryAnotherModel(e: unknown): boolean {
  const status = axios.isAxiosError(e) ? e.response?.status : undefined;
  if (status === 429 || status === 404) return true; // 無料枠切れ / モデルが無い
  if (status === 400) {
    const msg = String(
      (axios.isAxiosError(e) ? (e.response?.data as any)?.error?.message : '') ?? '',
    ).toLowerCase();
    return msg.includes('not found') || msg.includes('not supported');
  }
  return false;
}
