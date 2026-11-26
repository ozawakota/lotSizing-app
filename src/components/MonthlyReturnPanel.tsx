// 資金管理・記録タブの「月利」。今月の月利と平均月利（幾何平均）を大きく、直近6か月を棒グラフで並べる。
// 月利 = その月の損益 ÷ 元手（修正ディーツ法: 月初の残高＋その月の入出金の日割り。入金は利益に数えない。monthlyReturns・src/lib/fund.ts）。
import type { FC } from 'react';
import { averageMonthlyRate, type MonthlyReturn } from '@/lib/fund';

const pct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const tone = (v: number | null) => (v == null || v === 0 ? 'text-gray-500' : v > 0 ? 'text-green-600' : 'text-red-600');

const MonthlyReturnPanel: FC<{ months: MonthlyReturn[]; currentMonth: string }> = ({ months, currentMonth }) => {
  if (!months.length) return null;
  const cur = months.find((m) => m.month === currentMonth) ?? null;
  const avg = averageMonthlyRate(months);
  const tradedMonths = months.filter((m) => m.tradeCount > 0).length;
  const recent = months.slice(-6);
  const maxAbs = Math.max(1, ...recent.map((m) => Math.abs(m.ratePct ?? 0)));

  return (
    <div className="mt-2 rounded-lg bg-gray-50 px-2.5 py-2" aria-label="月利">
      <div className="grid grid-cols-2 divide-x divide-gray-200 text-center">
        <div>
          <p className="text-[10px] text-gray-500">今月の月利</p>
          <p className={`text-lg font-bold tabular-nums ${tone(cur?.ratePct ?? null)}`}>{pct(cur && cur.tradeCount > 0 ? cur.ratePct : cur ? 0 : null)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-500">平均月利{tradedMonths > 0 ? `（${tradedMonths}か月）` : ''}</p>
          <p className={`text-lg font-bold tabular-nums ${tone(avg)}`}>{pct(avg)}</p>
        </div>
      </div>

      {/* 直近6か月の月利（0 を中心に上=プラス・下=マイナス） */}
      <div className="mt-1.5 flex items-stretch gap-1" role="list" aria-label="直近の月利">
        {recent.map((m) => {
          const r = m.tradeCount > 0 ? m.ratePct : null;
          const h = r == null ? 0 : (Math.abs(r) / maxAbs) * 100;
          const isCur = m.month === currentMonth;
          return (
            <div key={m.month} role="listitem" className="flex flex-1 flex-col items-center">
              <span className={`text-[9px] font-semibold tabular-nums ${tone(r)}`}>{r == null ? '—' : pct(r)}</span>
              <div className="relative h-10 w-full">
                <span className="absolute inset-x-0 top-1/2 h-px bg-gray-300" />
                {r != null && r !== 0 && (
                  <span
                    className={`absolute left-1/2 w-3 -translate-x-1/2 rounded-sm ${r > 0 ? 'bg-green-500' : 'bg-red-500'}`}
                    style={r > 0 ? { bottom: '50%', height: `${h / 2}%` } : { top: '50%', height: `${h / 2}%` }}
                  />
                )}
              </div>
              <span className={`text-[9px] ${isCur ? 'font-bold text-orange-600' : 'text-gray-400'}`}>{Number(m.month.slice(5))}月</span>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-[9px] text-gray-400">
        月利＝その月の損益 ÷ 元手（月初の残高＋その月の入出金を入れた日から日割り）。入金は利益に数えません。平均は記録がある月の複利平均。
      </p>
    </div>
  );
};

export default MonthlyReturnPanel;
