import { describe, it, expect } from 'vitest';
import { normalizeNet, specLean, specStrength, pairSpecNet, toPairCot, type CotCurrency } from '../lib/flow';

describe('normalizeNet', () => {
  it('(long − short) / (long + short) を返す', () => {
    expect(normalizeNet(150, 50)).toBeCloseTo(0.5); // (150-50)/200
    expect(normalizeNet(50, 150)).toBeCloseTo(-0.5);
    expect(normalizeNet(100, 100)).toBe(0);
  });
  it('建玉ゼロ（0除算）は 0 を返す', () => {
    expect(normalizeNet(0, 0)).toBe(0);
  });
});

describe('specLean', () => {
  it('デッドバンド外は買い越し/売り越し、内は中立', () => {
    expect(specLean(0.3)).toBe('buy');
    expect(specLean(-0.3)).toBe('sell');
    expect(specLean(0.02)).toBe('neutral'); // |net| < 0.05
    expect(specLean(-0.04)).toBe('neutral');
  });
});

describe('specStrength', () => {
  it('偏りの大きさを弱/中/強に区分する', () => {
    expect(specStrength(0.2)).toBe('weak'); // < 0.34
    expect(specStrength(-0.5)).toBe('mid'); // 0.34〜0.67
    expect(specStrength(0.715)).toBe('strong'); // >= 0.67
  });
});

describe('pairSpecNet', () => {
  const net: Partial<Record<CotCurrency, number>> = { USD: 0.1, JPY: 0.6, EUR: 0.4, XAU: 0.8 };

  it('X/Y のネット = net(X) − net(Y)', () => {
    // USD/JPY は net(USD) − net(JPY)。JPY が買い越されているほど USD/JPY は売り（符号反転が自動処理）。
    expect(pairSpecNet(net, 'USD/JPY')).toBeCloseTo(0.1 - 0.6); // -0.5 → 売り越し
    expect(pairSpecNet(net, 'EUR/USD')).toBeCloseTo(0.4 - 0.1); // +0.3 → 買い越し
    expect(pairSpecNet(net, 'XAU/USD')).toBeCloseTo(0.8 - 0.1); // +0.7 → 買い越し
  });

  it('いずれかの通貨が欠ければ undefined', () => {
    expect(pairSpecNet(net, 'GBP/JPY')).toBeUndefined(); // GBP 無し
  });
});

describe('toPairCot', () => {
  const net: Partial<Record<CotCurrency, number>> = { USD: 0.1, JPY: 0.6 };
  const prev: Partial<Record<CotCurrency, number>> = { USD: 0.1, JPY: 0.4 };

  it('USD/JPY の売り越しと前週比を組み立てる', () => {
    const cot = toPairCot(net, prev, 'USD/JPY');
    expect(cot).toBeDefined();
    expect(cot!.net).toBeCloseTo(-0.5);
    expect(cot!.lean).toBe('sell');
    // 当週 -0.5、前週 (0.1-0.4)=-0.3 → 変化 -0.2（さらに売り越しが強化）
    expect(cot!.deltaNet).toBeCloseTo(-0.2);
  });

  it('前週データが無ければ deltaNet は undefined', () => {
    const cot = toPairCot(net, { USD: 0.1 }, 'USD/JPY');
    expect(cot!.deltaNet).toBeUndefined();
  });

  it('合成できないペアは undefined', () => {
    expect(toPairCot(net, prev, 'GBP/USD')).toBeUndefined();
  });
});
