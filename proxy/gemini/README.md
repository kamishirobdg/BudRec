# Gemini の中継（Cloudflare Workers）

Bud-Rec のアプリに Gemini の API キーを持たせないための中継。アプリは Google ログインのアクセストークンを付けてここを呼び、
中継がトークンを Google に確かめ（発行先が Bud-Rec の OAuth クライアントで、許可したメールアドレスか）、キーを付けて Gemini に送る。

- 通すのは `GET /v1beta/models` と `POST /v1beta/models/<model>:generateContent` だけ
- キー・許可するメールアドレス・OAuth クライアント ID は **Worker の秘密の設定**に入れる。リポジトリには書かない
- 無料プランで足りる（1 日 10 万リクエストまで。Bud-Rec は 1 日数十回）

## 登録の手順（Windows の PowerShell）

```powershell
cd C:\work\BudRec\proxy\gemini
npx wrangler login                          # ブラウザで Cloudflare にログインして許可する
npx wrangler deploy                         # 表示される https://budrec-gemini-proxy.<名前>.workers.dev が中継の URL
npx wrangler secret put GEMINI_API_KEY      # 入力を求められたら新しい Gemini のキーを貼る（画面には出ない）
npx wrangler secret put ALLOWED_EMAILS      # 使う 2 人の Google アカウントをカンマ区切りで
npx wrangler secret put ALLOWED_CLIENT_IDS  # kakeibo/.env の Android と Web の OAuth クライアント ID をカンマ区切りで
```

確認: `curl.exe -i https://budrec-gemini-proxy.<名前>.workers.dev/v1beta/models` が `401`（`x-proxy-error: auth`）になれば動いている。

アプリ側は `kakeibo/.env` と EAS の環境変数（preview）に `EXPO_PUBLIC_GEMINI_PROXY_URL=<中継の URL>` を入れてビルドする。

## 変えるとき

- キーを作り直した: `npx wrangler secret put GEMINI_API_KEY` だけ（アプリのビルドは要らない）
- 使う人を増やす・減らす: `npx wrangler secret put ALLOWED_EMAILS`
- コードを変えた: `npx wrangler deploy`
