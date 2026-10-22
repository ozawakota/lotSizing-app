import { describe, it, expect } from 'vitest';
import {
  COOLDOWN_MS,
  WINDOW_MS,
  evaluate,
  formatAlertBody,
  formatAlertTitle,
  isValidPushEndpoint,
  pruneWindow,
  rangePips,
  type Sample,
} from '../alert';

const T0 = 1_700_000_000_000; // 基準時刻（epoch ms）
const min = (n: number) => n * 60 * 1000;

describe('pruneWindow', () => {
  it('窓より古いサンプルを落とす', () => {
    const now = T0 + min(20);
    const samples: Sample[] = [
      { ts: T0, bid: 190.0 }, // 20分前 → 落ちる
      { ts: T0 + min(6), bid: 190.1 }, // 14分前 → 残る
      { ts: T0 + min(20), bid: 190.2 }, // 今 → 残る
    ];
    expect(pruneWindow(samples, now)).toHaveLength(2);
  });

  it('ちょうど15分前は窓内に含む（境界）', () => {
    const now = T0 + WINDOW_MS;
    expect(pruneWindow([{ ts: T0, bid: 190 }], now)).toHaveLength(1);
  });
});

describe('rangePips', () => {
  it('JPYクロスは 0.01 を 1pip として換算', () => {
    const samples: Sample[] = [
      { ts: T0, bid: 190.0 },
      { ts: T0 + 1, bid: 190.25 },
    ];
    expect(rangePips(samples, 'GBP/JPY')).toBeCloseTo(25, 6);
  });

  it('ドルストレートは 0.0001 を 1pip として換算', () => {
    const samples: Sample[] = [
      { ts: T0, bid: 1.27 },
      { ts: T0 + 1, bid: 1.2725 },
    ];
    expect(rangePips(samples, 'GBP/USD')).toBeCloseTo(25, 6);
  });

  it('XAU/USD は 1ドル を 1単位として換算', () => {
    const samples: Sample[] = [
      { ts: T0, bid: 2650 },
      { ts: T0 + 1, bid: 2655 },
    ];
    expect(rangePips(samples, 'XAU/USD')).toBeCloseTo(5, 6);
  });

  it('サンプルが1つなら 0', () => {
    expect(rangePips([{ ts: T0, bid: 190 }], 'GBP/JPY')).toBe(0);
  });
});

describe('evaluate', () => {
  it('25pips未満なら発火せず窓に追加する', () => {
    const r = evaluate({
      pair: 'GBP/JPY',
      samples: [{ ts: T0, bid: 190.0 }],
      newSample: { ts: T0 + min(1), bid: 190.1 },
      cooldownUntil: null,
      now: T0 + min(1),
    });
    expect(r.triggered).toBe(false);
    expect(r.samples).toHaveLength(2);
    expect(r.cooldownUntil).toBeNull();
  });

  it('15分窓内で25pips以上なら発火しクールダウンを開始・窓リセット', () => {
    const now = T0 + min(10);
    const r = evaluate({
      pair: 'GBP/JPY',
      samples: [{ ts: T0, bid: 190.0 }],
      newSample: { ts: now, bid: 190.25 },
      cooldownUntil: null,
      now,
    });
    expect(r.triggered).toBe(true);
    expect(r.rangePips).toBeCloseTo(25, 6);
    expect(r.cooldownUntil).toBe(now + COOLDOWN_MS);
    expect(r.samples).toEqual([]);
  });

  it('XAU/USD は 15分で8ドル以上動いたら発火する', () => {
    const now = T0 + min(5);
    const r = evaluate({
      pair: 'XAU/USD',
      samples: [{ ts: T0, bid: 2650 }],
      newSample: { ts: now, bid: 2658 },
      cooldownUntil: null,
      now,
    });
    expect(r.triggered).toBe(true);
    expect(r.rangePips).toBeCloseTo(8, 6);
  });

  it('XAU/USD は 8ドル未満では発火しない（旧しきい値5ドルでは鳴らない）', () => {
    const now = T0 + min(5);
    const r = evaluate({
      pair: 'XAU/USD',
      samples: [{ ts: T0, bid: 2650 }],
      newSample: { ts: now, bid: 2655 },
      cooldownUntil: null,
      now,
    });
    expect(r.triggered).toBe(false);
  });

  it('古い高値が窓から外れると発火しない', () => {
    const now = T0 + min(20);
    const r = evaluate({
      pair: 'GBP/JPY',
      samples: [{ ts: T0, bid: 190.3 }], // 20分前の高値 → 窓外
      newSample: { ts: now, bid: 190.0 },
      cooldownUntil: null,
      now,
    });
    expect(r.triggered).toBe(false);
    expect(r.samples).toHaveLength(1); // 古いサンプルは落ちている
  });

  it('クールダウン中は測定休止（サンプルを捨て発火しない）', () => {
    const now = T0 + min(5);
    const r = evaluate({
      pair: 'GBP/JPY',
      samples: [],
      newSample: { ts: now, bid: 190.9 },
      cooldownUntil: T0 + COOLDOWN_MS, // まだ明けていない
      now,
    });
    expect(r.triggered).toBe(false);
    expect(r.samples).toEqual([]);
    expect(r.cooldownUntil).toBe(T0 + COOLDOWN_MS);
  });

  it('クールダウン明け後は通常測定を再開する', () => {
    const now = T0 + COOLDOWN_MS + min(1);
    const r = evaluate({
      pair: 'GBP/JPY',
      samples: [],
      newSample: { ts: now, bid: 190.0 },
      cooldownUntil: T0 + COOLDOWN_MS,
      now,
    });
    expect(r.cooldownUntil).toBeNull();
    expect(r.samples).toHaveLength(1);
  });
});

describe('formatAlertBody', () => {
  it('JPYクロスは小数3桁・pips四捨五入', () => {
    expect(formatAlertBody('GBP/JPY', 190.25, 190.1)).toBe('GBP/JPY が15分で15pips変動（190.100 → 190.250）');
  });

  it('ドルストレートは小数5桁', () => {
    expect(formatAlertBody('GBP/USD', 1.2725, 1.27)).toBe('GBP/USD が15分で25pips変動（1.27000 → 1.27250）');
  });

  it('XAU/USD はドル単位・小数2桁', () => {
    expect(formatAlertBody('XAU/USD', 2655, 2650)).toBe('XAU/USD が15分で5ドル変動（2650.00 → 2655.00）');
  });
});

describe('formatAlertTitle', () => {
  it('ペア＋急変動＋変動量（pips）', () => {
    expect(formatAlertTitle('GBP/JPY', 190.25, 190.1)).toBe('GBP/JPY 急変動 15pips');
  });
  it('XAU/USD はドル単位', () => {
    expect(formatAlertTitle('XAU/USD', 2655, 2650)).toBe('XAU/USD 急変動 5ドル');
  });
});

describe('isValidPushEndpoint', () => {
  it('既知の push サービス(https)を許可する', () => {
    const ok = [
      'https://fcm.googleapis.com/fcm/send/abc123',
      'https://android.googleapis.com/gcm/send/abc123',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QID/xyz',
      'https://ABC.notify.windows.com/w/?token=xyz', // ホスト大文字も小文字化して判定
      'https://foo.push.microsoft.com/w/?token=xyz',
    ];
    for (const e of ok) expect(isValidPushEndpoint(e)).toBe(true);
  });

  it('任意ホスト・内部アドレス・非httpsを拒否する（SSRF/リクエスト強制の防止）', () => {
    const bad = [
      'http://fcm.googleapis.com/fcm/send/abc', // https でない
      'https://attacker.example/collect', // 既知 push サービスでない
      'https://169.254.169.254/latest/meta-data/', // クラウドメタデータ
      'https://localhost/x',
      'https://fcm.googleapis.com.attacker.example/x', // サフィックス偽装
      'https://evilgoogleapis.com/x',
      'ftp://fcm.googleapis.com/x',
      'not a url',
      '',
    ];
    for (const e of bad) expect(isValidPushEndpoint(e)).toBe(false);
  });

  it('文字列以外は拒否する', () => {
    expect(isValidPushEndpoint(undefined)).toBe(false);
    expect(isValidPushEndpoint(null)).toBe(false);
    expect(isValidPushEndpoint(123)).toBe(false);
    expect(isValidPushEndpoint({})).toBe(false);
  });
});
