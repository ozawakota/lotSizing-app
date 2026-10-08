// レジサポライン分析ページ。選んだペアを 15m/30m/1h/4h で見て、各足の
// レジスタンス(直近スイング高値)・サポート(直近スイング安値)・現在値を提示し、
// Jev AI の判定で「ブレイクの可能性（上抜け/下抜け）」と「反転の可能性(PA)」を表示する。
// データは Worker(/mtf, VITE_MTF_URL) を流用（Yahoo足＋Jev）。※参考情報・投資助言ではない。
import { useEffect, useState } from 'react';
import type { BreakoutProb, PaClass, SlTimeframe } from '@/lib/stoploss';
import { pipSize } from '@/lib/stoploss';
import { fetchGoldSpot } from '@/lib/goldSpot';
import TfCountdown from '@/components/TfCountdown';

const MTF_URL = import.meta.env.VITE_MTF_URL as string | undefined;

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

interface SrTf {
  tf: SlTimeframe;
  trend: 'up' | 'down' | 'range';
  swingHigh: number;
  swingLow: number;
  pa: PaClass;
  paPct: number;
  breakout: BreakoutProb | null;
  volumeLevel: number | null; // 過去の高出来高の節目（30m/1h=2日前・4h=2週前。出来高無し=null）
  stoch: { k: number; d: number } | null; // ストキャスティクス(%K/%D)
}
interface MtfResult {
  instrument: string;
  currentRate: number;
  timeframes: SrTf[];
  generatedAt: number;
}

const digitsFor = (instrument: string): number =>
  instrument.startsWith('XAU') ? 2 : instrument.endsWith('JPY') ? 3 : 5;

const TF_LABEL: Record<SlTimeframe, string> = { '15m': '15分足', '30m': '30分足', '1h': '1時間足', '4h': '4時間足' };
// 出来高の節目が参照する過去時点（カード表示用）。
const VOLUME_AGO_LABEL: Record<SlTimeframe, string> = { '15m': '2日前', '30m': '2日前', '1h': '2日前', '4h': '2週間前' };
const TREND_LABEL: Record<'up' | 'down' | 'range', string> = { up: '上昇', down: '下降', range: 'レンジ' };
const TREND_STYLE: Record<'up' | 'down' | 'range', string> = {
  up: 'bg-green-100 text-green-700',
  down: 'bg-red-100 text-red-700',
  range: 'bg-gray-100 text-gray-600',
};
const PA_LABEL: Record<PaClass, string> = { reversal: '反転', sell_rally: '戻り売り', buy_dip: '押し目買い', range: 'レンジ' };

// カード右上の「結論チップ」。反転が出ていれば最優先、無ければブレイク優勢、
// それも無ければPAラベル。色: 上抜け=緑 / 下抜け=赤 / 反転=アンバー / その他=グレー。
function verdict(tf: SrTf): { label: string; cls: string } {
  const AMBER = 'bg-amber-100 text-amber-700';
  const GREEN = 'bg-green-100 text-green-700';
  const RED = 'bg-red-100 text-red-700';
  const GRAY = 'bg-gray-100 text-gray-600';
  if (tf.pa === 'reversal') return { label: `反転 ${tf.paPct}%`, cls: AMBER };
  if (tf.breakout) {
    const { up, down, range } = tf.breakout;
    const max = Math.max(up, down, range);
    if (max === up) return { label: `上抜け ${up}%`, cls: GREEN };
    if (max === down) return { label: `下抜け ${down}%`, cls: RED };
    return { label: `レンジ継続 ${range}%`, cls: GRAY };
  }
  return { label: PA_LABEL[tf.pa], cls: GRAY };
}

// レジサポラインの1行（レジ/サポ）。ラベル＋価格＋現在値からの距離を列で揃える。
function LevelLine({
  side,
  price,
  distancePips,
  digits,
}: {
  side: 'res' | 'sup';
  price: number;
  distancePips: number;
  digits: number;
}) {
  const res = side === 'res';
  return (
    <>
      <span className={`flex items-center gap-1.5 text-sm ${res ? 'text-red-600' : 'text-green-600'}`}>
        <span className={`inline-block h-0.5 w-4 ${res ? 'bg-red-500' : 'bg-green-500'}`} />
        {res ? 'レジ R' : 'サポ S'}
      </span>
      <span className="text-right text-sm font-bold tabular-nums text-gray-800">{price.toFixed(digits)}</span>
      <span className="w-16 text-right text-[11px] tabular-nums text-gray-400">
        {res ? '+' : '−'}{distancePips.toFixed(1)}pips
      </span>
    </>
  );
}

// 各TFのレジサポ＋判定カード。結論チップ → レジ/現在/サポ → 補助指標 の順で読ませる。
function TfCard({ tf, instrument, currentRate, digits }: { tf: SrTf; instrument: string; currentRate: number; digits: number }) {
  const pip = pipSize(instrument);
  const resDist = Math.abs(tf.swingHigh - currentRate) / pip;
  const supDist = Math.abs(currentRate - tf.swingLow) / pip;
  const v = verdict(tf);
  const stochLabel = !tf.stoch ? null : tf.stoch.k >= 80 ? '買われすぎ' : tf.stoch.k <= 20 ? '売られすぎ' : '中立';
  const stochCls = !tf.stoch
    ? ''
    : tf.stoch.k >= 80
      ? 'text-red-600'
      : tf.stoch.k <= 20
        ? 'text-green-600'
        : 'text-gray-500';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      {/* ヘッダー: 時間足 ＋ トレンド ＋ 結論チップ */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-gray-800">{TF_LABEL[tf.tf]}</p>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${TREND_STYLE[tf.trend]}`}>
            {TREND_LABEL[tf.trend]}
          </span>
          <TfCountdown tf={tf.tf} />
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${v.cls}`}>{v.label}</span>
      </div>

      {/* レジ → 現在 → サポ（価格列を揃える3行グリッド） */}
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-2 border-y border-gray-100 py-2">
        <LevelLine side="res" price={tf.swingHigh} distancePips={resDist} digits={digits} />

        <span className="text-sm font-medium text-gray-500">現在</span>
        <span className="text-right text-xl font-bold tabular-nums text-gray-900">{currentRate.toFixed(digits)}</span>
        <span />

        <LevelLine side="sup" price={tf.swingLow} distancePips={supDist} digits={digits} />
      </div>

      {/* 補助指標（ストキャス・出来高節目）を1行に集約。無ければ非表示 */}
      {(tf.stoch || tf.volumeLevel != null) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
          {tf.stoch && (
            <span>
              ストキャス <span className="font-semibold tabular-nums text-gray-700">{tf.stoch.k.toFixed(0)}/{tf.stoch.d.toFixed(0)}</span>{' '}
              <span className={`font-semibold ${stochCls}`}>{stochLabel}</span>
            </span>
          )}
          {tf.volumeLevel != null && (
            <span>
              出来高節目（{VOLUME_AGO_LABEL[tf.tf]}）{' '}
              <span className="font-semibold tabular-nums text-gray-700">{tf.volumeLevel.toFixed(digits)}</span>
              <span className={tf.volumeLevel >= currentRate ? 'text-red-600' : 'text-green-600'}>
                {tf.volumeLevel >= currentRate ? '（レジ）' : '（サポ）'}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// XAU の GC=F(先物)基準を現物スポット基準へ平行移動する。gold-api のスポットを取得し、
// offset = 先物現在値 − スポットを全価格から引く。取得失敗時は元の payload をそのまま返す。
async function toSpotBasis(body: MtfResult): Promise<MtfResult> {
  const spot = await fetchGoldSpot();
  if (spot === null || !(body.currentRate > 0)) return body;
  const offset = body.currentRate - spot;
  return {
    ...body,
    currentRate: spot,
    timeframes: body.timeframes.map((t) => ({
      ...t,
      swingHigh: t.swingHigh - offset,
      swingLow: t.swingLow - offset,
      volumeLevel: t.volumeLevel == null ? null : t.volumeLevel - offset,
    })),
  };
}

export default function SupportResistance() {
  const [instrument, setInstrument] = useState('XAU_USD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MtfResult | null>(null);

  useEffect(() => {
    if (!MTF_URL) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setResult(null);
    (async () => {
      try {
        const res = await fetch(`${MTF_URL}?instrument=${encodeURIComponent(instrument)}`);
        const body = (await res.json()) as MtfResult | { error: string };
        if ('error' in body) throw new Error(body.error);
        // XAU は /mtf が金先物(GC=F)基準。現物スポット(gold-api)との差分だけ全体を平行移動し、
        // 現在レート・レジサポ線をスポット基準に揃える（構造・ブレイク判定は不変）。失敗時は GC=F のまま。
        const adjusted = instrument === 'XAU_USD' ? await toSpotBasis(body) : body;
        if (!cancelled) setResult(adjusted);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instrument]);

  const digits = result ? digitsFor(result.instrument) : 5;

  if (!MTF_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        レジサポライン分析は未設定です。<code>VITE_MTF_URL</code> を設定すると使えます。
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-3 my-2">
      <label className="flex flex-col gap-1 text-xs text-gray-600">
        通貨ペア
        <select
          className="rounded border border-gray-300 bg-white px-2 py-2 text-sm"
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
        >
          {PAIRS.map((p) => (
            <option key={p.instrument} value={p.instrument}>{p.label}</option>
          ))}
        </select>
      </label>

      {loading && <p className="mt-3 text-sm text-gray-500">分析中…</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {result && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between rounded-md border border-gray-200 bg-white p-3">
            <div>
              <p className="text-xs text-gray-500">現在レート</p>
              <p className="text-xl font-bold text-gray-800">{result.currentRate.toFixed(digits)}</p>
            </div>
            <p className="text-[10px] text-gray-400">
              {new Date(result.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新
            </p>
          </div>

          {result.timeframes.map((tf) => (
            <TfCard key={tf.tf} tf={tf} instrument={result.instrument} currentRate={result.currentRate} digits={digits} />
          ))}

          <p className="text-[10px] text-gray-400">
            ※ レジサポは直近スイング高安、ブレイク/反転は Jev AI の推定です。参考情報であり投資助言ではありません。
          </p>
        </div>
      )}
    </div>
  );
}
