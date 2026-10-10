/**
 * Google API 呼び出しの自動リトライ。
 *
 * Sheets / Gmail は 429（クォータ超過）や 5xx を普通に返してくる。1 回で諦めると
 * 「たまに保存できない・たまに一覧が出ない」アプリになるので、少し待って投げ直す。
 *
 * 方針:
 * - **レスポンスが返ってきた 429 / 5xx は必ず再送する。** サーバーが処理を拒否した
 *   ことが確定しているので、非冪等な POST（`:append`）を投げ直しても二重登録にならない。
 * - **レスポンスが無い失敗（通信断・タイムアウト）は冪等なメソッドだけ再送する。**
 *   届いたかどうか分からないため、POST を投げ直すと同じ行が 2 行できうる。
 *   ここで諦めた書き込みは WriteQueueService が拾って後で送り直す。
 * - 待ち時間は `Retry-After`（秒指定）を優先し、無ければ指数バックオフ＋ジッター。
 *   ジッターは、起動直後に並行して走る複数リクエストの再送が同じ瞬間に重なるのを防ぐ。
 */

import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

/** 1 リクエストあたりの再送回数の上限（初回と合わせて最大 4 回投げる） */
export const MAX_RETRIES = 3;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS  = 8_000;
// Retry-After はサーバー側の指定を尊重したいので、指数バックオフ用の MAX_DELAY_MS より
// 大きい上限にする（無制限にすると極端な値で待ちっぱなしになりうるため、こちらも一応キャップする）
const MAX_RETRY_AFTER_MS = 30_000;

/** 待てば状況が変わりうる（＝サーバー側が一時的に断っている）ステータス */
const RETRIABLE_STATUS: readonly number[] = [429, 500, 502, 503, 504];

type RetryableConfig = InternalAxiosRequestConfig & { _retryCount?: number };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 何度投げても結果が変わらないメソッドか（届いたか不明でも再送してよいか） */
function isIdempotentMethod(method?: string): boolean {
  const m = (method ?? 'get').toLowerCase();
  return m === 'get' || m === 'head' || m === 'put';
}

/**
 * このエラーは再送する価値があるか。
 * @param idempotent 同じリクエストを 2 回投げても副作用が重複しないなら true
 */
export function isRetriableError(e: unknown, idempotent: boolean): boolean {
  if (axios.isCancel(e)) return false;
  if (!axios.isAxiosError(e)) return false;

  const status = e.response?.status;
  if (status !== undefined) return RETRIABLE_STATUS.includes(status);

  // レスポンス無し = 通信断・タイムアウト。サーバーに届いたかどうか分からない
  return idempotent;
}

/**
 * `Retry-After` を待ち時間（ms）に変換する。
 * 秒数指定のみ解釈し、HTTP-date 形式は無視する（Hermes の日付解析に頼らない方針）。
 */
function parseRetryAfter(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return sec * 1000;
}

/** 次の再送までの待ち時間（ms）。attempt は 0 始まり */
export function retryDelayMs(e: unknown, attempt: number): number {
  const header     = axios.isAxiosError(e) ? e.response?.headers?.['retry-after'] : undefined;
  const fromHeader = parseRetryAfter(header);
  if (fromHeader !== null) return Math.min(fromHeader, MAX_RETRY_AFTER_MS);

  const backoff = BASE_DELAY_MS * 2 ** attempt;
  const jitter  = Math.random() * BASE_DELAY_MS;
  return Math.min(backoff + jitter, MAX_DELAY_MS);
}

/**
 * axios インスタンスに再送インターセプタを付ける。
 * 401 の再認証インターセプタより **後に** 登録すること（401 を先に処理させるため）。
 */
export function attachRetryInterceptor(client: AxiosInstance): void {
  client.interceptors.response.use(undefined, async (error) => {
    const config = error?.config as RetryableConfig | undefined;
    if (!config) throw error;

    const attempt = config._retryCount ?? 0;
    if (attempt >= MAX_RETRIES) throw error;
    if (!isRetriableError(error, isIdempotentMethod(config.method))) throw error;

    const wait = retryDelayMs(error, attempt);
    console.log(
      `[retry] ${(config.method ?? 'get').toUpperCase()} ${config.url ?? ''} を ${wait}ms 後に再送` +
      ` (${attempt + 1}/${MAX_RETRIES}) status=${error?.response?.status ?? 'none'}`,
    );
    config._retryCount = attempt + 1;
    await sleep(wait);
    return client.request(config);
  });
}

/**
 * axios を直接呼んでいる箇所（Gmail）用のラッパ。
 * @param idempotent 送信済みか不明な状態で投げ直しても安全なら true
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  opts: { idempotent: boolean; label?: string },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= MAX_RETRIES || !isRetriableError(e, opts.idempotent)) throw e;
      const wait = retryDelayMs(e, attempt);
      console.log(
        `[retry] ${opts.label ?? 'request'} を ${wait}ms 後に再送 (${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(wait);
    }
  }
}
