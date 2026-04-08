import { AIProvider } from './AIProvider';
import { geminiProvider } from './GeminiProvider';

export type { AIProvider, ReceiptData, ReceiptItem } from './AIProvider';

export type ProviderName = 'gemini' | 'claude' | 'openai';

/** デフォルトで使うプロバイダー */
export const DEFAULT_PROVIDER: ProviderName = 'gemini';

/** 名前からプロバイダーを取得（未実装のものは Error） */
export function getProvider(name: ProviderName = DEFAULT_PROVIDER): AIProvider {
  switch (name) {
    case 'gemini':
      return geminiProvider;
    case 'claude':
      throw new Error('ClaudeProvider は未実装です');
    case 'openai':
      throw new Error('OpenAIProvider は未実装です');
    default: {
      const _exhaustive: never = name;
      throw new Error(`未知のプロバイダー: ${_exhaustive}`);
    }
  }
}
