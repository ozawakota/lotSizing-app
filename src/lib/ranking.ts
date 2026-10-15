// RR好機ボード（エッジページ）の型と整形ロジック。フロント/worker 共有。
// 各ペア×TF（15m/30m/1h/4h）で構造RR(≥RR_MIN)が成立した「好機」を1カードとして扱う。
// 信用度は Jev のブレイク方向確率。取得できない/使用上限のときは roleReversal の構造信用度で代替。
// 並び順は信用度→RR の降順。※投資助言ではない参考情報。
import type { SlTimeframe, SlDirection } from './stoploss';

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
}

export interface RrBoardSnapshot {
  cards: RrCard[];
  jevPaused: boolean; // Jev が使用上限等で一時停止中（信用度は構造判定で表示）
  failed: string[]; // 取得に失敗したペア
  generatedAt: number;
}

// 信用度の高い順（null は最後）、同率は RR の高い順。
export function sortCards(cards: RrCard[]): RrCard[] {
  return [...cards].sort((a, b) => {
    const ca = a.confidence ?? -1;
    const cb = b.confidence ?? -1;
    if (cb !== ca) return cb - ca;
    return b.rr - a.rr;
  });
}
