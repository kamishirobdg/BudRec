import axios from 'axios';
import {
  AIProvider,
  CancelledError,
  QuotaExceededError,
  EMAIL_RECEIPT_SCHEMA,
  RECEIPT_LIST_SCHEMA,
  ReceiptData,
  buildReceiptPrompt,
  buildEmailPrompt,
  parseReceiptList,
  parseReceiptResponse,
} from './AIProvider';
import { classifyQuotaError, quotaRetryAt } from './geminiQuota';
import {
  invalidateModelCache,
  resolveModel,
  shouldTryAnotherModel,
} from './geminiModels';

// ─── API キー（.env の EXPO_PUBLIC_GEMINI_API_KEY に設定） ──────────────────
// https://aistudio.google.com/apikey で取得し .env に記載
export const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? '';
// ─────────────────────────────────────────────────────────────────────────────

// モデル名は固定しない。ListModels で「今このキーで使えるモデル」を解決する。
// （実測: gemini-2.0-flash はこのキーでは無料枠 0 で 429 になる）
const endpointFor = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export const geminiProvider: AIProvider = {
  name: 'gemini',

  async extractReceipts(
    imageBase64: string,
    categories: string[],
    signal?: AbortSignal,
  ): Promise<ReceiptData[]> {
    const prompt = buildReceiptPrompt(categories);
    const parts = [
      { text: prompt },
      { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
    ];
    const raw = await callGemini(parts, { schema: RECEIPT_LIST_SCHEMA, highRes: true, signal });
    return parseReceiptList(raw, categories);
  },

  async extractEmail(emailText: string, categories: string[]): Promise<ReceiptData> {
    const prompt = buildEmailPrompt(categories);
    const parts = [{ text: `${prompt}\n\n--- メール本文 ---\n${emailText}` }];
    // テキストだけなので解像度指定は要らない
    const raw = await callGemini(parts, { schema: EMAIL_RECEIPT_SCHEMA, highRes: false });
    return parseReceiptResponse(raw, categories);
  },
};

export interface CallOptions {
  /** responseSchema に渡す出力スキーマ。形式崩れと項目欠落を防ぐ（tools と併用しない） */
  schema?:  object;
  /** 画像を高解像度で処理させる（小さい文字・複数レシート対策） */
  highRes:  boolean;
  signal?:  AbortSignal;
  /** Google 検索 grounding（`[{ google_search: {} }]`）。構造化出力と併用できないモデルがあるので schema は付けない */
  tools?:   object[];
}

/**
 * Gemini API 呼び出し共通処理。parts はモデルに渡すコンテンツ配列。
 * 戻り値はモデルの生テキスト（パースは呼び出し側で行う。画像は複数件、メールは 1 件）。
 *
 * 日単位の無料枠を全モデルで使い切ったら QuotaExceededError を投げる（呼び出し側は推定待ちにする）。
 */
export interface GeminiResult {
  text:    string;
  /** grounding で参照したページの URL（grounding を使わなければ空） */
  sources: string[];
}

/** 生テキストだけ欲しい場合 */
export async function callGemini(parts: object[], opts: CallOptions): Promise<string> {
  return (await callGeminiDetailed(parts, opts)).text;
}

export async function callGeminiDetailed(parts: object[], opts: CallOptions): Promise<GeminiResult> {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('YOUR_')) {
    throw new Error('GEMINI_API_KEY が未設定です');
  }

  const { signal } = opts;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  // 高解像度指定に対応しないモデルに当たったら false に落として以降は既定解像度で通す
  let highRes = opts.highRes;

  const send = async (model: string): Promise<GeminiResult> => {
    try {
      return await postToModel(model, parts, opts, highRes, signal);
    } catch (e) {
      if (!highRes || !isUnsupportedConfigError(e)) throw e;
      console.warn(`[Gemini] ${model} は mediaResolution 非対応。既定の解像度で再試行します`);
      highRes = false;
      return postToModel(model, parts, opts, false, signal);
    }
  };

  // 分単位の枠切れは、指定の待ち時間だけ待って同じモデルで 1 回だけ送り直す
  const sendWithMinuteRetry = async (model: string): Promise<GeminiResult> => {
    try {
      return await send(model);
    } catch (e) {
      const q = classifyQuotaError(e);
      if (q?.scope !== 'minute' || (q.retryDelayMs ?? 0) > 60_000) throw e;
      console.warn(`[Gemini] ${model} の分単位の枠切れ。${q.retryDelayMs ?? 10_000}ms 待って再送します`);
      await abortableSleep(q.retryDelayMs ?? 10_000, signal);
      return send(model);
    }
  };

  // 無料枠切れ（429）やモデル消滅（404）のときは、そのモデルを外して選び直す。
  // 世代が古いモデルは無料枠が枯れていることがあるので、最大 3 モデルまで試す。
  const tried: string[] = [];
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    // モデルを乗り換える前に毎回見る。1 モデルあたり最大 60 秒かかるので、
    // ここで見ないとキャンセルしても次のモデルを試し始めてしまう
    throwIfCancelled();

    let model: string;
    try {
      model = await resolveModel(GEMINI_API_KEY, { exclude: tried, force: attempt > 0 });
    } catch (e) {
      throw toReadableError(lastError ?? e);
    }
    if (tried.includes(model)) break; // 候補が尽きた
    tried.push(model);

    try {
      return await sendWithMinuteRetry(model);
    } catch (e) {
      if (isCancellation(e)) throw new CancelledError();
      lastError = e;
      if (!shouldTryAnotherModel(e)) throw toReadableError(e);
      console.warn(`[Gemini] ${model} が使えないため別のモデルを試します`);
      await invalidateModelCache();
    }
  }

  throwIfCancelled();
  // どのモデルも枠切れだった。失敗にせず、枠が戻ってから処理し直してもらう
  const quota = classifyQuotaError(lastError);
  if (quota) {
    toReadableError(lastError); // 本文をログに残す
    throw new QuotaExceededError(quotaRetryAt(quota));
  }
  throw toReadableError(lastError ?? new Error('Gemini の呼び出しに失敗しました'));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CancelledError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new CancelledError()); };
    signal?.addEventListener('abort', onAbort);
  });
}

/** axios の中断か（signal.abort による） */
function isCancellation(e: unknown): boolean {
  return e instanceof CancelledError || axios.isCancel(e);
}

async function postToModel(
  model: string,
  parts: object[],
  opts: CallOptions,
  highRes: boolean,
  signal?: AbortSignal,
): Promise<GeminiResult> {
  const res = await axios.post(
    endpointFor(model),
    {
      contents: [{ parts }],
      ...(opts.tools ? { tools: opts.tools } : {}),
      generationConfig: {
        temperature:      0.1,
        // 出力の形を固定する。パース失敗と項目の欠落が消える
        ...(opts.schema ? { responseMimeType: 'application/json', responseSchema: opts.schema } : {}),
        // レシートの小さい文字を落とさないよう解像度を上げる。
        // 複数枚を 1 枚に収めた画像では、既定のままだと縮小されて読めない
        ...(highRes ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}),
      },
    },
    {
      params:  { key: GEMINI_API_KEY },
      headers: { 'Content-Type': 'application/json' },
      timeout: 60_000,
      signal,
    },
  );

  const candidate = res.data?.candidates?.[0];
  // grounding を使うと本文が複数の part に分かれて返ることがある
  const text: string = (candidate?.content?.parts ?? [])
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('');
  if (!text) throw new Error('Gemini から空の応答が返されました');

  const sources: string[] = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c: any) => String(c?.web?.uri ?? ''))
    .filter((u: string) => u.length > 0);
  return { text, sources };
}

/**
 * generationConfig のフィールドに対応していないモデルだったか。
 * mediaResolution は比較的新しいので、古い世代のモデルに当たると 400 で弾かれる。
 */
function isUnsupportedConfigError(e: unknown): boolean {
  if (!axios.isAxiosError(e) || e.response?.status !== 400) return false;
  const msg = String((e.response?.data as any)?.error?.message ?? '').toLowerCase();
  return msg.includes('mediaresolution')
    || msg.includes('media_resolution')
    || msg.includes('unknown name');
}

/** API のエラー本文をそのままユーザーに見せられる形にする */
function toReadableError(e: unknown): Error {
  if (axios.isAxiosError(e) && e.response) {
    console.error('[Gemini] HTTP', e.response.status, JSON.stringify(e.response.data));
    const apiMsg = (e.response.data as any)?.error?.message;
    if (apiMsg) return new Error(`Gemini API ${e.response.status}: ${apiMsg}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
