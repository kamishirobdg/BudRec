import axios from 'axios';
import {
  AIProvider,
  ReceiptData,
  buildReceiptPrompt,
  buildEmailPrompt,
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

  async extractReceipt(imageBase64: string, categories: string[]): Promise<ReceiptData> {
    const prompt = buildReceiptPrompt(categories);
    const parts = [
      { text: prompt },
      { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
    ];
    return callGemini(parts);
  },

  async extractEmail(emailText: string, categories: string[]): Promise<ReceiptData> {
    const prompt = buildEmailPrompt(categories);
    const parts = [{ text: `${prompt}\n\n--- メール本文 ---\n${emailText}` }];
    return callGemini(parts);
  },
};

/** Gemini API 呼び出し共通処理。parts はモデルに渡すコンテンツ配列。 */
async function callGemini(parts: object[]): Promise<ReceiptData> {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('YOUR_')) {
    throw new Error('GEMINI_API_KEY が未設定です');
  }

  // 無料枠切れ（429）やモデル消滅（404）のときは、そのモデルを外して選び直す。
  // 世代が古いモデルは無料枠が枯れていることがあるので、最大 3 モデルまで試す。
  const tried: string[] = [];
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let model: string;
    try {
      model = await resolveModel(GEMINI_API_KEY, { exclude: tried, force: attempt > 0 });
    } catch (e) {
      throw toReadableError(lastError ?? e);
    }
    if (tried.includes(model)) break; // 候補が尽きた
    tried.push(model);

    try {
      return await postToModel(model, parts);
    } catch (e) {
      lastError = e;
      if (!shouldTryAnotherModel(e)) throw toReadableError(e);
      console.warn(`[Gemini] ${model} が使えないため別のモデルを試します`);
      await invalidateModelCache();
    }
  }

  throw toReadableError(lastError ?? new Error('Gemini の呼び出しに失敗しました'));
}

async function postToModel(model: string, parts: object[]): Promise<ReceiptData> {
  const res = await axios.post(
    endpointFor(model),
    {
      contents: [{ parts }],
      generationConfig: {
        temperature:      0.1,
        responseMimeType: 'application/json',
      },
    },
    {
      params:  { key: GEMINI_API_KEY },
      headers: { 'Content-Type': 'application/json' },
      timeout: 60_000,
    },
  );

  const text: string = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Gemini から空の応答が返されました');

  return parseReceiptResponse(text);
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
