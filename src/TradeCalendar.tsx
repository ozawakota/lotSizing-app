// 月間損益カレンダー。各日のセルにその日の合計損益を色付きで表示し、日タップで選択。
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { dailyPnl, monthGrid, type Trade } from '@/lib/fund';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const monthPrefix = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

export default function TradeCalendar({
  trades,
  selectedDate,
  onSelectDate,
}: {
  trades: Trade[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });

  const pnl = dailyPnl(trades);
  const weeks = monthGrid(cursor.y, cursor.m);
  const prefix = monthPrefix(cursor.y, cursor.m);
  const monthTotal = Object.entries(pnl)
    .filter(([d]) => d.startsWith(prefix))
    .reduce((s, [, v]) => s + v, 0);

  const prev = () => setCursor((c) => (c.m === 1 ? { y: c.y - 1, m: 12 } : { y: c.y, m: c.m - 1 }));
  const next = () => setCursor((c) => (c.m === 12 ? { y: c.y + 1, m: 1 } : { y: c.y, m: c.m + 1 }));

  return (
    <div className="bg-white rounded-md p-2 border border-gray-200">
      {/* ヘッダー: 月移動 + 月間合計 */}
      <div className="flex items-center justify-between px-1 mb-1">
        <button type="button" aria-label="前の月" onClick={prev} className="p-1 text-gray-500">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-sm font-bold text-gray-700">
          {cursor.y}年{cursor.m}月
          <span className={`ml-2 text-xs ${monthTotal >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {monthTotal >= 0 ? '+' : ''}
            {monthTotal.toLocaleString()}
          </span>
        </div>
        <button type="button" aria-label="次の月" onClick={next} className="p-1 text-gray-500">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* 曜日 */}
      <div className="grid grid-cols-7 text-center text-[10px] text-gray-400">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : ''}>
            {w}
          </div>
        ))}
      </div>

      {/* 日セル */}
      <div className="grid grid-cols-7 gap-0.5 mt-0.5">
        {weeks.flat().map((date, i) => {
          if (!date) return <div key={i} />;
          const p = pnl[date];
          const day = Number(date.slice(8));
          const selected = date === selectedDate;
          const bg = p == null ? 'bg-gray-50' : p > 0 ? 'bg-green-50' : p < 0 ? 'bg-red-50' : 'bg-gray-50';
          const ring = selected ? 'ring-2 ring-orange-400' : 'border border-transparent';
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelectDate(date)}
              className={`rounded ${bg} ${ring} h-11 flex flex-col items-center justify-center leading-none`}
            >
              <span className="text-[10px] text-gray-500">{day}</span>
              {p != null && (
                <span className={`text-[10px] font-bold ${p >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {p >= 0 ? '+' : ''}
                  {Math.round(p).toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
