import axios from 'axios';
import {
  AIProvider,
  ReceiptData,
  buildReceiptPrompt,
  parseReceiptResponse,
} from './AIProvider';

// ─── API キー（後で設定 / 将来的には SecureStore に移行） ───────────────────
// https://aistudio.google.com/apikey で取得
export const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY';
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export const geminiProvider: AIProvider = {
  name: 'gemini',

  async extractReceipt(imageBase64: string, categories: string[]): Promise<ReceiptData> {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('YOUR_')) {
      throw new Error('GEMINI_API_KEY が未設定です');
    }

    const prompt = buildReceiptPrompt(categories);

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
  },
};
