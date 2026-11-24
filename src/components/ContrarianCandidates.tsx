// 取引量・センチメント ページの「逆張りのエントリー候補」。
// 個人投資家の建玉が片側に大きく偏ったペア（65% 以上）を、その逆向きの候補として確からしさ（A/B/C）順に並べる。
// 判定は contrarianCandidates（src/lib/flow.ts）。各行から TF分析ページへ飛び、流れ・抵抗線・入りどきを確かめる。
import { FC, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronDown, Crosshair } from 'lucide-react';
import type { ContrarianCandidate, ContrarianGrade, FlowPair } from '@/lib/flow';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';

// TF分析ページで選べるペア（ほかは TF分析が未対応）
export const TF_INSTRUMENTS: Partial<Record<FlowPair, string>> = {
  'USD/JPY': 'USD_JPY',
  'EUR/JPY': 'EUR_JPY',
  'GBP/JPY': 'GBP_JPY',
  'AUD/JPY': 'AUD_JPY',
  'EUR/USD': 'EUR_USD',
  'GBP/USD': 'GBP_USD',
  'AUD/USD': 'AUD_USD',
  'XAU/USD': 'XAU_USD',
};

const GRADE_STYLE: Record<ContrarianGrade, { stars: string; label: string; cls: string }> = {
  A: { stars: '★★★', label: '有力', cls: 'bg-orange-100 text-orange-700' },
  B: { stars: '★★', label: '候補', cls: 'bg-amber-50 text-amber-700' },
  C: { stars: '★', label: '注意', cls: 'bg-gray-100 text-gray-500' },
};

const ContrarianCandidates: FC<{ items: ContrarianCandidate[]; onOpenTf?: (instrument: string) => void }> = ({ items, onOpenTf }) => {
  const [showWeak, setShowWeak] = useState(false);
  const strong = items.filter((c) => c.grade !== 'C');
  const weak = items.filter((c) => c.grade === 'C');
  const shown = showWeak ? items : strong;

  return (
    <section className="mb-3 rounded-xl border border-orange-200 bg-white px-3 py-2.5 shadow-sm" aria-label="逆張りのエントリー候補">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Crosshair className="h-4 w-4 text-orange-500" aria-hidden="true" />
        <span className="text-xs font-bold text-gray-800">逆張りのエントリー候補</span>
        <span className="ml-auto text-[10px] text-gray-400">個人が65%以上偏ったペアの逆向き</span>
      </div>

      {shown.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-gray-500">
          {items.length === 0 ? 'いまは個人の偏りが大きいペアはありません。' : '有力な候補はありません（大口も同じ向きのペアのみ）。'}
        </p>
      ) : (
        <ul className="space-y-1.5" style={LIST_RESET}>
          {shown.map((c) => {
            const g = GRADE_STYLE[c.grade];
            const buy = c.direction === 'buy';
            const instrument = TF_INSTRUMENTS[c.pair];
            const Arrow = buy ? ArrowUpRight : ArrowDownRight;
            return (
              <li
                key={c.pair}
                style={LIST_ITEM_RESET}
                className={`flex items-center gap-2 rounded-lg border-l-4 px-2 py-1.5 ${buy ? 'border-green-500 bg-green-50/60' : 'border-red-500 bg-red-50/60'} ${c.grade === 'C' ? 'opacity-70' : ''}`}
              >
                <div className="w-[4.6rem] shrink-0">
                  <p className="text-[13px] font-bold text-gray-800">{c.pair}</p>
                  <p className={`flex items-center text-[11px] font-bold ${buy ? 'text-green-700' : 'text-red-600'}`}>
                    <Arrow className="h-3.5 w-3.5" aria-hidden="true" />
                    {buy ? '買い候補' : '売り候補'}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <span className={`inline-block rounded px-1 text-[10px] font-bold ${g.cls}`}>
                    {g.stars} {g.label}
                  </span>
                  <p className="mt-0.5 flex flex-wrap gap-1">
                    {c.reasons.map((r) => (
                      <span key={r} className="rounded bg-white px-1 text-[10px] text-gray-600 ring-1 ring-gray-200">
                        {r}
                      </span>
                    ))}
                  </p>
                </div>
                {instrument && onOpenTf ? (
                  <button
                    type="button"
                    onClick={() => onOpenTf(instrument)}
                    className="shrink-0 rounded-full border border-orange-300 px-2 py-1 text-[10px] font-semibold text-orange-600"
                  >
                    TF分析で確認
                  </button>
                ) : (
                  <span className="shrink-0 text-[9px] text-gray-400">TF分析は未対応</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {weak.length > 0 && (
        <button type="button" onClick={() => setShowWeak((v) => !v)} className="mt-1.5 flex items-center gap-0.5 text-[10px] text-gray-400">
          <ChevronDown className={`h-3 w-3 transition-transform ${showWeak ? 'rotate-180' : ''}`} aria-hidden="true" />
          {showWeak ? '注意の候補を隠す' : `大口も同じ向きのペア（注意）${weak.length}件を表示`}
        </button>
      )}
      <p className="mt-1.5 text-[10px] leading-relaxed text-gray-400">
        ★★★＝大口が個人と逆（大口の側につく形）／★★＝大口は中立。エントリーの合図ではありません。TF分析で流れが候補の向きに変わり始めたか、抵抗線で止まったかを確かめてから。※投資助言ではありません。
      </p>
    </section>
  );
};

export default ContrarianCandidates;
