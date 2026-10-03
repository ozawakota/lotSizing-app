import { describe, it, expect } from 'vitest';
import {
  COOLDOWN_MS,
  WINDOW_MS,
  evaluate,
  formatAlertBody,
  pruneWindow,
  rangePips,
  type Sample,
} from '../alert';

const T0 = 1_700_000_000_000; // 基準時刻（epoch ms）
const min = (n: number) => n * 60 * 1000;

describe('pruneWindow', () => {
  it('窓より古いサンプルを落とす', () => {
    const now = T0 + min(20);
    const samples: Sample[] = [
      { ts: T0, bid: 150.0 }, // 20分前 → 落ちる
      { ts: T0 + min(6), bid: 150.1 }, // 14分前 → 残る
      { ts: T0 + min(20), bid: 150.2 }, // 今 → 残る
    ];
    expect(pruneWindow(samples, now)).toHaveLength(2);
  });

  it('ちょうど15分前は窓内に含む（境界）', () => {
    const now = T0 + WINDOW_MS;
    expect(pruneWindow([{ ts: T0, bid: 150 }], now)).toHaveLength(1);
  });
});

describe('rangePips', () => {
  it('JPYクロスは 0.01 を 1pip として換算', () => {
    const samples: Sample[] = [
      { ts: T0, bid: 150.0 },
      { ts: T0 + 1, bid: 150.25 },
    ];
    expect(rangePips(samples, 'USD/JPY')).toBeCloseTo(25, 6);
  });

  it('EUR/USD は 0.0001 を 1pip として換算', () => {
    const samples: Sample[] = [
      { ts: T0, bid: 1.1 },
      { ts: T0 + 1, bid: 1.1025 },
    ];
    expect(rangePips(samples, 'EUR/USD')).toBeCloseTo(25, 6);
  });

  it('サンプルが1つなら 0', () => {
    expect(rangePips([{ ts: T0, bid: 150 }], 'USD/JPY')).toBe(0);
  });
});

describe('evaluate', () => {
  it('25pips未満なら発火せず窓に追加する', () => {
    const r = evaluate({
      pair: 'USD/JPY',
      samples: [{ ts: T0, bid: 150.0 }],
      newSample: { ts: T0 + min(1), bid: 150.1 },
      cooldownUntil: null,
      now: T0 + min(1),
    });
    expect(r.triggered).toBe(false);
    expect(r.samples).toHaveLength(2);
    expect(r.cooldownUntil).toBeNull();
  });

  it('15分窓内で25pips以上なら発火しクールダウンを開始・窓リセット', () => {
    const now = T0 + min(10);
    const r = evaluate({
      pair: 'USD/JPY',
      samples: [{ ts: T0, bid: 150.0 }],
      newSample: { ts: now, bid: 150.25 },
      cooldownUntil: null,
      now,
    });
    expect(r.triggered).toBe(true);
    expect(r.rangePips).toBeCloseTo(25, 6);
    expect(r.cooldownUntil).toBe(now + COOLDOWN_MS);
    expect(r.samples).toEqual([]);
  });

  it('古い高値が窓から外れると発火しない', () => {
    const now = T0 + min(20);
    const r = evaluate({
      pair: 'USD/JPY',
      samples: [{ ts: T0, bid: 150.3 }], // 20分前の高値 → 窓外
      newSample: { ts: now, bid: 150.0 },
      cooldownUntil: null,
      now,
    });
    expect(r.triggered).toBe(false);
    expect(r.samples).toHaveLength(1); // 古いサンプルは落ちている
  });

  it('クールダウン中は測定休止（サンプルを捨て発火しない）', () => {
    const now = T0 + min(5);
    const r = evaluate({
      pair: 'USD/JPY',
      samples: [],
      newSample: { ts: now, bid: 150.9 },
      cooldownUntil: T0 + COOLDOWN_MS, // まだ明けていない
      now,
    });
    expect(r.triggered).toBe(false);
    expect(r.samples).toEqual([]);
    expect(r.cooldownUntil).toBe(T0 + COOLDOWN_MS);
  });

  it('クールダウン明け後は通常測定を再開する', () => {
    const now = T0 + COOLDOWN_MS + min(1);
    const r = evaluate({
      pair: 'USD/JPY',
      samples: [],
      newSample: { ts: now, bid: 150.0 },
      cooldownUntil: T0 + COOLDOWN_MS,
      now,
    });
    expect(r.cooldownUntil).toBeNull();
    expect(r.samples).toHaveLength(1);
  });
});

describe('formatAlertBody', () => {
  it('JPYクロスは小数3桁・pips四捨五入', () => {
    expect(formatAlertBody('USD/JPY', 150.35, 150.1)).toBe('USD/JPY が15分で25pips変動（150.100 → 150.350）');
  });

  it('EUR/USD は小数5桁', () => {
    expect(formatAlertBody('EUR/USD', 1.1025, 1.1)).toBe('EUR/USD が15分で25pips変動（1.10000 → 1.10250）');
  });
});
