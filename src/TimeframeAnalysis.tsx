// タイムフレーム分析ページ。選んだペアを 15m/30m/1h/4h で分析し、各TFのトレンド＋
// プライスアクション(反転/戻り売り/押し目買い/レンジ)と、全TFを統合した総合判断を表示。
// Worker(/mtf, VITE_MTF_URL) が Yahoo足＋Jev/Workers AI で算出。※参考情報・投資助言ではない。
import { useEffect, useState } from 'react';
import type {
  BreakoutProb,
  PaClass,
  RrSetup,
  SessionOutlook,
  SessionPrediction,
  SessionScenario,
  SlDirection,
  SlTimeframe,
} from '@/lib/stoploss';
import { MARKET_SESSIONS, isSessionOpen } from '@/lib/session';
import { fetchGoldSpot } from '@/lib/goldSpot';

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

interface MtfTf {
  tf: SlTimeframe;
  trend: 'up' | 'down' | 'range';
  swingHigh: number;
  swingLow: number;
  pa: PaClass;
  paPct: number;
  confidence: number;
  breakout: BreakoutProb | null;
  rr: RrSetup | null;
  volumeLevel: number | null; // 過去の高出来高の節目（レジサポページで使用。TF分析では表示しないが整合のため保持）
}
interface MtfResult {
  instrument: string;
  currentRate: number;
  timeframes: MtfTf[];
  alignment: string;
  comment: string;
  paEngine: string;
  rrOpportunity: (RrSetup & { tf: SlTimeframe }) | null;
  sessionOutlook: SessionOutlook | null;
  generatedAt: number;
}

// XAU は /mtf が金先物(GC=F)基準のため、gold-api の現物スポットとの差分(offset)で
// 現在レート・スイング高安・RR価格(エントリー/損切/目標)をスポット基準へ平行移動する。
// 構造・pips・確率は差分不変。取得失敗時は GC=F のまま。
async function toSpotBasis(body: MtfResult): Promise<MtfResult> {
  const spot = await fetchGoldSpot();
  if (spot === null || !(body.currentRate > 0)) return body;
  const off = body.currentRate - spot;
  const shiftRr = <T extends RrSetup>(rr: T): T => ({ ...rr, entry: rr.entry - off, stop: rr.stop - off, target: rr.target - off });
  return {
    ...body,
    currentRate: spot,
    timeframes: body.timeframes.map((t) => ({
      ...t,
      swingHigh: t.swingHigh - off,
      swingLow: t.swingLow - off,
      rr: t.rr ? shiftRr(t.rr) : null,
      volumeLevel: t.volumeLevel == null ? null : t.volumeLevel - off,
    })),
    rrOpportunity: body.rrOpportunity ? shiftRr(body.rrOpportunity) : null,
  };
}

const digitsFor = (instrument: string): number =>
  instrument.startsWith('XAU') ? 2 : instrument.endsWith('JPY') ? 3 : 5;

const TREND_LABEL: Record<'up' | 'down' | 'range', string> = { up: '上昇', down: '下降', range: 'レンジ' };
const TREND_STYLE: Record<'up' | 'down' | 'range', string> = {
  up: 'bg-green-100 text-green-700',
  down: 'bg-red-100 text-red-700',
  range: 'bg-gray-100 text-gray-600',
};
const PA_LABEL: Record<PaClass, string> = {
  reversal: '反転',
  sell_rally: '戻り売り',
  buy_dip: '押し目買い',
  range: 'レンジ',
};
const PA_STYLE: Record<PaClass, string> = {
  reversal: 'bg-amber-100 text-amber-700',
  sell_rally: 'bg-red-100 text-red-700',
  buy_dip: 'bg-green-100 text-green-700',
  range: 'bg-gray-100 text-gray-600',
};

// レンジブレイク確率（上抜け/下抜け/継続）を数値＋3色セグメントバー＋優勢ラベルで表示。
// breakout が null（Jev未取得）のときは判定不可を小さく示す。
function BreakoutRow({ breakout }: { breakout: BreakoutProb | null }) {
  if (!breakout) {
    return <p className="mt-2 text-[10px] text-gray-400">ブレイク判定: Jev未取得</p>;
  }
  const { up, down, range } = breakout;
  const dominant =
    up >= down && up >= range
      ? { label: '上方優勢', style: 'text-green-700' }
      : down >= up && down >= range
        ? { label: '下方優勢', style: 'text-red-700' }
        : { label: 'レンジ優勢', style: 'text-gray-500' };
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-gray-500">ブレイク</span>
        <span className="flex gap-2 font-semibold">
          <span className="text-green-700">↑上抜け {up}%</span>
          <span className="text-red-700">↓下抜け {down}%</span>
          <span className="text-gray-500">↔継続 {range}%</span>
        </span>
      </div>
      <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div className="bg-green-500" style={{ width: `${up}%` }} />
        <div className="bg-red-500" style={{ width: `${down}%` }} />
        <div className="bg-gray-300" style={{ width: `${range}%` }} />
      </div>
      <p className={`mt-0.5 text-right text-[10px] font-semibold ${dominant.style}`}>{dominant.label}</p>
    </div>
  );
}

const DIR_LABEL: Record<SlDirection, string> = { long: 'ロング', short: 'ショート' };
const DIR_STYLE: Record<SlDirection, string> = { long: 'text-green-700', short: 'text-red-700' };

const SCENARIO_LABEL: Record<SessionScenario, string> = {
  reversal: '反転',
  breakout: 'ブレイク',
  buy_dip: '押し目買い',
  sell_rally: '戻り売り',
  range: 'レンジ',
};
const SCENARIO_STYLE: Record<SessionScenario, string> = {
  reversal: 'bg-amber-100 text-amber-700',
  breakout: 'bg-blue-100 text-blue-700',
  buy_dip: 'bg-green-100 text-green-700',
  sell_rally: 'bg-red-100 text-red-700',
  range: 'bg-gray-100 text-gray-600',
};
const SCENARIO_BAR: Record<SessionScenario, string> = {
  reversal: 'bg-amber-500',
  breakout: 'bg-blue-500',
  buy_dip: 'bg-green-500',
  sell_rally: 'bg-red-500',
  range: 'bg-gray-400',
};

// 現在開いていないセッションのうち、最も早く開場するものの名前（「次」バッジ用）。
function nextSessionLabel(now: Date): string | null {
  for (let h = 1; h <= 48; h++) {
    const t = new Date(now.getTime() + h * 3600_000);
    for (const s of MARKET_SESSIONS) {
      if (!isSessionOpen(s, now) && isSessionOpen(s, t)) return s.label;
    }
  }
  return null;
}

// 東京/ロンドン/NY のシナリオ予測。開催中/次バッジ＋シナリオ＋確率バー。
function SessionOutlookCard({ outlook }: { outlook: SessionOutlook | null }) {
  if (!outlook) {
    return (
      <div className="rounded-md border border-gray-200 p-3">
        <p className="text-sm font-bold text-gray-700">セッション別予測</p>
        <p className="mt-1 text-[10px] text-gray-400">セッション予測: Jev未取得</p>
      </div>
    );
  }
  const now = new Date();
  const next = nextSessionLabel(now);
  const rows: { session: (typeof MARKET_SESSIONS)[number]; pred: SessionPrediction }[] = [
    { session: MARKET_SESSIONS[0], pred: outlook.tokyo },
    { session: MARKET_SESSIONS[1], pred: outlook.london },
    { session: MARKET_SESSIONS[2], pred: outlook.ny },
  ];
  return (
    <div className="rounded-md border border-gray-200 p-3">
      <p className="mb-1 text-sm font-bold text-gray-700">セッション別予測（Jev）</p>
      {rows.map(({ session, pred }) => {
        const open = isSessionOpen(session, now);
        const badge = open ? '開催中' : session.label === next ? '次' : '';
        return (
          <div key={session.label} className="mt-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full ${open ? 'bg-green-500' : 'border border-gray-400'}`}
                />
                <span className={open ? 'font-medium text-gray-800' : 'text-gray-500'}>{session.label}</span>
                {badge && <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-500">{badge}</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SCENARIO_STYLE[pred.scenario]}`}>
                  {SCENARIO_LABEL[pred.scenario]} {pred.pct}%
                </span>
                <span className="text-[10px] text-gray-400">確信{Math.round(pred.confidence * 100)}%</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div className={SCENARIO_BAR[pred.scenario]} style={{ width: `${pred.pct}%`, height: '100%' }} />
            </div>
          </div>
        );
      })}
      <p className="mt-2 text-[10px] text-gray-400">※セッション予測は構造＋AI推定の参考値です。</p>
    </div>
  );
}

// 上位TFスイングを目標にした RR 評価の1行。狙える(qualifies)ときはオレンジ＋✓で強調。
function RrRow({ rr, digits }: { rr: RrSetup | null; digits: number }) {
  if (!rr) return <p className="mt-1 text-[10px] text-gray-400">RR　上位TF目標なし —</p>;
  const ok = rr.qualifies;
  return (
    <div className="mt-1 flex items-center justify-between text-[11px]">
      <span className="flex items-center gap-1">
        <span className="text-gray-500">RR</span>
        <span className={`font-semibold ${DIR_STYLE[rr.direction]}`}>{DIR_LABEL[rr.direction]}</span>
        <span className={ok ? 'font-bold text-orange-600' : 'text-gray-500'}>
          1:{rr.rr.toFixed(1)}
          {ok ? ' ✓' : ''}
        </span>
      </span>
      <span className="text-[10px] text-gray-400">
        損切 {rr.stop.toFixed(digits)} / 目標 {rr.target.toFixed(digits)}
      </span>
    </div>
  );
}

export default function TimeframeAnalysis() {
  const [instrument, setInstrument] = useState('XAU_USD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MtfResult | null>(null);
  const [showRrPopup, setShowRrPopup] = useState(false);

  // 分析完了時、RR 1:3 以上の好機があればポップアップを1回開く（新しい分析ごとに再判定）。
  useEffect(() => {
    if (result?.rrOpportunity) setShowRrPopup(true);
  }, [result]);

  const run = async () => {
    if (!MTF_URL) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`${MTF_URL}?instrument=${encodeURIComponent(instrument)}`);
      const body = (await res.json()) as MtfResult | { error: string };
      if ('error' in body) throw new Error(body.error);
      // ゴールドは現物スポット基準に揃える（レジサポページと同様）。
      setResult(instrument === 'XAU_USD' ? await toSpotBasis(body) : body);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const digits = result ? digitsFor(result.instrument) : 5;

  if (!MTF_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        タイムフレーム分析は未設定です。<code>VITE_MTF_URL</code> を設定すると使えます。
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-3 my-2">
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-gray-600">
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
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="h-10 rounded bg-orange-500 px-4 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? '分析中…' : '分析'}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {result && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between rounded-md border border-gray-200 bg-white p-3">
            <div>
              <p className="text-xs text-gray-500">現在レート</p>
              <p className="text-xl font-bold text-gray-800">{result.currentRate.toFixed(digits)}</p>
            </div>
            <span className="rounded-full bg-orange-50 px-2 py-1 text-xs font-semibold text-orange-700">
              {result.alignment}
            </span>
          </div>

          {/* セッション別シナリオ予測 */}
          <SessionOutlookCard outlook={result.sessionOutlook} />

          {/* TF別カード（全幅・縦積み） */}
          <div className="space-y-2">
            {result.timeframes.map((t) => (
              <div key={t.tf} className="rounded-md border border-gray-200 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold">{t.tf}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${TREND_STYLE[t.trend]}`}>
                      {TREND_LABEL[t.trend]}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${PA_STYLE[t.pa]}`}>
                      {PA_LABEL[t.pa]} {t.paPct}%
                    </span>
                    <span className="text-[10px] text-gray-400">確信{Math.round(t.confidence * 100)}%</span>
                  </div>
                </div>

                <BreakoutRow breakout={t.breakout} />
                <RrRow rr={t.rr} digits={digits} />

                <p className="mt-2 text-[10px] text-gray-400">
                  高{t.swingHigh.toFixed(digits)} / 安{t.swingLow.toFixed(digits)}
                </p>
              </div>
            ))}
          </div>

          {result.comment && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
              <p className="mb-1 text-sm font-bold text-gray-700">総合判断（AI）</p>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-700">{result.comment}</p>
            </div>
          )}

          <p className="text-[10px] text-gray-400">
            プライスアクション判定: {result.paEngine === 'jev' ? 'Jev' : 'Workers AI'}
          </p>
          <p className="text-center text-[10px] text-gray-400">
            ※複数時間軸の構造・AIによる推定の参考値です。投資助言ではありません。
          </p>
        </div>
      )}

      {!result && !error && !loading && (
        <p className="mt-3 text-center text-gray-400">ペアを選んで「分析」を押してください。</p>
      )}

      {/* RR 1:3 以上の好機ポップアップ（分析完了時に自動表示） */}
      {showRrPopup && result?.rrOpportunity && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setShowRrPopup(false)}
        >
          <div
            className="w-full max-w-xs rounded-xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-center text-base font-bold text-orange-600">🎯 RR 1:3 以上の好機</p>
            <p className="mt-2 text-center text-sm font-semibold text-gray-800">
              {result.instrument.replace('_', '/')}　<span className="font-mono">{result.rrOpportunity.tf}</span>
              <span className={DIR_STYLE[result.rrOpportunity.direction]}>
                {DIR_LABEL[result.rrOpportunity.direction]}
              </span>
              　1:{result.rrOpportunity.rr.toFixed(1)}
            </p>
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">エントリー</span>
                <span className="font-mono">{result.rrOpportunity.entry.toFixed(digits)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">損切り</span>
                <span className="font-mono text-red-600">
                  {result.rrOpportunity.stop.toFixed(digits)} (-{result.rrOpportunity.riskPips}pips)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">目標</span>
                <span className="font-mono text-green-600">
                  {result.rrOpportunity.target.toFixed(digits)} (+{result.rrOpportunity.rewardPips}pips)
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowRrPopup(false)}
              className="mt-4 w-full rounded bg-orange-500 py-2 text-sm font-medium text-white"
            >
              閉じる
            </button>
            <p className="mt-2 text-center text-[10px] text-gray-400">
              ※上位TFスイングを目標にした構造上の参考値。投資助言ではありません。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
