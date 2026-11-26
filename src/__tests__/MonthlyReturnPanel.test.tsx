// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import MonthlyReturnPanel, { barWindow, shiftMonth } from '../components/MonthlyReturnPanel';
import type { MonthlyReturn } from '@/lib/fund';

afterEach(cleanup);

const m = (month: string, ratePct: number | null, tradeCount = 1): MonthlyReturn => ({
  month,
  startBalance: 100_000,
  capital: 100_000,
  pnl: (ratePct ?? 0) * 1000,
  ratePct,
  tradeCount,
});
// 3月 −3% … 11月 +5%
const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].map((x, i) =>
  m(x, i - 3),
);

describe('shiftMonth / barWindow', () => {
  it('年をまたいで月をずらす', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-11', -13)).toBe('2025-10');
  });
  it('棒は選んだ月で終わる6か月。一覧に無い月なら直近6か月', () => {
    expect(barWindow(months, '2026-06').map((x) => x.month)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
    expect(barWindow(months, '2026-09').map((x) => x.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(barWindow(months, '2027-01').map((x) => x.month)).toEqual(months.slice(-6).map((x) => x.month));
  });
});

describe('MonthlyReturnPanel', () => {
  it('選んだ月の月利を表示し、‹ › と棒で月を変えられる', () => {
    const onSelect = vi.fn();
    render(<MonthlyReturnPanel months={months} currentMonth="2026-11" selectedMonth="2026-08" onSelectMonth={onSelect} />);
    expect(screen.getByText('2026年8月の月利')).toBeTruthy();
    expect(screen.getAllByText('+2.0%').length).toBe(2); // 大きい表示と棒の上
    fireEvent.click(screen.getByLabelText('前の月の月利'));
    expect(onSelect).toHaveBeenLastCalledWith('2026-07');
    fireEvent.click(screen.getByLabelText('次の月の月利'));
    expect(onSelect).toHaveBeenLastCalledWith('2026-09');
    fireEvent.click(within(screen.getByRole('list', { name: '直近の月利' })).getByLabelText('5月の月利を表示'));
    expect(onSelect).toHaveBeenLastCalledWith('2026-05');
    fireEvent.click(screen.getByText('今月に戻る'));
    expect(onSelect).toHaveBeenLastCalledWith('2026-11');
  });

  it('今月を選んでいるときは「今月の月利」で「今月に戻る」は出ない', () => {
    render(<MonthlyReturnPanel months={months} currentMonth="2026-11" selectedMonth="2026-11" onSelectMonth={() => {}} />);
    expect(screen.getByText('今月の月利')).toBeTruthy();
    expect(screen.queryByText('今月に戻る')).toBeNull();
  });

  it('記録の無い月（一覧の外）は —', () => {
    render(<MonthlyReturnPanel months={months} currentMonth="2026-11" selectedMonth="2025-12" onSelectMonth={() => {}} />);
    expect(screen.getByText('2025年12月の月利')).toBeTruthy();
    expect(screen.getByLabelText('月利').querySelector('.text-lg')?.textContent).toBe('—');
  });
});
