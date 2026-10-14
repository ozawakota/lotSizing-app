// 時間足ごとの更新タイミング。足の確定直後（Dukascopy 側の反映待ちに少し遅らせる）に集計し直す。
import { EDGE_TIMEFRAMES, type EdgeTimeframe } from '../../src/lib/edge';

// 更新間隔。短い足は確定ごと、長い足は途中経過の反映を兼ねて足の長さより短い間隔で回す。
export const REFRESH_MS: Record<EdgeTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 15 * 60_000,
  '4h': 30 * 60_000,
  '1d': 60 * 60_000,
};
export const SETTLE_MS = 15_000; // 足の確定から取得までの待ち

/** now の次の更新時刻（間隔の区切り + SETTLE_MS）。 */
export function nextDue(tf: EdgeTimeframe, now: number): number {
  const interval = REFRESH_MS[tf];
  const due = Math.floor(now / interval) * interval + SETTLE_MS;
  return due > now ? due : due + interval;
}

// 起動直後は軽い（本数の少ない）足から集計し、早く表示できるようにする。
export const STARTUP_ORDER: EdgeTimeframe[] = [...EDGE_TIMEFRAMES].reverse();

/**
 * 更新ループ。起動時に全時間足を集計し、以後は期限の来た時間足を順番に1つずつ集計する
 * （同時実行しない＝データ元への負荷と CPU を抑える）。戻り値で停止できる。
 */
export function startScheduler(run: (tf: EdgeTimeframe) => Promise<unknown>, tickMs = 5_000): () => void {
  const due = new Map<EdgeTimeframe, number>(STARTUP_ORDER.map((tf) => [tf, 0]));
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const tf of STARTUP_ORDER) {
        if (stopped || Date.now() < (due.get(tf) ?? 0)) continue;
        try {
          await run(tf);
        } catch (e) {
          console.error(`[edge] ${tf} 集計失敗`, e);
        }
        due.set(tf, nextDue(tf, Date.now()));
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, tickMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
