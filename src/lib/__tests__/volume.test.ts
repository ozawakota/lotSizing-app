import { describe, it, expect } from 'vitest';
import { computeVolumeIndicators, computeVolumeProfile, mapProfile, profileLevels, rvolLevel } from '../volume';
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

describe('computeVolumeProfile（価格帯別出来高）', () => {
  // 100〜110 の範囲。105 付近で出来高の大きい足が多く、108 付近にも小さな山。
  const bars: Candle[] = [];
  for (let i = 0; i < 40; i++) bars.push({ high: 110, low: 100, close: 105, volume: 10 }); // 全体に薄く
  for (let i = 0; i < 20; i++) bars.push({ high: 105.3, low: 104.7, close: 105, volume: 300 }); // 105 に集中
  for (let i = 0; i < 6; i++) bars.push({ high: 108.2, low: 107.9, close: 108, volume: 200 }); // 108 に小さな山

  it('出来高が集中した価格が POC、バリューエリアはそれを含む', () => {
    const p = computeVolumeProfile(bars)!;
    expect(p.poc).toBeGreaterThan(104.6);
    expect(p.poc).toBeLessThan(105.4);
    expect(p.val).toBeLessThanOrEqual(p.poc);
    expect(p.vah).toBeGreaterThanOrEqual(p.poc);
    expect(p.vah - p.val).toBeLessThan(10); // 全範囲より狭い
    expect(p.bars).toBe(66);
  });

  it('POC から離れた出来高の山を HVN として拾う', () => {
    const p = computeVolumeProfile(bars)!;
    expect(p.hvns.some((h) => Math.abs(h - 108) < 0.5)).toBe(true);
  });

  it('出来高のある足が少なければ null', () => {
    expect(computeVolumeProfile(bars.slice(0, 5))).toBeNull();
    expect(computeVolumeProfile(bars.map((b) => ({ ...b, volume: 0 })))).toBeNull();
  });

  it('逆数クォートで写すと上下が入れ替わっても vah > val を保ち、ラベル付きのライン一覧にできる', () => {
    const p = computeVolumeProfile(bars)!;
    const m = mapProfile(p, (x) => 1000 / x);
    expect(m.vah).toBeGreaterThan(m.val);
    expect(m.poc).toBeCloseTo(1000 / p.poc, 6);
    const labels = profileLevels(m).map((l) => l.label);
    expect(labels.slice(0, 3)).toEqual(['出来高POC', 'バリューエリア上限', 'バリューエリア下限']);
    expect(labels).toContain('出来高の山');
  });
});
