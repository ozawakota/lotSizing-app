import { describe, it, expect } from 'vitest';
import { backtestStops } from '../stopBacktest';
import type { Candle } from '../stoploss';

// ジグザグに上昇する相場（押し安値が切り上がる）。トレンド方向（ロング）の取引がほぼ目標まで伸びる。
function zigzagUp(legs: number): Candle[] {
  const out: Candle[] = [];
  let p = 150;
  for (let k = 0; k < legs; k++) {
    for (let i = 0; i < 8; i++) { p += 0.1; out.push({ high: p + 0.05, low: p - 0.05, close: p }); }
    for (let i = 0; i < 4; i++) { p -= 0.1; out.push({ high: p + 0.05, low: p - 0.05, close: p }); }
  }
  return out;
}

describe('backtestStops', () => {
  it('同じエントリー集合で新旧を比較し、割合の合計は100%', () => {
    const r = backtestStops(zigzagUp(40), { instrument: 'USD_JPY', warmup: 60, horizonBars: 60, step: 3 });
    expect(r.legacy.trades).toBe(r.structural.trades);
    expect(r.legacy.trades).toBeGreaterThan(0);
    for (const s of [r.legacy, r.structural]) {
      expect(s.stopRate + s.targetRate + s.timeoutRate).toBeCloseTo(100, 0);
      expect(s.avgRiskPips).toBeGreaterThan(0);
    }
  });

  it('切り上がる上昇相場では、ロングの目標到達が損切りより多い', () => {
    const r = backtestStops(zigzagUp(40), { instrument: 'USD_JPY', warmup: 60, horizonBars: 80, step: 3, rewardR: 1 });
    expect(r.structural.targetRate).toBeGreaterThan(r.structural.stopRate);
  });

  it('スプレッドを入れると期待値（R）が下がる', () => {
    const base = backtestStops(zigzagUp(40), { instrument: 'USD_JPY', warmup: 60, horizonBars: 60, step: 3 });
    const cost = backtestStops(zigzagUp(40), { instrument: 'USD_JPY', warmup: 60, horizonBars: 60, step: 3, spreadPips: 1 });
    expect(cost.structural.expectancyR).toBeLessThan(base.structural.expectancyR);
  });

  it('足が足りなければ取引ゼロ', () => {
    const r = backtestStops(zigzagUp(2), { instrument: 'USD_JPY' });
    expect(r.legacy.trades).toBe(0);
    expect(r.structural.trades).toBe(0);
  });
});
