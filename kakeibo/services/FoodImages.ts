/**
 * 食品データのパッケージ画像。仕様は docs/meal-nutrition-spec.md §8.8.3。
 *
 * - 栄養を調べたときの参照ページ（メーカーの商品ページなど）を読み、ページの代表画像（og:image）を取る
 * - grounding の参照ページは 5 品ぶんまとめて返るので、どの品のページかはページの題名と品名の近さで決める
 * - 画像は端末に保存して（`photos/foods/`）在庫の一覧と「どれですか？」に出す
 * - 見つからなければ image_url を '-' にして探し直さない
 */

import axios from 'axios';
import { Directory, File, Paths } from 'expo-file-system';
import { Food, loadFoods, saveImageUrls } from './FoodService';
import * as Demo from './DemoService';

const FOOD_DIR = ['photos', 'foods'] as const;
/** 1 回に探す品目数（空き時間に少しずつ） */
const PER_RUN = 5;
/** 1 品で読むページ数の上限（grounding の参照は 5 品ぶんまとめてなので、どの品のページも見られるだけ読む） */
const PAGES_PER_FOOD = 8;
/** 品名とページの題名がこれ以上似ていれば、その品のページとみなす（文字の 2-gram の Dice 係数） */
const MIN_SIMILARITY = 0.3;

/** 比べるために揃える（全角英数を半角に、空白・記号を消し、小文字に） */
function normalize(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　・\-‐－_/|｜()（）［］\[\]【】「」『』、。,.!！?？:：®™]/g, '')
    .toLowerCase();
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 品名がページの題名にどれだけ含まれているか（品名側の 2-gram のうち題名にもある割合） */
export function similarity(name: string, title: string): number {
  const a = bigrams(normalize(name));
  const b = new Set(bigrams(normalize(title)));
  if (a.length === 0 || b.size === 0) return 0;
  return a.filter((g) => b.has(g)).length / a.length;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function metaContent(html: string, prop: string): string {
  // property="og:image" content="..." と、属性の順が逆のものの両方
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return decodeEntities((a?.[1] ?? b?.[1] ?? '').trim());
}

interface PageInfo {
  title: string;
  image: string;
}

async function readPage(url: string): Promise<PageInfo | null> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 10_000,
      responseType: 'text',
      maxContentLength: 3 * 1024 * 1024,
      headers: { Accept: 'text/html' },
    });
    const html = String(res.data ?? '').slice(0, 300_000);
    const image = metaContent(html, 'og:image') || metaContent(html, 'twitter:image');
    const title = metaContent(html, 'og:title') || decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '');
    if (!image) return { title, image: '' };
    // 相対パスの画像は使わない（grounding の参照は転送用の URL なので、転送先のページの URL が分からない）
    const abs = /^https?:\/\//.test(image) ? image : image.startsWith('//') ? `https:${image}` : '';
    return { title, image: abs };
  } catch {
    return null;
  }
}

/**
 * 画像をまだ探していない品目を少しずつ探す（空き時間に呼ぶ）。探したら true。
 * 外食のメニューは在庫に出ないので対象外。
 */
/** この起動中にページを読めなかった品目（同じ品目ばかり試して先に進めなくならないように） */
const unreachable = new Set<string>();

export async function fillSomeImages(): Promise<boolean> {
  if (await Demo.isDemo()) return false;
  const foods = [...(await loadFoods(true)).values()]
    .filter((f) => f.status === 'done' && !f.chain && !f.imageUrl && f.sources.length > 0 && !unreachable.has(f.foodId))
    .sort((a, b) => b.purchaseCount - a.purchaseCount)
    .slice(0, PER_RUN);
  if (foods.length === 0) return false;

  // 同じ回の調査の品目は参照ページが同じなので、1 回の実行の中では読み直さない
  const pages = new Map<string, Promise<PageInfo | null>>();
  const page = (url: string) => {
    if (!pages.has(url)) pages.set(url, readPage(url));
    return pages.get(url)!;
  };

  const results: { food: Food; imageUrl: string }[] = [];
  for (const food of foods) {
    let best: { score: number; image: string } = { score: 0, image: '' };
    let read = 0;
    for (const url of food.sources.slice(0, PAGES_PER_FOOD)) {
      const info = await page(url);
      if (info) read++;
      if (!info?.image) continue;
      const score = similarity(food.name, info.title);
      if (score > best.score) best = { score, image: info.image };
    }
    // どのページも読めなかった（通信の失敗・403 など）ときは、見つからなかったと決めずに次の機会に回す
    if (read === 0) {
      unreachable.add(food.foodId);
      continue;
    }
    const imageUrl = best.score >= MIN_SIMILARITY ? best.image : '-';
    results.push({ food, imageUrl });
    if (imageUrl !== '-') await downloadFoodImage({ ...food, imageUrl });
  }
  await saveImageUrls(results);
  return true;
}

function imageFile(food: Food): File {
  const dir = new Directory(Paths.document, ...FOOD_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${food.foodId}.img`);
}

const downloading = new Map<string, Promise<string | null>>();

/** 端末に保存した画像の URI。無ければ取ってくる。画像が無い・取れなければ null */
export function downloadFoodImage(food: Food): Promise<string | null> {
  if (!/^https?:\/\//.test(food.imageUrl) || !food.foodId) return Promise.resolve(null);
  // 在庫の一覧で同じ品目が並ぶと同時に呼ばれる。同じファイルへ二重に保存しない
  const running = downloading.get(food.foodId);
  if (running) return running;
  const task = (async () => {
    try {
      const file = imageFile(food);
      if (file.exists) return file.uri;
      // 書きかけのファイルが残ると次から取り直さないので、一時ファイルに落としてから移す
      const tmp = new File(Paths.cache, `food-${food.foodId}.tmp`);
      if (tmp.exists) tmp.delete();
      let moved = false;
      try {
        await File.downloadFileAsync(food.imageUrl, tmp);
        if (!tmp.exists || tmp.size === 0 || (tmp.type && !tmp.type.startsWith('image/'))) return null;
        // move すると tmp 自体が移した先を指すようになるので、後で消さない
        tmp.move(file);
        moved = true;
        return file.uri;
      } finally {
        if (!moved && tmp.exists) tmp.delete();
      }
    } catch (e) {
      console.warn('[FoodImages] 画像を保存できなかった:', e instanceof Error ? e.message : e);
      return null;
    } finally {
      downloading.delete(food.foodId);
    }
  })();
  downloading.set(food.foodId, task);
  return task;
}
