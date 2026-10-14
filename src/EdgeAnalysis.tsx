// 通貨優位性ランキングページ。15分/30分/1時間/4時間の各ペアを分析し、
// トレンド方向・RR（リスクリワード）・ロールリバーサル信用度・プライスアクションを合成した
// 通貨別スコア（−100〜+100）でランキング表示する。ゴールド(XAU)も1通貨として並ぶ。
// currency-strength worker(/ranking, VITE_RANKING_URL) が Yahoo足から算出（AI非依存・cronキャッシュ）。
// スコア計算ロジックは src/lib/ranking.ts を共有。※過去/現在の値動きの参考情報であり投資助言ではない。
import { useEffect, useState } from 'react';
import {
  RANK_VERDICT_LABEL,
  RANKING_TIMEFRAMES,
  type RankingSnapshot,
} from '@/lib/ranking';
import type { SlTimeframe } from '@/lib/stoploss';

const RANKING_URL = import.meta.env.VITE_RANKING_URL as string | undefined;

const CURRENCY_META: Record<string, { label: string; icon: string }> = {
  USD: { label: '米ドル', icon: '🇺🇸' },
  JPY: { label: '円', icon: '🇯🇵' },
  EUR: { label: 'ユーロ', icon: '🇪🇺' },
  GBP: { label: '英ポンド', icon: '🇬🇧' },
  AUD: { label: '豪ドル', icon: '🇦🇺' },
  XAU: { label: 'ゴールド', icon: '🥇' },
};
const meta = (c: string) => CURRENCY_META[c] ?? { label: c, icon: '' };

const VERDICT_STYLE: Record<string, string> = {
  strong_buy: 'text-green-700 font-bold',
  buy: 'text-green-600',
  neutral: 'text-gray-500',
  sell: 'text-red-600',
  strong_sell: 'text-red-700 font-bold',
};

const TF_SHORT: Record<SlTimeframe, string> = { '15m': '15分', '30m': '30分', '1h': '1時間', '4h': '4時間' };
const pairLabel = (ins: string) => ins.replace('_', '/');
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

// TFスコア(-1..1)をチップの色・矢印に変換。中立は灰。
const tfChipStyle = (score: number): { cls: string; arrow: string } => {
  if (score >= 0.15) return { cls: 'bg-green-50 text-green-700', arrow: '▲' };
  if (score <= -0.15) return { cls: 'bg-red-50 text-red-600', arrow: '▼' };
  return { cls: 'bg-gray-50 text-gray-400', arrow: '―' };
};

// ある通貨に寄与するペアを、その通貨から見た向き（base=+ / quote=−）に揃えて返す。
function contributionsFor(currency: string, snap: RankingSnapshot) {
  return snap.pairs
    .filter((p) => p.instrument.split('_').includes(currency))
    .map((p) => {
      const sign = p.instrument.split('_')[0] === currency ? 1 : -1;
      return {
        instrument: p.instrument,
        score: Math.round(p.score * sign * 100),
        tfScores: p.tfScores.map((t) => ({ tf: t.tf, score: t.score * sign })),
      };
    })
    .sort((a, b) => b.score - a.score);
}

// 中央0の横棒（右=買い優位/緑、左=売り優位/赤）。
function ScoreBar({ score }: { score: number }) {
  const w = (Math.abs(score) / 100) * 50;
  return (
    <div className="relative h-2.5 rounded-full bg-gray-100">
      <span className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
      {score !== 0 && (
        <span
          className={`absolute inset-y-0 rounded-full ${score > 0 ? 'bg-green-500' : 'bg-red-500'}`}
          style={score > 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
        />
      )}
    </div>
  );
}

// 1通貨の行（タップで根拠内訳を開閉）。
function CurrencyRow({ rank, data, snap }: { rank: number; data: RankingSnapshot['currencies'][number]; snap: RankingSnapshot }) {
  const [open, setOpen] = useState(false);
  const m = meta(data.currency);
  const isGold = data.currency === 'XAU';
  return (
    <div className={`rounded-lg border ${isGold ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200 bg-white'}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full px-3 py-2.5 text-left">
        <div className="flex items-center gap-2">
          <span className="w-5 text-center text-sm font-bold text-gray-400 tabular-nums">{rank}</span>
          <span className="text-lg leading-none">{m.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-bold text-gray-800">
                {data.currency}
                <span className="ml-1 text-[11px] font-normal text-gray-500">{m.label}</span>
              </span>
              <span className={`text-xs ${VERDICT_STYLE[data.verdict]}`}>{RANK_VERDICT_LABEL[data.verdict]}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="flex-1">
                <ScoreBar score={data.score} />
              </div>
              <span
                className={`w-11 text-right text-sm font-bold tabular-nums ${
                  data.score > 0 ? 'text-green-700' : data.score < 0 ? 'text-red-600' : 'text-gray-400'
                }`}
              >
                {signed(data.score)}
              </span>
            </div>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-3 py-2 space-y-1.5">
          <p className="text-[10px] text-gray-400">根拠（{data.currency}目線・ペア別／TF別スコア）</p>
          {contributionsFor(data.currency, snap).map((c) => (
            <div key={c.instrument} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px] font-semibold text-gray-700">{pairLabel(c.instrument)}</span>
              <span
                className={`w-9 text-right text-[11px] font-bold tabular-nums ${
                  c.score > 0 ? 'text-green-700' : c.score < 0 ? 'text-red-600' : 'text-gray-400'
                }`}
              >
                {signed(c.score)}
              </span>
              <div className="flex flex-1 gap-1">
                {c.tfScores.map((t) => {
                  const st = tfChipStyle(t.score);
                  return (
                    <span key={t.tf} className={`flex-1 rounded px-1 py-0.5 text-center text-[10px] ${st.cls}`}>
                      {TF_SHORT[t.tf]} {st.arrow}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EdgeAnalysis() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<RankingSnapshot | null>(null);

  const load = async (initial: boolean) => {
    if (!RANKING_URL) return;
    if (initial) setLoading(true);
    try {
      const res = await fetch(RANKING_URL);
      const body = (await res.json()) as RankingSnapshot | { error: string };
      if ('error' in body) throw new Error(body.error);
      setData(body);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      if (initial) setLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(false), 10 * 60_000); // 10分ごとに再取得
    return () => clearInterval(timer);
  }, []);

  if (!RANKING_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        通貨ランキングは未設定です。<code>VITE_RANKING_URL</code> を設定すると使えます。
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-3 my-2">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-gray-500">15分 / 30分 / 1時間 / 4時間を合成</p>
        <button
          type="button"
          onClick={() => void load(true)}
          className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 active:bg-gray-200"
        >
          更新
        </button>
      </div>

      {loading && <p className="mt-3 text-sm text-gray-500">分析中…</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {data && (
        <div className="space-y-2">
          {data.currencies.map((c, i) => (
            <CurrencyRow key={c.currency} rank={i + 1} data={c} snap={data} />
          ))}
          {data.failed.length > 0 && (
            <p className="text-[11px] text-amber-600">取得できなかったペア: {data.failed.map(pairLabel).join(', ')}</p>
          )}
          <p className="text-[10px] leading-relaxed text-gray-400">
            スコア＝各ペアのトレンド方向・RR・ロールリバーサル信用度・プライスアクションを
            {RANKING_TIMEFRAMES.length}つのTF（上位足ほど重く）で合成し、買われている通貨(+)/売られている通貨(−)に
            配分して −100〜+100 に正規化。ゴールド(XAU)も1通貨として評価。データは Yahoo Finance（XAU は先物 GC=F）。
            {data.generatedAt
              ? ` ${new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新。`
              : ''}
            ※AIを使わない純統計の参考情報であり、将来の値動きや利益を保証するものではありません。
          </p>
        </div>
      )}
    </div>
  );
}
