import axios from 'axios';
import {
  AIProvider,
  ReceiptData,
  buildReceiptPrompt,
  parseReceiptResponse,
} from './AIProvider';

// ─── API キー（後で設定 / 将来的には SecureStore に移行） ───────────────────
// https://aistudio.google.com/apikey で取得
export const GEMINI_API_KEY = 'REMOVED_GEMINI_KEY';
// ─────────────────────────────────────────────────────────────────────────────

// 新規アカウントでは gemini-2.0-flash / 2.5-flash は無料枠が 0 のことがある。
// lite 系（gemini-flash-lite-latest）なら無料枠が提供されている。
const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export const geminiProvider: AIProvider = {
  name: 'gemini',

  async extractReceipt(imageBase64: string, categories: string[]): Promise<ReceiptData> {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('YOUR_')) {
      throw new Error('GEMINI_API_KEY が未設定です');
    }

    const prompt = buildReceiptPrompt(categories);

    try {
      const res = await axios.post(
        GEMINI_ENDPOINT,
        {
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: 'image/jpeg',
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature:      0.1,
            responseMimeType: 'application/json',
          },
        },
        {
          params: { key: GEMINI_API_KEY },
          headers: { 'Content-Type': 'application/json' },
        },
      );

      const text: string = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) throw new Error('Gemini から空の応答が返されました');

      return parseReceiptResponse(text);
    } catch (e: any) {
      // Gemini API のエラー詳細を可視化
      if (e?.response) {
        console.error('[Gemini] HTTP', e.response.status, JSON.stringify(e.response.data));
        const apiMsg = e.response.data?.error?.message;
        if (apiMsg) {
          throw new Error(`Gemini API ${e.response.status}: ${apiMsg}`);
        }
      }
      throw e;
    }
  },
};
