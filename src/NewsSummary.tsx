// 為替ニュースタブ：売買シグナル%（＋反転/継続）と日本語要約、出典見出しを表示する。
// データは currency-strength Worker の /news（VITE_NEWS_URL）から取得。
// 要約・シグナルはAI推定の参考値であり投資助言ではない（画面にも明記）。
import { FC, useCallback, useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { PairSignal, TrendLabel } from '@/lib/signal';

interface NewsPayload {
  generatedAt: number;
  engine: string; // 'workers-ai' | 'jev'
  summary: string;
  signals: PairSignal[];
  items: { title: string; link: string; pubDate: string }[];
}

const CACHE_KEY = 'news-cache';

const TREND_LABEL: Record<TrendLabel, string> = {
  continuation: '継続',
  reversal: '反転',
  neutral: '中立',
};
const TREND_CLASS: Record<TrendLabel, string> = {
  continuation: 'bg-blue-100 text-blue-700',
  reversal: 'bg-amber-100 text-amber-700',
  neutral: 'bg-gray-100 text-gray-600',
};

const fetchNews = async (): Promise<NewsPayload> => {
  const url = import.meta.env.VITE_NEWS_URL as string | undefined;
  if (!url) throw new Error('ニュースエンドポイント(VITE_NEWS_URL)が未設定です');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ニュースAPI HTTP ${res.status}`);
  const data = (await res.json()) as NewsPayload | { error: string };
  if ('error' in data) throw new Error(data.error);
  return data;
};

const SignalRow: FC<{ s: PairSignal }> = ({ s }) => {
  const sellPct = 100 - s.buyPct;
  return (
    <div className="rounded-lg border border-gray-200 p-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-bold">{s.pair}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${TREND_CLASS[s.trend]}`}>
          {TREND_LABEL[s.trend]} {s.trendPct}%
        </span>
      </div>
      {/* 買い/売りの横バー */}
      <div className="mt-1 flex h-4 overflow-hidden rounded bg-gray-100 text-[10px] font-semibold text-white">
        <div className="flex items-center justify-start bg-green-600 pl-1" style={{ width: `${s.buyPct}%` }}>
          {s.buyPct >= 20 && `買 ${s.buyPct}%`}
        </div>
        <div className="flex items-center justify-end bg-red-500 pr-1" style={{ width: `${sellPct}%` }}>
          {sellPct >= 20 && `売 ${sellPct}%`}
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500">
        <span>確信度 {Math.round(s.confidence * 100)}%</span>
      </div>
      {s.rationale && <p className="mt-1 text-xs text-gray-600">{s.rationale}</p>}
    </div>
  );
};

const NewsSummary: FC = () => {
  const [data, setData] = useState<NewsPayload | null>(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as NewsPayload) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await fetchNews();
      setData(d);
      localStorage.setItem(CACHE_KEY, JSON.stringify(d));
    } catch (e) {
      console.warn('ニュース取得に失敗:', e);
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.VITE_NEWS_URL) return;
    load();
  }, [load]);

  const generated = data ? new Date(data.generatedAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' }) : '';

  return (
    <div className="mx-auto max-w-md px-3 pb-4 text-sm">
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-full border border-orange-500 px-3 py-1 text-orange-600 disabled:opacity-50"
        >
          {loading ? '取得中…' : data ? 'ニュースを更新' : 'ニュースを表示'}
        </button>
        {data && <span className="text-[10px] text-gray-400">更新 {generated}</span>}
      </div>

      {error && <p className="mt-2 text-center text-red-600">{error}</p>}

      {data && (
        <>
          {/* 売買シグナル */}
          <h3 className="mt-3 mb-1 font-bold text-gray-700">売買シグナル（AI推定）</h3>
          <div className="space-y-1.5">
            {data.signals.map((s) => (
              <SignalRow key={s.pair} s={s} />
            ))}
          </div>
          <p className="mt-1 flex items-center gap-1 text-[10px] text-gray-400">
            <HelpCircle className="h-3 w-3" />
            買い/売りの傾きと、直近トレンドの継続/反転の推定（{data.engine === 'jev' ? 'Jev' : 'Workers AI'}）。
          </p>

          {/* 要約 */}
          {data.summary && (
            <>
              <h3 className="mt-4 mb-1 font-bold text-gray-700">ニュース要約</h3>
              <div className="whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-xs leading-relaxed text-gray-700">
                {data.summary}
              </div>
            </>
          )}

          {/* 出典見出し */}
          {data.items.length > 0 && (
            <>
              <h3 className="mt-4 mb-1 font-bold text-gray-700">出典（FXStreet 他）</h3>
              <ul className="space-y-1">
                {data.items.map((it, i) => (
                  <li key={i} className="text-xs">
                    <a href={it.link} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                      {it.title}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-4 text-center text-[10px] text-gray-400">
            ※要約・シグナルはAIによる推定の参考値です。投資助言ではありません。実際の取引はご自身の判断で行ってください。
          </p>
        </>
      )}

      {!data && !error && !loading && (
        <p className="mt-3 text-center text-gray-400">「ニュースを表示」を押すと取得します。</p>
      )}
    </div>
  );
};

export default NewsSummary;
