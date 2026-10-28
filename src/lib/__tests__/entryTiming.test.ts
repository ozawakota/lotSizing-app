import { describe, it, expect } from 'vitest';
import { assessEntryTiming } from '../entryTiming';
import type { DowAnalysis } from '../dow';
import type { SrZone } from '../srZones';
import type { OhlcCandle } from '../edge';

// 値幅 0.10（ATR ≈ 0.10）の横ばいの足。最後の3本だけ動きを変えられる。
function bars(last3: [number, number][] = []): OhlcCandle[] {
  const out: OhlcCandle[] = [];
  for (let n = 0; n < 30; n++) out.push({ open: 150.0, high: 150.05, low: 149.95, close: 150.0 });
  last3.forEach(([low, high], k) => (out[27 + k] = { open: low, high, low, close: high }));
  return out;
}

function dow(lo: number, hi: number, key: number | null): DowAnalysis {
  return {
    trend: 'up',
    phase: 'extending',
    strength: 3,
    swings: [
      { kind: 'low', price: lo, index: 10, barsAgo: 19, label: 'HL' },
      { kind: 'high', price: hi, index: 20, barsAgo: 9, label: 'HH' },
    ],
    keyLevel: key == null ? null : { price: key, kind: 'pullback_low' },
    extremeLevel: { price: hi, kind: 'high' },
    rangeHigh: null,
    rangeLow: null,
  };
}

function zone(side: 'res' | 'sup', low: number, high: number, price: number): SrZone {
  const contains = price >= low && price <= high;
  const dist = contains ? 0 : side === 'res' ? low - price : price - high;
  return {
    low, high, center: (low + high) / 2, side, contains, stars: 2, score: 5, swingTouches: 2,
    lastTouchBarsAgo: 3, sources: [], distancePips: Math.round((dist / 0.01) * 10) / 10,
  };
}

describe('assessEntryTiming', () => {
  it('支持帯のすぐ上・値幅の下の方なら入りどき', () => {
    const price = 150.02;
    const t = assessEntryTiming({
      direction: 'long', price, instrument: 'USD_JPY', bars: bars(),
      dow: dow(149.9, 150.5, 149.9), zones: { res: [zone('res', 150.5, 150.55, price)], sup: [zone('sup', 149.95, 150.0, price)] },
      rsi: 52, stochK: 40,
    });
    expect(t?.verdict).toBe('ok');
    expect(t?.limit).toBeNull();
  });

  it('伸び切った高値圏では高値掴み注意と押し目の指値を出す', () => {
    const price = 150.48;
    const t = assessEntryTiming({
      direction: 'long', price, instrument: 'USD_JPY',
      bars: bars([[150.1, 150.25], [150.25, 150.4], [150.4, 150.48]]),
      dow: dow(149.9, 150.5, 149.9),
      zones: { res: [zone('res', 150.5, 150.55, price)], sup: [zone('sup', 149.95, 150.0, price)] },
      rsi: 78, stochK: 92,
      rr: { stop: 149.85, target: 151.2, spreadPips: 0.3 },
    });
    expect(t?.verdict).toBe('avoid');
    expect(t?.reasons[0].points).toBe(2);
    expect(t?.limit).not.toBeNull();
    // 押し目 50% = 150.2 が最も近い候補（現在値から 0.3 ATR 以上下・損切りより上）
    expect(t!.limit!.price).toBeCloseTo(150.2, 5);
    expect(t!.limit!.basis).toBe('押し目50%');
    // 指値で入ると RR は現在値より良くなる
    const nowRr = ((151.2 - price) / 0.01 - 0.3) / ((price - 149.85) / 0.01 + 0.3);
    expect(t!.limit!.rr!).toBeGreaterThan(nowRr);
  });

  it('売りは逆向きに判定する（安値圏の売りは安値売り注意）', () => {
    const price = 149.92;
    const d = { ...dow(149.9, 150.5, null), trend: 'down' as const, keyLevel: { price: 150.5, kind: 'rally_high' as const } };
    const t = assessEntryTiming({
      direction: 'short', price, instrument: 'USD_JPY',
      bars: bars([[150.2, 150.35], [150.05, 150.2], [149.92, 150.05]]),
      dow: d, zones: { res: [], sup: [zone('sup', 149.85, 149.9, price)] }, rsi: 22, stochK: 8,
      rr: { stop: 150.6, target: 149.3, spreadPips: 0.3 },
    });
    expect(t?.verdict).toBe('avoid');
    expect(t!.limit!.price).toBeGreaterThan(price);
    expect(t!.limit!.price).toBeLessThan(150.6);
  });

  it('足が足りなければ null', () => {
    expect(
      assessEntryTiming({ direction: 'long', price: 150, instrument: 'USD_JPY', bars: bars().slice(0, 5), dow: null, zones: null, rsi: null, stochK: null }),
    ).toBeNull();
  });
});
