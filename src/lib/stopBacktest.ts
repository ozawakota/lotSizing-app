// 損切りラインの新旧比較バックテスト（純関数）。edge-server/backtest/stops.ts から実データで呼ぶ。
// 各確定足の終値でトレンド方向にエントリーしたと仮定し、旧方式（computeStopLoss）と構造的損切り
// （computeStructuralStop）のそれぞれで「損切り / 目標（リスクの rewardR 倍）/ 時間切れ」のどれに先に
// 達したかを数える。同じ足で損切りと目標の両方に触れた場合は損切り扱い（保守的）。
// 「刈られ率」= 損切り後、同じ期間内に元の目標まで到達したケース（ノイズで狩られた）の割合。
import {
  RR_MIN,
  computeStopLoss,
  computeStructuralStop,
  computeStructure,
  pipSize,
  trendToDirection,
  type Candle,
  type SlDirection,
  type StopOptions,
} from './stoploss';

export type StopMethod = 'legacy' | 'structural';

export interface BacktestOptions {
  instrument: string;
  warmup?: number; // 判定に使う最低本数（既定 120）
  horizonBars?: number; // エントリー後に追う最大本数（既定 200）
  step?: number; // エントリーを何本おきに取るか（重複を減らす。既定 4）
  rewardR?: number; // 目標＝リスクの何倍か（既定 RR_MIN）
  spreadPips?: number; // 1取引のコスト（R 換算で期待値から差し引く）
  stopOptions?: Partial<StopOptions>; // 構造的損切りのパラメータ（バッファ倍率などの比較用）
}

export interface BacktestStats {
  method: StopMethod;
  trades: number;
  stopRate: number; // 損切りに先に到達した割合（%）
  targetRate: number; // 目標に先に到達した割合（%）
  timeoutRate: number; // どちらにも届かず期間切れ（%）
  whipsawRate: number; // 損切りのうち、後で目標まで届いた割合（%）＝狩られ率
  expectancyR: number; // 1取引あたりの平均損益（R 単位, スプレッド控除後）
  avgRiskPips: number; // 平均の損切り幅
}

type Outcome = { kind: 'stop' | 'target' | 'timeout'; r: number; whipsaw: boolean; riskPips: number };

function simulate(
  candles: Candle[],
  i: number,
  direction: SlDirection,
  entry: number,
  stop: number,
  horizon: number,
  rewardR: number,
  pip: number,
  spreadPips: number,
): Outcome | null {
  const long = direction === 'long';
  const risk = long ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
  const target = long ? entry + risk * rewardR : entry - risk * rewardR;
  const end = Math.min(candles.length - 1, i + horizon);
  const cost = spreadPips * pip / risk; // スプレッドを R 換算
  for (let j = i + 1; j <= end; j++) {
    const c = candles[j];
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const tgtHit = long ? c.high >= target : c.low <= target;
    if (stopHit) {
      let whipsaw = false;
      for (let k = j + 1; k <= end && !whipsaw; k++) whipsaw = long ? candles[k].high >= target : candles[k].low <= target;
      return { kind: 'stop', r: -1 - cost, whipsaw, riskPips: risk / pip };
    }
    if (tgtHit) return { kind: 'target', r: rewardR - cost, whipsaw: false, riskPips: risk / pip };
  }
  const last = candles[end].close;
  return { kind: 'timeout', r: (long ? last - entry : entry - last) / risk - cost, whipsaw: false, riskPips: risk / pip };
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

function summarize(method: StopMethod, outs: Outcome[]): BacktestStats {
  const n = outs.length;
  const stops = outs.filter((o) => o.kind === 'stop');
  return {
    method,
    trades: n,
    stopRate: pct(stops.length, n),
    targetRate: pct(outs.filter((o) => o.kind === 'target').length, n),
    timeoutRate: pct(outs.filter((o) => o.kind === 'timeout').length, n),
    whipsawRate: pct(stops.filter((o) => o.whipsaw).length, stops.length),
    expectancyR: n > 0 ? Math.round((outs.reduce((a, o) => a + o.r, 0) / n) * 1000) / 1000 : 0,
    avgRiskPips: n > 0 ? Math.round((outs.reduce((a, o) => a + o.riskPips, 0) / n) * 10) / 10 : 0,
  };
}

/**
 * 同じエントリー集合（両方式とも損切りが決まった足のみ）で新旧を比較する。
 * candles は古い→新しい順の確定足。
 */
export function backtestStops(candles: Candle[], opts: BacktestOptions): { legacy: BacktestStats; structural: BacktestStats } {
  const warmup = opts.warmup ?? 120;
  const horizon = opts.horizonBars ?? 200;
  const step = opts.step ?? 4;
  const rewardR = opts.rewardR ?? RR_MIN;
  const spreadPips = opts.spreadPips ?? 0;
  const pip = pipSize(opts.instrument);
  const legacy: Outcome[] = [];
  const structural: Outcome[] = [];

  for (let i = warmup; i < candles.length - 1; i += step) {
    // 判定に要るのは直近の lookback 本程度なので、その分だけ切り出す（全履歴コピーを避ける）。
    const need = Math.max(opts.stopOptions?.lookback ?? 100, 24) + 20;
    const hist = candles.slice(Math.max(0, i + 1 - need), i + 1);
    const entry = candles[i].close;
    const structure = computeStructure(hist, entry);
    const direction = trendToDirection(structure.trend);
    if (!direction) continue;
    const oldStop = computeStopLoss(structure, direction, null, opts.instrument).price;
    const plan = computeStructuralStop(hist, direction, entry, {
      instrument: opts.instrument,
      spreadPips,
      ...opts.stopOptions,
      excludeLast: false, // hist の最終足（i）は確定済み
    });
    if (!plan) continue;
    const a = simulate(candles, i, direction, entry, oldStop, horizon, rewardR, pip, spreadPips);
    const b = simulate(candles, i, direction, entry, plan.price, horizon, rewardR, pip, spreadPips);
    if (!a || !b) continue;
    legacy.push(a);
    structural.push(b);
  }
  return { legacy: summarize('legacy', legacy), structural: summarize('structural', structural) };
}
