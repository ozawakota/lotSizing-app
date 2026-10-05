import { describe, it, expect } from 'vitest';
import {
  CURRENCIES,
  computeStrengthScores,
  sortScores,
  formatWindowLabel,
  findStartIndex,
  computeCumulativeStrength,
  computeGoldLine,
  type StrengthScore,
  type StrengthSnapshot,
  type RateSeries,
} from '../strength';

describe('computeStrengthScores', () => {
  it('returns one score per supported currency', () => {
    const flat = { USD: 100, EUR: 100, GBP: 100, AUD: 100, NZD: 100, CAD: 100, CHF: 100 };
    const scores = computeStrengthScores(flat, { ...flat });
    expect(scores).toHaveLength(CURRENCIES.length);
    expect(scores.map((s) => s.currency).sort()).toEqual([...CURRENCIES].sort());
  });

  it('scores are all zero when nothing moves', () => {
    const flat = { USD: 100, EUR: 100, GBP: 100, AUD: 100, NZD: 100, CAD: 100, CHF: 100 };
    const scores = computeStrengthScores(flat, { ...flat });
    for (const s of scores) expect(s.changePct).toBeCloseTo(0, 6);
  });

  it('ranks the only rising currency on top and sums to about zero', () => {
    const start = { USD: 100, EUR: 100, GBP: 100, AUD: 100, NZD: 100, CAD: 100, CHF: 100 };
    const end = { ...start, USD: 101 }; // USD +1% vs JPY
    const scores = computeStrengthScores(start, end);

    const ranked = sortScores(scores);
    expect(ranked[0].currency).toBe('USD');
    expect(ranked[0].changePct).toBeCloseTo(1.0, 3);

    const sum = scores.reduce((acc, s) => acc + s.changePct, 0);
    expect(Math.abs(sum)).toBeLessThan(0.02);
  });

  it('treats JPY as the base with zero own-return', () => {
    // Every non-JPY currency falls 1% vs JPY -> JPY should be the strongest.
    const start = { USD: 100, EUR: 100, GBP: 100, AUD: 100, NZD: 100, CAD: 100, CHF: 100 };
    const end = { USD: 99, EUR: 99, GBP: 99, AUD: 99, NZD: 99, CAD: 99, CHF: 99 };
    const ranked = sortScores(computeStrengthScores(start, end));
    expect(ranked[0].currency).toBe('JPY');
  });

  it('throws when a pair close is missing', () => {
    const start = { USD: 100, EUR: 100, GBP: 100, AUD: 100, NZD: 100, CAD: 100, CHF: 100 };
    const end = { USD: 101, EUR: 100, GBP: 100, AUD: 100, NZD: 100, CAD: 100 }; // CHF missing
    expect(() => computeStrengthScores(start, end)).toThrow();
  });
});

describe('sortScores', () => {
  it('orders descending by changePct without mutating the input', () => {
    const input: StrengthScore[] = [
      { currency: 'JPY', changePct: -0.5 },
      { currency: 'USD', changePct: 0.9 },
      { currency: 'EUR', changePct: 0.1 },
    ];
    const out = sortScores(input);
    expect(out.map((s) => s.currency)).toEqual(['USD', 'EUR', 'JPY']);
    expect(input[0].currency).toBe('JPY'); // original untouched
  });
});

describe('formatWindowLabel', () => {
  it('joins the two window times with an arrow', () => {
    const snapshot: StrengthSnapshot = {
      windowStart: '09:00',
      windowEnd: '10:00',
      computedAt: 0,
      scores: [],
    };
    expect(formatWindowLabel(snapshot)).toBe('09:00 → 10:00');
  });
});

const flatRow = { USD: 100, EUR: 100, GBP: 100, AUD: 100, NZD: 100, CAD: 100, CHF: 100 };

// Build an aligned RateSeries from per-datetime rate rows.
const makeSeries = (
  interval: string,
  points: Array<{ dt: string; rates: Record<string, number> }>,
): RateSeries => ({
  interval,
  datetimes: points.map((p) => p.dt),
  rates: {
    USD: points.map((p) => p.rates.USD),
    EUR: points.map((p) => p.rates.EUR),
    GBP: points.map((p) => p.rates.GBP),
    AUD: points.map((p) => p.rates.AUD),
    NZD: points.map((p) => p.rates.NZD),
    CAD: points.map((p) => p.rates.CAD),
    CHF: points.map((p) => p.rates.CHF),
  },
});

describe('findStartIndex', () => {
  const dts = [
    '2026-09-29 22:00:00',
    '2026-09-30 00:00:00',
    '2026-09-30 06:00:00',
    '2026-09-30 09:00:00',
    '2026-09-30 10:00:00',
  ];
  const now = new Date('2026-09-30T01:05:00Z'); // 10:05 JST on 2026-09-30

  it("'today' picks the first bar on today's JST date", () => {
    expect(findStartIndex(dts, 'today', now)).toBe(1); // 2026-09-30 00:00
  });

  it("'4h' picks the first bar at/after now-4h", () => {
    // now-4h = 06:05 JST -> first bar >= that is index 3 (09:00)
    expect(findStartIndex(dts, '4h', now)).toBe(3);
  });

  it("'1h' picks the first bar at/after now-1h", () => {
    // now-1h = 09:05 JST -> first bar >= that is index 4 (10:00)
    expect(findStartIndex(dts, '1h', now)).toBe(4);
  });

  it("'year' picks the first bar in the current JST year", () => {
    const yearDts = ['2025-12-31 00:00:00', '2026-01-05 00:00:00', '2026-09-30 00:00:00'];
    expect(findStartIndex(yearDts, 'year', now)).toBe(1);
  });
});

describe('computeCumulativeStrength', () => {
  it('starts every currency at 0 and keeps the sum ~0 at each point', () => {
    const series = makeSeries('15min', [
      { dt: '2026-09-30 09:00:00', rates: { ...flatRow } },
      { dt: '2026-09-30 09:15:00', rates: { ...flatRow, USD: 101 } }, // USD +1% vs JPY
      { dt: '2026-09-30 09:30:00', rates: { ...flatRow, USD: 102 } },
    ]);
    const { datetimes, series: out, latest } = computeCumulativeStrength(series, 0);

    expect(datetimes).toHaveLength(3);
    for (const c of CURRENCIES) expect(out[c][0]).toBeCloseTo(0, 9); // 0 baseline
    for (let i = 0; i < 3; i++) {
      const sum = CURRENCIES.reduce((acc, c) => acc + out[c][i], 0);
      expect(Math.abs(sum)).toBeLessThan(1e-6);
    }
    // USD rose the most -> strongest at the end
    expect(sortScores(latest)[0].currency).toBe('USD');
    expect(latest.find((s) => s.currency === 'USD')!.changePct).toBeGreaterThan(0);
  });

  it('slices from the given start index', () => {
    const series = makeSeries('15min', [
      { dt: 'a', rates: { ...flatRow } },
      { dt: 'b', rates: { ...flatRow, USD: 101 } },
      { dt: 'c', rates: { ...flatRow, USD: 102 } },
    ]);
    const res = computeCumulativeStrength(series, 1);
    expect(res.datetimes).toEqual(['b', 'c']);
    for (const c of CURRENCIES) expect(res.series[c][0]).toBeCloseTo(0, 9); // baseline at index 1
  });
});

describe('computeGoldLine', () => {
  // XAU/JPY の合成系列を付与したシリーズを作る。
  const withXau = (base: RateSeries, xau: number[]): RateSeries => ({
    ...base,
    rates: { ...base.rates, XAU: xau },
  });

  it('returns null when the series carries no XAU data', () => {
    const series = makeSeries('15min', [
      { dt: 'a', rates: { ...flatRow } },
      { dt: 'b', rates: { ...flatRow } },
    ]);
    expect(computeGoldLine(series, 0)).toBeNull();
  });

  it('starts at 0 and is positive when gold rises against a flat basket', () => {
    const base = makeSeries('15min', [
      { dt: 'a', rates: { ...flatRow } },
      { dt: 'b', rates: { ...flatRow } },
      { dt: 'c', rates: { ...flatRow } },
    ]);
    // ゴールドは +1% ずつ上昇、法定通貨は全て不変。
    const series = withXau(base, [2000, 2020, 2040.2]);
    const line = computeGoldLine(series, 0)!;

    expect(line).toHaveLength(3);
    expect(line[0]).toBeCloseTo(0, 9); // 起点は0
    // 期待値 = 8 × ln(XAU_i/XAU_0) × 100（バスケットは0）。
    expect(line[1]).toBeCloseTo(8 * Math.log(2020 / 2000) * 100, 6);
    expect(line[2]).toBeGreaterThan(line[1]);
  });

  it('honors the start index (0 at the chosen baseline)', () => {
    const base = makeSeries('15min', [
      { dt: 'a', rates: { ...flatRow } },
      { dt: 'b', rates: { ...flatRow } },
      { dt: 'c', rates: { ...flatRow } },
    ]);
    const series = withXau(base, [2000, 2020, 2040]);
    const line = computeGoldLine(series, 1)!;
    expect(line).toHaveLength(2);
    expect(line[0]).toBeCloseTo(0, 9); // 起点(index=1)で0
  });

  it('does not change the 8-currency strength when XAU is present', () => {
    const points = [
      { dt: 'a', rates: { ...flatRow } },
      { dt: 'b', rates: { ...flatRow, USD: 101 } },
    ];
    const without = computeCumulativeStrength(makeSeries('15min', points), 0);
    const withGold = computeCumulativeStrength(withXau(makeSeries('15min', points), [2000, 2100]), 0);
    for (const c of CURRENCIES) {
      expect(withGold.series[c]).toEqual(without.series[c]);
    }
  });
});
