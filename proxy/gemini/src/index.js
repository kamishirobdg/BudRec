/**
 * Bud-Rec の Gemini 中継。アプリに API キーを持たせないため、Gemini はここから呼ぶ。
 *
 * - アプリは Google ログインのアクセストークンを `Authorization: Bearer <token>` で付けて呼ぶ
 * - トークンを Google の tokeninfo で確かめ、発行先が Bud-Rec の OAuth クライアントで、
 *   メールアドレスが許可した人（夫婦の 2 人）のときだけ Gemini に送る
 * - 通すのはアプリが使う 2 つだけ: `GET /v1beta/models`（使えるモデルの一覧）と
 *   `POST /v1beta/models/<model>:generateContent`
 * - Gemini の応答（429・503 なども）はそのまま返す。中継が断ったときは `x-proxy-error` を付ける
 *
 * 秘密の設定（wrangler secret put）:
 *   GEMINI_API_KEY      Gemini の API キー
 *   ALLOWED_EMAILS      使ってよい Google アカウント（カンマ区切り）
 *   ALLOWED_CLIENT_IDS  Bud-Rec の OAuth クライアント ID（Android・Web。カンマ区切り）
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const MODEL_PATH = /^\/v1beta\/models\/([a-z0-9.\-]+):generateContent$/;
/** 写真（base64）を含むので大きめ。これを超えるものは受けない */
const MAX_BODY_BYTES = 20 * 1024 * 1024;
/** 確かめたトークンを覚えておく時間の上限（同じトークンで tokeninfo を何度も呼ばない） */
const CACHE_MS = 5 * 60 * 1000;

/** トークンのハッシュ → { email, until }。Worker のインスタンスごとのメモリ（消えても確かめ直すだけ） */
const verified = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isList = request.method === 'GET' && url.pathname === '/v1beta/models';
    const isGenerate = request.method === 'POST' && MODEL_PATH.test(url.pathname);
    if (!isList && !isGenerate) return refuse(404, 'not_found');

    const auth = request.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return refuse(401, 'auth');
    const who = await verifyToken(token, env);
    if (who === 'invalid') return refuse(401, 'auth');
    if (who === 'forbidden') return refuse(403, 'forbidden');
    if (who === 'error') return refuse(503, 'tokeninfo_unavailable');

    const size = Number(request.headers.get('content-length') ?? 0);
    if (size > MAX_BODY_BYTES) return refuse(413, 'too_large');

    // クライアントから来たクエリの key は使わない。一覧の pageSize だけ通す
    const target = new URL(GEMINI_BASE + url.pathname);
    if (isList) target.searchParams.set('pageSize', url.searchParams.get('pageSize') ?? '200');

    const upstream = await fetch(target, {
      method: request.method,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: isGenerate ? request.body : undefined,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  },
};

/** @returns 'ok' | 'invalid'（期限切れ・不正）| 'forbidden'（許可していない人・アプリ）| 'error'（確かめられなかった） */
async function verifyToken(token, env) {
  const key = await sha256(token);
  const hit = verified.get(key);
  if (hit && hit.until > Date.now()) return 'ok';

  let res;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  } catch {
    return 'error';
  }
  if (res.status === 400) return 'invalid';
  if (!res.ok) return 'error';
  const info = await res.json();

  const clients = list(env.ALLOWED_CLIENT_IDS);
  const emails = list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());
  const email = String(info.email ?? '').toLowerCase();
  const fromApp = clients.includes(info.aud) || clients.includes(info.azp);
  if (!fromApp || !email || String(info.email_verified) !== 'true' || !emails.includes(email)) return 'forbidden';

  const expiresMs = Number(info.expires_in) > 0 ? Number(info.expires_in) * 1000 : CACHE_MS;
  if (verified.size > 100) verified.clear();
  verified.set(key, { email, until: Date.now() + Math.min(CACHE_MS, expiresMs) });
  return 'ok';
}

function list(v) {
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function refuse(status, reason) {
  return new Response(JSON.stringify({ error: { code: status, message: `proxy: ${reason}` } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-proxy-error': reason },
  });
}
