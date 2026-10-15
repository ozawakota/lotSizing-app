// RR好機ボード（エッジページ）の型と整形ロジック。フロント/worker 共有。
// 各ペア×TF（15m/30m/1h/4h）で構造RR(≥RR_MIN)が成立した「好機」を1カードとして扱う。
// 信用度は Jev のブレイク方向確率。取得できない/使用上限のときは roleReversal の構造信用度で代替。
// 並び順は信用度→RR の降順。※投資助言ではない参考情報。
import type { SlTimeframe, SlDirection } from './stoploss';
import { ENTRY_DELTA, type EntrySignal } from './entrySignal';

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
  confidence: number | null; // 0–100。取得不可は null
  confidenceSource: ConfidenceSource | null;
  entrySignal: EntrySignal | null; // 押し目/戻り/打診/反転警戒（MA+ストキャス+PA）。評価不能は null
}

export interface RrBoardSnapshot {
  cards: RrCard[];
  jevPaused: boolean; // Jev が使用上限等で一時停止中（信用度は構造判定で表示）
  failed: string[]; // 取得に失敗したペア
  generatedAt: number;
}

// 実効スコア = 信用度 + エントリータイミング補正（押し目/戻り加点・反転警戒減点）。
export function effectiveScore(c: RrCard): number {
  return (c.confidence ?? -1) + (c.entrySignal ? ENTRY_DELTA[c.entrySignal.kind] : 0);
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
