// 東京・ロンドン・ニューヨーク時間の動きの予想（TF分析ページ）。純関数。Worker の /sessions と画面で共有する。
// 材料:
//   ① 出来高の抵抗線: 価格帯別出来高（ボリュームプロファイル）の POC（最多）・VAH/VAL（出来高70%帯の上限/下限）・HVN（山）
//      先物の出来高があるペアは出来高で、無いペア（クロス円）は滞在時間（各価格帯にいた時間）で代用する
//   ② セッションのくせ（直近1か月の1時間足）: 平均値幅・上げで終わる割合・前のセッションの高安を抜ける割合・出来高の割合
//   ③ いまの流れ（1時間足のダウ理論の向き）
//   ④ 高値・安値: 前日の高値/安値・今日の高値/安値・直前に終わったセッションの高値/安値（例「東京高値」）
//   ⑤ ストキャスティクス（1時間足）: 買われすぎ/売られすぎ・%K と %D の交差
// 予想: 各セッションで動きそうな範囲（平均値幅を流れの向きに寄せる）に、どの線が入るかで
//   「試して止まる」「抜けて次の線へ」「線の間で往復」などのシナリオと一言を出す。
//   出来高の線と高値・安値が近く重なる線は「強い線」とみなし、抜けにくくする。
//   流れの向きにストキャスが行き過ぎ（上昇で 80 以上・下降で 20 以下）なら、抜けるシナリオを「止まる」に弱める。
//   理由は短いタグ（reasons）で返す。※投資助言ではない参考情報。
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

// 線の種類: 出来高（POC・VAH・VAL・山）と、高値・安値（前日・今日・直前のセッション）
export type VolumeLevelKind = 'poc' | 'vah' | 'val' | 'hvn' | 'pdh' | 'pdl' | 'tdh' | 'tdl' | 'ssh' | 'ssl';
export interface VolumeLevel {
  kind: VolumeLevelKind;
  price: number;
  label?: string; // 表示名の上書き（例「東京高値」）
}
export const LEVEL_LABEL: Record<VolumeLevelKind, string> = {
  poc: 'POC',
  vah: 'VAH',
  val: 'VAL',
  hvn: '山',
  pdh: '前日高値',
  pdl: '前日安値',
  tdh: '今日高値',
  tdl: '今日安値',
  ssh: '直前高値',
  ssl: '直前安値',
};
export const isVolumeKind = (k: VolumeLevelKind) => k === 'poc' || k === 'vah' || k === 'val' || k === 'hvn';
export const levelName = (l: VolumeLevel) => l.label ?? LEVEL_LABEL[l.kind];

/** /sessions の応答。 */
export interface SessionsPayload {
  instrument: string;
  currentRate: number;
  stats: SessionStat[];
  levels: VolumeLevel[];
  levelSource: 'volume' | 'time'; // volume = 先物の出来高 / time = 滞在時間（出来高が無いペア）
  refs?: VolumeLevel[]; // 高値・安値（前日・今日・直前のセッション）。古い Worker では無い
  generatedAt: number;
}

/**
 * ④ 高値・安値の線。FX の1日は NY 17時で切り替わるので、NY 時間を 7 時間進めた日付で日を分ける。
 *   前日の高値/安値・今日の高値/安値（ここまで）・直前に終わったセッションの高値/安値。
 */
export function priceRefs(bars: HourBar[], now: Date = new Date()): VolumeLevel[] {
  if (!bars.length) return [];
  const fxDay = (t: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000 + 7 * 3_600_000));
  const days = new Map<string, { high: number; low: number }>();
  for (const b of bars) {
    const k = fxDay(b.t);
    const d = days.get(k);
    if (!d) days.set(k, { high: b.high, low: b.low });
    else {
      d.high = Math.max(d.high, b.high);
      d.low = Math.min(d.low, b.low);
    }
  }
  const keys = [...days.keys()].sort();
  const today = fxDay(now.getTime() / 1000);
  const out: VolumeLevel[] = [];
  const cur = days.get(today);
  const prevKey = [...keys].reverse().find((k) => k < today);
  const prev = prevKey ? days.get(prevKey) : undefined;
  if (prev) out.push({ kind: 'pdh', price: prev.high }, { kind: 'pdl', price: prev.low });
  if (cur) out.push({ kind: 'tdh', price: cur.high }, { kind: 'tdl', price: cur.low });
  // 直前に終わったセッション（いま開いていないもののうち、いちばん新しいまとまり）
  const nowSec = now.getTime() / 1000;
  const blocks = sessionBlocks(bars).filter((b) => !isSessionOpen(SESSION_DEF[b.key], now) || b.start < nowSec - 12 * 3600);
  const last = blocks[blocks.length - 1];
  if (last) {
    const label = SESSION_DEF[last.key].label;
    out.push({ kind: 'ssh', price: last.high, label: `${label}高値` }, { kind: 'ssl', price: last.low, label: `${label}安値` });
  }
  return out;
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
  reasons: string[]; // 判断の理由の短いタグ（例「前日高値と重なる」「ストキャス 85 買われすぎ」）
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
  levels: VolumeLevel[]; // 出来高の線と高値・安値の線（refs）をまとめて渡す
  bias: TrendBias;
  stoch?: { k: number; d: number } | null; // 1時間足のストキャス（無ければ考慮しない）
  now?: Date;
}): SessionForecast[] {
  const now = i.now ?? new Date();
  const fmt = (p: number) => p.toFixed(i.digits);
  const name = (l: VolumeLevel) => `${levelName(l)} ${fmt(l.price)}`;
  // ⑤ ストキャス: 流れの向きに行き過ぎていれば、その向きへの抜けは弱める。%K と %D の交差は向きの変わり目のサイン。
  const k = i.stoch?.k ?? null;
  const d = i.stoch?.d ?? null;
  const overbought = k != null && k >= 80;
  const oversold = k != null && k <= 20;
  const crossDown = k != null && d != null && k < d && k >= 60; // 高い位置で下向きに交差
  const crossUp = k != null && d != null && k > d && k <= 40; // 低い位置で上向きに交差
  const stochTag = overbought ? `ストキャス ${Math.round(k!)} 買われすぎ` : oversold ? `ストキャス ${Math.round(k!)} 売られすぎ` : null;
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
    // 強い線: 出来高の線と高値・安値が、平均値幅の 15% 以内で重なっているもの
    const near = reach * 0.15;
    const overlapWith = (l: VolumeLevel): VolumeLevel | null =>
      i.levels.find((o) => o !== l && isVolumeKind(o.kind) !== isVolumeKind(l.kind) && Math.abs(o.price - l.price) <= near) ?? null;
    const reasons: string[] = [];
    const strongNote = (l: VolumeLevel | null) => {
      const o = l ? overlapWith(l) : null;
      if (l && o) reasons.push(`${isVolumeKind(l.kind) ? levelName(o) : levelName(l)}と${isVolumeKind(l.kind) ? levelName(l) : levelName(o)}が重なる`);
      return !!o;
    };
    const breaksBase = st.breakPrevPct >= 60; // 前のセッションの高安を抜けやすいセッション
    let scenario: SessionScenarioKind;
    let headline: string;
    let target: VolumeLevel | null = null;
    if (i.bias !== 'down' && upIn && (i.bias === 'up' || !downIn)) {
      const nextUp = above.find((l) => l.price > upIn.price) ?? null;
      const strong = strongNote(upIn);
      const stochAgainst = overbought || crossDown;
      if (stochAgainst && stochTag) reasons.push(`${stochTag} → 上は伸びにくい`);
      else if (crossDown) reasons.push('ストキャスが下向きに交差');
      const breaks = breaksBase && !stochAgainst && (!strong || st.breakPrevPct >= 75);
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
      const strong = strongNote(downIn);
      const stochAgainst = oversold || crossUp;
      if (stochAgainst && stochTag) reasons.push(`${stochTag} → 下は伸びにくい`);
      else if (crossUp) reasons.push('ストキャスが上向きに交差');
      const breaks = breaksBase && !stochAgainst && (!strong || st.breakPrevPct >= 75);
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
      strongNote(upIn);
      strongNote(downIn);
      if (stochTag) reasons.push(stochTag);
    } else {
      if (stochTag) reasons.push(stochTag);
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
      reasons: reasons.slice(0, 2),
      stat: st,
    };
  });
}
