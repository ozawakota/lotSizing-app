// 損切り位置サジェスト ページ。
// ペア+方向+足を選ぶと、backend(/stoploss) が構造(ZigZag/Fib)で損切り価格を決め、
// 通貨強弱・取引量を確信度として返す。VITE_BACKEND_URL 未設定なら案内のみ表示。
import { useState } from 'react';
import { Menu } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL as string | undefined;

// 表示ペア → OANDA instrument。
const PAIRS: { label: string; instrument: string }[] = [
  { label: 'USD/JPY', instrument: 'USD_JPY' },
  { label: 'EUR/JPY', instrument: 'EUR_JPY' },
  { label: 'GBP/JPY', instrument: 'GBP_JPY' },
  { label: 'AUD/JPY', instrument: 'AUD_JPY' },
  { label: 'EUR/USD', instrument: 'EUR_USD' },
  { label: 'GBP/USD', instrument: 'GBP_USD' },
  { label: 'AUD/USD', instrument: 'AUD_USD' },
  { label: 'XAU/USD', instrument: 'XAU_USD' },
];

const TIMEFRAMES = ['30m', '1h', '4h'] as const;

interface StrengthSignal {
  base: string;
  quote: string;
  baseStrength: number;
  quoteStrength: number;
  agree: boolean;
}
interface VolumeSignal {
  longPct: number;
  shortPct: number;
  lean: 'buy' | 'sell';
}
interface StopLossResult {
  instrument: string;
  direction: 'long' | 'short';
  timeframe: string;
  entry: number;
  stopLoss: { price: number; distancePips: number; basis: string; bufferPct: number; swing: { price: number; type: string } };
  fibonacci: { nearest: string | null; beyond618: boolean; alignedWithSwing: boolean } | null;
  confidence: { level: 'low' | 'medium' | 'high'; score: number; reasons: string[] };
  signals: { strength: StrengthSignal | null; volume: VolumeSignal | null };
}

const digitsFor = (instrument: string): number =>
  instrument.startsWith('XAU') ? 2 : instrument.endsWith('JPY') ? 3 : 5;

const CONFIDENCE_STYLE: Record<string, string> = {
  high: 'bg-green-100 text-green-700 border-green-300',
  medium: 'bg-amber-100 text-amber-700 border-amber-300',
  low: 'bg-red-100 text-red-700 border-red-300',
};
const CONFIDENCE_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };

export default function StopLossTool({ onOpenMenu }: { onOpenMenu: () => void }) {
  const [instrument, setInstrument] = useState('GBP_USD');
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>('1h');
  const [entry, setEntry] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StopLossResult | null>(null);

  const run = async () => {
    if (!BACKEND_URL) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const params = new URLSearchParams({ direction, timeframe });
      if (entry.trim()) params.set('entry', entry.trim());
      const res = await fetch(`${BACKEND_URL}/stoploss/${instrument}?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `HTTP ${res.status}`);
      }
      setResult((await res.json()) as StopLossResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const digits = result ? digitsFor(result.instrument) : 5;
  const selectCls = 'rounded border border-gray-300 px-2 py-2 text-sm bg-white';

  return (
    <>
      <div className="relative">
        <h1 className="text-center text-base! font-bold lh-base">損切り提案</h1>
        <button
          type="button"
          aria-label="メニュー"
          className="absolute top-0 right-3 text-gray-600 rounded-full h-8 w-8 flex items-center justify-center border border-gray-300"
          onClick={onOpenMenu}
        >
          <Menu className="h-4 w-4" />
        </button>
      </div>

      {!BACKEND_URL ? (
        <div className="mx-3 my-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-700">
          バックエンド未設定です。<code>VITE_BACKEND_URL</code> を設定すると損切り提案が使えます。
        </div>
      ) : (
        <div className="mx-3 my-2">
          {/* 入力 */}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-gray-600">
              通貨ペア
              <select className={selectCls} value={instrument} onChange={(e) => setInstrument(e.target.value)}>
                {PAIRS.map((p) => (
                  <option key={p.instrument} value={p.instrument}>{p.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-600">
              方向
              <select className={selectCls} value={direction} onChange={(e) => setDirection(e.target.value as 'long' | 'short')}>
                <option value="long">買い (long)</option>
                <option value="short">売り (short)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-600">
              タイムフレーム
              <select className={selectCls} value={timeframe} onChange={(e) => setTimeframe(e.target.value as (typeof TIMEFRAMES)[number])}>
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-600">
              エントリー価格 (任意)
              <input
                className={selectCls}
                inputMode="decimal"
                placeholder="未入力=現在値"
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="mt-3 w-full rounded bg-orange-500 text-white py-2 text-sm font-medium disabled:opacity-50"
          >
            {loading ? '計算中…' : '損切りを計算'}
          </button>

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          {/* 結果 */}
          {result && (
            <div className="mt-3 space-y-3">
              <div className="bg-blue-50 rounded-md p-3 border border-blue-200">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">推奨 損切り価格</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${CONFIDENCE_STYLE[result.confidence.level]}`}>
                    確信度 {CONFIDENCE_LABEL[result.confidence.level]}（{result.confidence.score}）
                  </span>
                </div>
                <p className="text-2xl font-bold text-blue-700">{result.stopLoss.price.toFixed(digits)}</p>
                <p className="text-xs text-gray-500">
                  現在値 {result.entry.toFixed(digits)} から {result.stopLoss.distancePips} pips（
                  {result.stopLoss.basis === 'swing_low' ? '直近スイング安値' : '直近スイング高値'} の外側）
                </p>
              </div>

              <div className="bg-gray-50 rounded-md p-3 border border-gray-200">
                <p className="text-sm font-bold text-gray-700 mb-1">根拠</p>
                <ul className="list-disc list-inside text-xs text-gray-600 space-y-0.5">
                  {result.confidence.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-white rounded-md p-2 border border-gray-200">
                  <p className="font-bold text-gray-700">通貨強弱</p>
                  {result.signals.strength ? (
                    <p className={result.signals.strength.agree ? 'text-green-600' : 'text-red-600'}>
                      {result.signals.strength.base} {result.signals.strength.baseStrength} / {result.signals.strength.quote}{' '}
                      {result.signals.strength.quoteStrength}（{result.signals.strength.agree ? '一致' : '不一致'}）
                    </p>
                  ) : (
                    <p className="text-gray-400">対象外/取得なし</p>
                  )}
                </div>
                <div className="bg-white rounded-md p-2 border border-gray-200">
                  <p className="font-bold text-gray-700">取引量</p>
                  {result.signals.volume ? (
                    <p className="text-gray-600">
                      ロング {result.signals.volume.longPct}% / ショート {result.signals.volume.shortPct}%
                    </p>
                  ) : (
                    <p className="text-gray-400">取得なし</p>
                  )}
                </div>
              </div>

              {result.fibonacci && (
                <p className="text-[11px] text-gray-400">
                  Fib: 最寄り {result.fibonacci.nearest ?? '—'} / 61.8%外側 {result.fibonacci.beyond618 ? 'はい' : 'いいえ'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
