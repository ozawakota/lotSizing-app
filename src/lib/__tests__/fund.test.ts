import { describe, it, expect } from 'vitest';
import {
  aggregateByTag,
  computeSummary,
  dailyPnl,
  growthDetail,
  growthPerTrade,
  monthGrid,
  pnlOf,
  simulateGrowth,
  type Cashflow,
  type FundSettings,
  type GrowthParams,
  type Trade,
} from '../fund';

const settings: FundSettings = { startingBalance: 10000, currency: 'JPY' };

// invested/recovered から損益 = recovered - invested。
const trade = (date: string, invested: number, recovered: number, tags: string[] = []): Trade => ({
  id: `${date}-${invested}-${recovered}`,
  date,
  invested,
  recovered,
  tags,
});

const cash = (date: string, type: 'deposit' | 'withdrawal', amount: number): Cashflow => ({
  id: date + type,
  date,
  type,
  amount,
});

describe('pnlOf', () => {
  it('損益 = 回収 − 投資', () => {
    expect(pnlOf(trade('d', 1000, 1500))).toBe(500);
    expect(pnlOf(trade('d', 1000, 300))).toBe(-700);
  });
});

describe('computeSummary', () => {
  it('残高 = 初期 + 入金 − 出金 + 累計損益', () => {
    const s = computeSummary(
      settings,
      [trade('2026-01-01', 0, 500), trade('2026-01-02', 200, 0)],
      [cash('2026-01-03', 'deposit', 1000), cash('2026-01-04', 'withdrawal', 300)],
    );
    expect(s.cumulativePnl).toBe(300);
    expect(s.balance).toBe(10000 + 1000 - 300 + 300);
  });

  it('総投資・総回収・回収率', () => {
    const s = computeSummary(settings, [trade('d1', 1000, 1500), trade('d2', 1000, 500)], []);
    expect(s.totalInvested).toBe(2000);
    expect(s.totalRecovered).toBe(2000);
    expect(s.recoveryRate).toBe(1);
  });

  it('投資0なら回収率0', () => {
    expect(computeSummary(settings, [], []).recoveryRate).toBe(0);
  });

  it('勝率は損益≠0のトレード基準', () => {
    const s = computeSummary(
      settings,
      [trade('d1', 0, 100), trade('d2', 0, 100), trade('d3', 100, 0), trade('d4', 100, 100)],
      [],
    );
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(2 / 3, 6);
    expect(s.tradeCount).toBe(4);
  });

  it('トレードなしなら勝率0・DD0・残高は初期', () => {
    const s = computeSummary(settings, [], []);
    expect(s.winRate).toBe(0);
    expect(s.maxDrawdown).toBe(0);
    expect(s.balance).toBe(10000);
    expect(s.equityCurve).toEqual([]);
  });

  it('エクイティカーブは日付順に積み上がる', () => {
    const s = computeSummary(
      settings,
      [trade('2026-01-02', 0, 300), trade('2026-01-01', 0, 100)],
      [cash('2026-01-03', 'withdrawal', 50)],
    );
    expect(s.equityCurve.map((p) => p.balance)).toEqual([10100, 10400, 10350]);
  });

  it('最大ドローダウンはピークからの最大下落幅', () => {
    const s = computeSummary(
      settings,
      [trade('2026-01-01', 0, 1000), trade('2026-01-02', 2000, 0), trade('2026-01-03', 0, 500)],
      [],
    );
    expect(s.maxDrawdown).toBe(2000);
  });
});

describe('dailyPnl', () => {
  it('日付ごとに損益を合算', () => {
    const m = dailyPnl([trade('2026-01-01', 0, 100), trade('2026-01-01', 30, 0), trade('2026-01-02', 0, 50)]);
    expect(m).toEqual({ '2026-01-01': 70, '2026-01-02': 50 });
  });
});

describe('aggregateByTag', () => {
  it('タグ別に収支・回収率・件数を集計（複数タグは各々に加算）', () => {
    const trades = [
      trade('d1', 1000, 1500, ['店A', '20スロ']),
      trade('d2', 1000, 500, ['店A']),
      trade('d3', 2000, 3000, ['20スロ']),
    ];
    const byTag = Object.fromEntries(aggregateByTag(trades).map((a) => [a.tag, a]));
    expect(byTag['店A'].pnl).toBe(500 + -500);
    expect(byTag['店A'].count).toBe(2);
    expect(byTag['20スロ'].invested).toBe(3000);
    expect(byTag['20スロ'].recovered).toBe(4500);
    expect(byTag['20スロ'].recoveryRate).toBeCloseTo(1.5, 6);
  });
});

describe('monthGrid', () => {
  it('2026-01 は木曜始まり・最初の週は前半4つが空白', () => {
    const weeks = monthGrid(2026, 1);
    expect(weeks[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(weeks[0][4]).toBe('2026-01-01');
  });

  it('全セルは7の倍数、日付は1〜月末を網羅', () => {
    const weeks = monthGrid(2026, 2);
    const flat = weeks.flat();
    expect(flat.length % 7).toBe(0);
    const days = flat.filter((c): c is string => c !== null);
    expect(days[0]).toBe('2026-02-01');
    expect(days[days.length - 1]).toBe('2026-02-28');
    expect(days.length).toBe(28);
  });
});

describe('growthPerTrade', () => {
  it('g = (1 + RR·r)^勝率 × (1 − r)^(1−勝率)', () => {
    // 勝率50%・RR3・リスク2% → (1.06)^0.5 × (0.98)^0.5
    expect(growthPerTrade(0.5, 3, 0.02)).toBeCloseTo(Math.sqrt(1.06 * 0.98), 10);
  });

  it('勝率100%なら勝ちの倍率そのもの、0%なら負けの倍率そのもの', () => {
    expect(growthPerTrade(1, 3, 0.05)).toBeCloseTo(1.15, 10);
    expect(growthPerTrade(0, 3, 0.05)).toBeCloseTo(0.95, 10);
  });
});

describe('simulateGrowth', () => {
  const base: GrowthParams = {
    startingBalance: 100_000,
    targetBalance: 1_000_000,
    winRate: 0.5,
    tradesPerMonth: 20,
    rewardRatio: 3,
    riskPercents: [2, 3, 4, 5],
  };

  it('各リスク%の線を返し、残高は目標でクランプされる', () => {
    const { lines } = simulateGrowth(base);
    expect(lines.map((l) => l.riskPercent)).toEqual([2, 3, 4, 5]);
    for (const l of lines) {
      expect(l.points[0].balance).toBe(100_000); // 月0は起点
      expect(Math.max(...l.points.map((p) => p.balance))).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('期待値プラス（g>1）なら到達月を返し、リスクが高いほど速い', () => {
    const { lines } = simulateGrowth(base);
    const months = lines.map((l) => l.monthsToTarget);
    expect(months.every((m) => m !== null)).toBe(true);
    // 2% < 3% < 4% < 5% の順に到達が速くなる（月数は小さくなる）。
    for (let i = 1; i < months.length; i++) {
      expect(months[i]!).toBeLessThan(months[i - 1]!);
    }
  });

  it('到達月は複利式と一致する', () => {
    const { lines } = simulateGrowth({ ...base, riskPercents: [3] });
    const g = growthPerTrade(0.5, 3, 0.03);
    const expected = Math.log(10) / (20 * Math.log(g)); // target/start = 10
    expect(lines[0].monthsToTarget).toBeCloseTo(expected, 8);
  });

  it('横軸は到達する中で最長（最もリスクの低い線）の月数を切り上げたもの', () => {
    const { lines, maxMonths } = simulateGrowth(base);
    const slowest = Math.max(...lines.map((l) => l.monthsToTarget!));
    expect(maxMonths).toBe(Math.ceil(slowest));
  });

  it('期待値マイナス（g≤1）は未到達（null）', () => {
    // 勝率20%・RR3: g = (1.09)^0.2 × (0.97)^0.8 < 1
    const { lines } = simulateGrowth({ ...base, winRate: 0.2, riskPercents: [3] });
    expect(lines[0].growthPerTrade).toBeLessThanOrEqual(1);
    expect(lines[0].monthsToTarget).toBeNull();
  });

  it('起点が不正（0以下/目標以上）なら未到達で平坦', () => {
    const { lines } = simulateGrowth({ ...base, startingBalance: 0 });
    expect(lines[0].monthsToTarget).toBeNull();
    expect(lines[0].points.every((p) => p.balance === 0)).toBe(true);
  });
});

describe('growthDetail', () => {
  const base: GrowthParams = {
    startingBalance: 50_000,
    targetBalance: 1_000_000,
    winRate: 0.6,
    tradesPerMonth: 10,
    rewardRatio: 3,
    riskPercents: [2, 3, 4, 5],
  };

  it('勝率60%・RR3・2% の1トレード内訳（勝ち+6%/負け-2%/期待値+2.8%）', () => {
    const d = growthDetail(base, 2);
    expect(d.winPct).toBeCloseTo(6, 10);
    expect(d.lossPct).toBeCloseTo(2, 10);
    expect(d.expectancyPct).toBeCloseTo(2.8, 10); // 2% ×(0.6×3 − 0.4) = 2% ×1.4
  });

  it('初回の金額換算は起点ベース（リスク1,000円・勝ち3,000円・期待値1,400円）', () => {
    const d = growthDetail(base, 2);
    expect(d.initialRiskAmount).toBeCloseTo(1_000, 6);
    expect(d.initialWinAmount).toBeCloseTo(3_000, 6);
    expect(d.initialExpectancyAmount).toBeCloseTo(1_400, 6);
  });

  it('月利・初月増加額は幾何平均 g の月複利と一致', () => {
    const d = growthDetail(base, 2);
    const g = growthPerTrade(0.6, 3, 0.02);
    const monthlyFactor = Math.pow(g, 10);
    expect(d.monthlyRatePct).toBeCloseTo((monthlyFactor - 1) * 100, 8);
    expect(d.firstMonthGain).toBeCloseTo(50_000 * (monthlyFactor - 1), 6);
  });

  it('総トレード回数 = 到達月数 × 毎月回数 の切り上げ', () => {
    const d = growthDetail(base, 3);
    expect(d.tradesToTarget).toBe(Math.ceil(d.monthsToTarget! * 10));
  });

  it('期待値マイナスなら到達月・総回数は null', () => {
    const d = growthDetail({ ...base, winRate: 0.2 }, 3);
    expect(d.monthsToTarget).toBeNull();
    expect(d.tradesToTarget).toBeNull();
  });
});
