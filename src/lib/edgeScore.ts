// RR好機ボード（エッジページ）の精度を上げる純関数。Worker の /ranking とテストで共有する。
//  1) fitSetupToZones: 構造RRの損切り・目標を抵抗帯に合わせる
//     - 損切りが支持帯（ショートは抵抗帯）の中や縁にあると、帯で反発する前に刈られやすいので帯の外へずらす
//     - 目標までの途中に★2以上の抵抗帯（ショートは支持帯）があれば、目標をその帯の手前に縮める
//  2) edgeScore: 総合スコア（0–100）と内訳。50 を基準に、ダウ理論・上位足の向き・RR・損切りの強さ・
//     エントリー位置（帯との位置関係）・ローソク足パターン・タイミング・オシレーター・AI（Jev）を加減点する。
// ※投資助言ではない参考情報。
import { pipSize, type RrSetup, type SlDirection, type SlTimeframe } from './stoploss';
import type { SrZone } from './srZones';
import { dowDirection, type DowAnalysis } from './dow';
import type { EntryKind } from './entrySignal';

/** 準好機の下限 RR（RR_MIN 未満〜これ以上は「準好機」として別枠で表示）。 */
export const NEAR_RR_MIN = 2.0;

const STOP_BUFFER_ATR = 0.1; // 帯の外へずらすときのバッファ
const STOP_EDGE_ATR = 0.25; // 損切りが帯の上端（ショートは下端）からこの距離以内なら「縁」とみなす

export interface ZoneFit {
  setup: RrSetup;
  stopNote: string | null; // 例「損切りを支持帯★3の外へ」
  targetNote: string | null; // 例「目標を抵抗帯★2の手前に」
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * 損切り・目標を抵抗帯に合わせ、RR を計算し直す。zones は minScore 以上の帯（buildSrZones の keepAll）。
 * 現在値を含む帯は「いま居る帯」なので、損切り・目標の調整には使わない。
 */
export function fitSetupToZones(
  setup: RrSetup,
  zones: { res: SrZone[]; sup: SrZone[] },
  atr: number,
  instrument: string,
): ZoneFit {
  const pip = pipSize(instrument);
  const long = setup.direction === 'long';
  const { entry } = setup;
  let { stop, target } = setup;
  let stopNote: string | null = null;
  let targetNote: string | null = null;

  // 損切り: 背後の帯（ロング=支持帯）の中か縁にあれば、帯の外（ロング=下限の下）へ。
  const behind = (long ? zones.sup : zones.res).filter((z) => !z.contains);
  const hit = behind.find((z) =>
    long ? stop > z.low && stop < z.high + atr * STOP_EDGE_ATR : stop < z.high && stop > z.low - atr * STOP_EDGE_ATR,
  );
  if (hit) {
    stop = long ? hit.low - atr * STOP_BUFFER_ATR : hit.high + atr * STOP_BUFFER_ATR;
    stopNote = `損切りを${long ? '支持帯' : '抵抗帯'}★${hit.stars}の外へ`;
  }

  // 目標: 途中にある最も近い帯（ロング=抵抗帯の下限が entry と target の間）の手前まで。
  const ahead = (long ? zones.res : zones.sup)
    .filter((z) => !z.contains && (long ? z.low > entry && z.low < target : z.high < entry && z.high > target))
    .sort((a, b) => (long ? a.low - b.low : b.high - a.high));
  if (ahead.length) {
    const z = ahead[0];
    target = long ? z.low : z.high;
    targetNote = `目標を${long ? '抵抗帯' : '支持帯'}★${z.stars}の手前に`;
  }

  const riskPips = round1(setup.riskPips + Math.abs(stop - setup.stop) / pip);
  const rewardPips = round1(Math.max(Math.abs(target - entry) / pip - setup.spreadPips, 0));
  const rr = riskPips > 0 ? round1(rewardPips / riskPips) : 0;
  return { setup: { ...setup, stop, target, riskPips, rewardPips, rr }, stopNote, targetNote };
}

export interface ScoreItem {
  label: string; // 例「上位足も上昇（1時間足・4時間足）」
  points: number; // 加点(+)/減点(−)
}

export interface EdgeInputs {
  direction: SlDirection;
  rr: number;
  stopStrength?: number | null; // 損切りラインの強さ 0–100
  dow: DowAnalysis | null; // setup の時間足のダウ理論
  higherDows: { tf: SlTimeframe; dow: DowAnalysis | null }[]; // 上位足のダウ理論
  zones: { res: SrZone[]; sup: SrZone[] }; // setup の時間足の抵抗帯（keepAll）
  atr: number;
  instrument: string;
  pattern: { label: string; dir: 1 | -1 } | null; // 有効なローソク足パターン
  entryKind: EntryKind | null; // 押し目/戻り・様子見・反転警戒
  rsi: number | null;
  stochK: number | null;
  jevProb: number | null; // AI（Jev）のその方向へのブレイク確率（0–100）。取れなければ null
}

const TF_JA: Record<SlTimeframe, string> = { '15m': '15分足', '30m': '30分足', '1h': '1時間足', '4h': '4時間足' };
const PHASE_JA: Record<DowAnalysis['phase'], string> = {
  extending: '高値/安値を更新中',
  pullback: '押し目/戻りの形成中',
  continuing: 'トレンド方向へ再開',
  broken: '転換の兆し',
  none: '',
};

/** 総合スコア（0–100）と内訳（点数の大きい順）。50 が中立。 */
export function edgeScore(i: EdgeInputs): { score: number; items: ScoreItem[] } {
  const items: ScoreItem[] = [];
  const add = (label: string, points: number) => {
    if (points !== 0) items.push({ label, points });
  };
  const long = i.direction === 'long';
  const want = long ? 'long' : 'short';
  const pip = pipSize(i.instrument);

  // ダウ理論（setup の時間足）: そろったスイングが多いほど・押し目/戻りからの再開ほど加点。
  if (i.dow) {
    const s = i.dow.strength;
    add(`ダウ: スイング${s}つそろう`, s >= 3 ? 6 : s === 2 ? 3 : 0);
    if (i.dow.phase === 'pullback' || i.dow.phase === 'continuing') add(`ダウ: ${PHASE_JA[i.dow.phase]}`, 4);
  }

  // 上位足のダウの向き: 同じ向きなら加点、逆向きなら減点（上位足の数で割って ±15 に収める）。
  const higher = i.higherDows.filter((h) => h.dow);
  if (higher.length) {
    const same = higher.filter((h) => dowDirection(h.dow) === want).map((h) => TF_JA[h.tf]);
    const opp = higher.filter((h) => h.dow?.trend === (long ? 'down' : 'up')).map((h) => TF_JA[h.tf]);
    if (same.length) add(`上位足も${long ? '上昇' : '下降'}（${same.join('・')}）`, Math.round((15 * same.length) / higher.length));
    if (opp.length) add(`上位足が逆向き（${opp.join('・')}）`, -Math.round((15 * opp.length) / higher.length));
  }

  // RR: 2.5→0点、4.0以上→+8。準好機（2.5未満）は減点。
  add(`RR 1:${i.rr.toFixed(1)}`, i.rr >= 2.5 ? Math.round(Math.min((i.rr - 2.5) / 1.5, 1) * 8) : Math.round((i.rr - 2.5) * 10));

  // 損切りラインの強さ（タッチ回数・上位足との一致など）。
  if (i.stopStrength != null) add(`損切りラインの強さ ${i.stopStrength}`, Math.round(((i.stopStrength - 50) / 50) * 6));

  // エントリー位置: 背後に★2以上の帯があれば加点、すぐ前（0.5 ATR 以内）に帯があれば減点。
  if (i.atr > 0) {
    const behind = (long ? i.zones.sup : i.zones.res).find((z) => z.contains || z.distancePips * pip <= i.atr);
    const front = (long ? i.zones.res : i.zones.sup).find((z) => z.contains || z.distancePips * pip <= i.atr * 0.5);
    if (behind) add(`${long ? '支持帯' : '抵抗帯'}★${behind.stars}の${long ? '上' : '下'}で入れる`, 6);
    if (front) add(`すぐ${long ? '上に抵抗帯' : '下に支持帯'}★${front.stars}`, -6);
  }

  // ローソク足パターン（確定・ライン上・質60以上の有効なもの）。
  if (i.pattern) {
    const aligned = (i.pattern.dir === 1) === long;
    add(aligned ? `${i.pattern.label}が裏付け` : `逆向きの${i.pattern.label}`, aligned ? 8 : -12);
  }

  // タイミング（移動平均・ストキャス・パターン）。
  if (i.entryKind === 'pullback') add(long ? 'タイミング: 押し目' : 'タイミング: 戻り', 6);
  if (i.entryKind === 'caution') add('タイミング: 反転警戒', -10);

  // オシレーター: 順方向に行き過ぎていれば減点（反転警戒で減点済みなら重ねない）。
  if (i.entryKind !== 'caution') {
    const over = long ? (i.rsi ?? 0) >= 70 || (i.stochK ?? 0) >= 85 : (i.rsi ?? 100) <= 30 || (i.stochK ?? 100) <= 15;
    if (over) add(long ? 'RSI/ストキャスが買われすぎ' : 'RSI/ストキャスが売られすぎ', -6);
  }

  // AI（Jev）のブレイク確率: 50% を中立に ±15。
  if (i.jevProb != null) add(`AI: ${long ? '上抜け' : '下抜け'}確率 ${Math.round(i.jevProb)}%`, Math.round((i.jevProb - 50) * 0.3));

  const score = Math.max(0, Math.min(100, Math.round(50 + items.reduce((a, b) => a + b.points, 0))));
  items.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, items };
}
