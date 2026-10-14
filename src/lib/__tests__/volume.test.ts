import { describe, it, expect } from 'vitest';
import { computeVolumeIndicators, rvolLevel } from '../volume';
import type { Candle } from '../stoploss';

// close を step ずつ動かし、出来高は vols[i]（足りなければ 100）。
const series = (n: number, step: number, vols: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const close = 100 + i * step;
    return { high: close + 0.1, low: close - 0.1, close, volume: vols(i), t: 1_800_000_000 + i * 14400 };
  });

describe('rvolLevel', () => {
  it('1.5倍以上=急増 / 1.15倍以上=多い / 0.7倍以上=普通 / それ未満=少ない', () => {
    expect(rvolLevel(1.6)).toBe('surge');
    expect(rvolLevel(1.2)).toBe('high');
    expect(rvolLevel(1.0)).toBe('normal');
    expect(rvolLevel(0.5)).toBe('low');
  });
});

describe('computeVolumeIndicators', () => {
  it('最新足が平均の2倍なら RVOL 2・急増', () => {
    const bars = series(30, 0.01, (i) => (i === 29 ? 200 : 100));
    const v = computeVolumeIndicators(bars)!;
    expect(v.rvol).toBe(2);
    expect(v.rvolLevel).toBe('surge');
    expect(v.lastVolume).toBe(200);
    expect(v.avgVolume).toBe(100);
  });

  it('直近5本の出来高が増えていれば増加トレンド', () => {
    const v = computeVolumeIndicators(series(30, 0.01, (i) => (i >= 25 ? 180 : 100)))!;
    expect(v.trend).toBe('increasing');
    expect(computeVolumeIndicators(series(30, 0.01, (i) => (i >= 25 ? 50 : 100)))!.trend).toBe('decreasing');
  });

  it('上昇が続けば OBV も価格も上向きで、食い違いなし', () => {
    const v = computeVolumeIndicators(series(30, 0.05, () => 100))!;
    expect(v.obv).toBe('up');
    expect(v.price).toBe('up');
    expect(v.divergence).toBe(false);
  });

  it('逆数クォートの先物（6J=F）は向きをスポット基準に反転する', () => {
    const v = computeVolumeIndicators(series(30, 0.05, () => 100), true)!;
    expect(v.obv).toBe('down');
    expect(v.price).toBe('down');
  });

  it('価格は上向きでも、上げ足の出来高が細り下げ足で膨らめば OBV は下向き（食い違い）', () => {
    // 2本上げて1本下げるジグザグ上昇。下げ足だけ出来高が大きい。
    const bars: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 33; i++) {
      const down = i % 3 === 2;
      p += down ? -0.03 : 0.05;
      bars.push({ high: p + 0.1, low: p - 0.1, close: p, volume: down ? 400 : 100 });
    }
    const v = computeVolumeIndicators(bars)!;
    expect(v.price).toBe('up');
    expect(v.obv).toBe('down');
    expect(v.divergence).toBe(true);
  });

  it('出来高データが足りなければ null（FXスポット=0 など）', () => {
    expect(computeVolumeIndicators(series(30, 0.01, () => 0))).toBeNull();
    expect(computeVolumeIndicators(series(15, 0.01, () => 100))).toBeNull();
  });
});
