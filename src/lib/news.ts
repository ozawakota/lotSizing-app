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

// ---------------------------------------------------------------------------
// 経済指標カレンダー（ForexFactory 週次JSON）。ニュース分析に加味する。
// ---------------------------------------------------------------------------

// 1件の経済指標イベント（ForexFactory 由来）。
export interface EconEvent {
  date: string; // TZ付きISO8601（例: 2026-10-14T08:30:00-04:00）
  country: string; // 通貨コード（USD/JPY/EUR/...）
  title: string; // イベント名（例: CPI m/m）
  impact: string; // 重要度（本モジュールでは 'High' のみ通す）
  forecast: string; // 予想（空のことあり）
  previous: string; // 前回（空のことあり）
}

// 加味する対象通貨（アプリの対象ペア通貨）。
const ECON_MAJORS = new Set(['USD', 'JPY', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF']);
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * ForexFactory 週次JSON（配列）から、High重要度・対象8通貨・「JSTの今日0時以降」の
 * イベントだけを抽出し、日時昇順で返す。不正入力・過去分は除外。
 */
export function filterEconEvents(raw: unknown, now: Date): EconEvent[] {
  if (!Array.isArray(raw)) return [];
  // JST の今日0時（epoch ms）。これより前に始まったイベントは「過ぎた日」として除外。
  const startOfTodayJst = Math.floor((now.getTime() + JST_OFFSET_MS) / 86_400_000) * 86_400_000 - JST_OFFSET_MS;
  const out: EconEvent[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || r.impact !== 'High') continue;
    const country = String(r.country ?? '');
    if (!ECON_MAJORS.has(country)) continue;
    const date = String(r.date ?? '');
    const t = new Date(date).getTime();
    if (Number.isNaN(t) || t < startOfTodayJst) continue;
    out.push({
      date,
      country,
      title: String(r.title ?? ''),
      impact: 'High',
      forecast: String(r.forecast ?? ''),
      previous: String(r.previous ?? ''),
    });
  }
  out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return out;
}

/**
 * AI プロンプト用のコンパクトな指標ダイジェストを作る（JST 日時）。
 * 例: "10/14 21:30 USD CPI m/m（予想0.6%/前回0.4%）"。1イベント1行。
 */
export function formatEconDigest(events: EconEvent[]): string {
  return events
    .map((e) => {
      const d = new Date(e.date);
      const when = Number.isNaN(d.getTime())
        ? e.date
        : new Intl.DateTimeFormat('ja-JP', {
            timeZone: 'Asia/Tokyo',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(d);
      const fp = e.forecast || e.previous ? `（予想${e.forecast || '—'}/前回${e.previous || '—'}）` : '';
      return `${when} ${e.country} ${e.title}${fp}`;
    })
    .join('\n');
}
