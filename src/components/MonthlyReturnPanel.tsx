// 資金管理・記録タブの「月利」。選んだ月の月利と平均月利（幾何平均）を大きく、その月までの6か月を棒グラフで並べる。
// 月は ‹ › か棒のタップで変えられ、下の月間カレンダーと同じ月を表示する（FundManager が月を持つ）。
// 月利 = その月の損益 ÷ 元手（修正ディーツ法。monthlyReturns・src/lib/fund.ts）。
import type { FC } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { averageMonthlyRate, type MonthlyReturn } from '@/lib/fund';

const pct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const tone = (v: number | null) => (v == null || v === 0 ? 'text-gray-500' : v > 0 ? 'text-green-600' : 'text-red-600');

/** "YYYY-MM" を n か月ずらす */
export const shiftMonth = (month: string, n: number): string => {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

/** 棒グラフに並べる6か月（選んだ月で終わる。選んだ月が一覧に無ければ直近6か月） */
export const barWindow = (months: MonthlyReturn[], selected: string): MonthlyReturn[] => {
  const i = months.findIndex((m) => m.month === selected);
  return i < 0 ? months.slice(-6) : months.slice(Math.max(0, i - 5), i + 1);
};

const MonthlyReturnPanel: FC<{
  months: MonthlyReturn[];
  currentMonth: string; // 今月 "YYYY-MM"
  selectedMonth?: string; // 表示する月（省略時は今月）
  onSelectMonth?: (month: string) => void;
}> = ({ months, currentMonth, selectedMonth, onSelectMonth }) => {
  if (!months.length) return null;
  const sel = selectedMonth ?? currentMonth;
  const cur = months.find((m) => m.month === sel) ?? null;
  const avg = averageMonthlyRate(months);
  const tradedMonths = months.filter((m) => m.tradeCount > 0).length;
  const recent = barWindow(months, sel);
  const maxAbs = Math.max(1, ...recent.map((m) => Math.abs(m.ratePct ?? 0)));
  const title = sel === currentMonth ? '今月の月利' : `${Number(sel.slice(0, 4))}年${Number(sel.slice(5, 7))}月の月利`;
  const navCls = 'p-0.5 text-gray-400 disabled:opacity-30';

  return (
    <div className="mt-2 rounded-lg bg-gray-50 px-2.5 py-2" aria-label="月利">
      <div className="grid grid-cols-2 divide-x divide-gray-200 text-center">
        <div>
          <div className="flex items-center justify-center gap-0.5">
            {onSelectMonth && (
              <button type="button" aria-label="前の月の月利" className={navCls} onClick={() => onSelectMonth(shiftMonth(sel, -1))}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <p className="text-[10px] text-gray-500">{title}</p>
            {onSelectMonth && (
              <button type="button" aria-label="次の月の月利" className={navCls} onClick={() => onSelectMonth(shiftMonth(sel, 1))}>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <p className={`text-lg font-bold tabular-nums ${tone(cur?.ratePct ?? null)}`}>{pct(cur && cur.tradeCount > 0 ? cur.ratePct : cur ? 0 : null)}</p>
          {sel !== currentMonth && onSelectMonth && (
            <button type="button" className="text-[9px] text-orange-600 underline" onClick={() => onSelectMonth(currentMonth)}>
              今月に戻る
            </button>
          )}
        </div>
        <div>
          <p className="text-[10px] text-gray-500">平均月利{tradedMonths > 0 ? `（${tradedMonths}か月）` : ''}</p>
          <p className={`text-lg font-bold tabular-nums ${tone(avg)}`}>{pct(avg)}</p>
        </div>
      </div>

      {/* 選んだ月までの6か月の月利（0 を中心に上=プラス・下=マイナス）。タップでその月を選ぶ */}
      <div className="mt-1.5 flex items-stretch gap-1" role="list" aria-label="直近の月利">
        {recent.map((m) => {
          const r = m.tradeCount > 0 ? m.ratePct : null;
          const h = r == null ? 0 : (Math.abs(r) / maxAbs) * 100;
          const isSel = m.month === sel;
          return (
            <div key={m.month} role="listitem" className="flex flex-1">
              <button
                type="button"
                aria-label={`${Number(m.month.slice(5))}月の月利を表示`}
                aria-pressed={isSel}
                disabled={!onSelectMonth}
                onClick={() => onSelectMonth?.(m.month)}
                className={`flex flex-1 flex-col items-center rounded ${isSel ? 'bg-orange-50' : ''}`}
              >
                <span className={`text-[9px] font-semibold tabular-nums ${tone(r)}`}>{r == null ? '—' : pct(r)}</span>
                <span className="relative block h-10 w-full">
                  <span className="absolute inset-x-0 top-1/2 h-px bg-gray-300" />
                  {r != null && r !== 0 && (
                    <span
                      className={`absolute left-1/2 w-3 -translate-x-1/2 rounded-sm ${r > 0 ? 'bg-green-500' : 'bg-red-500'}`}
                      style={r > 0 ? { bottom: '50%', height: `${h / 2}%` } : { top: '50%', height: `${h / 2}%` }}
                    />
                  )}
                </span>
                <span className={`text-[9px] ${isSel ? 'font-bold text-orange-600' : 'text-gray-400'}`}>{Number(m.month.slice(5))}月</span>
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-[9px] text-gray-400">
        月利＝その月の損益 ÷ 元手（月初の残高＋その月の入出金を日割り）。入金は利益に数えない。平均は記録がある月の複利平均。‹ › や棒のタップで月を変えると、下のカレンダーも同じ月になります。
      </p>
    </div>
  );
};

export default MonthlyReturnPanel;
