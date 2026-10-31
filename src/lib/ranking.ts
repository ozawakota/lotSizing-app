// RR好機ボード（エッジページ）の型と整形ロジック。フロント/worker 共有。
// 各ペア×TF（15m/30m/1h/4h）で RR が出た「好機」を1カードとして扱う。カードは TF分析（/mtf）の結果から作る
// （rankingCards.ts）ので、RR・損切り・目標・入りどきは TF分析ページと同じ。RR が成立=「好機」、
// 成立しないが NEAR_RR_MIN 以上=「準好機」。並び順は総合スコア（edgeScore）→RR の降順。
// 旧キャッシュ（総合スコアが無いカード）は、信用度（Jev/roleReversal）＋タイミング補正で並べる。
// ※投資助言ではない参考情報。
import type { SlTimeframe, SlDirection } from './stoploss';
import { ENTRY_DELTA, type EntrySignal } from './entrySignal';
import type { ScoreItem } from './edgeScore';
import type { PaTag } from './smc';
import type { TimingVerdict } from './entryTiming';

export const RANKING_TIMEFRAMES: SlTimeframe[] = ['15m', '30m', '1h', '4h'];

// 対象ペア（通貨強弱の全ペア。XAU/USD のゴールドを含む）。
export const RANKING_PAIRS: string[] = [
  'USD_JPY',
  'EUR_JPY',
  'GBP_JPY',
  'AUD_JPY',
  'EUR_USD',
  'GBP_USD',
  'AUD_USD',
  'XAU_USD',
];

// 信用度の出所。jev=Jevブレイク方向確率 / structure=roleReversal（純粋算出）
export type ConfidenceSource = 'jev' | 'structure';

// 1好機（ペア×TF）＝1カード。
export interface RrCard {
  instrument: string;
  tf: SlTimeframe;
  direction: SlDirection; // long=買い / short=売り
  entry: number;
  stop: number; // 損切り価格
  target: number; // 利確目標価格
  rr: number; // リワード/リスク（小数1桁）
  riskPips: number;
  rewardPips: number;
  spreadPips: number;
  // 以下3つは旧キャッシュのみ（TF分析と統一する前のカード）。新しいカードは timing・jevProb・score を使う。
  confidence?: number | null; // 0–100。取得不可は null
  confidenceSource?: ConfidenceSource | null;
  entrySignal?: EntrySignal | null; // 押し目/戻り/様子見/反転警戒（MA+ストキャス+PA）。評価不能は null
  // 以下は精度向上版で追加（旧キャッシュには無い）。
  tier?: 'prime' | 'near'; // prime=好機（RR≥RR_MIN）/ near=準好機（NEAR_RR_MIN≤RR<RR_MIN）
  score?: number; // 総合スコア 0–100（50=中立）
  scoreItems?: ScoreItem[]; // 総合スコアの内訳（点数の大きい順）
  dowLabel?: string; // 例「上昇・押し目を形成中」
  stopNote?: string | null; // 抵抗帯に合わせた損切りの調整（無ければ null）
  targetNote?: string | null; // 抵抗帯に合わせた目標の調整（無ければ null）
  paTags?: PaTag[]; // プライスアクション（SMC: スイープ・オーダーブロック・FVG・OTE など）のタグ
  // 以下は TF分析と統一した版で追加。
  timing?: {
    verdict: TimingVerdict; // TF分析と同じ入りどき
    label: string; // 入りどき / 押し目待ち（戻り待ち）/ 高値掴み注意（安値売り注意）
    limitPrice: number | null; // 指値の目安
    stopEntryPrice: number | null; // ブレイク狙いの逆指値の目安
  } | null;
  jevProb?: number | null; // AI（Jev）のその方向へのブレイク確率
  stopReasons?: string[]; // 損切りの根拠（構造的損切り）
  patternNote?: string; // ローソク足パターンとの関係
}

export interface RrBoardSnapshot {
  cards: RrCard[];
  jevPaused: boolean; // Jev が使用上限等で一時停止中（信用度は構造判定で表示）
  failed: string[]; // 取得に失敗したペア
  generatedAt: number;
}

// 並び順のスコア。総合スコアがあればそれ、無ければ（旧キャッシュ）信用度 + エントリータイミング補正。
export function effectiveScore(c: RrCard): number {
  if (c.score != null) return c.score;
  return (c.confidence ?? -1) + (c.entrySignal ? ENTRY_DELTA[c.entrySignal.kind] : 0); // 旧キャッシュ
}

// 実効スコアの高い順、同率は RR の高い順。
export function sortCards(cards: RrCard[]): RrCard[] {
  return [...cards].sort((a, b) => {
    const ea = effectiveScore(a);
    const eb = effectiveScore(b);
    if (eb !== ea) return eb - ea;
    return b.rr - a.rr;
  });
}
