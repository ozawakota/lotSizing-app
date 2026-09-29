import { describe, it, expect } from 'vitest';
import {
  CURRENCIES,
  computeStrengthScores,
  sortScores,
  formatWindowLabel,
  type StrengthScore,
  type StrengthSnapshot,
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
