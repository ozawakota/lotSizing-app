// ローソク足パターンの「読み」（TF分析カード用）。ピンバー・包み足の検出（edge.ts）に、
//  B. 形の質（0–100）: ヒゲ/実体の比率と、ATR に対する足の大きさ
//  C. 出た場所: 押し安値/戻り高値・上位足の高安・ロールリバーサル・出来高節目・キリ番の近くか
//  D. 確定/否定: その後の終値がパターンの高値/安値を抜けたか
//  E. 足ごとの適正な期間で、最大 N 件を新しい順に
// を加える。純関数（Worker とクライアントで共有、テスト可能）。
import {
  PATTERN_DIRECTION,
  PATTERN_LABEL,
  PINBAR_BODY_MAX,
  PINBAR_OPP_WICK_MAX,
  PINBAR_THRESHOLD,
  averageRange,
  detectPatterns,
  type OhlcCandle,
  type PatternKey,
} from './edge';
import { pivotIndices, type RrSetup, type SlTimeframe, type StopLevelRef } from './stoploss';

// 足ごとの探索期間（本数）: 15m=6時間 / 30m=12時間 / 1h=1日 / 4h=3日。古いパターンは表示しない。
export const PATTERN_WINDOW_BARS: Record<SlTimeframe, number> = { '15m': 24, '30m': 24, '1h': 24, '4h': 18 };
export const PATTERN_MAX_COUNT = 3;

export type PatternZone = 'key' | 'mid'; // key=意識されるライン付近 / mid=ラインから離れた場所
export type PatternConfirmation = 'confirmed' | 'pending' | 'invalidated';
export const CONFIRMATION_LABEL: Record<PatternConfirmation, string> = {
  confirmed: '確定',
  pending: '未確定',
  invalidated: '否定',
};

export interface PatternRead {
  key: PatternKey;
  label: string;
  barsAgo: number; // 0 = 最新確定足
  quality: number; // 形の質 0–100
  zone: PatternZone;
  zoneReasons: string[]; // 例 ['押し安値', '1時間足の安値']
  confirmation: PatternConfirmation;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lin = (x: number, lo: number, hi: number) => clamp01((x - lo) / (hi - lo));

/** B. 形の質（0–100）。ピンバー=長ヒゲ比率・反対ヒゲ・実体・大きさ / 包み足=実体の大きさ・包み方・大きさ。 */
export function patternQuality(candles: OhlcCandle[], i: number, key: PatternKey): number {
  const c = candles[i];
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  const atr = averageRange(candles, i) ?? range;
  const size = lin(range / atr, 0.5, 2); // ATR の半分→0点、2倍→満点
  const body = Math.abs(c.close - c.open);
  if (key === 'bull_pinbar' || key === 'bear_pinbar') {
    const longWick = key === 'bull_pinbar' ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
    const oppWick = key === 'bull_pinbar' ? c.high - Math.max(c.open, c.close) : Math.min(c.open, c.close) - c.low;
    const score =
      0.45 * lin(longWick / range, PINBAR_THRESHOLD, 0.9) +
      0.2 * (1 - clamp01(oppWick / range / PINBAR_OPP_WICK_MAX)) +
      0.1 * (1 - clamp01(body / range / PINBAR_BODY_MAX)) +
      0.25 * size;
    return Math.round(score * 100);
  }
  const prev = candles[i - 1];
  const prevBody = Math.abs(prev.close - prev.open);
  const bodyRatio = prevBody > 0 ? body / prevBody : 3;
  const engulfsRange = c.high >= prev.high && c.low <= prev.low; // ヒゲまで包む＝より強い
  const score = 0.35 * lin(bodyRatio, 1, 2.5) + 0.25 * lin(body / atr, 0.3, 1.2) + 0.2 * (engulfsRange ? 1 : 0) + 0.2 * size;
  return Math.round(score * 100);
}

// キリ番の刻み（円絡み=0.50円, XAU=10ドル, その他=0.0050）。
function roundStep(instrument: string): number {
  if (instrument.startsWith('XAU')) return 10;
  if (instrument.endsWith('JPY')) return 0.5;
  return 0.005;
}

/**
 * C. 出た場所。強気パターンは安値側、弱気パターンは高値側が、意識されるラインから ATR×0.5 以内なら key。
 * ラインは「パターンより前の確定ピボット」＋呼び出し側から渡す上位足・ロールリバーサル・出来高節目＋キリ番。
 */
export function patternZone(
  candles: OhlcCandle[],
  i: number,
  key: PatternKey,
  instrument: string,
  levels: StopLevelRef[] = [],
): { zone: PatternZone; reasons: string[] } {
  const c = candles[i];
  const atr = averageRange(candles, i) ?? c.high - c.low;
  const bull = PATTERN_DIRECTION[key] === 1;
  const edge = bull ? c.low : c.high;
  const tol = atr * 0.5;
  const reasons: string[] = [];
  // パターンより前（確定に前後2本が要るので i-3 まで）のピボット。
  const before = candles.slice(Math.max(0, i - 100), Math.max(0, i - 2));
  const pivots = pivotIndices(before, bull ? 'low' : 'high').map((p) => (bull ? before[p].low : before[p].high));
  if (pivots.some((L) => Math.abs(L - edge) <= tol)) reasons.push(bull ? '押し安値' : '戻り高値');
  for (const l of levels) if (Math.abs(l.price - edge) <= tol && !reasons.includes(l.label)) reasons.push(l.label);
  const step = roundStep(instrument);
  if (Math.abs(edge - Math.round(edge / step) * step) <= tol) reasons.push('キリ番');
  return { zone: reasons.length > 0 ? 'key' : 'mid', reasons };
}

/** D. 確定/否定。その後の終値が、強気=パターン高値を上抜け→確定 / 安値を下抜け→否定（先に起きた方）。 */
export function patternConfirmation(candles: OhlcCandle[], i: number, key: PatternKey): PatternConfirmation {
  const c = candles[i];
  const bull = PATTERN_DIRECTION[key] === 1;
  for (let j = i + 1; j < candles.length; j++) {
    const close = candles[j].close;
    if (bull ? close > c.high : close < c.low) return 'confirmed';
    if (bull ? close < c.low : close > c.high) return 'invalidated';
  }
  return 'pending';
}

/**
 * E. 末尾（最新確定足）から windowBars 本の範囲のパターンを、新しい順に最大 maxCount 件読む。
 * 同じ足に複数パターンがあればすべて含める。candles は確定足のみを渡す（形成中の足は除外）。
 */
export function readCandlePatterns(
  candles: OhlcCandle[],
  opts: { instrument: string; windowBars: number; maxCount?: number; levels?: StopLevelRef[] },
): PatternRead[] {
  const end = candles.length - 1;
  const out: PatternRead[] = [];
  const max = opts.maxCount ?? PATTERN_MAX_COUNT;
  for (let i = end; i >= Math.max(1, end - opts.windowBars + 1) && out.length < max; i--) {
    for (const key of detectPatterns(candles, i)) {
      if (out.length >= max) break;
      const z = patternZone(candles, i, key, opts.instrument, opts.levels);
      out.push({
        key,
        label: PATTERN_LABEL[key],
        barsAgo: end - i,
        quality: patternQuality(candles, i, key),
        zone: z.zone,
        zoneReasons: z.reasons,
        confirmation: patternConfirmation(candles, i, key),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 「有効なパターン」＝ 確定済み・意識されるライン上・形の質が高い。売買判断（Jev の入力・RR）に使うのはこれだけ。
// ---------------------------------------------------------------------------
export const VALID_PATTERN_MIN_QUALITY = 60;

export function isValidPattern(r: PatternRead): boolean {
  return r.confirmation === 'confirmed' && r.zone === 'key' && r.quality >= VALID_PATTERN_MIN_QUALITY;
}

/** 新しい順の読みから、最も新しい有効パターンを返す（無ければ null）。 */
export function pickValidPattern(reads: PatternRead[]): PatternRead | null {
  return reads.find(isValidPattern) ?? null;
}

/** Jev などに渡す説明（例 '確定・押し安値・1時間足の安値付近・質82'）。 */
export function patternDetail(r: PatternRead): string {
  return `${CONFIRMATION_LABEL[r.confirmation]}・${r.zoneReasons.join('・')}付近・質${r.quality}`;
}

/**
 * 有効パターンで RR を補正する。トレンド方向と同じ向きなら「裏付け」を付記、逆向きなら見送り（qualifies=false）。
 * RR好機通知はページの ✓ と一致したときだけ送るので、この補正は通知にもそのまま効く。
 */
export function applyPatternToRr<T extends RrSetup>(rr: T | null, valid: PatternRead | null): T | null {
  if (!rr || !valid) return rr;
  const dir = PATTERN_DIRECTION[valid.key] === 1 ? 'long' : 'short';
  if (dir === rr.direction) return { ...rr, patternSupport: 'aligned', patternNote: `${valid.label}（確定）が裏付け` };
  return { ...rr, qualifies: false, patternSupport: 'against', patternNote: `逆向きの${valid.label}（確定）が出ているため見送り` };
}
