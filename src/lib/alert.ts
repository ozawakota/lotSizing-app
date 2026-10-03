// 相場変動通知（外貨ex 準拠）の純粋ドメインロジック。
// 仕様: 対象ペアの Bid レートについて「過去15分以内の高値 − 安値 ≥ しきい値」で発火。
// 発火後は 15 分間そのペアの測定を休止（クールダウン）する。
//
// しきい値はペアごとに持つ:
//  - FX は 25pips（JPY クロス=0.01/pip、ドルストレート=0.0001/pip）。
//  - XAU/JPY（ゴールド円）は pip 概念が合わないため「円」で判定（1pip=1円、しきい値=円）。
//
// Worker(Cron 毎分) が OANDA practice から Bid を取得し、本モジュールで判定する。
// 判定は副作用のない純関数に閉じ込め、Worker・テストから共有する。

export type AlertPair = 'GBP/JPY' | 'XAU/JPY' | 'AUD/USD' | 'GBP/USD';

interface PairConfig {
  oanda: string; // OANDA v20 の instrument 名（pricing の instruments に渡す）
  pipSize: number; // 1 pip（または1単位）あたりの価格差
  thresholdPips: number; // 発火しきい値（pipSize 単位の個数）
  unit: 'pips' | '円'; // 通知文の単位表記
  digits: number; // 通知文でのレート表示小数桁
}

// 対象ペアと判定設定。ここを編集すれば対象の増減・しきい値変更ができる。
export const PAIR_CONFIG: Record<AlertPair, PairConfig> = {
  'GBP/JPY': { oanda: 'GBP_JPY', pipSize: 0.01, thresholdPips: 25, unit: 'pips', digits: 3 },
  'XAU/JPY': { oanda: 'XAU_JPY', pipSize: 1, thresholdPips: 1000, unit: '円', digits: 0 },
  'AUD/USD': { oanda: 'AUD_USD', pipSize: 0.0001, thresholdPips: 25, unit: 'pips', digits: 5 },
  'GBP/USD': { oanda: 'GBP_USD', pipSize: 0.0001, thresholdPips: 25, unit: 'pips', digits: 5 },
};

export const ALERT_PAIRS = Object.keys(PAIR_CONFIG) as AlertPair[];

// OANDA instrument 名の逆引き/一括取得用（例: GBP/JPY → GBP_JPY）。
export const OANDA_INSTRUMENT: Record<AlertPair, string> = Object.fromEntries(
  (Object.entries(PAIR_CONFIG) as [AlertPair, PairConfig][]).map(([pair, cfg]) => [pair, cfg.oanda]),
) as Record<AlertPair, string>;

export const WINDOW_MS = 15 * 60 * 1000; // 相場変動の測定窓（15分）
export const COOLDOWN_MS = 15 * 60 * 1000; // 発火後の測定休止（15分）

// 1サンプル（epoch ミリ秒の時刻と、その時点の Bid）。
export interface Sample {
  ts: number;
  bid: number;
}

// 窓外（now から windowMs より古い）サンプルを落とす。
export function pruneWindow(samples: Sample[], now: number, windowMs = WINDOW_MS): Sample[] {
  return samples.filter((s) => now - s.ts <= windowMs);
}

// 窓内の高安差を pip（XAU/JPY は円）単位で返す。サンプルが2未満なら 0。
export function rangePips(samples: Sample[], pair: AlertPair): number {
  if (samples.length < 2) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const s of samples) {
    if (s.bid > hi) hi = s.bid;
    if (s.bid < lo) lo = s.bid;
  }
  return (hi - lo) / PAIR_CONFIG[pair].pipSize;
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

// 15分/しきい値 判定の本体（純関数）。
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

  if (rp >= PAIR_CONFIG[pair].thresholdPips) {
    return { samples: [], cooldownUntil: now + COOLDOWN_MS, triggered: true, rangePips: rp, high, low };
  }
  return { samples: windowed, cooldownUntil: null, triggered: false, rangePips: rp, high, low };
}

// プッシュ通知の本文を組み立てる。
//   FX     : "GBP/JPY が15分で25pips変動（190.000 → 190.250）"
//   ゴールド: "XAU/JPY が15分で1000円変動（390000 → 391000）"
export function formatAlertBody(pair: AlertPair, high: number, low: number): string {
  const cfg = PAIR_CONFIG[pair];
  const amount = Math.round((high - low) / cfg.pipSize);
  return `${pair} が15分で${amount}${cfg.unit}変動（${low.toFixed(cfg.digits)} → ${high.toFixed(cfg.digits)}）`;
}
