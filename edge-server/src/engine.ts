// 時間足ごとに「足の取得・保存 → 確定足でエッジ集計 → スナップショット保持」を行う。
// データ元(Feed)と保存先(SeriesStore)を注入するので、テストでは偽の Feed で動かせる。
import {
  EDGE_HISTORY_DAYS,
  EDGE_HORIZON,
  EDGE_PAIRS,
  TIMEFRAME_MS,
  analyzePairEdge,
  closedCandles,
  currencyBias,
  type EdgeSnapshot,
  type EdgeTimeframe,
  type PairEdge,
} from '../../src/lib/edge';
import { avgSpreadPips, mergeBars, pruneBefore, type Bar, type SeriesStore } from './store';

export interface Feed {
  /** fromMs〜toMs の足（過去分。直近は反映が遅れてもよい）。 */
  history(instrument: string, tf: EdgeTimeframe, fromMs: number, toMs: number): Promise<Bar[]>;
  /** 最新 last 本の足（形成中の足を含んでよい）。 */
  recent(instrument: string, tf: EdgeTimeframe, last: number): Promise<Bar[]>;
}

export const RECENT_BARS = 300; // 毎回の更新で取り直す直近本数（この範囲を超える空白は過去分で埋める）

export class EdgeEngine {
  private snapshots = new Map<EdgeTimeframe, EdgeSnapshot>();

  constructor(
    private readonly feed: Feed,
    private readonly store: SeriesStore,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string, e?: unknown) => void = (m, e) => console.error(m, e ?? ''),
  ) {}

  snapshot(tf: EdgeTimeframe): EdgeSnapshot | undefined {
    return this.snapshots.get(tf);
  }

  /** 1ペア分の系列を最新化して返す。初回は統計期間ぶんを、途中の空白は過去分で補う。 */
  private async updateSeries(instrument: string, tf: EdgeTimeframe): Promise<Bar[]> {
    const now = this.now();
    const tfMs = TIMEFRAME_MS[tf];
    const startMs = now - EDGE_HISTORY_DAYS[tf] * 86_400_000;
    let bars = await this.store.get(instrument, tf);
    const lastMs = bars.length > 0 ? bars[bars.length - 1].t * 1000 : startMs;
    if (now - lastMs > RECENT_BARS * tfMs * 0.8) {
      bars = mergeBars(bars, await this.feed.history(instrument, tf, Math.max(lastMs, startMs), now));
    }
    bars = mergeBars(bars, await this.feed.recent(instrument, tf, RECENT_BARS));
    bars = pruneBefore(bars, Math.floor(startMs / 1000));
    await this.store.set(instrument, tf, bars);
    return bars;
  }

  /** 全ペアを更新して集計する。取得に失敗しても保存済みの足があれば、それで集計を続ける。 */
  async refresh(tf: EdgeTimeframe): Promise<EdgeSnapshot> {
    const horizon = EDGE_HORIZON[tf];
    const pairs: PairEdge[] = [];
    const failed: string[] = [];
    for (const instrument of EDGE_PAIRS) {
      let bars: Bar[];
      try {
        bars = await this.updateSeries(instrument, tf);
      } catch (e) {
        this.log(`[edge] ${instrument} ${tf} 取得失敗（保存済みの足で集計）`, e);
        bars = await this.store.get(instrument, tf);
      }
      const closed = closedCandles(bars, tf, this.now());
      if (closed.length <= horizon + 1) {
        failed.push(instrument);
        continue;
      }
      pairs.push(analyzePairEdge(closed, instrument, horizon, undefined, avgSpreadPips(closed, instrument)));
    }
    const snap: EdgeSnapshot = {
      timeframe: tf,
      horizon,
      pairs,
      currencies: currencyBias(pairs),
      failed,
      source: 'dukascopy',
      generatedAt: this.now(),
    };
    if (pairs.length > 0) this.snapshots.set(tf, snap);
    return snap;
  }
}
