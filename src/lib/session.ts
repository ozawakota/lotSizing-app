// FX市場セッション（東京・ロンドン・ニューヨーク）の開場判定と状況テキスト。
// AIbot(/chat) のコンテキストに「現在どのセッションが開いているか」を渡すために使う純関数。
// タイムゾーン/DST は Intl(timeZone) が自動処理する（App.tsx の世界時計と同じBabyPips基準）。

export interface MarketSession {
  label: string;
  timeZone: string;
  openHour: number; // 現地時間の開場時（時）
  closeHour: number; // 現地時間の閉場時（時）
}

export const MARKET_SESSIONS: MarketSession[] = [
  { label: '東京', timeZone: 'Asia/Tokyo', openHour: 9, closeHour: 18 },
  { label: 'ロンドン', timeZone: 'Europe/London', openHour: 8, closeHour: 17 },
  { label: 'ニューヨーク', timeZone: 'America/New_York', openHour: 8, closeHour: 17 },
];

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// 指定タイムゾーンでの「時」と「曜日(0=日)」を返す。
function localParts(timeZone: string, at: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  if (hour === 24) hour = 0; // 一部環境で深夜0時を 24 と返すため正規化
  const weekday = WEEKDAY_INDEX[parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'] ?? 1;
  return { hour, weekday };
}

/** そのセッションが `at` 時点で開場中か（平日かつ現地 open〜close 時）。 */
export function isSessionOpen(session: MarketSession, at: Date): boolean {
  const { hour, weekday } = localParts(session.timeZone, at);
  const isWeekday = weekday >= 1 && weekday <= 5;
  return isWeekday && hour >= session.openHour && hour < session.closeHour;
}

/** AIbot に渡す市場セッション状況テキスト（現在時刻JST＋各セッションの開閉＋重複注記）。 */
export function sessionStatusText(now: Date): string {
  const jst = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const statuses = MARKET_SESSIONS.map((s) => `${s.label}:${isSessionOpen(s, now) ? '開場中' : '閉場'}`);
  const openCount = MARKET_SESSIONS.filter((s) => isSessionOpen(s, now)).length;
  const overlap = openCount >= 2 ? '（セッション重複中＝流動性・ボラティリティ高めになりやすい）' : '';
  return `【市場セッション】現在 ${jst} JST｜${statuses.join(' ')}${overlap}`;
}
