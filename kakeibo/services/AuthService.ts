import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import * as Storage from './Storage';

WebBrowser.maybeCompleteAuthSession();

// ─── クライアントID（.env の EXPO_PUBLIC_GOOGLE_CLIENT_ID_* に設定） ─────────
// Google Cloud Console → 認証情報 → OAuthクライアントID で取得
// Web用: Web 動作確認 / Dev Build 両方で使用
// Android用: Dev Build 用（カスタムスキーム経由）
export const GOOGLE_CLIENT_ID_ANDROID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID ?? '';
export const GOOGLE_CLIENT_ID_WEB     = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB     ?? '';
// ─────────────────────────────────────────────────────────────────────────────

const SCOPES = [
  'openid',
  'profile',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

const SECURE_STORE_KEYS = {
  ACCESS_TOKEN:  'google_access_token',
  REFRESH_TOKEN: 'google_refresh_token',
  EXPIRES_AT:    'google_token_expires_at',
} as const;

const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint:         'https://oauth2.googleapis.com/token',
  revocationEndpoint:    'https://oauth2.googleapis.com/revoke',
};

/** プラットフォームに応じたクライアントIDとリダイレクトURI */
function getClientConfig() {
  // Web では Web 用クライアントID + 現在のオリジンをリダイレクトに使う
  // Android Dev Build ではカスタムスキーム + Android 用クライアントID
  if (Platform.OS === 'web') {
    return {
      clientId: GOOGLE_CLIENT_ID_WEB,
      redirectUri: AuthSession.makeRedirectUri(),
    };
  }
  return {
    clientId: GOOGLE_CLIENT_ID_ANDROID,
    // Google Android OAuth は `com.svnsfy.kakeibo:/oauthredirect`（単一スラッシュ）形式を要求する
    // 参考: expo-auth-session/build/providers/Google.js
    redirectUri: 'com.svnsfy.kakeibo:/oauthredirect',
  };
}

// ─── 公開 API ─────────────────────────────────────────────────────────────────

const PKCE_VERIFIER_KEY = 'pkce_code_verifier';

/**
 * Google OAuth サインイン。
 * - Web: 同一ウィンドウのリダイレクト方式（戻りは handleAuthCallback で処理）
 * - Native: ポップアップ方式（promptAsync）
 *
 * Web ではこの関数は戻らない（ページ遷移する）。
 */
export async function signInWithGoogle(): Promise<string> {
  if (Platform.OS === 'web') {
    return signInWeb();
  }
  return signInNative();
}

/** Web 版: 同一ウィンドウでリダイレクトする */
async function signInWeb(): Promise<string> {
  const { clientId, redirectUri } = getClientConfig();

  const request = new AuthSession.AuthRequest({
    clientId,
    scopes: SCOPES,
    redirectUri,
    usePKCE: true,
    extraParams: {
      access_type: 'offline',
      prompt:      'consent',
    },
  });

  // codeVerifier を内部で生成させるために authUrl を構築
  const authUrl = await request.makeAuthUrlAsync(GOOGLE_DISCOVERY);

  // 戻った後のために codeVerifier を sessionStorage に退避
  if (request.codeVerifier) {
    sessionStorage.setItem(PKCE_VERIFIER_KEY, request.codeVerifier);
  }

  // 同一ウィンドウで Google にリダイレクト
  window.location.assign(authUrl);

  // この Promise は解決しない（ページ遷移するため）
  return new Promise<string>(() => {});
}

/** Native 版: ポップアップ */
async function signInNative(): Promise<string> {
  const { clientId, redirectUri } = getClientConfig();

  const request = new AuthSession.AuthRequest({
    clientId,
    scopes: SCOPES,
    redirectUri,
    usePKCE: true,
    // access_type=offline は Android クライアントでは不要（インストール済みアプリは
    // デフォルトでオフラインアクセス付き）。ただし prompt=consent を付けないと
    // 2回目以降のサインイン時にリフレッシュトークンが返らず、1時間ごとに
    // 再ログインが必要になるため必須。
    extraParams: { prompt: 'consent' },
  });

  const result = await request.promptAsync(GOOGLE_DISCOVERY);

  if (result.type !== 'success') {
    throw new Error(`Google サインイン失敗: ${result.type}`);
  }

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier! },
    },
    GOOGLE_DISCOVERY,
  );

  await saveTokens(tokenResponse);
  return tokenResponse.accessToken;
}

/**
 * Web 専用: アプリ起動時に呼び、URL に ?code= が含まれていれば
 * トークン交換を実行して保存する。
 * @returns 新規にサインインを完了した場合 true
 */
export async function handleAuthCallback(): Promise<boolean> {
  if (Platform.OS !== 'web') return false;

  const params = new URLSearchParams(window.location.search);
  const code  = params.get('code');
  const error = params.get('error');

  if (error) {
    // URL を綺麗にしてからエラー
    window.history.replaceState({}, '', window.location.pathname);
    throw new Error(`Google OAuth エラー: ${error}`);
  }

  if (!code) return false;

  const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  if (!codeVerifier) {
    window.history.replaceState({}, '', window.location.pathname);
    throw new Error('codeVerifier がセッションから失われました');
  }

  const { clientId, redirectUri } = getClientConfig();

  try {
    const tokenResponse = await AuthSession.exchangeCodeAsync(
      {
        clientId,
        code,
        redirectUri,
        extraParams: { code_verifier: codeVerifier },
      },
      GOOGLE_DISCOVERY,
    );
    await saveTokens(tokenResponse);
    return true;
  } finally {
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    // URL パラメータを消す
    window.history.replaceState({}, '', window.location.pathname);
  }
}

/**
 * 保存済みアクセストークンを返す。
 * 有効期限切れならリフレッシュを試みる。未サインインなら null。
 */
export async function getAccessToken(): Promise<string | null> {
  const [accessToken, expiresAtStr, refreshToken] = await Promise.all([
    Storage.getItem(SECURE_STORE_KEYS.ACCESS_TOKEN),
    Storage.getItem(SECURE_STORE_KEYS.EXPIRES_AT),
    Storage.getItem(SECURE_STORE_KEYS.REFRESH_TOKEN),
  ]);

  if (!accessToken) return null;

  const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;
  const isExpired = Date.now() >= expiresAt - 60_000;
  if (!isExpired) return accessToken;

  if (!refreshToken) {
    await clearTokens();
    return null;
  }

  try {
    const { clientId } = getClientConfig();
    const refreshed = await AuthSession.refreshAsync(
      { clientId, refreshToken },
      GOOGLE_DISCOVERY,
    );
    await saveTokens(refreshed);
    return refreshed.accessToken;
  } catch {
    await clearTokens();
    return null;
  }
}

/** サインアウト：SecureStore からトークンを削除し、Google セッションを無効化 */
export async function signOut(): Promise<void> {
  const accessToken = await Storage.getItem(SECURE_STORE_KEYS.ACCESS_TOKEN);
  await clearTokens();

  if (accessToken) {
    try {
      await AuthSession.revokeAsync({ token: accessToken }, GOOGLE_DISCOVERY);
    } catch {
      // ignore
    }
  }
}

/** サインイン済みかどうかを確認する（期限切れ時はリフレッシュを試みる） */
export async function isSignedIn(): Promise<boolean> {
  const token = await getAccessToken();
  return token !== null;
}

// ─── 内部: トークン保存 / 削除 ───────────────────────────────────────────────

async function saveTokens(tokenResponse: AuthSession.TokenResponse): Promise<void> {
  const expiresAt = tokenResponse.expiresIn
    ? String(Date.now() + tokenResponse.expiresIn * 1000)
    : String(Date.now() + 3600 * 1000);

  await Promise.all([
    Storage.setItem(SECURE_STORE_KEYS.ACCESS_TOKEN, tokenResponse.accessToken),
    Storage.setItem(SECURE_STORE_KEYS.EXPIRES_AT,   expiresAt),
    tokenResponse.refreshToken
      ? Storage.setItem(SECURE_STORE_KEYS.REFRESH_TOKEN, tokenResponse.refreshToken)
      : Promise.resolve(),
  ]);
}

async function clearTokens(): Promise<void> {
  await Promise.all([
    Storage.deleteItem(SECURE_STORE_KEYS.ACCESS_TOKEN),
    Storage.deleteItem(SECURE_STORE_KEYS.REFRESH_TOKEN),
    Storage.deleteItem(SECURE_STORE_KEYS.EXPIRES_AT),
  ]);
}
