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
  volumeAnchoredLevel,
  futuresLevelToSpot,
  computeStochastic,
  scanStructuralRr,
  scanStructuralRrAll,
  trendToDirection,
  averageTrueRange,
  computeStructuralStop,
  scoreRoleReversal,
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

describe('volumeAnchoredLevel', () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const now = 10 * DAY; // 基準の現在時刻

  it('参照時点(2日前)±窓で最大出来高の足の終値を返す', () => {
    const at = (daysAgo: number) => (now - daysAgo * DAY) / 1000; // UNIX秒
    const candles: Candle[] = [
      { high: 0, low: 0, close: 100, volume: 50, t: at(2) }, // 2日前ちょうど
      { high: 0, low: 0, close: 105, volume: 200, t: at(2) + 3 * HOUR / 1000 }, // 窓内・最大出来高
      { high: 0, low: 0, close: 999, volume: 999, t: at(0) }, // 窓外（現在付近）
    ];
    expect(volumeAnchoredLevel(candles, now, 2 * DAY, 12 * HOUR)).toBe(105);
  });

  it('出来高が無い（FXスポット等）は null', () => {
    const candles: Candle[] = [{ high: 0, low: 0, close: 100, t: (now - 2 * DAY) / 1000 }];
    expect(volumeAnchoredLevel(candles, now, 2 * DAY, 12 * HOUR)).toBeNull();
  });

  it('窓内に足が無ければ null', () => {
    const candles: Candle[] = [{ high: 0, low: 0, close: 100, volume: 10, t: now / 1000 }];
    expect(volumeAnchoredLevel(candles, now, 2 * DAY, 1 * HOUR)).toBeNull();
  });
});

describe('computeStochastic', () => {
  it('足数が足りなければ null', () => {
    const few = mkCandles(Array.from({ length: 5 }, (_, i) => [i + 2, i, i + 1] as [number, number, number]));
    expect(computeStochastic(few)).toBeNull();
  });

  it('終値が期間高値に張り付くと %K/%D は高位（買われすぎ域）', () => {
    // 高安は一定(10-0)、終値は最高値 → rawK≈100
    const s = computeStochastic(mkCandles(Array.from({ length: 25 }, () => [10, 0, 10])));
    expect(s).not.toBeNull();
    expect(s!.k).toBeGreaterThanOrEqual(80);
    expect(s!.d).toBeGreaterThanOrEqual(80);
  });

  it('終値が期間安値付近だと %K は低位（売られすぎ域）', () => {
    const s = computeStochastic(mkCandles(Array.from({ length: 25 }, () => [10, 0, 0])));
    expect(s!.k).toBeLessThanOrEqual(20);
  });

  it('高安が同値（値幅ゼロ）なら null', () => {
    expect(computeStochastic(mkCandles(Array.from({ length: 25 }, () => [5, 5, 5])))).toBeNull();
  });
});

describe('futuresLevelToSpot', () => {
  it('非逆数（EUR/USD等）はベーシス差で平行移動', () => {
    // 先物現在1.085 / スポット現在1.080 → offset 0.005。先物節目1.100 → 1.095
    expect(futuresLevelToSpot(1.1, 1.085, 1.08, false)).toBeCloseTo(1.095, 10);
  });

  it('逆数（USD/JPY=1/6J=F）は逆数化してからベーシス補正', () => {
    // 6J=F 現在0.006667(=150.0) / スポット150.2 → offset -0.2。節目0.006623(=151.0) → 151.2
    const spot = futuresLevelToSpot(1 / 151, 1 / 150, 150.2, true);
    expect(spot).toBeCloseTo(151.2, 6);
  });

  it('ベーシスが0なら非逆数はそのまま', () => {
    expect(futuresLevelToSpot(1.27, 1.27, 1.27, false)).toBeCloseTo(1.27, 10);
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
      { sessionStatus: '東京: 開場 / ロンドン: 閉場' },
    );
    expect((state as { sessionStatus?: string }).sessionStatus).toBe('東京: 開場 / ロンドン: 閉場');
    const breakout = questions.breakout as { instructions: string };
    const pa = questions.price_action as { instructions: string };
    expect(breakout.instructions).toContain('セッション');
    expect(pa.instructions).toContain('セッション');
  });

  it('includes volumeLevel in state and instructions when provided', () => {
    const { state, questions } = buildPaJevRequest(
      { trend: 'up', swingHigh: 1.2, swingLow: 1.1, currentRate: 1.15 },
      [1.1, 1.15],
      { volumeLevel: 1.18 },
    );
    expect((state as { volumeLevel?: number }).volumeLevel).toBe(1.18);
    expect((questions.breakout as { instructions: string }).instructions).toContain('出来高');
  });

  it('includes stochastic in state and instructions when provided', () => {
    const { state, questions } = buildPaJevRequest(
      { trend: 'up', swingHigh: 1.2, swingLow: 1.1, currentRate: 1.15 },
      [1.1, 1.15],
      { stoch: { k: 85, d: 78 } },
    );
    expect((state as { stochastic?: { k: number } }).stochastic?.k).toBe(85);
    expect((questions.breakout as { instructions: string }).instructions).toContain('ストキャス');
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

  it('spreadPips を渡すとリスクに足しリワードから引いた実質 RR になる', () => {
    const base = assessRiskReward(structure, 'long', 60, [{ swingHigh: 152.0, swingLow: 149.0 }], 'USD_JPY');
    const withSpread = assessRiskReward(structure, 'long', 60, [{ swingHigh: 152.0, swingLow: 149.0 }], 'USD_JPY', 3, 50, 2);
    expect(base!.spreadPips).toBe(0);
    expect(withSpread!.spreadPips).toBe(2);
    expect(withSpread!.riskPips).toBeCloseTo(base!.riskPips + 2, 5);
    expect(withSpread!.rewardPips).toBeCloseTo(base!.rewardPips - 2, 5);
    expect(withSpread!.rr).toBeLessThan(base!.rr);
  });

  it('returns null when no higher-TF swing lies ahead in the trade direction', () => {
    // すべての上位TF高値が現在値より下 → ロングの目標が無い
    const rr = assessRiskReward(structure, 'long', 60, [{ swingHigh: 150.2, swingLow: 149.0 }], 'USD_JPY');
    expect(rr).toBeNull();
  });
});

describe('scanStructuralRr', () => {
  it('上昇TFで上位TFの高値を目標に RR>=3 の最良 setup を返す（確率不要）', () => {
    const tfs = [
      { tf: '1h' as const, structure: { trend: 'up' as const, swingHigh: 150.5, swingLow: 150.0, currentRate: 150.4 } },
      { tf: '4h' as const, structure: { trend: 'up' as const, swingHigh: 152.0, swingLow: 149.0, currentRate: 150.4 } },
    ];
    const r = scanStructuralRr(tfs, 'USD_JPY', 3);
    expect(r).not.toBeNull();
    expect(r!.tf).toBe('1h');
    expect(r!.direction).toBe('long');
    expect(r!.rr).toBeGreaterThanOrEqual(3);
  });

  it('レンジTFは方向なしで除外、満たすものが無ければ null', () => {
    const tfs = [
      { tf: '1h' as const, structure: { trend: 'range' as const, swingHigh: 150.5, swingLow: 150.0, currentRate: 150.3 } },
      { tf: '4h' as const, structure: { trend: 'range' as const, swingHigh: 152.0, swingLow: 149.0, currentRate: 150.3 } },
    ];
    expect(scanStructuralRr(tfs, 'USD_JPY', 3)).toBeNull();
  });

  it('下降TFはショート方向で下位の上位TF安値を目標にする', () => {
    const tfs = [
      { tf: '1h' as const, structure: { trend: 'down' as const, swingHigh: 150.5, swingLow: 150.0, currentRate: 150.1 } },
      { tf: '4h' as const, structure: { trend: 'down' as const, swingHigh: 151.0, swingLow: 148.0, currentRate: 150.1 } },
    ];
    const r = scanStructuralRr(tfs, 'USD_JPY', 3);
    expect(r!.direction).toBe('short');
    expect(r!.target).toBe(148.0);
  });
});

describe('scoreRoleReversal', () => {
  const mk = (high: number, low: number, close: number, volume?: number): Candle => ({ high, low, close, volume });
  const UP = { trend: 'up' as const, swingHigh: 100, swingLow: 96, currentRate: 103.5 };

  // レジ100を抜けずに下げる（どのピボット高値も終値で抜けていない）→ 未ブレイク。
  const noBreak: Candle[] = [
    mk(98, 96, 97), mk(98.5, 96.5, 97.5), mk(99, 97, 98), mk(98.8, 96.8, 97.8),
    mk(98.5, 96.5, 97.5), mk(99, 97, 98), mk(100, 98, 98.5), mk(98.5, 96.5, 97.5),
    mk(98, 96, 97), mk(97.5, 95.5, 96.5), mk(97, 95, 96), mk(96.5, 94.5, 95.5),
    mk(96, 94, 95), mk(95.5, 93.5, 94.5), mk(95, 93, 94), mk(94.5, 92.5, 93.5),
  ];

  // レジ100を終値で上抜け→戻り(リテスト100.3)→保持(終値>100継続) → 転換確認。
  const breakHold: Candle[] = [
    mk(98, 96, 97), mk(98.5, 96.5, 97.5), mk(99, 97, 98), mk(98.8, 96.8, 97.8),
    mk(98.5, 96.5, 97.5), mk(99, 97, 98), mk(100, 98, 98.5), mk(99, 97, 98),
    mk(98.8, 97, 98), mk(99, 97.5, 98.2), mk(102.5, 99, 102), mk(103, 101, 102.5),
    mk(103, 101, 102.8), mk(101.5, 100.3, 101), mk(102, 101, 101.8), mk(103, 101.5, 102.5),
    mk(103.5, 102, 103), mk(103.2, 102, 102.8), mk(103.5, 102.5, 103.2), mk(104, 103, 103.5),
  ];

  it('候補不足なら null', () => {
    expect(scoreRoleReversal([], UP, { instrument: 'USD_JPY' })).toBeNull();
    expect(scoreRoleReversal(noBreak.slice(0, 8), UP, { instrument: 'USD_JPY' })).toBeNull();
  });

  it('上昇トレンドはレジ(resistance)側を評価する', () => {
    const r = scoreRoleReversal(breakHold, UP, { instrument: 'USD_JPY' });
    expect(r?.side).toBe('resistance');
  });

  it('下降トレンドはサポ(support)側を評価する', () => {
    const down = { trend: 'down' as const, swingHigh: 104, swingLow: 100, currentRate: 96 };
    const r = scoreRoleReversal(breakHold, down, { instrument: 'USD_JPY' });
    expect(r?.side).toBe('support');
  });

  it('未ブレイクは state=none で、ブレイク保持より低スコア', () => {
    const none = scoreRoleReversal(noBreak, UP, { instrument: 'USD_JPY' });
    const hold = scoreRoleReversal(breakHold, UP, { instrument: 'USD_JPY' });
    expect(none?.state).toBe('none');
    expect(hold?.state).toBe('confirmed');
    expect(hold!.score).toBeGreaterThan(none!.score);
    for (const r of [none!, hold!]) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it('評価したラインの価格を返す（ブレイク済み=抜けたピボット / 未ブレイク=スイング高値）', () => {
    // 終値で抜けたピボット高値は 100（idx6）と 103（idx12、終値103.2で上抜け）。現在値に近い高い方を採る。
    expect(scoreRoleReversal(breakHold, UP, { instrument: 'USD_JPY' })?.level).toBe(103);
    expect(scoreRoleReversal(noBreak, UP, { instrument: 'USD_JPY' })?.level).toBe(UP.swingHigh);
  });

  it('出来高が無くても（FXスポット想定）スコアは有限', () => {
    const r = scoreRoleReversal(breakHold, UP, { instrument: 'USD_JPY' });
    expect(Number.isFinite(r!.score)).toBe(true);
  });
});

describe('scanStructuralRrAll', () => {
  it('条件を満たすTFを全件（短い足→長い足の順）返し、best版は最大rrの1件', () => {
    const tfs = [
      { tf: '15m' as const, structure: { trend: 'up' as const, swingHigh: 150.1, swingLow: 149.95, currentRate: 150.0 } },
      { tf: '1h' as const, structure: { trend: 'up' as const, swingHigh: 150.2, swingLow: 149.9, currentRate: 150.0 } },
      { tf: '4h' as const, structure: { trend: 'up' as const, swingHigh: 153.0, swingLow: 149.0, currentRate: 150.0 } },
    ];
    const all = scanStructuralRrAll(tfs, 'USD_JPY', 2.5);
    // 15m・1h は上位TFに目標があり成立。4h は上位TFの目標が無く除外。
    expect(all.map((r) => r.tf)).toEqual(['15m', '1h']);
    expect(all.every((r) => r.rr >= 2.5)).toBe(true);
    // 従来の best 版は rr 最大の1件（1h）のみ。
    expect(scanStructuralRr(tfs, 'USD_JPY', 2.5)!.tf).toBe('1h');
  });

  it('スプレッド込みでは RR が下がり、ぎりぎりの setup は条件から外れる', () => {
    const tfs = [
      { tf: '15m' as const, structure: { trend: 'up' as const, swingHigh: 150.1, swingLow: 149.95, currentRate: 150.0 } },
      { tf: '1h' as const, structure: { trend: 'range' as const, swingHigh: 150.2, swingLow: 149.9, currentRate: 150.0 } },
    ];
    const [noSpread] = scanStructuralRrAll(tfs, 'USD_JPY', 2.5);
    expect(noSpread.rr).toBeGreaterThanOrEqual(2.5);
    // 同じ setup でも、RR の閾値を素の RR ちょうどにするとスプレッド分で不成立になる。
    expect(scanStructuralRrAll(tfs, 'USD_JPY', noSpread.rr, 1)).toEqual([]);
  });

  it('direction を渡すとトレンドより優先（ダウ理論の方向）。null は対象外', () => {
    const h = { tf: '4h' as const, structure: { trend: 'up' as const, swingHigh: 153.0, swingLow: 147.0, currentRate: 150.0 } };
    const base = { tf: '15m' as const, structure: { trend: 'up' as const, swingHigh: 150.1, swingLow: 149.95, currentRate: 150.0 } };
    // トレンドは up でも、ダウ理論が null（レンジ・転換の兆し）なら対象外
    expect(scanStructuralRrAll([{ ...base, direction: null }, h], 'USD_JPY', 0.1)).toEqual([]);
    // トレンドは range でも、ダウ理論の方向（short）で評価する
    const short = scanStructuralRrAll(
      [{ tf: '15m', structure: { ...base.structure, trend: 'range', swingHigh: 150.05 }, direction: 'short' }, h],
      'USD_JPY',
      0.1,
    );
    expect(short.map((r) => r.direction)).toEqual(['short']);
    // direction を渡さなければ従来どおりトレンドで決める（好機ボード）
    expect(scanStructuralRrAll([base, h], 'USD_JPY', 0.1).map((r) => r.direction)).toEqual(['long']);
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

describe('trendToDirection（TF分析ページと RR好機通知で共通の方向）', () => {
  it('上昇=ロング / 下降=ショート / レンジ=対象外', () => {
    expect(trendToDirection('up')).toBe('long');
    expect(trendToDirection('down')).toBe('short');
    expect(trendToDirection('range')).toBeNull();
  });
});

describe('averageTrueRange', () => {
  it('前足終値とのギャップも値幅に含める', () => {
    const c = (high: number, low: number, close: number): Candle => ({ high, low, close });
    // 2本目: 高安0.1だが前足終値100→ギャップで高値100.5 → TR=0.5
    expect(averageTrueRange([c(100.1, 99.9, 100), c(100.5, 100.4, 100.45)])).toBeCloseTo(0.5, 5);
  });
});

describe('computeStructuralStop', () => {
  // USD_JPY。ジグザグに上昇: 押し安値が 150.00 → 150.40 → 150.80 と切り上がる。各足の値幅は約0.1。
  const leg = (from: number, to: number, n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const close = from + ((to - from) * (i + 1)) / n;
      return { high: close + 0.05, low: close - 0.05, close };
    });
  const up: Candle[] = [
    ...leg(150.6, 150.0, 6), ...leg(150.0, 150.9, 9), // 押し安値 ≈149.95
    ...leg(150.9, 150.4, 5), ...leg(150.4, 151.3, 9), // 押し安値 ≈150.35
    ...leg(151.3, 150.8, 5), ...leg(150.8, 151.2, 4), // 押し安値 ≈150.75
  ];
  const forming: Candle = { high: 151.25, low: 140, close: 151.2 }; // 形成中の足（異常な安値は無視されるべき）
  const entry = 151.2;

  it('ロングは直近の押し安値（現在値に一番近いピボット安値）の下に置く', () => {
    const plan = computeStructuralStop([...up, forming], 'long', entry, { instrument: 'USD_JPY' })!;
    expect(plan.basis).toBe('pivot');
    expect(plan.level).toBeCloseTo(150.75, 1);
    expect(plan.reasons[0]).toBe('直近の押し安値');
    // バッファ = ATR×0.25
    expect(plan.price).toBeCloseTo(plan.level - plan.atr * 0.25, 6);
    expect(plan.distancePips).toBeGreaterThan(0);
  });

  it('形成中の最終足は使わない（excludeLast 既定）', () => {
    const plan = computeStructuralStop([...up, forming], 'long', entry, { instrument: 'USD_JPY' })!;
    expect(plan.level).toBeGreaterThan(149); // 140 の異常値を拾わない
  });

  it('上位足のスイングと一致するラインは強さが上がり、根拠に出る', () => {
    const base = computeStructuralStop([...up, forming], 'long', entry, { instrument: 'USD_JPY' })!;
    const conf = computeStructuralStop([...up, forming], 'long', entry, {
      instrument: 'USD_JPY',
      higherLevels: [{ price: base.level, label: '1時間足の安値' }],
    })!;
    expect(conf.strength).toBeGreaterThan(base.strength);
    expect(conf.reasons).toContain('1時間足の安値と一致');
  });

  it('近い押し安値より、距離1.5倍以内でかなり強いラインがあればそちらを採る', () => {
    const near = computeStructuralStop([...up, forming], 'long', entry, { instrument: 'USD_JPY' })!;
    // 1つ外側の押し安値（≈150.35）に上位足2本分の一致を付ける。近い方との距離比が1.5倍を超えるなら採られない。
    const strong = computeStructuralStop([...up, forming], 'long', entry, {
      instrument: 'USD_JPY',
      higherLevels: [{ price: 150.35, label: '4時間足の安値' }],
      extraLevels: [{ price: 150.35, label: '出来高節目' }, { price: 150.35, label: 'ロールリバーサルのライン' }],
    })!;
    const ratio = (entry - 150.35) / (entry - near.level);
    if (ratio <= 1.5) expect(strong.level).toBeCloseTo(150.35, 1);
    else expect(strong.level).toBeCloseTo(near.level, 6);
  });

  it('ショートは戻り高値の上に、バッファ＋スプレッドを足して置く', () => {
    const down = up.map((c) => ({ high: 302 - c.low, low: 302 - c.high, close: 302 - c.close }));
    const e = 302 - entry;
    const noSpread = computeStructuralStop([...down, forming], 'short', e, { instrument: 'USD_JPY' })!;
    const withSpread = computeStructuralStop([...down, forming], 'short', e, { instrument: 'USD_JPY', spreadPips: 1 })!;
    expect(noSpread.reasons[0]).toBe('直近の戻り高値');
    expect(noSpread.price).toBeGreaterThan(noSpread.level);
    expect(withSpread.price - noSpread.price).toBeCloseTo(0.01, 6); // 1pip = 0.01円
  });

  it('範囲内にピボットが無ければ直近24本の極値で代用（basis=window）、それも無ければ null', () => {
    const mono = leg(150.0, 151.0, 40); // 単調上昇＝ピボット安値なし
    const plan = computeStructuralStop(mono, 'long', 151.0, { instrument: 'USD_JPY', excludeLast: false })!;
    expect(plan.basis).toBe('window');
    expect(computeStructuralStop(mono.slice(0, 5), 'long', 151.0, { instrument: 'USD_JPY' })).toBeNull();
  });

  it('assessRiskReward に渡すと旧方式の代わりに使われ、根拠と強さが RrSetup に入る', () => {
    const plan = computeStructuralStop([...up, forming], 'long', entry, { instrument: 'USD_JPY' })!;
    const structure: SlStructure = { trend: 'up', swingHigh: 151.35, swingLow: 150.75, currentRate: entry };
    const rr = assessRiskReward(structure, 'long', 100, [{ swingHigh: 153, swingLow: 149 }], 'USD_JPY', 2.5, 0, 0, plan)!;
    expect(rr.stop).toBeCloseTo(plan.price, 6);
    expect(rr.riskPips).toBeCloseTo(plan.distancePips, 5);
    expect(rr.stopReasons?.[0]).toBe('直近の押し安値');
    expect(rr.stopStrength).toBe(plan.strength);
  });
});
