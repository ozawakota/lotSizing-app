// 東京・ロンドン・ニューヨーク時間の動きの予想（TF分析ページ）。純関数。Worker の /sessions と画面で共有する。
// 材料:
//   ① 出来高の抵抗線: 価格帯別出来高（ボリュームプロファイル）の POC（最多）・VAH/VAL（出来高70%帯の上限/下限）・HVN（山）
//      先物の出来高があるペアは出来高で、無いペア（クロス円）は滞在時間（各価格帯にいた時間）で代用する
//   ② セッションのくせ（直近1か月の1時間足）: 平均値幅・上げで終わる割合・前のセッションの高安を抜ける割合・出来高の割合
//   ③ いまの流れ（1時間足のダウ理論の向き）
// 予想: 各セッションで動きそうな範囲（平均値幅を流れの向きに寄せる）に、どの抵抗線が入るかで
//   「試して止まる」「抜けて次の抵抗線へ」「抵抗線の間で往復」などのシナリオと一言を出す。※投資助言ではない参考情報。
import { isSessionOpen, MARKET_SESSIONS, type MarketSession } from './session';

export type SessionKey = 'tokyo' | 'london' | 'ny';
export const SESSION_KEYS: SessionKey[] = ['tokyo', 'london', 'ny'];
const SESSION_DEF: Record<SessionKey, MarketSession> = {
  tokyo: MARKET_SESSIONS[0],
  london: MARKET_SESSIONS[1],
  ny: MARKET_SESSIONS[2],
};

export interface HourBar {
  t: number; // UNIX 秒（足の始まり）
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number; // 出来高（無ければ undefined）
}

export interface SessionStat {
  key: SessionKey;
  label: string;
  samples: number; // 集計できた日数
  avgRangePips: number; // 平均値幅（高値−安値）
  upPct: number; // 上げ（終値＞始値）で終わった割合 %
  breakPrevPct: number; // 直前のセッションの高値か安値を抜けた割合 %
  volumeShare: number | null; // 3セッション合計に対する出来高の割合 %（出来高が無ければ null）
}

export type VolumeLevelKind = 'poc' | 'vah' | 'val' | 'hvn';
export interface VolumeLevel {
  kind: VolumeLevelKind;
  price: number;
}
export const LEVEL_LABEL: Record<VolumeLevelKind, string> = { poc: 'POC', vah: 'VAH', val: 'VAL', hvn: '山' };

/** /sessions の応答。 */
export interface SessionsPayload {
  instrument: string;
  currentRate: number;
  stats: SessionStat[];
  levels: VolumeLevel[];
  levelSource: 'volume' | 'time'; // volume = 先物の出来高 / time = 滞在時間（出来高が無いペア）
  generatedAt: number;
}

/** 足がどのセッションに入るか（DST は Intl が処理。ロンドンと NY の重なりは両方に入る）。 */
const sessionsOfBar = (t: number): SessionKey[] => SESSION_KEYS.filter((k) => isSessionOpen(SESSION_DEF[k], new Date(t * 1000)));

/** そのセッションの現地の日付（同じ日のまとまりを作るため）。 */
const localDay = (key: SessionKey, t: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: SESSION_DEF[key].timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));

interface SessionBlock {
  key: SessionKey;
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  hasVolume: boolean;
  bars: number;
}

/** 1時間足（古い順）を「セッション×日」のまとまりにする（3本未満のまとまりは捨てる）。 */
export function sessionBlocks(bars: HourBar[]): SessionBlock[] {
  const map = new Map<string, SessionBlock>();
  for (const b of bars) {
    for (const key of sessionsOfBar(b.t)) {
      const id = `${key}:${localDay(key, b.t)}`;
      const cur = map.get(id);
      const vol = typeof b.volume === 'number' && b.volume > 0 ? b.volume : 0;
      if (!cur) {
        map.set(id, { key, start: b.t, open: b.open, high: b.high, low: b.low, close: b.close, volume: vol, hasVolume: vol > 0, bars: 1 });
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += vol;
        cur.hasVolume ||= vol > 0;
        cur.bars += 1;
      }
    }
  }
  return [...map.values()].filter((s) => s.bars >= 3).sort((a, b) => a.start - b.start);
}

/** ② セッションのくせ（直近 maxDays 日ぶん）。 */
export function sessionStats(bars: HourBar[], pip: number, maxDays = 20): SessionStat[] {
  const blocks = sessionBlocks(bars);
  const out: SessionStat[] = [];
  const avgVol: Partial<Record<SessionKey, number>> = {};
  for (const key of SESSION_KEYS) {
    const mine = blocks.filter((b) => b.key === key).slice(-maxDays);
    if (!mine.length) continue;
    let broke = 0;
    let comparable = 0;
    for (const b of mine) {
      // 直前のセッション（自分より前に始まった、別のセッションのまとまりのうち最後のもの）
      const prev = [...blocks].reverse().find((o) => o.start < b.start && o.key !== key);
      if (!prev) continue;
      comparable++;
      if (b.high > prev.high || b.low < prev.low) broke++;
    }
    const withVol = mine.filter((b) => b.hasVolume);
    if (withVol.length >= Math.ceil(mine.length / 2)) avgVol[key] = withVol.reduce((s, b) => s + b.volume, 0) / withVol.length;
    out.push({
      key,
      label: SESSION_DEF[key].label,
      samples: mine.length,
      avgRangePips: Math.round((mine.reduce((s, b) => s + (b.high - b.low), 0) / mine.length / pip) * 10) / 10,
      upPct: Math.round((mine.filter((b) => b.close > b.open).length / mine.length) * 100),
      breakPrevPct: comparable ? Math.round((broke / comparable) * 100) : 50,
      volumeShare: null,
    });
  }
  const totalVol = SESSION_KEYS.reduce((s, k) => s + (avgVol[k] ?? 0), 0);
  if (totalVol > 0 && SESSION_KEYS.every((k) => avgVol[k] != null)) {
    for (const st of out) st.volumeShare = Math.round(((avgVol[st.key] ?? 0) / totalVol) * 100);
  }
  return out;
}

export type SessionStatus = 'open' | 'next' | 'later';
export type SessionScenarioKind = 'break_up' | 'break_down' | 'stall_up' | 'stall_down' | 'range' | 'drift_up' | 'drift_down';

export interface SessionForecast {
  key: SessionKey;
  label: string;
  status: SessionStatus;
  startsInH: number | null; // 開くまでの時間（開催中は null）
  low: number; // 動きそうな範囲
  high: number;
  scenario: SessionScenarioKind;
  headline: string; // 一言（例「VAH 151.400 を試す → 抜ければ 151.650」）
  target: VolumeLevel | null; // 向かう先の抵抗線
  stat: SessionStat;
}

export type TrendBias = 'up' | 'down' | 'range';

/** 次に始まるまでの時間（時間。開催中なら 0）。 */
function hoursUntilOpen(key: SessionKey, now: Date): number {
  for (let h = 0; h <= 72; h++) {
    if (isSessionOpen(SESSION_DEF[key], new Date(now.getTime() + h * 3_600_000))) return h;
  }
  return 99;
}

/**
 * ③ これからの東京・ロンドン・NY の動きを予想する（開催中→次の順）。
 * levels は現物の基準の出来高の抵抗線、bias は 1時間足の流れ。
 */
export function forecastSessions(i: {
  price: number;
  pip: number;
  digits: number;
  stats: SessionStat[];
  levels: VolumeLevel[];
  bias: TrendBias;
  now?: Date;
}): SessionForecast[] {
  const now = i.now ?? new Date();
  const fmt = (p: number) => p.toFixed(i.digits);
  const name = (l: VolumeLevel) => `${LEVEL_LABEL[l.kind]} ${fmt(l.price)}`;
  const order = i.stats
    .map((st) => ({ st, h: hoursUntilOpen(st.key, now) }))
    .sort((a, b) => a.h - b.h);
  const firstLater = order.find((o) => o.h > 0);
  return order.map(({ st, h }) => {
    const reach = st.avgRangePips * i.pip;
    // 流れの向きに寄せた「動きそうな範囲」（上げで終わる割合も少し反映）
    const tilt = i.bias === 'up' ? 0.15 : i.bias === 'down' ? -0.15 : 0;
    const lean = Math.max(-0.25, Math.min(0.25, tilt + (st.upPct - 50) / 200));
    const high = i.price + reach * (0.5 + lean);
    const low = i.price - reach * (0.5 - lean);
    const above = i.levels.filter((l) => l.price > i.price).sort((a, b) => a.price - b.price);
    const below = i.levels.filter((l) => l.price < i.price).sort((a, b) => b.price - a.price);
    const upIn = above.find((l) => l.price <= high) ?? null;
    const downIn = below.find((l) => l.price >= low) ?? null;
    const breaks = st.breakPrevPct >= 60; // 前のセッションの高安を抜けやすいセッション
    let scenario: SessionScenarioKind;
    let headline: string;
    let target: VolumeLevel | null = null;
    if (i.bias !== 'down' && upIn && (i.bias === 'up' || !downIn)) {
      const nextUp = above.find((l) => l.price > upIn.price) ?? null;
      if (breaks && i.bias === 'up') {
        scenario = 'break_up';
        target = nextUp ?? upIn;
        headline = `${name(upIn)} を上抜け${nextUp ? ` → ${name(nextUp)}` : ''}`;
      } else {
        scenario = 'stall_up';
        target = upIn;
        headline = `${name(upIn)} を試して止まりやすい`;
      }
    } else if (i.bias !== 'up' && downIn && (i.bias === 'down' || !upIn)) {
      const nextDown = below.find((l) => l.price < downIn.price) ?? null;
      if (breaks && i.bias === 'down') {
        scenario = 'break_down';
        target = nextDown ?? downIn;
        headline = `${name(downIn)} を下抜け${nextDown ? ` → ${name(nextDown)}` : ''}`;
      } else {
        scenario = 'stall_down';
        target = downIn;
        headline = `${name(downIn)} を試して止まりやすい`;
      }
    } else if (upIn && downIn) {
      scenario = 'range';
      headline = `${fmt(downIn.price)}〜${fmt(upIn.price)} を往復`;
    } else {
      scenario = i.bias === 'down' ? 'drift_down' : i.bias === 'up' ? 'drift_up' : 'range';
      headline =
        scenario === 'range'
          ? `近くに抵抗線なし・±${(st.avgRangePips / 2).toFixed(0)}pips 程度`
          : `${scenario === 'drift_up' ? '上' : '下'}へ 約${st.avgRangePips.toFixed(0)}pips（近くに抵抗線なし）`;
    }
    return {
      key: st.key,
      label: st.label,
      status: h === 0 ? 'open' : firstLater && firstLater.st.key === st.key ? 'next' : 'later',
      startsInH: h === 0 ? null : h,
      low,
      high,
      scenario,
      headline,
      target,
      stat: st,
    };
  });
}
