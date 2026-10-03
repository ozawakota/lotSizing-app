// 相場変動通知（外貨ex 準拠）の純粋ドメインロジック。
// 仕様: 対象ペアの Bid レートについて「過去15分以内の高値 − 安値 ≥ 25pips」で発火。
// 発火後は 15 分間そのペアの測定を休止（クールダウン）する。
//
// Worker(Cron 毎分) が OANDA practice から Bid を取得し、本モジュールで判定する。
// 判定は副作用のない純関数に閉じ込め、Worker・テストから共有する。

// 対象4ペア（外貨ex の相場変動通知と同一）。
export type AlertPair = 'USD/JPY' | 'EUR/JPY' | 'EUR/USD' | 'AUD/JPY';
export const ALERT_PAIRS: AlertPair[] = ['USD/JPY', 'EUR/JPY', 'EUR/USD', 'AUD/JPY'];

// OANDA v20 の instrument 名（例: USD/JPY → USD_JPY）。pricing の instruments に渡す。
export const OANDA_INSTRUMENT: Record<AlertPair, string> = {
  'USD/JPY': 'USD_JPY',
  'EUR/JPY': 'EUR_JPY',
  'EUR/USD': 'EUR_USD',
  'AUD/JPY': 'AUD_JPY',
};

// 1 pip あたりの価格差。JPY クロスは 0.01、それ以外（EUR/USD）は 0.0001。
export const PIP_SIZE: Record<AlertPair, number> = {
  'USD/JPY': 0.01,
  'EUR/JPY': 0.01,
  'AUD/JPY': 0.01,
  'EUR/USD': 0.0001,
};

export const WINDOW_MS = 15 * 60 * 1000; // 相場変動の測定窓（15分）
export const COOLDOWN_MS = 15 * 60 * 1000; // 発火後の測定休止（15分）
export const THRESHOLD_PIPS = 25; // 発火しきい値（25pips）

// 1サンプル（epoch ミリ秒の時刻と、その時点の Bid）。
export interface Sample {
  ts: number;
  bid: number;
}

// 窓外（now から windowMs より古い）サンプルを落とす。
export function pruneWindow(samples: Sample[], now: number, windowMs = WINDOW_MS): Sample[] {
  return samples.filter((s) => now - s.ts <= windowMs);
}

// 窓内の高安差を pips 単位で返す。サンプルが2未満なら 0。
export function rangePips(samples: Sample[], pair: AlertPair): number {
  if (samples.length < 2) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const s of samples) {
    if (s.bid > hi) hi = s.bid;
    if (s.bid < lo) lo = s.bid;
  }
  return (hi - lo) / PIP_SIZE[pair];
}

// 1ペア1回分の判定入力（新サンプル取得前の窓とクールダウン状態）。
export interface EvalInput {
  pair: AlertPair;
  samples: Sample[]; // 既存の窓（新サンプル追加前）
  newSample: Sample; // 今回取得したサンプル
  cooldownUntil: number | null; // クールダウン明けの epoch ms（なければ null）
  now: number;
}

// 判定結果。samples / cooldownUntil は次回に永続化すべき新状態。
export interface EvalResult {
  samples: Sample[];
  cooldownUntil: number | null;
  triggered: boolean;
  rangePips: number;
  high: number;
  low: number;
}

// 15分/25pips 判定の本体（純関数）。
// - クールダウン中: サンプルを捨て、窓は空のまま（＝測定休止）。
// - 発火: クールダウンを開始し、窓をリセット。
// - それ以外: 窓に追加して保持。
export function evaluate(input: EvalInput): EvalResult {
  const { pair, samples, newSample, now } = input;
  const inCooldown = input.cooldownUntil != null && now < input.cooldownUntil;
  if (inCooldown) {
    return {
      samples: [],
      cooldownUntil: input.cooldownUntil,
      triggered: false,
      rangePips: 0,
      high: newSample.bid,
      low: newSample.bid,
    };
  }

  const windowed = pruneWindow([...samples, newSample], now);
  const rp = rangePips(windowed, pair);
  const high = Math.max(...windowed.map((s) => s.bid));
  const low = Math.min(...windowed.map((s) => s.bid));

  if (rp >= THRESHOLD_PIPS) {
    return { samples: [], cooldownUntil: now + COOLDOWN_MS, triggered: true, rangePips: rp, high, low };
  }
  return { samples: windowed, cooldownUntil: null, triggered: false, rangePips: rp, high, low };
}

// プッシュ通知の本文を組み立てる（例: "USD/JPY が15分で25pips変動（150.100 → 150.350）"）。
export function formatAlertBody(pair: AlertPair, high: number, low: number): string {
  const digits = PIP_SIZE[pair] === 0.01 ? 3 : 5;
  const pips = Math.round((high - low) / PIP_SIZE[pair]);
  return `${pair} が15分で${pips}pips変動（${low.toFixed(digits)} → ${high.toFixed(digits)}）`;
}
