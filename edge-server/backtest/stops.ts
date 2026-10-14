// 損切りラインの新旧比較を Dukascopy の実データで実行する。
//   cd edge-server && npm install && npx tsx backtest/stops.ts            # 既定（RR好機通知の4ペア×15m/30m/1h）
//   npx tsx backtest/stops.ts --sweep                                     # 構造的損切りのバッファ×最小距離も比較
//   npx tsx backtest/stops.ts --csv data.csv --pair EUR_USD --tf 1h [--sweep]
//     # 手元の CSV（ヘッダー1行＋「日時,Open,High,Low,Close[,...]」, MT5 のエクスポート等）で検証
// 結果は表で表示（期待値R・損切り率・目標到達率・刈られ率・平均損切り幅）。
// ※過去データでの検証結果であり、将来の成績を保証しない。
import { readFileSync } from 'node:fs';
import { getHistoricalRates } from 'dukascopy-node';
import { backtestStops, type BacktestStats } from '../../src/lib/stopBacktest';
import { RR_MIN, typicalSpreadPips, type Candle, type SlTimeframe } from '../../src/lib/stoploss';

const PAIRS = ['XAU_USD', 'USD_JPY', 'EUR_USD', 'GBP_USD'];
// 足ごとの検証期間（日）と Dukascopy の足の名前。
const TFS: { tf: SlTimeframe; duka: 'm15' | 'm30' | 'h1'; days: number }[] = [
  { tf: '15m', duka: 'm15', days: 120 },
  { tf: '30m', duka: 'm30', days: 240 },
  { tf: '1h', duka: 'h1', days: 365 },
];
const SWEEP_BUFFERS = [0.1, 0.25, 0.5]; // ラインからのバッファ（ATR 倍）
const SWEEP_MIN_DIST = [0.5, 1, 1.5]; // エントリーからの最小距離（ATR 倍）。近すぎるラインはノイズで刈られやすい

async function load(instrument: string, duka: string, days: number): Promise<Candle[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dukascopy-node の instrument は巨大な列挙型
  const rows = (await getHistoricalRates({
    instrument: instrument.replace('_', '').toLowerCase(),
    dates: { from, to },
    timeframe: duka,
    priceType: 'bid',
    format: 'array',
    ignoreFlats: true,
    batchSize: 10,
    pauseBetweenBatchesMs: 500,
    retryCount: 8,
    pauseBetweenRetriesMs: 3000,
  } as any)) as [number, number, number, number, number][];
  return rows.map(([t, open, high, low, close]) => ({ t: Math.floor(t / 1000), open, high, low, close }));
}

const row = (pair: string, tf: string, label: string, s: BacktestStats) => ({
  pair,
  tf,
  method: label,
  trades: s.trades,
  'E[R]': s.expectancyR,
  '損切%': s.stopRate,
  '目標%': s.targetRate,
  '期限%': s.timeoutRate,
  '刈られ%': s.whipsawRate,
  '平均幅pips': s.avgRiskPips,
});

// CSV（ヘッダー1行、2〜5列目が Open,High,Low,Close）を読む。区切りはカンマ/タブ。
function loadCsv(path: string): Candle[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(/[,\t]/))
    .map((c) => ({ open: +c[1], high: +c[2], low: +c[3], close: +c[4] }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const sweep = process.argv.includes('--sweep');
  const csv = arg('--csv');
  const rows: ReturnType<typeof row>[] = [];
  const jobs: { pair: string; tf: string; load: () => Promise<Candle[]> }[] = csv
    ? [{ pair: arg('--pair') ?? 'EUR_USD', tf: arg('--tf') ?? '1h', load: async () => loadCsv(csv) }]
    : PAIRS.flatMap((pair) =>
        TFS.map(({ tf, duka, days }) => ({
          pair,
          tf,
          load: () => {
            process.stderr.write(`取得中 ${pair} ${tf} (${days}日)…\n`);
            return load(pair, duka, days);
          },
        })),
      );
  for (const { pair, tf, load: loadCandles } of jobs) {
    const candles = await loadCandles();
    const base = { instrument: pair, rewardR: RR_MIN, spreadPips: typicalSpreadPips(pair) };
    const r = backtestStops(candles, base);
    rows.push(row(pair, tf, '旧: 24本の極値', r.legacy), row(pair, tf, '新: 構造的', r.structural));
    if (sweep) {
      for (const b of SWEEP_BUFFERS) {
        for (const d of SWEEP_MIN_DIST) {
          const s = backtestStops(candles, { ...base, stopOptions: { bufferAtr: b, minDistAtr: d } }).structural;
          rows.push(row(pair, tf, `新: バッファ${b}・最小距離${d}ATR`, s));
        }
      }
    }
  }
  console.table(rows);
  console.log(`目標=リスクの${RR_MIN}倍、同じ足で損切りと目標に触れたら損切り扱い、期待値はスプレッド控除後。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
