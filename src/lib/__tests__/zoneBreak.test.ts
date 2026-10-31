import { describe, it, expect } from 'vitest';
import { stopEntryPlan, zoneBreakOdds } from '../zoneBreak';
import type { SrZone } from '../srZones';
import type { DowAnalysis } from '../dow';

const zone = (o: Partial<SrZone>): SrZone => ({
  low: 150.4, high: 150.45, center: 150.425, side: 'res', contains: false, stars: 1, score: 3,
  swingTouches: 1, lastTouchBarsAgo: 3, sources: [], distancePips: 10, ...o,
});
const up: DowAnalysis = {
  trend: 'up', phase: 'extending', strength: 3, swings: [], keyLevel: null, extremeLevel: null, rangeHigh: null, rangeLow: null,
};
const base = { price: 150.3, atr: 0.2, pip: 0.01, rsi: 60, ma: { sma21: 150.1, ema75: null, ema200: null } };

describe('zoneBreakOdds', () => {
  it('Jev の上抜け確率を土台に、トレンド・勢いで加点する', () => {
    const o = zoneBreakOdds({ ...base, zone: zone({}), dow: up, breakout: { up: 50, down: 20, range: 30 } });
    expect(o.base).toBe(50);
    expect(o.pct).toBe(68); // 50 + 10(トレンド) + 4(21SMA) + 4(RSI)
    expect(o.level).toBe('high');
    expect(o.factors[0].label).toContain('上昇トレンド');
  });

  it('強い帯・遠い帯・逆向きのトレンドは跳ね返されやすい', () => {
    const o = zoneBreakOdds({
      ...base, rsi: 50, ma: null, zone: zone({ stars: 3, distancePips: 60 }), dow: up, breakout: { up: 30, down: 40, range: 30 },
    });
    // 支持帯ではないので上昇トレンドは帯の方向（+10）。★3 −12、遠い 3 ATR → −12
    expect(o.pct).toBe(30 + 10 - 12 - 12);
    expect(o.level).toBe('low');
    const s = zoneBreakOdds({ ...base, rsi: 50, ma: null, zone: zone({ side: 'sup', distancePips: 5 }), dow: up, breakout: null });
    expect(s.base).toBe(35);
    expect(s.pct).toBe(25); // 下抜けに対して上昇トレンドは逆向き −10
  });

  it('5〜90% に収める', () => {
    const o = zoneBreakOdds({ ...base, zone: zone({ swingTouches: 4 }), dow: up, breakout: { up: 95, down: 0, range: 5 } });
    expect(o.pct).toBe(90);
  });
});

describe('stopEntryPlan', () => {
  const odds = { pct: 60, level: 'high' as const, base: 50, factors: [] };
  it('すぐ前の帯をブレイクしやすければ、帯の外側に逆指値の案を出す', () => {
    const p = stopEntryPlan({
      direction: 'long', price: 150.3, atr: 0.2, pip: 0.01,
      ahead: { zone: zone({}), odds, label: 'R1' }, rr: { stop: 150.0, target: 151.2, spreadPips: 0.3 },
    });
    expect(p?.price).toBeCloseTo(150.47, 5);
    expect(p?.distancePips).toBe(17);
    expect(p?.rr).toBeCloseTo(1.5, 1); // (73 − 0.3) / (47 + 0.3)
  });

  it('ブレイクしにくい・遠い・目標が近すぎるときは出さない', () => {
    const args = { direction: 'long' as const, price: 150.3, atr: 0.2, pip: 0.01, rr: { stop: 150.0, target: 151.2, spreadPips: 0.3 } };
    expect(stopEntryPlan({ ...args, ahead: { zone: zone({}), odds: { ...odds, pct: 45 }, label: 'R1' } })).toBeNull();
    expect(stopEntryPlan({ ...args, ahead: { zone: zone({ distancePips: 40 }), odds, label: 'R1' } })).toBeNull();
    expect(stopEntryPlan({ ...args, rr: { stop: 150.0, target: 150.5, spreadPips: 0.3 }, ahead: { zone: zone({}), odds, label: 'R1' } })).toBeNull();
  });
});

describe('stopEntryForAnalysis（画面と Worker で共有）', () => {
  it('トレンド方向のすぐ前の帯（買いなら R1）から逆指値の目安を作る', async () => {
    const { stopEntryForAnalysis } = await import('../zoneBreak');
    const bars = Array.from({ length: 30 }, (_, k) => ({ open: 150.2, high: 150.3, low: 150.1, close: 150.2 + (k % 2) * 0.01 }));
    const p = stopEntryForAnalysis({
      direction: 'long', price: 150.3, pip: 0.01, bars,
      zones: { res: [zone({})], sup: [] }, dow: up, breakout: { up: 50, down: 20, range: 30 }, rsi: 60,
      ma: { sma21: 150.1, ema75: null, ema200: null }, rr: { stop: 150.0, target: 151.2, spreadPips: 0.3 },
    });
    expect(p?.zoneLabel).toBe('R1（抵抗帯★1）');
    expect(p!.price).toBeGreaterThan(150.45);
    expect(stopEntryForAnalysis({ direction: 'long', price: 150.3, pip: 0.01, bars, zones: { res: [], sup: [] }, dow: up, breakout: null, rsi: null, rr: null })).toBeNull();
  });
});
