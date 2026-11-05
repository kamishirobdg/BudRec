/**
 * Gemini の呼び出しは、アプリに API キーを持たせないため中継（Cloudflare Workers。`proxy/gemini/`）を通す。
 * 中継には Google ログインのアクセストークンを付け、中継が Bud-Rec の利用者か確かめてから Gemini に送る。
 * 仕様は docs/meal-nutrition-spec.md §6.1（2026-11 のセキュリティ対応）。
 *
 * Gemini の応答（429・404・503 など）は中継がそのまま返すので、呼び出し側の扱い（別のモデルを試す等）は変わらない。
 * 中継が断ったときは `x-proxy-error` ヘッダーが付く。
 */

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { AuthError, getAccessToken, refreshAccessTokenNow } from '../services/AuthService';

/** 中継の URL（.env の EXPO_PUBLIC_GEMINI_PROXY_URL。秘密ではない） */
export const GEMINI_PROXY_URL = (process.env.EXPO_PUBLIC_GEMINI_PROXY_URL ?? '').replace(/\/+$/, '');

/** 中継が断った理由（Gemini 自身のエラーなら null） */
export function proxyRefusal(e: unknown): string | null {
  if (!axios.isAxiosError(e)) return null;
  const v = e.response?.headers?.['x-proxy-error'];
  return typeof v === 'string' && v ? v : null;
}

/**
 * 中継に送る。トークンが期限切れ・失効していたら 1 回だけ取り直して送り直す。
 * 取り直せなければ AuthError（再サインイン）。この Google アカウントが許可されていなければ分かる文面のエラー。
 */
export async function proxyRequest<T = any>(
  path: string,
  config: AxiosRequestConfig & { method: 'GET' | 'POST'; data?: unknown },
): Promise<AxiosResponse<T>> {
  if (!GEMINI_PROXY_URL) throw new Error('Gemini の中継の URL（EXPO_PUBLIC_GEMINI_PROXY_URL）が未設定です');
  const send = (token: string) => axios.request<T>({
    ...config,
    url: `${GEMINI_PROXY_URL}${path}`,
    headers: { ...(config.headers ?? {}), 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });

  const token = await getAccessToken();
  if (!token) throw new AuthError();
  try {
    return await send(token);
  } catch (e) {
    const reason = proxyRefusal(e);
    if (reason === 'forbidden') throw new Error('この Google アカウントでは Gemini を使えません（中継で許可されていません）');
    if (reason !== 'auth') throw e;
    const fresh = await refreshAccessTokenNow();
    if (!fresh) throw new AuthError();
    try {
      return await send(fresh);
    } catch (e2) {
      if (proxyRefusal(e2) === 'auth') throw new AuthError();
      throw e2;
    }
  }
}
