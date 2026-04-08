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
  date:     string;       // YYYY-MM-DD
  items?:   ReceiptItem[];
  raw:      string;       // モデルの生レスポンス（デバッグ用）
}

export interface AIProvider {
  /** プロバイダー識別名（'gemini' / 'claude' / 'openai' など） */
  readonly name: string;

  /**
   * レシート画像から構造化データを抽出する。
   * @param imageBase64 画像の base64 文字列（data: プレフィックス無し）
   * @param categories  選択肢となるカテゴリ一覧。モデルはこの中から1つ選ぶ。
   */
  extractReceipt(imageBase64: string, categories: string[]): Promise<ReceiptData>;

  /**
   * メール本文（プレーンテキスト）から取引情報を抽出する。
   * 取引情報が含まれない場合は amount を 0 で返す（呼び出し側でスキップ判定）。
   */
  extractEmail(emailText: string, categories: string[]): Promise<ReceiptData>;
}

/** プロバイダー共通のプロンプト生成 */
export function buildReceiptPrompt(categories: string[]): string {
  const list = categories.map((c) => `- ${c}`).join('\n');
  return `あなたはレシートOCRアシスタントです。画像のレシートから以下の情報を抽出し、JSONのみを返してください。説明文・コードブロック記号・前後のテキストは一切不要です。

抽出する項目:
- store: 店名
- amount: 合計金額（数値、円記号やカンマ無し）
- date: 日付（YYYY-MM-DD 形式）
- category: 以下のリストから最も適切な1つを選ぶ。該当が無ければ「その他」。
- items: 購入品の配列（任意、{name, price} の形式）

カテゴリ候補:
${list}

出力例:
{"store":"セブンイレブン","amount":1280,"date":"2026-04-07","category":"食費","items":[{"name":"おにぎり","price":150}]}`;
}

/** メール本文用プロンプト（取引でない場合は amount=0 を返させる） */
export function buildEmailPrompt(categories: string[]): string {
  const list = categories.map((c) => `- ${c}`).join('\n');
  return `あなたは家計簿アシスタントです。以下のメール本文から購入/利用情報を抽出し、JSONのみを返してください。説明文・コードブロック記号・前後のテキストは一切不要です。

抽出ルール:
- 取引メール（カード利用通知、ECサイトの注文確認等）の場合: 取引情報を抽出する。
- 取引でない場合（広告、ポイント通知、お知らせ等）: amount を 0 にする。

抽出する項目:
- store: 店舗名 / 加盟店名 / EC サイト名
- amount: 金額（数値、円記号やカンマ無し、税込）。取引でなければ 0。
- date: 取引日（YYYY-MM-DD 形式）。不明なら空文字。
- category: 以下のリストから最も適切な1つを選ぶ。該当が無ければ「その他」。
- items: 購入品の配列（任意、{name, price}）

カテゴリ候補:
${list}

出力例（取引メール）:
{"store":"Amazon","amount":2480,"date":"2026-04-05","category":"日用品","items":[]}

出力例（取引でない）:
{"store":"","amount":0,"date":"","category":"その他","items":[]}`;
}

/** モデルの返答 JSON を ReceiptData にパース */
export function parseReceiptResponse(raw: string, fallbackCategory = 'その他'): ReceiptData {
  // モデルがコードブロックで返してきた場合に備えて剥がす
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI 応答の JSON パースに失敗: ${cleaned.slice(0, 200)}`);
  }

  return {
    store:    String(parsed.store ?? ''),
    amount:   Number(parsed.amount ?? 0),
    category: String(parsed.category ?? fallbackCategory),
    date:     String(parsed.date ?? ''),
    items:    Array.isArray(parsed.items) ? parsed.items : undefined,
    raw,
  };
}
