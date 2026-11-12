import { describe, it, expect } from 'vitest';
import { estimateOrderBook, positionBookFromRecords, snapshotTime, MIN_POSITION_RECORDS, type OhlcLike } from '../estimatedBook';
import { bookClusters } from '../orderBook';

// 150.00 を中心に上下する1時間足（山 150.80・谷 149.40 を作り、いまは 150.10 付近）
const wave = (): OhlcLike[] => {
  const closes: number[] = [];
  for (let i = 0; i < 60; i++) closes.push(150 + Math.sin(i / 6) * 0.6);
  closes.push(150.8, 150.5, 150.3, 150.2, 150.15, 150.1); // 山（未到達の高値 150.8 付近）
  closes.push(149.8, 149.5, 149.4, 149.6, 149.9, 150.0, 150.05, 150.1, 150.1, 150.1); // 谷 149.4
  return closes.map((c, k) => {
    const o = k === 0 ? c : closes[k - 1];
    return { high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c };
  });
};

describe('estimateOrderBook', () => {
  it('板全体に対する % の [価格, 買い%, 売り%] を、現在値の上下に返す（OANDA と同じく、返す範囲の合計は 100 以下）', () => {
    const b = estimateOrderBook(wave(), 150.1, 'USD_JPY', { now: 0 })!;
    expect(b.bucketWidth).toBe(0.05);
    const total = b.buckets.reduce((s, [, l, sh]) => s + l + sh, 0);
    expect(total).toBeGreaterThan(50);
    expect(total).toBeLessThanOrEqual(100 + 1e-9);
    expect(b.buckets[0][0]).toBeLessThan(150.1);
    expect(b.buckets.at(-1)![0]).toBeGreaterThan(150.1);
  });

  it('未到達のスイング高値の上に買いの逆指値、スイング安値の下に売りの逆指値が厚くなる', () => {
    const b = estimateOrderBook(wave(), 150.1, 'USD_JPY', { now: 0 })!;
    const cl = bookClusters(b, 150.1, 8);
    expect(cl.some((c) => c.kind === 'buy_stop' && c.price > 150.8)).toBe(true);
    expect(cl.some((c) => c.kind === 'sell_stop' && c.price < 149.4)).toBe(true);
  });

  it('個人が売りに偏るほど、買いの逆指値（売り方の損切り）が重くなる', () => {
    const sumBuyStops = (shortPct: number) => {
      const b = estimateOrderBook(wave(), 150.1, 'USD_JPY', { retail: { longPct: 100 - shortPct, shortPct }, now: 0 })!;
      return b.buckets.filter(([p]) => p > 150.8).reduce((s, [, l]) => s + l, 0);
    };
    expect(sumBuyStops(80)).toBeGreaterThan(sumBuyStops(20));
  });

  it('足が足りない・未対応のペアは null', () => {
    expect(estimateOrderBook(wave().slice(0, 10), 150.1, 'USD_JPY')).toBeNull();
    expect(estimateOrderBook(wave(), 150.1, 'NZD_CAD')).toBeNull();
  });
});

describe('snapshotTime', () => {
  it('OANDA と同じく 20 分ごと（:00 / :20 / :40）に切り捨てる', () => {
    const t = Date.UTC(2026, 10, 12, 21, 39, 59);
    expect(new Date(snapshotTime(t)).toISOString()).toBe('2026-11-12T21:20:00.000Z');
    expect(snapshotTime(Date.UTC(2026, 10, 12, 21, 40))).toBe(Date.UTC(2026, 10, 12, 21, 40));
  });
});

describe('positionBookFromRecords', () => {
  const H = 3_600_000;
  it('平均取得価格の帯に取引量を積み、新しい記録ほど重い', () => {
    const now = 100 * H;
    const recs = [
      { ts: now - 200 * H, avgLong: 149.0, avgShort: 151.0, longVolume: 100, shortVolume: 100 }, // 古い
      { ts: now - 2 * H, avgLong: 150.0, avgShort: 150.6, longVolume: 100, shortVolume: 50 },
      { ts: now - 1 * H, avgLong: 150.0, avgShort: 150.6, longVolume: 100, shortVolume: 50 },
    ];
    const b = positionBookFromRecords(recs, 150.2, 'USD_JPY', now)!;
    const at = (p: number) => b.buckets.find(([x]) => Math.abs(x - p) < 1e-9)!;
    expect(at(150.0)[1]).toBeGreaterThan(at(149.0)[1]); // 新しい平均取得価格の方が厚い
    expect(at(150.6)[2]).toBeGreaterThan(0);
    const total = b.buckets.reduce((s, [, l, sh]) => s + l + sh, 0);
    expect(total).toBeCloseTo(100, 6); // 記録は現在値の近くだけなので、ここでは全部が範囲に入る
  });

  it(`平均取得価格のある記録が ${MIN_POSITION_RECORDS} 件未満なら null`, () => {
    expect(positionBookFromRecords([{ ts: 0, avgLong: 150, avgShort: null, longVolume: 1, shortVolume: 1 }], 150, 'USD_JPY', 0)).toBeNull();
  });
});
