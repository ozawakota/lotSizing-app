// タイムフレーム分析ページ（旧「レジサポ」を統合）。選んだペアを 15m/30m/1h/4h で分析し、
// 各TFを1カードに融合表示する: 結論(反転/ブレイク/PA)＋ダウ理論(スイング図・押し安値/戻り高値)＋
// 抵抗帯のはしご(★・根拠)＋ブレイク確率＋RR＋プライスアクション(ローソク足チャート・パターン)＋そのほかの指標。全TF統合の総合判断・セッション別予測・RR好機も表示。
// Worker(/mtf, VITE_MTF_URL) が Yahoo足＋Jev/Workers AI で算出。ペア選択で自動取得。
// ※参考情報・投資助言ではない。
import { useEffect, useState, type ReactNode } from 'react';
import type {
  BreakoutProb,
  PaClass,
  RoleReversal,
  RrSetup,
  SessionOutlook,
  SessionPrediction,
  SessionScenario,
  SlDirection,
  SlTimeframe,
} from '@/lib/stoploss';
import { RR_MIN, pipSize } from '@/lib/stoploss';
import { MARKET_SESSIONS, isSessionOpen } from '@/lib/session';
import { fetchGoldSpot } from '@/lib/goldSpot';
import { CONFIRMATION_LABEL, priceActionHeadline, type PatternRead, type PriceActionTone } from '@/lib/candleRead';
import type { OhlcCandle } from '@/lib/edge';
import { PriceActionChart } from '@/components/PriceActionChart';
import TfCountdown from '@/components/TfCountdown';
import { DowHeader, KeyLevelRow, SwingChart, ZoneLadder } from '@/components/TfStructure';
import { dowDirection, dowSummary, type DowAnalysis } from '@/lib/dow';
import type { SrZone } from '@/lib/srZones';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';
import type { MaSet } from '@/lib/entrySignal';
import { TIMING_LABEL, assessEntryTiming, type EntryTiming, type TimingVerdict } from '@/lib/entryTiming';

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

// /mtf の1TF分（分析＋レジサポの全フィールドを保持）。
interface MtfTf {
  tf: SlTimeframe;
  trend: 'up' | 'down' | 'range';
  swingHigh: number; // 直近スイング高値＝レジスタンス
  swingLow: number; // 直近スイング安値＝サポート
  pa: PaClass;
  paPct: number;
  confidence: number;
  breakout: BreakoutProb | null;
  rr: RrSetup | null;
  volumeLevel: number | null; // 過去の高出来高の節目（30m/1h=2日前・4h=2週前。無し=null）
  stoch: { k: number; d: number } | null; // ストキャスティクス(%K/%D)。算出不可=null
  roleReversal: RoleReversal | null; // ロールリバーサル・ブレイク信用度（0–100・状態・側）。評価不能=null
  candlePattern: { key: string; label: string; barsAgo: number } | null; // 直近のローソク足パターン(ピンバー/包み足)
  candlePatterns?: PatternRead[]; // 期間内のパターン（新しい順・最大3件、質・場所・確定/否定つき）。旧キャッシュには無い
  dow?: DowAnalysis | null; // ダウ理論（表示用）。旧キャッシュには無い
  zones?: { res: SrZone[]; sup: SrZone[] } | null; // 抵抗帯（表示用）。旧キャッシュには無い
  rsi?: number | null; // RSI(14)。旧キャッシュには無い
  bars?: OhlcCandle[]; // ローソク足チャート用の直近の確定足（古い順。末尾=barsAgo 0）。旧キャッシュには無い
  forming?: OhlcCandle | null; // 形成中の足。旧キャッシュには無い
  ma?: MaSet | null; // 21SMA・75EMA・200EMA。旧キャッシュには無い
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
// 現在レート・スイング高安・出来高節目・RR価格(エントリー/損切/目標)をスポット基準へ平行移動する。
// 構造・pips・確率・ストキャスは差分不変。取得失敗時は GC=F のまま。
async function toSpotBasis(body: MtfResult): Promise<MtfResult> {
  const spot = await fetchGoldSpot();
  if (spot === null || !(body.currentRate > 0)) return body;
  const off = body.currentRate - spot;
  const shiftRr = <T extends RrSetup>(rr: T): T => ({ ...rr, entry: rr.entry - off, stop: rr.stop - off, target: rr.target - off });
  const shiftDow = (d: DowAnalysis): DowAnalysis => ({
    ...d,
    swings: d.swings.map((sw) => ({ ...sw, price: sw.price - off })),
    keyLevel: d.keyLevel ? { ...d.keyLevel, price: d.keyLevel.price - off } : null,
    extremeLevel: d.extremeLevel ? { ...d.extremeLevel, price: d.extremeLevel.price - off } : null,
    rangeHigh: d.rangeHigh == null ? null : d.rangeHigh - off,
    rangeLow: d.rangeLow == null ? null : d.rangeLow - off,
  });
  const shiftZone = (z: SrZone): SrZone => ({ ...z, low: z.low - off, high: z.high - off, center: z.center - off });
  const shiftMa = (m: MaSet): MaSet => ({
    sma21: m.sma21 == null ? null : m.sma21 - off,
    ema75: m.ema75 == null ? null : m.ema75 - off,
    ema200: m.ema200 == null ? null : m.ema200 - off,
  });
  const shiftBar = (b: OhlcCandle): OhlcCandle => ({ ...b, open: b.open - off, high: b.high - off, low: b.low - off, close: b.close - off });
  return {
    ...body,
    currentRate: spot,
    timeframes: body.timeframes.map((t) => ({
      ...t,
      swingHigh: t.swingHigh - off,
      swingLow: t.swingLow - off,
      rr: t.rr ? shiftRr(t.rr) : null,
      volumeLevel: t.volumeLevel == null ? null : t.volumeLevel - off,
      roleReversal:
        t.roleReversal && typeof t.roleReversal.level === 'number'
          ? { ...t.roleReversal, level: t.roleReversal.level - off }
          : t.roleReversal,
      dow: t.dow ? shiftDow(t.dow) : t.dow,
      zones: t.zones ? { res: t.zones.res.map(shiftZone), sup: t.zones.sup.map(shiftZone) } : t.zones,
      bars: t.bars?.map(shiftBar),
      forming: t.forming ? shiftBar(t.forming) : t.forming,
      ma: t.ma ? shiftMa(t.ma) : t.ma,
    })),
    rrOpportunity: body.rrOpportunity ? shiftRr(body.rrOpportunity) : null,
  };
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
function verdict(tf: MtfTf): { label: string; cls: string } {
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

// レンジブレイク確率（上抜け/下抜け/継続）を数値＋3色セグメントバー＋優勢ラベルで表示。
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

// 上位TFスイングを目標にした RR 評価の1行（方向はトレンド、スプレッド込み）。狙える(qualifies)ときはオレンジ＋✓で強調。
// 損切りラインの根拠（構造的損切り）。強さで色分け: 60以上=緑 / 40以上=アンバー / それ未満=グレー。
function StopBasis({ rr }: { rr: RrSetup }) {
  if (!rr.stopReasons?.length) return null;
  const s = rr.stopStrength ?? 0;
  const cls = s >= 60 ? 'text-green-700' : s >= 40 ? 'text-amber-600' : 'text-gray-500';
  return (
    <p className="mt-0.5 text-[10px] text-gray-500">
      損切根拠: {rr.stopReasons.join('・')}
      <span className={`ml-1 font-semibold ${cls}`}>強さ{s}</span>
    </p>
  );
}

// RR の方向はダウ理論（上昇=ロング・下降=ショート）。レンジ・転換の兆しのときは RR を出さない。
function RrRow({ rr, digits, dow }: { rr: RrSetup | null; digits: number; dow?: DowAnalysis | null }) {
  if (!rr) {
    const noTrend = !!dow && dowDirection(dow) === null;
    return (
      <p className="mt-1 text-[10px] text-gray-400">
        RR{'　'}
        {noTrend ? `ダウ理論で${dow?.phase === 'broken' ? '転換の兆し' : 'レンジ'}のため対象外 —` : '上位TF目標なし —'}
      </p>
    );
  }
  const ok = rr.qualifies;
  return (
    <div className="mt-1">
    <div className="flex items-center justify-between text-[11px]">
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
    <StopBasis rr={rr} />
    {rr.patternNote && (
      <p className={`mt-0.5 text-[10px] ${rr.patternSupport === 'aligned' ? 'text-green-700' : 'text-gray-500'}`}>
        {rr.patternSupport === 'aligned' ? '◎ ' : '× '}
        {rr.patternNote}
      </p>
    )}
    </div>
  );
}

// エントリーのタイミング（高値掴み・安値売りの回避）。RR の方向（無ければダウ理論の向き）で、
// いま成行で入ってよいかを判定する。足・方向が無ければ null。
function tfTiming(tf: MtfTf, instrument: string, currentRate: number): { dir: SlDirection; t: EntryTiming } | null {
  const dir = tf.rr?.direction ?? (tf.dow ? dowDirection(tf.dow) : null);
  if (!dir || !tf.bars) return null;
  const t = assessEntryTiming({
    direction: dir,
    price: currentRate,
    instrument,
    bars: tf.bars,
    dow: tf.dow ?? null,
    zones: tf.zones,
    rsi: tf.rsi,
    stochK: tf.stoch?.k ?? null,
    rr: tf.rr && tf.rr.direction === dir ? { stop: tf.rr.stop, target: tf.rr.target, spreadPips: tf.rr.spreadPips } : null,
    ma: tf.ma,
  });
  return t ? { dir, t } : null;
}

const TIMING_STYLE: Record<TimingVerdict, { chip: string; box: string; icon: string }> = {
  ok: { chip: 'bg-green-100 text-green-700', box: 'border-green-200 bg-green-50', icon: '🟢' },
  wait: { chip: 'bg-amber-100 text-amber-700', box: 'border-amber-200 bg-amber-50', icon: '🟡' },
  avoid: { chip: 'bg-red-100 text-red-700', box: 'border-red-200 bg-red-50', icon: '🔴' },
};

function TimingChip({ dir, t }: { dir: SlDirection; t: EntryTiming }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${TIMING_STYLE[t.verdict].chip}`}>
      {TIMING_LABEL[t.verdict][dir]}
    </span>
  );
}

// 移動平均と現在値の位置（ATR 倍）。順方向の側にあれば緑、逆側なら赤、21SMA から離れすぎ（>0.8 ATR）ならアンバー。
function MaLine({ mas, long, digits }: { mas: EntryTiming['mas']; long: boolean; digits: number }) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-500">
      {mas.map((m) => {
        const along = long ? m.atrFromPrice : -m.atrFromPrice; // 順方向の側なら +
        const cls = along < 0 ? 'text-red-600' : m.key === 'sma21' && along > 0.8 ? 'text-amber-700' : 'text-green-700';
        return (
          <span key={m.key} className="whitespace-nowrap">
            {m.label} <span className="font-mono text-gray-700">{m.price.toFixed(digits)}</span>{' '}
            <span className={`font-semibold ${cls}`}>
              （{m.atrFromPrice >= 0 ? '上' : '下'} {Math.abs(m.atrFromPrice).toFixed(1)} ATR）
            </span>
          </span>
        );
      })}
    </div>
  );
}

// 成行で入ってよいか（入りどき / 押し目待ち・戻り待ち / 高値掴み注意・安値売り注意）＋理由＋指値の目安。
function EntryTimingRow({ dir, t, digits }: { dir: SlDirection; t: EntryTiming; digits: number }) {
  const st = TIMING_STYLE[t.verdict];
  const long = dir === 'long';
  return (
    <div className={`mt-2 rounded-lg border px-2.5 py-2 text-[11px] ${st.box}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className="text-gray-500">{long ? '買い' : '売り'}の入りどき</span>
          <TimingChip dir={dir} t={t} />
        </span>
        <span className="text-[10px] text-gray-400">{st.icon} 成行の判定</span>
      </div>
      {t.mas.length > 0 && <MaLine mas={t.mas} long={long} digits={digits} />}
      {t.verdict === 'ok' ? (
        <div className="mt-1 text-[10px] text-gray-600">
          {long ? '支えに近く、伸び切っていない位置です。' : '抑えに近く、売られ切っていない位置です。'}
          {t.reasons.length > 0 && `（気になる点: ${t.reasons.map((r) => r.label).join('・')}）`}
        </div>
      ) : (
        <>
          <ul className="mt-1 space-y-0.5 text-[10px] text-gray-700" style={LIST_RESET}>
            {t.reasons.map((r) => (
              <li style={LIST_ITEM_RESET} key={r.label} className="flex items-start gap-1">
                <span aria-hidden className="text-gray-400">・</span>
                <span>{r.label}</span>
              </li>
            ))}
          </ul>
          {t.limit ? (
            <div className="mt-1.5 rounded bg-white/70 px-2 py-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-500">{long ? '押し目' : '戻り'}の指値の目安</span>
                <span className="font-mono font-bold text-gray-900">{t.limit.price.toFixed(digits)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-2 text-[10px] text-gray-500">
                <span>
                  {t.limit.basis}・現在値から{long ? '−' : '+'}
                  {t.limit.distancePips.toFixed(1)}pips
                </span>
                {t.limit.rr != null && (
                  <span className={t.limit.rr >= RR_MIN ? 'font-bold text-orange-600' : ''}>その価格なら RR 1:{t.limit.rr.toFixed(1)}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-gray-500">
              {long ? '押し目' : '戻り'}の目安が見当たらないため、次の足の確定を待つのが無難です。
            </div>
          )}
          <div className="mt-1 text-[10px] text-gray-500">
            {t.verdict === 'avoid'
              ? `いま成行で${long ? '買う' : '売る'}と${long ? '高値掴み' : '安値売り'}になりやすい位置です。`
              : `成行より、${long ? '押し目' : '戻り'}を待った方が有利です。`}
          </div>
        </>
      )}
    </div>
  );
}

// ローソク足パターンの一覧（期間内・新しい順）。1行 = パターン名・何本前・確定/否定・形の質・出た場所。
const CONF_STYLE: Record<PatternRead['confirmation'], string> = {
  confirmed: 'bg-blue-50 text-blue-700',
  pending: 'bg-gray-100 text-gray-500',
  invalidated: 'bg-gray-100 text-gray-400 line-through',
};
const PATTERN_PERIOD_LABEL: Record<SlTimeframe, string> = { '15m': '6時間', '30m': '12時間', '1h': '1日', '4h': '3日' };
function PatternList({ reads, tf }: { reads: PatternRead[]; tf: SlTimeframe }) {
  return (
    <div className="mt-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-gray-500">ローソク足</span>
        <span className="text-[10px] text-gray-400">直近{PATTERN_PERIOD_LABEL[tf]}</span>
      </div>
      {reads.length === 0 ? (
        <p className="mt-0.5 text-[10px] text-gray-400">パターンなし</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5" style={LIST_RESET}>
          {reads.map((r, idx) => (
            <li style={LIST_ITEM_RESET} key={`${r.key}-${r.barsAgo}-${idx}`} className="flex flex-wrap items-center gap-x-1.5">
              <span className={`font-semibold ${r.key.startsWith('bull') ? 'text-green-700' : 'text-red-700'}`}>{r.label}</span>
              <span className="text-[10px] text-gray-400">{r.barsAgo === 0 ? '確定足' : `${r.barsAgo}本前`}</span>
              <span className={`rounded px-1 text-[10px] ${CONF_STYLE[r.confirmation]}`}>{CONFIRMATION_LABEL[r.confirmation]}</span>
              <span className={`text-[10px] ${r.quality >= 70 ? 'font-semibold text-gray-800' : 'text-gray-500'}`}>質{r.quality}</span>
              <span className={`text-[10px] ${r.zone === 'key' ? 'text-orange-600' : 'text-gray-400'}`}>
                {r.zone === 'key' ? `@${r.zoneReasons.join('・')}` : 'ライン外'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ロールリバーサル・ブレイク信用度（0–100）の1行。側（レジ上抜け=緑/サポ下抜け=赤）＋状態＋バー。
const RR_STATE_LABEL: Record<RoleReversal['state'], string> = {
  none: '未ブレイク',
  broken: 'ブレイク直後',
  retest: 'リテスト中',
  confirmed: '転換確認',
};
// ロールリバーサルの評価ライン。価格と現在値からの距離（上=+ / 下=−）を表示する。
// level は旧キャッシュ（価格を持たない応答）では欠けるので、その場合は行ごと省く。
function RoleReversalRow({
  rr,
  instrument,
  currentRate,
  digits,
}: {
  rr: RoleReversal;
  instrument: string;
  currentRate: number;
  digits: number;
}) {
  const up = rr.side === 'resistance'; // レジ上抜け＝強気（緑）/ サポ下抜け＝弱気（赤）
  const hasLevel = typeof rr.level === 'number' && Number.isFinite(rr.level);
  const distPips = hasLevel ? (rr.level - currentRate) / pipSize(instrument) : 0;
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-gray-500">ロールリバーサル</span>
        <span className="flex items-center gap-1.5 font-semibold">
          <span className={up ? 'text-green-700' : 'text-red-700'}>{up ? 'レジ上抜け' : 'サポ下抜け'}</span>
          <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-500">{RR_STATE_LABEL[rr.state]}</span>
          <span className="tabular-nums text-gray-700">信用度 {rr.score}</span>
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div className={up ? 'bg-green-500' : 'bg-red-500'} style={{ width: `${rr.score}%`, height: '100%' }} />
      </div>
      {hasLevel && (
        <div className="mt-1 flex items-center justify-between text-[11px]">
          <span className="text-gray-500">ライン</span>
          <span className="tabular-nums">
            <span className="font-semibold text-gray-800">{rr.level.toFixed(digits)}</span>
            <span className="ml-1.5 text-gray-400">
              {distPips >= 0 ? '+' : '−'}
              {Math.abs(distPips).toFixed(1)}pips
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

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

// カード内の小見出し。
function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 mt-3 text-[11px] font-semibold text-gray-500">{children}</p>;
}

// 1TFの融合カード:
//   見出し（時間足・確定カウントダウン・結論チップ）→ ダウ理論（トレンド・局面・強さ・スイング図・押し安値/戻り高値）
//   → 抵抗帯のはしご（★・幅・距離・根拠）→ ブレイク確率・RR → プライスアクション（ローソク足チャート・パターンの一覧）
//   → 「そのほかの指標」（ロールリバーサル・ストキャス・出来高。旧キャッシュではパターンもここ）。
// 旧キャッシュ（dow/zones が無い）では、従来のトレンドチップとスイング高安の2本線で表示する。
function TfCard({ tf, instrument, currentRate, digits }: { tf: MtfTf; instrument: string; currentRate: number; digits: number }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const pip = pipSize(instrument);
  const resDist = Math.abs(tf.swingHigh - currentRate) / pip;
  const supDist = Math.abs(currentRate - tf.swingLow) / pip;
  const v = verdict(tf);
  const timing = tfTiming(tf, instrument, currentRate);
  const stochLabel = !tf.stoch ? null : tf.stoch.k >= 80 ? '買われすぎ' : tf.stoch.k <= 20 ? '売られすぎ' : '中立';
  const stochCls = !tf.stoch
    ? ''
    : tf.stoch.k >= 80
      ? 'text-red-600'
      : tf.stoch.k <= 20
        ? 'text-green-600'
        : 'text-gray-500';
  const hasZones = !!tf.zones && (tf.zones.res.length > 0 || tf.zones.sup.length > 0);
  // ローソク足チャートが描けるときは、パターンはチャートの下に出すので「そのほかの指標」からは外す。
  const hasChart = !!tf.bars && tf.bars.length >= 2 && !!tf.candlePatterns;
  const extraCount =
    (tf.roleReversal ? 1 : 0) +
    (hasChart ? 0 : tf.candlePatterns ? tf.candlePatterns.length : tf.candlePattern ? 1 : 0) +
    (tf.stoch || tf.rsi != null ? 1 : 0) +
    (tf.volumeLevel != null ? 1 : 0);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      {/* 見出し: 時間足 ＋ 確定カウントダウン ／ 結論チップ ＋ 確信% */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-gray-800">{TF_LABEL[tf.tf]}</p>
          {!tf.dow && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${TREND_STYLE[tf.trend]}`}>{TREND_LABEL[tf.trend]}</span>
          )}
          <TfCountdown tf={tf.tf} />
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${v.cls}`}>{v.label}</span>
          <span className="text-[10px] text-gray-400">確信{Math.round(tf.confidence * 100)}%</span>
        </div>
      </div>

      {/* ダウ理論: トレンド・局面・強さ → スイング図 → 押し安値/戻り高値 */}
      {tf.dow && (
        <div className="mb-2 rounded-lg bg-gray-50 px-2 py-1.5">
          <DowHeader dow={tf.dow} />
          <SwingChart dow={tf.dow} currentRate={currentRate} digits={digits} />
          <KeyLevelRow dow={tf.dow} currentRate={currentRate} pip={pip} digits={digits} />
        </div>
      )}

      {/* 抵抗帯のはしご（新）。無ければ従来のレジ → 現在 → サポ */}
      <SectionLabel>抵抗帯（★が多いほど強い）</SectionLabel>
      {hasZones && tf.zones ? (
        <ZoneLadder res={tf.zones.res} sup={tf.zones.sup} currentRate={currentRate} digits={digits} />
      ) : (
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-2 border-y border-gray-100 py-2">
          <LevelLine side="res" price={tf.swingHigh} distancePips={resDist} digits={digits} />

          <span className="text-sm font-medium text-gray-500">現在</span>
          <span className="text-right text-xl font-bold tabular-nums text-gray-900">{currentRate.toFixed(digits)}</span>
          <span />

          <LevelLine side="sup" price={tf.swingLow} distancePips={supDist} digits={digits} />
        </div>
      )}

      {/* ブレイク確率バー ＋ RR（判断に直結するので常に表示） */}
      <SectionLabel>ブレイク確率・RR</SectionLabel>
      <BreakoutRow breakout={tf.breakout} />
      <RrRow rr={tf.rr} digits={digits} dow={tf.dow} />
      {timing && <EntryTimingRow dir={timing.dir} t={timing.t} digits={digits} />}

      {/* プライスアクション: ローソク足チャート（パターンの位置・確定/否定ライン・抵抗帯）＋パターンの一覧 */}
      {hasChart && tf.bars && tf.candlePatterns && (
        <PriceActionChart
          bars={tf.bars}
          forming={tf.forming ?? null}
          reads={tf.candlePatterns}
          zones={tf.zones}
          currentRate={currentRate}
          digits={digits}
          periodLabel={`直近${PATTERN_PERIOD_LABEL[tf.tf]}`}
        />
      )}

      {/* そのほかの指標（ロールリバーサル・ローソク足パターン・ストキャス・出来高節目）は折りたたみ */}
      {extraCount > 0 && (
        <div className="mt-2 border-t border-gray-100 pt-1.5">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            className="flex w-full items-center justify-between text-[11px] text-gray-500"
          >
            <span>
              そのほかの指標 <span className="text-gray-400">（{extraCount}）</span>
            </span>
            <span className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`} aria-hidden="true">
              ▾
            </span>
          </button>
          {moreOpen && (
            <>
              {tf.roleReversal && (
                <RoleReversalRow rr={tf.roleReversal} instrument={instrument} currentRate={currentRate} digits={digits} />
              )}
              {hasChart ? null : tf.candlePatterns ? (
                <PatternList reads={tf.candlePatterns} tf={tf.tf} />
              ) : (
                tf.candlePattern && (
                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="text-gray-500">ローソク足</span>
                    <span className="flex items-center gap-1.5 font-semibold">
                      <span className={tf.candlePattern.key.startsWith('bull') ? 'text-green-700' : 'text-red-700'}>
                        {tf.candlePattern.label}
                      </span>
                      <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-500">
                        {tf.candlePattern.barsAgo === 0 ? '確定足' : `${tf.candlePattern.barsAgo}本前`}
                      </span>
                    </span>
                  </div>
                )
              )}
              {(tf.stoch || tf.rsi != null || tf.volumeLevel != null) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
                  {tf.stoch && (
                    <span>
                      ストキャス{' '}
                      <span className="font-semibold tabular-nums text-gray-700">
                        {tf.stoch.k.toFixed(0)}/{tf.stoch.d.toFixed(0)}
                      </span>{' '}
                      <span className={`font-semibold ${stochCls}`}>{stochLabel}</span>
                    </span>
                  )}
                  {tf.rsi != null && (
                    <span>
                      RSI <span className="font-semibold tabular-nums text-gray-700">{tf.rsi.toFixed(0)}</span>{' '}
                      <span
                        className={`font-semibold ${tf.rsi >= 70 ? 'text-red-600' : tf.rsi <= 30 ? 'text-green-600' : 'text-gray-500'}`}
                      >
                        {tf.rsi >= 70 ? '買われすぎ' : tf.rsi <= 30 ? '売られすぎ' : '中立'}
                      </span>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

// 全時間足のまとめ（1行=1時間足）。ダウの向き・局面／結論チップ／プライスアクションの一言／RR を並べ、
// 行を押すとその時間足のタブに切り替わる。
const TONE_DOT: Record<PriceActionTone, string> = { bull: 'bg-green-500', bear: 'bg-red-500', neutral: 'bg-gray-300' };
function MtfOverview({
  timeframes,
  selected,
  onSelect,
  instrument,
  currentRate,
}: {
  timeframes: MtfTf[];
  selected: SlTimeframe;
  onSelect: (tf: SlTimeframe) => void;
  instrument: string;
  currentRate: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-3 py-2 text-xs font-bold text-gray-700">全時間足のまとめ</div>
      <ul style={LIST_RESET}>
        {timeframes.map((t) => {
          const v = verdict(t);
          const trend = t.dow?.trend ?? t.trend;
          const pa = t.candlePatterns ? priceActionHeadline(t.candlePatterns) : null;
          const on = t.tf === selected;
          const timing = tfTiming(t, instrument, currentRate);
          return (
            <li style={LIST_ITEM_RESET} key={t.tf} className="border-b border-gray-50 last:border-b-0">
              {/* 余白とレイアウトは内側の要素に付ける（ボタン要素に付けると Mobiscroll のボタン用 CSS に打ち消されることがある） */}
              <button
                type="button"
                onClick={() => onSelect(t.tf)}
                aria-pressed={on}
                className={`block w-full text-left ${on ? 'bg-orange-50' : 'active:bg-gray-50'}`}
              >
                <span className="grid grid-cols-[3.2rem_1fr_auto] items-center gap-2 px-3 py-2">
                <span className={`text-xs font-bold ${on ? 'text-orange-700' : 'text-gray-700'}`}>{TF_LABEL[t.tf].replace('足', '')}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${TREND_STYLE[trend]}`}>{TREND_LABEL[trend]}</span>
                    {t.dow && t.dow.trend !== 'range' && (
                      <span className="truncate text-[10px] text-gray-500">{dowSummary(t.dow).replace(/^(上昇|下降)・/, '')}</span>
                    )}
                  </span>
                  {pa && (
                    <span className="mt-0.5 flex items-center gap-1 text-[10px] text-gray-500">
                      <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[pa.tone]}`} />
                      <span className="truncate">{pa.text}</span>
                    </span>
                  )}
                </span>
                <span className="flex flex-col items-end gap-0.5">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${v.cls}`}>{v.label}</span>
                  {t.rr?.qualifies ? (
                    <span className={`text-[10px] font-bold ${DIR_STYLE[t.rr.direction]}`}>
                      {DIR_LABEL[t.rr.direction]} RR 1:{t.rr.rr.toFixed(1)} ✓
                    </span>
                  ) : (
                    <span className="text-[10px] text-gray-300">RR —</span>
                  )}
                  {timing && timing.t.verdict !== 'ok' && <TimingChip dir={timing.dir} t={timing.t} />}
                </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// 総合判断（AI）。長いときは3行で畳み、「続きを読む」で全文。
function CommentCard({ comment }: { comment: string }) {
  const [open, setOpen] = useState(false);
  const long = comment.length > 90;
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <p className="mb-1 text-xs font-bold text-gray-700">総合判断（AI）</p>
      <p className={`whitespace-pre-wrap text-xs leading-relaxed text-gray-700 ${long && !open ? 'line-clamp-3' : ''}`}>{comment}</p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-[11px] text-orange-600">
          {open ? '閉じる' : '続きを読む'}
        </button>
      )}
    </div>
  );
}

export default function TimeframeAnalysis() {
  const [instrument, setInstrument] = useState('XAU_USD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MtfResult | null>(null);
  const [showRrPopup, setShowRrPopup] = useState(false);
  const [tfSel, setTfSel] = useState<SlTimeframe | null>(null); // 表示する時間足（null=自動: RR好機の足→1時間足→先頭）

  // ペア選択で自動取得（マウント時も既定ペアを取得）。
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
        // ゴールドは現物スポット基準に揃える。
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

  // 分析完了時、RR 好機（RR_MIN 以上・トレンド方向）があればポップアップを1回開く（新しい分析ごとに再判定）。
  // 表示する時間足は新しい分析ごとに自動選択に戻す。
  useEffect(() => {
    if (result?.rrOpportunity) setShowRrPopup(true);
    setTfSel(null);
  }, [result]);

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
      {/* ペア選択 ＋ 現在レート・時間足のそろい具合・更新時刻 */}
      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <select
          aria-label="通貨ペア"
          className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm font-semibold"
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
        >
          {PAIRS.map((p) => (
            <option key={p.instrument} value={p.instrument}>{p.label}</option>
          ))}
        </select>
        {result ? (
          <>
            <p className="text-xl font-bold tabular-nums text-gray-900">{result.currentRate.toFixed(digits)}</p>
            <div className="ml-auto flex flex-col items-end gap-0.5">
              <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">{result.alignment}</span>
              <span className="text-[10px] text-gray-400">
                {new Date(result.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新
              </span>
            </div>
          </>
        ) : (
          <span className="ml-auto text-xs text-gray-400">{loading ? '分析中…' : ''}</span>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {result && (() => {
        const tfs = result.timeframes;
        const autoTf =
          tfs.find((t) => t.tf === result.rrOpportunity?.tf)?.tf ?? tfs.find((t) => t.tf === '1h')?.tf ?? tfs[0]?.tf ?? '1h';
        const current = tfs.find((t) => t.tf === (tfSel ?? autoTf)) ?? tfs[0];
        return (
          <div className="mt-3 space-y-3">
            {/* 全時間足のまとめ（行を押すと下のタブが切り替わる） */}
            <MtfOverview
              timeframes={tfs}
              selected={current?.tf ?? autoTf}
              onSelect={setTfSel}
              instrument={result.instrument}
              currentRate={result.currentRate}
            />

            {result.comment && <CommentCard comment={result.comment} />}

            {/* 時間足のタブ ＋ 選んだ時間足の詳細カード */}
            {current && (
              <div>
                <div role="tablist" aria-label="時間足" className="mb-2 flex rounded-lg bg-gray-100 p-0.5">
                  {tfs.map((t) => (
                    <button
                      key={t.tf}
                      type="button"
                      role="tab"
                      aria-selected={t.tf === current.tf}
                      onClick={() => setTfSel(t.tf)}
                      className={`flex-1 rounded-md py-1.5 text-xs font-medium ${
                        t.tf === current.tf ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                      }`}
                    >
                      {TF_LABEL[t.tf]}
                      {t.rr?.qualifies && <span className="ml-0.5 text-orange-500">●</span>}
                    </button>
                  ))}
                </div>
                <TfCard key={current.tf} tf={current} instrument={result.instrument} currentRate={result.currentRate} digits={digits} />
              </div>
            )}

            {/* セッション別シナリオ予測 */}
            <SessionOutlookCard outlook={result.sessionOutlook} />

            <p className="text-center text-[10px] leading-relaxed text-gray-400">
              プライスアクション判定: {result.paEngine === 'jev' ? 'Jev' : 'Workers AI'}／
              レジサポは直近スイング高安、トレンド/ブレイク/反転・RRは複数時間軸の構造＋AI推定の参考値です。投資助言ではありません。
            </p>
          </div>
        );
      })()}

      {!result && !error && !loading && (
        <p className="mt-3 text-center text-gray-400">ペアを選ぶと自動で分析します。</p>
      )}

      {/* RR 好機ポップアップ（分析完了時に自動表示） */}
      {showRrPopup && result?.rrOpportunity && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setShowRrPopup(false)}
        >
          <div
            className="w-full max-w-xs rounded-xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-center text-base font-bold text-orange-600">🎯 RR 1:{RR_MIN} 以上の好機</p>
            <p className="mt-2 text-center text-sm font-semibold text-gray-800">
              {result.instrument.replace('_', '/')}{'　'}<span className="font-mono">{result.rrOpportunity.tf}</span>
              <span className={DIR_STYLE[result.rrOpportunity.direction]}>
                {DIR_LABEL[result.rrOpportunity.direction]}
              </span>
              {'　'}1:{result.rrOpportunity.rr.toFixed(1)}
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
              <StopBasis rr={result.rrOpportunity} />
              <div className="flex justify-between">
                <span className="text-gray-500">目標</span>
                <span className="font-mono text-green-600">
                  {result.rrOpportunity.target.toFixed(digits)} (+{result.rrOpportunity.rewardPips}pips)
                </span>
              </div>
            </div>
            {(() => {
              const opp = result.timeframes.find((t) => t.tf === result.rrOpportunity?.tf);
              const timing = opp ? tfTiming(opp, result.instrument, result.currentRate) : null;
              return timing ? <EntryTimingRow dir={timing.dir} t={timing.t} digits={digits} /> : null;
            })()}
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
