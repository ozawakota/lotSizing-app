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
}

export interface VolumeSnapshot {
  timeframe: '4h';
  pairs: PairVolume[];
  generatedAt: number;
}
