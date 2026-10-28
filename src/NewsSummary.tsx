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
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';
import type { ForecastAccuracy, HitRate } from '@/lib/forecast';

interface NewsPayload {
  generatedAt: number;
  engine: string; // 'workers-ai' | 'jev'
  summary: string;
  signals: PairSignal[];
  items: { title: string; link: string; pubDate: string }[];
  calendar?: EconEvent[]; // 高重要度の経済指標（今日〜今週・対象8通貨）。旧キャッシュには無いため任意
  accuracy?: ForecastAccuracy | null; // 直近の的中率。旧キャッシュには無い
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
              <li style={LIST_ITEM_RESET} key={a.id} className="text-[11px] leading-relaxed">
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
// 買い%を「上昇/下落/中立 + %」の短い表記に（内訳の行で使う）。
const leanText = (buyPct: number) => {
  const v = signalVerdict({ buyPct });
  return v === 'up' ? `買い${buyPct}%` : v === 'down' ? `売り${100 - buyPct}%` : `中立${buyPct}%`;
};
const LEAN_CLS: Record<SignalVerdict, string> = { up: 'text-green-700', down: 'text-red-700', flat: 'text-gray-500' };

// 予測の内訳: ニュース（AI）だけ・値動きだけの買い%と、向きがそろっているか。値動きの根拠は1行で。
const PartsRow: FC<{ parts: NonNullable<PairSignal['parts']> }> = ({ parts }) => {
  const price = parts.price as number;
  return (
    <div className="mt-2 rounded-lg bg-gray-50 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-gray-500">
          ニュース <span className={`font-semibold ${LEAN_CLS[signalVerdict({ buyPct: parts.news })]}`}>{leanText(parts.news)}</span>
        </span>
        <span className="text-gray-500">
          値動き <span className={`font-semibold ${LEAN_CLS[signalVerdict({ buyPct: price })]}`}>{leanText(price)}</span>
        </span>
        {parts.agree && <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-700">向きが一致</span>}
        {parts.disagree && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">食い違い・控えめに</span>}
      </div>
      {parts.priceNotes && parts.priceNotes.length > 0 && (
        <div className="mt-0.5 text-[10px] text-gray-500">{parts.priceNotes.join('・')}</div>
      )}
    </div>
  );
};

const pctOf = (h: HitRate) => (h.n > 0 ? Math.round((h.hit / h.n) * 100) : null);

// 予測の成績: 直近 N 日の的中率（合成後・ニュースだけ・値動きだけ）と合成の重み。件数が少ないうちは「集計中」。
const AccuracyCard: FC<{ acc: ForecastAccuracy }> = ({ acc }) => {
  const main = pctOf(acc.final);
  const enough = acc.final.n >= 10;
  const item = (label: string, h: HitRate) => (
    <span key={label} className="text-gray-500">
      {label} <span className="font-semibold tabular-nums text-gray-700">{pctOf(h) == null ? '—' : `${pctOf(h)}%`}</span>
      <span className="text-gray-400">（{h.n}件）</span>
    </span>
  );
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-gray-700">予測の成績（直近{acc.days}日・{acc.horizonH}時間後で答え合わせ）</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        {enough && main != null ? (
          <>
            <span className={`text-2xl font-bold tabular-nums ${main >= 55 ? 'text-green-600' : main < 50 ? 'text-red-600' : 'text-gray-800'}`}>{main}%</span>
            <span className="text-[11px] text-gray-500">的中（{acc.final.n}件中 {acc.final.hit}件）</span>
          </>
        ) : (
          <span className="text-[11px] text-gray-500">
            集計中です（答え合わせ済み {acc.final.n}件）。10件たまると的中率を表示します。
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
        {item('ニュースだけ', acc.news)}
        {item('値動きだけ', acc.price)}
      </div>
      <div className="mt-1 text-[10px] text-gray-400">
        合成の重み: ニュース {Math.round(acc.weights.news * 100)}% / 値動き {Math.round((1 - acc.weights.news) * 100)}%
        {acc.weights.adaptive ? '（的中率から自動調整）' : '（件数が少ないため半々）'}
      </div>
    </div>
  );
};

// 「予測の理由」パネル: 合成のしかた → ニュース（AI）の根拠と参照したニュース → 値動きの材料 → 近い経済指標。
const LEAN_MARK: Record<1 | -1 | 0, { mark: string; cls: string }> = {
  1: { mark: '▲ 上昇', cls: 'text-green-700' },
  [-1]: { mark: '▼ 下落', cls: 'text-red-700' },
  0: { mark: '― 中立', cls: 'text-gray-400' },
};
const ReasonSection: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="border-t border-gray-100 pt-2 first:border-t-0 first:pt-0">
    <div className="mb-1 text-[11px] font-bold text-gray-700">{title}</div>
    {children}
  </div>
);

// ペアの通貨（XAU は USD の指標を見る）。
const pairCurrencies = (pair: string) => pair.split('/').map((c) => (c === 'XAU' ? 'USD' : c));

const ReasonPanel: FC<{
  s: PairSignal;
  items: NewsPayload['items'];
  calendar: EconEvent[];
  now: number;
}> = ({ s, items, calendar, now }) => {
  const p = s.parts;
  const wn = p?.weightNews ?? 0.5;
  const refs = (s.refs ?? []).map((i) => items[i]).filter(Boolean);
  const cur = pairCurrencies(s.pair);
  // 今から24時間以内の、ペアの通貨の高重要度の指標（発表済み1時間以内も含める）。
  const events = calendar
    .filter((e) => cur.includes(e.country))
    .map((e) => ({ e, t: Date.parse(e.date) }))
    .filter(({ t }) => Number.isFinite(t) && t >= now - 3600_000 && t <= now + 24 * 3600_000)
    .sort((a, b) => a.t - b.t)
    .slice(0, 4);
  const fmtTime = (t: number) =>
    new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-gray-100 bg-gray-50/70 px-2.5 py-2 text-[11px] text-gray-700">
      {p && p.price != null && (
        <ReasonSection title="① 合成のしかた">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span>
              ニュース <span className={`font-semibold ${LEAN_CLS[signalVerdict({ buyPct: p.news })]}`}>{leanText(p.news)}</span>
              <span className="text-gray-400">（重み{Math.round(wn * 100)}%）</span>
            </span>
            <span className="text-gray-400">＋</span>
            <span>
              値動き <span className={`font-semibold ${LEAN_CLS[signalVerdict({ buyPct: p.price })]}`}>{leanText(p.price)}</span>
              <span className="text-gray-400">（重み{Math.round((1 - wn) * 100)}%）</span>
            </span>
            <span className="text-gray-400">→</span>
            <span className={`font-bold ${LEAN_CLS[signalVerdict(s)]}`}>{leanText(s.buyPct)}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-gray-500">
            {p.disagree
              ? '向きが食い違うため、方向感を弱め（50%寄りに）、確信度を低くしています。'
              : p.agree
                ? '向きが一致しているため、確信度を上げています。'
                : 'どちらかが中立に近いため、そのまま合成しています。'}
            {p.adaptive ? ' 重みは直近の的中率から自動で決めています。' : ' 答え合わせの件数がたまるまでは重みは半々です。'}
          </div>
        </ReasonSection>
      )}

      <ReasonSection title={`② ニュース（AI）${p?.newsConfidence != null ? `・確信度 ${Math.round(p.newsConfidence * 100)}%` : ''}`}>
        {s.rationale ? <p className="leading-relaxed">{s.rationale}</p> : <p className="text-gray-400">AI の一言根拠はありません（判定エンジンが根拠文を返さない場合があります）。</p>}
        <div className="mt-0.5 text-[10px] text-gray-500">
          {TREND_LABEL[s.trend]} {s.trendPct}%（直近の流れが続くか・反転するかの AI の見立て）
        </div>
        {refs.length > 0 && (
          <ul className="mt-1 space-y-0.5" style={LIST_RESET}>
            {refs.map((it) => (
              <li style={LIST_ITEM_RESET} key={it.link + it.title} className="flex gap-1">
                <Newspaper className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" aria-hidden="true" />
                <a href={it.link} target="_blank" rel="noreferrer" className="min-w-0 text-blue-700 underline decoration-dotted">
                  {it.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </ReasonSection>

      {p?.priceFactors && p.priceFactors.length > 0 && (
        <ReasonSection title={`③ 値動き（15分足）${p.priceConfidence != null ? `・確信度 ${Math.round(p.priceConfidence * 100)}%` : ''}`}>
          <ul className="space-y-0.5" style={LIST_RESET}>
            {p.priceFactors.map((f) => (
              <li style={LIST_ITEM_RESET} key={f.label} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2">
                <span className="min-w-0">
                  {f.label}
                  <span className="ml-1 text-gray-500">{f.detail}</span>
                </span>
                <span className="text-[10px] text-gray-400">{f.weight > 0 ? `重み${f.weight}%` : '補正'}</span>
                <span className={`w-12 text-right text-[10px] font-semibold ${LEAN_MARK[f.lean].cls}`}>{LEAN_MARK[f.lean].mark}</span>
              </li>
            ))}
          </ul>
        </ReasonSection>
      )}

      <ReasonSection title="④ 24時間以内の重要指標">
        {events.length === 0 ? (
          <p className="text-gray-400">{cur.join('・')} の高重要度の指標はありません。</p>
        ) : (
          <ul className="space-y-0.5" style={LIST_RESET}>
            {events.map(({ e, t }) => (
              <li style={LIST_ITEM_RESET} key={e.date + e.title} className="flex flex-wrap gap-x-1.5">
                <span className="tabular-nums text-gray-500">{fmtTime(t)}</span>
                <span className="font-semibold">{e.country}</span>
                <span>{e.title}</span>
                {t < now && <span className="text-[10px] text-gray-400">（発表済み）</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-0.5 text-[10px] text-gray-500">発表の前後は値動きが荒くなりやすく、予測が外れやすくなります。</div>
      </ReasonSection>
    </div>
  );
};

const ForecastCard: FC<{
  s: PairSignal;
  anomalies: Anomaly[];
  pairHit?: HitRate;
  items: NewsPayload['items'];
  calendar: EconEvent[];
  now: number;
}> = ({ s, anomalies, pairHit, items, calendar, now }) => {
  const [showReason, setShowReason] = useState(false);
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
    <li style={LIST_ITEM_RESET} className="rounded-xl border border-gray-200 bg-white shadow-sm">
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
          {pairHit && pairHit.n >= 5 && (
            <span className="rounded bg-gray-50 px-1.5 py-0.5 text-gray-500">
              このペアの的中 <span className="font-semibold text-gray-700">{Math.round((pairHit.hit / pairHit.n) * 100)}%</span>（{pairHit.n}件）
            </span>
          )}
        </div>

        {/* 内訳: ニュース（AI）と値動きの予測。食い違いは 50% に寄せている */}
        {s.parts && s.parts.price != null && <PartsRow parts={s.parts} />}

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

        {/* 予測の理由（合成のしかた・ニュース・値動きの材料・近い指標）。余白は内側の span に付ける */}
        <button
          type="button"
          onClick={() => setShowReason((o) => !o)}
          aria-expanded={showReason}
          className="mt-2 w-full rounded-lg border border-gray-200 bg-white text-[11px] font-semibold text-gray-600 active:bg-gray-50"
        >
          <span className="flex items-center justify-center gap-1 py-1.5">
            予測の理由{showReason ? 'を閉じる' : 'を見る'}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showReason ? 'rotate-180' : ''}`} aria-hidden="true" />
          </span>
        </button>
        {showReason && <ReasonPanel s={s} items={items} calendar={calendar} now={now} />}
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
    <li style={LIST_ITEM_RESET} className={`flex items-center gap-3 px-3 py-2 ${past ? 'opacity-50' : ''} ${soon ? 'bg-amber-50' : ''}`}>
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
            <li style={LIST_ITEM_RESET} key={i} className="animate-pulse rounded-xl border border-gray-200 bg-white px-3 py-3">
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
          {data.accuracy && <AccuracyCard acc={data.accuracy} />}
          <OutlookSummary signals={signals} filter={verdictFilter} onFilter={setVerdictFilter} />
          <div className="flex items-center justify-between gap-2 text-[10px] text-gray-500">
            <span className="min-w-0 truncate">
              {verdictFilter ? `${VERDICT[verdictFilter].label}だけ表示中` : 'ニュースと値動きから推定'}（{data.engine === 'jev' ? 'Jev' : 'Workers AI'}）
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
                <ForecastCard
                  key={s.pair}
                  s={s}
                  anomalies={anomalies}
                  pairHit={data.accuracy?.byPair[s.pair]}
                  items={data.items}
                  calendar={data.calendar ?? []}
                  now={now}
                />
              ))}
            </ul>
          )}
          <p className="text-[10px] leading-relaxed text-gray-400">
            買い60%以上を上昇予想、40%以下を下落予想としています（今後8時間程度）。予測はニュース（AI）と15分足の値動き（2・8・24時間の勢い・移動平均・RSI）を合成し、向きが食い違うときは控えめにしています。的中率は過去の参考値で、将来を保証しません。アノマリーは「そう言われる」経験則で、毎回当てはまるわけではありません。
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
                  <li style={LIST_ITEM_RESET} key={i} className="py-1.5 text-xs leading-snug">
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
