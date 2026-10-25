// プライスアクションの「スマートマネー」系の読み（SMC / ICT 系の手法）。エッジページ（RR好機ボード）で使う純関数。
//  - FVG（フェアバリューギャップ）: 3本の足で、1本目の高値と3本目の安値の間に空いた価格の空白（未充足のものだけ）
//  - オーダーブロック: 強い足（ディスプレイスメント）で直近高値/安値を抜けた直前の、逆向きの最後の足。終値で割られたら無効
//  - 流動性スイープ: 直近のスイング安値（高値）をヒゲで割って終値で戻した足＝ストップを狩ってから反転
//  - プレミアム/ディスカウント: 直近のスイングの値幅の中の位置。買いは下半分（ディスカウント）、
//    とくに 61.8〜79% 押し（OTE）が有利。売りは逆
//  - ディスプレイスメント: 直近3本に ATR の1.5倍以上の実体の足（勢いのある動き）
// 足は確定足だけを渡す（形成中の足は除く）。※投資助言ではない参考情報。
import { averageTrueRange, pivotIndices, type SlDirection } from './stoploss';
import type { OhlcCandle } from './edge';
import type { DowAnalysis } from './dow';

export interface PriceBox {
  dir: 1 | -1; // 1=強気（買い方の）/ -1=弱気（売り方の）
  low: number;
  high: number;
  barsAgo: number; // できた足が何本前か
}
export interface Sweep {
  dir: 1 | -1; // 1=安値スイープ（売り方のストップを狩って上へ）/ -1=高値スイープ
  level: number; // 狩られたスイングの価格
  barsAgo: number;
}
export interface PremiumDiscount {
  pos: number; // 直近スイングの値幅の中の位置（0=安値・1=高値）
  zone: 'discount' | 'equilibrium' | 'premium';
  ote: boolean; // その方向の OTE（61.8〜79% 押し/戻り）に入っている
}
export interface SmcRead {
  fvg: PriceBox | null; // 順方向の未充足 FVG（買いなら現在値の下、1.5 ATR 以内か現在値を含む）
  oppFvg: PriceBox | null; // 逆方向の FVG がすぐ前（0.5 ATR 以内）にある
  ob: PriceBox | null; // 順方向の有効なオーダーブロック（現在値が中か 1 ATR 以内の上）
  sweep: Sweep | null; // 順方向の流動性スイープ（直近 SWEEP_BARS 本）
  oppSweep: Sweep | null; // 逆方向の流動性スイープ
  pd: PremiumDiscount | null;
  displacement: 1 | -1 | 0; // 直近3本の強い足の向き
}

const LOOKBACK = 40; // FVG・オーダーブロックを探す本数
const SWEEP_BARS = 8; // スイープを探す本数
const FVG_MIN_ATR = 0.1; // これより小さい空白は FVG とみなさない
const DISPLACEMENT_ATR = 1.2; // オーダーブロックの起点になる強い足（実体）
const STRONG_ATR = 1.5; // ディスプレイスメントのタグ

const body = (c: OhlcCandle) => Math.abs(c.close - c.open);

/** 未充足（一部充足を含む）の FVG。一部埋まった分は範囲から除く。新しい順。 */
export function findFvgs(c: OhlcCandle[], atr: number, lookback = LOOKBACK): PriceBox[] {
  const n = c.length;
  const out: PriceBox[] = [];
  for (let i = Math.max(2, n - lookback); i < n; i++) {
    const a = c[i - 2];
    const z = c[i];
    let box: PriceBox | null = null;
    if (z.low > a.high && z.low - a.high >= atr * FVG_MIN_ATR) box = { dir: 1, low: a.high, high: z.low, barsAgo: n - 1 - i };
    if (z.high < a.low && a.low - z.high >= atr * FVG_MIN_ATR) box = { dir: -1, low: z.high, high: a.low, barsAgo: n - 1 - i };
    if (!box) continue;
    let alive = true;
    for (let j = i + 1; j < n && alive; j++) {
      if (box.dir === 1) {
        if (c[j].low <= box.low) alive = false;
        else if (c[j].low < box.high) box.high = c[j].low;
      } else if (c[j].high >= box.high) alive = false;
      else if (c[j].high > box.low) box.low = c[j].high;
    }
    if (alive) out.push(box);
  }
  return out.reverse();
}

/** 有効なオーダーブロック（終値で割られていないもの）。新しい順。 */
export function findOrderBlocks(c: OhlcCandle[], atr: number, lookback = LOOKBACK): PriceBox[] {
  const n = c.length;
  const out: PriceBox[] = [];
  for (let i = Math.max(11, n - lookback); i < n; i++) {
    const d = c[i];
    if (body(d) < atr * DISPLACEMENT_ATR) continue;
    const bull = d.close > d.open;
    const prior = c.slice(i - 10, i);
    // 強い足が直近10本の高値（安値）を終値で抜けた＝構造のブレイク
    if (bull ? d.close <= Math.max(...prior.map((x) => x.high)) : d.close >= Math.min(...prior.map((x) => x.low))) continue;
    // 直前5本のうち、逆向きの最後の足
    let k = -1;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (bull ? c[j].close < c[j].open : c[j].close > c[j].open) {
        k = j;
        break;
      }
    }
    if (k < 0) continue;
    const box: PriceBox = { dir: bull ? 1 : -1, low: c[k].low, high: c[k].high, barsAgo: n - 1 - k };
    const broken = c.slice(i + 1).some((x) => (bull ? x.close < box.low : x.close > box.high));
    if (!broken && !out.some((o) => o.dir === box.dir && o.barsAgo === box.barsAgo)) out.push(box);
  }
  return out.reverse();
}

/** 直近 bars 本の流動性スイープ。スイープした足の安値（高値）をその後の終値で割って（超えて）いないものだけ。新しい順。 */
export function findSweeps(c: OhlcCandle[], bars = SWEEP_BARS): Sweep[] {
  const n = c.length;
  const out: Sweep[] = [];
  for (let j = Math.max(3, n - bars); j < n; j++) {
    const s = c[j];
    const from = Math.max(0, j - 60);
    const before = c.slice(from, j);
    const after = c.slice(j + 1);
    // 安値スイープ: 過去のスイング安値をヒゲで割って、終値はその上
    const lows = pivotIndices(before, 'low').map((p) => ({ price: before[p].low, idx: from + p }));
    const lowHit = lows
      .filter((l) => s.low < l.price && s.close > l.price && !c.slice(l.idx + 1, j).some((x) => x.close < l.price))
      .sort((a, b) => a.price - b.price)[0];
    if (lowHit && !after.some((x) => x.close < s.low)) out.push({ dir: 1, level: lowHit.price, barsAgo: n - 1 - j });
    const highs = pivotIndices(before, 'high').map((p) => ({ price: before[p].high, idx: from + p }));
    const highHit = highs
      .filter((h) => s.high > h.price && s.close < h.price && !c.slice(h.idx + 1, j).some((x) => x.close > h.price))
      .sort((a, b) => b.price - a.price)[0];
    if (highHit && !after.some((x) => x.close > s.high)) out.push({ dir: -1, level: highHit.price, barsAgo: n - 1 - j });
  }
  return out.reverse();
}

/** 直近の高値スイングと安値スイングの値幅の中で、現在値がどこにいるか。 */
export function premiumDiscount(dow: DowAnalysis | null, price: number, direction: SlDirection): PremiumDiscount | null {
  const hi = [...(dow?.swings ?? [])].reverse().find((s) => s.kind === 'high')?.price;
  const lo = [...(dow?.swings ?? [])].reverse().find((s) => s.kind === 'low')?.price;
  if (hi == null || lo == null || !(hi > lo)) return null;
  const pos = Math.min(1, Math.max(0, (price - lo) / (hi - lo)));
  const zone = pos < 0.45 ? 'discount' : pos > 0.55 ? 'premium' : 'equilibrium';
  // 買いの OTE = 高値から 61.8〜79% 押した位置（pos 0.21〜0.382）。売りは逆（pos 0.618〜0.79）。
  const ote = direction === 'long' ? pos >= 0.21 && pos <= 0.382 : pos >= 0.618 && pos <= 0.79;
  return { pos, zone, ote };
}

/** setup の方向から見た SMC の読み。candles は確定足、price は現在値。 */
export function analyzeSmc(candles: OhlcCandle[], price: number, direction: SlDirection, dow: DowAnalysis | null): SmcRead {
  const atr = averageTrueRange(candles);
  const want: 1 | -1 = direction === 'long' ? 1 : -1;
  const empty: SmcRead = { fvg: null, oppFvg: null, ob: null, sweep: null, oppSweep: null, pd: null, displacement: 0 };
  if (candles.length < 15 || !(atr > 0)) return empty;
  const long = want === 1;

  const fvgs = findFvgs(candles, atr);
  // 順方向: 買いなら現在値の下（または現在値を含む）で 1.5 ATR 以内。
  const fvg =
    fvgs.find((f) => f.dir === want && (long ? f.low <= price && price - f.high <= atr * 1.5 : f.high >= price && f.low - price <= atr * 1.5)) ??
    null;
  // 逆方向: 買いなら現在値の上 0.5 ATR 以内（すぐ前の売りの空白）。
  const oppFvg =
    fvgs.find((f) => f.dir === -want && (long ? f.high >= price && f.low - price <= atr * 0.5 : f.low <= price && price - f.high <= atr * 0.5)) ??
    null;

  const ob =
    findOrderBlocks(candles, atr).find(
      (o) => o.dir === want && (long ? price >= o.low && price - o.high <= atr : price <= o.high && o.low - price <= atr),
    ) ?? null;

  const sweeps = findSweeps(candles);
  const sweep = sweeps.find((s) => s.dir === want) ?? null;
  const oppSweep = sweeps.find((s) => s.dir === -want) ?? null;

  const last3 = candles.slice(-3).filter((x) => body(x) >= atr * STRONG_ATR);
  const displacement = last3.length ? ((last3[last3.length - 1].close > last3[last3.length - 1].open ? 1 : -1) as 1 | -1) : 0;

  return { fvg, oppFvg, ob, sweep, oppSweep, pd: premiumDiscount(dow, price, direction), displacement };
}

export type PaTone = 'with' | 'against' | 'info'; // setup の方向に有利 / 不利 / 参考

export interface PaTag {
  label: string; // 例「FVG 151.20–151.25」「安値スイープ（3本前）」
  tone: PaTone;
  points: number; // 総合スコアへの加減点
}

/** SMC の読みを、カードに出すタグ（加減点つき）にする。 */
export function smcTags(r: SmcRead, direction: SlDirection, digits: number): PaTag[] {
  const long = direction === 'long';
  const f = (p: number) => p.toFixed(digits);
  const ago = (n: number) => (n === 0 ? '最新足' : `${n}本前`);
  const tags: PaTag[] = [];
  if (r.sweep) tags.push({ label: `${long ? '安値' : '高値'}スイープ（${ago(r.sweep.barsAgo)}・${f(r.sweep.level)}）`, tone: 'with', points: 7 });
  if (r.oppSweep) tags.push({ label: `逆の${long ? '高値' : '安値'}スイープ（${ago(r.oppSweep.barsAgo)}）`, tone: 'against', points: -7 });
  if (r.ob) tags.push({ label: `${long ? '買い' : '売り'}のオーダーブロック ${f(r.ob.low)}–${f(r.ob.high)}`, tone: 'with', points: 6 });
  if (r.fvg) tags.push({ label: `${long ? '上昇' : '下落'}FVG ${f(r.fvg.low)}–${f(r.fvg.high)}`, tone: 'with', points: 5 });
  if (r.oppFvg) tags.push({ label: `すぐ${long ? '上に売り' : '下に買い'}のFVG`, tone: 'against', points: -4 });
  if (r.pd) {
    const pct = Math.round(r.pd.pos * 100);
    if (r.pd.ote) tags.push({ label: `OTE（${long ? '61.8〜79%押し' : '61.8〜79%戻し'}・${pct}%）`, tone: 'with', points: 6 });
    else if ((long && r.pd.zone === 'discount') || (!long && r.pd.zone === 'premium'))
      tags.push({ label: `${long ? 'ディスカウント' : 'プレミアム'}（${pct}%）`, tone: 'with', points: 3 });
    else if ((long && r.pd.zone === 'premium') || (!long && r.pd.zone === 'discount'))
      tags.push({ label: `${long ? 'プレミアムで買い' : 'ディスカウントで売り'}（${pct}%）`, tone: 'against', points: -5 });
    else tags.push({ label: `値幅の中間（${pct}%）`, tone: 'info', points: 0 });
  }
  if (r.displacement !== 0) {
    const withDir = (r.displacement === 1) === long;
    tags.push({ label: withDir ? '順方向の強い足（ディスプレイスメント）' : '逆方向の強い足', tone: withDir ? 'with' : 'against', points: withDir ? 3 : -5 });
  }
  return tags;
}
