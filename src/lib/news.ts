// 為替ニュース（RSS）の純粋ドメインロジック。Worker とクライアントで共有する。
// RSS の <item> から title / link / pubDate / description を取り出すだけの軽量パーサ。
// 依存なし（Worker でも動くよう DOMParser は使わず正規表現で処理）。

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  description: string; // タグ除去済みのプレーンテキスト
}

const stripCdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// <name>...</name> の中身（最初の1つ）を返す。無ければ空文字。
const tagContent = (block: string, name: string): string => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};

/**
 * RSS/XML 文字列から記事項目を最大 `max` 件、元の並び（通常は新しい順）で取り出す。
 * CDATA と基本的な HTML エンティティを処理し、description はタグ除去してプレーン化する。
 */
export function parseRssItems(xml: string, max = 10): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const title = decodeEntities(stripCdata(tagContent(block, 'title'))).trim();
    const link = decodeEntities(stripCdata(tagContent(block, 'link'))).trim();
    const pubDate = stripCdata(tagContent(block, 'pubDate')).trim();
    const description = stripTags(decodeEntities(stripCdata(tagContent(block, 'description'))));
    if (title) items.push({ title, link, pubDate, description });
    if (items.length >= max) break;
  }
  return items;
}
