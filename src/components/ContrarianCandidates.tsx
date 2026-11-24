// 取引量・センチメント ページの「逆張りのエントリー候補」。
// 個人投資家の建玉が片側に大きく偏ったペア（65% 以上）を、その逆向きの候補として確からしさ（★）順に並べる。
// 判定は contrarianCandidates（src/lib/flow.ts）。文字を減らして一目で分かるように:
//   - 左: 候補の向き（↗買い / ↘売り）を色つきの丸で大きく
//   - 中: ペア名＋★、個人の建玉バー（緑=買い・赤=売り。多い側を濃く）、大口の向き（矢印）と積み増し
//   - 行全体を押すと、そのペアを選んだ状態で TF分析ページへ
import { FC, useState } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, ChevronRight, Crosshair } from 'lucide-react';
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

const STARS: Record<ContrarianGrade, string> = { A: '★★★', B: '★★', C: '★' };

// 個人の建玉バー（緑=買い・赤=売り）。多い側（群集）を濃く、少ない側を薄く。
const RetailBar: FC<{ buyPct: number }> = ({ buyPct }) => {
  const crowdBuy = buyPct >= 50;
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-7 shrink-0 text-[10px] text-gray-400">個人</span>
      <span className="flex h-2 flex-1 overflow-hidden rounded-full" aria-hidden="true">
        <span className={crowdBuy ? 'bg-green-500' : 'bg-green-200'} style={{ width: `${buyPct}%` }} />
        <span className={crowdBuy ? 'bg-red-200' : 'bg-red-500'} style={{ width: `${100 - buyPct}%` }} />
      </span>
      <span className={`w-[4.2rem] shrink-0 text-right text-[11px] font-bold tabular-nums ${crowdBuy ? 'text-green-700' : 'text-red-600'}`}>
        {crowdBuy ? '買い' : '売り'}
        {Math.round(crowdBuy ? buyPct : 100 - buyPct)}%
      </span>
    </span>
  );
};

// 大口（CFTC 投機筋）の向き
const SpecMark: FC<{ c: ContrarianCandidate }> = ({ c }) => {
  if (c.spec == null) return <span className="text-[10px] text-gray-400">データなし</span>;
  const Icon = c.spec === 'buy' ? ArrowUpRight : c.spec === 'sell' ? ArrowDownRight : ArrowRight;
  const color = c.spec === 'buy' ? 'text-green-700' : c.spec === 'sell' ? 'text-red-600' : 'text-gray-500';
  const word = c.spec === 'buy' ? '買い越し' : c.spec === 'sell' ? '売り越し' : '中立';
  return (
    <span className={`flex items-center gap-0.5 text-[11px] font-bold ${color}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {word}
      {c.specAdding && <span className="ml-1 rounded bg-orange-100 px-1 text-[9px] font-bold text-orange-700">積み増し中</span>}
      {c.grade === 'C' && <span className="ml-1 rounded bg-gray-100 px-1 text-[9px] font-semibold text-gray-500">個人と同じ向き</span>}
    </span>
  );
};

const Row: FC<{ c: ContrarianCandidate; onOpenTf?: (instrument: string) => void }> = ({ c, onOpenTf }) => {
  const buy = c.direction === 'buy';
  const instrument = TF_INSTRUMENTS[c.pair];
  const canOpen = !!(instrument && onOpenTf);
  const Arrow = buy ? ArrowUpRight : ArrowDownRight;
  const retailBuyPct = buy ? 100 - c.retailPct : c.retailPct; // 買い候補＝個人は売りに偏っている
  const body = (
    <>
      {/* 候補の向き */}
      <span className="flex w-12 shrink-0 flex-col items-center">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full text-white ${buy ? 'bg-green-500' : 'bg-red-500'}`}>
          <Arrow className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className={`mt-0.5 text-[10px] font-bold ${buy ? 'text-green-700' : 'text-red-600'}`}>{buy ? '買い候補' : '売り候補'}</span>
      </span>
      {/* ペア・★・個人のバー・大口 */}
      <span className="min-w-0 flex-1 space-y-1 text-left">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[14px] font-bold text-gray-800">{c.pair}</span>
          <span className={`text-[12px] tracking-tight ${c.grade === 'C' ? 'text-gray-300' : 'text-orange-500'}`} title={`確からしさ ${c.grade}`}>
            {STARS[c.grade]}
          </span>
        </span>
        <RetailBar buyPct={retailBuyPct} />
        <span className="flex items-center gap-1.5">
          <span className="w-7 shrink-0 text-[10px] text-gray-400">大口</span>
          <SpecMark c={c} />
        </span>
      </span>
      {/* TF分析へ */}
      {canOpen ? (
        <span className="flex w-10 shrink-0 flex-col items-center text-orange-500">
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
          <span className="text-[9px] font-semibold">TF分析</span>
        </span>
      ) : (
        <span className="w-10 shrink-0 text-center text-[9px] leading-tight text-gray-300">TF分析
          <br />
          未対応
        </span>
      )}
    </>
  );
  const cls = `flex w-full items-center gap-2 rounded-xl border px-2 py-2 ${
    buy ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'
  } ${c.grade === 'C' ? 'opacity-60' : ''}`;
  return (
    <li style={LIST_ITEM_RESET}>
      {canOpen ? (
        <button type="button" aria-label={`${c.pair} をTF分析で確認`} onClick={() => onOpenTf!(instrument!)} className={`${cls} active:scale-[0.99]`}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
};

const ContrarianCandidates: FC<{ items: ContrarianCandidate[]; onOpenTf?: (instrument: string) => void }> = ({ items, onOpenTf }) => {
  const [showWeak, setShowWeak] = useState(false);
  const strong = items.filter((c) => c.grade !== 'C');
  const weak = items.filter((c) => c.grade === 'C');
  const shown = showWeak ? items : strong;

  return (
    <section className="mb-3 rounded-xl border border-orange-200 bg-white px-3 py-2.5 shadow-sm" aria-label="逆張りのエントリー候補">
      <div className="mb-2 flex items-center gap-1.5">
        <Crosshair className="h-4 w-4 text-orange-500" aria-hidden="true" />
        <span className="text-[13px] font-bold text-gray-800">逆張りのエントリー候補</span>
        {strong.length > 0 && <span className="rounded-full bg-orange-500 px-1.5 text-[10px] font-bold text-white">{strong.length}</span>}
        <span className="ml-auto text-[10px] text-gray-400">個人の偏り 65%↑ の逆</span>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg bg-gray-50 py-3 text-center text-[11px] text-gray-500">
          {items.length === 0 ? 'いまは個人の偏りが大きいペアはありません' : '有力な候補はありません（大口も同じ向きのペアのみ）'}
        </p>
      ) : (
        <ul className="space-y-1.5" style={LIST_RESET}>
          {shown.map((c) => (
            <Row key={c.pair} c={c} onOpenTf={onOpenTf} />
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] text-gray-400">
        <span>
          <span className="text-orange-500">★★★</span> 大口が個人と逆　<span className="text-orange-500">★★</span> 大口は中立
        </span>
        {weak.length > 0 && (
          <button type="button" onClick={() => setShowWeak((v) => !v)} className="flex items-center gap-0.5 text-gray-400">
            <ChevronDown className={`h-3 w-3 transition-transform ${showWeak ? 'rotate-180' : ''}`} aria-hidden="true" />
            {showWeak ? '注意を隠す' : `注意 ${weak.length}件`}
          </button>
        )}
      </div>
      <p className="mt-0.5 text-[9px] text-gray-300">エントリーの合図ではありません。押して TF分析で流れ・抵抗線を確かめてから。※投資助言ではありません</p>
    </section>
  );
};

export default ContrarianCandidates;
