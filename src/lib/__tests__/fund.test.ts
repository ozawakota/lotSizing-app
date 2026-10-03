import { describe, it, expect } from 'vitest';
import {
  aggregateByTag,
  computeSummary,
  dailyPnl,
  monthGrid,
  pnlOf,
  type Cashflow,
  type FundSettings,
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
