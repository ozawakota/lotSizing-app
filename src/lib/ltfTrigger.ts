// 下位足（1分足・5分足）で入るタイミングを確かめる（TF分析ページ）。純関数。
// 上位足（15分〜4時間）で方向・入る場所（成行/指値/逆指値）・損切り・目標が決まっているとき、
// 下位足で次の3つを順に確かめる（買いの場合。売りは逆）:
//   ① 入る場所に来たか（成行=すぐ / 指値=指値まで下がったか / 逆指値=逆指値まで上がったか）
//   ② 下位足で向きが変わったか（直近の押し安値の前の戻り高値を終値で上抜けた＝CHoCH、
//      または直近3本以内に確定した強気のピンバー/包み足）
//   ③ ①②がそろえば「トリガー点灯」
// 損切りを下位足の押し安値の少し下（0.2 ATR）に置くと、上位足の損切りより狭くなり RR が上がる。
// 向きが変わる前は「下位足の戻り高値を上抜けたら買う」逆指値を目安にする。※投資助言ではない参考情報。
import { averageTrueRange, pipSize, type SlDirection } from './stoploss';
import type { OhlcCandle } from './edge';
import { readCandlePatterns } from './candleRead';
import { PATTERN_DIRECTION } from './edge';

export type LtfState = 'invalid' | 'wait_area' | 'wait_turn' | 'triggered';

export interface LtfPlanArea {
  kind: 'market' | 'limit' | 'stop'; // 上位足のプランの入り方
  price: number; // 成行は現在値、指値/逆指値はその価格
}

export interface LtfInput {
  direction: SlDirection;
  bars: OhlcCandle[]; // 下位足の確定足（古い順）
  price: number; // 現在値
  instrument: string;
  area: LtfPlanArea;
  htfStop: number; // 上位足の損切り
  target: number; // 上位足の目標
  spreadPips: number;
}

export interface LtfCheck {
  label: string;
  ok: boolean;
}

export interface LtfRefined {
  entry: number;
  entryType: 'market' | 'stop'; // 向きが変わった後=成行 / 変わる前=戻り高値の上抜けで逆指値
  stop: number;
  stopBasis: string;
  target: number;
  riskPips: number;
  rr: number;
}

export interface LtfResult {
  state: LtfState;
  checks: LtfCheck[];
  swingHigh: { price: number; barsAgo: number } | null; // 下位足の直近の戻り高値（買い）/ 押し安値（売り）＝転換のライン
  swingLow: { price: number; barsAgo: number } | null; // 下位足の直近の押し安値（買い）/ 戻り高値（売り）＝損切りの基準
  pattern: string | null; // 確定した順方向のパターン（あれば）
  refined: LtfRefined | null;
  htfRr: number; // 上位足のままの RR（比較用）
  note: string;
}

const PIVOT_K = 2;

function pivots(bars: OhlcCandle[], kind: 'high' | 'low'): number[] {
  const out: number[] = [];
  for (let i = PIVOT_K; i < bars.length - PIVOT_K; i++) {
    let ok = true;
    for (let j = 1; j <= PIVOT_K && ok; j++) {
      ok = kind === 'high'
        ? bars[i].high >= bars[i - j].high && bars[i].high > bars[i + j].high
        : bars[i].low <= bars[i - j].low && bars[i].low < bars[i + j].low;
    }
    if (ok) out.push(i);
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function rrOf(direction: SlDirection, entry: number, stop: number, target: number, pip: number, spreadPips: number) {
  const riskPips = Math.abs(entry - stop) / pip + spreadPips;
  const rewardPips = (direction === 'long' ? target - entry : entry - target) / pip - spreadPips;
  return { riskPips: round1(riskPips), rr: riskPips > 0 && rewardPips > 0 ? round1(rewardPips / riskPips) : 0 };
}

export function assessLtfTrigger(i: LtfInput): LtfResult | null {
  if (i.bars.length < 20) return null;
  const long = i.direction === 'long';
  const pip = pipSize(i.instrument);
  const atr = averageTrueRange(i.bars);
  const htf = rrOf(i.direction, i.area.price, i.htfStop, i.target, pip, i.spreadPips);
  const last = i.bars.length - 1;

  // 損切りを越えていたら、上位足のプランは崩れている。
  if (long ? i.price <= i.htfStop : i.price >= i.htfStop) {
    return {
      state: 'invalid', checks: [], swingHigh: null, swingLow: null, pattern: null, refined: null, htfRr: htf.rr,
      note: '上位足の損切りラインを越えています（プランは無効）。',
    };
  }

  // ① 入る場所に来たか（直近12本の安値/高値も見る）。
  const recent = i.bars.slice(-12);
  let reached = true;
  if (i.area.kind === 'limit') {
    reached = long
      ? Math.min(i.price, ...recent.map((b) => b.low)) <= i.area.price
      : Math.max(i.price, ...recent.map((b) => b.high)) >= i.area.price;
  } else if (i.area.kind === 'stop') {
    reached = long
      ? Math.max(i.price, ...recent.map((b) => b.high)) >= i.area.price
      : Math.min(i.price, ...recent.map((b) => b.low)) <= i.area.price;
  }

  // ② 下位足の構造: 直近の押し安値（買い）と、その前の戻り高値（転換のライン）。
  const lows = pivots(i.bars, long ? 'low' : 'high');
  const highs = pivots(i.bars, long ? 'high' : 'low');
  const lowIdx = lows.at(-1);
  const highIdx = lowIdx != null ? [...highs].reverse().find((h) => h < lowIdx) : highs.at(-1);
  const extreme = (idx: number) => (long ? i.bars[idx].low : i.bars[idx].high);
  const turnLine = (idx: number) => (long ? i.bars[idx].high : i.bars[idx].low);
  const swingLow = lowIdx != null ? { price: extreme(lowIdx), barsAgo: last - lowIdx } : null;
  const swingHigh = highIdx != null ? { price: turnLine(highIdx), barsAgo: last - highIdx } : null;
  let choch = false;
  if (swingHigh && lowIdx != null) {
    for (let k = lowIdx + 1; k <= last && !choch; k++) {
      choch = long ? i.bars[k].close > swingHigh.price : i.bars[k].close < swingHigh.price;
    }
  }
  const reads = readCandlePatterns(i.bars, { instrument: i.instrument, windowBars: 4 });
  const pat = reads.find((r) => r.confirmation === 'confirmed' && r.barsAgo <= 3 && (PATTERN_DIRECTION[r.key] === 1) === long);
  const turned = choch || !!pat;

  // ③ 下位足の損切り・入り方。損切りは押し安値の 0.2 ATR 外（上位足の損切りより内側のときだけ採用）。
  let stop = i.htfStop;
  let stopBasis = '上位足の損切り';
  if (swingLow) {
    const s = long ? swingLow.price - atr * 0.2 : swingLow.price + atr * 0.2;
    if (long ? s > i.htfStop && s < i.price : s < i.htfStop && s > i.price) {
      stop = s;
      stopBasis = `下位足の${long ? '押し安値' : '戻り高値'}の少し${long ? '下' : '上'}`;
    }
  }
  let refined: LtfRefined | null = null;
  if (reached) {
    const entry = turned ? i.price : swingHigh ? (long ? swingHigh.price + atr * 0.1 : swingHigh.price - atr * 0.1) : null;
    if (entry != null && (long ? entry > stop && entry < i.target : entry < stop && entry > i.target)) {
      const r = rrOf(i.direction, entry, stop, i.target, pip, i.spreadPips);
      refined = { entry, entryType: turned ? 'market' : 'stop', stop, stopBasis, target: i.target, riskPips: r.riskPips, rr: r.rr };
    }
  }

  const areaLabel =
    i.area.kind === 'market' ? '入る場所（今の価格）' : `${i.area.kind === 'limit' ? '指値' : '逆指値'}の目安まで来た`;
  const turnLabel = pat
    ? `下位足で${long ? '上' : '下'}向きに転換（${pat.label}）`
    : `下位足で${long ? '戻り高値を上抜け' : '押し安値を下抜け'}（転換）`;
  const checks: LtfCheck[] = [
    { label: areaLabel, ok: reached },
    { label: turnLabel, ok: turned },
  ];
  const state: LtfState = !reached ? 'wait_area' : !turned ? 'wait_turn' : 'triggered';
  const note =
    state === 'wait_area'
      ? `${i.area.kind === 'limit' ? '指値' : '逆指値'}の目安まで来るのを待つ段階です。`
      : state === 'wait_turn'
        ? `入る場所には来ています。下位足で${long ? '戻り高値を上抜ける' : '押し安値を下抜ける'}まで待つと、だましを避けやすくなります。`
        : `下位足でも${long ? '上' : '下'}向きに変わりました。損切りを下位足の${long ? '押し安値' : '戻り高値'}の外に置くと RR が上がります。`;
  return {
    state, checks, swingHigh, swingLow, pattern: pat?.label ?? null, refined, htfRr: htf.rr, note,
  };
}
