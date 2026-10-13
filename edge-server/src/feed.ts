// Dukascopy（キー不要）からローソク足を取得するアダプタ。dukascopy-node を使う。
// 過去分は getHistoricalRates（日/月単位のファイル、直近は反映が遅れる）、
// 直近分は getRealTimeRates（最新 N 本）で取り、Bid の OHLC と Ask の終値を時刻で突き合わせる。
import { getHistoricalRates, getRealTimeRates } from 'dukascopy-node';
import type { EdgeTimeframe } from '../../src/lib/edge';
import type { Feed } from './engine';
import { combineBidAsk, type Row } from './store';

const DUKA_TF = { '1m': 'm1', '5m': 'm5', '15m': 'm15', '1h': 'h1', '4h': 'h4', '1d': 'd1' } as const satisfies Record<
  EdgeTimeframe,
  string
>;

// 'USD_JPY' → 'usdjpy'（XAU_USD は現物スポット xauusd）
const dukaInstrument = (instrument: string) => instrument.replace('_', '').toLowerCase();

export const dukascopyFeed: Feed = {
  async history(instrument, tf, fromMs, toMs) {
    const base = {
      instrument: dukaInstrument(instrument),
      dates: { from: new Date(fromMs), to: new Date(toMs) },
      timeframe: DUKA_TF[tf],
      format: 'array',
      ignoreFlats: true, // 週末などの値動き無し足を除く
      batchSize: 10,
      pauseBetweenBatchesMs: 500,
      retryCount: 3,
    } as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dukascopy-node の instrument は巨大な列挙型
    const bid = (await getHistoricalRates({ ...base, priceType: 'bid' } as any)) as Row[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ask = (await getHistoricalRates({ ...base, priceType: 'ask' } as any)) as Row[];
    return combineBidAsk(bid, ask);
  },

  async recent(instrument, tf, last) {
    const base = { instrument: dukaInstrument(instrument), timeframe: DUKA_TF[tf], format: 'array', last } as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bid = (await getRealTimeRates({ ...base, priceType: 'bid' } as any)) as Row[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ask = (await getRealTimeRates({ ...base, priceType: 'ask' } as any)) as Row[];
    return combineBidAsk(bid, ask);
  },
};
