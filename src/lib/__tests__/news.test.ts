import { describe, it, expect } from 'vitest';
import { parseRssItems } from '../news';

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
