# Requirements Document

## Introduction

The Currency Strength Meter adds an hourly, per-currency momentum indicator to the FX Lot Size Calculator. For each of the app's 8 supported currencies (JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF) it shows the equal-weighted average of that currency's percent change against the other 7 over the last completed clock hour — a relative score where a currency is "strong" only relative to the others.

Because the strength score requires time-series data (a rate now and a rate at the window start), which the app's display-grade rate sources cannot supply, the score is computed server-side on the existing priceAlert Google Apps Script (GAS) project using Twelve Data time-series data, cached, and served to the client as a JSONP snapshot. The client is a pure renderer that displays a collapsible ranked bar list. The feature is secondary to the calculator and must never block or degrade it.

Domain terms are defined in `CONTEXT.md` (Currency strength, Strength window, Strength coverage) and the architecture is recorded in `docs/adr/0002-currency-strength-hourly-on-gas-cached-snapshot.md`.

## Boundary Context

- **In scope**: Server-side hourly computation and caching of an 8-currency strength snapshot; a JSONP endpoint serving the snapshot; a collapsible ranked bar list in the SPA; staleness and unavailable-data handling.
- **Out of scope**: Real-time/rolling (sub-hourly) strength; 24/5 coverage; adding currencies beyond the existing 8; changing the calculator's own rate-fetch behavior; paid Twelve Data tiers; alerting/push on strength changes.
- **Adjacent expectations**: Shares the Twelve Data free-tier quota (800 req/day) with the existing Price-move alert (~660 req/day); reuses the priceAlert GAS project's Twelve Data key, `PropertiesService`/`CacheService`, and time-trigger infrastructure. The strength coverage window intentionally matches the alert window (weekdays 15:00–26:00 JST).

## Requirements

### Requirement 1: Currency strength computation

**Objective:** As a forex trader, I want a per-currency strength score across the 8 supported currencies, so that I can see at a glance which currencies are strengthening or weakening relative to each other.

#### Acceptance Criteria
1. The Strength Service shall compute, for each of the 8 supported currencies (JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF), a strength score equal to the equal-weighted average of that currency's percent change against each of the other 7 currencies over the strength window.
2. The Strength Service shall derive all cross-rate changes from the 7 X/JPY time-series pairs (deriving X/Y as (X/JPY) ÷ (Y/JPY)).
3. When computing a snapshot, the Strength Service shall define the strength window as the last completed clock hour, using the two most recent hourly closes (e.g. at 10:00 the window is 09:00→10:00).
4. The Strength Service shall label each snapshot with its window boundaries (window start and window end) and the timestamp at which it was computed.
5. Where the snapshot is complete, the sum of all 8 strength scores shall be approximately zero (scores are relative to the basket).

### Requirement 2: Hourly recompute and caching

**Objective:** As the system operator, I want the strength snapshot computed once per hour on the server and cached, so that all clients read a shared snapshot without each consuming Twelve Data quota.

#### Acceptance Criteria
1. While within the strength coverage window, the Strength Service shall recompute the strength snapshot once per clock hour on a GAS time trigger.
2. When a new snapshot is computed, the Strength Service shall persist it as the current cached snapshot (replacing the previous one).
3. When a client requests the snapshot, the Strength Service shall return the cached snapshot without triggering a new Twelve Data request.
4. The Strength Service shall return the snapshot to the client as JSONP, consistent with the existing GAS rate endpoint transport.
5. The Currency Strength Meter shall request the snapshot from the GAS strength endpoint configured via the `VITE_GAS_STRENGTH_URL` environment variable.

### Requirement 3: Coverage window and staleness

**Objective:** As a forex trader, I want strength to update during high-liquidity hours and to be clearly marked when it is not fresh, so that I do not misread an old value as current.

#### Acceptance Criteria
1. The Strength Service shall recompute snapshots only on weekdays between 15:00 and 26:00 JST (the London↔New York session overlap).
2. While outside the coverage window or on weekends, the Strength Service shall not recompute and shall retain the last computed snapshot.
3. While the displayed snapshot's window is older than the current clock hour, the Currency Strength Meter shall display a stale indicator (「古い」) together with the snapshot's window label.
4. When the snapshot is fresh (its window is the last completed clock hour within the coverage window), the Currency Strength Meter shall display it without a stale indicator.

### Requirement 4: Client display

**Objective:** As a mobile-first user, I want strength presented compactly so it does not crowd the single-screen calculator, but expandable when I want the full ranking.

#### Acceptance Criteria
1. The Currency Strength Meter shall render the 8 currencies as a ranked list sorted from strongest to weakest.
2. The Currency Strength Meter shall display each currency's percent change and a diverging bar (positive vs negative visually distinguished).
3. While collapsed, the Currency Strength Meter shall show a compact header (including the window label) without the full 8-row list.
4. When the user toggles the section header, the Currency Strength Meter shall expand to show the full ranked list or collapse back to the header.
5. The Currency Strength Meter shall default to the collapsed state on load.
6. When a snapshot is retrieved, the Currency Strength Meter shall persist it to `localStorage` and shall render the persisted snapshot on subsequent loads before or without a network response.

### Requirement 5: Graceful degradation and failure handling

**Objective:** As a user, I want the calculator to remain fully usable even when strength data is unavailable, so that a secondary feature never blocks my primary task.

#### Acceptance Criteria
1. If the strength snapshot cannot be retrieved but a cached snapshot exists (in `localStorage`), then the Currency Strength Meter shall display the cached snapshot marked stale.
2. If no snapshot has ever been retrieved (first load or total failure), then the Currency Strength Meter shall display an "unavailable" (「利用不可」) placeholder in the collapsed header.
3. The Currency Strength Meter shall not block, disable, or error the lot-size calculator when strength data fails to load.
4. If a Twelve Data request fails during recompute, then the Strength Service shall retain the previous cached snapshot rather than overwriting it with an error state.

### Requirement 6: Quota and secret constraints

**Objective:** As the system operator, I want strength to fit within the shared free-tier quota and to keep credentials off the client, so that it neither starves the price-move alert nor leaks secrets.

#### Acceptance Criteria
1. The Strength Service shall keep daily Twelve Data usage for strength within the quota headroom shared with the Price-move alert (recompute limited to the coverage window keeps this at approximately 77 requests/day).
2. The Strength Service shall read the Twelve Data API key only from the priceAlert GAS project's Script Properties and shall not expose it to the client.
3. The Currency Strength Meter shall receive only the computed snapshot and the endpoint URL, and shall not hold any Twelve Data credential.
