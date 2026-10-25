// 抵抗帯（レジスタンス/サポートの「帯」）を求める純関数。Worker の /mtf と TF分析ページで共有する。
// 1本のラインではなく、近い価格に集まった根拠をまとめて「帯」にし、強さを★1〜3で付ける。
// 根拠: 確定足のスイング高安（何度も止められた価格ほど強い）・キリ番・上位足の高安・出来高の節目・
//       ロールリバーサルのライン・ダウ理論の押し安値/戻り高値。
// 帯の幅は ATR を基準にまとめ（既定 0.35 ATR 以内を同じ帯）、現在値から maxAtr 以内の帯だけを返す。
import { averageTrueRange, pipSize, pivotIndices, roundStep, type Candle } from './stoploss';

export type LevelKind = 'swing' | 'round' | 'higher_tf' | 'volume' | 'role_reversal' | 'dow';

export interface LevelSource {
  price: number;
  kind: LevelKind;
  label: string; // 例: 「4時間足の高値」「出来高POC」「押し安値」
}

export interface SrZone {
  low: number;
  high: number;
  center: number;
  side: 'res' | 'sup'; // 現在値より上=レジスタンス / 下=サポート
  contains: boolean; // 現在値が帯の中にある
  stars: 1 | 2 | 3;
  score: number;
  swingTouches: number; // 帯の中で反転したスイングの数
  lastTouchBarsAgo: number | null; // 最後にスイングが付いたのは何本前か（スイング無しは null）
  sources: string[]; // 根拠のラベル（重複なし。例: 「スイング×3」「キリ番」「4時間足の高値」）
  distancePips: number; // 現在値から帯の近い端までの距離（帯の中なら 0）
}

export interface SrZoneOptions {
  instrument: string;
  extra?: LevelSource[]; // 上位足・出来高・ロールリバーサル・ダウ理論などの外部のライン
  lookback?: number; // スイングを探す確定足の本数（既定 150）
  pivotK?: number; // ピボットの左右の本数（既定 2）
  tolAtr?: number; // 同じ帯にまとめる距離（ATR 倍。既定 0.35）
  maxAtr?: number; // 現在値からこの ATR 倍より遠い帯は返さない（既定 6）
  maxPerSide?: number; // 片側あたりの最大件数（既定 3）
}

// 根拠の種類ごとの重み（スイングは1回ごとに加算）。
const WEIGHT: Record<LevelKind, number> = { swing: 1, round: 0.5, higher_tf: 1.5, volume: 1, role_reversal: 1.5, dow: 1 };
const RECENT_BARS = 30; // この本数以内にスイングが付いた帯は加点
const MIN_SCORE = 2; // 表示する帯の最低スコア（スイング2回、またはスイング＋上位足・出来高・押し安値などの根拠）

/** 帯の強さ（スコア）を★に変換する。 */
export function starsFor(score: number): 1 | 2 | 3 {
  if (score >= 4) return 3;
  if (score >= 2.5) return 2;
  return 1;
}

/** 現在値 currentRate の上下にある抵抗帯（近い順）を求める。足が足りない・ATR が 0 なら空。 */
export function buildSrZones(closed: Candle[], currentRate: number, opts: SrZoneOptions): { res: SrZone[]; sup: SrZone[]; atr: number } {
  const o = { lookback: 150, pivotK: 2, tolAtr: 0.35, maxAtr: 6, maxPerSide: 3, extra: [], ...opts };
  const candles = closed.slice(-o.lookback);
  const atr = averageTrueRange(candles);
  if (candles.length < o.pivotK * 2 + 3 || !(atr > 0)) return { res: [], sup: [], atr };
  const pip = pipSize(o.instrument);
  const lastIdx = candles.length - 1;
  const span = atr * o.maxAtr;

  // 1) 根拠を集める。スイングは何本前かも持つ。
  type Pt = LevelSource & { barsAgo?: number };
  const pts: Pt[] = [
    ...pivotIndices(candles, 'high', o.pivotK).map((i) => ({ price: candles[i].high, kind: 'swing' as const, label: 'スイング', barsAgo: lastIdx - i })),
    ...pivotIndices(candles, 'low', o.pivotK).map((i) => ({ price: candles[i].low, kind: 'swing' as const, label: 'スイング', barsAgo: lastIdx - i })),
    ...o.extra,
  ];
  const step = roundStep(o.instrument);
  for (let r = Math.ceil((currentRate - span) / step) * step; r <= currentRate + span; r += step) {
    pts.push({ price: Number(r.toFixed(6)), kind: 'round', label: 'キリ番' });
  }
  const near = pts.filter((p) => Number.isFinite(p.price) && Math.abs(p.price - currentRate) <= span).sort((a, b) => a.price - b.price);

  // 2) 近い価格を帯にまとめる（直前の点から tol 以内なら同じ帯。ただし帯の幅は tol の2倍まで）。
  const tol = atr * o.tolAtr;
  const clusters: Pt[][] = [];
  for (const p of near) {
    const cur = clusters[clusters.length - 1];
    if (cur && p.price - cur[cur.length - 1].price <= tol && p.price - cur[0].price <= tol * 2) cur.push(p);
    else clusters.push([p]);
  }

  // 3) 帯ごとに強さを付ける。キリ番だけの帯は根拠が弱いので捨てる。
  const minHalf = atr * 0.05; // 1点だけの帯にも最低限の幅を持たせる
  const zones: SrZone[] = [];
  for (const c of clusters) {
    if (c.every((p) => p.kind === 'round')) continue;
    const swings = c.filter((p) => p.kind === 'swing');
    const lastTouch = swings.length ? Math.min(...swings.map((p) => p.barsAgo ?? Infinity)) : null;
    // 同じ種類・同じラベルの外部ラインは1回だけ数える。
    const seen = new Set<string>();
    let score = swings.length * WEIGHT.swing;
    for (const p of c) {
      if (p.kind === 'swing') continue;
      const key = `${p.kind}:${p.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      score += WEIGHT[p.kind];
    }
    if (lastTouch != null && lastTouch <= RECENT_BARS) score += 0.5;

    let low = Math.min(...c.map((p) => p.price));
    let high = Math.max(...c.map((p) => p.price));
    if (high - low < minHalf * 2) {
      const mid = (low + high) / 2;
      low = mid - minHalf;
      high = mid + minHalf;
    }
    const center = (low + high) / 2;
    const contains = currentRate >= low && currentRate <= high;
    const distance = contains ? 0 : center > currentRate ? low - currentRate : currentRate - high;
    const labels = [
      ...(swings.length ? [swings.length > 1 ? `スイング×${swings.length}` : 'スイング'] : []),
      ...[...new Set(c.filter((p) => p.kind !== 'swing').map((p) => p.label))],
    ];
    zones.push({
      low,
      high,
      center,
      side: center >= currentRate ? 'res' : 'sup',
      contains,
      stars: starsFor(score),
      score: Math.round(score * 10) / 10,
      swingTouches: swings.length,
      lastTouchBarsAgo: lastTouch === Infinity ? null : lastTouch,
      sources: labels,
      distancePips: Math.round((distance / pip) * 10) / 10,
    });
  }

  // 根拠が1つだけ（スイング1回だけ等）の帯はノイズになりやすいので、根拠が2つ以上（スコア MIN_SCORE 以上）の帯を優先する。
  // その側に1つも無いときだけ、最も近い帯を1つ残す（「近くに帯なし」にならないように）。
  const pick = (side: 'res' | 'sup') => {
    const sorted = zones.filter((z) => z.side === side).sort((a, b) => a.distancePips - b.distancePips);
    const strong = sorted.filter((z) => z.score >= MIN_SCORE);
    return (strong.length ? strong : sorted.slice(0, 1)).slice(0, o.maxPerSide);
  };
  return { res: pick('res'), sup: pick('sup'), atr };
}
