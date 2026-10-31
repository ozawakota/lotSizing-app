// RR好機ボードのカードを、TF分析（Worker /mtf）の結果から作る（純関数・Worker とテストで共有）。
// TF分析ページと同じ RR（損切り・目標）・入りどき・逆指値の目安を使うので、どのページでも同じ数字・同じ判定になる。
//   - RR が成立（qualifies: RR≥RR_MIN・方向の確率・パターンの裏付け）→ 好機（prime）
//   - 成立しないが RR≥NEAR_RR_MIN → 準好機（near）
//   - 総合スコアは edgeScore（トレンド・RR・入りどき・パターン・SMC・AI）
// ※投資助言ではない参考情報。
import { pickValidPattern, type PatternRead } from './candleRead';
import { dowSummary, type DowAnalysis } from './dow';
import { PATTERN_DIRECTION, type OhlcCandle } from './edge';
import { NEAR_RR_MIN, edgeScore } from './edgeScore';
import type { EntryTiming } from './entryTiming';
import type { RrCard } from './ranking';
import { analyzeSmc, smcTags } from './smc';
import type { BreakoutProb, RrSetup, SlTimeframe } from './stoploss';
import type { StopEntryPlan } from './zoneBreak';

/** /mtf の1時間足ぶん（カード作りに使う項目だけ）。 */
export interface MtfTfLike {
  tf: SlTimeframe;
  rr: RrSetup | null;
  timing?: EntryTiming | null;
  stopEntry?: StopEntryPlan | null;
  dow?: DowAnalysis | null;
  breakout: BreakoutProb | null;
  bars?: OhlcCandle[];
  forming?: OhlcCandle | null;
  candlePatterns?: PatternRead[];
}

export interface MtfLike {
  instrument: string;
  currentRate: number;
  timeframes: MtfTfLike[];
}

const TIMING_LABEL = {
  ok: { long: '入りどき', short: '入りどき' },
  wait: { long: '押し目待ち', short: '戻り待ち' },
  avoid: { long: '高値掴み注意', short: '安値売り注意' },
} as const;

export function cardsFromMtf(m: MtfLike): RrCard[] {
  const digits = m.instrument.startsWith('XAU') ? 2 : m.instrument.endsWith('JPY') ? 3 : 5;
  const cards: RrCard[] = [];
  m.timeframes.forEach((t, i) => {
    const rr = t.rr;
    if (!rr || rr.rr < NEAR_RR_MIN) return;
    const long = rr.direction === 'long';
    const higher = m.timeframes.slice(i + 1);
    const valid = t.candlePatterns ? pickValidPattern(t.candlePatterns) : null;
    const jevProb = t.breakout ? (long ? t.breakout.up : t.breakout.down) : null;
    const paTags = t.bars && t.bars.length >= 10 ? smcTags(analyzeSmc(t.bars, m.currentRate, rr.direction, t.dow ?? null), rr.direction, digits) : [];
    const verdict = t.timing?.verdict ?? null;
    const { score, items } = edgeScore({
      direction: rr.direction,
      rr: rr.rr,
      stopStrength: rr.stopStrength ?? null,
      dow: t.dow ?? null,
      higherDows: higher.map((h) => ({ tf: h.tf, dow: h.dow ?? null })),
      timing: verdict,
      pattern: valid ? { label: valid.label, dir: PATTERN_DIRECTION[valid.key] } : null,
      jevProb,
      paTags,
    });
    cards.push({
      instrument: m.instrument,
      tf: t.tf,
      direction: rr.direction,
      entry: rr.entry,
      stop: rr.stop,
      target: rr.target,
      rr: rr.rr,
      riskPips: rr.riskPips,
      rewardPips: rr.rewardPips,
      spreadPips: rr.spreadPips,
      tier: rr.qualifies ? 'prime' : 'near',
      score,
      scoreItems: items,
      dowLabel: t.dow ? dowSummary(t.dow) : undefined,
      stopReasons: rr.stopReasons,
      patternNote: rr.patternNote,
      paTags,
      jevProb,
      bars: t.bars,
      forming: t.forming ?? null,
      timing: verdict
        ? {
            verdict,
            label: TIMING_LABEL[verdict][rr.direction],
            limitPrice: t.timing?.limit?.price ?? null,
            stopEntryPrice: t.stopEntry?.price ?? null,
          }
        : null,
    });
  });
  return cards;
}
