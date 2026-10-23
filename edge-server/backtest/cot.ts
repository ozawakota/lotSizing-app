// 投機筋（CFTC COT）の偏りと、その後の値動きの関係を実データで検証する。
//   cd edge-server && npm install && npm run backtest:cot                    # 全11ペア・2010年〜・1/4/12週先
//   npm run backtest:cot -- --from 2015-01-01 --pairs USD/JPY,EUR/USD --horizons 4,12
//   npm run backtest:cot -- --out samples.csv                                # 週ごとのサンプルも CSV に保存
//   npm run backtest:cot -- --cot-csv cot.csv --price-csv USD/JPY=usdjpy.csv # 手元の CSV で検証（通信なし）
//     cot.csv: ヘッダー1行＋「報告日(YYYY-MM-DD),通貨(USD/JPY/EUR/…/XAU),買い,売り」
//     価格 CSV: ヘッダー1行＋1列目が日付、5列以上なら5列目（Close）、それ以外は2列目を終値とみなす（MT5 のエクスポート等）
// COT は CFTC の公開 API（キー不要）、価格は Dukascopy の日足（Bid）。
// ※過去データでの検証結果であり、将来の値動きを保証しない。
import { readFileSync, writeFileSync } from 'node:fs';
import { getHistoricalRates } from 'dukascopy-node';
import {
  COT_DEFAULTS,
  buildCotSamples,
  buildPairNetSeries,
  pairCurrencies,
  summarizeCot,
  type CotRow,
  type CotSample,
  type DailyClose,
  type GroupStats,
} from '../../src/lib/cotBacktest';
import { COT_CONTRACT_CODES, FLOW_PAIRS, type CotCurrency, type FlowPair } from '../../src/lib/flow';

const CFTC_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
const PAGE = 50_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const args = (name: string) => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []));

// CFTC Legacy（先物のみ）から、対象通貨の非商業建玉を from 以降すべて取る。
async function fetchCot(from: string, currencies: CotCurrency[]): Promise<CotRow[]> {
  const codeToCur = new Map(currencies.map((c) => [COT_CONTRACT_CODES[c], c]));
  const codes = [...codeToCur.keys()].map((c) => `'${c}'`).join(',');
  const out: CotRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({
      $select: 'cftc_contract_market_code,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all',
      $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${from}T00:00:00'`,
      $order: 'report_date_as_yyyy_mm_dd ASC',
      $limit: String(PAGE),
      $offset: String(offset),
    });
    const res = await fetch(`${CFTC_URL}?${params}`, { headers: { 'User-Agent': 'lotsizing-cot-backtest/1.0' } });
    if (!res.ok) throw new Error(`CFTC HTTP ${res.status}`);
    const rows = (await res.json()) as Record<string, string>[];
    for (const r of rows) {
      const currency = codeToCur.get(r.cftc_contract_market_code);
      const long = Number(r.noncomm_positions_long_all);
      const short = Number(r.noncomm_positions_short_all);
      if (!currency || !Number.isFinite(long) || !Number.isFinite(short)) continue;
      out.push({ date: r.report_date_as_yyyy_mm_dd.slice(0, 10), currency, long, short });
    }
    if (rows.length < PAGE) return out;
  }
}

// Dukascopy の日足（Bid）の終値。
async function fetchCloses(pair: FlowPair, from: string): Promise<DailyClose[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dukascopy-node の instrument は巨大な列挙型
  const rows = (await getHistoricalRates({
    instrument: pair.replace('/', '').toLowerCase(),
    dates: { from: new Date(`${from}T00:00:00Z`), to: new Date() },
    timeframe: 'd1',
    priceType: 'bid',
    format: 'array',
    ignoreFlats: true,
    batchSize: 10,
    pauseBetweenBatchesMs: 500,
    retryCount: 8,
    pauseBetweenRetriesMs: 3000,
  } as any)) as [number, number, number, number, number][];
  return rows.map(([t, , , , close]) => ({ date: new Date(t).toISOString().slice(0, 10), close }));
}

// "2024.01.02" / "2024-01-02 00:00" / "2024/1/2" → "2024-01-02"
const normDate = (s: string): string | null => {
  const m = s.trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};

const csvLines = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(/[,\t;]/));

function loadCotCsv(path: string): CotRow[] {
  return csvLines(path).flatMap((c) => {
    const date = normDate(c[0] ?? '');
    const currency = (c[1] ?? '').trim().toUpperCase() as CotCurrency;
    const long = Number(c[2]);
    const short = Number(c[3]);
    return date && currency in COT_CONTRACT_CODES && Number.isFinite(long) && Number.isFinite(short) ? [{ date, currency, long, short }] : [];
  });
}

function loadPriceCsv(path: string): DailyClose[] {
  return csvLines(path)
    .flatMap((c) => {
      const date = normDate(c[0] ?? '');
      const close = Number(c.length >= 5 ? c[4] : c[1]);
      return date && Number.isFinite(close) && close > 0 ? [{ date, close }] : [];
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const tableRow = (pair: string, s: GroupStats) => ({
  pair,
  週先: s.horizonWeeks,
  条件: s.group,
  件数: s.n,
  '平均%': s.meanPct,
  '勝率%': s.hitRate,
  t値: s.t,
});

async function main() {
  const from = arg('--from') ?? '2010-01-01';
  const horizons = (arg('--horizons') ?? COT_DEFAULTS.horizonsWeeks.join(','))
    .split(',')
    .map(Number)
    .filter((h) => h > 0);
  const priceCsv = new Map(
    args('--price-csv').map((kv) => {
      const [pair, path] = kv.split('=');
      return [pair.replace('_', '/').toUpperCase(), path] as const;
    }),
  );
  const cotCsv = arg('--cot-csv');
  const pairs = (arg('--pairs')?.split(',').map((p) => p.replace('_', '/').toUpperCase()) ?? (priceCsv.size ? [...priceCsv.keys()] : FLOW_PAIRS)).filter(
    (p): p is FlowPair => (FLOW_PAIRS as string[]).includes(p),
  );
  if (pairs.length === 0) throw new Error(`対象ペアがありません（使えるのは ${FLOW_PAIRS.join(', ')}）`);

  const currencies = [...new Set(pairs.flatMap(pairCurrencies))];
  process.stderr.write(cotCsv ? `COT を ${cotCsv} から読み込み…\n` : `CFTC から COT を取得中（${from}〜）…\n`);
  const cot = (cotCsv ? loadCotCsv(cotCsv) : await fetchCot(from, currencies)).filter((r) => r.date >= from);
  process.stderr.write(`COT ${cot.length} 行\n`);

  const opts = { horizonsWeeks: horizons };
  const perPair: ReturnType<typeof tableRow>[] = [];
  const pooled: CotSample[] = [];
  const csvOut: string[] = ['pair,report_date,entry_date,net,lean,strength,delta_net,cot_index,' + horizons.map((h) => `fwd_${h}w_pct`).join(',')];
  for (const pair of pairs) {
    const series = buildPairNetSeries(cot, pair);
    if (series.length === 0) {
      process.stderr.write(`${pair}: COT がそろわないため対象外\n`);
      continue;
    }
    const path = priceCsv.get(pair);
    process.stderr.write(path ? `${pair}: 価格を ${path} から読み込み…\n` : `${pair}: Dukascopy から日足を取得中…\n`);
    const closes = path ? loadPriceCsv(path) : await fetchCloses(pair, from);
    const samples = buildCotSamples(series, closes, opts);
    pooled.push(...samples);
    for (const s of summarizeCot(samples, horizons)) perPair.push(tableRow(pair, s));
    for (const s of samples) {
      csvOut.push(
        [pair, s.reportDate, s.entryDate, s.net.toFixed(4), s.lean, s.strength ?? '', s.deltaNet?.toFixed(4) ?? '', s.cotIndex?.toFixed(1) ?? '', ...horizons.map((h) => s.fwd[h]?.toFixed(4) ?? '')].join(','),
      );
    }
  }

  console.log('\n■ 全ペア合算（ペア同士は通貨を共有して連動するため、件数ほどの独立性はない）');
  console.table(summarizeCot(pooled, horizons).map((s) => tableRow('全ペア', s)));
  console.log('\n■ ペア別');
  console.table(perPair);
  console.log(
    [
      '平均%: 大口（投機筋）の向きに乗った場合の平均騰落率（プラス＝乗ると有利、マイナス＝逆張りが有利）。スプレッド・スワップは含まない。',
      '極端な偏り: 直近3年の中で最も買い越し側/売り越し側の10%の週。マイナスなら、その後は逆に動きやすかった。',
      'トレンド分を除く: 各週のリターンから期間平均（買い持ち）を引いた値。「全体」がプラスでもこちらが0付近なら、偏りの効果ではなく相場全体の流れによる。',
      't値: 保有期間の重なりを粗く補正した値。|t| が2未満なら偶然の範囲と考えるのが無難。',
    ].join('\n'),
  );

  const out = arg('--out');
  if (out) {
    writeFileSync(out, csvOut.join('\n') + '\n');
    console.log(`\n週ごとのサンプルを ${out} に保存しました（${csvOut.length - 1} 行）。`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
