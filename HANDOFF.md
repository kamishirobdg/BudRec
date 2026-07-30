# Bud-Rec 引き継ぎドキュメント

> 新しいチャットセッションを開始するときは、このファイルを読ませてから作業を依頼してください。
> 例: 「BudRec/HANDOFF.md を読んで、状況を把握してから作業を始めて」
>
> 作業場所は 2 系統ある。**パスを間違えないこと。**
> - Windows ローカル: `C:\work\BudRec`（`kakeibo/node_modules` あり → `npx tsc --noEmit` が通る）
> - クラウドコンテナ: `/home/user/BudRec`（node_modules 無し）

最終更新: 2026-07-30 / 最新コミット `d134982` + ローカル未 push 分（デモモード・認証堅牢化）

---

## 1. プロジェクト概要

夫婦で使う家計簿 Android アプリ。レシート撮影（AI-OCR）・Gmail の購入明細メール・手入力から
支出を記録し、**Google スプレッドシートをそのままデータベースとして**保存する。
専用サーバーは無く、アプリから Google API を直接叩く構成。

- リポジトリ: `kamishirobdg/BudRec`
- 作業ブランチ: **`claude/reduce-google-relogin-MCMj8`**（このブランチ以外に push しない）
- アプリ本体: `kakeibo/` サブディレクトリ（`my-next-app/` は無関係の残骸）
- Android 専用（iOS ビルドは未対応）
- パッケージ名: `com.svnsfy.kakeibo` / 表示名: `Bud-Rec`

## 2. 技術スタック

| 領域 | 採用技術 |
|---|---|
| フレームワーク | Expo SDK 54 / React Native 0.81 / TypeScript |
| 認証 | Google OAuth（`expo-auth-session`、ネイティブ SDK は未使用） |
| DB | Google Sheets API v4（axios で直接呼び出し） |
| メール取込 | Gmail API |
| OCR | Gemini API（`providers/` で AI プロバイダーを抽象化。Claude/GPT は未実装） |
| ナビゲーション | `@react-navigation/bottom-tabs` |
| CI/CD | GitHub Actions → Android リリース APK を Artifacts に出力 |

redirectUri は `com.svnsfy.kakeibo:/oauthredirect` 固定。

## 3. ディレクトリ構成

```
kakeibo/
├── App.tsx                  タブナビゲーション・サインイン判定・Gmail自動取込(5分クールダウン)
├── app.json                 Expo設定（アイコン/スプラッシュ/背景色 #2e7d32）
├── .env.example             必要な環境変数のテンプレート
├── assets/                  icon.png / adaptive-icon.png / splash-icon.png（緑背景＋💰）
├── screens/
│   ├── HomeScreen.tsx       (57行) ホーム
│   ├── CameraScreen.tsx     (971行) レシート撮影・ギャラリー選択・OCR→確認→保存
│   ├── SummaryScreen.tsx    (1416行) 一覧/集計画面 ＋ 明細編集モーダル ★中核
│   ├── SettingsScreen.tsx   (535行) ユーザー名・Gmail連携・カテゴリ管理・サインアウト
│   ├── PersonalModal.tsx    (321行) 個人支出モーダル
│   └── MemoText.tsx         メモ内の価格を太字表示
├── services/
│   ├── AuthService.ts       OAuth・トークン保存(expo-secure-store)・AuthError
│   ├── SheetsService.ts     (844行) Sheets 全操作 ★中核
│   ├── GmailService.ts      Gmail検索→パース→行追加
│   ├── GmailProgressService.ts / ReceiptQueueService.ts
│   ├── DuplicateDetector.ts 重複候補の検出
│   ├── CategoryService.ts / UserService.ts / PreferencesService.ts / Storage.ts
└── providers/
    ├── AIProvider.ts        OCRプロバイダーのインターフェース
    └── GeminiProvider.ts    Gemini 実装
```

## 4. データモデル（スプレッドシート）

月ごとに `YYYY-MM` という名前のシートを作り、1 行 = 1 支出。列範囲は **`A:L`**。

```
A timestamp | B source | C user  | D store   | E category | F amount
G memo      | H counted_amount   | I excluded | J confirmed | K recurring | L deleted
```

```ts
interface ExpenseRow {
  timestamp: string;      // 'YYYY/MM/DD HH:MM:SS'（ISOではない）
  source: string;         // 'camera' | 'gmail' | 'manual' | 'suica'
                          // | 'proxy_camera' | 'proxy_manual'（代理入力）
                          // | 'recurring'（固定費の自動生成）
  user: string;           // 対象者名。代理入力時は「入力者」ではなく「対象者」が入る
  store: string;
  category: string;
  amount: number;
  memo: string;
  countedAmount: number;  // 集計に使う金額（一部計上のとき amount と異なる）
  excluded: boolean;      // 集計対象外
  confirmed: boolean;     // 重複警告を確認済み
  recurring: boolean;     // 固定費フラグ → 翌月に自動コピー
  deleted?: boolean;      // 論理削除（getRows で除外される）
  rowIndex?: number;      // 読み出し時に付与（1-based、ヘッダー=1）
  sheetName?: string;     // 読み出し時に付与
}
```

設定用シート（先頭 `_` で月次シートと区別）:
`_settings`（ユーザー/カテゴリ）, `_config`（既定一部計上額・Gmail検索期間）,
`_gmail_filters`, `_gmail_processed`（処理済みメールID・非取引としてスキップしたID）

### タイムスタンプの落とし穴（重要）
Hermes エンジンでは `new Date('2026/07/30 12:00:00')` が **NaN** になる。
そのため `sheetNameFromTimestamp()` は正規表現でパースしている。
**タイムスタンプ文字列を扱うコードで `new Date()` に頼らないこと。**
また `USER_ENTERED` で書き込まれた過去データが数値（シリアル値）化しているケースがあり、
`normalizeTimestamp()` / `serialToTimestamp()` で読み出し時に文字列へ戻している。

## 5. 実装済み機能

- Google サインイン（トークンは SecureStore。下記「再ログインを減らす対策」参照）
- レシート撮影 / ギャラリー選択 → Gemini OCR → 内容確認 → シートへ追加
  （**モデル名は固定せず実行時に解決する**。下記参照）
- Gmail 取込（アプリ復帰時に 5 分クールダウンで自動実行、設定画面から手動実行も可）
- 重複警告（`DuplicateDetector`）＋「確認済み」フラグ
- 一覧画面: 期間切替（月/年/全期間）・並び替え（日時/金額/カテゴリ）
- 合計カード（緑）＋ユーザー別ピル表示
- **カテゴリ別 ⇄ 人別 の表示トグル**（カテゴリカード右上の「人別」ボタン）
- **カテゴリ行をタップすると明細をそのカテゴリだけに絞り込む**（もう一度タップ、または
  明細ヘッダー右のチップで解除。合計ビュー・人別ビューのどちらからでも選べる。
  照合キーは表示名なので空カテゴリは '未設定' に寄せる）
- 明細ごとのトグル: 除外 / 一部計上 / 固定費（`ToggleChip` コンポーネント）
- 明細編集モーダル（取込元・ユーザーは読み取り専用表示）
- 代理入力（`proxy_camera` / `proxy_manual`、一覧で緑背景＋代理バッジ）
- **固定費の月初自動作成**（下記参照）
- 設定: 端末ユーザー名、Gmail 連携、カテゴリ追加/削除、サインアウト
- **デモモード**（外部にアプリを見せる用。下記参照）
- UI デザイン刷新済み（背景 `#f2f4f7` / プライマリ `#2e7d32` / カード角丸 16–20）
- アプリアイコン: 緑グラデーション角丸＋💰絵文字

### 固定費の月初自動作成の仕組み
1. `SummaryScreen` 起動時に 1 回だけ `checkAndApplyRecurring()` を実行
2. `PreferencesService.getRecurringAppliedMonth()` が当月と一致すれば何もしない（月1回だけ通信）
3. `SheetsService.applyRecurringEntries()` が **前月シート**の `recurring && !deleted` 行を当月へコピー
   - タイムスタンプ = `YYYY/MM/01 00:00:00`、`source: 'recurring'`
   - `excluded`/`confirmed`/`deleted` は false にリセット、`rowIndex`/`sheetName` はクリア
   - `recurring: true` は維持されるので翌月以降も連鎖する
4. 重複防止キー = `store|category|user|amount`（当月の `source === 'recurring'` 行から構築）
5. 作成件数 > 0 なら一覧を再読み込み

### Gemini モデルの動的解決（`providers/geminiModels.ts`）
モデル名をコードに固定すると、提供終了・無料枠 0・リージョン非対応になった瞬間に壊れる。
そのため ListModels で**そのキーで今使えるモデル**を取得して選ぶ。

- 優先順: `gemini-flash-lite-latest` → `gemini-flash-latest` → `gemini-2.5-flash-lite` →
  `gemini-2.5-flash`。先頭 2 つは Google が中身を差し替えるエイリアスなので世代交代に自動追従する。
- 優先リストが全滅しても、一覧から `flash-lite` → `flash` → `pro` の順、
  同種別なら**名前の降順（新しい世代優先）**で自動選択する。
  image / tts / audio / embedding / robotics / computer-use / deep-research / omni は除外。
- 解決結果は端末に 24 時間キャッシュ（OCR のたびに一覧を引かない）。
- 呼び出しが **429（無料枠切れ）/ 404（モデル無し）** で落ちたら、そのモデルを除外して
  選び直し、**最大 3 モデルまで**試す。それ以外のエラーは即座に投げる。

**2026-07-30 実測（このキー）**: `gemini-flash-lite-latest` / `gemini-flash-latest` /
`gemini-2.5-flash` / `gemini-3.5-flash-lite` は 200。**`gemini-2.0-flash` と
`gemini-2.0-flash-lite` は 429 RESOURCE_EXHAUSTED**（モデルは存在する。無料枠が 0）。
`gemini-2.5-flash` も存命。つまり他プロジェクトで言われた「2.5 が提供終了」は誤りで、
実体は**クォータ切れ**。モデル名を新しくするだけでなく、429 で別モデルに逃げる作りが要る。

### 再ログインを減らす対策（`services/AuthService.ts`）
アプリ側は以下まで対応済み。**これでも直らない場合の本命は Google Cloud Console の
OAuth 同意画面の公開ステータス**（「テスト」のままだとリフレッシュトークンが 7 日で失効する）。

- リフレッシュは **single-flight**。起動直後は一覧読み込みと Gmail 取り込みが同時に走り、
  同じリフレッシュトークンで並行更新して片方が失敗 → サインアウト、という事故が起きうる。
- **一時的な失敗でトークンを消さない。** `invalid_grant` / `invalid_client` /
  `unauthorized_client` のときだけ消す。通信断や 5xx では `TransientAuthError` を投げる
  （`AuthError` とは別クラス。画面側はアラートだけ出してサインイン状態を維持する）。
- `isSignedIn()` は通信できなかっただけならリフレッシュトークンの有無で判定する（オフラインで落とさない）。
- Sheets/Gmail は **401 を 1 回だけ強制リフレッシュして再送**（`refreshAccessTokenNow()`）。
  期限内でも Google 側で失効しているケースを拾う。
- ネイティブの `prompt: 'consent'` は**外さないこと**。付けないと 2 回目以降の
  サインインでリフレッシュトークンが返らず、1 時間ごとに再ログインになる。

### デモモードの仕組み（`services/DemoService.ts`）
設定画面いちばん上のスイッチで ON/OFF。設定は端末ローカル（Storage）に保存。

- **マスキングは読み出しの出口だけ**でやる。`SheetsService.getRows` / `getUniqueUsers` /
  `UserService.getCurrentUser` が返す値を差し替えるので、画面側はデモモードを知らない。
- 名前 = 設定画面の対応表（実名 → 表示名）。未設定の名前は `ユーザーA`〜`H` に自動割当。
- **カテゴリ別の合計金額 = 設定画面で直接指定できる**（`categoryTotals`）。
  当月の実合計を隣に出すので、それを見ながら見せたい額を入れる。指定したカテゴリは
  倍率・ジッターを使わず `指定額 ÷ 実合計` で明細を比例配分し、丸め誤差はカテゴリ内で
  一番大きい行に寄せて **合計が指定額ぴったり**になるようにする。
  合計の定義は画面のカテゴリ別カードと同じ（除外行を含めない `countedAmount` の合計）。
  マスクはシート単位なので **指定額は「1 か月あたり」の意味**になる（年/全期間表示では月数倍）。
  実合計の取得には `getRowsRaw()`（マスクしない生データ）を使う。
- 金額（合計を指定していないカテゴリ） = 倍率（×0.5〜×2）＋**行内容のハッシュから決まる ±20% のジッター**。
  同じ行はいつ見ても同じ偽金額になる（リロードで金額が動くと不自然なため）。
  `amount` と `countedAmount` には同じ倍率を掛ける（一部計上の比率を壊さない）。
- 店名ぼかし（既定 OFF）・メモ非表示（既定 ON）は個別スイッチ。
- **デモ中の書き込みはスプレッドシートに一切届かない。** メモリ上のオーバーレイ
  （追加行 + `sheetName:rowIndex` キーのパッチ）に溜め、`getRows` の最後で重ねる。
  → 追加・編集・削除・トグルの実演はできるが実データは汚れない。アプリ再起動で消える。
- デモ中は Gmail 取り込み・固定費の月初コピー・カテゴリ変更・設定変更を停止する
  （固定費は「適用済み」フラグも立てないので、デモ解除後に改めて走る）。
- 一覧の合計カード右上に小さく `DEMO` バッジが出る（付けっぱなし防止）。
- 実名を触る画面（設定のユーザー名欄、デモ対応表）は `getCurrentUserRaw()` /
  `getUniqueUsersRaw()` を使う。**ここを `getCurrentUser()` にすると、
  デモ表示名を実名として保存してしまう**ので注意。

**未対応**: 過去データのタイムスタンプ遡及修正（複数シートの履歴書き換えになるため見送り）。
遡及は「前月 → 当月」の 1 世代分だけ初回起動時に自動適用される。

## 6. ビルド・配布

`.github/workflows/build-apk.yml` が `claude/reduce-google-relogin-MCMj8` / `claude/competent-bose` /
`main` への push、または手動実行（workflow_dispatch）で走る。所要 **約 26 分**。

流れ: checkout → Node 22 / Java 21 / Android SDK → `npm ci` → `.env` 生成 →
`.env` 検証 → `expo prebuild --platform android --no-install` → キーストア準備 →
`./gradlew assembleRelease` → Artifacts `bud-rec-release` にアップロード（14日保持）

APK は Actions の該当 run ページの Artifacts からダウンロードする。

### 必須の GitHub Secrets（すべて設定済み）
```
EXPO_PUBLIC_GEMINI_API_KEY
EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID
EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB
EXPO_PUBLIC_SPREADSHEET_ID
```
`EXPO_PUBLIC_*` は Metro バンドル時に JS へ埋め込まれる。**シークレット未設定だと空文字になり、
Google 側で「Missing required parameter: client_id / エラー400」になる。**
`Verify .env keys and value lengths` ステップが各キーの文字数だけをログに出す（値は出さない）ので、
`0 chars` が出ていたらシークレット未設定と判断できる。

### 注意: 毎回インストールし直しが必要
`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`
が未設定なので、ビルドごとに `keytool` で新しいキーストアを生成している。
→ 署名が毎回変わるため、**新しい APK を入れる前に旧アプリをアンインストールする必要がある**。
アンインストールすると SecureStore ごと消えるので **Google 再ログインも毎回発生する**。

> **2026-07-30 決定: 恒久キーストアは採用しない。**
> 利用者が 2 人だけなので、更新のたびに「アンインストール → インストール → 再ログイン 1 回」で
> 運用する。キーストアと鍵パスワードを失うと二度と同じ署名で更新できなくなるため、
> その管理リスクを負うほどの利点が無いという判断。**この方針を再提案しないこと。**
> ワークフロー側は Secrets があればそちらを使う実装のままなので、方針が変わればいつでも切り替えられる。
> なお公開ステータスを本番にしたので、この再ログインは「インストールごとに 1 回」であって
> 7 日ごとに切れるわけではない。

### リンクを送るだけで配布したい場合（EAS internal distribution）
※ 現状は 2 人で使うだけなので未使用。外部に配る話が出たときの選択肢として残しておく。
`eas.json` に `preview`（`distribution: internal` / APK）と `production`（AAB）を定義済み。
`eas build -p android --profile preview` を通すと expo.dev のインストールページ URL と QR が発行され、
リンクを送るだけで入る。署名鍵は EAS 側が保持するので**毎回同じ署名＝上書き更新でき、
ログイン状態も維持される**（GitHub Actions の使い捨てキーストア問題が消える）。

事前に必要なもの:
- `app.json` の `extra.eas.projectId`（コミット済み）
- EAS 環境変数を `preview` 環境に 4 つ登録: `eas env:create --environment preview --name EXPO_PUBLIC_...`
  （`.env` は EAS のビルドサーバーには存在しないため必須）

**リポジトリは public なので、GitHub Releases に APK を置くのは避ける。**
APK には `EXPO_PUBLIC_GEMINI_API_KEY` が埋め込まれており、誰でも取り出せてしまう。
アクセス制御が必要なら Firebase App Distribution（テスター招待制）を使う。

### リリース（debug 不可の理由）
`assembleDebug` は Metro 開発サーバー前提で JS をバンドルに含めないため使えない。
必ず `assembleRelease` を使う。

## 7. 開発環境の制約

### Windows ローカル（`C:\work\BudRec`）
- `kakeibo/node_modules` があるので **`npx tsc --noEmit` がそのまま通る（現状エラー 0 件）**。
  型チェックはここでやるのが速い。
- git remote は `origin` = `kamishirobdg/BudRec`。ブランチは
  `claude/reduce-google-relogin-MCMj8`。push すると 26 分の CI ビルドが走るので、
  push するかどうかは都度確認する。
- **`.github/workflows/` を含むコミットは push できない**（保存されている PAT に
  `workflow` スコープが無く `refusing to allow a Personal Access Token to create or
  update workflow` で弾かれる）。ワークフローを直したいときは GitHub の Web UI で
  編集するか、PAT に `workflow` スコープを付け直すこと。
- コンテナ側とズレるので、作業開始前に `git fetch origin` して差分を確認する。

### クラウドコンテナ（`/home/user/BudRec`）
- **`node_modules` が未インストール**。そのため `npx tsc --noEmit` は
  `TS2307 Cannot find module 'react'` / `TS17004 JSX` / `TS2591 process` などで数百件エラーになる。
  これらは既存の環境起因であり、コードの問題ではない。自分の変更だけ確認するには:
  ```bash
  npx tsc --noEmit 2>&1 | grep -E "対象ファイル名" | grep -v "TS2307\|TS17004\|TS6142\|TS2591"
  ```
  実質的な検証手段は GitHub Actions のリリースビルド。
- `gh` / `hub` CLI・直接の GitHub API は使えない。**GitHub MCP ツール（`mcp__github__*`）のみ**、
  対象は `kamishirobdg/budrec` に限定。
- コンテナは使い捨て。作業は必ず commit & push する。
- **コンテナ再作成直後はリポジトリのクローンが古い可能性がある。**
  作業開始前に `git fetch origin claude/reduce-google-relogin-MCMj8` して
  `git merge --ff-only` で最新に揃えること（今回これで実際にズレていた）。
- 画像加工は `pip3 install pillow` が必要（ImageMagick / node-canvas は無い）。
  絵文字は `/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf` を `embedded_color=True` で描画。
  グリフが固定 109px なので、**ラスタライズ後に getbbox → crop → LANCZOS で拡大**する。
- 外向き HTTPS はプロキシ経由。TLS 検証を無効化したり `HTTPS_PROXY` を外したりしない。

## 8. 未対応・次にやること

### 動作確認待ち
- [ ] OAuth サインインが実機で通るか最終確認（Secrets 設定後のビルド #7〜#11 は成功済み）
- [ ] カテゴリ人別トグル・固定費月初自動作成の実機確認（ビルド #11 の APK）

### 優先度の高い改善
- [ ] **API レートリミット対策（指数バックオフ付きリトライ）** ← 最優先。Sheets/Gmail の 429 で落ちる
- [x] axios にタイムアウト設定（Sheets/Gmail ともに 30 秒）
- [ ] React ErrorBoundary（クラッシュ時の白画面回避）
- [ ] 書き込み失敗時のリトライキュー
- [ ] エラー時の再試行 UI
- ~~恒久 Android キーストアを Secrets に登録~~ → **見送り決定（2026-07-30）**。上記「ビルド・配布」参照

### 中期
- [ ] FlatList のページネーション（全期間表示が重い）
- [ ] 検索・フィルタ機能
- [ ] オフライン対応
- [ ] 初回オンボーディング画面
- [ ] アクセシビリティ改善

### Play ストア公開に向けて
- [ ] Gemini API キーをバンドルから外す（現状 JS に埋め込まれており抽出可能）
- [ ] スプレッドシートの自動作成（初回起動時）
- [ ] ユーザーごとの API キー設定
- [ ] プライバシーポリシーページ
- [ ] SuicaCSV インポート（当初計画にあり未着手）

## 9. 運用ルール（セッション共通）

- 開発・commit・push は **`claude/reduce-google-relogin-MCMj8`** のみ。他ブランチへ push しない。
- **明示的に依頼されない限り Pull Request を作らない。**
- push は `git push -u origin claude/reduce-google-relogin-MCMj8`。
  ネットワークエラー時のみ 2s → 4s → 8s → 16s のバックオフで最大 4 回リトライ。
- シークレットの値をビルドログやコミットに出さない。
- コミットメッセージは日本語、`feat:` / `ui:` / `ci:` / `docs:` プレフィックス。

## 10. コミット履歴（直近）

```
d134982 feat: カテゴリ人別表示切替・固定費月初自動作成      ← 現在の HEAD / ビルド#11 成功
7fdde6a ui: アイコンを💰絵文字（緑背景・角丸）に修正
4976feb ui: アイコン・一覧画面・設定画面のデザインを刷新
f692520 docs: UIモックアップHTMLを追加（mockup.html）
f4196a1 ci: .envキーと値の長さを検証するステップを追加
86131bb ci: .env生成をecho方式に変更
57974e8 ci: デバッグビルドをリリースビルドに切り替え
b4720e2 Move API keys and credentials to environment variables
```

## 11. 過去にハマった点（同じ失敗を繰り返さないため）

1. **「Missing required parameter: client_id」の真因は GitHub Secrets が 1 つも未設定だったこと。**
   `.env` の YAML ヒアドキュメントのインデント問題だと推測して先に修正したが的外れだった。
   → 環境変数系の不具合は、まず**シークレットが存在するか**を確認する。
2. ビルドの進行状況を確認せずに「まだ実行中です」と報告してしまった。
   → Actions の状態は `mcp__github__actions_list` で確認してから報告する。
3. アイコン生成でモックアップの 💰 絵文字ではなくテキストの「¥」を使ってしまった。
   → デザイン指示は元のモックアップと突き合わせて確認する。
