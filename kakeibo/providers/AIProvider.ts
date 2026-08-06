/**
 * AI OCR プロバイダーの共通インターフェース。
 * Gemini / Claude / OpenAI などを差し替え可能にする。
 */

export interface ReceiptItem {
  name:  string;
  price: number;
}

export interface ReceiptData {
  store:    string;
  amount:   number;
  category: string;       // categories から選ばれた値（または「その他」）
  date:     string;       // YYYY-MM-DD（取得できなければ空文字）
  time?:    string;       // HH:MM（取得できなければ undefined / 空文字）
  items?:   ReceiptItem[];
  raw:      string;       // モデルの生レスポンス（デバッグ用）
}

export interface AIProvider {
  /** プロバイダー識別名（'gemini' / 'claude' / 'openai' など） */
  readonly name: string;

  /**
   * レシート画像から構造化データを抽出する。
   * **1 枚の画像に複数のレシートが並べて写っている場合は、その枚数ぶん返す。**
   * @param imageBase64 画像の base64 文字列（data: プレフィックス無し）
   * @param categories  選択肢となるカテゴリ一覧。モデルはこの中から1つ選ぶ。
   */
  extractReceipts(imageBase64: string, categories: string[]): Promise<ReceiptData[]>;

  /**
   * メール本文（プレーンテキスト）から取引情報を抽出する。
   * 取引情報が含まれない場合は amount を 0 で返す（呼び出し側でスキップ判定）。
   */
  extractEmail(emailText: string, categories: string[]): Promise<ReceiptData>;
}

/** プロバイダー共通のプロンプト生成 */
export function buildReceiptPrompt(categories: string[]): string {
  const list = categories.map((c) => `- ${c}`).join('\n');
  return `あなたはレシートOCRアシスタントです。画像に写っているレシートを**すべて**読み取り、JSONのみを返してください。説明文・コードブロック記号・前後のテキストは一切不要です。

【複数レシートの扱い】
1 枚の画像に複数のレシートを並べて撮影することがあります。その場合はレシートごとに
1 オブジェクトを作り、receipts 配列に並べてください。1 枚しか写っていなければ要素は 1 つです。
- 1 枚のレシート = 1 オブジェクト。勝手に分割したり、複数枚を合算したりしない。
- 長いレシートが折れ曲がって写っている場合や、明細が 2 段に見える場合も 1 件として扱う。
- 合計金額が読み取れないレシートは受け取らない（推測で埋めず、その要素ごと省く）。
- レシート以外のもの（手書きメモ・紙の切れ端・背景）は無視する。

各レシートで抽出する項目:
- store: 店名
- amount: 合計金額（数値、円記号やカンマ無し）
- date: 日付（YYYY-MM-DD 形式）。レシートに無ければ空文字。
- time: 時刻（HH:MM 形式、24時間表記）。レシートに無ければ空文字。
- category: 以下のリストから最も適切な1つを選ぶ。該当が無ければ「その他」。
- items: 購入品の配列（任意、{name, price} の形式）

カテゴリ候補:
${list}

出力例（レシート 2 枚が写っている画像）:
{"receipts":[{"store":"セブンイレブン","amount":1280,"date":"2026-04-07","time":"18:42","category":"食費","items":[{"name":"おにぎり","price":150}]},{"store":"マツモトキヨシ","amount":3480,"date":"2026-04-07","time":"19:05","category":"日用品","items":[]}]}`;
}

/** メール本文用プロンプト（取引でない場合は amount=0 を返させる） */
export function buildEmailPrompt(categories: string[]): string {
  const list = categories.map((c) => `- ${c}`).join('\n');
  return `あなたは家計簿アシスタントです。以下のメール本文から購入/利用情報を抽出し、JSONのみを返してください。説明文・コードブロック記号・前後のテキストは一切不要です。

【取引メールの判定基準】
以下はすべて取引メールとして扱う:
- ECサイトの注文確認・注文済みメール（Amazon「ご注文ありがとうございます」等）
- クレジットカード・デビットカードの利用通知
- 銀行振込・引落通知
- サブスクリプション・定期購読の決済通知
- 電子マネー（Suica・PayPay等）のチャージ・利用通知
- 公共料金・保険料等の請求・引落通知

以下は取引でないとして amount=0 を返す:
- 純粋な広告・宣伝メール（購入していない）
- ポイント付与のみの通知（金銭の支払いを伴わない）
- 配送状況のみの通知（発送済み・配達済みのみで金額なし）

【金額の抽出ルール】
- 「合計」「請求金額」「お支払い金額」等の最終合計を使う
- 1通に複数の注文・配送が含まれる場合は全注文の合計金額を合算する
- 明示的な合計金額がない場合は商品価格をすべて合算する
- 割引・クーポン適用後の金額を使う

抽出する項目:
- store: 店舗名 / 加盟店名 / EC サイト名
- amount: 金額（数値、円記号やカンマ無し、税込）。取引でなければ 0。
- date: 取引日（YYYY-MM-DD 形式）。不明なら空文字。
- category: 以下のリストから最も適切な1つを選ぶ。該当が無ければ「その他」。
- items: 購入品の配列（{name, price}）。複数ある場合はすべて列挙。

カテゴリ候補:
${list}

出力例（複数商品のAmazon注文）:
{"store":"Amazon","amount":19308,"date":"2026-04-12","category":"日用品","items":[{"name":"ノヴァージュ液体洗剤","price":1200},{"name":"モバイルバッテリー","price":6990},{"name":"充電池","price":1318},{"name":"骨盤クッション","price":11000}]}

出力例（取引でない）:
{"store":"","amount":0,"date":"","category":"その他","items":[]}`;
}

/** モデルの返答を JSON として読む（コードブロックで返された場合に備えて剥がす） */
function parseJson(raw: string): any {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI 応答の JSON パースに失敗: ${cleaned.slice(0, 200)}`);
  }
}

/** 1 件ぶんの JSON オブジェクトを ReceiptData に変換 */
function toReceiptData(parsed: any, raw: string, fallbackCategory: string): ReceiptData {
  return {
    store:    String(parsed?.store ?? ''),
    amount:   Number(parsed?.amount ?? 0),
    category: String(parsed?.category ?? fallbackCategory),
    date:     String(parsed?.date ?? ''),
    time:     parsed?.time ? String(parsed.time) : undefined,
    items:    Array.isArray(parsed?.items) ? parsed.items : undefined,
    raw,
  };
}

/** モデルの返答 JSON を ReceiptData にパース（メール用・常に 1 件） */
export function parseReceiptResponse(raw: string, fallbackCategory = 'その他'): ReceiptData {
  return toReceiptData(parseJson(raw), raw, fallbackCategory);
}

/**
 * レシート画像の返答をパースする。
 * モデルが指示した形を崩すことがあるので、次のいずれも受け付ける:
 *   `{"receipts":[...]}` / `[...]` / `{"store":...}`（1 件だけを裸で返した場合）
 */
export function parseReceiptList(raw: string, fallbackCategory = 'その他'): ReceiptData[] {
  const parsed = parseJson(raw);
  const list: any[] =
    Array.isArray(parsed)              ? parsed :
    Array.isArray(parsed?.receipts)    ? parsed.receipts :
    parsed && typeof parsed === 'object' ? [parsed] :
    [];
  return list.map((r) => toReceiptData(r, raw, fallbackCategory));
}
