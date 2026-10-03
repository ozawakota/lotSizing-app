import { describe, it, expect } from 'vitest';
import { computeSummary, dailyPnl, monthGrid, type Cashflow, type FundSettings, type Trade } from '../fund';

const settings: FundSettings = { startingBalance: 10000, currency: 'JPY' };

const trade = (date: string, pnl: number): Trade => ({
  id: date + pnl,
  date,
  instrument: 'USD_JPY',
  direction: 'long',
  lot: 1,
  pnl,
});

const cash = (date: string, type: 'deposit' | 'withdrawal', amount: number): Cashflow => ({
  id: date + type,
  date,
  type,
  amount,
});

describe('computeSummary', () => {
  it('残高 = 初期 + 入金 − 出金 + 累計損益', () => {
    const s = computeSummary(
      settings,
      [trade('2026-01-01', 500), trade('2026-01-02', -200)],
      [cash('2026-01-03', 'deposit', 1000), cash('2026-01-04', 'withdrawal', 300)],
    );
    expect(s.cumulativePnl).toBe(300);
    expect(s.deposits).toBe(1000);
    expect(s.withdrawals).toBe(300);
    expect(s.balance).toBe(10000 + 1000 - 300 + 300);
  });

  it('勝率は決済済（pnl≠0）基準', () => {
    const s = computeSummary(settings, [trade('d1', 100), trade('d2', 100), trade('d3', -100), trade('d4', 0)], []);
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
      [trade('2026-01-02', 300), trade('2026-01-01', 100)],
      [cash('2026-01-03', 'withdrawal', 50)],
    );
    expect(s.equityCurve.map((p) => p.balance)).toEqual([10100, 10400, 10350]);
  });

  it('dailyPnl は日付ごとに損益を合算', () => {
    const m = dailyPnl([trade('2026-01-01', 100), trade('2026-01-01', -30), trade('2026-01-02', 50)]);
    expect(m).toEqual({ '2026-01-01': 70, '2026-01-02': 50 });
  });

  it('最大ドローダウンはピークからの最大下落幅', () => {
    // 10000 → +1000(11000 peak) → -2000(9000) → +500(9500)
    const s = computeSummary(
      settings,
      [trade('2026-01-01', 1000), trade('2026-01-02', -2000), trade('2026-01-03', 500)],
      [],
    );
    expect(s.maxDrawdown).toBe(2000);
  });
});

describe('monthGrid', () => {
  it('2026-01 は木曜始まり・最初の週は前半3つが空白', () => {
    // 2026-01-01 は木曜(Dow=4)。
    const weeks = monthGrid(2026, 1);
    expect(weeks[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(weeks[0][4]).toBe('2026-01-01');
  });

  it('全セルは7の倍数、日付は1〜月末を網羅', () => {
    const weeks = monthGrid(2026, 2); // 2月=28日
    const flat = weeks.flat();
    expect(flat.length % 7).toBe(0);
    const days = flat.filter((c): c is string => c !== null);
    expect(days[0]).toBe('2026-02-01');
    expect(days[days.length - 1]).toBe('2026-02-28');
    expect(days.length).toBe(28);
  });
});
