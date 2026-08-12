# Bud-Rec 引き継ぎドキュメント

> 新しいチャットセッションを開始するときは、このファイルを読ませてから作業を依頼してください。
> 例: 「BudRec/HANDOFF.md を読んで、状況を把握してから作業を始めて」
>
> 作業場所は 2 系統ある。**パスを間違えないこと。**
> - Windows ローカル: `C:\work\BudRec`（`kakeibo/node_modules` あり → `npx tsc --noEmit` が通る）
> - クラウドコンテナ: `/home/user/BudRec`（node_modules 無し）

最終更新: 2026-08-07 / 最新コミット `068529b`（Windows ローカルに未 push のコミットあり）

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
├── components/
│   └── ErrorBoundary.tsx    描画中の例外を受け止める。App全体＋タブ単位で使う
├── screens/
│   ├── HomeScreen.tsx       (52行) ホーム
│   ├── CameraScreen.tsx     (1093行) レシート撮影・ギャラリー選択・OCR→確認→保存
│   ├── SummaryScreen.tsx    (1579行) 一覧/集計画面 ＋ 明細編集モーダル ★中核
│   ├── SettingsScreen.tsx   (768行) ユーザー名・Gmail連携・カテゴリ管理・未送信キュー
│   ├── ReceiptReviewModal.tsx (385行) 複数明細の確認・編集（保存前／登録後の両方で使う）
│   ├── PersonalModal.tsx    (297行) 個人支出モーダル（読み出しのみ）
│   └── MemoText.tsx         メモ内の価格を太字表示
├── services/
│   ├── AuthService.ts       OAuth・トークン保存(expo-secure-store)・AuthError
│   ├── SheetsService.ts     (974行) Sheets 全操作 ★中核
│   ├── httpRetry.ts         429/5xx/通信断の再送（指数バックオフ）
│   ├── WriteQueueService.ts 送れなかった書き込みの退避キュー
│   ├── LastBatchService.ts  直近に登録した行の記録（「前回の登録」用）
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
- **複数レシートの一括読み取り**: 並べて 1 枚に収めて撮ると、写っている枚数ぶん行を作る（下記参照）
- **読み取り結果の確認画面**: 2 件以上読めたときは保存前に一覧で確認・編集できる（下記参照）
- **「前回の登録」**: 一覧から、この端末で最後に登録した行だけをまとめて見直せる（下記参照）
- Gmail 取込（アプリ復帰時に 5 分クールダウンで自動実行、設定画面から手動実行も可）
- 重複警告（`DuplicateDetector`）＋「確認済み」フラグ
- 一覧画面: 期間切替（月/年/全期間）・並び替え（日時/金額/カテゴリ）・**店舗名/メモの検索**・
  **段階的な描画（50 件ずつ・スクロールで追加読み込み）**
- 合計カード（緑）＋ユーザー別ピル表示
- **カテゴリ別 ⇄ 人別 の表示トグル**（カテゴリカード右上の「人別」ボタン）
- **カテゴリ行をタップすると明細をそのカテゴリだけに絞り込む**（もう一度タップ、または
  明細ヘッダー右のチップで解除。合計ビュー・人別ビューのどちらからでも選べる。
  照合キーは表示名なので空カテゴリは '未設定' に寄せる）
- 明細ごとのトグル: 除外 / 一部計上 / 固定費（`ToggleChip` コンポーネント）
- 明細編集モーダル（取込元・ユーザーは読み取り専用表示）。RN の `Modal` は Android では
  別ウィンドウ扱いで `windowSoftInputMode=adjustResize` が効かず、メモ欄がキーボードに
  隠れて入力内容が見えなくなる問題があったため `KeyboardAvoidingView`（`behavior="height"`）で
  包んで対応（2026-08-08）
- 代理入力（`proxy_camera` / `proxy_manual`、一覧で緑背景＋代理バッジ）
- **固定費の月初自動作成**（下記参照）
- 設定: 端末ユーザー名、Gmail 連携、カテゴリ追加/削除、サインアウト
- **デモモード**（外部にアプリを見せる用。下記参照）
- **通信エラーへの耐性**: 429/5xx の自動リトライ、送れなかった書き込みの退避と自動再送、
  一覧の読み込み失敗時の再試行バナー、未送信の追加行の「送信待ち」表示、
  **一覧読み込みのオフラインキャッシュ**（下記参照）
- **ErrorBoundary**: 描画中に落ちても白画面にならず、その場で再試行できる（下記参照）
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

### 複数レシートの一括読み取り（`providers/AIProvider.ts`）

レシートを並べて 1 枚に収めて撮ると、写っている枚数ぶんの行を作る。

- プロンプトで `{"receipts":[...]}` を返させ、`parseReceiptList()` が配列に直す。
  モデルが形を崩して `[...]` や裸のオブジェクトを返しても受け付ける。
- プロンプトでは「勝手に分割・合算しない」「折れ曲がって 2 段に見えるものは 1 件」
  「金額が読めないものは要素ごと省く」を明示している。
- **合計金額を読めなかったレシートは行を作らない**（`amount > 0` のものだけ採用）。
  1 件も読めなければ従来どおり「OCR失敗」の 3 択ダイアログになる。
- 途中の 1 件が書き込みに失敗しても残りは続け、件数だけトーストで伝える。
  ただし `AuthError` のときは即中断する（再サインインが要る状態では残りも必ず失敗するため）。
- **2 件以上読めたときは保存前に確認モーダルを出す**（下記参照）。1 件のときは即保存。
- OCR 失敗時の手動入力モーダルは 1 件ぶんのみ。複数枚を手入力したいときは個別に撮り直す。

### 読み取り結果の確認と「前回の登録」（`screens/ReceiptReviewModal.tsx`）

1 つのモーダルを 2 通りに使う。行の追加はできない（読めなかったレシートは撮り直す）。

**`confirm`（保存前）** — 1 枚の画像から **2 件以上**読み取れたときに出る。1 件なら従来どおり
即保存で確認は挟まない。日時・店舗・カテゴリ・金額・メモをその場で直せる。

- 「登録しない」にした行は書き込まない。全部外して確定した場合は「このレシートは不要」と
  みなして画像ごと破棄する。
- 「閉じる」で抜けた場合は**画像を pending に残す**ので、後から撮り直さずに再処理できる。
- バナーからの一括処理は、確認モーダルが開いた時点で止める（次の結果で上書きしないため）。
  残りはバナーに残るので続きから再開できる。

**`edit`（登録後）** — 一覧の明細ヘッダー右「前回の登録」から開く。この端末で最後に登録した
行だけを集めて表示し、直すとそのままシートに反映される。

- 何を登録したかは `LastBatchService` が `<documentDirectory>/last-batch.json` に覚えている。
  **追加した時点では行番号が分からない**ため、行の内容（シート名・日時・店名・金額）をキーにして
  開くときにシートから探し直す。表示中の期間とは無関係に、登録した月のシートを直接読む。
- 触っていない行は書き戻さない（`isSameEntry` で判定）。
- 保存後は編集後の内容でキーを取り直すので、日時や金額を直しても次回また開ける。
- 行が見つからないとき（削除された・他端末で内容が変わった）はその旨を出して何もしない。
- デモモード中はボタンを出さない。

日時の入力は `2026/08/07 12:34` のような表記を受け付けて `YYYY/MM/DD HH:MM:SS` に整える
（`normalizeTimestampInput`。区切り・ゼロ埋め・秒の省略を許し、実在しない日時は弾く）。

**精度の注意**: 並べる枚数が増えるほど 1 枚あたりの解像度が落ちる。対策として
`mediaResolution: MEDIA_RESOLUTION_HIGH` と撮影 `quality: 0.85` を入れてある（下記参照）。
それでも読めない場合は枚数を減らす。**実機での精度は未検証**（何枚まで実用かはこれから確かめる）。

### OCR の精度設定（`providers/GeminiProvider.ts`）

`generationConfig` に渡しているもの:

- `temperature: 0.1`
- `responseMimeType: 'application/json'` ＋ **`responseSchema`**（`AIProvider.ts` の
  `RECEIPT_LIST_SCHEMA` / `EMAIL_RECEIPT_SCHEMA`）。出力の形が固定され、パース失敗と項目欠落が
  消える。**値の正しさは保証しない**ので、日付の検証は下記のとおり別途行う。
- **`mediaResolution: 'MEDIA_RESOLUTION_HIGH'`**（画像のときだけ。メールはテキストなので付けない）。
  小さい文字の読み取りが上がる。複数レシートを 1 枚に収めた画像では、既定のままだと縮小されて読めない。
  古い世代のモデルは 400 を返すので、その場合は指定を外して同じモデルで 1 回だけ再送する。
- 撮影は `quality: 0.85`、ギャラリー選択は `0.9`（JPEG 圧縮で文字が潰れると誤読になる）。

**モデルは既定で `gemini-flash-lite-latest`**（一番安く、一番誤読しやすい）。精度がどうしても
足りなければ `PREFERRED_MODELS` の先頭を `gemini-flash-latest` に入れ替える。
無料枠の消費とレイテンシは増える。

### 日付の扱い（`AIProvider.normalizeDateString` / `CameraScreen.acceptableDate`）

以前は `/^\d{4}-\d{2}-\d{2}$/` の厳密一致で、外れると**黙って撮影日に化けていた**。
モデルは指示した形式を普通に外すので、2 段階に分けてある。

1. `normalizeDateString()` が表記を `YYYY-MM-DD` に正規化する。受け付けるのは
   `2026-4-7` / `2026/04/07` / `2026.4.7` / `2026年4月7日` / `令和8年4月7日` / `R8.4.7` /
   `26-04-07` / `4/7`（年が印字されていないレシート → 今年。未来になるなら前年）。
   **存在しない日付（`2026-02-30` など）はここで空文字にする。**
2. `acceptableDate()` が採用可否を決める。**未来日**（有効期限・次回来店期限の誤読）と
   **400 日より古い日付**（年の誤読）は捨てて撮影日に寄せる。そのまま書くと別の月シートに
   入ってしまい、一覧から消えたように見えるため。

プロンプト側でも「有効期限・ポイント有効期限・次回来店期限を購入日と取り違えない」
「和暦は西暦に直す」「年が読めなければ月日だけ返す（推測で補わない）」を明示している。

### 通信が失敗したときのふるまい（`services/httpRetry.ts` / `services/WriteQueueService.ts`）

Sheets / Gmail は 429（クォータ超過）や 5xx を普通に返す。3 段構えで耐える。

**1. 自動リトライ（`httpRetry.ts`）**
- 対象は 429 / 500 / 502 / 503 / 504 と、通信断・タイムアウト。最大 3 回再送。
- **レスポンスが返ってきた 429・5xx はメソッドを問わず再送する。** サーバーが処理を拒否した
  ことが確定しているので、`:append` を投げ直しても二重登録にならない。
- **レスポンスが無い失敗（通信断・タイムアウト）は GET / PUT だけ再送する。** 届いたかどうか
  分からないため、POST を投げ直すと同じ行が 2 行できうる。ここで諦めた分は下の 3 が拾う。
- 待ち時間は `Retry-After`（**秒指定のみ**解釈。日付形式は Hermes の日付解析に頼らないため無視）
  を優先し、無ければ 500ms から倍々＋ジッター（上限 8 秒）。
- Sheets は axios インターセプタ、Gmail は `withRetry()` でラップ。Sheets では
  **401 の再認証インターセプタより後に登録すること**（401 を先に処理させるため）。

**2. リクエスト数そのものを減らす**
- シート名一覧を 15 秒だけキャッシュする。1 行追記するたびに「そのシートが存在するか」を
  問い合わせていたのをやめた。シートを作ったら `invalidateSheetNames()` で必ず捨てること。
  取りこぼし（他端末が直前に作った等）は addSheet の「既に存在する」失敗を拾って吸収する。
- 全期間表示の月別読み出しは 4 並列まで（従来は全シート同時に投げていた）。

**3. 書き込みの退避キュー（`WriteQueueService.ts`）**
- リトライしても送れなかった書き込みを `<documentDirectory>/pending-writes.json` に溜める。
  対象は追加・編集・フラグ更新・削除・固定費切替の 5 操作。SecureStore は大きな値を
  保存できないことがあるためファイルに置く（認証情報は含まない）。
- 退避するのは一時的な失敗（429 / 5xx / 通信断 / 認証切れ）だけ。400 系はそのまま投げる。
- 退避したときは `QueuedWriteError` を投げる。**画面側はこれを「失敗」ではなく
  「未送信のまま受理」として扱い、楽観的更新を巻き戻さない。** `AuthError` だけは元のまま
  投げてサインアウトさせる（キューは残るので再ログイン後に自動で流れる）。
- 再送は App のサインイン直後とフォアグラウンド復帰時に、**Gmail 取り込みより先に**走る。
  一覧のバナー（タップで即送信）と設定画面の「未送信の変更」からも実行できる。
- 1 件失敗したらそこで止める（同じ行への操作の順序を崩さないため）。送っても直らないと
  判断した失敗は `permanent` を立てて自動送信からは飛ばし、設定画面で破棄できるようにする。
- 固定費の月初コピーは、退避された場合も「作成済み」として先へ進める。ここで中断すると
  適用済みフラグが立たず、次回起動時に未送信ぶんと二重に作ってしまうため。
- **退避された追加行は「送信待ち」として一覧の先頭に重ねて表示する**（`SummaryScreen.tsx` の
  `pendingAppendRows`。2026-08-07）。サーバー側の行番号がまだ無いため実データの `rows` には混ぜず、
  表示専用の `DisplayRow`（`pendingWriteId` 付き）として FlatList にだけ渡す。現在の表示範囲
  （月/年/全期間）と自分の行（代理入力含む）に絞り込む。編集・トグル操作は不可（送信後に通常の行として
  現れてから行う）。送信できて一覧から消えたら通常の `rows` 側に反映される。
- タイムアウトで退避したものは「実は書けていた」可能性がある。再送すると重複しうるので、
  設定画面から内訳（操作内容・失敗理由・失敗回数）を見て個別に破棄できるようにしてある。

**4. 一覧読み込み失敗時の再試行バナー（`SummaryScreen.tsx` の `loadError`）**
- 上記 1〜3 で救えなかった読み込み失敗（`getRowsForRange` 等）は `Alert.alert` に加えて
  赤いバナーを常時表示する。引き下げ更新でも再取得できるが、それに気づかない・失敗に気づかない
  利用者向けに、タップで即再試行できるボタンを兼ねたバナーを置いた。
- 読み込みに成功した時点（引き下げ更新含む）で自動的に消える。

### ErrorBoundary（`components/ErrorBoundary.tsx`）

描画中に例外が起きると React はツリー全体をアンマウントするため、以前は画面が真っ白になり
アプリを再起動するしか手が無かった。App 全体とタブ単位の二重で囲んである
（一覧画面が落ちても撮影タブは使える）。エラー文言・再試行ボタン・スタックトレース
（コピー可。実機で原因を追う唯一の手がかり）を表示し、再試行では子ツリーの key を
変えて作り直す。

**イベントハンドラ内と非同期処理の例外は React の仕様上ここでは拾えない。**
そちらは従来どおり各画面の try/catch が担当する。

### デモモードの仕組み（`services/DemoService.ts`）
設定画面いちばん上の丸い色付きボタン（テキストラベル無し）で ON/OFF。設定は端末ローカル（Storage）に保存。

- **設定内容（表示名対応表・カテゴリ別合計・倍率・店名ぼかし・メモ非表示）は
  ON/OFF ボタンを押した直後だけ表示する**（`SettingsScreen.tsx` の `panelOpen`、2026-08-08）。
  `demo.enabled` は端末に永続化されるが `panelOpen` は画面を開くたびに `false` にリセットされる
  コンポーネント内 state なので、デモが ON のまま設定画面を開き直しても中身は見えない。
  横から画面を覗かれても「デモモードという機能がある」こと自体が分からないようにするための対策。
  再度中身を見る/直すには ON/OFF ボタンをもう一度押す（デモの ON/OFF 自体も切り替わる）。
- **未送信キューの「送信待ち」行・オフラインキャッシュはどちらもデモ中は出さない**（2026-08-09、
  レビューで発覚した抜け漏れ）。`pendingAppendRows`（`WriteQueueService` 由来）はマスクを
  一切通らない生データのため `demoMode` なら空配列にする。`RowsCacheService` はデモ中の
  取得結果（偽名・偽金額）を保存すると次にオフラインで開いたとき本物のデータとして
  出てきてしまい、逆に実データのキャッシュが残っているとデモ中オフラインで生データが
  漏れるため、**デモ中は保存も読み出しも行わない**（`SummaryScreen.tsx` の `loadRows` 内
  `isDemo` フラグ）。
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
- [x] OAuth サインイン・カテゴリ人別トグル・固定費月初自動作成の実機確認（2026-08-02 完了）
- [x] リトライ / 未送信キュー / ErrorBoundary の実機確認（2026-08-07 完了。問題なし）
- [x] 複数レシート一括読み取りの実機確認（2026-08-07 完了。**4 枚までは問題なく取り込めることを確認**。5 枚以上は未検証）
- [x] 読み取り結果の確認モーダル・「前回の登録」の実機確認（2026-08-07 完了。問題なし）
- [x] 読み込み失敗時の再試行バナー・未送信追加行の「送信待ち」表示の実機確認（2026-08-07 完了。問題なし）
- [x] 検索・ページネーション・スクロールボタン・キーボード回避の実機確認（2026-08-12 完了。問題なし）
- [x] 全体レビューでの修正 10 件の実機確認（2026-08-12 完了。問題なし）
- [ ] **異常系だけ未確認**（通常操作では踏まないため上記の確認では通っていない）:
  - オフラインキャッシュ（機内モードで一度開いた範囲を開き直し、灰バナーが出るか）
  - 一括処理の途中でセッションが切れた場合に Alert が 1 回で止まるか
  - デモ ON のまま未送信キューが残っているときに設定画面・一覧に実データが出ないか
- [ ] OCR の「中止」ボタン（2026-08-12 実装。未検証。OCR 中に押して、エラーダイアログが
  出ずにバナーへ戻る＝画像が残っていることを確認する）
- [ ] 月シートのヘッダー書き込み（2026-08-12 修正）。**月が変わって最初の 1 件を登録したとき、
  ヘッダー行と明細行が正しく並ぶか**（通常経路も通るので次の月初に要確認）

### 優先度の高い改善
- [x] **API レートリミット対策（指数バックオフ付きリトライ）**（2026-08-02）
- [x] axios にタイムアウト設定（Sheets/Gmail ともに 30 秒）
- [x] React ErrorBoundary（クラッシュ時の白画面回避）（2026-08-02）
- [x] 書き込み失敗時のリトライキュー（2026-08-02）
- [x] 読み込み失敗時の再試行 UI（2026-08-07。Alert に加え、失敗中は赤いバナーを常時表示しタップで再試行）
- [x] 未送信の追加行を一覧に「送信待ち」として重ねて表示する（2026-08-07。`SummaryScreen.tsx` の
  `pendingAppendRows` が未送信キューの `append` 操作を現在の表示範囲・自分の行に絞って一覧の先頭に重ねる。
  サーバー側の行番号がまだ無いため編集・トグル操作は不可）
- ~~恒久 Android キーストアを Secrets に登録~~ → **見送り決定（2026-07-30）**。上記「ビルド・配布」参照

### 中期
- [x] **検索・フィルタ機能**（2026-08-08。`SummaryScreen.tsx` に店舗名・メモの検索欄を追加。
  既存のカテゴリ絞り込み（`catFilter`）と併用可能。未送信の「送信待ち」行にも適用される）
- [x] **FlatList のページネーション**（2026-08-08。`PAGE_SIZE=50` 件ずつ段階的に描画し、
  `onEndReached` に加えて 300ms 間隔のタイマーでスクロールを待たず裏で先読みする。
  範囲・絞り込み・検索・並び替えを変えると先頭からやり直す。
  合計・カテゴリ別集計は従来どおり全件を対象にする（ページングは表示のみ））
  - **フロートのスクロールボタン**（画面右上「最上部へ/↑10%」・右下「↓10%/最下部へ」）を追加。
    Android の `persistentScrollbar` は機種のテーマ次第で細く見えづらいことがあるため、
    件数が多い範囲でもスクロールバーに頼らず移動できるようにした。`scrollToOffset` は
    渡した位置にそのまま着地し後から補正されないため、10% 移動は 1 回押して 1 回だけ動く。
    「最下部へ」は未読み込み分があれば先に全件読み込んでから `scrollToEnd` する
    （`onContentSizeChange` で読み込み完了を検知してから 1 回だけジャンプ）。
    右下フロートボタンが最後の明細の「編集」ボタンと重なっていたため `contentContainerStyle`
    に `paddingBottom:100` を追加して回避（2026-08-09 修正）。また「最下部へ」の着地待ち
    （`jumpToEndPending`）は範囲・絞り込み・並び替えを変えた時点で取り消すようにした
    （そうしないと絞り込みで表示件数が減った瞬間に意図せず一番下までスクロールしうる）。
- [x] **オフライン対応**（2026-08-08。新規 `services/RowsCacheService.ts` が読み込めた一覧を
  表示範囲ごとに端末へ保存し、通信失敗時はそれを表示する。書き込み側の `WriteQueueService` と対になる
  読み取り側のオフライン対応。灰色バナーで「〜時点のデータを表示中」と案内しタップで再取得できる。
  ユーザー名・デモ設定は Sheets 呼び出しと分離し、通信不可でも端末ローカル読み出しだけは常に反映する
  （そうしないと自分の行の絞り込みキーが空のままキャッシュが空に見えてしまうため）。
  デモ中は保存・読み出しとも行わない（2026-08-09 修正。詳細は「デモモードの仕組み」参照）。
  サインアウト時に `RowsCache.clear()` する（同じ端末で別アカウントに切り替えても前アカウントの
  データが残らないように））
- [ ] 初回オンボーディング画面
- [ ] アクセシビリティ改善

### 2026-08-09 アプリ全体レビューで修正した項目
critic エージェント3体（services層／画面層／カメラ・OCR・基盤）を並列でアプリ全体にかけ、
見つかった実害のあるバグを修正した。

- [x] `ListHeaderComponent={renderHeader}` が毎レンダー新しい関数参照になり、VirtualizedList が
  ヘッダー（検索欄含む）を丸ごと再マウントしていた。**検索欄に1文字打つたびにキーボードが
  閉じる**という致命的な不具合になっていたはず。`ListHeaderComponent={renderHeader()}` に修正。
- [x] デモ漏れ3件目・4件目（`pendingAppendRows`／`RowsCacheService` に続く同パターン）:
  `SettingsScreen.tsx` の「未送信の変更」一覧、`LastBatchService`（`CameraScreen.saveRows`）が
  マスクされない実データをそれぞれ画面表示・端末ファイルに残していた。両方ともデモ中は
  スキップするよう修正。サインアウト時に `LastBatch.clearLastBatch()` も呼ぶようにした。
- [x] `providers/geminiModels.ts` の `console.warn` が生の axios エラー（リクエストの
  `params`＝APIキーを含む）をそのまま渡しており、モデル一覧取得の失敗のたびに
  Gemini API キーがログに出る経路があった。メッセージのみ渡すよう修正。
- [x] `CameraScreen.handleProcessPending`（バナーからの一括処理）が `AuthError` 後も
  残り全件に対して処理を続け、同じ Alert を件数分積んでいた。`processReceipt` が
  「再サインインが必要な状態で終わったか」を返すようにし、ループを打ち切るようにした。
- [x] `SheetsService.flushWriteQueue` が `AuthError` も他の一時失敗と同様に握りつぶし、
  `App.tsx` の `syncPending().catch()` が実質デッドコードになっていた（本当にセッションが
  切れていても自動送信経路ではサインアウトさせられなかった）。`AuthError` は再スローし、
  `App.tsx`／`SettingsScreen.tsx` 双方で受けてサインアウト状態にするようにした。
- [x] 未送信キューの部分送信（例: 3件中2件成功）で、送れた分が `pendingAppendRows`
  （表示専用）からは消えるのに `rows` にはまだ反映されておらず、一覧から一時的に
  消えたように見えていた。件数が「0になった時」ではなく「減った時」に再読込するよう修正。
- [x] 明細編集モーダルの日時欄が無検証で任意の文字列をそのまま保存できた
  （`sheetNameFromTimestamp`／重複検出は正規表現前提のため壊れうる）。
  `ReceiptReviewModal.tsx` の `normalizeTimestampInput` を再利用して保存前に検証するよう修正。
- [x] OCR が返す `category` が候補一覧に対して検証されておらず、表記ゆれ等で孤立した
  カテゴリがそのまま書き込まれうる問題を修正（候補外なら空文字＝「未設定」扱いに寄せる。
  固定の「その他」に寄せると、それ自体が候補一覧に無い場合に同じ問題を再生産するため避けた）。
- [x] `CameraScreen.handlePickImage`（ギャラリー選択）が `busy` セットをピッカー起動前に
  行っておらず、連打で多重起動しうる非対称さがあった。撮影ボタン側と揃えた。
- [x] `SummaryScreen` の `currentRange` は `rangeOptions` 読み込み前後でオブジェクト参照が
  変わり（中身が同じでも）、起動直後に一覧取得が2回走っていた。`useEffect` の依存を
  内容ベースの `currentRangeSignature`（文字列）に変更。
- [x] `httpRetry.ts` の `retryDelayMs` が `Retry-After` ヘッダーの値を指数バックオフ用の
  `MAX_DELAY_MS=8000` で無条件にキャップしており、コメントの意図（Retry-After優先）と
  実装が食い違っていた。Retry-After 専用の上限（30秒）を別に設けた。

### 2026-08-12 追加修正（レビューで見送っていたうち、安く塞げる2件）

- [x] **新しい月シートの初回作成時、ヘッダー書き込みが直後の追記を消しうる問題**
  （`SheetsService.writeHeaderRow`）。`addSheet` してからヘッダーを A1 へ PUT するまでの間に、
  別プロセス（夫婦の別端末、または同一端末の Gmail 自動取込と固定費月初コピーの並行実行）が
  「シートはもう在る＝ヘッダーも書かれている」と判断して先に 1 行を追記すると、
  ヘッダーがまだ無いのでその追記は 1 行目に入り、後から確定するヘッダー PUT に消されていた。
  **ヘッダーを無条件 PUT せず、先に A1:L1 を読んで分岐するようにした**:
  空なら通常どおり PUT / 既にヘッダーなら何もしない / 明細行が入っていたら
  `insertDimension` で上に 1 行差し込んでからヘッダーを書く（明細を消さない）。
  追加コストは新規シート作成時の GET 1 回だけ（月 1 回）。
  - 残る穴: ヘッダー書き込み前にアプリが落ちると、1 行目が明細のままのシートが残り、
    以降 `ensureSheet` は「存在する」と判断するので誰も直さない。その行は `getRows` に
    ヘッダーとして読み飛ばされ一覧に出ない。発生条件が狭いため未対応。
- [x] **OCR に中止手段が無かった問題**（`CameraScreen` / `GeminiProvider` / `AIProvider`）。
  429 が複数モデルで連続すると最悪 7 分半ほど「OCR解析中...」のまま操作できなかった。
  `AbortSignal` を `extractReceipts` まで通し、**進捗表示の横に「中止」ボタン**を出すようにした。
  中止は失敗扱いにしない（リトライも 3 択ダイアログも出さず、画像は pending に残すので
  バナーから後で再開できる）。モデルを乗り換える手前でも毎回 abort を見るので、
  「中止したのに次のモデルを試し始める」ことはない。新しい `CancelledError` で識別する。

### 既知の未修正課題（2026-08-09 レビューで発見・対応は見送り）
いずれも設計変更を伴う・発生頻度が低い・拙速に直すと別の不具合を生みやすいと判断し、
修正せず記録のみ。着手する際はこの節を更新すること。

- **未送信キューの古い項目が、後から成功した直接編集を上書きしうる**（`WriteQueueService`）。
  例: オフラインで行Aの一部計上をトグル→失敗しキューに積まれる（画面は楽観的更新）→
  電波が戻り同じ行Aのメモを直接編集→成功→その後キューの自動送信/手動送信が走ると、
  古いキュー項目がそのまま送られ、後から直した内容を上書きする。直すには「同じ
  `sheetName+rowIndex` への新しい直接書き込みが成功したら、キュー内の古い同一行の項目を
  無効化する」設計が要る。単純に破棄すると別フィールドへの pending な変更を消してしまう
  ケースがあるため、コアレシング（差分のマージ）の設計から考える必要がある。
  **残課題のうち実害が一番大きいのはこれ。次に手を入れるならここ。**
- **固定費の月初自動コピーが端末をまたいで二重作成されうる**（`applyRecurringEntries`）。
  重複防止はその場でシートを読み取って作るキー集合のみで、「適用済み月」フラグは端末ローカル
  保存のため、夫婦の2台がほぼ同時に月初起動すると両方が「まだ無い」と判定し同じ固定費行を
  2つ作りうる。発生条件が狭い（月初にほぼ同時起動）うえ、重複は一覧で見て消せるため優先度は低い。
- **コード重複**: `pad2()`/`nowLabel()`、ファイル読み込み→JSONパース→壊れていたら空配列
  にフォールバックする `load()`/`persist()` パターンが `WriteQueueService.ts` と
  `RowsCacheService.ts` にほぼ同一の形で重複している。共通ユーティリティへの切り出しを検討。

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
068529b feat: 一覧読み込み失敗時の再試行バナーと未送信追加行の送信待ち表示を追加  ← 現在の HEAD（未 push）
b95e2ba feat: 複数枚の読み取り結果を保存前に確認・編集できるようにする
fb69891 fix: レシート日付の取りこぼしを直しOCRの精度設定を追加
1839cdf feat: 1枚の画像に並べた複数レシートをまとめて読み取る
e8eee85 docs: リトライ・未送信キュー・ErrorBoundaryの仕組みをHANDOFFに反映
f34883a feat: 送れなかった書き込みを端末に退避して後で自動送信する
41a6f5f feat: ErrorBoundaryを追加してクラッシュ時の白画面を回避する
be03884 feat: Sheets/Gmailの429・5xx・通信断を指数バックオフで自動リトライ
24b82de docs: 恒久キーストアは見送りの決定を記録
aeb4e13 docs: PATのworkflowスコープ制約を追記
b4aa70a fix: Geminiのモデル名を固定せずListModelsから実行時に解決する
83b5f71 feat: カテゴリ選択で明細を絞り込み・デモモードでカテゴリ別合計を編集可能に
8f78d20 feat: デモモード追加・Google再ログイン対策・内部配布プロファイル
d134982 feat: カテゴリ人別表示切替・固定費月初自動作成          ← ビルド#11 成功
```

## 11. 過去にハマった点（同じ失敗を繰り返さないため）

1. **「Missing required parameter: client_id」の真因は GitHub Secrets が 1 つも未設定だったこと。**
   `.env` の YAML ヒアドキュメントのインデント問題だと推測して先に修正したが的外れだった。
   → 環境変数系の不具合は、まず**シークレットが存在するか**を確認する。
2. ビルドの進行状況を確認せずに「まだ実行中です」と報告してしまった。
   → Actions の状態は `mcp__github__actions_list` で確認してから報告する。
3. アイコン生成でモックアップの 💰 絵文字ではなくテキストの「¥」を使ってしまった。
   → デザイン指示は元のモックアップと突き合わせて確認する。
4. **「たまに日付がおかしい」の真因は、モデルの誤読よりアプリ側の厳密一致だった。**
   `YYYY-MM-DD` 以外を黙って撮影日に置き換えていたため、`2026-4-7` のようなゼロ埋め無しの
   返答が返るたびにレシートの日付が捨てられていた（2026-08-07 修正）。
   → モデルの出力形式は信用せず、**受け入れ側を寛容にしてから妥当性を検証する**。
