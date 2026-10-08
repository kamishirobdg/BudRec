/**
 * チェーン店の一覧（`_chains`）。外食のメニュー（`_menus`）をどのチェーンについて使うか（ON/OFF）と、
 * まだ取り込んでいない候補を持つ。仕様は docs/meal-nutrition-spec.md §3.9。
 *
 * | chain | genre | status | enabled | aliases | note | updated_at |
 *
 * - status: collected（メニューを取り込み済み）/ none（公式に栄養表示が無い）/ candidate（候補）/
 *   requested（調べてほしい。Claude Code か一括調査で調べて `_menus` に取り込む）
 * - enabled: collected のとき、メニューを照合に使うか
 * - aliases: 店名の別の書き方（「MOS BURGER」など。カンマ区切り）
 *
 * あわせて、スーパー・コンビニの店名からチェーン名を出す（店のオリジナル商品の鍵に使う）。
 */

import { SheetsInternal, getConfigValue, getRowsRaw, setConfigValue } from './SheetsService';
import { nowLabel } from './jsonFileStore';
import { callGemini } from '../providers/GeminiProvider';
import { parseJson } from '../providers/AIProvider';
import * as Demo from './DemoService';

const SHEET = '_chains';
const HEADER = ['chain', 'genre', 'status', 'enabled', 'aliases', 'note', 'updated_at'];

export type ChainStatus = 'collected' | 'none' | 'candidate' | 'requested';

export interface Chain {
  chain:    string;
  genre:    string;
  status:   ChainStatus;
  enabled:  boolean;
  aliases:  string[];
  note:     string;
  rowIndex: number;
}

/**
 * 飲食チェーンの別名（アプリに組み込みのもの。`_chains` の aliases 列と合わせて使う）。
 * 短すぎて別の店名にも含まれうる略称（「マック」→ マックスバリュ など）は入れない。
 */
const BUILTIN_ALIASES: Record<string, string[]> = {
  'マクドナルド':               ["McDonald's", 'McDonalds'],
  'モスバーガー':               ['MOS BURGER', 'MOSBURGER'],
  'バーガーキング':             ['BURGER KING'],
  'ドトール':                   ['DOUTOR'],
  'すき家':                     ['SUKIYA'],
  'ガスト':                     ['GUSTO'],
  'はま寿司':                   ['HAMA-SUSHI', 'HAMASUSHI', 'はまずし'],
  'ピザハット':                 ['PIZZA HUT', 'PIZZAHUT'],
  'コメダ珈琲店':               ['コメダ', 'KOMEDA'],
  'ケンタッキーフライドチキン': ['KFC', 'ケンタッキー', 'KENTUCKY'],
  'ミスタードーナツ':           ['ミスド', 'MISTER DONUT', 'MISTERDONUT'],
  'サンマルクカフェ':           ['サンマルク', 'ST.MARC', 'SAINT MARC'],
  'ドミノ・ピザ':               ["Domino's", 'DOMINOS'],
  '吉野家':                     ['YOSHINOYA'],
  'なか卯':                     ['NAKAU'],
  'やよい軒':                   ['YAYOIKEN'],
  '松のや':                     ['松乃家', 'MATSUNOYA'],
  'CoCo壱番屋':                 ['ココイチ', 'ココ壱', 'COCOICHI'],
  'リンガーハット':             ['RINGER HUT', 'RINGERHUT'],
  '天丼てんや':                 ['てんや', 'TENYA'],
  '富士そば':                   ['FUJISOBA'],
  'スシロー':                   ['SUSHIRO'],
  'しゃぶ葉':                   ['SHABUYO'],
  '洋麺屋五右衛門':             ['五右衛門', 'GOEMON'],
  'びっくりドンキー':           ['BIKKURI DONKEY'],
  'ペッパーランチ':             ['PEPPER LUNCH'],
  '回転寿司みさき':             ['みさき'],
  '壱角家':                     ['IKKAKUYA'],
  '銚子丸':                     ['CHOSHIMARU'],
  'カレーショップC&C':          ['C&C'],
  'ヴィ・ド・フランス':         ['VIE DE FRANCE'],
};

/**
 * スーパー・コンビニのチェーン名と別名。店のオリジナル商品（PB・店内調理）は
 * 「チェーン名|品名」の鍵で食品データに入れる（別の店の同じ名前の商品と混ざらないように）。
 */
const RETAIL_CHAINS: Record<string, string[]> = {
  'セブン-イレブン':  ['セブンイレブン', 'セブン‐イレブン', 'セブン－イレブン', '7-ELEVEN', 'SEVEN-ELEVEN', 'SEVEN ELEVEN'],
  'ファミリーマート': ['FamilyMart', 'ファミマ'],
  'ローソン':         ['LAWSON'],
  'デイリーヤマザキ': ['DAILY YAMAZAKI', 'デイリー ヤマザキ'],
  'ミニストップ':     ['MINISTOP'],
  'NewDays':          ['ニューデイズ', 'NEWDAYS'],
  'イオン':           ['AEON', 'イオンスタイル', 'まいばすけっと'],
  '生鮮市場TOP':      ['生鮮市場 TOP'],
  'コープみらい':     ['コープデリ'],
};

/** 店名の照合用に揃える（全角英数を半角に、空白・中黒・アポストロフィ・ハイフンを消し、小文字に） */
export function normalizeStore(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９＆．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　・'’\-‐－]/g, '')
    .toLowerCase();
}

/**
 * スーパー・コンビニの店名からチェーン名を出す（「ローソン 新東京ビル店」→「ローソン」）。
 * 表に無い店は、末尾の「〇〇店」を除いた店名にする。
 */
export function retailChainOf(store: string): string {
  const s = normalizeStore(store);
  if (!s) return '';
  for (const [chain, aliases] of Object.entries(RETAIL_CHAINS)) {
    if ([chain, ...aliases].some((n) => s.includes(normalizeStore(n)))) return chain;
  }
  const parts = store.trim().split(/\s+/);
  if (parts.length > 1 && /店$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

// ─── `_chains` の読み書き ─────────────────────────────────────────────────────

let cache: { chains: Chain[]; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

function fromCells(c: any[], rowIndex: number): Chain {
  const status = ['collected', 'none', 'candidate', 'requested'].includes(String(c[2])) ? String(c[2]) as ChainStatus : 'candidate';
  return {
    chain: String(c[0] ?? '').trim(),
    genre: String(c[1] ?? ''),
    status,
    enabled: String(c[3]).toUpperCase() !== 'FALSE',
    aliases: String(c[4] ?? '').split(/[,、]/).map((s) => s.trim()).filter(Boolean),
    note: String(c[5] ?? ''),
    rowIndex,
  };
}

function toCells(c: Chain): (string | number)[] {
  return [c.chain, c.genre, c.status, c.enabled ? 'TRUE' : 'FALSE', c.aliases.join(', '), c.note, nowLabel()];
}

export async function loadChains(force = false): Promise<Chain[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.chains;
  if (await Demo.isDemo()) return [];
  const client = await SheetsInternal.createClient();
  const names = await SheetsInternal.listSheetNames(client, true);
  const chains: Chain[] = [];
  if (names.includes(SHEET)) {
    const res = await client.get(`/values/${encodeURIComponent(SHEET)}!A:G`, {
      params: { valueRenderOption: 'UNFORMATTED_VALUE' },
    });
    ((res.data.values ?? []) as any[][]).forEach((c, i) => {
      if (i === 0 || !String(c[0] ?? '').trim()) return;
      chains.push(fromCells(c, i + 1));
    });
  }
  cache = { chains, at: Date.now() };
  return chains;
}

/** 照合に使わないチェーン（OFF にしたもの） */
export async function disabledChains(): Promise<Set<string>> {
  try {
    return new Set((await loadChains()).filter((c) => c.status === 'collected' && !c.enabled).map((c) => c.chain));
  } catch {
    return new Set();
  }
}

/** チェーン名と別名（組み込み + `_chains` の aliases） */
export async function chainAliases(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(Object.entries(BUILTIN_ALIASES));
  try {
    for (const c of await loadChains()) {
      if (c.aliases.length > 0) map.set(c.chain, [...new Set([...(map.get(c.chain) ?? []), ...c.aliases])]);
    }
  } catch {
    // 読めなければ組み込みの別名だけ
  }
  return map;
}

/** 書き換える（行があれば上書き、無ければ足す） */
export async function saveChains(list: Chain[]): Promise<void> {
  if (list.length === 0 || (await Demo.isDemo())) return;
  const client = await SheetsInternal.createClient();
  if (await SheetsInternal.ensureSheet(client, SHEET)) {
    await SheetsInternal.writeHeaderRow(client, SHEET, HEADER);
  }
  const updates = list.filter((c) => c.rowIndex > 0);
  const appends = list.filter((c) => c.rowIndex <= 0);
  if (updates.length > 0) {
    await client.post('/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: updates.map((c) => ({ range: `'${SHEET}'!A${c.rowIndex}:G${c.rowIndex}`, values: [toCells(c)] })),
    });
  }
  if (appends.length > 0) {
    await client.post(
      `/values/${encodeURIComponent(SHEET)}!A:G:append`,
      { values: appends.map(toCells) },
      { params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' } },
    );
  }
  cache = null;
}

// ─── 候補を探す ───────────────────────────────────────────────────────────────

const CONFIG_STATIONS = 'chain_stations';
const CONFIG_LIKES    = 'chain_likes';

export async function getSuggestConditions(): Promise<{ stations: string; likes: string }> {
  const [stations, likes] = await Promise.all([getConfigValue(CONFIG_STATIONS), getConfigValue(CONFIG_LIKES)]);
  return { stations, likes };
}

export async function setSuggestConditions(stations: string, likes: string): Promise<void> {
  await setConfigValue(CONFIG_STATIONS, stations);
  await setConfigValue(CONFIG_LIKES, likes);
}

/** 直近 12 か月に外食で行った店と回数（カテゴリ名に「外食」を含む支出行の店名） */
async function visitedStores(): Promise<{ store: string; count: number }[]> {
  const counts = new Map<string, number>();
  const now = new Date();
  for (let k = 0; k < 12; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    try {
      for (const r of await getRowsRaw(month)) {
        if (!r.category.includes('外食') || !r.store.trim()) continue;
        counts.set(r.store.trim(), (counts.get(r.store.trim()) ?? 0) + 1);
      }
    } catch {
      // その月のシートが無い
    }
  }
  return [...counts.entries()].map(([store, count]) => ({ store, count })).sort((a, b) => b.count - a.count).slice(0, 40);
}

const SUGGEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    chains: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          chain:   { type: 'STRING' },
          genre:   { type: 'STRING' },
          aliases: { type: 'ARRAY', items: { type: 'STRING' } },
          reason:  { type: 'STRING' },
        },
        required: ['chain', 'genre', 'reason'],
      },
    },
  },
  required: ['chains'],
};

/**
 * 行った店・生活圏の駅・好きなものから、メニューの栄養を取り込むとよいチェーン店の候補を出し、
 * `_chains` に candidate として足す。足した件数を返す。
 */
export async function suggestChains(stations: string, likes: string, signal?: AbortSignal): Promise<number> {
  await setSuggestConditions(stations, likes);
  const [visited, existing] = await Promise.all([visitedStores(), loadChains(true)]);
  const known = new Set(existing.map((c) => normalizeStore(c.chain)));
  const prompt = `家計簿アプリで外食の栄養を記録するために、メニューの栄養成分を取り込んでおくとよい日本の飲食チェーン店を挙げてください。JSON のみを返してください。
- 生活圏の駅: ${stations || '（未入力）'}
- 好きなもの: ${likes || '（未入力）'}
- 直近 12 か月に行った店（回数）:
${visited.map((v) => `  ${v.store}（${v.count}）`).join('\n') || '  （記録なし）'}
- すでに一覧にあるチェーン（挙げない）: ${existing.map((c) => c.chain).join('、') || 'なし'}

条件:
- 生活圏の駅の近くに店があり、好きなものに合う全国・首都圏のチェーンを優先する。行った店の傾向も参考にする
- 公式サイトで栄養成分（カロリーなど）を公開していそうなチェーンを優先する
- 15 件まで。chain は正式な店名（店舗名は除く）、genre は「寿司」「焼肉」「ラーメン」「ハンバーガー」「ピザ」「焼き鳥」「カフェ」「定食・丼」「ファミレス」「その他」のどれか
- aliases はレシートで使われそうな別の書き方（英字表記など。無ければ空配列）、reason は 20 字以内`;
  const raw = await callGemini([{ text: prompt }], { schema: SUGGEST_SCHEMA, highRes: false, signal });
  const list: any[] = Array.isArray(parseJson(raw)?.chains) ? parseJson(raw).chains : [];
  const add: Chain[] = [];
  for (const s of list) {
    const chain = String(s?.chain ?? '').trim();
    if (!chain || known.has(normalizeStore(chain))) continue;
    known.add(normalizeStore(chain));
    add.push({
      chain,
      genre: String(s?.genre ?? 'その他'),
      status: 'candidate',
      enabled: true,
      aliases: Array.isArray(s?.aliases) ? s.aliases.map(String).filter(Boolean) : [],
      note: String(s?.reason ?? ''),
      rowIndex: 0,
    });
  }
  await saveChains(add);
  return add.length;
}
