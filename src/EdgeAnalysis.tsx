// エッジ分析ページ。ピンバー・包み足が過去にどれだけ機能したか（N本先の勝率・平均pips・エッジ）を
// ペアごとに集計し、最新確定足に優位性のあるパターンが出ていれば売買シグナルとして表示する。
// ペアのシグナルを通貨単位に振り分けた「通貨別の優位性」も表示（買い=基軸+／決済−）。
// Worker(/edge, VITE_EDGE_URL) が Yahoo足から算出。判定ロジックは src/lib/edge.ts を共有。
// ※過去統計による参考情報・投資助言ではない。
import { useEffect, useState } from 'react';
import {
  EDGE_TIMEFRAMES,
  MIN_SAMPLES,
  PATTERN_DIRECTION,
  PATTERN_LABEL,
  PINBAR_THRESHOLD,
  SIGNAL_LABEL,
  VERDICT_LABEL,
  type EdgeSignal,
  type EdgeSnapshot,
  type EdgeTimeframe,
  type EdgeVerdict,
  type PairEdge,
} from '@/lib/edge';

const EDGE_URL = import.meta.env.VITE_EDGE_URL as string | undefined;
const TF_STORAGE_KEY = 'edgeTimeframe';

const TF_LABEL: Record<EdgeTimeframe, string> = { '1h': '1時間足', '1d': '日足' };
const SIGNAL_STYLE: Record<EdgeSignal, string> = {
  buy: 'bg-green-100 text-green-700',
  sell: 'bg-red-100 text-red-700',
  neutral: 'bg-gray-100 text-gray-600',
};
const VERDICT_STYLE: Record<EdgeVerdict, string> = {
  strong: 'text-green-700 font-bold',
  weak: 'text-green-600',
  none: 'text-gray-500',
  negative: 'text-red-600',
  insufficient: 'text-gray-400',
};

const pairLabel = (instrument: string) => instrument.replace('_', '/');
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;

const loadTimeframe = (): EdgeTimeframe => {
  try {
    const v = localStorage.getItem(TF_STORAGE_KEY);
    return v && (EDGE_TIMEFRAMES as string[]).includes(v) ? (v as EdgeTimeframe) : '1h';
  } catch {
    return '1h';
  }
};

// 通貨別の優位性: 中央0の横棒（右=買い優位/緑、左=売り優位/赤）。
function CurrencyBiasCard({ data }: { data: EdgeSnapshot }) {
  const max = Math.max(1, ...data.currencies.map((c) => Math.abs(c.score)));
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <p className="mb-2 text-sm font-bold text-gray-800">通貨別の優位性</p>
      <div className="space-y-1.5">
        {data.currencies.map((c) => {
          const w = (Math.abs(c.score) / max) * 50;
          return (
            <div key={c.currency} className="grid grid-cols-[3rem_1fr_3.5rem] items-center gap-2">
              <span className="text-xs font-semibold text-gray-700">{c.currency}</span>
              <div className="relative h-2 rounded-full bg-gray-100">
                <span className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
                {c.score !== 0 && (
                  <span
                    className={`absolute inset-y-0 rounded-full ${c.score > 0 ? 'bg-green-500' : 'bg-red-500'}`}
                    style={c.score > 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
                  />
                )}
              </div>
              <span
                className={`text-right text-xs tabular-nums ${
                  c.score > 0 ? 'text-green-700' : c.score < 0 ? 'text-red-600' : 'text-gray-400'
                }`}
              >
                {signed(c.score)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-gray-400">
        ※最新確定足に優位性のあるパターンが出たペアのエッジ（%pt）を通貨ごとに合算。0＝シグナルなし。
      </p>
    </div>
  );
}

// 1ペアのカード: シグナル＋最新足のパターン → パターン別の過去統計テーブル。
function PairCard({ pair, horizon }: { pair: PairEdge; horizon: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-gray-800">{pairLabel(pair.instrument)}</p>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${SIGNAL_STYLE[pair.signal]}`}>
          {SIGNAL_LABEL[pair.signal]}
          {pair.signal !== 'neutral' && ` ${signed(pair.score)}`}
        </span>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
        最新足:
        {pair.current.length === 0 ? (
          <span className="text-gray-400">パターンなし</span>
        ) : (
          pair.current.map((p) => (
            <span
              key={p}
              className={`rounded px-1.5 py-0.5 font-semibold ${
                PATTERN_DIRECTION[p] === 1 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}
            >
              {PATTERN_LABEL[p]}
            </span>
          ))
        )}
        {pair.lastClosedAt && (
          <span className="ml-auto text-[10px] text-gray-400">
            {new Date(pair.lastClosedAt * 1000).toLocaleString('ja-JP', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            確定
          </span>
        )}
      </div>

      <table className="w-full text-[11px] tabular-nums">
        <thead>
          <tr className="border-b border-gray-100 text-gray-400">
            <th className="py-1 text-left font-normal">パターン</th>
            <th className="py-1 text-right font-normal">回数</th>
            <th className="py-1 text-right font-normal">勝率</th>
            <th className="py-1 text-right font-normal">エッジ</th>
            <th className="py-1 text-right font-normal">平均</th>
            <th className="py-1 text-right font-normal">判定</th>
          </tr>
        </thead>
        <tbody>
          {pair.stats.map((s) => (
            <tr key={s.pattern} className="border-b border-gray-50 last:border-0">
              <td className={`py-1 ${PATTERN_DIRECTION[s.pattern] === 1 ? 'text-green-700' : 'text-red-600'}`}>
                {PATTERN_LABEL[s.pattern]}
              </td>
              <td className="py-1 text-right text-gray-600">{s.count}</td>
              <td className="py-1 text-right text-gray-800">{s.count > 0 ? `${s.winRate.toFixed(0)}%` : '—'}</td>
              <td className={`py-1 text-right ${s.edge > 0 ? 'text-green-700' : s.edge < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                {s.count > 0 ? signed(s.edge) : '—'}
              </td>
              <td className="py-1 text-right text-gray-600">{s.count > 0 ? signed(s.avgPips) : '—'}</td>
              <td className={`py-1 text-right ${VERDICT_STYLE[s.verdict]}`}>{VERDICT_LABEL[s.verdict]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-gray-400">
        勝率・平均pipsは出現足の終値から{horizon}本先の終値まで（パターン方向基準）。エッジ＝勝率−全足平均の勝率。
      </p>
    </div>
  );
}

export default function EdgeAnalysis() {
  const [timeframe, setTimeframe] = useState<EdgeTimeframe>(loadTimeframe);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<EdgeSnapshot | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(TF_STORAGE_KEY, timeframe);
    } catch {
      // 保存できなくても表示は続行
    }
  }, [timeframe]);

  // 足の切替で自動取得（マウント時も取得）。
  useEffect(() => {
    if (!EDGE_URL) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    (async () => {
      try {
        const res = await fetch(`${EDGE_URL}?timeframe=${encodeURIComponent(timeframe)}`);
        const body = (await res.json()) as EdgeSnapshot | { error: string };
        if ('error' in body) throw new Error(body.error);
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [timeframe]);

  if (!EDGE_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        エッジ分析は未設定です。<code>VITE_EDGE_URL</code> を設定すると使えます。
      </div>
    );
  }

  // シグナルが出ているペアを先頭に（強い順）、残りは既定順。
  const pairs = data ? [...data.pairs].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)) : [];

  return (
    <div className="mx-auto max-w-md px-3 my-2">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1">
        {EDGE_TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => setTimeframe(tf)}
            className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
              timeframe === tf ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500'
            }`}
          >
            {TF_LABEL[tf]}
          </button>
        ))}
      </div>

      {loading && <p className="mt-3 text-sm text-gray-500">分析中…</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {data && (
        <div className="mt-3 space-y-3">
          <CurrencyBiasCard data={data} />
          {pairs.map((p) => (
            <PairCard key={p.instrument} pair={p} horizon={data.horizon} />
          ))}
          {data.failed.length > 0 && (
            <p className="text-[11px] text-amber-600">取得できなかったペア: {data.failed.map(pairLabel).join(', ')}</p>
          )}
          <p className="text-[10px] leading-relaxed text-gray-400">
            ピンバー＝ヒゲが全値幅の{Math.round(PINBAR_THRESHOLD * 100)}%以上。包み足＝前足の実体を逆向きの実体で包む。
            出現{MIN_SAMPLES}回未満はサンプル不足として判定しません。XAU/USD は金先物(GC=F)の足で集計。
            {' '}{new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新。
            ※過去統計による参考情報であり、将来の値動きや利益を保証するものではありません。
          </p>
        </div>
      )}
    </div>
  );
}
