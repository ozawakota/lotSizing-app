import { describe, it, expect } from 'vitest';
import {
  MIN_SAMPLES,
  analyzePairEdge,
  closedCandles,
  computePatternStats,
  currencyBias,
  detectPatterns,
  isBearishEngulfing,
  isBearishPinbar,
  isBullishEngulfing,
  isBullishPinbar,
  verdictOf,
  type OhlcCandle,
  type PairEdge,
} from '../edge';

const c = (open: number, high: number, low: number, close: number): OhlcCandle => ({ open, high, low, close });

describe('ピンバー判定', () => {
  it('下ヒゲが全値幅の66%以上なら強気ピンバー（陽線・陰線とも）', () => {
    expect(isBullishPinbar(c(1.009, 1.01, 1.0, 1.0095))).toBe(true); // 陽線: 下ヒゲ 0.009/0.01
    expect(isBullishPinbar(c(1.0095, 1.01, 1.0, 1.009))).toBe(true); // 陰線: 下ヒゲ 0.009/0.01
    expect(isBullishPinbar(c(1.005, 1.01, 1.0, 1.006))).toBe(false); // 下ヒゲ 50%
  });

  it('上ヒゲが全値幅の66%以上なら弱気ピンバー', () => {
    expect(isBearishPinbar(c(1.001, 1.01, 1.0, 1.0005))).toBe(true);
    expect(isBearishPinbar(c(1.001, 1.01, 1.0, 1.005))).toBe(false);
  });

  it('値幅ゼロの足はピンバーにしない', () => {
    expect(isBullishPinbar(c(1, 1, 1, 1))).toBe(false);
    expect(isBearishPinbar(c(1, 1, 1, 1))).toBe(false);
  });
});

describe('包み足判定', () => {
  it('陰線の実体を陽線の実体が包めば強気の包み足', () => {
    expect(isBullishEngulfing(c(1.005, 1.006, 1.002, 1.003), c(1.003, 1.008, 1.001, 1.006))).toBe(true);
    // 今足の終値が前足の始値に届かない
    expect(isBullishEngulfing(c(1.005, 1.006, 1.002, 1.003), c(1.003, 1.008, 1.001, 1.004))).toBe(false);
    // 前足が陽線
    expect(isBullishEngulfing(c(1.003, 1.006, 1.002, 1.005), c(1.002, 1.008, 1.001, 1.006))).toBe(false);
  });

  it('陽線の実体を陰線の実体が包めば弱気の包み足', () => {
    expect(isBearishEngulfing(c(1.003, 1.006, 1.002, 1.005), c(1.005, 1.006, 1.0, 1.002))).toBe(true);
    expect(isBearishEngulfing(c(1.003, 1.006, 1.002, 1.005), c(1.005, 1.006, 1.0, 1.004))).toBe(false);
  });

  it('先頭の足では包み足を判定しない', () => {
    expect(detectPatterns([c(1.003, 1.008, 1.001, 1.006)], 0)).toEqual([]);
  });
});

describe('verdictOf', () => {
  it('サンプル不足を最優先', () => {
    expect(verdictOf(MIN_SAMPLES - 1, 50, 10)).toBe('insufficient');
  });
  it('エッジと平均pipsで段階判定', () => {
    expect(verdictOf(20, 12, 5)).toBe('strong');
    expect(verdictOf(20, 5, 5)).toBe('weak');
    expect(verdictOf(20, 5, -1)).toBe('none');
    expect(verdictOf(20, -8, -3)).toBe('negative');
  });
});

// 下ヒゲピンバー → 3本かけて上昇、を繰り返す合成データ（ピンバーに買いの優位性がある相場）。
function bullishPinbarMarket(cycles: number): OhlcCandle[] {
  const out: OhlcCandle[] = [];
  let p = 150;
  for (let k = 0; k < cycles; k++) {
    // 下ヒゲピンバー（陽線）
    out.push({ open: p, high: p + 0.02, low: p - 0.3, close: p + 0.01 });
    p += 0.01;
    // 小さな陽線で上昇（ピンバーにならない実体の大きい足）
    for (let j = 0; j < 3; j++) {
      out.push({ open: p, high: p + 0.12, low: p - 0.01, close: p + 0.1 });
      p += 0.1;
    }
    // 小さな陰線で押し戻し
    out.push({ open: p, high: p + 0.01, low: p - 0.16, close: p - 0.15 });
    p -= 0.15;
  }
  return out;
}

describe('computePatternStats', () => {
  it('ピンバー後に上昇する相場では下ヒゲピンバーの勝率・エッジがプラス', () => {
    const candles = bullishPinbarMarket(20);
    const stats = computePatternStats(candles, 'USD_JPY', 3);
    const pin = stats.find((s) => s.pattern === 'bull_pinbar')!;
    expect(pin.count).toBeGreaterThanOrEqual(MIN_SAMPLES);
    expect(pin.winRate).toBe(100);
    expect(pin.avgPips).toBeCloseTo(30, 0); // 3本先まで +0.1×3 = 0.30円 = 30pips
    expect(pin.edge).toBeGreaterThan(0);
    expect(pin.verdict).toBe('strong');
    expect(pin.profitFactor).toBeNull(); // 負けなし
  });

  it('結果が確定しない末尾 horizon 本は母数に含めない', () => {
    const candles = bullishPinbarMarket(2); // 10本、ピンバーは 0 と 5
    const stats = computePatternStats(candles, 'USD_JPY', 6); // 検証可能は i ≤ 3
    expect(stats.find((s) => s.pattern === 'bull_pinbar')!.count).toBe(1);
  });
});

describe('取引コスト（スプレッド）の控除', () => {
  it('平均pipsからコストを差し引き、コストが値動きを上回れば勝てない', () => {
    const candles = bullishPinbarMarket(20);
    const pin = (cost: number) =>
      computePatternStats(candles, 'USD_JPY', 3, undefined, cost).find((s) => s.pattern === 'bull_pinbar')!;
    expect(pin(1).avgPips).toBeCloseTo(29, 0); // 30pips − 1pips
    expect(pin(40).winRate).toBe(0); // 30pips の値動きでは 40pips のコストを超えられない
    expect(pin(40).verdict).not.toBe('strong');
  });

  it('ベースラインの勝率も同じコストで評価する', () => {
    const candles = bullishPinbarMarket(20);
    const base = (cost: number) =>
      computePatternStats(candles, 'USD_JPY', 3, undefined, cost).find((s) => s.pattern === 'bull_pinbar')!.baselineWinRate;
    expect(base(0)).toBeGreaterThan(base(10));
  });

  it('analyzePairEdge はコストを spreadPips として返す', () => {
    expect(analyzePairEdge(bullishPinbarMarket(20), 'USD_JPY', 3, undefined, 0.84).spreadPips).toBe(0.8);
  });
});

describe('closedCandles', () => {
  it('足の終了時刻が現在以前のものだけ残す（形成中の足を除外）', () => {
    const at = (t: number): OhlcCandle => ({ open: 1, high: 1, low: 1, close: 1, t });
    const now = 1_700_000_000_000; // ms
    const bars = [at(now / 1000 - 180), at(now / 1000 - 120), at(now / 1000 - 60), at(now / 1000 - 30)];
    expect(closedCandles(bars, '1m', now).map((b) => b.t)).toEqual([now / 1000 - 180, now / 1000 - 120, now / 1000 - 60]);
    expect(closedCandles([{ open: 1, high: 1, low: 1, close: 1 }], '1m', now)).toEqual([]); // 時刻なしは除外
  });
});

describe('analyzePairEdge', () => {
  it('最新確定足に優位性のあるパターンが出ていれば買いシグナル', () => {
    const candles = bullishPinbarMarket(20);
    // 最新足を下ヒゲピンバーで終える
    const p = candles[candles.length - 1].close;
    candles.push({ open: p, high: p + 0.02, low: p - 0.3, close: p + 0.01, t: 1_700_000_000 });
    const edge = analyzePairEdge(candles, 'USD_JPY', 3);
    expect(edge.current).toContain('bull_pinbar');
    expect(edge.signal).toBe('buy');
    expect(edge.score).toBeGreaterThan(0);
    expect(edge.lastClosedAt).toBe(1_700_000_000);
  });

  it('パターンが出ていなければ様子見', () => {
    const candles = bullishPinbarMarket(20);
    const edge = analyzePairEdge(candles, 'USD_JPY', 3); // 最終足は押し戻しの陰線
    expect(edge.signal).toBe('neutral');
    expect(edge.score).toBe(0);
  });
});

describe('currencyBias', () => {
  const pair = (instrument: string, score: number): PairEdge => ({
    instrument,
    spreadPips: 0,
    lastClosedAt: null,
    stats: [],
    current: [],
    signal: score > 0 ? 'buy' : score < 0 ? 'sell' : 'neutral',
    score,
  });

  it('買いシグナルは基軸通貨に加点・決済通貨に減点し、降順で返す', () => {
    const bias = currencyBias([pair('GBP_JPY', 10), pair('USD_JPY', -4), pair('GBP_USD', 2)]);
    const score = (cur: string) => bias.find((b) => b.currency === cur)?.score;
    expect(score('GBP')).toBe(12); // +10 +2
    expect(score('JPY')).toBe(-6); // −10 +4
    expect(score('USD')).toBe(-6); // −4 −2
    expect(bias[0].currency).toBe('GBP');
  });
});
