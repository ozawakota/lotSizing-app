// FX市場セッション（東京・ロンドン・ニューヨーク）の現地時刻とオープン状態を
// 1秒ごとに更新して表示する。オープン判定は各セッションの現地時間で行うため、
// DST（英BST・米EDT）は Intl により自動で吸収される。
// ロット計算ページ発祥。資金管理以外の各ページ共通ヘッダー下で使う。
import { useEffect, useState, type FC } from 'react';

type MarketSession = {
  label: string;
  timeZone: string;
  openHour: number; // 現地オープン時刻（時, 24h）
  closeHour: number; // 現地クローズ時刻（時, 24h）
};

// BabyPips標準のセッション時間（各セッションの現地時間で定義）
const MARKET_SESSIONS: MarketSession[] = [
  { label: '東京', timeZone: 'Asia/Tokyo', openHour: 9, closeHour: 18 },
  { label: 'ロンドン', timeZone: 'Europe/London', openHour: 8, closeHour: 17 },
  { label: 'ニューヨーク', timeZone: 'America/New_York', openHour: 8, closeHour: 17 },
];

// 指定タイムゾーンにおける現地の「時」と「曜日」を取り出す
const getLocalHourAndWeekday = (timeZone: string, at: Date): { hour: number; weekday: string } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return { hour, weekday };
};

// セッションがオープン中か判定する。FX市場は土日クローズのため、
// 各セッションの現地曜日が月〜金かつ営業時間内のときのみオープン。
const isSessionOpen = (session: MarketSession, at: Date): boolean => {
  const { hour, weekday } = getLocalHourAndWeekday(session.timeZone, at);
  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
  return isWeekday && hour >= session.openHour && hour < session.closeHour;
};

const formatSessionTime = (timeZone: string, at: Date): string =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(at);

// 指定タイムゾーンのUTCからのオフセット（分, 東が正）を求める。
// 現地の壁掛け時計の時刻をUTCとして解釈し、実際のUTC時刻との差を取ることで算出する。
const getTimeZoneOffsetMinutes = (timeZone: string, at: Date): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
};

// そのタイムゾーンがDST（サマータイム）を採用しているか（夏/冬の概念があるか）。
// 1月と7月でオフセットが異なればDST採用地域とみなす（東京は年中同じなので false）。
const observesDaylightSaving = (timeZone: string): boolean => {
  const year = new Date().getFullYear();
  const janOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 0, 1)));
  const julOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 6, 1)));
  return janOffset !== julOffset;
};

// そのタイムゾーンが現在DSTを実施中か判定する。北半球では標準時（冬）が
// オフセット最小・DST（夏）が最大になる性質を使い、現在が標準時でなければDSTとみなす。
const isDaylightSavingTime = (timeZone: string, at: Date): boolean => {
  const year = at.getFullYear();
  const janOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 0, 1)));
  const julOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 6, 1)));
  if (janOffset === julOffset) return false; // DST非採用地域
  const standardOffset = Math.min(janOffset, julOffset);
  return getTimeZoneOffsetMinutes(timeZone, at) !== standardOffset;
};

// FX市場の週の取引時間（日本時間）を求める。基準はニューヨーク市場で、
// 週明けは日曜17:00 ET・週末は金曜17:00 ET。NYがDST（EDT）なら日本時間は1時間早まる。
const getWeeklyTradingHoursJst = (at: Date): { hour: number; isNyDst: boolean } => {
  const nyOffsetHours = getTimeZoneOffsetMinutes('America/New_York', at) / 60;
  // NY 17:00 を日本時間（UTC+9）へ変換（翌日の時刻になる）
  const hour = (((17 + (9 - nyOffsetHours)) % 24) + 24) % 24;
  return { hour, isNyDst: isDaylightSavingTime('America/New_York', at) };
};

const WorldClock: FC = () => {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { hour: weeklyHour, isNyDst } = getWeeklyTradingHoursJst(now);

  return (
    <div className="mt-1">
      <div className="flex justify-center gap-5">
        {MARKET_SESSIONS.map((session) => {
          const open = isSessionOpen(session, now);
          const hasDst = observesDaylightSaving(session.timeZone);
          const dst = hasDst && isDaylightSavingTime(session.timeZone, now);
          return (
            <div key={session.timeZone} className="text-center">
              <div className="flex items-center justify-center gap-1">
                <span
                  aria-hidden="true"
                  className={`inline-block h-2 w-2 rounded-full ${
                    open ? 'bg-green-500' : 'border border-gray-400'
                  }`}
                />
                <span className={`text-sm ${open ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>
                  {session.label}
                </span>
              </div>
              <div
                className={`font-mono tabular-nums text-lg leading-tight ${
                  open ? 'text-gray-800' : 'text-gray-400'
                }`}
              >
                {formatSessionTime(session.timeZone, now)}
              </div>
              {hasDst ? (
                <span
                  className={`inline-block mt-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                    dst ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'
                  }`}
                >
                  {dst ? '夏時間' : '冬時間'}
                </span>
              ) : (
                <span className="inline-block mt-0.5 px-1.5 py-0.5 text-[10px] text-gray-400">
                  DSTなし
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-center text-xs text-gray-500 mt-1">
        今週の取引時間（日本時間）: 月 {weeklyHour}:00 〜 土 {weeklyHour}:00
        <span className="ml-1">{isNyDst ? '(NY夏時間)' : '(NY冬時間)'}</span>
      </p>
    </div>
  );
};

export default WorldClock;
