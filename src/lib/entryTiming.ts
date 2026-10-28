// エントリーのタイミング判定（高値掴み・安値売りの回避）。TF分析ページで使う純関数。
// RR は「現在値で入る」前提で計算しているため、伸び切ったところでも RR が成立して見えることがある。
// そこで、いま入ると高値掴み（売りなら安値売り）になりやすいかを、次の材料で点数化する（買いの場合。売りは逆）:
//   - 直近スイングの値幅の中の位置（上の方ほど高値掴み）
//   - 背後の支え（支持帯・押し安値）からの距離（ATR 倍。離れすぎは押し戻されやすい）
//   - すぐ上の抵抗帯（0.5 ATR 以内）
//   - RSI / ストキャスの買われすぎ
//   - 直近3本の急上昇（1.5 ATR 以上）
//   - 移動平均: 21SMA からの乖離（ATR 倍）と、75EMA・200EMA に対する位置（下で買う=大きな流れに逆らう）
// 合計 0〜1=入りどき / 2〜3=押し目待ち / 4以上=高値掴み注意。
// 待つべきときは、押し目の指値の目安（支持帯の上限・押し目の 50% / 61.8%・21SMA・75EMA・いちばん近い支えの少し上）と、
// その価格で入った場合の RR（損切り・目標は同じ）を返す。※投資助言ではない参考情報。
import { averageTrueRange, pipSize, type SlDirection } from './stoploss';
import type { OhlcCandle } from './edge';
import type { DowAnalysis } from './dow';
import type { SrZone } from './srZones';
import { premiumDiscount } from './smc';
import { sma, type MaSet } from './entrySignal';

export type TimingVerdict = 'ok' | 'wait' | 'avoid';

export interface EntryReason {
  label: string; // 例「直近の値幅の上の方（82%）」
  points: number; // 高値掴みの度合い（大きいほど不利）
}

export interface LimitPlan {
  price: number; // 指値の目安
  basis: string; // 例「支持帯の上限」「押し目61.8%」
  distancePips: number; // 現在値からの距離
  rr: number | null; // その価格で入った場合の RR（損切り・目標が無ければ null）
}

export interface MaRead {
  key: 'sma21' | 'ema75' | 'ema200';
  label: string; // 「21SMA」など
  price: number;
  atrFromPrice: number; // 現在値 − MA（ATR 倍。上=+）
}

export interface EntryTiming {
  verdict: TimingVerdict;
  score: number;
  reasons: EntryReason[]; // 点数の大きい順
  limit: LimitPlan | null; // verdict が ok のときは null
  mas: MaRead[]; // 表示用の移動平均（算出できたものだけ）
}

export interface EntryTimingInput {
  direction: SlDirection;
  price: number;
  instrument: string;
  bars: OhlcCandle[]; // 確定足（古い順）
  dow: DowAnalysis | null;
  zones: { res: SrZone[]; sup: SrZone[] } | null | undefined;
  rsi: number | null | undefined;
  stochK: number | null | undefined;
  rr?: { stop: number; target: number; spreadPips: number } | null; // 現在の RR 計画（指値の RR を出すため）
  ma?: MaSet | null; // 長い足の履歴から求めた移動平均（Worker）。無ければ bars から 21SMA だけ求める
}

const MA_LABEL: Record<MaRead['key'], string> = { sma21: '21SMA', ema75: '75EMA', ema200: '200EMA' };

const round1 = (n: number) => Math.round(n * 10) / 10;

interface Behind {
  price: number;
  name: string; // 例「支持帯★3」「押し安値」
}

/** 現在値で入ってよいか（高値掴み・安値売りになりやすいか）を判定する。足が足りなければ null。 */
export function assessEntryTiming(i: EntryTimingInput): EntryTiming | null {
  const atr = averageTrueRange(i.bars);
  if (i.bars.length < 15 || !(atr > 0)) return null;
  const long = i.direction === 'long';
  const pip = pipSize(i.instrument);
  const reasons: EntryReason[] = [];
  const add = (label: string, points: number) => {
    if (points > 0) reasons.push({ label, points });
  };

  // 1) 直近スイングの値幅の中の位置（買いなら上の方ほど不利）。
  const pd = premiumDiscount(i.dow, i.price, i.direction);
  if (pd) {
    const bad = long ? pd.pos : 1 - pd.pos; // 0=最も有利 / 1=最も不利
    const pct = Math.round(pd.pos * 100);
    if (bad > 0.75) add(`直近の値幅の${long ? '上' : '下'}の方（${pct}%）`, 2);
    else if (bad > 0.6) add(`直近の値幅の${long ? 'やや上' : 'やや下'}（${pct}%）`, 1);
  }

  // 2) 背後の支え（買い=支持帯・押し安値 / 売り=抵抗帯・戻り高値）からの距離。
  const behindLevels: Behind[] = [];
  for (const z of (long ? i.zones?.sup : i.zones?.res) ?? [])
    behindLevels.push({ price: z.contains ? i.price : long ? z.high : z.low, name: `${long ? '支持帯' : '抵抗帯'}★${z.stars}` });
  const key = i.dow?.keyLevel?.price;
  if (key != null && (long ? key < i.price : key > i.price)) behindLevels.push({ price: key, name: long ? '押し安値' : '戻り高値' });
  const behind = behindLevels.length
    ? behindLevels.reduce((a, b) => ((long ? b.price > a.price : b.price < a.price) ? b : a))
    : null;
  if (behind != null) {
    const distAtr = Math.abs(i.price - behind.price) / atr;
    if (distAtr > 2) add(`${long ? '支え' : '抑え'}から離れすぎ（${round1(distAtr)} ATR）`, 2);
    else if (distAtr > 1.3) add(`${long ? '支え' : '抑え'}からやや離れている（${round1(distAtr)} ATR）`, 1);
  }

  // 3) すぐ前（0.5 ATR 以内）にある抵抗帯（売りなら支持帯）。
  const ahead = ((long ? i.zones?.res : i.zones?.sup) ?? []).find((z) => z.contains || z.distancePips * pip <= atr * 0.5);
  if (ahead) add(`すぐ${long ? '上に抵抗帯' : '下に支持帯'}★${ahead.stars}`, 2);

  // 4) オシレーターの行き過ぎ。
  const rsi = i.rsi ?? null;
  const k = i.stochK ?? null;
  if (rsi != null && (long ? rsi >= 75 : rsi <= 25)) add(`RSI ${Math.round(rsi)}（${long ? '買われすぎ' : '売られすぎ'}）`, 2);
  else if ((rsi != null && (long ? rsi >= 70 : rsi <= 30)) || (k != null && (long ? k >= 85 : k <= 15)))
    add(long ? 'RSI/ストキャスが買われすぎ' : 'RSI/ストキャスが売られすぎ', 1);

  // 5) 直近3本の急な動き（その方向に 1.5 ATR 以上）。
  const last3 = i.bars.slice(-3);
  const run = long ? i.price - Math.min(...last3.map((b) => b.low)) : Math.max(...last3.map((b) => b.high)) - i.price;
  if (run > atr * 1.5) add(`直近3本で急${long ? '上昇' : '下落'}（${round1(run / atr)} ATR）`, 1);

  // 6) 移動平均。21SMA から順方向に離れすぎていれば、MA まで押し戻されやすい。
  //    75EMA・200EMA の逆側（買いなら下）で入るのは大きな流れに逆らうので注意（高値掴みとは別の減点）。
  const ma: MaSet = {
    sma21: i.ma?.sma21 ?? sma(i.bars.map((b) => b.close), 21),
    ema75: i.ma?.ema75 ?? null,
    ema200: i.ma?.ema200 ?? null,
  };
  const mas: MaRead[] = (['sma21', 'ema75', 'ema200'] as const)
    .filter((key) => ma[key] != null)
    .map((key) => ({ key, label: MA_LABEL[key], price: ma[key] as number, atrFromPrice: round1((i.price - (ma[key] as number)) / atr) }));
  const sma21 = mas.find((m) => m.key === 'sma21');
  if (sma21) {
    const ext = long ? sma21.atrFromPrice : -sma21.atrFromPrice; // 順方向への乖離
    if (ext > 1.5) add(`21SMA から離れすぎ（${ext.toFixed(1)} ATR）`, 2);
    else if (ext > 0.8) add(`21SMA からやや離れている（${ext.toFixed(1)} ATR）`, 1);
  }
  const against = mas.filter((m) => m.key !== 'sma21' && (long ? m.atrFromPrice < 0 : m.atrFromPrice > 0));
  if (against.length) add(`${against.map((m) => m.label).join('・')}の${long ? '下で買う' : '上で売る'}（大きな流れに逆らう）`, 1);

  reasons.sort((a, b) => b.points - a.points);
  const score = reasons.reduce((s, r) => s + r.points, 0);
  const verdict: TimingVerdict = score >= 4 ? 'avoid' : score >= 2 ? 'wait' : 'ok';
  return { verdict, score, reasons, limit: verdict === 'ok' ? null : limitPlan(i, atr, pip, behind, mas), mas };
}

/** 押し目（戻り）の指値の目安。現在値より 0.3 ATR 以上有利で、損切りより手前の候補のうち、最も近いもの。 */
function limitPlan(i: EntryTimingInput, atr: number, pip: number, behind: Behind | null, mas: MaRead[]): LimitPlan | null {
  const long = i.direction === 'long';
  const cands: { price: number; basis: string }[] = [];
  const zone = ((long ? i.zones?.sup : i.zones?.res) ?? []).find((z) => !z.contains);
  if (zone) cands.push({ price: long ? zone.high : zone.low, basis: `${long ? '支持帯' : '抵抗帯'}★${zone.stars}の${long ? '上限' : '下限'}` });
  const hi = [...(i.dow?.swings ?? [])].reverse().find((s) => s.kind === 'high')?.price;
  const lo = [...(i.dow?.swings ?? [])].reverse().find((s) => s.kind === 'low')?.price;
  if (hi != null && lo != null && hi > lo) {
    for (const f of [0.5, 0.618]) {
      cands.push({ price: long ? hi - (hi - lo) * f : lo + (hi - lo) * f, basis: `${long ? '押し目' : '戻り'}${(f * 100).toFixed(1).replace(/\.0$/, '')}%` });
    }
  }
  if (behind != null)
    cands.push({ price: long ? behind.price + atr * 0.2 : behind.price - atr * 0.2, basis: `${behind.name}の少し${long ? '上' : '下'}` });

  // 移動平均までの押し（21SMA・75EMA）。順方向の側にあるものだけ。
  for (const m of mas) {
    if (m.key !== 'ema200' && (long ? m.price < i.price : m.price > i.price)) cands.push({ price: m.price, basis: `${m.label}まで${long ? '押し' : '戻り'}` });
  }
  const minGap = atr * 0.3;
  const stop = i.rr?.stop ?? null;
  const ok = cands.filter(
    (c) => (long ? c.price <= i.price - minGap : c.price >= i.price + minGap) && (stop == null || (long ? c.price > stop : c.price < stop)),
  );
  if (!ok.length) return null;
  const best = ok.sort((a, b) => (long ? b.price - a.price : a.price - b.price))[0];
  let rr: number | null = null;
  if (i.rr) {
    const risk = Math.abs(best.price - i.rr.stop) / pip + i.rr.spreadPips;
    const reward = Math.abs(i.rr.target - best.price) / pip - i.rr.spreadPips;
    rr = risk > 0 && reward > 0 ? round1(reward / risk) : null;
  }
  return { price: best.price, basis: best.basis, distancePips: round1(Math.abs(i.price - best.price) / pip), rr };
}

export const TIMING_LABEL: Record<TimingVerdict, { long: string; short: string }> = {
  ok: { long: '入りどき', short: '入りどき' },
  wait: { long: '押し目待ち', short: '戻り待ち' },
  avoid: { long: '高値掴み注意', short: '安値売り注意' },
};
