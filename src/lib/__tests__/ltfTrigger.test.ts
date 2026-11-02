import { describe, it, expect } from 'vitest';
import { assessLtfTrigger, type LtfInput } from '../ltfTrigger';
import type { OhlcCandle } from '../edge';

// 終値の列から、値幅 0.02 のローソク足（陰陽は前の終値との比較）を作る。
const bars = (closes: number[]): OhlcCandle[] =>
  closes.map((c, k) => {
    const o = k === 0 ? c : closes[k - 1];
    return { open: o, high: Math.max(o, c) + 0.01, low: Math.min(o, c) - 0.01, close: c };
  });

// 上げ → 戻り高値 150.30 → 押し安値 150.10 まで下げ → まだ戻り高値の下
const pullback = [
  150.0, 150.05, 150.1, 150.15, 150.2, 150.25, 150.3, 150.26, 150.22, 150.18,
  150.14, 150.1, 150.13, 150.16, 150.19, 150.2, 150.21, 150.22, 150.2, 150.21, 150.22, 150.2,
];
// その後、戻り高値 150.30 を終値で上抜け
const broken = [...pullback, 150.26, 150.33, 150.35];

const base = (o: Partial<LtfInput> = {}): LtfInput => ({
  direction: 'long', bars: bars(pullback), price: 150.2, instrument: 'USD_JPY',
  area: { kind: 'market', price: 150.2 }, htfStop: 149.8, target: 151.4, spreadPips: 0.3, ...o,
});

describe('assessLtfTrigger', () => {
  it('入る場所には来ているが、下位足の転換前は「転換待ち」。戻り高値の上抜けで入る逆指値と、狭い損切りを出す', () => {
    const r = assessLtfTrigger(base())!;
    expect(r.state).toBe('wait_turn');
    expect(r.swingHigh?.price).toBeCloseTo(150.31, 5); // 戻り高値（その足の高値）
    expect(r.swingLow?.price).toBeCloseTo(150.09, 5); // 押し安値（その足の安値）
    expect(r.refined?.entryType).toBe('stop');
    expect(r.refined!.stop).toBeGreaterThan(149.8); // 上位足の損切りより内側
    expect(r.refined!.rr).toBeGreaterThan(r.htfRr); // RR が上がる
  });

  it('戻り高値を終値で上抜けたら「トリガー点灯」で、今の価格（成行）で入る', () => {
    const r = assessLtfTrigger(base({ bars: bars(broken), price: 150.35 }))!;
    expect(r.state).toBe('triggered');
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.refined).toMatchObject({ entryType: 'market', entry: 150.35 });
  });

  it('指値の目安まで下がっていなければ「場所待ち」', () => {
    const r = assessLtfTrigger(base({ area: { kind: 'limit', price: 149.95 } }))!;
    expect(r.state).toBe('wait_area');
    expect(r.refined).toBeNull();
  });

  it('上位足の損切りを越えていたら無効、足が足りなければ null', () => {
    expect(assessLtfTrigger(base({ price: 149.7 }))!.state).toBe('invalid');
    expect(assessLtfTrigger(base({ bars: bars(pullback.slice(0, 10)) }))).toBeNull();
  });
});
