import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDGE_HISTORY_DAYS, EDGE_PAIRS, TIMEFRAME_MS, type EdgeSnapshot, type EdgeTimeframe } from '../../src/lib/edge';
import { EdgeEngine, RECENT_BARS, type Feed } from '../src/engine';
import { nextDue, REFRESH_MS, SETTLE_MS } from '../src/scheduler';
import { createHandler } from '../src/server';
import { SeriesStore, avgSpreadPips, combineBidAsk, mergeBars, pruneBefore, type Bar } from '../src/store';

const bar = (t: number, close: number, ask?: number): Bar => ({ t, open: close, high: close + 0.1, low: close - 0.1, close, ask });

describe('store の純関数', () => {
  it('mergeBars は時刻順に統合し、同時刻は新しい方で上書き（ask は欠けていれば既存を残す）', () => {
    const merged = mergeBars([bar(1, 100, 100.01), bar(2, 101, 101.01)], [bar(2, 102), bar(3, 103, 103.01), bar(0, 99)]);
    expect(merged.map((b) => [b.t, b.close, b.ask])).toEqual([
      [0, 99, undefined],
      [1, 100, 100.01],
      [2, 102, 101.01],
      [3, 103, 103.01],
    ]);
  });

  it('pruneBefore は期間外の足を捨てる', () => {
    expect(pruneBefore([bar(1, 1), bar(5, 1), bar(9, 1)], 5).map((b) => b.t)).toEqual([5, 9]);
  });

  it('avgSpreadPips は Ask−Bid の平均（pips）。ask 無しと負値は除外', () => {
    const bars = [bar(1, 150, 150.008), bar(2, 150, 150.012), bar(3, 150), bar(4, 150, 149.9)];
    expect(avgSpreadPips(bars, 'USD_JPY')).toBeCloseTo(1.0, 5);
    expect(avgSpreadPips([bar(1, 1)], 'EUR_USD')).toBe(0);
  });

  it('SeriesStore は保存した系列を別インスタンスから読み戻せる', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'edge-store-'));
    try {
      await new SeriesStore(dir).set('USD_JPY', '1h', [bar(1, 150, 150.01)]);
      expect(await new SeriesStore(dir).get('USD_JPY', '1h')).toEqual([bar(1, 150, 150.01)]);
      expect(JSON.parse(await readFile(path.join(dir, 'USD_JPY_1h.json'), 'utf8'))).toHaveLength(1);
      expect(await new SeriesStore(dir).get('EUR_USD', '1h')).toEqual([]); // 未保存は空
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('combineBidAsk', () => {
  it('Bid の OHLC に同時刻の Ask 終値を付け、秒に変換する', () => {
    const bars = combineBidAsk(
      [
        [60_000, 1, 2, 0.5, 1.5],
        [120_000, 1.5, 2, 1, 1.8],
      ],
      [[60_000, 1, 2, 0.5, 1.6]],
    );
    expect(bars).toEqual([
      { t: 60, open: 1, high: 2, low: 0.5, close: 1.5, ask: 1.6 },
      { t: 120, open: 1.5, high: 2, low: 1, close: 1.8, ask: undefined },
    ]);
  });
});

describe('scheduler.nextDue', () => {
  it('間隔の区切り + 待ち時間 の次の時刻を返す', () => {
    const base = 1_700_000_000_000 - (1_700_000_000_000 % REFRESH_MS['5m']); // 5分の区切り
    expect(nextDue('5m', base)).toBe(base + SETTLE_MS);
    expect(nextDue('5m', base + SETTLE_MS)).toBe(base + REFRESH_MS['5m'] + SETTLE_MS);
  });
});

// 1時間ごとの合成足（下ヒゲピンバー → 上昇 を繰り返す）。t は秒。
function synthetic(fromMs: number, toMs: number, tf: EdgeTimeframe): Bar[] {
  const out: Bar[] = [];
  const step = TIMEFRAME_MS[tf];
  let p = 150;
  for (let ms = Math.ceil(fromMs / step) * step, i = 0; ms <= toMs; ms += step, i++) {
    const pin = i % 5 === 0;
    const o = p;
    const c = pin ? o + 0.01 : i % 5 === 4 ? o - 0.15 : o + 0.1;
    out.push({ t: ms / 1000, open: o, high: Math.max(o, c) + 0.01, low: pin ? o - 0.3 : Math.min(o, c) - 0.01, close: c, ask: c + 0.008 });
    p = c;
  }
  return out;
}

describe('EdgeEngine', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'edge-engine-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const NOW = Date.UTC(2026, 9, 13, 12, 0, 30);

  function fakeFeed(failFor: string[] = []) {
    const calls: string[] = [];
    const feed: Feed = {
      async history(instrument, tf, fromMs, toMs) {
        calls.push(`history:${instrument}`);
        if (failFor.includes(instrument)) throw new Error('down');
        return synthetic(fromMs, toMs - 2 * TIMEFRAME_MS[tf], tf); // 過去分は直近が欠ける想定
      },
      async recent(instrument, tf, last) {
        calls.push(`recent:${instrument}`);
        if (failFor.includes(instrument)) throw new Error('down');
        return synthetic(NOW - last * TIMEFRAME_MS[tf], NOW, tf); // 最後は形成中の足
      },
    };
    return { feed, calls };
  }

  it('初回は過去分＋直近分で全ペアを集計し、形成中の足を除き、スプレッドを控除する', async () => {
    const { feed, calls } = fakeFeed();
    const engine = new EdgeEngine(feed, new SeriesStore(dir), () => NOW, () => {});
    const snap = await engine.refresh('1h');

    expect(snap.pairs.map((p) => p.instrument)).toEqual(EDGE_PAIRS);
    expect(snap.failed).toEqual([]);
    expect(snap.source).toBe('dukascopy');
    expect(calls.filter((c) => c.startsWith('history'))).toHaveLength(EDGE_PAIRS.length);
    const usdjpy = snap.pairs.find((p) => p.instrument === 'USD_JPY')!;
    expect(usdjpy.spreadPips).toBeCloseTo(0.8, 5); // ask − bid = 0.008円
    expect(usdjpy.lastClosedAt! * 1000 + TIMEFRAME_MS['1h']).toBeLessThanOrEqual(NOW); // 形成中の足は使わない
    expect(engine.snapshot('1h')).toBe(snap);

    // 保存された系列は統計期間内に収まる
    const saved = await new SeriesStore(dir).get('USD_JPY', '1h');
    expect(saved[0].t * 1000).toBeGreaterThanOrEqual(NOW - EDGE_HISTORY_DAYS['1h'] * 86_400_000);
  });

  it('2回目以降は直近分だけ取り直す（空白が直近本数に収まる場合）', async () => {
    const { feed, calls } = fakeFeed();
    const engine = new EdgeEngine(feed, new SeriesStore(dir), () => NOW, () => {});
    await engine.refresh('1h');
    calls.length = 0;
    await engine.refresh('1h');
    expect(calls.every((c) => c.startsWith('recent'))).toBe(true);
    expect(RECENT_BARS).toBeGreaterThan(2);
  });

  it('取得に失敗したペアは保存済みの足で集計し、足が無ければ failed に入れる', async () => {
    const first = fakeFeed();
    await new EdgeEngine(first.feed, new SeriesStore(dir), () => NOW, () => {}).refresh('1h');

    const down = fakeFeed(['USD_JPY']);
    const snap = await new EdgeEngine(down.feed, new SeriesStore(dir), () => NOW, () => {}).refresh('1h');
    expect(snap.pairs.some((p) => p.instrument === 'USD_JPY')).toBe(true); // 保存済みで継続
    expect(snap.failed).toEqual([]);

    const fresh = await mkdtemp(path.join(os.tmpdir(), 'edge-engine-'));
    try {
      const snap2 = await new EdgeEngine(down.feed, new SeriesStore(fresh), () => NOW, () => {}).refresh('1h');
      expect(snap2.failed).toEqual(['USD_JPY']);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe('HTTP ハンドラ', () => {
  let server: Server;
  let base: string;
  const snap = { timeframe: '1h', pairs: [] } as unknown as EdgeSnapshot;

  beforeEach(async () => {
    server = createServer(createHandler((tf) => (tf === '1h' ? snap : undefined), 'https://app.example'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('/edge は集計済みスナップショットを CORS ヘッダ付きで返す', async () => {
    const res = await fetch(`${base}/edge?timeframe=1h`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(await res.json()).toEqual(snap);
  });

  it('未集計の時間足は 503、不明な時間足は 1h 扱い、/health は準備済みの足を返す', async () => {
    expect((await fetch(`${base}/edge?timeframe=1m`)).status).toBe(503);
    expect((await fetch(`${base}/edge?timeframe=bogus`)).status).toBe(200);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, ready: ['1h'] });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
