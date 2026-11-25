import { describe, it, expect } from 'vitest';
import { smallLossPlan } from '../smallLoss';

const pip = 0.01;
const longCard = { direction: 'long' as const, entry: 152.0, stop: 151.5, target: 153.5, riskPips: 50, timing: null };

describe('smallLossPlan', () => {
  it('撤退ラインと、1R 進んだら建値へ（買い）', () => {
    const p = smallLossPlan(longCard, pip);
    expect(p.stop).toEqual({ price: 151.5, pips: 50 });
    expect(p.breakeven).toEqual({ trigger: 152.5, moveTo: 152.0 });
    expect(p.limit).toBeNull();
  });

  it('押し目の指値で入れば損失が小さく RR が上がる', () => {
    const p = smallLossPlan({ ...longCard, timing: { verdict: 'wait', label: '', limitPrice: 151.8, stopEntryPrice: null } as never }, pip);
    expect(p.limit).toEqual({ price: 151.8, riskPips: 30, savedPct: 40, rr: 5.7 });
  });

  it('指値がエントリーより上（買い）や損切りの外なら使わない', () => {
    const above = smallLossPlan({ ...longCard, timing: { limitPrice: 152.2, stopEntryPrice: null } as never }, pip);
    const outside = smallLossPlan({ ...longCard, timing: { limitPrice: 151.4, stopEntryPrice: null } as never }, pip);
    expect(above.limit).toBeNull();
    expect(outside.limit).toBeNull();
  });

  it('売りは向きが逆。目標が 1R より近ければ建値ストップは出さない', () => {
    const p = smallLossPlan({ direction: 'short', entry: 1.1, stop: 1.105, target: 1.097, riskPips: 50, timing: null }, 0.0001);
    expect(p.breakeven).toBeNull();
    const q = smallLossPlan({ direction: 'short', entry: 1.1, stop: 1.105, target: 1.088, riskPips: 50, timing: { limitPrice: 1.102, stopEntryPrice: null } as never }, 0.0001);
    expect(q.breakeven!.trigger).toBeCloseTo(1.095);
    expect(q.limit).toMatchObject({ riskPips: 30, savedPct: 40 });
  });
});
