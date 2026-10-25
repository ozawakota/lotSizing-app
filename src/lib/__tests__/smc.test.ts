import { describe, it, expect } from 'vitest';
import { analyzeSmc, findFvgs, findOrderBlocks, findSweeps, premiumDiscount, smcTags, type SmcRead } from '../smc';
import type { OhlcCandle } from '../edge';
import type { DowAnalysis } from '../dow';

const c = (open: number, high: number, low: number, close: number): OhlcCandle => ({ open, high, low, close });
// 値幅0.1の平凡な足（100 前後を小さく上下）
const flat = (n: number, p = 100): OhlcCandle[] =>
  Array.from({ length: n }, (_, i) => (i % 2 ? c(p - 0.02, p + 0.05, p - 0.05, p + 0.02) : c(p + 0.02, p + 0.05, p - 0.05, p - 0.02)));

describe('findFvgs', () => {
  it('1本目の高値と3本目の安値の空白を強気 FVG とし、一部埋まった分は範囲から除く', () => {
    const bars = [...flat(10), c(100, 100.1, 99.95, 100.05), c(100.05, 100.6, 100.05, 100.55), c(100.55, 100.7, 100.3, 100.65)];
    expect(findFvgs(bars, 0.1)).toEqual([{ dir: 1, low: 100.1, high: 100.3, barsAgo: 0 }]);
    const partly = [...bars, c(100.6, 100.65, 100.2, 100.5)];
    expect(findFvgs(partly, 0.1)[0]).toMatchObject({ low: 100.1, high: 100.2, barsAgo: 1 });
    const filled = [...partly, c(100.5, 100.5, 100.05, 100.3)];
    expect(findFvgs(filled, 0.1)).toEqual([]);
  });

  it('弱気 FVG は1本目の安値と3本目の高値の空白、小さすぎる空白は無視', () => {
    const bars = [...flat(10), c(100, 100.05, 99.9, 99.95), c(99.95, 99.95, 99.4, 99.45), c(99.45, 99.7, 99.35, 99.4)];
    expect(findFvgs(bars, 0.1)[0]).toMatchObject({ dir: -1, low: 99.7, high: 99.9 });
    const tiny = [...flat(10), c(100, 100.05, 99.9, 99.95), c(99.95, 99.95, 99.85, 99.87), c(99.87, 99.895, 99.8, 99.82)];
    expect(findFvgs(tiny, 0.1)).toEqual([]);
  });
});

describe('findOrderBlocks', () => {
  const base = [...flat(14), c(100.02, 100.04, 99.92, 99.95), c(99.95, 100.8, 99.94, 100.75), c(100.75, 100.9, 100.6, 100.85)];
  it('直近高値を抜けた強い陽線の直前の陰線が、買いのオーダーブロック', () => {
    expect(findOrderBlocks(base, 0.15)).toEqual([{ dir: 1, low: 99.92, high: 100.04, barsAgo: 2 }]);
  });
  it('その後に終値で安値を割られたら無効', () => {
    expect(findOrderBlocks([...base, c(100.85, 100.85, 99.8, 99.85)], 0.15).filter((o) => o.dir === 1)).toEqual([]); // 大陰線で売りの OB は新しくできる
  });
});

describe('findSweeps', () => {
  it('スイング安値をヒゲで割って終値で戻した足は安値スイープ', () => {
    const bars = [...flat(5), c(100, 100.02, 99.8, 99.9), ...flat(5), c(99.98, 100.0, 99.7, 99.95), c(99.95, 100.05, 99.96, 100.0)];
    expect(findSweeps(bars)).toEqual([{ dir: 1, level: 99.8, barsAgo: 1 }]);
  });
  it('その後スイープした足の安値を終値で割ったら取り消し', () => {
    const bars = [...flat(5), c(100, 100.02, 99.8, 99.9), ...flat(5), c(99.98, 100.0, 99.7, 99.95), c(99.95, 99.96, 99.6, 99.65)];
    expect(findSweeps(bars).filter((s) => s.dir === 1)).toEqual([]);
  });
});

describe('premiumDiscount', () => {
  const dow = { swings: [{ kind: 'low', price: 100 }, { kind: 'high', price: 101 }] } as unknown as DowAnalysis;
  it('値幅の中の位置と、買い/売りそれぞれの OTE', () => {
    expect(premiumDiscount(dow, 100.3, 'long')).toEqual({ pos: expect.closeTo(0.3, 6), zone: 'discount', ote: true });
    expect(premiumDiscount(dow, 100.5, 'long')?.zone).toBe('equilibrium');
    expect(premiumDiscount(dow, 100.7, 'short')).toMatchObject({ zone: 'premium', ote: true });
    expect(premiumDiscount(null, 100, 'long')).toBeNull();
  });
});

describe('analyzeSmc / smcTags', () => {
  it('買い: オーダーブロックの上・安値スイープ後なら順方向のタグが付く', () => {
    const bars = [
      ...flat(5),
      c(100, 100.02, 99.8, 99.9),
      ...flat(8),
      c(100.02, 100.04, 99.92, 99.95),
      c(99.95, 100.8, 99.94, 100.75), // 強い陽線（オーダーブロックの起点・ディスプレイスメント）
      c(100.75, 100.78, 100.3, 100.35),
      c(100.35, 100.4, 100.1, 100.15),
    ];
    const r = analyzeSmc(bars, 100.12, 'long', null);
    expect(r.ob).toMatchObject({ dir: 1, low: 99.92, high: 100.04 });
    const tags = smcTags(r, 'long', 2);
    expect(tags.find((t) => t.label.startsWith('買いのオーダーブロック'))).toMatchObject({ tone: 'with', points: 6 });
  });

  it('足が足りなければ何も読まない', () => {
    expect(analyzeSmc(flat(5), 100, 'long', null)).toMatchObject({ fvg: null, ob: null, sweep: null, pd: null, displacement: 0 });
  });

  it('タグの加減点: 逆スイープ・プレミアムで買い・逆の強い足は減点', () => {
    const r: SmcRead = {
      fvg: null,
      oppFvg: { dir: -1, low: 100.1, high: 100.2, barsAgo: 2 },
      ob: null,
      sweep: null,
      oppSweep: { dir: -1, level: 100.5, barsAgo: 1 },
      pd: { pos: 0.8, zone: 'premium', ote: false },
      displacement: -1,
    };
    expect(smcTags(r, 'long', 2).map((t) => [t.tone, t.points])).toEqual([
      ['against', -7],
      ['against', -4],
      ['against', -5],
      ['against', -5],
    ]);
  });
});
