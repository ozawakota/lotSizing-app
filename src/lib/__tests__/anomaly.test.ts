import { describe, it, expect } from 'vitest';
import { anomaliesForPair, detectAnomalies, formatAnomalyDigest, isGotobi, isLastBusinessDay } from '../anomaly';
import type { EconEvent } from '../news';

// JST の日時 → Date。
const jst = (s: string) => new Date(`${s}+09:00`);
const ids = (now: Date, cal: EconEvent[] = []) => detectAnomalies(now, cal).map((a) => a.id);

describe('isGotobi（五十日）', () => {
  it('5・10・15・20・25日と月末。土日なら直前の金曜に振り替え', () => {
    expect(isGotobi(jst('2026-10-05T08:00:00').getTime())).toBe(true); // 月曜の5日
    expect(isGotobi(jst('2026-10-20T08:00:00').getTime())).toBe(true);
    expect(isGotobi(jst('2026-10-21T08:00:00').getTime())).toBe(false);
    expect(isGotobi(jst('2026-10-09T08:00:00').getTime())).toBe(true); // 10日(土)の振替
    expect(isGotobi(jst('2026-10-10T08:00:00').getTime())).toBe(false); // 土曜そのもの
    expect(isGotobi(jst('2026-10-30T08:00:00').getTime())).toBe(true); // 31日(土)=月末の振替
    expect(isGotobi(jst('2026-03-31T08:00:00').getTime())).toBe(true); // 月末
    expect(isGotobi(jst('2026-05-29T08:00:00').getTime())).toBe(true); // 31日(日)の振替
  });
});

describe('isLastBusinessDay', () => {
  it('月の最終営業日（土日のみ考慮）', () => {
    expect(isLastBusinessDay(jst('2026-10-30T12:00:00').getTime())).toBe(true);
    expect(isLastBusinessDay(jst('2026-10-29T12:00:00').getTime())).toBe(false);
    expect(isLastBusinessDay(jst('2026-03-31T12:00:00').getTime())).toBe(true);
    expect(isLastBusinessDay(jst('2026-10-31T12:00:00').getTime())).toBe(false); // 土曜
  });
});

describe('detectAnomalies', () => {
  it('五十日は仲値前ならドル円が上、仲値後は下', () => {
    const before = detectAnomalies(jst('2026-10-20T08:30:00')).find((a) => a.id === 'gotobi')!;
    expect(before.effects).toEqual([{ pair: 'USD/JPY', bias: 'up' }]);
    const after = detectAnomalies(jst('2026-10-20T11:00:00')).find((a) => a.id === 'gotobi')!;
    expect(after.effects[0].bias).toBe('down');
  });

  it('月末・四半期末はドルを含むペアが荒れやすい（クロス円は対象外）', () => {
    const a = detectAnomalies(jst('2026-03-31T15:00:00')).find((x) => x.id === 'month-end')!;
    expect(a.title).toBe('年度末・四半期末');
    const pairs = a.effects.map((e) => e.pair);
    expect(pairs).toContain('USD/JPY');
    expect(pairs).toContain('XAU/USD');
    expect(pairs).not.toContain('EUR/JPY');
  });

  it('季節性: 3月は円高（クロス円が下）、4月は円安、10月はなし', () => {
    const mar = detectAnomalies(jst('2026-03-10T12:00:00')).find((a) => a.id === 'season-mar')!;
    expect(mar.effects.every((e) => e.pair.endsWith('/JPY') && e.bias === 'down')).toBe(true);
    expect(ids(jst('2026-04-14T12:00:00'))).toContain('season-apr');
    expect(ids(jst('2026-10-21T12:00:00')).filter((i) => i.startsWith('season'))).toEqual([]);
  });

  it('月曜朝の窓開け・金曜夜のポジション調整', () => {
    expect(ids(jst('2026-10-12T08:00:00'))).toContain('monday-gap');
    expect(ids(jst('2026-10-12T15:00:00'))).not.toContain('monday-gap');
    expect(ids(jst('2026-10-23T22:00:00'))).toContain('weekend-squaring');
  });

  it('36時間以内の雇用統計・中銀会合を拾い、関係する通貨のペアに付ける', () => {
    const cal: EconEvent[] = [
      { date: '2026-10-23T08:30:00-04:00', country: 'USD', title: 'Non-Farm Employment Change', impact: 'High', forecast: '', previous: '' },
      { date: '2026-10-23T12:00:00+09:00', country: 'JPY', title: 'BOJ Policy Rate', impact: 'High', forecast: '', previous: '' },
      { date: '2026-10-30T08:30:00-04:00', country: 'USD', title: 'CPI m/m', impact: 'High', forecast: '', previous: '' }, // 先すぎる
    ];
    const a = detectAnomalies(jst('2026-10-22T21:00:00'), cal);
    const nfp = a.find((x) => x.title === '米雇用統計')!;
    expect(nfp.when).toBe('10/23 21:30 発表');
    expect(nfp.effects.map((e) => e.pair)).toContain('EUR/USD');
    expect(a.find((x) => x.title === '日銀会合')!.effects.map((e) => e.pair)).toEqual(
      expect.arrayContaining(['USD/JPY', 'EUR/JPY']),
    );
    expect(a.some((x) => x.title === '米CPI')).toBe(false);
  });

  it('ペア別の抽出とプロンプト用ダイジェスト', () => {
    const a = detectAnomalies(jst('2026-03-31T08:00:00')); // 五十日・年度末・3月
    expect(anomaliesForPair(a, 'USD/JPY').map((x) => x.anomaly.id).sort()).toEqual(['gotobi', 'month-end', 'season-mar']);
    expect(anomaliesForPair(a, 'EUR/USD').map((x) => x.anomaly.id)).toEqual(['month-end']);
    const digest = formatAnomalyDigest(a.filter((x) => x.id === 'gotobi'));
    expect(digest).toContain('五十日');
    expect(digest).toContain('USD/JPYが上がりやすい');
  });
});
