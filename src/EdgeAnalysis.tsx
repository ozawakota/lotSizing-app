// RR好機ボード。各通貨ペア×時間足（15分/30分/1時間/4時間）で構造RR(≥1:2.5)が成立した好機を
// 2列カードで一覧表示し、すぐ売買確認できるようにする。信用度は Jev のブレイク方向確率（AI）。
// Jev が使用上限/失敗のときは構造判定(roleReversal)で代替し、カードは必ず表示する。
// currency-strength worker(/ranking, VITE_RANKING_URL) が算出・KVキャッシュ。整形は src/lib/ranking.ts を共有。
// ※投資助言ではなく、値動きや利益を保証するものではない参考情報。
import { useEffect, useState } from 'react';
import { RANKING_TIMEFRAMES, type RrBoardSnapshot, type RrCard } from '@/lib/ranking';
import type { EntryKind } from '@/lib/entrySignal';
import type { SlTimeframe } from '@/lib/stoploss';

const RANKING_URL = import.meta.env.VITE_RANKING_URL as string | undefined;

const TF_LABEL: Record<SlTimeframe, string> = { '15m': '15分', '30m': '30分', '1h': '1時間', '4h': '4時間' };
// エントリータイミングのバッジ（押し目/戻り=緑・打診=黄・反転警戒=アンバー）。
const ENTRY_STYLE: Record<EntryKind, { cls: string; icon: string }> = {
  pullback: { cls: 'bg-green-100 text-green-700', icon: '🟢' },
  tentative: { cls: 'bg-yellow-50 text-yellow-700', icon: '🟡' },
  caution: { cls: 'bg-amber-100 text-amber-800', icon: '⚠' },
};
const pairLabel = (ins: string) => ins.replace('_', '/');
const digitsFor = (ins: string) => (ins.startsWith('XAU') ? 2 : ins.endsWith('JPY') ? 3 : 5);
const SOURCE_LABEL = { jev: 'AI', structure: '構造' } as const;

// 1好機カード（ペア×TF）。買い=緑/売り=赤。信用度≥50 は強調。
function OpportunityCard({ card }: { card: RrCard }) {
  const d = digitsFor(card.instrument);
  const long = card.direction === 'long';
  const dirColor = long ? 'text-green-700' : 'text-red-700';
  const dirBg = long ? 'border-green-200 bg-green-50/40' : 'border-red-200 bg-red-50/40';
  const conf = card.confidence;
  const confStrong = conf != null && conf >= 50;
  return (
    <div className={`rounded-lg border p-2.5 ${dirBg}`}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-xs font-bold text-gray-800">{pairLabel(card.instrument)}</span>
        <span className="text-[11px] text-gray-500">{TF_LABEL[card.tf]}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-1">
        <span className={`text-sm font-bold ${dirColor}`}>
          {long ? '▲買い' : '▼売り'}
        </span>
        <span className="text-xs font-bold text-gray-700">RR 1:{card.rr.toFixed(1)}</span>
      </div>
      {card.entrySignal && (
        <div className="mt-1">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${ENTRY_STYLE[card.entrySignal.kind].cls}`}>
            {ENTRY_STYLE[card.entrySignal.kind].icon}
            {card.entrySignal.label}
          </span>
        </div>
      )}
      <div className="mt-1">
        {conf == null ? (
          <span className="text-[10px] text-gray-400">信用度 —</span>
        ) : (
          <span className={`text-[11px] ${confStrong ? 'font-bold text-indigo-700' : 'text-gray-500'}`}>
            信用度 {conf}
            <span className="ml-0.5 text-[9px] text-gray-400">
              {card.confidenceSource ? SOURCE_LABEL[card.confidenceSource] : ''}
            </span>
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-0.5 text-[11px] tabular-nums text-gray-600">
        <div className="flex justify-between">
          <span className="text-gray-400">入</span>
          <span className="font-semibold text-gray-800">{card.entry.toFixed(d)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">損</span>
          <span className="text-red-600">{card.stop.toFixed(d)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">利</span>
          <span className="text-green-600">{card.target.toFixed(d)}</span>
        </div>
      </div>
      <p className="mt-1 text-[9px] text-gray-400">
        リスク{card.riskPips}pips / リワード{card.rewardPips}pips
      </p>
    </div>
  );
}

export default function EdgeAnalysis() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<RrBoardSnapshot | null>(null);

  const load = async (initial: boolean) => {
    if (!RANKING_URL) return;
    if (initial) setLoading(true);
    try {
      const res = await fetch(RANKING_URL);
      const body = (await res.json()) as RrBoardSnapshot | { error: string };
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
        RR好機ボードは未設定です。<code>VITE_RANKING_URL</code> を設定すると使えます。
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-3 my-2">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-gray-500">RR好機（15分/30分/1時間/4時間・RR≥1:2.5）</p>
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
          {data.jevPaused && (
            <p className="rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
              AI信用度は一時停止中（使用上限）。信用度は構造判定で表示しています。
            </p>
          )}
          {data.cards.length === 0 ? (
            <p className="mt-6 text-center text-sm text-gray-400">現在、条件を満たす好機はありません。</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {data.cards.map((c) => (
                <OpportunityCard key={`${c.instrument}:${c.tf}`} card={c} />
              ))}
            </div>
          )}
          {data.failed.length > 0 && (
            <p className="text-[11px] text-amber-600">取得できなかったペア: {data.failed.map(pairLabel).join(', ')}</p>
          )}
          <p className="text-[10px] leading-relaxed text-gray-400">
            構造的RR（ピボット＋ATR＋上位TF目標、スプレッド込みの実質RR）が1:2.5以上の好機を、
            信用度（AI＝Jevのブレイク方向確率／構造＝ロールリバーサル）＋エントリータイミングの実効スコア順に表示。
            タイミングは 🟢押し目/戻り・🟡打診・⚠反転警戒（移動平均SMA21/EMA75/EMA200＋ストキャス＋プライスアクション）。
            対象は{RANKING_TIMEFRAMES.map((t) => TF_LABEL[t]).join('/')}。データは Yahoo Finance。
            {data.generatedAt
              ? ` ${new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新。`
              : ''}
            ※将来の値動きや利益を保証するものではありません。
          </p>
        </div>
      )}
    </div>
  );
}
