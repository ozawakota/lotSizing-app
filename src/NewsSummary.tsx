// 為替ニュースタブ：ペアごとの売買予測（買い%・トレンド継続/反転・確信度）に、
// ニュースの根拠とアノマリー（五十日・月末・季節性・指標前後などの経験則）の解説を添えて表示する。
// 予測・要約は currency-strength Worker の /news（VITE_NEWS_URL）から取得。
// アノマリーは src/lib/anomaly.ts で「いま」の日時と経済指標カレンダーから毎回判定する（キャッシュに依存しない）。
// 予測はAI推定の参考値であり投資助言ではない（画面にも明記）。
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, ChevronDown, Clock, Newspaper, RefreshCw, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import {
  confidenceLevel,
  signalVerdict,
  sortSignalsByStrength,
  type ConfidenceLevel,
  type PairSignal,
  type SignalVerdict,
  type TrendLabel,
} from '@/lib/signal';
import type { EconEvent } from '@/lib/news';
import { ANOMALY_BIAS_LABEL, anomaliesForPair, detectAnomalies, type Anomaly, type AnomalyBias, type AnomalyKind } from '@/lib/anomaly';

interface NewsPayload {
  generatedAt: number;
  engine: string; // 'workers-ai' | 'jev'
  summary: string;
  signals: PairSignal[];
  items: { title: string; link: string; pubDate: string }[];
  calendar?: EconEvent[]; // 高重要度の経済指標（今日〜今週・対象8通貨）。旧キャッシュには無いため任意
}

const CACHE_KEY = 'news-cache';
const TAB_KEY = 'news-tab';
const SORT_KEY = 'news-sort';

type Tab = 'forecast' | 'calendar' | 'news';
const TABS: { id: Tab; label: string }[] = [
  { id: 'forecast', label: '売買予測' },
  { id: 'calendar', label: '経済指標' },
  { id: 'news', label: 'ニュース' },
];
type SortMode = 'default' | 'strength';

const readLocal = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても表示はそのまま使える
  }
};

const VERDICT: Record<SignalVerdict, { label: string; cls: string; Icon: LucideIcon }> = {
  up: { label: '上昇予想', cls: 'bg-green-50 text-green-700', Icon: ArrowUpRight },
  down: { label: '下落予想', cls: 'bg-red-50 text-red-700', Icon: ArrowDownRight },
  flat: { label: '方向感なし', cls: 'bg-gray-100 text-gray-500', Icon: ArrowRight },
};
const CONF_LABEL: Record<ConfidenceLevel, string> = { high: '高', mid: '中', low: '低' };
const CONF_DOTS: Record<ConfidenceLevel, number> = { high: 3, mid: 2, low: 1 };
const TREND_LABEL: Record<TrendLabel, string> = { continuation: 'トレンド継続', reversal: 'トレンド反転', neutral: 'トレンド中立' };
const TREND_CLASS: Record<TrendLabel, string> = {
  continuation: 'bg-blue-50 text-blue-700',
  reversal: 'bg-amber-50 text-amber-700',
  neutral: 'bg-gray-100 text-gray-500',
};
const KIND_ICON: Record<AnomalyKind, LucideIcon> = { calendar: CalendarDays, seasonal: Sparkles, session: Clock, event: Zap };
const BIAS_STYLE: Record<AnomalyBias, { cls: string; mark: string }> = {
  up: { cls: 'bg-green-50 text-green-700', mark: '↑' },
  down: { cls: 'bg-red-50 text-red-700', mark: '↓' },
  volatile: { cls: 'bg-purple-50 text-purple-700', mark: '⚡' },
};

// リストの既定の余白（左インデント）を確実に消す。Tailwind の基本スタイルは CSS の layer の中にあり、
// layer の外で読み込む CSS（Mobiscroll など）に負けることがあるため、インラインスタイルで指定する。
const LIST_RESET: React.CSSProperties = { margin: 0, padding: 0, listStyle: 'none' };

// JST の日付キー（YYYY-MM-DD）と、見出し用の表示（今日 / 明日 / 10/29(水)）。
const jstDateKey = (t: number): string => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
const dayLabel = (key: string, now: number): string => {
  const [y, m, d] = key.split('-').map(Number);
  const wd = '日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const base = `${m}/${d}(${wd})`;
  if (key === jstDateKey(now)) return `今日 ${base}`;
  if (key === jstDateKey(now + 86_400_000)) return `明日 ${base}`;
  return base;
};
const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });

// 「◯分前 / ◯時間前 / ◯日前」。日時が読めなければ空。
const fmtAgo = (date: string, now: number): string => {
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 60) return `${min}分前`;
  if (min < 24 * 60) return `${Math.round(min / 60)}時間前`;
  return `${Math.round(min / (24 * 60))}日前`;
};

const SOON_MS = 3 * 3_600_000; // これより先の指標までを「まもなく」とする

const fetchNews = async (): Promise<NewsPayload> => {
  const url = import.meta.env.VITE_NEWS_URL as string | undefined;
  if (!url) throw new Error('ニュースエンドポイント(VITE_NEWS_URL)が未設定です');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ニュースAPI HTTP ${res.status}`);
  const data = (await res.json()) as NewsPayload | { error: string };
  if ('error' in data) throw new Error(data.error);
  return data;
};

// 今日のアノマリー（ページ上部）。普段は見出しだけを並べ、タップで解説を開く。
const AnomalyPanel: FC<{ anomalies: Anomaly[] }> = ({ anomalies }) => {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <section className="rounded-xl bg-white px-3 py-2.5 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={anomalies.length === 0}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-left text-xs font-bold text-gray-800"
      >
        <Sparkles className="h-3.5 w-3.5 text-purple-500" aria-hidden="true" />
        いま意識されやすいアノマリー
        {anomalies.length > 0 && (
          <span className="ml-auto flex items-center gap-0.5 text-[10px] font-normal text-gray-400">
            {open ? '閉じる' : '解説'}
            <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </span>
        )}
      </button>
      {anomalies.length === 0 ? (
        <p className="mt-1 text-[11px] text-gray-500">今日は目立ったアノマリーはありません。</p>
      ) : open ? (
        <ul className="mt-1.5 space-y-2" style={LIST_RESET}>
          {anomalies.map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <li key={a.id} className="text-[11px] leading-relaxed">
                <div className="flex flex-wrap items-center gap-x-1.5">
                  <Icon className="h-3 w-3 shrink-0 text-gray-400" aria-hidden="true" />
                  <span className="font-bold text-gray-800">{a.title}</span>
                  <span className="text-gray-400">{a.when}</span>
                </div>
                <div className="pl-4 text-gray-600">{a.detail}</div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {anomalies.map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <span key={a.id} className="flex items-center gap-0.5 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-700">
                <Icon className="h-3 w-3" aria-hidden="true" />
                {a.title}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
};

// ペアごとの予測カード。見出し（ペア・予想・買い%）→ 買い/売りの棒 → トレンド・確信度 → 根拠（長ければ2行で畳む）→ アノマリー。
const ForecastCard: FC<{ s: PairSignal; anomalies: Anomaly[] }> = ({ s, anomalies }) => {
  const [open, setOpen] = useState<boolean>(false);
  const verdict = signalVerdict(s);
  const v = VERDICT[verdict];
  const conf = confidenceLevel(s.confidence);
  const sellPct = 100 - s.buyPct;
  const related = anomaliesForPair(anomalies, s.pair);
  // アノマリーの向きが予測と逆（上昇予想なのに下がりやすい等）なら目印を出す。
  const conflict = related.some(({ bias }) => (verdict === 'up' && bias === 'down') || (verdict === 'down' && bias === 'up'));
  const longText = (s.rationale?.length ?? 0) > 60;
  const lead = verdict === 'down' ? { label: '売り', pct: sellPct, cls: 'text-red-600' } : { label: '買い', pct: s.buyPct, cls: verdict === 'up' ? 'text-green-600' : 'text-gray-600' };

  return (
    <li className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="px-3 py-2.5">
        {/* 見出し: ペア・予想 ／ 優勢な側の% */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[15px] font-bold text-gray-800">{s.pair}</span>
          <span className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold ${v.cls}`}>
            <v.Icon className="h-3 w-3" aria-hidden="true" />
            {v.label}
          </span>
          <span className={`ml-auto text-right leading-none ${lead.cls}`}>
            <span className="text-[10px] font-semibold">{lead.label}</span>
            <span className="ml-0.5 text-lg font-bold tabular-nums">{lead.pct}</span>
            <span className="text-[10px] font-semibold">%</span>
          </span>
        </div>

        {/* 買い/売りの横バー（中央線つき） */}
        <div className="relative mt-2 flex h-2 overflow-hidden rounded-full bg-gray-100" aria-label={`買い ${s.buyPct}% / 売り ${sellPct}%`}>
          <div className="bg-green-500" style={{ width: `${s.buyPct}%` }} />
          <div className="bg-red-500" style={{ width: `${sellPct}%` }} />
          <span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-white" />
        </div>
        <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-gray-400">
          <span>買い {s.buyPct}%</span>
          <span>売り {sellPct}%</span>
        </div>

        {/* トレンド・確信度 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className={`rounded px-1.5 py-0.5 font-semibold ${TREND_CLASS[s.trend]}`}>
            {TREND_LABEL[s.trend]} {s.trendPct}%
          </span>
          <span className="flex items-center gap-1 rounded bg-gray-50 px-1.5 py-0.5 text-gray-500" aria-label={`確信度 ${CONF_LABEL[conf]}`}>
            確信度
            <span className="flex gap-0.5" aria-hidden="true">
              {[1, 2, 3].map((i) => (
                <span key={i} className={`inline-block h-1.5 w-1.5 rounded-full ${i <= CONF_DOTS[conf] ? 'bg-gray-700' : 'bg-gray-200'}`} />
              ))}
            </span>
            <span className="font-semibold text-gray-700">{CONF_LABEL[conf]}</span>
          </span>
          {conflict && <span className="rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-700">アノマリーと逆向き</span>}
        </div>

        {/* 根拠（ニュース）。長い文は2行で畳む */}
        {s.rationale && (
          <div className="mt-2 flex gap-1.5 text-xs leading-relaxed text-gray-700">
            <Newspaper className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" aria-label="ニュースの根拠" />
            <div className="min-w-0">
              <p className={longText && !open ? 'line-clamp-2' : ''}>{s.rationale}</p>
              {longText && (
                <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] text-blue-600">
                  {open ? '閉じる' : '続きを読む'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* アノマリー */}
        {(related.length > 0 || s.anomaly) && (
          <div className="mt-2 rounded-lg bg-purple-50/60 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <Sparkles className="h-3 w-3 text-purple-500" aria-label="アノマリー" />
              {related.map(({ anomaly, bias }) => (
                <span key={anomaly.id} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${BIAS_STYLE[bias].cls}`}>
                  {anomaly.title} {BIAS_STYLE[bias].mark}
                  {ANOMALY_BIAS_LABEL[bias]}
                </span>
              ))}
            </div>
            {s.anomaly && <p className="mt-1 text-[11px] leading-relaxed text-gray-700">{s.anomaly}</p>}
          </div>
        )}
      </div>
    </li>
  );
};

// 全体の見通し（上昇/下落/方向感なしの件数）。押すとその予想だけに絞り込む（もう一度押すと解除）。
const VERDICT_TILE: Record<SignalVerdict, string> = {
  up: 'text-green-700',
  down: 'text-red-700',
  flat: 'text-gray-500',
};
const OutlookSummary: FC<{
  signals: PairSignal[];
  filter: SignalVerdict | null;
  onFilter: (v: SignalVerdict | null) => void;
}> = ({ signals, filter, onFilter }) => {
  const count = (v: SignalVerdict) => signals.filter((s) => signalVerdict(s) === v).length;
  return (
    <section className="rounded-xl bg-white shadow-sm">
      <div className="px-3 pt-2.5 text-xs font-bold text-gray-800">全体の見通し</div>
      <div className="grid grid-cols-3 gap-1.5 p-2">
        {(['up', 'down', 'flat'] as const).map((v) => {
          const on = filter === v;
          return (
            <button
              key={v}
              type="button"
              aria-pressed={on}
              onClick={() => onFilter(on ? null : v)}
              className={`rounded-lg border text-center ${on ? 'border-gray-800 bg-gray-50' : 'border-gray-100'}`}
            >
              <span className="block px-1 py-1.5">
                <span className={`block text-lg font-bold tabular-nums ${VERDICT_TILE[v]}`}>{count(v)}</span>
                <span className="block text-[10px] text-gray-500">{VERDICT[v].label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

// 小さな切り替えボタン。余白は内側の span に付ける（ボタン要素の余白は外部の CSS に打ち消されることがある）。
const Pill: FC<{ on: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, onClick, children }) => (
  <button type="button" aria-pressed={on} onClick={onClick} className={`rounded-full ${on ? 'bg-gray-800 text-white' : 'bg-white text-gray-500'}`}>
    <span className="block px-2 py-0.5">{children}</span>
  </button>
);

// 経済指標の1行。左に時刻、右に通貨・指標名・予想/前回。発表済みは薄く、3時間以内は「まもなく」。
const EconRow: FC<{ e: EconEvent; now: number }> = ({ e, now }) => {
  const t = new Date(e.date).getTime();
  const past = t < now;
  const soon = !past && t - now <= SOON_MS;
  return (
    <li className={`flex items-center gap-3 px-3 py-2 ${past ? 'opacity-50' : ''} ${soon ? 'bg-amber-50' : ''}`}>
      <span className="w-11 shrink-0 text-sm font-bold tabular-nums text-gray-800">{fmtTime(e.date)}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-bold text-white">{e.country}</span>
          <span className="truncate text-xs font-semibold text-gray-800">{e.title}</span>
        </p>
        {(e.forecast || e.previous) && (
          <p className="mt-0.5 text-[10px] tabular-nums text-gray-500">
            予想 <span className="font-semibold text-gray-700">{e.forecast || '—'}</span>
            <span className="mx-1 text-gray-300">|</span>
            前回 <span className="text-gray-700">{e.previous || '—'}</span>
          </p>
        )}
      </div>
      {soon && <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">まもなく</span>}
      {past && <span className="shrink-0 text-[10px] text-gray-400">発表済み</span>}
    </li>
  );
};

const NewsSummary: FC = () => {
  const [data, setData] = useState<NewsPayload | null>(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as NewsPayload) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [tab, setTab] = useState<Tab>(() => readLocal(TAB_KEY, ['forecast', 'calendar', 'news'] as const, 'forecast'));
  const [sort, setSort] = useState<SortMode>(() => readLocal(SORT_KEY, ['default', 'strength'] as const, 'default'));
  const [now, setNow] = useState<number>(() => Date.now()); // アノマリーの時間帯（仲値前後など）を追従させる
  const [verdictFilter, setVerdictFilter] = useState<SignalVerdict | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await fetchNews();
      setData(d);
      writeLocal(CACHE_KEY, JSON.stringify(d));
    } catch (e) {
      console.warn('ニュース取得に失敗:', e);
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5 * 60_000);
    if (import.meta.env.VITE_NEWS_URL) load();
    return () => clearInterval(tick);
  }, [load]);

  const anomalies = useMemo(() => detectAnomalies(new Date(now), data?.calendar ?? []), [now, data]);
  const signals = useMemo(() => (data ? (sort === 'strength' ? sortSignalsByStrength(data.signals) : data.signals) : []), [data, sort]);
  const shownSignals = verdictFilter ? signals.filter((s) => signalVerdict(s) === verdictFilter) : signals;
  // 経済指標を JST の日付ごとにまとめる（並びは元の時刻順のまま）。
  const calendarByDay = useMemo(() => {
    const groups: { key: string; events: EconEvent[] }[] = [];
    for (const e of data?.calendar ?? []) {
      const t = new Date(e.date).getTime();
      const key = Number.isNaN(t) ? 'unknown' : jstDateKey(t);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.events.push(e);
      else groups.push({ key, events: [e] });
    }
    return groups;
  }, [data]);
  const generated = data
    ? new Date(data.generatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  const changeTab = (t: Tab) => {
    setTab(t);
    writeLocal(TAB_KEY, t);
  };
  const changeSort = (m: SortMode) => {
    setSort(m);
    writeLocal(SORT_KEY, m);
  };

  return (
    <div className="mx-auto max-w-md space-y-3 px-3 pb-6 pt-2 text-sm">
      <AnomalyPanel anomalies={anomalies} />

      {/* タブ＋更新 */}
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label="表示の切り替え" className="flex flex-1 rounded-lg bg-gray-100 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => changeTab(t.id)}
              className={`flex-1 rounded-md text-[11px] font-semibold ${tab === t.id ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
            >
              <span className="block px-1 py-1.5">
                {t.label}
                {t.id === 'calendar' && data?.calendar && data.calendar.length > 0 && <span className="ml-0.5 text-red-500">{data.calendar.length}</span>}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-label="最新に更新"
          className="shrink-0 rounded-lg border border-gray-200 bg-white text-[11px] text-gray-500 disabled:opacity-50"
        >
          <span className="flex items-center gap-1 px-2 py-1.5">
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            {loading ? '取得中' : data ? generated : '取得'}
          </span>
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <span>{error}</span>
          <button type="button" onClick={load} className="font-bold underline">
            再試行
          </button>
        </div>
      )}

      {!data && loading && (
        <ul className="space-y-2" style={LIST_RESET}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="animate-pulse rounded-xl border border-gray-200 bg-white px-3 py-3">
              <div className="mb-3 h-4 w-28 rounded bg-gray-200" />
              <div className="mb-2 h-4 rounded-full bg-gray-200" />
              <div className="h-3 w-3/4 rounded bg-gray-200" />
            </li>
          ))}
        </ul>
      )}

      {!data && !loading && !error && <p className="py-6 text-center text-xs text-gray-400">「取得」を押すとニュースを読み込みます。</p>}

      {data && tab === 'forecast' && (
        <>
          <OutlookSummary signals={signals} filter={verdictFilter} onFilter={setVerdictFilter} />
          <div className="flex items-center justify-between gap-2 text-[10px] text-gray-500">
            <span className="min-w-0 truncate">
              {verdictFilter ? `${VERDICT[verdictFilter].label}だけ表示中` : 'ニュースと直近の値動きから推定'}（{data.engine === 'jev' ? 'Jev' : 'Workers AI'}）
            </span>
            <span className="flex shrink-0 gap-1">
              <Pill on={sort === 'default'} onClick={() => changeSort('default')}>既定の順</Pill>
              <Pill on={sort === 'strength'} onClick={() => changeSort('strength')}>傾きが強い順</Pill>
            </span>
          </div>
          {shownSignals.length === 0 ? (
            <p className="rounded-xl bg-white py-6 text-center text-xs text-gray-500">該当するペアはありません。</p>
          ) : (
            <ul className="space-y-2" style={LIST_RESET}>
              {shownSignals.map((s) => (
                <ForecastCard key={s.pair} s={s} anomalies={anomalies} />
              ))}
            </ul>
          )}
          <p className="text-[10px] leading-relaxed text-gray-400">
            買い60%以上を上昇予想、40%以下を下落予想としています。アノマリーは「そう言われる」経験則で、毎回当てはまるわけではありません。
          </p>
        </>
      )}

      {data && tab === 'calendar' && (
        <>
          {calendarByDay.length > 0 ? (
            <div className="space-y-2">
              {calendarByDay.map((g) => (
                <section key={g.key} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                  <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[11px] font-bold text-gray-700">
                    {g.key === 'unknown' ? '日時不明' : dayLabel(g.key, now)}
                    <span className="ml-1.5 font-normal text-gray-400">{g.events.length}件</span>
                  </div>
                  <ul className="divide-y divide-gray-100" style={LIST_RESET}>
                    {g.events.map((e, i) => (
                      <EconRow key={`${e.date}-${e.title}-${i}`} e={e} now={now} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="rounded-xl bg-white py-6 text-center text-xs text-gray-500">今週の残りに高重要度の指標はありません。</p>
          )}
          <p className="text-[10px] text-gray-400">※ 高重要度のみ。時刻はJST。「まもなく」は3時間以内。予想/前回は発表前の暫定値を含みます（出典: ForexFactory）。</p>
        </>
      )}

      {data && tab === 'news' && (
        <>
          {data.summary && (
            <section className="rounded-xl bg-white px-3 py-2.5 shadow-sm">
              <h3 className="mb-1 text-xs font-bold text-gray-800">ニュース要約</h3>
              <div className="whitespace-pre-wrap text-xs leading-relaxed text-gray-700">{data.summary}</div>
            </section>
          )}
          {data.items.length > 0 && (
            <section className="rounded-xl bg-white px-3 py-2.5 shadow-sm">
              <h3 className="mb-1 text-xs font-bold text-gray-800">
                出典（FXStreet 他）<span className="ml-1.5 font-normal text-gray-400">{data.items.length}件</span>
              </h3>
              <ul className="divide-y divide-gray-100" style={LIST_RESET}>
                {data.items.map((it, i) => (
                  <li key={i} className="py-1.5 text-xs leading-snug">
                    <a href={it.link} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                      {it.title}
                    </a>
                    {fmtAgo(it.pubDate, now) && <span className="ml-1.5 whitespace-nowrap text-[10px] text-gray-400">{fmtAgo(it.pubDate, now)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {data && (
        <p className="text-center text-[10px] text-gray-400">
          ※予測・要約はAIによる推定の参考値です。投資助言ではありません。実際の取引はご自身の判断で行ってください。
        </p>
      )}
    </div>
  );
};

export default NewsSummary;
