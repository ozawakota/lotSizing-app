import { describe, it, expect } from 'vitest';
import { flowOverlay, flowPairOf } from '../flowOverlay';
import type { PairFlow } from '../flow';

const base: PairFlow = {
  pair: 'USD/JPY',
  longPct: 68,
  shortPct: 32,
  longVolume: 100,
  shortVolume: 50,
  dominant: 'buy',
  avgLongPrice: 151.2,
  avgShortPrice: 151.8,
  peak: { volume: 200, datetime: '2026-11-10T00:00:00Z', rate: 151.05 },
  cot: { net: -0.4, lean: 'sell' },
};

describe('flowOverlay', () => {
  it('平均取得価格とピークを帯にし、含み益/含み損と偏りをまとめる', () => {
    const o = flowOverlay(base, 151.32, 0.01);
    expect(o.levels.map((l) => l.kind)).toEqual(['avg_long', 'avg_short', 'peak']);
    const long = o.levels.find((l) => l.kind === 'avg_long')!;
    expect(long.distancePips).toBeCloseTo(12, 5);
    expect(long.note).toContain('含み益');
    const short = o.levels.find((l) => l.kind === 'avg_short')!;
    expect(short.note).toContain('含み益'); // 現在値は売り平均 151.80 より下 → 売り勢は含み益
    expect(o.crowd).toBe('buy');
    expect(o.summary).toContain('逆張りなら売り目線');
    expect(o.summary).toContain('大口は売り越し');
  });

  it('現在値が買い平均より下なら、買い勢は含み損（戻りで手仕舞いの売り）', () => {
    const o = flowOverlay(base, 151.1, 0.01);
    expect(o.levels.find((l) => l.kind === 'avg_long')!.note).toMatch(/含み損.*手仕舞いの売り/);
  });

  it('平均取得価格やピークが無ければ帯は出さず、拮抗なら neutral', () => {
    const o = flowOverlay({ ...base, longPct: 52, shortPct: 48, avgLongPrice: undefined, avgShortPrice: undefined, peak: undefined, cot: undefined }, 151.3, 0.01);
    expect(o.levels).toEqual([]);
    expect(o.crowd).toBe('neutral');
    expect(o.cot).toBeNull();
  });

  it('instrument をペア名にする', () => {
    expect(flowPairOf('XAU_USD')).toBe('XAU/USD');
  });
});
