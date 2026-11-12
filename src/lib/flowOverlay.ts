// 取引量・センチメント（/flow）の情報を、TF分析のローソク足チャートの背景に重ねるための読み方。純関数。
// /flow のペアごとの値:
//   - 個人の建玉の買い%・売り%（Myfxbook）… チャートの左端に半透明のゲージ
//   - 個人の買い・売りの平均取得価格 … 半透明の帯（その価格に戻ると、建値撤退や損切りが出やすい）
//   - 合計取引量のピーク時のレート … 半透明の帯（取引が集中した価格）
//   - 大口投機筋（CFTC COT）の買い越し/売り越し … 文字で
// 現在値と平均取得価格の位置から、買い勢・売り勢が含み益か含み損かを出す（含み損の側は、逆行で損切りが連鎖しやすい）。
// ※投資助言ではない参考情報。
import type { FlowPair, Lean, PairFlow } from './flow';

export type FlowLevelKind = 'avg_long' | 'avg_short' | 'peak';

export interface FlowLevel {
  kind: FlowLevelKind;
  price: number;
  label: string; // 例「個人の買い平均」
  distancePips: number; // 現在値 − 価格（pips。上にあれば負）
  note: string; // 例「買い勢は含み益（+12.0pips）」
}

export interface FlowOverlay {
  pair: FlowPair;
  longPct: number;
  shortPct: number;
  crowd: Lean; // 個人の偏り（60%以上の側。それ以外は neutral）
  cot: Lean | null; // 大口投機筋の向き（取得できなければ null）
  levels: FlowLevel[];
  peakAt: string | null; // 取引量ピークの日時（ISO8601）
  summary: string; // 1行のまとめ
}

/** 個人の建玉がこの割合以上なら「偏り」とみなす（逆張りの目安）。 */
export const FLOW_CROWD_PCT = 60;

const LEVEL_LABEL: Record<FlowLevelKind, string> = {
  avg_long: '個人の買い平均',
  avg_short: '個人の売り平均',
  peak: '取引量ピーク',
};

/** TF分析の instrument（例 USD_JPY）を /flow のペア名（例 USD/JPY）にする。 */
export const flowPairOf = (instrument: string): FlowPair => instrument.replace('_', '/') as FlowPair;

export function flowOverlay(pf: PairFlow, price: number, pip: number): FlowOverlay {
  const crowd: Lean = pf.longPct >= FLOW_CROWD_PCT ? 'buy' : pf.shortPct >= FLOW_CROWD_PCT ? 'sell' : 'neutral';
  const levels: FlowLevel[] = [];
  const dist = (p: number) => Math.round(((price - p) / pip) * 10) / 10;
  const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}pips`;
  if (pf.avgLongPrice != null) {
    const d = dist(pf.avgLongPrice); // 正 = 現在値が上 = 買い勢は含み益
    levels.push({
      kind: 'avg_long',
      price: pf.avgLongPrice,
      label: LEVEL_LABEL.avg_long,
      distancePips: d,
      note: d >= 0 ? `買い勢は含み益（${signed(d)}）` : `買い勢は含み損（${signed(d)}）。戻ると建値で手仕舞いの売りが出やすい`,
    });
  }
  if (pf.avgShortPrice != null) {
    const d = -dist(pf.avgShortPrice); // 正 = 現在値が下 = 売り勢は含み益
    levels.push({
      kind: 'avg_short',
      price: pf.avgShortPrice,
      label: LEVEL_LABEL.avg_short,
      distancePips: dist(pf.avgShortPrice),
      note: d >= 0 ? `売り勢は含み益（${signed(d)}）` : `売り勢は含み損（${signed(d)}）。戻ると建値で手仕舞いの買いが出やすい`,
    });
  }
  if (pf.peak?.rate != null) {
    levels.push({
      kind: 'peak',
      price: pf.peak.rate,
      label: LEVEL_LABEL.peak,
      distancePips: dist(pf.peak.rate),
      note: '取引が集中した価格（意識されやすい）',
    });
  }
  const crowdText =
    crowd === 'buy'
      ? `個人は買いに偏り（${pf.longPct}%）→ 逆張りなら売り目線`
      : crowd === 'sell'
        ? `個人は売りに偏り（${pf.shortPct}%）→ 逆張りなら買い目線`
        : `個人の買い・売りは拮抗（買い${pf.longPct}%）`;
  const cot = pf.cot?.lean ?? null;
  const cotText = cot === 'buy' ? '・大口は買い越し' : cot === 'sell' ? '・大口は売り越し' : cot === 'neutral' ? '・大口は中立' : '';
  return {
    pair: pf.pair,
    longPct: pf.longPct,
    shortPct: pf.shortPct,
    crowd,
    cot,
    levels,
    peakAt: pf.peak?.datetime ?? null,
    summary: crowdText + cotText,
  };
}
