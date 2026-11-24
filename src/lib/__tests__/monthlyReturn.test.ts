import { describe, it, expect } from 'vitest';
import { averageMonthlyRate, monthlyReturns, type Cashflow, type Trade } from '../fund';

const t = (id: string, date: string, pnl: number, tags: string[] = []): Trade => ({
  id,
  date,
  invested: 1000,
  recovered: 1000 + pnl,
  tags,
});
const settings = { startingBalance: 100_000, currency: 'JPY' };

describe('monthlyReturns', () => {
  it('月利 = その月の損益 ÷ 月初の残高（前の月の損益で月初の残高が変わる）', () => {
    const m = monthlyReturns(settings, [t('a', '2026-09-03', 10_000), t('b', '2026-10-10', -5_500)], []);
    expect(m.map((x) => x.month)).toEqual(['2026-09', '2026-10']);
    expect(m[0]).toMatchObject({ startBalance: 100_000, pnl: 10_000, tradeCount: 1 });
    expect(m[0].ratePct).toBeCloseTo(10);
    expect(m[1].startBalance).toBe(110_000);
    expect(m[1].ratePct).toBeCloseTo(-5);
  });

  it('入金・出金は月利に影響しない（月初の残高にも含めない）', () => {
    const cf: Cashflow[] = [
      { id: 'c', date: '2026-09-20', type: 'deposit', amount: 100_000 },
      { id: 'd', date: '2026-10-01', type: 'withdrawal', amount: 50_000 },
    ];
    const m = monthlyReturns(settings, [t('a', '2026-09-03', 2_000), t('b', '2026-10-05', 4_080)], cf);
    expect(m[0].ratePct).toBeCloseTo(2); // 9月: 2,000 ÷ 100,000
    expect(m[1].startBalance).toBe(102_000); // 10月の月初は初期残高＋9月の損益だけ
    expect(m[1].ratePct).toBeCloseTo(4); // 4,080 ÷ 102,000
  });

  it('記録の無い月も until まで 0 で並べ、タグで絞った損益で月利を出す', () => {
    const all = [t('a', '2026-08-01', 1_000, ['A']), t('b', '2026-08-02', 3_000, ['B'])];
    const m = monthlyReturns(settings, all, [], all.filter((x) => x.tags.includes('B')), '2026-10');
    expect(m.map((x) => [x.month, x.pnl, x.tradeCount])).toEqual([
      ['2026-08', 3_000, 1],
      ['2026-09', 0, 0],
      ['2026-10', 0, 0],
    ]);
    expect(m[1].startBalance).toBe(104_000); // 月初の残高は全記録
  });

  it('月初の残高が 0 以下なら月利は null', () => {
    const m = monthlyReturns({ startingBalance: 0, currency: 'JPY' }, [t('a', '2026-09-01', 500)], []);
    expect(m[0].ratePct).toBeNull();
  });
});

describe('averageMonthlyRate', () => {
  it('記録がある月の幾何平均（+10% と −10% → 約 −0.5%）', () => {
    const m = monthlyReturns(settings, [t('a', '2026-09-01', 10_000), t('b', '2026-11-01', -11_000)], [], undefined, '2026-11');
    // 9月 +10%、10月は記録なし（除外）、11月 110,000→ −11,000 = −10%
    expect(averageMonthlyRate(m)).toBeCloseTo((Math.sqrt(1.1 * 0.9) - 1) * 100, 6);
  });
  it('対象の月が無ければ null', () => {
    expect(averageMonthlyRate([])).toBeNull();
  });
});
