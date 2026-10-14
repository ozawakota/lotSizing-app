// 4時間足の出来高インジケーター（相対出来高 RVOL・出来高の増減トレンド・OBV の向き）の純粋ロジック。
// FX スポットには取引所の出来高が無いため、CME の通貨先物（6J/6E/6B/6A）と金先物（GC=F）の出来高を使う。
// クロス円（EUR/JPY・GBP/JPY・AUD/JPY）は単独の先物が無く対象外。Worker(/volume) とフロントで共有する。
import type { Candle } from './stoploss';

// 一覧に出すペア → 出来高を取る Yahoo シンボル。invert=true は先物がスポットの逆数クォート（6J=F は JPY/USD）。
// null は出来高データなし（クロス円）。
export const VOLUME_SOURCES: { instrument: string; symbol: string | null; invert: boolean }[] = [
  { instrument: 'USD_JPY', symbol: '6J=F', invert: true },
  { instrument: 'EUR_USD', symbol: '6E=F', invert: false },
  { instrument: 'GBP_USD', symbol: '6B=F', invert: false },
  { instrument: 'AUD_USD', symbol: '6A=F', invert: false },
  { instrument: 'XAU_USD', symbol: 'GC=F', invert: false },
  { instrument: 'EUR_JPY', symbol: null, invert: false },
  { instrument: 'GBP_JPY', symbol: null, invert: false },
  { instrument: 'AUD_JPY', symbol: null, invert: false },
];

export const RVOL_AVG_BARS = 20; // 相対出来高の分母＝直近20本の平均
export const TREND_SHORT_BARS = 5; // 増減トレンド: 直近5本平均 ÷ 直近20本平均
export const OBV_BARS = 10; // OBV の向きを見る本数

export type RvolLevel = 'surge' | 'high' | 'normal' | 'low';
export const RVOL_LABEL: Record<RvolLevel, string> = { surge: '急増', high: '多い', normal: '普通', low: '少ない' };
export type Dir3 = 'up' | 'down' | 'flat';
export type VolumeTrend = 'increasing' | 'decreasing' | 'flat';
export const VOLUME_TREND_LABEL: Record<VolumeTrend, string> = { increasing: '増加', decreasing: '減少', flat: '横ばい' };

export interface VolumeIndicators {
  lastVolume: number; // 最新確定足の出来高
  avgVolume: number; // 直近20本の平均
  rvol: number; // lastVolume ÷ avgVolume（小数2桁）
  rvolLevel: RvolLevel;
  trend: VolumeTrend; // 直近5本平均 ÷ 直近20本平均 で判定
  trendRatio: number;
  obv: Dir3; // OBV（上げた足は+出来高・下げた足は−出来高の累計）の直近10本の向き
  price: Dir3; // 同じ期間の価格（スポット基準）の向き
  divergence: boolean; // OBV と価格の向きが食い違う（動きの裏付けが弱い/転換の兆し）
  barTime: number | null; // 最新確定足の時刻（UNIX秒）
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function rvolLevel(rvol: number): RvolLevel {
  if (rvol >= 1.5) return 'surge';
  if (rvol >= 1.15) return 'high';
  if (rvol >= 0.7) return 'normal';
  return 'low';
}

/**
 * 確定足（古い→新しい）から出来高インジケーターを求める。出来高が無い（0/欠損）足が多ければ null。
 * invert=true（逆数クォートの先物）のときは、価格・OBV の向きをスポット基準に反転する。
 */
export function computeVolumeIndicators(closed: Candle[], invert = false): VolumeIndicators | null {
  const bars = closed.filter((c) => typeof c.volume === 'number' && c.volume > 0);
  if (bars.length < RVOL_AVG_BARS + 1) return null;
  const vols = bars.map((c) => c.volume as number);
  const last = vols[vols.length - 1];
  const avg = mean(vols.slice(-RVOL_AVG_BARS - 1, -1)); // 最新足を除いた直近20本
  if (!(avg > 0)) return null;
  const rvol = last / avg;
  const trendRatio = mean(vols.slice(-TREND_SHORT_BARS)) / mean(vols.slice(-RVOL_AVG_BARS));
  const trend: VolumeTrend = trendRatio >= 1.15 ? 'increasing' : trendRatio <= 0.85 ? 'decreasing' : 'flat';

  // OBV: 終値が上がった足は +出来高、下がった足は −出来高。スポット基準にするため invert で符号反転。
  const sign = invert ? -1 : 1;
  const win = bars.slice(-(OBV_BARS + 1));
  let obvChange = 0;
  for (let i = 1; i < win.length; i++) {
    const d = win[i].close - win[i - 1].close;
    obvChange += Math.sign(d) * sign * (win[i].volume as number);
  }
  const winVol = win.slice(1).reduce((a, c) => a + (c.volume as number), 0);
  const obv: Dir3 = obvChange > winVol * 0.2 ? 'up' : obvChange < -winVol * 0.2 ? 'down' : 'flat';
  const first = win[0].close;
  const lastClose = win[win.length - 1].close;
  const pct = ((lastClose - first) / first) * 100 * sign;
  const price: Dir3 = pct > 0.1 ? 'up' : pct < -0.1 ? 'down' : 'flat';
  const divergence = obv !== 'flat' && price !== 'flat' && obv !== price;

  return {
    lastVolume: last,
    avgVolume: Math.round(avg),
    rvol: round2(rvol),
    rvolLevel: rvolLevel(rvol),
    trend,
    trendRatio: round2(trendRatio),
    obv,
    price,
    divergence,
    barTime: bars[bars.length - 1].t ?? null,
  };
}

export interface PairVolume {
  instrument: string;
  source: string | null; // 出来高の取得元シンボル（null=データなし）
  indicators: VolumeIndicators | null; // 取得失敗・データなしは null
  profile?: VolumeProfile | null; // 価格帯別出来高（現物の目盛りに換算済み）。取得失敗は null
  spotRate?: number | null; // 現在の現物レート（ラインまでの距離表示用）
}

export interface VolumeSnapshot {
  timeframe: '4h';
  pairs: PairVolume[];
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// 価格帯別出来高（ボリュームプロファイル）→ 出来高由来のレジサポ
// ---------------------------------------------------------------------------
// 各足の出来高を、その足の高値〜安値の価格帯に均等に割り振って合計し（足の中の分布は不明なので近似）、
// POC（最多価格）・バリューエリア（出来高の70%が集まる範囲）の上限/下限・HVN（出来高の山）を求める。
// 先物の価格で集計するため、現物の目盛りへは futuresLevelToSpot で換算する（逆数クォートは上下が入れ替わる）。

export const PROFILE_BINS = 40;
export const VALUE_AREA_PCT = 0.7;

export interface VolumeProfile {
  poc: number; // 出来高が最も多い価格帯の中心
  vah: number; // バリューエリア上限
  val: number; // バリューエリア下限
  hvns: number[]; // POC 以外の出来高の山（多い順、最大3）
  binSize: number;
  bars: number; // 集計に使った足の本数
}

/** 足（古い→新しい、出来高つき）から価格帯別出来高を求める。出来高のある足が少なければ null。 */
export function computeVolumeProfile(candles: Candle[], bins = PROFILE_BINS, valueAreaPct = VALUE_AREA_PCT): VolumeProfile | null {
  const bars = candles.filter((c) => typeof c.volume === 'number' && c.volume > 0 && c.high >= c.low);
  if (bars.length < 10) return null;
  const lo = Math.min(...bars.map((c) => c.low));
  const hi = Math.max(...bars.map((c) => c.high));
  if (!(hi > lo)) return null;
  const size = (hi - lo) / bins;
  const vol = new Array<number>(bins).fill(0);
  const idx = (p: number) => Math.min(bins - 1, Math.max(0, Math.floor((p - lo) / size)));
  for (const c of bars) {
    const v = c.volume as number;
    const a = idx(c.low);
    const b = idx(c.high);
    if (a === b || c.high === c.low) {
      vol[a] += v;
      continue;
    }
    // 足の値幅と各価格帯の重なりの長さに比例して割り振る。
    for (let k = a; k <= b; k++) {
      const bLo = lo + k * size;
      const overlap = Math.min(c.high, bLo + size) - Math.max(c.low, bLo);
      if (overlap > 0) vol[k] += (v * overlap) / (c.high - c.low);
    }
  }
  const center = (k: number) => lo + (k + 0.5) * size;
  const total = vol.reduce((s, x) => s + x, 0);
  const pocIdx = vol.indexOf(Math.max(...vol));

  // バリューエリア: POC から、出来高の多い隣の価格帯へ順に広げて合計が70%に達するまで。
  let lIdx = pocIdx;
  let rIdx = pocIdx;
  let acc = vol[pocIdx];
  while (acc < total * valueAreaPct && (lIdx > 0 || rIdx < bins - 1)) {
    const left = lIdx > 0 ? vol[lIdx - 1] : -1;
    const right = rIdx < bins - 1 ? vol[rIdx + 1] : -1;
    if (right >= left) acc += vol[++rIdx];
    else acc += vol[--lIdx];
  }

  // HVN: 両隣より多く、平均の1.2倍以上の価格帯（POC と隣接2本は除く）。
  const mean = total / bins;
  const hvns = vol
    .map((v, k) => ({ v, k }))
    .filter(({ v, k }) => k > 0 && k < bins - 1 && v > vol[k - 1] && v > vol[k + 1] && v >= mean * 1.2 && Math.abs(k - pocIdx) > 2)
    .sort((x, y) => y.v - x.v)
    .slice(0, 3)
    .map(({ k }) => center(k));

  return { poc: center(pocIdx), vah: lo + (rIdx + 1) * size, val: lo + lIdx * size, hvns, binSize: size, bars: bars.length };
}

/** 価格を変換する関数でプロファイルを現物の目盛りに写す（逆数クォートで上下が入れ替わっても vah>val を保つ）。 */
export function mapProfile(p: VolumeProfile, toSpot: (price: number) => number): VolumeProfile {
  const a = toSpot(p.vah);
  const b = toSpot(p.val);
  return {
    ...p,
    poc: toSpot(p.poc),
    vah: Math.max(a, b),
    val: Math.min(a, b),
    hvns: p.hvns.map(toSpot),
    binSize: Math.abs(toSpot(p.poc + p.binSize) - toSpot(p.poc)),
  };
}

/** 損切りライン・パターンの場所判定に渡すライン一覧（ラベル付き）。 */
export function profileLevels(p: VolumeProfile): { price: number; label: string }[] {
  return [
    { price: p.poc, label: '出来高POC' },
    { price: p.vah, label: 'バリューエリア上限' },
    { price: p.val, label: 'バリューエリア下限' },
    ...p.hvns.map((price) => ({ price, label: '出来高の山' })),
  ];
}
