// 為替のアノマリー（経験則）を日付・経済指標カレンダーから判定する純ロジック。Worker とフロントで共有。
// - 日付: 五十日（ごとうび）の仲値、月末・四半期末のロンドンフィックス、季節性（3月・4月・8月・1月・12月）
// - 曜日・時間: 週明けの窓開け、週末前のポジション調整
// - 指標: 雇用統計・CPI・中銀の政策金利（ForexFactory の高重要度イベントから）
// いずれも「〜と言われる」経験則で、統計的な裏付けは限定的。判定は JST 基準。
// 日本の祝日は考慮しない（五十日が祝日に当たる場合のずれは反映しない）。
import type { EconEvent } from './news';
import { SIGNAL_PAIRS, type SignalPair } from './signal';

/** up=そのペアが上がりやすい / down=下がりやすい / volatile=方向は不明だが荒れやすい */
export type AnomalyBias = 'up' | 'down' | 'volatile';
export type AnomalyKind = 'calendar' | 'seasonal' | 'session' | 'event';

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  title: string; // 例: 五十日（ごとうび）
  when: string; // 例: 今日 9:55 の仲値まで
  detail: string; // 何が起きやすいと言われるか
  effects: { pair: SignalPair; bias: AnomalyBias }[];
}

const JST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

// JST の暦情報（getUTC* で読む）。
const jst = (t: number) => {
  const d = new Date(t + JST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
};
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isWeekend = (wd: number) => wd === 0 || wd === 6;

const JPY_PAIRS = SIGNAL_PAIRS.filter((p) => p.endsWith('/JPY'));
const pairsWith = (cur: string) => SIGNAL_PAIRS.filter((p) => p.split('/').includes(cur));
const all = (pairs: SignalPair[], bias: AnomalyBias) => pairs.map((pair) => ({ pair, bias }));

/** その JST 日が五十日（5・10・15・20・25日と月末。土日に当たれば直前の金曜）か。 */
export function isGotobi(t: number): boolean {
  const { wd } = jst(t);
  if (isWeekend(wd)) return false;
  // 金曜は、土日に当たる五十日の振替先にもなる。
  const candidates = wd === 5 ? [0, 1, 2] : [0];
  return candidates.some((offset) => {
    const c = jst(t + offset * DAY_MS);
    return c.day % 5 === 0 && c.day <= 25 ? true : c.day === daysInMonth(c.y, c.m);
  });
}

/** その JST 日が月の最終営業日（土日のみ考慮）か。 */
export function isLastBusinessDay(t: number): boolean {
  const { wd, m } = jst(t);
  if (isWeekend(wd)) return false;
  for (let k = 1; k <= 3; k++) {
    const n = jst(t + k * DAY_MS);
    if (!isWeekend(n.wd)) return n.m !== m;
  }
  return false;
}

// 高重要度イベントのうち、アノマリーとして解説するもの（タイトルの一致で判定）。
const EVENT_RULES: { test: (e: EconEvent) => boolean; title: string; detail: string }[] = [
  {
    test: (e) => e.country === 'USD' && /Non-Farm Employment Change/i.test(e.title),
    title: '米雇用統計',
    detail: '発表前はポジション調整で方向感が出にくく、発表直後に大きく動きやすい。結果次第でドルが一方向に走ることが多いと言われる。',
  },
  {
    test: (e) => e.country === 'USD' && /^(Core )?CPI/i.test(e.title),
    title: '米CPI',
    detail: '利下げ・利上げ観測を左右するため、発表直後にドルと金が大きく動きやすい。',
  },
  {
    test: (e) => e.country === 'USD' && /Federal Funds Rate|FOMC Statement/i.test(e.title),
    title: 'FOMC',
    detail: '結果発表と議長会見まで様子見になりやすく、会見中に上下に振れやすい。',
  },
  {
    test: (e) => e.country === 'JPY' && /BOJ Policy Rate|Monetary Policy Statement/i.test(e.title),
    title: '日銀会合',
    detail: '結果発表の時刻が決まっておらず、昼前後に円が急変動しやすい。',
  },
  {
    test: (e) => e.country === 'EUR' && /Main Refinancing Rate|Monetary Policy Statement/i.test(e.title),
    title: 'ECB理事会',
    detail: '声明と総裁会見でユーロが上下に振れやすい。',
  },
  {
    test: (e) => e.country === 'GBP' && /Official Bank Rate/i.test(e.title),
    title: 'BOE政策金利',
    detail: '投票配分のサプライズでポンドが急変動しやすい。',
  },
  {
    test: (e) => ['AUD', 'NZD', 'CAD'].includes(e.country) && /Cash Rate|Overnight Rate/i.test(e.title),
    title: '資源国の中銀会合',
    detail: '結果発表直後に該当通貨が大きく動きやすい。',
  },
];

const fmtEventTime = (t: number) => {
  const d = jst(t);
  return `${d.m}/${d.day} ${String(d.h).padStart(2, '0')}:${String(d.min).padStart(2, '0')}`;
};

/**
 * 現在時刻と経済指標カレンダーから、いま意識されやすいアノマリーを返す。
 * 指標イベントは now から eventWindowHours 時間以内のものだけ。
 */
export function detectAnomalies(now: Date, calendar: EconEvent[] = [], eventWindowHours = 36): Anomaly[] {
  const t = now.getTime();
  const { m, day, wd, h } = jst(t);
  const out: Anomaly[] = [];

  if (isGotobi(t)) {
    const before = h < 10;
    out.push({
      id: 'gotobi',
      kind: 'calendar',
      title: '五十日（ごとうび）',
      when: before ? '今日 9:55 の仲値まで' : '今日（仲値は通過）',
      detail: before
        ? '輸入企業の決済でドル買いが集まりやすく、仲値（9:55）に向けてドル円が上がりやすいと言われる。'
        : '仲値に向けたドル買いが一巡し、その後はドル円が伸び悩む・反落しやすいとも言われる。',
      effects: [{ pair: 'USD/JPY', bias: before ? 'up' : 'down' }],
    });
  }

  if (isLastBusinessDay(t)) {
    const quarter = m % 3 === 0;
    out.push({
      id: 'month-end',
      kind: 'calendar',
      title: quarter ? (m === 3 ? '年度末・四半期末' : '四半期末') : '月末',
      when: '今日 深夜0〜1時のロンドンフィックス前後',
      detail: `${quarter ? '四半期末は特に、' : ''}運用会社の資産配分の調整（リバランス）で、ロンドンフィックスに向けてドルの売買が膨らみやすい。方向は月中の株価の動き次第と言われる。`,
      effects: all(pairsWith('USD'), 'volatile'),
    });
  }

  if (wd === 1 && h < 12) {
    out.push({
      id: 'monday-gap',
      kind: 'session',
      title: '週明けの窓開け',
      when: '月曜の朝',
      detail: '週末のニュースで金曜終値から離れて始まる（窓開け）ことがあり、その後は窓を埋める方向に戻りやすいと言われる。',
      effects: all(SIGNAL_PAIRS, 'volatile'),
    });
  }

  if ((wd === 5 && h >= 21) || (wd === 6 && h < 7)) {
    out.push({
      id: 'weekend-squaring',
      kind: 'session',
      title: '週末前のポジション調整',
      when: '金曜のNY時間',
      detail: '週末をまたぐリスクを避ける手じまいが出やすく、週中のトレンドと逆向きに戻しやすいと言われる。',
      effects: all(SIGNAL_PAIRS, 'volatile'),
    });
  }

  // 季節性（月単位）。JPY ペアの up/down は「円安/円高」に対応。
  if (m === 1) {
    out.push({
      id: 'season-jan',
      kind: 'seasonal',
      title: '1月の円高・金高',
      when: '1月',
      detail: '年初は海外勢のリスク回避で円が買われやすく、金も新年の資金流入で買われやすいと言われる。',
      effects: [...all(JPY_PAIRS, 'down'), { pair: 'XAU/USD', bias: 'up' }],
    });
  } else if (m === 3) {
    out.push({
      id: 'season-mar',
      kind: 'seasonal',
      title: '3月の円高（決算期）',
      when: '3月',
      detail: '日本企業の決算期末に向けて、海外で得た利益を円に戻す動き（レパトリ）が出やすく、円高になりやすいと言われる。',
      effects: all(JPY_PAIRS, 'down'),
    });
  } else if (m === 4) {
    out.push({
      id: 'season-apr',
      kind: 'seasonal',
      title: '4月の円安（新年度）',
      when: '4月',
      detail: '新年度入りで国内の機関投資家が外債投資を再開し、円売りが出やすいと言われる。',
      effects: all(JPY_PAIRS, 'up'),
    });
  } else if (m === 8) {
    out.push({
      id: 'season-aug',
      kind: 'seasonal',
      title: '8月の円高（夏枯れ）',
      when: '8月',
      detail: 'お盆・夏休みで市場参加者が減り、薄い商いの中でリスク回避の円買いが出やすいと言われる。',
      effects: all(JPY_PAIRS, 'down'),
    });
  } else if (m === 12 && day >= 15) {
    out.push({
      id: 'season-dec',
      kind: 'seasonal',
      title: '年末の薄商い',
      when: '12月後半',
      detail: 'クリスマス休暇で流動性が落ち、小さな注文でも急に動きやすいと言われる。',
      effects: all(SIGNAL_PAIRS, 'volatile'),
    });
  }

  // 指標イベント（同じ種類は直近の1件だけ）。
  const seen = new Set<string>();
  for (const e of calendar) {
    const et = new Date(e.date).getTime();
    if (Number.isNaN(et) || et < t - 2 * 60 * 60 * 1000 || et > t + eventWindowHours * 60 * 60 * 1000) continue;
    const rule = EVENT_RULES.find((r) => r.test(e));
    if (!rule || seen.has(rule.title)) continue;
    seen.add(rule.title);
    out.push({
      id: `event-${rule.title}`,
      kind: 'event',
      title: rule.title,
      when: `${fmtEventTime(et)} 発表`,
      detail: rule.detail,
      effects: all(pairsWith(e.country), 'volatile'),
    });
  }
  return out;
}

/** そのペアに関係するアノマリーと、そのペアへの影響。 */
export function anomaliesForPair(anomalies: Anomaly[], pair: SignalPair): { anomaly: Anomaly; bias: AnomalyBias }[] {
  return anomalies.flatMap((a) => {
    const e = a.effects.find((x) => x.pair === pair);
    return e ? [{ anomaly: a, bias: e.bias }] : [];
  });
}

const BIAS_JA: Record<AnomalyBias, string> = { up: '上がりやすい', down: '下がりやすい', volatile: '荒れやすい' };

/** AI プロンプト用のダイジェスト（1アノマリー1行）。 */
export function formatAnomalyDigest(anomalies: Anomaly[]): string {
  return anomalies
    .map((a) => {
      const groups = new Map<AnomalyBias, SignalPair[]>();
      for (const e of a.effects) groups.set(e.bias, [...(groups.get(e.bias) ?? []), e.pair]);
      const effects = [...groups].map(([b, ps]) => `${ps.join('・')}が${BIAS_JA[b]}`).join('、');
      return `- ${a.title}（${a.when}）: ${a.detail} → ${effects}`;
    })
    .join('\n');
}

export { BIAS_JA as ANOMALY_BIAS_LABEL };
