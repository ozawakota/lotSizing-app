// 板情報（オーダーブック＝注文の分布 / ポジションブック＝保有ポジションの分布）の読み方。TF分析ページで使う純関数。
// 板情報そのものは自作の推定（src/lib/estimatedBook.ts）。OANDA の板情報と同じ形 [価格, 買い%, 売り%] で扱う。
// オーダーブックのバケツ（価格帯）ごとの「買い%・売り%」は、現在値の上下で意味が変わる:
//   - 現在値より下: 買い = 買い指値（下がったら買いたい＝支え） / 売り = 売りの逆指値（損切り・ブレイク売り＝割れると加速）
//   - 現在値より上: 売り = 売り指値（上がったら売りたい＝上値の重し） / 買い = 買いの逆指値（損切り・ブレイク買い＝抜けると加速）
// 平均より目立って多いバケツを「厚い」とみなし、エントリー・損切り・目標と照らして注意点を出す。※投資助言ではない参考情報。
import type { SlDirection } from './stoploss';

export interface BookSide {
  time: number; // 推定した時刻（ms）
  price: number; // その時点の価格
  bucketWidth: number;
  buckets: [number, number, number][]; // [価格, 買い（long）%, 売り（short）%]（価格の昇順）
}

export interface OrderBookPayload {
  instrument: string;
  orderBook: BookSide | null;
  positionBook: BookSide | null;
  generatedAt: number;
  source?: 'estimate'; // 自作の推定（価格の構造＋個人の建玉の記録）。OANDA の実データではない
  positionStatus?: PositionStatus; // ポジションの分布が無いときの理由（画面に出す）
}

/** ポジションの分布（ポジションブック）が出せないときの理由。 */
export interface PositionStatus {
  reason: 'no_db' | 'collecting' | 'error'; // no_db = Turso 未設定 / collecting = 記録を集め中 / error = 読み込み失敗
  records?: number; // 集まった記録の数（平均取得価格のあるもの）
  needed?: number; // 表示に必要な記録の数
}

export type ClusterKind = 'buy_limit' | 'sell_stop' | 'sell_limit' | 'buy_stop';

export const CLUSTER_LABEL: Record<ClusterKind, string> = {
  buy_limit: '買い指値（支え）',
  sell_stop: '売りの逆指値（割れると加速）',
  sell_limit: '売り指値（上値の重し）',
  buy_stop: '買いの逆指値（抜けると加速）',
};

export interface BookCluster {
  kind: ClusterKind;
  price: number; // バケツの価格（下端）
  pct: number; // そのバケツの割合（%）
  ratio: number; // 平均の何倍か
}

/** 平均の THICK_RATIO 倍以上を「厚い」とする。 */
export const THICK_RATIO = 1.8;

/**
 * オーダーブックの厚いところ（種類ごとに現在値に近い順で最大 maxPerKind 個）。
 * price は現在値（推定オーダーブックは現物の基準なので、画面の現在値と同じ基準）。
 */
export function bookClusters(book: BookSide, price: number, maxPerKind = 2): BookCluster[] {
  const bs = book.buckets;
  if (!bs.length) return [];
  const all = bs.flatMap(([, l, s]) => [l, s]);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  if (!(mean > 0)) return [];
  const out: BookCluster[] = [];
  const push = (kind: ClusterKind, p: number, pct: number) => {
    const ratio = pct / mean;
    if (ratio >= THICK_RATIO) out.push({ kind, price: p, pct, ratio: Math.round(ratio * 10) / 10 });
  };
  for (const [p, l, s] of bs) {
    const top = p + book.bucketWidth;
    if (top <= price) {
      push('buy_limit', p, l);
      push('sell_stop', p, s);
    } else if (p >= price) {
      push('sell_limit', p, s);
      push('buy_stop', p, l);
    }
  }
  const kinds: ClusterKind[] = ['buy_limit', 'sell_stop', 'sell_limit', 'buy_stop'];
  return kinds.flatMap((k) =>
    out
      .filter((c) => c.kind === k)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, maxPerKind),
  );
}

/** ポジションブックの買い・売りの比率（現在値の上下 ±range 内のバケツを合計）。 */
export function positionSkew(book: BookSide, price: number, range = Infinity): { longPct: number; shortPct: number } | null {
  let l = 0;
  let s = 0;
  for (const [p, lp, sp] of book.buckets) {
    if (Math.abs(p - price) > range) continue;
    l += lp;
    s += sp;
  }
  if (!(l + s > 0)) return null;
  const longPct = Math.round((l / (l + s)) * 100);
  return { longPct, shortPct: 100 - longPct };
}

export type NoteTone = 'good' | 'warn' | 'info';
export interface BookNote {
  tone: NoteTone;
  text: string;
}

export interface PlanLevels {
  direction: SlDirection;
  entry: number;
  stop: number;
  target: number;
}

/**
 * RR のプラン（エントリー・損切り・目標）を板情報と照らした注意点。
 *   - 損切りのすぐ近く（リスク幅の 25% 以内）に、同じ向きの逆指値の溜まり → 狩られやすい。外へずらす目安を出す
 *   - エントリーと目標の間に、反対向きの指値の壁 → 手前で一部利確
 *   - エントリーと損切りの間に、順方向の指値の支え → 支えあり
 *   - ポジションが片寄っている（65% 以上） → 逆の動きに注意（逆張りの目安）
 */
export function planNotes(
  plan: PlanLevels,
  orderBook: BookSide | null,
  positionBook: BookSide | null,
  price: number,
  fmt: (p: number) => string,
): BookNote[] {
  const notes: BookNote[] = [];
  const long = plan.direction === 'long';
  const risk = Math.abs(plan.entry - plan.stop);
  if (orderBook && risk > 0) {
    const cl = bookClusters(orderBook, price, 4);
    const w = orderBook.bucketWidth;
    // 損切り付近の逆指値（買い=下の売りの逆指値 / 売り=上の買いの逆指値）
    const stopKind: ClusterKind = long ? 'sell_stop' : 'buy_stop';
    const nearStop = cl.find((c) => c.kind === stopKind && Math.abs(c.price + w / 2 - plan.stop) <= risk * 0.25);
    if (nearStop) {
      const beyond = long ? nearStop.price - w : nearStop.price + 2 * w;
      notes.push({
        tone: 'warn',
        text: `損切り ${fmt(plan.stop)} の近く（${fmt(nearStop.price)}）に${long ? '売り' : '買い'}の逆指値が溜まっています（平均の${nearStop.ratio}倍）。狩られやすいので、${fmt(beyond)} より外に置くのも手です。`,
      });
    }
    // エントリーと目標の間の反対向きの指値（買い=上の売り指値 / 売り=下の買い指値）
    const wallKind: ClusterKind = long ? 'sell_limit' : 'buy_limit';
    const wall = cl
      .filter((c) => c.kind === wallKind && (long ? c.price > plan.entry && c.price < plan.target : c.price + w < plan.entry && c.price + w > plan.target))
      .sort((a, b) => Math.abs(a.price - plan.entry) - Math.abs(b.price - plan.entry))[0];
    if (wall) {
      notes.push({
        tone: 'warn',
        text: `目標までの途中 ${fmt(wall.price)} に${long ? '売り' : '買い'}指値の壁（平均の${wall.ratio}倍）。跳ね返されやすいので、その手前で一部利確を。`,
      });
    }
    // エントリーと損切りの間の順方向の指値（支え）
    const supKind: ClusterKind = long ? 'buy_limit' : 'sell_limit';
    const sup = cl.find((c) => c.kind === supKind && (long ? c.price < plan.entry && c.price > plan.stop : c.price > plan.entry && c.price < plan.stop));
    if (sup) {
      notes.push({
        tone: 'good',
        text: `エントリーと損切りの間 ${fmt(sup.price)} に${long ? '買い' : '売り'}指値の${long ? '支え' : '重し'}（平均の${sup.ratio}倍）。そこまでの押し${long ? '' : '（戻り）'}は止まりやすい。`,
      });
    }
  }
  if (positionBook) {
    const sk = positionSkew(positionBook, price);
    if (sk && (sk.longPct >= 65 || sk.shortPct >= 65)) {
      const crowdedLong = sk.longPct >= 65;
      const same = crowdedLong === long;
      notes.push({
        tone: same ? 'warn' : 'info',
        text: `保有ポジションは${crowdedLong ? '買い' : '売り'}が ${crowdedLong ? sk.longPct : sk.shortPct}% と片寄り。${
          same ? '同じ向きの人が多く、投げ（損切り）で逆に振れやすい点に注意。' : '逆張り目線では、このプランの向きに追い風。'
        }`,
      });
    }
  }
  return notes;
}
