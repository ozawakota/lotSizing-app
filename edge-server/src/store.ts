// ローソク足の保存（ペア×時間足ごとに JSON ファイル）と、マージ・期間外削除・平均スプレッドの純関数。
// 足は Bid の OHLC（チャートと同じ基準）＋ Ask の終値（スプレッド算出用）を持つ。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EdgeTimeframe, OhlcCandle } from '../../src/lib/edge';
import { pipSize } from '../../src/lib/stoploss';

export interface Bar extends OhlcCandle {
  t: number; // 足の開始時刻（UNIX秒, UTC）
  ask?: number; // Ask の終値（無ければスプレッド計算から除外）
}

export type Row = [number, number, number, number, number, number?]; // dukascopy-node の配列形式 [ms, open, high, low, close, volume]

/** Bid の足に同時刻の Ask の終値を付け、時刻を秒にする（Ask が欠けた足は ask 無し）。 */
export function combineBidAsk(bid: Row[], ask: Row[]): Bar[] {
  const askClose = new Map(ask.map((r) => [r[0], r[4]]));
  return bid
    .filter((r) => r.slice(1, 5).every((v) => typeof v === 'number' && Number.isFinite(v)))
    .map(([ms, open, high, low, close]) => ({ t: Math.floor(ms / 1000), open, high, low, close, ask: askClose.get(ms) }));
}

/** 時刻順に統合する。同じ時刻は新しい方で上書きし、新しい方に ask が無ければ既存の ask を残す。 */
export function mergeBars(existing: Bar[], incoming: Bar[]): Bar[] {
  const byT = new Map<number, Bar>();
  for (const b of existing) byT.set(b.t, b);
  for (const b of incoming) {
    const prev = byT.get(b.t);
    byT.set(b.t, b.ask === undefined && prev?.ask !== undefined ? { ...b, ask: prev.ask } : b);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** cutoffSec より前の足を捨てる（統計期間外）。 */
export function pruneBefore(bars: Bar[], cutoffSec: number): Bar[] {
  return bars.filter((b) => b.t >= cutoffSec);
}

/** Ask − Bid（終値）の平均を pips で返す。Ask の無い足・負の値（異常値）は除外。データ無しは 0。 */
export function avgSpreadPips(bars: Bar[], instrument: string): number {
  const pip = pipSize(instrument);
  let sum = 0;
  let n = 0;
  for (const b of bars) {
    if (b.ask === undefined) continue;
    const s = (b.ask - b.close) / pip;
    if (s >= 0 && Number.isFinite(s)) {
      sum += s;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** ペア×時間足の系列をメモリに持ち、更新のたびにファイルへ保存する（再起動時の再取得を避ける）。 */
export class SeriesStore {
  private series = new Map<string, Bar[]>();

  constructor(private readonly dir: string) {}

  private key(instrument: string, tf: EdgeTimeframe) {
    return `${instrument}_${tf}`;
  }

  private file(instrument: string, tf: EdgeTimeframe) {
    return path.join(this.dir, `${this.key(instrument, tf)}.json`);
  }

  async get(instrument: string, tf: EdgeTimeframe): Promise<Bar[]> {
    const k = this.key(instrument, tf);
    const cached = this.series.get(k);
    if (cached) return cached;
    let bars: Bar[] = [];
    try {
      bars = JSON.parse(await readFile(this.file(instrument, tf), 'utf8')) as Bar[];
    } catch {
      // 未保存 or 破損 → 空から作り直す
    }
    this.series.set(k, bars);
    return bars;
  }

  async set(instrument: string, tf: EdgeTimeframe, bars: Bar[]): Promise<void> {
    this.series.set(this.key(instrument, tf), bars);
    await mkdir(this.dir, { recursive: true });
    // 書き込み途中で落ちても壊れないよう、一時ファイルに書いてから置き換える。
    const file = this.file(instrument, tf);
    await writeFile(`${file}.tmp`, JSON.stringify(bars));
    await rename(`${file}.tmp`, file);
  }
}
