import { describe, it, expect } from 'vitest';
import { buildChatSystemPrompt, buildMarketContext, sanitizeHistory } from '../chat';

describe('buildMarketContext', () => {
  it('formats strength / flow / signals / news sections', () => {
    const ctx = buildMarketContext({
      strength: [
        { currency: 'JPY', score: 1.2 },
        { currency: 'USD', score: -0.8 },
      ],
      flow: [{ pair: 'USD/JPY', lean: 'buy', longPct: 63 }],
      signals: [{ pair: 'USD/JPY', buyPct: 60, trend: 'continuation' }],
      newsSummary: 'ドル高が継続。',
    });
    expect(ctx).toContain('通貨強弱');
    expect(ctx).toContain('JPY+1.20');
    expect(ctx).toContain('USD-0.80');
    expect(ctx).toContain('買い優勢');
    expect(ctx).toContain('買60%/継続');
    expect(ctx).toContain('ドル高が継続');
  });

  it('falls back when no data', () => {
    expect(buildMarketContext({})).toContain('取得できていません');
  });
});

describe('sanitizeHistory', () => {
  it('keeps only valid user/assistant messages, trims, limits count', () => {
    const raw = [
      { role: 'user', content: '  hi  ' },
      { role: 'system', content: 'should be dropped' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: '' },
      { role: 'user', content: 123 },
    ];
    const out = sanitizeHistory(raw);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
  });

  it('limits to the last maxHistory', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const out = sanitizeHistory(many, 8);
    expect(out).toHaveLength(8);
    expect(out[0].content).toBe('m4');
  });

  it('returns [] for non-array', () => {
    expect(sanitizeHistory(null)).toEqual([]);
  });
});

describe('buildChatSystemPrompt', () => {
  it('embeds the context and the no-advice instruction', () => {
    const p = buildChatSystemPrompt('【通貨強弱】...');
    expect(p).toContain('現在の相場データ');
    expect(p).toContain('【通貨強弱】');
    expect(p).toContain('投資助言は避け');
  });
});
