import axios from 'axios';
import {
  AIProvider,
  CancelledError,
  EMAIL_RECEIPT_SCHEMA,
  RECEIPT_LIST_SCHEMA,
  ReceiptData,
  buildReceiptPrompt,
  buildEmailPrompt,
  parseReceiptList,
  parseReceiptResponse,
} from './AIProvider';
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
    const raw = await callGemini(parts, RECEIPT_LIST_SCHEMA, { highRes: true, signal });
    return parseReceiptList(raw, categories);
  },

  async extractEmail(emailText: string, categories: string[]): Promise<ReceiptData> {
    const prompt = buildEmailPrompt(categories);
    const parts = [{ text: `${prompt}\n\n--- メール本文 ---\n${emailText}` }];
    // テキストだけなので解像度指定は要らない
    const raw = await callGemini(parts, EMAIL_RECEIPT_SCHEMA, { highRes: false });
    return parseReceiptResponse(raw, categories);
  },
};

/**
 * Gemini API 呼び出し共通処理。parts はモデルに渡すコンテンツ配列。
 * 戻り値はモデルの生テキスト（パースは呼び出し側で行う。画像は複数件、メールは 1 件）。
 *
 * @param schema  responseSchema に渡す出力スキーマ。形式崩れと項目欠落を防ぐ
 * @param opts.highRes 画像を高解像度で処理させる（小さい文字・複数レシート対策）
 */
async function callGemini(
  parts: object[],
  schema: object,
  opts: { highRes: boolean; signal?: AbortSignal },
): Promise<string> {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('YOUR_')) {
    throw new Error('GEMINI_API_KEY が未設定です');
  }

  const { signal } = opts;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  // 高解像度指定に対応しないモデルに当たったら false に落として以降は既定解像度で通す
  let highRes = opts.highRes;

  const send = async (model: string): Promise<string> => {
    try {
      return await postToModel(model, parts, schema, highRes, signal);
    } catch (e) {
      if (!highRes || !isUnsupportedConfigError(e)) throw e;
      console.warn(`[Gemini] ${model} は mediaResolution 非対応。既定の解像度で再試行します`);
      highRes = false;
      return postToModel(model, parts, schema, false, signal);
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
      return await send(model);
    } catch (e) {
      if (isCancellation(e)) throw new CancelledError();
      lastError = e;
      if (!shouldTryAnotherModel(e)) throw toReadableError(e);
      console.warn(`[Gemini] ${model} が使えないため別のモデルを試します`);
      await invalidateModelCache();
    }
  }

  throwIfCancelled();
  throw toReadableError(lastError ?? new Error('Gemini の呼び出しに失敗しました'));
}

/** axios の中断か（signal.abort による） */
function isCancellation(e: unknown): boolean {
  return e instanceof CancelledError || axios.isCancel(e);
}

async function postToModel(
  model: string,
  parts: object[],
  schema: object,
  highRes: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const res = await axios.post(
    endpointFor(model),
    {
      contents: [{ parts }],
      generationConfig: {
        temperature:      0.1,
        responseMimeType: 'application/json',
        // 出力の形を固定する。パース失敗と項目の欠落が消える
        responseSchema:   schema,
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

  const text: string = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Gemini から空の応答が返されました');

  return text;
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
