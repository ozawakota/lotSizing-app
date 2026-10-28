import { describe, it, expect } from 'vitest';
import {
  SIGNAL_PAIRS,
  buildJevRequest,
  buildSignalPrompt,
  computeRecentTrend,
  parseJevAnswers,
  parseSignalResponse,
  confidenceLevel,
  signalVerdict,
  sortSignalsByStrength,
} from '../signal';
import type { RateSeries } from '../strength';
import type { NewsItem } from '../news';

const items: NewsItem[] = [
  { title: 'USD strengthens', link: 'x', pubDate: '', description: 'Dollar up on data' },
];

describe('buildSignalPrompt', () => {
  it('includes the target pairs, news and trend context', () => {
    const trends = SIGNAL_PAIRS.map((pair) => ({ pair, changePct: 0.3, direction: 'up' as const }));
    const prompt = buildSignalPrompt(items, trends);
    for (const p of SIGNAL_PAIRS) expect(prompt).toContain(p);
    expect(prompt).toContain('USD strengthens');
    expect(prompt).toContain('直近トレンド');
  });
});

describe('parseSignalResponse', () => {
  it('parses valid JSON and clamps/rounds values', () => {
    const raw = JSON.stringify({
      signals: [
        { pair: 'USD/JPY', buyPct: 150, confidence: 2, trend: 'continuation', trendPct: 70, rationale: 'strong' },
      ],
    });
    const out = parseSignalResponse(raw);
    const usd = out.find((s) => s.pair === 'USD/JPY')!;
    expect(usd.buyPct).toBe(100); // clamped
    expect(usd.confidence).toBe(1); // clamped
    expect(usd.trend).toBe('continuation');
    expect(usd.trendPct).toBe(70);
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'ここに結果:\n```json\n{"signals":[{"pair":"XAU/USD","buyPct":60,"confidence":0.5,"trend":"reversal","trendPct":55}]}\n```';
    const out = parseSignalResponse(raw);
    const xau = out.find((s) => s.pair === 'XAU/USD')!;
    expect(xau.buyPct).toBe(60);
    expect(xau.trend).toBe('reversal');
  });

  it('accepts an already-parsed object response (Workers AI may return an object)', () => {
    const obj = { signals: [{ pair: 'GBP/JPY', buyPct: 40, confidence: 0.6, trend: 'continuation', trendPct: 65 }] };
    const out = parseSignalResponse(obj);
    const gbp = out.find((s) => s.pair === 'GBP/JPY')!;
    expect(gbp.buyPct).toBe(40);
    expect(gbp.trend).toBe('continuation');
  });

  it('fills every pair with a neutral default when the response is broken/empty', () => {
    const out = parseSignalResponse('not json at all');
    expect(out.map((s) => s.pair)).toEqual(SIGNAL_PAIRS);
    for (const s of out) {
      expect(s.buyPct).toBe(50);
      expect(s.trend).toBe('neutral');
      expect(s.confidence).toBeCloseTo(0.3, 6);
    }
  });
});

describe('buildJevRequest', () => {
  it('creates buy_ and trend_ Choice questions per pair plus shared state', () => {
    const trends = SIGNAL_PAIRS.map((pair) => ({ pair, changePct: 0.2, direction: 'up' as const }));
    const { state, questions } = buildJevRequest(items, trends);
    expect((state as { news: unknown[] }).news).toHaveLength(items.length);
    for (const pair of SIGNAL_PAIRS) {
      const k = pair.replace(/\//g, '_');
      expect(questions[`buy_${k}`]).toMatchObject({ type: 'choice' });
      expect(questions[`trend_${k}`]).toMatchObject({ type: 'choice' });
    }
  });
});

describe('parseJevAnswers', () => {
  it('maps buy probability and trend choice/probability into PairSignal', () => {
    const answers = {
      buy_USD_JPY: { choice: 'buy', probabilities: { buy: 0.72, sell: 0.28 }, confidence: 0.8 },
      trend_USD_JPY: { choice: 'reversal', probabilities: { continuation: 0.3, reversal: 0.6, neutral: 0.1 }, confidence: 0.7 },
    };
    const usd = parseJevAnswers(answers).find((s) => s.pair === 'USD/JPY')!;
    expect(usd.buyPct).toBe(72);
    expect(usd.confidence).toBeCloseTo(0.8, 6);
    expect(usd.trend).toBe('reversal');
    expect(usd.trendPct).toBe(60);
  });

  it('defaults missing pairs to neutral 50/50', () => {
    const out = parseJevAnswers({});
    for (const s of out) {
      expect(s.buyPct).toBe(50);
      expect(s.trend).toBe('neutral');
      expect(s.trendPct).toBe(50);
    }
  });
});

describe('computeRecentTrend', () => {
  const mkSeries = (xjpy: Partial<Record<string, number[]>>): RateSeries => ({
    interval: '15min',
    datetimes: ['a', 'b', 'c'],
    rates: { USD: [1], EUR: [1], GBP: [1], AUD: [1], NZD: [1], CAD: [1], CHF: [1], ...xjpy } as RateSeries['rates'],
  });

  it('reports up/down from the series direction', () => {
    const up = computeRecentTrend(mkSeries({ USD: [100, 101, 102] }), 'USD/JPY', 2);
    expect(up.direction).toBe('up');
    expect(up.changePct).toBeGreaterThan(0);

    const down = computeRecentTrend(mkSeries({ GBP: [200, 199, 198] }), 'GBP/JPY', 2);
    expect(down.direction).toBe('down');
  });

  it('derives XAU/USD from XAU/JPY ÷ USD/JPY', () => {
    // XAU/JPY rises faster than USD/JPY → XAU/USD up.
    const s = mkSeries({ USD: [150, 150, 150], XAU: [300000, 306000, 312000] });
    const t = computeRecentTrend(s, 'XAU/USD', 2);
    expect(t.direction).toBe('up');
  });

  it('returns flat/null when the series is missing', () => {
    const t = computeRecentTrend(mkSeries({}), 'XAU/USD', 2); // no XAU
    expect(t.changePct).toBeNull();
    expect(t.direction).toBe('flat');
  });

  it('handles a null series', () => {
    expect(computeRecentTrend(null, 'USD/JPY').changePct).toBeNull();
  });
});

describe('アノマリーの加味', () => {
  const trends = SIGNAL_PAIRS.map((pair) => ({ pair, changePct: 0.1, direction: 'up' as const }));

  it('アノマリーがあればプロンプトに節を足し、無ければ出さない', () => {
    const withA = buildSignalPrompt(items, trends, undefined, '', '- 五十日（今日 9:55 の仲値まで）: … → USD/JPYが上がりやすい');
    expect(withA).toContain('# いま意識されやすいアノマリー');
    expect(withA).toContain('五十日');
    expect(withA).toContain('"anomaly"');
    expect(buildSignalPrompt(items, trends)).not.toContain('# いま意識されやすいアノマリー');
  });

  it('応答の anomaly を読み、無ければ空文字', () => {
    const raw = '{"signals":[{"pair":"USD/JPY","buyPct":64,"confidence":0.6,"trend":"continuation","trendPct":70,"rationale":"米金利上昇","anomaly":"五十日の仲値買いも追い風"}]}';
    const out = parseSignalResponse(raw);
    expect(out[0].anomaly).toBe('五十日の仲値買いも追い風');
    expect(out[1].anomaly).toBe('');
  });

  it('Jev の state にもアノマリーを入れる', () => {
    const body = buildJevRequest(items, trends, undefined, [], [{ title: '五十日（ごとうび）', when: '今日', detail: 'ドル買い' }]);
    expect((body.state as { anomalies?: unknown[] }).anomalies).toHaveLength(1);
    expect((buildJevRequest(items, trends).state as { anomalies?: unknown[] }).anomalies).toBeUndefined();
  });
});

describe('signalVerdict / confidenceLevel / sortSignalsByStrength', () => {
  it('60%以上=上昇、40%以下=下落、その間=方向感なし', () => {
    expect(signalVerdict({ buyPct: 60 })).toBe('up');
    expect(signalVerdict({ buyPct: 59 })).toBe('flat');
    expect(signalVerdict({ buyPct: 40 })).toBe('down');
  });

  it('確信度 0.7以上=高、0.4以上=中、それ未満=低', () => {
    expect(confidenceLevel(0.7)).toBe('high');
    expect(confidenceLevel(0.5)).toBe('mid');
    expect(confidenceLevel(0.39)).toBe('low');
  });

  it('傾き×確信度の大きい順', () => {
    const mk = (pair: (typeof SIGNAL_PAIRS)[number], buyPct: number, confidence: number) => ({ pair, buyPct, confidence, trend: 'neutral' as const, trendPct: 50, rationale: '' });
    const out = sortSignalsByStrength([mk('USD/JPY', 55, 0.9), mk('EUR/USD', 20, 0.5), mk('GBP/JPY', 70, 0.8)]);
    expect(out.map((s) => s.pair)).toEqual(['GBP/JPY', 'EUR/USD', 'USD/JPY']);
  });
});

describe('根拠のニュース番号（refs）', () => {
  it('1 始まりの番号を 0 始まりに直し、重複・不正値を除いて最大3つ', () => {
    const [s] = parseSignalResponse(
      JSON.stringify({ signals: [{ pair: 'USD/JPY', buyPct: 70, confidence: 0.6, refs: [2, 2, 0, 'x', 5, 1, 7] }] }),
      ['USD/JPY'],
    );
    expect(s.refs).toEqual([1, 4, 0]);
  });
  it('無ければ refs を付けない', () => {
    const [s] = parseSignalResponse(JSON.stringify({ signals: [{ pair: 'USD/JPY', buyPct: 70 }] }), ['USD/JPY']);
    expect(s.refs).toBeUndefined();
  });
});
