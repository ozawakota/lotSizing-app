// Pure domain logic for the Currency Strength Meter.
// See CONTEXT.md (Currency strength, Strength window, Strength refresh) and
// docs/adr/0005-currency-strength-oanda-cumulative-log.md.
// OANDA-style: each currency's strength is the SUM of its LOG changes against
// the other 7 (via JPY cross), accumulated from a chosen start point (0-based).
// A Cloudflare Worker (Cron + KV) caches the rate time-series from Twelve Data;
// both the Worker and the client import this module so the formula has a single
// source of truth. (computeStrengthScores is the older single-window form, kept
// for reference/tests.)

export type CurrencyCode = 'JPY' | 'USD' | 'EUR' | 'GBP' | 'AUD' | 'NZD' | 'CAD' | 'CHF';

// The 8 currencies the app supports. JPY is the base of every fetched pair.
export const CURRENCIES: CurrencyCode[] = ['JPY', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];

// Non-JPY currencies, i.e. those quoted as X/JPY in the time-series feed.
export type JpyPairCurrency = Exclude<CurrencyCode, 'JPY'>;
const JPY_PAIRS: JpyPairCurrency[] = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];

// Closing rate of each X/JPY pair at a single instant.
export type JpyPairCloses = Partial<Record<JpyPairCurrency, number>>;

export interface StrengthScore {
  currency: CurrencyCode;
  changePct: number; // signed percent over the strength window
}

export interface StrengthSnapshot {
  windowStart: string; // window start, JST "HH:mm" (e.g. "09:00")
  windowEnd: string; // window end, JST "HH:mm" (e.g. "10:00")
  computedAt: number; // epoch ms (UTC) the snapshot was computed by the Worker
  scores: StrengthScore[];
}

/**
 * Compute the 8-currency strength scores from X/JPY closes at the window's
 * start and end. Each currency's score is the equal-weighted average of its
 * pairwise percent change against the other 7. JPY is the base, so its own
 * return is zero. Scores sum to approximately zero.
 *
 * @throws if any of the 7 X/JPY closes is missing at either boundary.
 */
export function computeStrengthScores(start: JpyPairCloses, end: JpyPairCloses): StrengthScore[] {
  // Per-currency return vs JPY over the window; JPY itself is the base (0).
  const returns: Record<CurrencyCode, number> = { JPY: 0 } as Record<CurrencyCode, number>;

  for (const pair of JPY_PAIRS) {
    const s = start[pair];
    const e = end[pair];
    if (typeof s !== 'number' || typeof e !== 'number' || s <= 0) {
      throw new Error(`Missing or invalid close for ${pair}/JPY`);
    }
    returns[pair] = e / s - 1;
  }

  return CURRENCIES.map((currency) => {
    const rc = returns[currency];
    let sum = 0;
    for (const other of CURRENCIES) {
      if (other === currency) continue;
      // Exact cross-pair change: (1+rc)/(1+rd) - 1.
      sum += ((1 + rc) / (1 + returns[other]) - 1) * 100;
    }
    return { currency, changePct: sum / (CURRENCIES.length - 1) };
  });
}

/** Return a new array sorted strongest-to-weakest (does not mutate the input). */
export function sortScores(scores: StrengthScore[]): StrengthScore[] {
  return [...scores].sort((a, b) => b.changePct - a.changePct);
}

/** Human-readable window label, e.g. "09:00 → 10:00". */
export function formatWindowLabel(snapshot: StrengthSnapshot): string {
  return `${snapshot.windowStart} → ${snapshot.windowEnd}`;
}

// ---------------------------------------------------------------------------
// OANDA-style cumulative log strength
// ---------------------------------------------------------------------------

// Start point for the cumulative plot (baseline = 0 at this point).
export type StrengthRange = '4h' | 'today' | 'year';

// A time-series of X/JPY closes shared across the 7 pairs, aligned by datetime.
export interface RateSeries {
  interval: string; // e.g. "15min" | "1day"
  datetimes: string[]; // ascending, "YYYY-MM-DD HH:mm:ss" in JST
  rates: Record<JpyPairCurrency, number[]>; // each aligned to datetimes
}

// Cumulative strength per currency over time, 0 at the start index.
export interface CumulativeStrength {
  datetimes: string[]; // sliced from the start index (ascending)
  series: Record<CurrencyCode, number[]>; // cumulative strength (%) per point
  latest: StrengthScore[]; // value at the last point, per currency
}

// Parse a JST "YYYY-MM-DD HH:mm:ss" string to epoch ms.
const parseJst = (s: string): number => new Date(`${s.replace(' ', 'T')}+09:00`).getTime();

// JST calendar helpers (JST is a fixed UTC+9, no DST).
const JST_OFFSET = 9 * 60 * 60 * 1000;
const jstYear = (d: Date): number => new Date(d.getTime() + JST_OFFSET).getUTCFullYear();
const jstDateStr = (d: Date): string => new Date(d.getTime() + JST_OFFSET).toISOString().slice(0, 10);

/**
 * Find the index in `datetimes` to use as the 0-baseline for the given range:
 * - '4h'    → the first bar at or after (now − 4h)
 * - 'today' → the first bar on today's JST date
 * - 'year'  → the first bar in the current JST year
 * Falls back to 0 when no later bar exists.
 */
export function findStartIndex(datetimes: string[], range: StrengthRange, now: Date): number {
  if (datetimes.length === 0) return 0;
  if (range === 'year') {
    const y = jstYear(now);
    const i = datetimes.findIndex((dt) => Number(dt.slice(0, 4)) >= y);
    return i < 0 ? 0 : i;
  }
  if (range === 'today') {
    const today = jstDateStr(now);
    const i = datetimes.findIndex((dt) => dt.slice(0, 10) >= today);
    return i < 0 ? 0 : i;
  }
  // '4h'
  const target = now.getTime() - 4 * 60 * 60 * 1000;
  const i = datetimes.findIndex((dt) => parseJst(dt) >= target);
  return i < 0 ? 0 : i;
}

/**
 * OANDA-style cumulative strength. For each point i (from `startIndex`), each
 * currency C's strength is the SUM over the other currencies D of the log change
 * of C/D since the start: Σ (lnC_i − lnC_start) − (lnD_i − lnD_start), ×100.
 * JPY is the base (its log change is 0). Values start at 0 and sum to ~0 at
 * every point. Positive = bought/strengthening, negative = sold/weakening.
 */
export function computeCumulativeStrength(data: RateSeries, startIndex: number): CumulativeStrength {
  const n = data.datetimes.length;
  const start = Math.max(0, Math.min(startIndex, n - 1));
  const datetimes = data.datetimes.slice(start);
  const len = datetimes.length;

  // Cumulative log-return since `start` for each currency (JPY stays 0).
  const cum: Record<CurrencyCode, number[]> = { JPY: new Array(len).fill(0) } as Record<CurrencyCode, number[]>;
  for (const pair of JPY_PAIRS) {
    const arr = data.rates[pair];
    const base = Math.log(arr[start]);
    const out = new Array<number>(len);
    for (let i = 0; i < len; i++) out[i] = Math.log(arr[start + i]) - base;
    cum[pair] = out;
  }

  const series: Record<CurrencyCode, number[]> = {} as Record<CurrencyCode, number[]>;
  for (const c of CURRENCIES) series[c] = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    let sumAll = 0;
    for (const c of CURRENCIES) sumAll += cum[c][i];
    for (const c of CURRENCIES) series[c][i] = (CURRENCIES.length * cum[c][i] - sumAll) * 100;
  }

  const latest: StrengthScore[] = CURRENCIES.map((c) => ({
    currency: c,
    changePct: len > 0 ? series[c][len - 1] : 0,
  }));
  return { datetimes, series, latest };
}
