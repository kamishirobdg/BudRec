/**
 * AI OCR プロバイダーの共通インターフェース。
 * Gemini / Claude / OpenAI などを差し替え可能にする。
 */

/** 品目の種類。食事の記録で候補に使うのは ingredient / packaged だけ */
export type ItemKind = 'ingredient' | 'packaged' | 'non_food';

/** 保存のしかた。冷凍・常温は日持ちするので、自炊の候補に残す期間が長い */
export type ItemStorage = 'chilled' | 'frozen' | 'ambient';

export interface ReceiptItem {
  /** レシート・メールの表記そのまま（半角カナ・略称を含む） */
  name:      string;
  price:     number;
  /** 正規化した品名（半角カナの展開・略称の解決） */
  normalized?: string;
  quantity?: number;
  unit?:     string;
  kind?:     ItemKind;
  storage?:  ItemStorage;
  /** 買ってから食べきるまでの目安の日数（品目ごとの推定） */
  shelfDays?: number;
  /** 入っている個数（6 本入りなら 6）。数えられないものは省略 */
  pieces?:   number;
  /** 店のオリジナル商品（コンビニ・スーパーの PB、店内調理の弁当・総菜・パン）。食品データの鍵を店ごとに分ける */
  ownBrand?: boolean;
}

/**
 * ユーザーが OCR を中断したときに投げる。
 * 呼び出し側はこれを「失敗」として扱わない（エラーダイアログを出さず、画像も残す）。
 */
export class CancelledError extends Error {
  constructor() {
    super('OCR を中止しました');
    this.name = 'CancelledError';
  }
}

/**
 * 日単位の無料枠を使い切ったときに投げる。呼び出し側は失敗にせず「推定待ち」にして、
 * `retryAt`（エポックミリ秒）を過ぎてから処理し直す。
 */
export class QuotaExceededError extends Error {
  constructor(public readonly retryAt: number) {
    super('Gemini の無料枠を使い切りました');
    this.name = 'QuotaExceededError';
  }
}

export interface ReceiptData {
  store:    string;
  amount:   number;
  category: string;       // categories から選ばれた値（または「その他」）
  date:     string;       // YYYY-MM-DD に正規化済み（読み取れなければ空文字）
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
   * @param signal      中断用。ユーザーが「キャンセル」を押したときに abort される。
   *                    abort されたら CancelledError を投げること。
   */
  extractReceipts(imageBase64: string, categories: string[], signal?: AbortSignal): Promise<ReceiptData[]>;

  /**
   * メール本文（プレーンテキスト）から取引情報を抽出する。
   * 取引情報が含まれない場合は amount を 0 で返す（呼び出し側でスキップ判定）。
   */
  extractEmail(emailText: string, categories: string[]): Promise<ReceiptData>;
}

/** プロバイダー共通のプロンプト生成 */
export function buildReceiptPrompt(categories: string[]): string {
  return `あなたはレシートOCRアシスタントです。画像に写っているレシートを**すべて**読み取り、JSONのみを返してください。説明文・コードブロック記号・前後のテキストは一切不要です。

${receiptRules(categories)}`;
}

/**
 * 撮った写真を 1 回の呼び出しで「レシート」と「料理・食品」に振り分けて読む。
 * 撮影時に種類を選ばせないため。呼び出し回数はレシートだけを読む場合と変わらない。
 * @param dishGuide 料理の各項目の説明（GeminiMeal 側で作る。撮った人・相手・手修正の傾向を含む）
 */
export function buildPhotoPrompt(categories: string[], dishGuide: string): string {
  return `あなたは家計簿と食事記録のアシスタントです。写真に写っているものを読み取り、JSONのみを返してください。説明文・コードブロック記号・前後のテキストは一切不要です。

写真には「レシート」と「料理・食品」のどちらか、または両方が写っています。
- レシートは receipts に、料理・食品は dishes に入れる。写っていない方は空配列にする
- 両方が写っていれば両方とも入れる
- 料理の写真に写り込んだメニュー表・値札・伝票はレシートとして扱わない

# receipts の書き方

${receiptRules(categories)}

# dishes の書き方

${dishGuide}`;
}

function receiptRules(categories: string[]): string {
  const list = categories.map((c) => `- ${c}`).join('\n');
  return `【複数レシートの扱い】
1 枚の画像に複数のレシートを並べて撮影することがあります。その場合はレシートごとに
1 オブジェクトを作り、receipts 配列に並べてください。1 枚しか写っていなければ要素は 1 つです。
- 1 枚のレシート = 1 オブジェクト。勝手に分割したり、複数枚を合算したりしない。
- 長いレシートが折れ曲がって写っている場合や、明細が 2 段に見える場合も 1 件として扱う。
- 合計金額が読み取れないレシートは受け取らない（推測で埋めず、その要素ごと省く）。
- レシート以外のもの（手書きメモ・紙の切れ端・背景）は無視する。

各レシートで抽出する項目:
- store: 店名
- amount: 合計金額（数値、円記号やカンマ無し）
- date: レシートに印字された**購入日**を YYYY-MM-DD 形式で。
  - 有効期限・ポイント有効期限・次回来店期限・キャンペーン期間を購入日と取り違えない
  - 和暦（令和8年4月7日 / R8.4.7）は西暦に直す
  - 年が印字されていない場合は月日だけ（MM-DD）を返してよい。年を推測で補わない
  - どこにも日付が無ければ空文字
- time: レシートに印字された**購入時刻**を HH:MM 形式（24時間表記）で。無ければ空文字。推測しない。
- category: 以下のリストから最も適切な1つを選ぶ。該当が無ければ「その他」。
- items: 購入品の配列（任意）。${ITEM_FIELDS_GUIDE}

カテゴリ候補:
${list}

出力例（レシート 2 枚が写っている画像）:
{"receipts":[{"store":"セブンイレブン","amount":1280,"date":"2026-04-07","time":"18:42","category":"食費","items":[{"name":"ﾂﾅﾏﾖｵﾆｷﾞﾘ","price":150,"normalized":"ツナマヨおにぎり","quantity":1,"unit":"個","kind":"packaged","storage":"chilled","shelfDays":1,"pieces":1,"ownBrand":true}]},{"store":"マツモトキヨシ","amount":3480,"date":"2026-04-07","time":"19:05","category":"日用品","items":[]}]}`;
}

/** 品目の各項目の説明（レシート・メール共通） */
const ITEM_FIELDS_GUIDE = `各品目の項目:
  - name: レシート・メールの表記そのまま（半角カナや略称も直さない）
  - price: その品目の金額（数値）
  - normalized: 一般的な品名に直したもの（例: ｺｸｻﾝﾌﾞﾀｺﾏ → 国産豚こま切れ肉）。直せなければ name と同じ。
    商品名のある商品（メーカー品・店のオリジナル商品）は商品名を残す（例: ﾌｧﾐﾁｷ → ファミチキ。「からあげ」のような一般名にしない）
  - quantity / unit: 内容量か個数（例: 300 / g、2 / 個、1 / パック）。表記に無ければ省略する。推測しない
  - kind: ingredient（調理に使う食材・調味料）/ packaged（弁当・パン・菓子・飲料・アイスなどそのまま食べる食品）/ non_food（食品以外）
  - storage: 食品の保存のしかた。chilled（冷蔵）/ frozen（冷凍食品・アイス）/ ambient（常温。米・乾物・調味料・缶詰・菓子など）。食品以外は省略
  - shelfDays: 買ってから食べきるまでの目安の日数（例: 肉・魚 3、卵 14、牛乳 7、冷凍食品 60、米 60）。食品以外は省略
  - pieces: 個数で数えられる商品の入り数（アイス 6 本入りなら 6、ヨーグルト 4 個パックなら 4、1 個売りなら 1）。数えられないもの（肉 300g など）は省略
  - ownBrand: その店（チェーン）でしか売っていない商品なら true。コンビニ・スーパーのプライベートブランド（セブンプレミアム、ファミマル、トップバリュなど）、
    店で作った弁当・おにぎり・サンドイッチ・総菜・パン、店の名前が付いた商品（ファミチキ、からあげクンなど）。メーカーの商品・生鮮食材・食品以外は false`;

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
- items: 購入品の配列。複数ある場合はすべて列挙。${ITEM_FIELDS_GUIDE}

カテゴリ候補:
${list}

出力例（複数商品のAmazon注文）:
{"store":"Amazon","amount":19308,"date":"2026-04-12","category":"日用品","items":[{"name":"ノヴァージュ液体洗剤","price":1200},{"name":"モバイルバッテリー","price":6990},{"name":"充電池","price":1318},{"name":"骨盤クッション","price":11000}]}

出力例（取引でない）:
{"store":"","amount":0,"date":"","category":"その他","items":[]}`;
}

// ─── 出力スキーマ（Gemini の responseSchema にそのまま渡せる形） ─────────────
// 形式が保証されるとパース失敗と項目欠落が消える。値の正しさは保証されないので、
// 日付の妥当性は normalizeDateString と呼び出し側のチェックで担保する。

const RECEIPT_PROPERTIES = {
  store:    { type: 'STRING' },
  amount:   { type: 'NUMBER' },
  date:     { type: 'STRING' },
  time:     { type: 'STRING' },
  category: { type: 'STRING' },
  items: {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        name:       { type: 'STRING' },
        price:      { type: 'NUMBER' },
        normalized: { type: 'STRING' },
        quantity:   { type: 'NUMBER' },
        unit:       { type: 'STRING' },
        kind:       { type: 'STRING', enum: ['ingredient', 'packaged', 'non_food'] },
        storage:    { type: 'STRING', enum: ['chilled', 'frozen', 'ambient'] },
        shelfDays:  { type: 'NUMBER' },
        pieces:     { type: 'NUMBER' },
        ownBrand:   { type: 'BOOLEAN' },
      },
      required: ['name', 'price'],
      propertyOrdering: ['name', 'price', 'normalized', 'quantity', 'unit', 'kind', 'storage', 'shelfDays', 'pieces', 'ownBrand'],
    },
  },
} as const;

const RECEIPT_REQUIRED = ['store', 'amount', 'date', 'category'];

/** 1 件分のレシートのスキーマ（写真の振り分けでも使う） */
export const RECEIPT_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: RECEIPT_PROPERTIES,
  required: RECEIPT_REQUIRED,
  propertyOrdering: ['store', 'amount', 'date', 'time', 'category', 'items'],
};

/** レシート画像用（複数枚ぶんを receipts 配列で受ける） */
export const RECEIPT_LIST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    receipts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: RECEIPT_PROPERTIES,
        required: RECEIPT_REQUIRED,
        propertyOrdering: ['store', 'amount', 'date', 'time', 'category', 'items'],
      },
    },
  },
  required: ['receipts'],
};

/** メール本文用（常に 1 件） */
export const EMAIL_RECEIPT_SCHEMA = {
  type: 'OBJECT',
  properties: RECEIPT_PROPERTIES,
  required: RECEIPT_REQUIRED,
  propertyOrdering: ['store', 'amount', 'date', 'time', 'category', 'items'],
};

// ─── 日付の正規化 ────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 実在する日付か（2026-13-45 のような値をここで落とす） */
function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 2000 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  // 数値引数の Date は Hermes でも安全（文字列パースだけが壊れる）
  return d >= 1 && d <= new Date(y, m, 0).getDate();
}

function buildYmd(y: number, m: number, d: number): string {
  return isValidYmd(y, m, d) ? `${y}-${pad2(m)}-${pad2(d)}` : '';
}

function ymdOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * モデルが返した日付表記を YYYY-MM-DD に揃える。解釈できなければ空文字。
 *
 * 指示した形式を外して返してくることがあり、厳密一致で弾くとレシートの日付が
 * 黙って撮影日に化ける（実際にこれが起きていた）。ゼロ埋め無し・区切り違い・
 * 和暦・年の省略を受け付ける。**存在しない日付はここで空文字にする。**
 */
export function normalizeDateString(raw: string, today: Date = new Date()): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';

  // 令和8年4月7日 / R8.4.7 / 令和 8-04-07
  const wareki = s.match(/(?:令和|reiwa|R)\s*(\d{1,2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/i);
  if (wareki) {
    return buildYmd(2018 + Number(wareki[1]), Number(wareki[2]), Number(wareki[3]));
  }

  // 2026-04-07 / 2026/4/7 / 2026.4.7 / 2026年4月7日
  const ymd = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (ymd) return buildYmd(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));

  // 26-04-07（2 桁年）
  const short = s.match(/^(\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
  if (short) return buildYmd(2000 + Number(short[1]), Number(short[2]), Number(short[3]));

  // 04-07 / 4月7日（年が印字されていないレシート）→ 今年。未来になるなら前年と解釈する
  const md = s.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    const thisYear = buildYmd(today.getFullYear(), m, d);
    if (!thisYear) return '';
    // YYYY-MM-DD は辞書順＝時系列順なので文字列比較でよい
    return thisYear > ymdOf(today) ? buildYmd(today.getFullYear() - 1, m, d) : thisYear;
  }

  return '';
}

/** モデルの返答を JSON として読む（コードブロックで返された場合に備えて剥がす） */
export function parseJson(raw: string): any {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // grounding を使うと JSON の前後に説明文が付くことがある。最初の { から最後の } までを読む
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // 下で投げる
      }
    }
    throw new Error(`AI 応答の JSON パースに失敗: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * 1 件ぶんの JSON オブジェクトを ReceiptData に変換。
 * `categories` を渡した場合、モデルが返した category がその候補に無ければ空文字にする
 * （プロンプトで候補を指定していても表記ゆれ等で候補外の文字列を返すことがあり、素通しすると
 * 集計・絞り込みから漏れる孤立カテゴリになるため）。空文字は一覧側で「未設定」として扱われる
 * 既存の仕組みに乗せる。fallbackCategory（既定「その他」）自体が候補一覧に無いことがあるため、
 * ここでは代わりに使わない。
 */
function toReceiptData(parsed: any, raw: string, fallbackCategory: string, categories: string[]): ReceiptData {
  const rawDate = String(parsed?.date ?? '');
  const date    = normalizeDateString(rawDate);
  if (rawDate && !date) {
    console.warn('[OCR] 日付として解釈できなかったので撮影日を使う:', rawDate);
  }
  const providedCategory = parsed?.category != null ? String(parsed.category) : null;
  const category =
    providedCategory === null
      ? fallbackCategory
      : categories.length === 0 || categories.includes(providedCategory)
        ? providedCategory
        : '';
  return {
    store:    String(parsed?.store ?? ''),
    amount:   Number(parsed?.amount ?? 0),
    category,
    date,
    time:     parsed?.time ? String(parsed.time) : undefined,
    items:    Array.isArray(parsed?.items) ? parsed.items.map(toReceiptItem).filter(Boolean) as ReceiptItem[] : undefined,
    raw,
  };
}

const ITEM_KINDS: readonly string[] = ['ingredient', 'packaged', 'non_food'];

/** モデルが返した品目を整える。品名の無いものは捨てる */
function toReceiptItem(raw: any): ReceiptItem | null {
  const name = String(raw?.name ?? '').trim();
  if (!name) return null;
  const price    = Number(raw?.price);
  const quantity = Number(raw?.quantity);
  const kind     = String(raw?.kind ?? '');
  const storage  = String(raw?.storage ?? '');
  const shelfDays = Number(raw?.shelfDays);
  const pieces    = Number(raw?.pieces);
  const normalized = String(raw?.normalized ?? '').trim();
  const unit       = String(raw?.unit ?? '').trim();
  return {
    name,
    price:      Number.isFinite(price) ? price : 0,
    normalized: normalized || undefined,
    quantity:   Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
    unit:       unit || undefined,
    kind:       ITEM_KINDS.includes(kind) ? (kind as ItemKind) : undefined,
    storage:    ['chilled', 'frozen', 'ambient'].includes(storage) ? (storage as ItemStorage) : undefined,
    shelfDays:  Number.isFinite(shelfDays) && shelfDays > 0 ? Math.round(shelfDays) : undefined,
    pieces:     Number.isFinite(pieces) && pieces >= 1 ? Math.round(pieces) : undefined,
    ownBrand:   raw?.ownBrand === true ? true : undefined,
  };
}

/** モデルの返答 JSON を ReceiptData にパース（メール用・常に 1 件） */
export function parseReceiptResponse(raw: string, categories: string[] = [], fallbackCategory = 'その他'): ReceiptData {
  return toReceiptData(parseJson(raw), raw, fallbackCategory, categories);
}

/**
 * レシート画像の返答をパースする。
 * モデルが指示した形を崩すことがあるので、次のいずれも受け付ける:
 *   `{"receipts":[...]}` / `[...]` / `{"store":...}`（1 件だけを裸で返した場合）
 */
export function parseReceiptList(raw: string, categories: string[] = [], fallbackCategory = 'その他'): ReceiptData[] {
  return receiptsFromParsed(parseJson(raw), raw, categories, fallbackCategory);
}

/** 読み込み済みの JSON からレシートを取り出す（写真の振り分けでも使う） */
export function receiptsFromParsed(parsed: any, raw: string, categories: string[] = [], fallbackCategory = 'その他'): ReceiptData[] {
  const list: any[] =
    Array.isArray(parsed)              ? parsed :
    Array.isArray(parsed?.receipts)    ? parsed.receipts :
    parsed && typeof parsed === 'object' ? [parsed] :
    [];
  return list.map((r) => toReceiptData(r, raw, fallbackCategory, categories));
}
