// 損切り提案ページ。ペア+方向+足(+任意エントリー)を指定すると、Worker(/stoploss) が
// Yahoo のロウソク足から構造(スイング高安)で損切り価格を算出し、プライスアクション
// (反転/戻り売り/押し目買い/レンジ)を Jev(失敗時 Workers AI)で判定、相場解説を Workers AI
// で返す。VITE_STOPLOSS_URL 未設定なら案内のみ表示。※参考情報であり投資助言ではない。
import { useState } from 'react';
import type { PaClass, SlDirection, SlTimeframe } from '@/lib/stoploss';

const STOPLOSS_URL = import.meta.env.VITE_STOPLOSS_URL as string | undefined;

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
const TIMEFRAMES: SlTimeframe[] = ['15m', '30m', '1h', '4h'];

interface StopLossResult {
  instrument: string;
  direction: SlDirection;
  timeframe: SlTimeframe;
  currentRate: number;
  entry: number | null;
  structure: { trend: 'up' | 'down' | 'range'; swingHigh: number; swingLow: number; currentRate: number };
  stopLoss: { price: number; distancePips: number; basis: 'swing_low' | 'swing_high'; reference: number };
  pa: { pa: PaClass; paPct: number; confidence: number };
  paEngine: string;
  comment: string;
  generatedAt: number;
}

const digitsFor = (instrument: string): number =>
  instrument.startsWith('XAU') ? 2 : instrument.endsWith('JPY') ? 3 : 5;

const PA_LABEL: Record<PaClass, string> = {
  reversal: '反転',
  sell_rally: '戻り売り',
  buy_dip: '押し目買い',
  range: 'レンジ',
};
const PA_STYLE: Record<PaClass, string> = {
  reversal: 'bg-amber-100 text-amber-700 border-amber-300',
  sell_rally: 'bg-red-100 text-red-700 border-red-300',
  buy_dip: 'bg-green-100 text-green-700 border-green-300',
  range: 'bg-gray-100 text-gray-600 border-gray-300',
};
const TREND_LABEL: Record<'up' | 'down' | 'range', string> = { up: '上昇', down: '下降', range: 'レンジ' };

export default function StopLossTool() {
  const [instrument, setInstrument] = useState('GBP_USD');
  const [direction, setDirection] = useState<SlDirection>('long');
  const [timeframe, setTimeframe] = useState<SlTimeframe>('1h');
  const [entry, setEntry] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StopLossResult | null>(null);

  const run = async () => {
    if (!STOPLOSS_URL) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const params = new URLSearchParams({ instrument, direction, timeframe });
      if (entry.trim()) params.set('entry', entry.trim());
      const res = await fetch(`${STOPLOSS_URL}?${params.toString()}`);
      const body = (await res.json()) as StopLossResult | { error: string };
      if ('error' in body) throw new Error(body.error);
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const digits = result ? digitsFor(result.instrument) : 5;
  const selectCls = 'rounded border border-gray-300 px-2 py-2 text-sm bg-white';

  if (!STOPLOSS_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        損切り提案は未設定です。<code>VITE_STOPLOSS_URL</code> を設定すると使えます。
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-3 my-2">
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
          <select className={selectCls} value={direction} onChange={(e) => setDirection(e.target.value as SlDirection)}>
            <option value="long">買い (long)</option>
            <option value="short">売り (short)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          タイムフレーム
          <select className={selectCls} value={timeframe} onChange={(e) => setTimeframe(e.target.value as SlTimeframe)}>
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
        className="mt-3 w-full rounded bg-orange-500 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {loading ? '分析中…' : '損切りを分析'}
      </button>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {result && (
        <div className="mt-3 space-y-3">
          {/* 現在レート＋プライスアクション */}
          <div className="flex items-center justify-between rounded-md border border-gray-200 bg-white p-3">
            <div>
              <p className="text-xs text-gray-500">現在レート</p>
              <p className="text-xl font-bold text-gray-800">{result.currentRate.toFixed(digits)}</p>
              <p className="text-[11px] text-gray-400">トレンド: {TREND_LABEL[result.structure.trend]}</p>
            </div>
            <div className="text-right">
              <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${PA_STYLE[result.pa.pa]}`}>
                {PA_LABEL[result.pa.pa]} {result.pa.paPct}%
              </span>
              <p className="mt-1 text-[11px] text-gray-400">確信度 {Math.round(result.pa.confidence * 100)}%</p>
            </div>
          </div>

          {/* 損切り価格 */}
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
            <p className="text-sm text-gray-600">推奨 損切り価格（{direction === 'long' ? '買い' : '売り'}）</p>
            <p className="text-2xl font-bold text-blue-700">{result.stopLoss.price.toFixed(digits)}</p>
            <p className="text-xs text-gray-500">
              {(result.entry ?? result.currentRate).toFixed(digits)} から {result.stopLoss.distancePips} pips（
              {result.stopLoss.basis === 'swing_low' ? '直近スイング安値' : '直近スイング高値'}{' '}
              {result.stopLoss.reference.toFixed(digits)} の外側）
            </p>
          </div>

          {/* 相場解説 */}
          {result.comment && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
              <p className="mb-1 text-sm font-bold text-gray-700">相場解説（AI）</p>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-700">{result.comment}</p>
            </div>
          )}

          <p className="text-[10px] text-gray-400">
            直近高値 {result.structure.swingHigh.toFixed(digits)} / 安値 {result.structure.swingLow.toFixed(digits)}（{timeframe}）
            ・プライスアクション判定: {result.paEngine === 'jev' ? 'Jev' : 'Workers AI'}
          </p>
          <p className="text-center text-[10px] text-gray-400">
            ※構造・AIによる推定の参考値です。投資助言ではありません。実際の損切りはご自身の判断で。
          </p>
        </div>
      )}
    </div>
  );
}
