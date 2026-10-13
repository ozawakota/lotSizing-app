import { describe, it, expect } from 'vitest';
import { filterEconEvents, formatEconDigest, parseRssItems } from '../news';

const SAMPLE = `<?xml version="1.0"?><rss><channel>
  <title>feed</title>
  <item>
    <title><![CDATA[USD/JPY rises on strong data]]></title>
    <link>https://example.com/a</link>
    <pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[The dollar <b>gained</b> as yields rose &amp; risk sentiment improved.]]></description>
  </item>
  <item>
    <title>Gold slips</title>
    <link>https://example.com/b</link>
    <pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate>
    <description>Gold eased slightly.</description>
  </item>
</channel></rss>`;

describe('parseRssItems', () => {
  it('extracts title/link/pubDate/description with CDATA, entities and tags handled', () => {
    const items = parseRssItems(SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'USD/JPY rises on strong data',
      link: 'https://example.com/a',
      pubDate: 'Mon, 05 Oct 2026 10:00:00 GMT',
      description: 'The dollar gained as yields rose & risk sentiment improved.',
    });
    expect(items[1].title).toBe('Gold slips');
  });

  it('respects the max limit and preserves order', () => {
    const items = parseRssItems(SAMPLE, 1);
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://example.com/a');
  });

  it('returns an empty array when there are no items', () => {
    expect(parseRssItems('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('filterEconEvents', () => {
  // JST 2026-10-14 の午後を基準に（UTC では 10-14 05:00Z ≒ JST 14:00）。
  const NOW = new Date('2026-10-14T05:00:00Z');
  const RAW = [
    { title: 'CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.6%', previous: '0.4%' }, // 当日 High USD
    { title: 'Employment Change', country: 'AUD', date: '2026-10-16T20:30:00-04:00', impact: 'High', forecast: '19K', previous: '39K' }, // 今週後半 High AUD
    { title: 'Retail Sales', country: 'USD', date: '2026-10-15T08:30:00-04:00', impact: 'Medium', forecast: '', previous: '' }, // Medium → 除外
    { title: 'Manufacturing PMI', country: 'CNY', date: '2026-10-15T01:00:00-04:00', impact: 'High', forecast: '', previous: '' }, // 対象外通貨 → 除外
    { title: 'Old Speech', country: 'EUR', date: '2026-10-12T10:00:00-04:00', impact: 'High', forecast: '', previous: '' }, // 過去日 → 除外
  ];

  it('High重要度・対象8通貨・今日以降だけを日時昇順で返す', () => {
    const r = filterEconEvents(RAW, NOW);
    expect(r.map((e) => `${e.country}:${e.title}`)).toEqual(['USD:CPI m/m', 'AUD:Employment Change']);
  });

  it('配列以外は空配列を返す', () => {
    expect(filterEconEvents(null, NOW)).toEqual([]);
    expect(filterEconEvents({ foo: 1 }, NOW)).toEqual([]);
  });
});

describe('formatEconDigest', () => {
  it('JST日時＋通貨＋イベント＋予想/前回を1行で整形する', () => {
    const digest = formatEconDigest([
      { date: '2026-10-14T08:30:00-04:00', country: 'USD', title: 'CPI m/m', impact: 'High', forecast: '0.6%', previous: '0.4%' },
    ]);
    // 08:30 EDT(-04:00) = 21:30 JST。
    expect(digest).toBe('10/14 21:30 USD CPI m/m（予想0.6%/前回0.4%）');
  });
});
