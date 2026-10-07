import { describe, it, expect } from 'vitest';
import {
  assessRiskReward,
  buildPaJevRequest,
  buildSessionJevRequest,
  computeStopLoss,
  computeStructure,
  parseBreakoutJev,
  parsePaAi,
  parsePaJev,
  parseSessionJev,
  pipSize,
  type Candle,
  type SessionState,
  type SlStructure,
} from '../stoploss';

const mkCandles = (vals: [number, number, number][]): Candle[] =>
  vals.map(([high, low, close]) => ({ high, low, close }));

describe('pipSize', () => {
  it('returns the right pip per instrument class', () => {
    expect(pipSize('XAU_USD')).toBe(0.1);
    expect(pipSize('USD_JPY')).toBe(0.01);
    expect(pipSize('GBP_USD')).toBe(0.0001);
  });
});

describe('computeStructure', () => {
  it('detects an uptrend and the swing high/low over the lookback', () => {
    const candles = mkCandles([
      [1.0, 0.9, 0.95],
      [1.1, 1.0, 1.05],
      [1.2, 1.1, 1.18],
    ]);
    const s = computeStructure(candles, 1.18, 3);
    expect(s.trend).toBe('up');
    expect(s.swingHigh).toBe(1.2);
    expect(s.swingLow).toBe(0.9);
    expect(s.currentRate).toBe(1.18);
  });

  it('falls back to currentRate when there are no candles', () => {
    const s = computeStructure([], 1.23);
    expect(s).toMatchObject({ trend: 'range', swingHigh: 1.23, swingLow: 1.23, currentRate: 1.23 });
  });
});

describe('computeStopLoss', () => {
  const structure = { trend: 'up' as const, swingHigh: 1.32, swingLow: 1.3, currentRate: 1.315 };

  it('places a long stop below the swing low with a buffer', () => {
    const sl = computeStopLoss(structure, 'long', 1.315, 'GBP_USD');
    expect(sl.basis).toBe('swing_low');
    expect(sl.reference).toBe(1.3);
    expect(sl.price).toBeLessThan(1.3); // below swing low
    expect(sl.distancePips).toBeGreaterThan(0);
  });

  it('places a short stop above the swing high', () => {
    const sl = computeStopLoss(structure, 'short', null, 'GBP_USD');
    expect(sl.basis).toBe('swing_high');
    expect(sl.price).toBeGreaterThan(1.32);
  });
});

describe('buildPaJevRequest', () => {
  it('creates one price_action choice question with the 4 classes and state', () => {
    const { state, questions } = buildPaJevRequest(
      { trend: 'down', swingHigh: 1.32, swingLow: 1.3, currentRate: 1.305 },
      [1.31, 1.308, 1.305],
    );
    expect((state as { trend: string }).trend).toBe('down');
    const q = questions.price_action as { type: string; criteria: Record<string, string> };
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria).sort()).toEqual(['buy_dip', 'range', 'reversal', 'sell_rally']);
  });

  it('omits sessionStatus from state when not provided', () => {
    const { state } = buildPaJevRequest({ trend: 'up', swingHigh: 1.2, swingLow: 1.1, currentRate: 1.15 }, [1.1, 1.15]);
    expect('sessionStatus' in (state as object)).toBe(false);
  });

  it('includes sessionStatus in state and instructions when provided', () => {
    const { state, questions } = buildPaJevRequest(
      { trend: 'up', swingHigh: 1.2, swingLow: 1.1, currentRate: 1.15 },
      [1.1, 1.15],
      '東京: 開場 / ロンドン: 閉場',
    );
    expect((state as { sessionStatus?: string }).sessionStatus).toBe('東京: 開場 / ロンドン: 閉場');
    const breakout = questions.breakout as { instructions: string };
    const pa = questions.price_action as { instructions: string };
    expect(breakout.instructions).toContain('セッション');
    expect(pa.instructions).toContain('セッション');
  });
});

describe('parsePaJev', () => {
  it('maps the chosen class, its probability and confidence', () => {
    const r = parsePaJev({
      price_action: { choice: 'sell_rally', probabilities: { sell_rally: 0.64, reversal: 0.2, buy_dip: 0.1, range: 0.06 }, confidence: 0.7 },
    });
    expect(r.pa).toBe('sell_rally');
    expect(r.paPct).toBe(64);
    expect(r.confidence).toBeCloseTo(0.7, 6);
  });

  it('defaults to range when missing', () => {
    expect(parsePaJev({}).pa).toBe('range');
  });
});

describe('parsePaAi', () => {
  it('parses a JSON string and clamps', () => {
    const r = parsePaAi('{"pa":"buy_dip","paPct":150,"confidence":0.8}');
    expect(r.pa).toBe('buy_dip');
    expect(r.paPct).toBe(100);
    expect(r.confidence).toBeCloseTo(0.8, 6);
  });

  it('falls back to range on garbage', () => {
    expect(parsePaAi('nonsense').pa).toBe('range');
  });
});

describe('parseBreakoutJev', () => {
  it('normalizes the three probabilities to 0-100 summing to 100', () => {
    const r = parseBreakoutJev({
      breakout: { probabilities: { break_up: 0.6, break_down: 0.1, stay_range: 0.3 } },
    });
    expect(r).not.toBeNull();
    expect(r!.up + r!.down + r!.range).toBe(100);
    expect(r!.up).toBe(60);
    expect(r!.down).toBe(10);
  });

  it('returns null when the breakout answer is missing', () => {
    expect(parseBreakoutJev({})).toBeNull();
    expect(parseBreakoutJev(undefined)).toBeNull();
  });
});

describe('assessRiskReward', () => {
  // USD_JPY: pip=0.01。レンジ 150.00–150.50, 現在 150.40。ロングの損切りは安値の少し下。
  const structure: SlStructure = { trend: 'up', swingHigh: 150.5, swingLow: 150.0, currentRate: 150.4 };

  it('qualifies when reward (higher-TF swing) is >=3x risk and bias is strong', () => {
    const rr = assessRiskReward(structure, 'long', 60, [{ swingHigh: 152.0, swingLow: 149.0 }], 'USD_JPY');
    expect(rr).not.toBeNull();
    expect(rr!.direction).toBe('long');
    expect(rr!.target).toBe(152.0); // 進行方向で最も近い上位TF高値
    expect(rr!.rr).toBeGreaterThanOrEqual(3);
    expect(rr!.qualifies).toBe(true);
  });

  it('does not qualify when the nearest higher-TF swing is too close (RR<3)', () => {
    const rr = assessRiskReward(structure, 'long', 60, [{ swingHigh: 151.0, swingLow: 149.0 }], 'USD_JPY');
    expect(rr!.rr).toBeLessThan(3);
    expect(rr!.qualifies).toBe(false);
  });

  it('does not qualify when direction probability is below the gate even if RR>=3', () => {
    const rr = assessRiskReward(structure, 'long', 40, [{ swingHigh: 152.0, swingLow: 149.0 }], 'USD_JPY');
    expect(rr!.rr).toBeGreaterThanOrEqual(3);
    expect(rr!.qualifies).toBe(false);
  });

  it('returns null when no higher-TF swing lies ahead in the trade direction', () => {
    // すべての上位TF高値が現在値より下 → ロングの目標が無い
    const rr = assessRiskReward(structure, 'long', 60, [{ swingHigh: 150.2, swingLow: 149.0 }], 'USD_JPY');
    expect(rr).toBeNull();
  });
});

describe('buildSessionJevRequest', () => {
  const state: SessionState = {
    trend: 'up',
    currentRate: 150.4,
    swingHigh: 150.8,
    swingLow: 149.5,
    alignment: '上向き優勢',
    breakoutBias: '15m:上 30m:継続 1h:上 4h:上',
    recentCloses: [150.1, 150.2, 150.3, 150.4],
    sessionStatus: '【市場セッション】東京:開場中 ロンドン:閉場 ニューヨーク:閉場',
  };

  it('creates three session choice questions over the 5 scenarios with state', () => {
    const { state: s, questions } = buildSessionJevRequest(state);
    expect((s as { alignment: string }).alignment).toBe('上向き優勢');
    expect(Object.keys(questions).sort()).toEqual(['london', 'ny', 'tokyo']);
    const q = questions.tokyo as { type: string; criteria: Record<string, string> };
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria).sort()).toEqual(['breakout', 'buy_dip', 'range', 'reversal', 'sell_rally']);
  });
});

describe('parseSessionJev', () => {
  it('maps each session to its chosen scenario, probability and confidence', () => {
    const r = parseSessionJev({
      tokyo: { choice: 'buy_dip', probabilities: { buy_dip: 0.58, reversal: 0.2, range: 0.22 }, confidence: 0.6 },
      london: { choice: 'breakout', probabilities: { breakout: 0.64, buy_dip: 0.2, range: 0.16 }, confidence: 0.55 },
      ny: { choice: 'reversal', probabilities: { reversal: 0.47, range: 0.33, breakout: 0.2 }, confidence: 0.5 },
    });
    expect(r).not.toBeNull();
    expect(r!.tokyo).toMatchObject({ scenario: 'buy_dip', pct: 58 });
    expect(r!.london).toMatchObject({ scenario: 'breakout', pct: 64 });
    expect(r!.ny.scenario).toBe('reversal');
  });

  it('returns null when any of the three sessions is missing', () => {
    expect(parseSessionJev({ tokyo: { choice: 'range' }, london: { choice: 'range' } })).toBeNull();
    expect(parseSessionJev(undefined)).toBeNull();
  });
});
