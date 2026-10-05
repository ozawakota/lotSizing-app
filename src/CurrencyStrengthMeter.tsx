// 通貨強弱メーター（OANDA式・累積対数の折れ線）
// 設計: docs/adr/0005-currency-strength-oanda-cumulative-log.md
// Cloudflare Worker(Cron+KV) がキャッシュした X/JPY 時系列(15分足/日足)を取得し、
// 選択した起点(4時間前/当日/年初)から 0 ベースで各通貨の累積対数強弱を計算・表示する。
// マウント時＋1時間ごとに自動再取得。取得失敗は電卓本体を妨げない。
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import {
  CurrencyCode,
  RateSeries,
  StrengthRange,
  computeCumulativeStrength,
  computeGoldLine,
  findStartIndex,
} from '@/lib/strength';
import StrengthInfoModal from './StrengthInfoModal';

interface StrengthData {
  computedAt: number;
  intraday: RateSeries | null; // Worker がまだ取得していないと null になり得る
  daily: RateSeries | null;
}

const REFRESH_MS = 60 * 60 * 1000; // 1時間

const RANGE_LABELS: Record<StrengthRange, string> = {
  '1h': '1時間前',
  '4h': '4時間前',
  today: '当日',
  year: '年初',
};

const CURRENCY_COLORS: Record<CurrencyCode, string> = {
  USD: '#2563eb',
  EUR: '#16a34a',
  GBP: '#9333ea',
  JPY: '#dc2626',
  CHF: '#0891b2',
  AUD: '#ea580c',
  CAD: '#ca8a04',
  NZD: '#0d9488',
};

// 独立したゴールド線（8通貨の強弱には含めず、別線として重ねて表示する）。
const GOLD_COLOR = '#d4af37';
const GOLD_LABEL = 'XAU';

// 凡例/一覧の1項目（8通貨とゴールドを統一的に扱う）。
interface LegendItem {
  key: string;
  label: string;
  color: string;
  changePct: number;
}

const fetchStrength = async (): Promise<StrengthData> => {
  const url = import.meta.env.VITE_STRENGTH_URL as string | undefined;
  if (!url) throw new Error('強弱エンドポイント(VITE_STRENGTH_URL)が未設定です');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`強弱API HTTP ${res.status}`);
  const data = (await res.json()) as StrengthData | { error: string };
  if ('error' in data) throw new Error(data.error);
  return data;
};

const CurrencyStrengthMeter: FC = () => {
  const [data, setData] = useState<StrengthData | null>(null);
  const [range, setRange] = useState<StrengthRange>('4h');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [infoOpen, setInfoOpen] = useState<boolean>(false);

  const loadStrength = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await fetchStrength());
    } catch (e) {
      console.warn('通貨強弱の取得に失敗:', e);
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.VITE_STRENGTH_URL) return;
    loadStrength();
    const id = setInterval(loadStrength, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadStrength]);

  // 選択された起点で、8通貨の累積強弱と独立したゴールド線を同じ起点で計算
  const computed = useMemo(() => {
    if (!data) return null;
    const source = range === 'year' ? data.daily : data.intraday;
    if (!source || source.datetimes.length < 2) return null;
    const startIndex = findStartIndex(source.datetimes, range, new Date());
    return {
      cumulative: computeCumulativeStrength(source, startIndex),
      goldLine: computeGoldLine(source, startIndex), // XAU 無し（旧キャッシュ等）なら null
    };
  }, [data, range]);

  const cumulative = computed?.cumulative ?? null;
  const goldLine = computed?.goldLine ?? null;

  // 凡例/一覧：8通貨＋（あれば）ゴールドを結合し、値の強い順に並べる。
  const legend: LegendItem[] = cumulative
    ? [
        ...cumulative.latest.map((s) => ({
          key: s.currency,
          label: s.currency,
          color: CURRENCY_COLORS[s.currency],
          changePct: s.changePct,
        })),
        ...(goldLine && goldLine.length > 0
          ? [{ key: GOLD_LABEL, label: GOLD_LABEL, color: GOLD_COLOR, changePct: goldLine[goldLine.length - 1] }]
          : []),
      ].sort((a, b) => b.changePct - a.changePct)
    : [];

  return (
    <div className="mt-2 text-xs">
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={loadStrength}
          disabled={loading}
          className="rounded-full border border-orange-500 px-3 py-1 text-orange-600 disabled:opacity-50"
        >
          {loading ? '取得中…' : data ? '通貨強弱を更新' : '通貨強弱を表示'}
        </button>
        {data && (
          <div className="flex gap-1">
            {(Object.keys(RANGE_LABELS) as StrengthRange[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded border px-2 py-0.5 ${
                  range === r ? 'border-orange-500 bg-orange-50 text-orange-600' : 'border-gray-300 text-gray-500'
                }`}
              >
                {RANGE_LABELS[r]}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label="通貨強弱の見方"
          onClick={() => setInfoOpen(true)}
          className="text-gray-400 hover:text-gray-600"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </div>

      <StrengthInfoModal isOpen={infoOpen} onClose={() => setInfoOpen(false)} />

      {error && <p className="mt-1 text-center text-red-600">{error}</p>}

      {data && !error && !cumulative && (
        <p className="mt-1 text-center text-gray-400">
          {RANGE_LABELS[range]}データを準備中です。少し待って「更新」を押してください。
        </p>
      )}

      {cumulative && cumulative.datetimes.length >= 2 && (
        <div className="mx-auto mt-2 max-w-md">
          <div className="px-2">
            <StrengthChart cumulative={cumulative} goldLine={goldLine} />
          </div>
          <div className="mt-2 grid grid-cols-4 gap-x-3 gap-y-1 px-2">
            {legend.map((s) => (
              <div key={s.key} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: s.color }}
                  aria-hidden="true"
                />
                <span className="font-mono">{s.label}</span>
                <span className={`ml-auto tabular-nums ${s.changePct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {s.changePct >= 0 ? '+' : ''}
                  {s.changePct.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-center text-[10px] text-gray-400">
            {RANGE_LABELS[range]}起点・0基準の累積対数強弱（＋:買われ強い ／ −:売られ弱い）
            {goldLine && goldLine.length > 0 && (
              <>
                <br />
                破線（{GOLD_LABEL}）はゴールドの対通貨バスケット強弱（参考・8通貨の値には非影響）
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
};

// 8通貨の累積強弱を0基準の折れ線で描く軽量SVGチャート（依存なし）。
// goldLine があれば独立したゴールド線を1本重ねて描く（他通貨の値には影響しない）。
const StrengthChart: FC<{
  cumulative: ReturnType<typeof computeCumulativeStrength>;
  goldLine?: number[] | null;
}> = ({ cumulative, goldLine }) => {
  const W = 360;
  const H = 180;
  const pad = 6;
  const { series, datetimes } = cumulative;
  const len = datetimes.length;

  const currencies = Object.keys(series) as CurrencyCode[];
  let min = 0;
  let max = 0;
  for (const c of currencies) {
    for (const v of series[c]) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  // ゴールド線も表示範囲に含める（振幅が大きいことがある）。
  if (goldLine) {
    for (const v of goldLine) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (max === min) max = min + 1;

  const x = (i: number): number => pad + (i * (W - 2 * pad)) / (len - 1);
  const y = (v: number): number => H - pad - ((v - min) / (max - min)) * (H - 2 * pad);

  const zeroY = y(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="通貨強弱チャート">
      <rect x="0" y="0" width={W} height={H} fill="#fafafa" />
      <line x1={pad} y1={zeroY} x2={W - pad} y2={zeroY} stroke="#d1d5db" strokeWidth="1" />
      {currencies.map((c) => (
        <polyline
          key={c}
          fill="none"
          stroke={CURRENCY_COLORS[c]}
          strokeWidth="1.5"
          points={series[c].map((v, i) => `${x(i)},${y(v)}`).join(' ')}
        />
      ))}
      {goldLine && goldLine.length === len && (
        <polyline
          fill="none"
          stroke={GOLD_COLOR}
          strokeWidth="2"
          strokeDasharray="4 2"
          points={goldLine.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
        />
      )}
    </svg>
  );
};

export default CurrencyStrengthMeter;
