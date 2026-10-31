// RR好機ボード。各通貨ペア×時間足で RR が出た好機を、総合スコアの高い順に1列カードで一覧表示する。
// RR・損切り・目標・入りどきは TF分析ページと同じ（Worker が TF分析の結果からカードを作る。rankingCards.ts）。
// RR 成立=好機・1:2.0 以上で不成立=準好機（別枠・隠せる）。ペア・方向・時間足で絞り込める。
// カードは要約（売買・ペア・RR・総合スコア・リスク:リワードの棒・入りどき・有利/不利の数）を常に見せ、
// タップで詳細（ダウ・損切りの根拠・指値/逆指値の目安・AI・スコアの内訳）を開く。
// 旧キャッシュ（総合スコアが無いカード・タイミングが旧方式のカード）は従来の表示にする。
// currency-strength worker(/ranking, VITE_RANKING_URL) が算出・KVキャッシュ。整形は src/lib/ranking.ts を共有。
// ※投資助言ではなく、値動きや利益を保証するものではない参考情報。
import { useEffect, useState } from 'react';
import { RANKING_PAIRS, RANKING_TIMEFRAMES, type RrBoardSnapshot, type RrCard } from '@/lib/ranking';
import type { EntryKind } from '@/lib/entrySignal';
import type { SlTimeframe } from '@/lib/stoploss';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';
import type { ScoreItem } from '@/lib/edgeScore';

const RANKING_URL = import.meta.env.VITE_RANKING_URL as string | undefined;

const TF_LABEL: Record<SlTimeframe, string> = { '15m': '15分', '30m': '30分', '1h': '1時間', '4h': '4時間' };
// エントリータイミングのバッジ（押し目/戻り=緑・様子見=黄・反転警戒=アンバー）。
const ENTRY_STYLE: Record<EntryKind, { cls: string; icon: string }> = {
  pullback: { cls: 'bg-green-100 text-green-700', icon: '🟢' },
  tentative: { cls: 'bg-yellow-50 text-yellow-700', icon: '🟡' },
  caution: { cls: 'bg-amber-100 text-amber-800', icon: '⚠' },
};
const pairLabel = (ins: string) => ins.replace('_', '/');
const digitsFor = (ins: string) => (ins.startsWith('XAU') ? 2 : ins.endsWith('JPY') ? 3 : 5);
const SOURCE_LABEL = { jev: 'AI', structure: '構造' } as const;
// 入りどき（TF分析と同じ判定）のバッジ。
const TIMING_CHIP = {
  ok: 'bg-green-100 text-green-700',
  wait: 'bg-amber-100 text-amber-700',
  avoid: 'bg-red-100 text-red-700',
} as const;
const TIMING_ICON = { ok: '🟢', wait: '🟡', avoid: '🔴' } as const;

// 総合スコアの段階（70以上=強い・50〜69=普通・50未満=弱い）。
function scoreTier(n: number): { label: string; cls: string } {
  if (n >= 70) return { label: '強い', cls: 'bg-indigo-600 text-white' };
  if (n >= 50) return { label: '普通', cls: 'bg-indigo-50 text-indigo-700' };
  return { label: '弱い', cls: 'bg-gray-100 text-gray-500' };
}

// 総合スコアのバッジ（カード右上）。旧キャッシュは信用度を小さく出す。
function ScoreBadge({ card }: { card: RrCard }) {
  if (card.score == null) {
    return (
      <span className="text-right text-[10px] leading-tight text-gray-500">
        信用度
        <span className="block text-sm font-bold text-gray-700">{card.confidence ?? '—'}</span>
        {card.confidenceSource && <span className="text-[9px] text-gray-400">{SOURCE_LABEL[card.confidenceSource]}</span>}
      </span>
    );
  }
  const t = scoreTier(card.score);
  return (
    <span className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg ${t.cls}`} aria-label={`総合スコア ${card.score}（${t.label}）`}>
      <span className="text-base font-bold leading-none tabular-nums">{card.score}</span>
      <span className="mt-0.5 text-[9px] leading-none">{t.label}</span>
    </span>
  );
}

// リスク（損切りまで）とリワード（目標まで）の比率を1本の棒で見せる。左=損切り・右=目標・境目=エントリー。
function RrBar({ card, digits }: { card: RrCard; digits: number }) {
  const total = card.riskPips + card.rewardPips || 1;
  const riskPct = Math.max(8, Math.min(50, (card.riskPips / total) * 100));
  return (
    <div className="mt-2">
      <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
        <div className="bg-red-400" style={{ width: `${riskPct}%` }} />
        <div className="w-0.5 bg-gray-800" />
        <div className="flex-1 bg-green-400" />
      </div>
      <div className="mt-1 grid grid-cols-3 text-[10px] tabular-nums leading-tight">
        <span className="text-red-600">
          損切り {card.stop.toFixed(digits)}
          <span className="block text-gray-400">−{card.riskPips}pips</span>
        </span>
        <span className="text-center text-gray-800">
          エントリー
          <span className="block font-semibold">{card.entry.toFixed(digits)}</span>
        </span>
        <span className="text-right text-green-700">
          目標 {card.target.toFixed(digits)}
          <span className="block text-gray-400">+{card.rewardPips}pips</span>
        </span>
      </div>
    </div>
  );
}

// 1好機カード（ペア×TF）。
//   要約（常に表示）: 売買・ペア・時間足・RR ／ 総合スコア → リスク:リワードの棒と価格 → 入りどき・有利/不利の数
//   詳細（タップで開く）: ダウの状態・帯での調整内容・スコアの内訳（有利な点 / 不利な点。プライスアクションは PA の印）
function OpportunityCard({ card }: { card: RrCard }) {
  const [open, setOpen] = useState(false);
  const d = digitsFor(card.instrument);
  const long = card.direction === 'long';
  const near = card.tier === 'near';
  const items = card.scoreItems ?? [];
  const pros = items.filter((it) => it.points > 0);
  const cons = items.filter((it) => it.points < 0);
  const pa = card.paTags ?? [];
  const paInfo = pa.filter((t) => t.points === 0); // 加減点なしの参考情報（例: 値幅の中間）
  const sumPros = pros.reduce((a, it) => a + it.points, 0);
  const sumCons = cons.reduce((a, it) => a + it.points, 0);
  const adjusted = !!(card.stopNote || card.targetNote); // 旧キャッシュのみ
  const orders = card.timing && (card.timing.limitPrice != null || card.timing.stopEntryPrice != null);
  const hasDetail = items.length > 0 || !!card.dowLabel || adjusted || pa.length > 0 || !!orders;
  const body = (
    <>
      {/* 見出し: 売買・ペア・時間足・RR ／ スコア */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${long ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
              {long ? '買い' : '売り'}
            </span>
            <span className="text-base font-bold text-gray-900">{pairLabel(card.instrument)}</span>
            <span className="text-xs text-gray-500">{TF_LABEL[card.tf]}足</span>
          </div>
          <p className="mt-0.5 text-xs text-gray-600">
            RR <span className="font-bold text-gray-900">1:{card.rr.toFixed(1)}</span>
            {near && <span className="ml-1.5 rounded bg-gray-100 px-1 text-[10px] text-gray-500">準好機</span>}
          </p>
        </div>
        <ScoreBadge card={card} />
      </div>

      <RrBar card={card} digits={d} />

      {/* ひと目で分かる要約 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
        {card.timing && (
          <span className={`rounded px-1.5 py-0.5 font-bold ${TIMING_CHIP[card.timing.verdict]}`}>
            {TIMING_ICON[card.timing.verdict]}
            {card.timing.label}
          </span>
        )}
        {!card.timing && card.entrySignal && (
          <span className={`rounded px-1.5 py-0.5 font-bold ${ENTRY_STYLE[card.entrySignal.kind].cls}`}>
            {ENTRY_STYLE[card.entrySignal.kind].icon}
            {card.entrySignal.label}
          </span>
        )}
        {items.length > 0 && (
          <span className="rounded bg-gray-50 px-1.5 py-0.5 text-gray-600">
            有利 <span className="font-bold text-green-700">{pros.length}</span> ・ 不利{' '}
            <span className="font-bold text-red-700">{cons.length}</span>
          </span>
        )}
        {adjusted && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">帯で調整済み</span>}
        {hasDetail && (
          <span className="ml-auto text-gray-400">
            {open ? '閉じる' : '詳しく'} <span className={`inline-block transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
          </span>
        )}
      </div>
    </>
  );

  return (
    <div className={`rounded-xl border bg-white shadow-sm ${near ? 'border-dashed border-gray-300' : 'border-gray-200'}`}>
      {hasDetail ? (
        // 余白は内側の要素に付ける（ボタン要素に付けると Mobiscroll のボタン用 CSS に打ち消されることがある）
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="block w-full text-left">
          <span className="block p-3">{body}</span>
        </button>
      ) : (
        <div className="p-3">{body}</div>
      )}

      {open && hasDetail && (
        <div className="space-y-2.5 border-t border-gray-100 px-3 pb-3 pt-2 text-[11px]">
          {/* 状態: ダウ理論・帯での調整 */}
          {(card.dowLabel || adjusted || card.stopReasons?.length || orders || card.jevProb != null) && (
            <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5">
              {card.dowLabel && (
                <>
                  <dt className="font-semibold text-gray-500">ダウ理論</dt>
                  <dd className="text-gray-700">{card.dowLabel}</dd>
                </>
              )}
              {card.stopReasons && card.stopReasons.length > 0 && (
                <>
                  <dt className="font-semibold text-gray-500">損切りの根拠</dt>
                  <dd className="text-gray-700">{card.stopReasons.join('・')}</dd>
                </>
              )}
              {card.timing?.limitPrice != null && (
                <>
                  <dt className="font-semibold text-gray-500">指値の目安</dt>
                  <dd className="text-gray-700">
                    <span className="font-mono font-semibold">{card.timing.limitPrice.toFixed(d)}</span>
                    <span className="ml-1 text-[10px] text-gray-400">{long ? 'Buy Limit（押し目買い）' : 'Sell Limit（戻り売り）'}</span>
                  </dd>
                </>
              )}
              {card.timing?.stopEntryPrice != null && (
                <>
                  <dt className="font-semibold text-gray-500">逆指値の目安</dt>
                  <dd className="text-gray-700">
                    <span className="font-mono font-semibold">{card.timing.stopEntryPrice.toFixed(d)}</span>
                    <span className="ml-1 text-[10px] text-gray-400">{long ? 'Buy Stop（上抜けで買い）' : 'Sell Stop（下抜けで売り）'}</span>
                  </dd>
                </>
              )}
              {card.jevProb != null && (
                <>
                  <dt className="font-semibold text-gray-500">AI</dt>
                  <dd className="text-gray-700">
                    {long ? '上抜け' : '下抜け'}確率 {Math.round(card.jevProb)}%
                  </dd>
                </>
              )}
              {adjusted && (
                <>
                  <dt className="font-semibold text-gray-500">帯での調整</dt>
                  <dd className="text-amber-700">{[card.stopNote, card.targetNote].filter(Boolean).join('・')}</dd>
                </>
              )}
            </dl>
          )}

          {/* スコアの内訳: 有利な点 / 不利な点（プライスアクションは PA の印） */}
          {items.length > 0 && (
            <>
              <PointGroup title="有利な点" tone="plus" items={pros} />
              <PointGroup title="不利な点" tone="minus" items={cons} />
              {paInfo.length > 0 && (
                <div className="text-gray-400">
                  <span className="mr-1 rounded bg-gray-100 px-1 text-[9px] font-bold text-gray-500">PA</span>
                  {paInfo.map((t) => t.label).join('・')}
                </div>
              )}
              <div className="flex items-baseline justify-between rounded-lg bg-gray-50 px-2 py-1.5">
                <span className="text-gray-500">
                  基準 50 {sumPros > 0 && <span className="text-green-700">+{sumPros}</span>}{' '}
                  {sumCons < 0 && <span className="text-red-700">−{Math.abs(sumCons)}</span>}
                  <span className="ml-1 text-[10px] text-gray-400">（0〜100に換算）</span>
                </span>
                <span className="text-sm font-bold tabular-nums text-gray-900">{card.score}</span>
              </div>
            </>
          )}
          {items.length === 0 && card.paTags && pa.length === 0 && <div className="text-gray-400">目立った痕跡なし</div>}
        </div>
      )}
    </div>
  );
}

// 加点/減点のグループ（見出しに合計点）。プライスアクション由来の項目には PA の印を付ける。
function PointGroup({ title, tone, items }: { title: string; tone: 'plus' | 'minus'; items: ScoreItem[] }) {
  if (items.length === 0) return null;
  const sum = items.reduce((a, it) => a + it.points, 0);
  const plus = tone === 'plus';
  return (
    <div>
      <div className={`mb-0.5 flex items-baseline justify-between font-bold ${plus ? 'text-green-700' : 'text-red-700'}`}>
        <span>
          {title}
          <span className="ml-1 font-normal text-gray-400">{items.length}件</span>
        </span>
        <span className="tabular-nums">
          {plus ? '+' : '−'}
          {Math.abs(sum)}
        </span>
      </div>
      <ul className={`space-y-0.5 rounded-lg px-2 py-1 ${plus ? 'bg-green-50/60' : 'bg-red-50/60'}`} style={LIST_RESET}>
        {items.map((it, k) => {
          const isPa = it.label.startsWith('PA: ');
          return (
            <li key={k} style={LIST_ITEM_RESET} className="flex items-start justify-between gap-2">
              <span className="text-gray-700">
                {isPa && <span className="mr-1 rounded bg-white px-1 text-[9px] font-bold text-gray-500">PA</span>}
                {isPa ? it.label.slice(4) : it.label}
              </span>
              <span className={`shrink-0 font-semibold tabular-nums ${plus ? 'text-green-700' : 'text-red-700'}`}>
                {plus ? '+' : '−'}
                {Math.abs(it.points)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// セグメントの切り替え（全体 / 個別）。
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg bg-gray-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={`flex-1 rounded-md text-[11px] font-medium ${value === o.v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
        >
          <span className="block px-2 py-1">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// セクションの見出し（件数つき）。
function SectionTitle({ title, note, count }: { title: string; note: string; count: number }) {
  return (
    <p className="mt-1 flex items-baseline gap-2 text-sm font-bold text-gray-800">
      {title}
      <span className="rounded-full bg-gray-100 px-2 text-[11px] font-semibold text-gray-600">{count}</span>
      <span className="ml-auto text-[10px] font-normal text-gray-400">{note}</span>
    </p>
  );
}

type DirFilter = 'all' | 'long' | 'short';
type TfFilter = 'all' | SlTimeframe;

// プライスアクション（SMC）の用語の説明。
const PA_GLOSSARY: [string, string][] = [
  ['流動性スイープ', '直近の安値（高値）をヒゲで一瞬割って、終値で戻した足。その下に溜まった損切り注文を狩ってから反転する動きで、買い（売り）の好材料。'],
  ['オーダーブロック', '強い足が直近の高値（安値）を抜ける直前にあった、逆向きの最後の足。大口が仕込んだ価格帯とされ、戻ってきたときに支え（抑え）になりやすい。終値で割られたら無効。'],
  ['FVG（フェアバリューギャップ）', '3本の足で、1本目の高値と3本目の安値の間に空いた価格の空白。急な動きで取引が薄い所で、価格が戻って埋めに来やすく、埋めた後に反発しやすい。'],
  ['プレミアム / ディスカウント', '直近のスイングの値幅の上半分（割高）と下半分（割安）。買いはディスカウント、売りはプレミアムで入るのが有利。'],
  ['OTE', 'Optimal Trade Entry。値幅の 61.8〜79% まで押した（戻した）位置。押し目買い・戻り売りの最も有利なゾーンとされる。'],
  ['ディスプレイスメント', 'ATR の1.5倍以上の実体を持つ強い足。大口の参入を示し、その向きに勢いがある。'],
];
const SETUP_TFS = RANKING_TIMEFRAMES.slice(0, -1); // 4時間足は目標の供給元なので好機にならない

export default function EdgeAnalysis() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<RrBoardSnapshot | null>(null);
  const [pair, setPair] = useState('all');
  const [tf, setTf] = useState<TfFilter>('all');
  const [dir, setDir] = useState<DirFilter>('all');
  const [showNear, setShowNear] = useState(true);

  const load = async (initial: boolean) => {
    if (!RANKING_URL) return;
    if (initial) setLoading(true);
    try {
      const res = await fetch(RANKING_URL);
      const body = (await res.json()) as RrBoardSnapshot | { error: string };
      if ('error' in body) throw new Error(body.error);
      setData(body);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      if (initial) setLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(false), 10 * 60_000); // 10分ごとに再取得
    return () => clearInterval(timer);
  }, []);

  if (!RANKING_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        RR好機ボードは未設定です。<code>VITE_RANKING_URL</code> を設定すると使えます。
      </div>
    );
  }

  const shown = (data?.cards ?? []).filter(
    (c) => (pair === 'all' || c.instrument === pair) && (tf === 'all' || c.tf === tf) && (dir === 'all' || c.direction === dir),
  );
  const prime = shown.filter((c) => c.tier !== 'near');
  const near = shown.filter((c) => c.tier === 'near');
  const updated = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="mx-auto my-2 max-w-md space-y-3 px-3">
      {/* 見出し: 件数・更新時刻・更新ボタン */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-gray-800">
            好機 {data ? prime.length : '–'}件
            <span className="ml-1.5 text-xs font-normal text-gray-500">準好機 {data ? near.length : '–'}件</span>
          </p>
          <p className="text-[10px] text-gray-400">
            15分・30分・1時間足／総合スコアの高い順{updated ? `／${updated} 更新` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          className="rounded-lg bg-gray-100 text-xs font-medium text-gray-600 active:bg-gray-200"
        >
          <span className="block px-3 py-1.5">更新</span>
        </button>
      </div>

      {/* 絞り込み */}
      <div className="space-y-1.5 rounded-xl bg-white p-2 shadow-sm">
        <div className="flex items-center gap-2">
          <select
            value={pair}
            onChange={(e) => setPair(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700"
            aria-label="通貨ペア"
          >
            <option value="all">すべてのペア</option>
            {RANKING_PAIRS.map((p) => (
              <option key={p} value={p}>
                {pairLabel(p)}
              </option>
            ))}
          </select>
          <div className="w-40">
            <Segmented<DirFilter>
              label="売買の方向"
              value={dir}
              onChange={setDir}
              options={[
                { v: 'all', label: '両方' },
                { v: 'long', label: '買い' },
                { v: 'short', label: '売り' },
              ]}
            />
          </div>
        </div>
        <Segmented<TfFilter>
          label="時間足"
          value={tf}
          onChange={setTf}
          options={[{ v: 'all', label: '全時間足' }, ...SETUP_TFS.map((t) => ({ v: t as TfFilter, label: `${TF_LABEL[t]}足` }))]}
        />
      </div>

      {loading && <p className="text-sm text-gray-500">分析中…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && (
        <>
          {data.jevPaused && (
            <div className="rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
              AI（Jev）は一時停止中（使用上限）です。総合スコアは AI を除いた材料で計算しています。
            </div>
          )}

          <SectionTitle title="好機" note="RR 1:2.5以上" count={prime.length} />
          {prime.length === 0 ? (
            <p className="rounded-xl bg-white py-6 text-center text-sm text-gray-400 shadow-sm">条件を満たす好機はありません</p>
          ) : (
            <div className="space-y-2">
              {prime.map((c) => (
                <OpportunityCard key={`${c.instrument}:${c.tf}`} card={c} />
              ))}
            </div>
          )}

          <div className="mt-1 flex items-baseline gap-2">
            <p className="flex items-baseline gap-2 text-sm font-bold text-gray-500">
              準好機
              <span className="rounded-full bg-gray-100 px-2 text-[11px] font-semibold text-gray-600">{near.length}</span>
              <span className="text-[10px] font-normal text-gray-400">RR 1:2.0〜2.5</span>
            </p>
            <button
              type="button"
              onClick={() => setShowNear((v) => !v)}
              aria-expanded={showNear}
              className="ml-auto rounded-lg bg-gray-100 text-[11px] text-gray-600"
            >
              <span className="block px-2 py-0.5">{showNear ? '隠す ▴' : '表示 ▾'}</span>
            </button>
          </div>
          {showNear &&
            (near.length === 0 ? (
              <p className="py-2 text-center text-[11px] text-gray-400">準好機はありません</p>
            ) : (
              <div className="space-y-2">
                {near.map((c) => (
                  <OpportunityCard key={`${c.instrument}:${c.tf}`} card={c} />
                ))}
              </div>
            ))}

          {data.failed.length > 0 && (
            <p className="text-[11px] text-amber-600">取得できなかったペア: {data.failed.map(pairLabel).join(', ')}</p>
          )}

          {/* 見方と用語（折りたたみ） */}
          <details className="rounded-xl bg-white px-3 py-2 text-[11px] text-gray-600 shadow-sm">
            <summary className="cursor-pointer font-semibold text-gray-700">この画面の見方・用語</summary>
            <div className="mt-2 space-y-2 leading-relaxed">
              <p>
                <span className="font-semibold text-gray-800">方向</span>：ダウ理論で、高値・安値の切り上げは買い、切り下げは売り。レンジや転換の兆しは対象外です。
              </p>
              <p>
                <span className="font-semibold text-gray-800">損切り・目標</span>：TF分析ページと同じです。損切りは構造的なライン（ピボット＋ATR＋上位足・出来高などの重なり）、目標は上位足のスイング。
              </p>
              <p>
                <span className="font-semibold text-gray-800">好機・準好機</span>：TF分析で RR が成立（スプレッド込み 1:2.5以上・AI のその方向の確率・ローソク足パターンが逆向きでない）なら好機、成立しないが 1:2.0以上なら準好機です。
              </p>
              <p>
                <span className="font-semibold text-gray-800">総合スコア</span>：50を基準に、トレンド（ダウ理論・上位足の向き）・RR と損切りの強さ・入りどき・ローソク足パターン・プライスアクション（SMC）・AI（Jev）を加点/減点し、0〜100に換算します。同じ材料を二重に数えないよう、帯との位置・値幅の中の位置・RSI/ストキャスは「入りどき」にまとめています。
                <span className="ml-1 inline-flex gap-1 align-middle">
                  <span className="rounded bg-indigo-600 px-1 text-[10px] text-white">70〜 強い</span>
                  <span className="rounded bg-indigo-50 px-1 text-[10px] text-indigo-700">50〜 普通</span>
                  <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-500">〜49 弱い</span>
                </span>
              </p>
              <p>
                <span className="font-semibold text-gray-800">入りどき</span>：TF分析ページと同じ判定です。🟢入りどき（成行でよい）・🟡押し目待ち/戻り待ち（指値の目安あり）・🔴高値掴み注意/安値売り注意。詳細に指値・逆指値の目安を出します。
              </p>
              <dl className="space-y-1 border-t border-gray-100 pt-2">
                {PA_GLOSSARY.map(([term, desc]) => (
                  <div key={term}>
                    <dt className="font-semibold text-gray-800">{term}</dt>
                    <dd className="text-gray-500">{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </details>
          <p className="text-[10px] leading-relaxed text-gray-400">
            データは Yahoo Finance。※将来の値動きや利益を保証するものではありません。
          </p>
        </>
      )}
    </div>
  );
}
