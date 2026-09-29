// Pure domain logic for the Currency Strength Meter.
// See CONTEXT.md (Currency strength, Strength window, Strength refresh) and
// docs/adr/0004-currency-strength-intraday-on-cloudflare-workers.md.
// Intraday strength is computed hourly by a Cloudflare Worker (Cron + KV) from
// Twelve Data and served to the client. This module owns the pure computation,
// sort, and window-label helpers, and is imported by BOTH the client and the
// Worker so the formula has a single source of truth.

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
