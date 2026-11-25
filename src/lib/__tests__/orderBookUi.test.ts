import { describe, it, expect } from 'vitest';
import { bookLean, nearestWalls, type BookSide } from '../orderBook';

// 151.00〜152.00 の 0.05 刻み。現在値 151.50。平均は約 1、厚い＝1.8 倍以上
const book = (rows: [number, number, number][]): BookSide => ({ time: 0, price: 151.5, bucketWidth: 0.05, buckets: rows });
const flat: [number, number, number][] = Array.from({ length: 20 }, (_, k) => [151 + k * 0.05, 1, 1]);

describe('nearestWalls', () => {
  it('現在値のすぐ上と下の厚い価格帯を返す（遠い方は選ばない）', () => {
    const rows = flat.map(([p, l, s]): [number, number, number] => {
      if (Math.abs(p - 151.6) < 1e-9) return [p, l, 4]; // 上: 売り指値の壁（近い）
      if (Math.abs(p - 151.9) < 1e-9) return [p, 4, s]; // 上: 買いの逆指値（遠い）
      if (Math.abs(p - 151.3) < 1e-9) return [p, l, 4]; // 下: 売りの逆指値
      return [p, l, s];
    });
    const w = nearestWalls(book(rows), 151.52);
    expect(w.above).toMatchObject({ kind: 'sell_limit' });
    expect(w.above!.price).toBeCloseTo(151.6);
    expect(w.below).toMatchObject({ kind: 'sell_stop' });
    expect(w.below!.price).toBeCloseTo(151.3);
  });
  it('厚い価格帯が無ければ undefined', () => {
    expect(nearestWalls(book(flat), 151.52)).toEqual({ above: undefined, below: undefined });
  });
});

describe('bookLean', () => {
  it('上の逆指値と下の支えが多ければ上', () => {
    expect(bookLean({ accelUpPct: 64, accelDownPct: 36, supportPct: 60, resistancePct: 40 })).toEqual({ lean: 'up', score: 24 });
  });
  it('下の逆指値と上の重しが多ければ下、打ち消し合えば拮抗', () => {
    expect(bookLean({ accelUpPct: 30, accelDownPct: 70, supportPct: 45, resistancePct: 55 }).lean).toBe('down');
    expect(bookLean({ accelUpPct: 64, accelDownPct: 36, supportPct: 43, resistancePct: 57 })).toEqual({ lean: 'even', score: 7 });
  });
});
