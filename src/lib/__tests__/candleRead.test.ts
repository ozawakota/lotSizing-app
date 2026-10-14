import { describe, it, expect } from 'vitest';
import { patternConfirmation, patternQuality, patternZone, readCandlePatterns } from '../candleRead';
import type { OhlcCandle } from '../edge';

const c = (open: number, high: number, low: number, close: number): OhlcCandle => ({ open, high, low, close });
// 値幅0.1前後の平凡な足（ATR の基準）
const flat = (n: number, p = 150): OhlcCandle[] => Array.from({ length: n }, (_, i) => c(p, p + 0.05, p - 0.05, p + (i % 2 ? 0.02 : -0.02)));

describe('patternQuality（形の質）', () => {
  it('長ヒゲが長く、足が大きいピンバーほど高得点', () => {
    const base = flat(20);
    const weak = [...base, c(150.0, 150.012, 149.9, 150.01)]; // 下ヒゲ比率 ≈0.82、値幅≈ATR
    const strong = [...base, c(150.0, 150.005, 149.7, 150.004)]; // 下ヒゲ比率 ≈0.98、値幅≈3ATR
    const q1 = patternQuality(weak, weak.length - 1, 'bull_pinbar');
    const q2 = patternQuality(strong, strong.length - 1, 'bull_pinbar');
    expect(q2).toBeGreaterThan(q1);
    expect(q2).toBeLessThanOrEqual(100);
    expect(q1).toBeGreaterThanOrEqual(0);
  });

  it('包み足はヒゲまで包み、実体が大きいほど高得点', () => {
    const base = flat(20);
    const prev = c(150.05, 150.07, 149.98, 150.0);
    const small = [...base, prev, c(149.99, 150.06, 149.99, 150.06)];
    const big = [...base, prev, c(149.97, 150.2, 149.95, 150.19)];
    expect(patternQuality(big, big.length - 1, 'bull_engulfing')).toBeGreaterThan(patternQuality(small, small.length - 1, 'bull_engulfing'));
  });
});

describe('patternZone（出た場所）', () => {
  it('過去の押し安値付近の強気パターンは key、離れていれば mid', () => {
    // 149.80 の押し安値を作ってから戻し、再び 149.80 付近でピンバー
    const bars = [
      ...flat(10),
      c(150, 150.05, 149.9, 149.92), c(149.92, 149.95, 149.8, 149.85), c(149.85, 149.95, 149.81, 149.93),
      c(149.93, 150.05, 149.9, 150.0), ...flat(8),
      c(149.95, 149.97, 149.79, 149.96),
    ];
    const i = bars.length - 1;
    expect(patternZone(bars, i, 'bull_pinbar', 'USD_JPY')).toEqual({ zone: 'key', reasons: ['押し安値'] });
    const far = [...flat(30, 151.3), c(151.25, 151.27, 151.09, 151.26)];
    expect(patternZone(far, far.length - 1, 'bull_pinbar', 'USD_JPY').zone).toBe('mid');
  });

  it('渡したライン（上位足など）やキリ番の近くも key として理由に出る', () => {
    const bars = [...flat(20, 150.3), c(150.25, 150.27, 150.1, 150.26)];
    const z = patternZone(bars, bars.length - 1, 'bull_pinbar', 'USD_JPY', [{ price: 150.12, label: '1時間足の安値' }]);
    expect(z.zone).toBe('key');
    expect(z.reasons).toContain('1時間足の安値');
    const r = [...flat(20, 150.2), c(150.15, 150.17, 150.0, 150.16)]; // 安値 150.00 = キリ番
    expect(patternZone(r, r.length - 1, 'bull_pinbar', 'USD_JPY').reasons).toContain('キリ番');
  });
});

describe('patternConfirmation（確定/否定）', () => {
  const pin = c(150.0, 150.01, 149.8, 150.0);
  it('その後の終値が高値を上抜ければ確定、安値を下抜ければ否定、どちらも無ければ未確定', () => {
    expect(patternConfirmation([pin, c(150, 150.05, 149.95, 150.03)], 0, 'bull_pinbar')).toBe('confirmed');
    expect(patternConfirmation([pin, c(150, 150.0, 149.7, 149.75)], 0, 'bull_pinbar')).toBe('invalidated');
    expect(patternConfirmation([pin, c(150, 150.0, 149.9, 149.95)], 0, 'bull_pinbar')).toBe('pending');
    expect(patternConfirmation([pin], 0, 'bull_pinbar')).toBe('pending');
  });
  it('先に起きた方を採る', () => {
    expect(patternConfirmation([pin, c(150, 150.05, 149.95, 150.03), c(150, 150, 149.6, 149.7)], 0, 'bull_pinbar')).toBe('confirmed');
  });
});

describe('readCandlePatterns', () => {
  it('期間内のパターンを新しい順に最大件数まで返し、期間外は含めない', () => {
    const pinUp = (p: number) => c(p, p + 0.005, p - 0.3, p + 0.004);
    const bars = [...flat(20), pinUp(150), ...flat(3), pinUp(150), ...flat(2), pinUp(150), ...flat(1), pinUp(150)];
    const reads = readCandlePatterns(bars, { instrument: 'USD_JPY', windowBars: 10, maxCount: 3 });
    expect(reads.map((r) => r.barsAgo)).toEqual([0, 2, 5]); // 新しい順・3件まで
    expect(reads.every((r) => r.key === 'bull_pinbar' && r.label === '下ヒゲピンバー')).toBe(true);
    const narrow = readCandlePatterns(bars, { instrument: 'USD_JPY', windowBars: 1 });
    expect(narrow.map((r) => r.barsAgo)).toEqual([0]);
  });
});
