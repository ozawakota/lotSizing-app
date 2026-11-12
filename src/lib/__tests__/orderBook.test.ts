import { describe, it, expect } from 'vitest';
import { bookClusters, planNotes, positionSkew, type BookSide } from '../orderBook';

// 149.00〜151.00 を 0.05 刻み。ふだんは 0.5% ずつで、いくつかの価格帯だけ厚くする。
const book = (thick: Record<string, [number, number]>, price = 150.0): BookSide => {
  const buckets: [number, number, number][] = [];
  for (let p = 149.0; p < 151.0 - 1e-9; p += 0.05) {
    const key = p.toFixed(2);
    const [l, s] = thick[key] ?? [0.5, 0.5];
    buckets.push([Number(key), l, s]);
  }
  return { time: 0, price, bucketWidth: 0.05, buckets };
};

const ob = book({
  '149.80': [2.0, 0.5], // 下の買い指値（支え）
  '149.50': [0.5, 2.0], // 下の売りの逆指値
  '150.40': [0.5, 2.5], // 上の売り指値（壁）
  '150.70': [2.0, 0.5], // 上の買いの逆指値
});
const fmt = (p: number) => p.toFixed(3);

describe('bookClusters', () => {
  it('現在値の上下で、買い/売りを指値・逆指値に読み分けて、厚いところを返す', () => {
    const cl = bookClusters(ob, 150.0);
    const by = (k: string) => cl.filter((c) => c.kind === k).map((c) => c.price);
    expect(by('buy_limit')).toEqual([149.8]);
    expect(by('sell_stop')).toEqual([149.5]);
    expect(by('sell_limit')).toEqual([150.4]);
    expect(by('buy_stop')).toEqual([150.7]);
    expect(cl.every((c) => c.ratio >= 1.8)).toBe(true);
  });

  it('どこも平らなら厚いところは無い', () => {
    expect(bookClusters(book({}), 150.0)).toEqual([]);
  });
});

describe('planNotes', () => {
  it('買いのプラン: 損切り近くの逆指値溜まり・途中の売り指値の壁・間の買い指値の支えを指摘する', () => {
    const notes = planNotes({ direction: 'long', entry: 150.0, stop: 149.52, target: 150.8 }, ob, null, 150.0, fmt);
    expect(notes.some((n) => n.tone === 'warn' && n.text.includes('損切り') && n.text.includes('149.500'))).toBe(true);
    expect(notes.some((n) => n.tone === 'warn' && n.text.includes('150.400') && n.text.includes('壁'))).toBe(true);
    expect(notes.some((n) => n.tone === 'good' && n.text.includes('149.800'))).toBe(true);
  });

  it('売りのプランでは向きを入れ替えて読む（上の買いの逆指値・下の買い指値の壁）', () => {
    const notes = planNotes({ direction: 'short', entry: 150.0, stop: 150.72, target: 149.3 }, ob, null, 150.0, fmt);
    expect(notes.some((n) => n.text.includes('損切り') && n.text.includes('150.700'))).toBe(true);
    expect(notes.some((n) => n.text.includes('149.800') && n.text.includes('壁'))).toBe(true);
  });

  it('ポジションが片寄っていれば、同じ向きなら注意・逆向きなら追い風', () => {
    const pb = book({ '149.90': [20, 1], '150.10': [20, 1] });
    expect(positionSkew(pb, 150.0)!.longPct).toBeGreaterThanOrEqual(65);
    const same = planNotes({ direction: 'long', entry: 150, stop: 149.7, target: 150.6 }, null, pb, 150.0, fmt);
    expect(same[0]).toMatchObject({ tone: 'warn' });
    const opp = planNotes({ direction: 'short', entry: 150, stop: 150.3, target: 149.4 }, null, pb, 150.0, fmt);
    expect(opp[0]).toMatchObject({ tone: 'info' });
  });
});
