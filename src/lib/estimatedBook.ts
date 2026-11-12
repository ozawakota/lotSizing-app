// 自作の推定オーダーブック（OANDA の板情報の代わり）。純関数。Worker の /orderbook とテストで使う。
// 実際の注文は公開されていないため、手に入るデータから「注文・ポジションが溜まっていそうな価格帯」を推定する。
//
// ① 注文（オーダーブック）: 1時間足の価格の構造から推定
//   - まだ抜けていないスイング高値の少し上 = 買いの逆指値（売り方の損切り・ブレイク買い）、高値の少し下 = 売り指値
//   - まだ割れていないスイング安値の少し下 = 売りの逆指値（買い方の損切り・ブレイク売り）、安値の少し上 = 買い指値
//   - キリ番（00・50）: 現在値より下 = 買い指値、上 = 売り指値。その少し外に逆指値
//   - 新しいスイングほど重く（半減期 RECENCY_HALF_LIFE 本）、キリ番は現在値に近いほど重い
//   - 個人の建玉（Myfxbook）が売りに偏っていれば、売り方の損切り＝買いの逆指値を重く（買いに偏っていれば逆）
// ② ポジション（ポジションブック）: Myfxbook の「買い・売りの平均取得価格と取引量」の毎時の記録（Turso）を積み上げる
//   - 記録ごとに、平均取得価格の価格帯へ取引量を足す（新しい記録ほど重く・半減期 POSITION_HALF_LIFE_H 時間）
// 集計の仕方は OANDA の板情報に合わせる:
//   - 固定幅のバケツ（価格帯）ごとの [価格, 買い%, 売り%]。% は「板全体（全バケツ）の合計」に対する割合
//     （返すのは現在値の上下 BOOK_RANGE_BUCKETS 本だけなので、返した範囲の合計は 100 未満になりうる）
//   - 20 分ごとのスナップショット（:00 / :20 / :40）。時刻は snapshotTime() でそろえる
// 入力（注文・ポジションの量）は実データではなく推定である点だけが OANDA と違う。※投資助言ではない参考情報。
import type { BookSide } from './orderBook';

export interface OhlcLike {
  high: number;
  low: number;
  close: number;
}

/** バケツ（価格帯）の幅。 */
export const BOOK_BUCKET: Record<string, number> = {
  USD_JPY: 0.05,
  EUR_JPY: 0.05,
  GBP_JPY: 0.05,
  AUD_JPY: 0.05,
  EUR_USD: 0.0005,
  GBP_USD: 0.0005,
  AUD_USD: 0.0005,
  XAU_USD: 1,
};
/** キリ番の刻み（00 と 50）。 */
const ROUND_STEP: Record<string, number> = {
  USD_JPY: 0.5,
  EUR_JPY: 0.5,
  GBP_JPY: 0.5,
  AUD_JPY: 0.5,
  EUR_USD: 0.005,
  GBP_USD: 0.005,
  AUD_USD: 0.005,
  XAU_USD: 10,
};

export const BOOK_RANGE_BUCKETS = 80; // 現在値の上下に返すバケツ数

/** OANDA と同じスナップショットの間隔（20 分）。 */
export const SNAPSHOT_INTERVAL_MS = 20 * 60 * 1000;
/** その時刻が属するスナップショットの時刻（:00 / :20 / :40 に切り捨て）。 */
export const snapshotTime = (ms: number): number => Math.floor(ms / SNAPSHOT_INTERVAL_MS) * SNAPSHOT_INTERVAL_MS;
const PIVOT_K = 3;
const RECENCY_HALF_LIFE = 120; // スイングの重みの半減期（本。1時間足で5日）
export const POSITION_HALF_LIFE_H = 72; // ポジションの記録の重みの半減期（時間）
const SMOOTH = [0.25, 0.5, 0.25]; // 注文を隣のバケツにも少し配る
const POSITION_SMOOTH = [0.06, 0.14, 0.2, 0.2, 0.2, 0.14, 0.06]; // ポジションは平均値なので広めに配る

export interface RetailMix {
  longPct: number;
  shortPct: number;
}

function atrOf(bars: OhlcLike[], n = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  const tail = trs.slice(-n);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

/** バケツの累積器（index = floor(price / width)）。 */
class Accum {
  long = new Map<number, number>();
  short = new Map<number, number>();
  constructor(private width: number) {}
  add(side: 'long' | 'short', price: number, weight: number, kernel: number[] = SMOOTH) {
    if (!(weight > 0) || !Number.isFinite(price)) return;
    const m = side === 'long' ? this.long : this.short;
    const idx = Math.floor(price / this.width + 1e-9);
    const half = (kernel.length - 1) / 2;
    kernel.forEach((k, j) => {
      const key = idx + j - half;
      m.set(key, (m.get(key) ?? 0) + weight * k);
    });
  }
  /**
   * OANDA と同じく「板全体の合計」に対する % にして、現在値の上下 BOOK_RANGE_BUCKETS 本を返す。全部 0 なら null。
   */
  toBook(price: number, time: number): BookSide | null {
    const w = this.width;
    const center = Math.floor(price / w + 1e-9);
    const keys: number[] = [];
    for (let k = center - BOOK_RANGE_BUCKETS; k <= center + BOOK_RANGE_BUCKETS; k++) keys.push(k);
    let total = 0;
    for (const v of this.long.values()) total += v;
    for (const v of this.short.values()) total += v;
    if (!(total > 0)) return null;
    const dp = w >= 1 ? 2 : w >= 0.01 ? 3 : 5;
    const r = (n: number) => Math.round(n * 10 ** dp) / 10 ** dp;
    return {
      time,
      price,
      bucketWidth: w,
      buckets: keys.map((k) => [r(k * w), ((this.long.get(k) ?? 0) / total) * 100, ((this.short.get(k) ?? 0) / total) * 100]),
    };
  }
}

/**
 * ① 価格の構造から、注文の分布（オーダーブック）を推定する。
 * bars は 1時間足（古い順・確定足）。price は現在値（bars と同じ基準）。retail は個人の建玉の割合（無ければ偏りなしとして扱う）。
 */
export function estimateOrderBook(
  bars: OhlcLike[],
  price: number,
  instrument: string,
  opts: { retail?: RetailMix | null; now?: number } = {},
): BookSide | null {
  const width = BOOK_BUCKET[instrument];
  const step = ROUND_STEP[instrument];
  if (!width || !step || bars.length < PIVOT_K * 2 + 10 || !(price > 0)) return null;
  const atr = atrOf(bars);
  if (!(atr > 0)) return null;
  const acc = new Accum(width);
  const n = bars.length;
  // 個人の偏り: 売りが多い = 売り方の損切り（買いの逆指値）が多い。買いが多い = 売りの逆指値が多い。
  const buyStopScale = opts.retail ? 0.5 + opts.retail.shortPct / 100 : 1;
  const sellStopScale = opts.retail ? 0.5 + opts.retail.longPct / 100 : 1;

  // スイング高安（左右 PIVOT_K 本）。その後に抜けた/割れたものは、注文が執行済みとみなして除く。
  const laterMaxHigh = new Array<number>(n).fill(-Infinity);
  const laterMinLow = new Array<number>(n).fill(Infinity);
  for (let i = n - 2; i >= 0; i--) {
    laterMaxHigh[i] = Math.max(laterMaxHigh[i + 1], bars[i + 1].high);
    laterMinLow[i] = Math.min(laterMinLow[i + 1], bars[i + 1].low);
  }
  for (let i = PIVOT_K; i < n - PIVOT_K; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= PIVOT_K; j++) {
      if (!(bars[i].high >= bars[i - j].high && bars[i].high > bars[i + j].high)) isHigh = false;
      if (!(bars[i].low <= bars[i - j].low && bars[i].low < bars[i + j].low)) isLow = false;
    }
    const recency = 0.5 ** ((n - 1 - i) / RECENCY_HALF_LIFE);
    if (isHigh && laterMaxHigh[i] < bars[i].high && bars[i].high > price) {
      acc.add('long', bars[i].high + atr * 0.15, 1.0 * recency * buyStopScale); // 買いの逆指値
      acc.add('short', bars[i].high - atr * 0.05, 0.6 * recency); // 売り指値
    }
    if (isLow && laterMinLow[i] > bars[i].low && bars[i].low < price) {
      acc.add('short', bars[i].low - atr * 0.15, 1.0 * recency * sellStopScale); // 売りの逆指値
      acc.add('long', bars[i].low + atr * 0.05, 0.6 * recency); // 買い指値
    }
  }

  // キリ番（00 は 50 より重い）。現在値に近いほど重い。
  const reach = width * BOOK_RANGE_BUCKETS;
  for (let r = Math.ceil((price - reach) / step) * step; r <= price + reach; r += step) {
    const isFull = Math.abs(Math.round(r / (step * 2)) * step * 2 - r) < step / 10;
    const near = 0.5 ** (Math.abs(r - price) / (atr * 8));
    const base = (isFull ? 0.8 : 0.5) * near;
    if (r < price) {
      acc.add('long', r, base); // 買い指値
      acc.add('short', r - atr * 0.1, base * 0.5 * sellStopScale); // その下の売りの逆指値
    } else if (r > price) {
      acc.add('short', r, base); // 売り指値
      acc.add('long', r + atr * 0.1, base * 0.5 * buyStopScale); // その上の買いの逆指値
    }
  }
  return acc.toBook(price, opts.now ?? Date.now());
}

/** Myfxbook の毎時の記録（Turso の flow_snapshots の1行）。 */
export interface FlowRecord {
  ts: number; // 記録時刻（ms）
  avgLong: number | null;
  avgShort: number | null;
  longVolume: number;
  shortVolume: number;
}

/** ポジションの分布を出すのに必要な記録の数（平均取得価格のあるもの）。 */
export const MIN_POSITION_RECORDS = 3;

/**
 * ② 個人の建玉の記録を積み上げて、ポジションの分布（ポジションブック）を推定する。
 * 平均取得価格のある記録が MIN_POSITION_RECORDS 未満なら null（記録がたまるまで出さない）。
 */
export function positionBookFromRecords(records: FlowRecord[], price: number, instrument: string, now = Date.now()): BookSide | null {
  const width = BOOK_BUCKET[instrument];
  if (!width) return null;
  const usable = records.filter((r) => r.avgLong != null || r.avgShort != null);
  if (usable.length < MIN_POSITION_RECORDS) return null;
  const acc = new Accum(width);
  for (const r of usable) {
    const w = 0.5 ** (Math.max(0, now - r.ts) / 3_600_000 / POSITION_HALF_LIFE_H);
    if (r.avgLong != null) acc.add('long', r.avgLong, r.longVolume * w, POSITION_SMOOTH);
    if (r.avgShort != null) acc.add('short', r.avgShort, r.shortVolume * w, POSITION_SMOOTH);
  }
  return acc.toBook(price, now);
}
