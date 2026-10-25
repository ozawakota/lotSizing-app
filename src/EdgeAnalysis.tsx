// RR好機ボード。各通貨ペア×時間足（15分/30分/1時間）で構造RRが成立した好機を、総合スコアの高い順に
// 1列カードで一覧表示する。RR≥1:2.5=好機・1:2.0〜2.5=準好機（別枠）。ペア・時間足・方向で絞り込める。
// カードには総合スコア（ダウ理論・上位足・帯・パターン・タイミング・AI の加減点）と内訳、抵抗帯に合わせた
// 損切り・目標の調整メモを出す。旧キャッシュ（総合スコアが無いカード）は従来の信用度を表示する。
// currency-strength worker(/ranking, VITE_RANKING_URL) が算出・KVキャッシュ。整形は src/lib/ranking.ts を共有。
// ※投資助言ではなく、値動きや利益を保証するものではない参考情報。
import { useEffect, useState, type ReactNode } from 'react';
import { RANKING_PAIRS, RANKING_TIMEFRAMES, type RrBoardSnapshot, type RrCard } from '@/lib/ranking';
import type { ScoreItem } from '@/lib/edgeScore';
import type { EntryKind } from '@/lib/entrySignal';
import type { SlTimeframe } from '@/lib/stoploss';

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

// 総合スコアの色（70以上=強調・50未満=薄く）。
const scoreCls = (n: number) => (n >= 70 ? 'text-indigo-700' : n >= 50 ? 'text-gray-700' : 'text-gray-400');
const scoreBar = (n: number) => (n >= 70 ? 'bg-indigo-500' : n >= 50 ? 'bg-gray-400' : 'bg-gray-300');

// 内訳の1項目（加点=緑・減点=赤）。
function ScoreChip({ item }: { item: ScoreItem }) {
  const plus = item.points > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] ${
        plus ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
      }`}
    >
      <span className="font-bold tabular-nums">
        {plus ? '+' : '−'}
        {Math.abs(item.points)}
      </span>
      {item.label}
    </span>
  );
}

// 1好機カード（ペア×TF）。見出し（ペア・時間足・売買・総合スコア）→ ダウ・タイミング → 入/損/利 → 調整メモ → 根拠（上位3つ＋内訳）。
// 旧キャッシュ（総合スコアが無い）は従来の信用度を表示する。
function OpportunityCard({ card }: { card: RrCard }) {
  const [open, setOpen] = useState(false);
  const d = digitsFor(card.instrument);
  const long = card.direction === 'long';
  const near = card.tier === 'near';
  const items = card.scoreItems ?? [];
  // 根拠の上位3つ（プライスアクションは下の専用の行に出すので除く）。
  const top = items.filter((it) => !it.label.startsWith('PA: ')).slice(0, 3);
  const pa = card.paTags ?? [];
  return (
    <div
      className={`rounded-lg border bg-white p-2.5 ${
        near ? 'border-dashed border-gray-300' : long ? 'border-green-200' : 'border-red-200'
      }`}
    >
      {/* 見出し */}
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${long ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
          {long ? '▲買い' : '▼売り'}
        </span>
        <span className="text-sm font-bold text-gray-800">{pairLabel(card.instrument)}</span>
        <span className="text-[11px] text-gray-500">{TF_LABEL[card.tf]}足</span>
        <span className="ml-auto text-right">
          {card.score != null ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-gray-100">
                <span className={`block h-full ${scoreBar(card.score)}`} style={{ width: `${card.score}%` }} />
              </span>
              <span className={`text-sm font-bold tabular-nums ${scoreCls(card.score)}`}>{card.score}</span>
            </span>
          ) : card.confidence != null ? (
            <span className="text-[11px] text-gray-500">
              信用度 {card.confidence}
              <span className="ml-0.5 text-[9px] text-gray-400">{card.confidenceSource ? SOURCE_LABEL[card.confidenceSource] : ''}</span>
            </span>
          ) : (
            <span className="text-[10px] text-gray-400">信用度 —</span>
          )}
        </span>
      </div>

      {/* ダウ理論の状態とタイミング */}
      {(card.dowLabel || card.entrySignal) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          {card.dowLabel && <span className="text-gray-600">ダウ: {card.dowLabel}</span>}
          {card.entrySignal && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${ENTRY_STYLE[card.entrySignal.kind].cls}`}>
              {ENTRY_STYLE[card.entrySignal.kind].icon}
              {card.entrySignal.label}
            </span>
          )}
        </div>
      )}

      {/* 入 / 損 / 利 と RR */}
      <div className="mt-1.5 grid grid-cols-[auto_1fr_1fr_1fr] items-end gap-x-2 text-[11px] tabular-nums">
        <span className="text-xs font-bold text-gray-800">RR 1:{card.rr.toFixed(1)}</span>
        <span className="text-right">
          <span className="block text-[9px] text-gray-400">エントリー</span>
          <span className="font-semibold text-gray-800">{card.entry.toFixed(d)}</span>
        </span>
        <span className="text-right">
          <span className="block text-[9px] text-gray-400">損切り −{card.riskPips}p</span>
          <span className="text-red-600">{card.stop.toFixed(d)}</span>
        </span>
        <span className="text-right">
          <span className="block text-[9px] text-gray-400">目標 +{card.rewardPips}p</span>
          <span className="text-green-600">{card.target.toFixed(d)}</span>
        </span>
      </div>
      {(card.stopNote || card.targetNote) && (
        <p className="mt-1 text-[10px] text-amber-700">
          {[card.stopNote, card.targetNote].filter(Boolean).join('・')}
        </p>
      )}

      {/* プライスアクション（SMC）: スイープ・オーダーブロック・FVG・OTE など */}
      {card.paTags && (
        <div className="mt-1.5 rounded bg-gray-50 px-1.5 py-1">
          <p className="text-[10px] font-semibold text-gray-500">プライスアクション</p>
          {pa.length === 0 ? (
            <p className="text-[10px] text-gray-400">目立った痕跡なし</p>
          ) : (
            <ul className="mt-0.5 space-y-0.5">
              {pa.map((t, k) => (
                <li key={k} className="flex items-center gap-1 text-[11px]">
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                      t.tone === 'with' ? 'bg-green-500' : t.tone === 'against' ? 'bg-red-500' : 'bg-gray-300'
                    }`}
                  />
                  <span className={t.tone === 'against' ? 'text-red-700' : t.tone === 'with' ? 'text-gray-800' : 'text-gray-500'}>
                    {t.label}
                  </span>
                  {t.points !== 0 && (
                    <span className={`ml-auto shrink-0 tabular-nums text-[10px] ${t.points > 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {t.points > 0 ? '+' : '−'}
                      {Math.abs(t.points)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 根拠: 影響の大きい3つ＋内訳 */}
      {top.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {top.map((it, k) => (
            <ScoreChip key={k} item={it} />
          ))}
        </div>
      )}
      {items.length > top.length && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="mt-1 text-[10px] text-gray-500 underline-offset-2 hover:underline"
          >
            {open ? '内訳を閉じる' : `内訳をすべて見る（${items.length}）`}
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5 border-t border-gray-100 pt-1 text-[10px]">
              <li className="flex justify-between text-gray-400">
                <span>基準</span>
                <span className="tabular-nums">50</span>
              </li>
              {items.map((it, k) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="text-gray-600">{it.label}</span>
                  <span className={`shrink-0 font-semibold tabular-nums ${it.points > 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {it.points > 0 ? '+' : '−'}
                    {Math.abs(it.points)}
                  </span>
                </li>
              ))}
              <li className="flex justify-between border-t border-gray-100 pt-0.5 font-bold text-gray-700">
                <span>総合スコア（合計を0〜100に換算）</span>
                <span className="tabular-nums">{card.score}</span>
              </li>
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// 絞り込みのチップ。
function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${on ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600'}`}
    >
      {children}
    </button>
  );
}

type DirFilter = 'all' | 'long' | 'short';

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
  const [tfs, setTfs] = useState<SlTimeframe[]>([]); // 空=すべて
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

  return (
    <div className="mx-auto max-w-md px-3 my-2">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-gray-500">RR好機（15分/30分/1時間足・総合スコア順）</p>
        <button
          type="button"
          onClick={() => void load(true)}
          className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 active:bg-gray-200"
        >
          更新
        </button>
      </div>

      {loading && <p className="mt-3 text-sm text-gray-500">分析中…</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {data && (
        <div className="space-y-2">
          {data.jevPaused && (
            <p className="rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
              AI（Jev）は一時停止中（使用上限）。総合スコアは AI を除いた材料で計算しています。
            </p>
          )}
          {/* 絞り込み: ペア・時間足・方向 */}
          <div className="space-y-1.5 rounded-lg bg-white p-2 shadow-sm">
            <div className="flex items-center gap-2">
              <select
                value={pair}
                onChange={(e) => setPair(e.target.value)}
                className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
                aria-label="通貨ペア"
              >
                <option value="all">すべてのペア</option>
                {RANKING_PAIRS.map((p) => (
                  <option key={p} value={p}>
                    {pairLabel(p)}
                  </option>
                ))}
              </select>
              <div className="ml-auto flex gap-1">
                {(['all', 'long', 'short'] as DirFilter[]).map((v) => (
                  <FilterChip key={v} on={dir === v} onClick={() => setDir(v)}>
                    {v === 'all' ? '売買とも' : v === 'long' ? '買い' : '売り'}
                  </FilterChip>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <FilterChip on={tfs.length === 0} onClick={() => setTfs([])}>
                全時間足
              </FilterChip>
              {SETUP_TFS.map((t) => (
                <FilterChip
                  key={t}
                  on={tfs.includes(t)}
                  onClick={() => setTfs((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
                >
                  {TF_LABEL[t]}足
                </FilterChip>
              ))}
              <label className="ml-auto flex items-center gap-1 text-[11px] text-gray-600">
                <input type="checkbox" checked={showNear} onChange={(e) => setShowNear(e.target.checked)} />
                準好機も表示
              </label>
            </div>
          </div>

          {(() => {
            const shown = data.cards.filter(
              (c) =>
                (pair === 'all' || c.instrument === pair) &&
                (tfs.length === 0 || tfs.includes(c.tf)) &&
                (dir === 'all' || c.direction === dir),
            );
            const prime = shown.filter((c) => c.tier !== 'near');
            const near = shown.filter((c) => c.tier === 'near');
            return (
              <>
                <p className="flex items-baseline justify-between text-xs font-bold text-gray-700">
                  好機 <span className="font-normal text-gray-400">RR 1:2.5以上・{prime.length}件</span>
                </p>
                {prime.length === 0 ? (
                  <p className="py-3 text-center text-sm text-gray-400">条件を満たす好機はありません。</p>
                ) : (
                  <div className="space-y-2">
                    {prime.map((c) => (
                      <OpportunityCard key={`${c.instrument}:${c.tf}`} card={c} />
                    ))}
                  </div>
                )}
                {showNear && (
                  <>
                    <p className="mt-3 flex items-baseline justify-between text-xs font-bold text-gray-500">
                      準好機 <span className="font-normal text-gray-400">RR 1:2.0〜2.5・{near.length}件</span>
                    </p>
                    {near.length === 0 ? (
                      <p className="py-2 text-center text-[11px] text-gray-400">準好機はありません。</p>
                    ) : (
                      <div className="space-y-2">
                        {near.map((c) => (
                          <OpportunityCard key={`${c.instrument}:${c.tf}`} card={c} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            );
          })()}
          {data.failed.length > 0 && (
            <p className="text-[11px] text-amber-600">取得できなかったペア: {data.failed.map(pairLabel).join(', ')}</p>
          )}
          <details className="rounded bg-white px-2 py-1.5 text-[11px] text-gray-600 shadow-sm">
            <summary className="cursor-pointer font-semibold text-gray-700">プライスアクションの用語</summary>
            <dl className="mt-1 space-y-1">
              {PA_GLOSSARY.map(([term, desc]) => (
                <div key={term}>
                  <dt className="font-semibold text-gray-800">{term}</dt>
                  <dd className="text-gray-500">{desc}</dd>
                </div>
              ))}
            </dl>
          </details>
          <p className="text-[10px] leading-relaxed text-gray-400">
            方向はダウ理論（高値・安値の切り上げ＝買い／切り下げ＝売り。レンジ・転換の兆しは対象外）。
            損切りはピボット＋ATR に、目標は上位足のスイングに置き、抵抗帯に合わせて調整します（損切りは帯の外、目標は途中の★2以上の帯の手前）。
            スプレッド込みの実質RRが1:2.5以上を「好機」、1:2.0〜2.5を「準好機」とし、総合スコアの高い順に並べます。
            総合スコアは50を基準に、ダウ理論・上位足の向き・RR・損切りラインの強さ・帯との位置・ローソク足パターン・
            プライスアクション（流動性スイープ・オーダーブロック・FVG・プレミアム/ディスカウント・OTE・ディスプレイスメント）・
            タイミング（🟢押し目/戻り・🟡様子見・⚠反転警戒）・RSI/ストキャス・AI（Jevのブレイク確率）を加減点し、
            合計を0〜100に換算したものです（材料がそろうほど100に近づきます）。
            対象は{SETUP_TFS.map((t) => TF_LABEL[t]).join('/')}足（4時間足は目標に使用）。データは Yahoo Finance。
            {data.generatedAt
              ? ` ${new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新。`
              : ''}
            ※将来の値動きや利益を保証するものではありません。
          </p>
        </div>
      )}
    </div>
  );
}
