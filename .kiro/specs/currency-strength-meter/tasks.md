# Implementation Plan

- [x] 1. Foundation: strength types and pure client logic
- [x] 1.1 Define strength types and pure helpers with unit tests
  - Define the snapshot/score/response types for the 8 supported currencies and the JSONP payload shape.
  - Implement a pure strength-from-closes reference function: per-currency equal-weighted average of pairwise % change over the window, with JPY as base (its own return is zero), such that the 8 scores sum to approximately zero.
  - Implement pure helpers for sorting scores strongest-to-weakest, deciding staleness (snapshot window vs. the last completed clock hour in JST), and formatting the window label (e.g. `09:00–10:00`).
  - Observable completion: `pnpm test` passes with a fixture asserting scores sum ≈ 0 and the expected ranking, plus sort/staleness/label cases.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.3, 4.1_
  - _Boundary: strength.ts_

- [x] 2. Server: hourly strength computation and JSONP endpoint (GAS)
- [x] 2.1 (P) Fetch Twelve Data series and compute the snapshot
  - Batch-request `time_series` for the 7 X/JPY pairs at 1h interval, output size 2, reading the API key from the existing Script Properties (never returned to callers).
  - Parse each symbol's two most recent closes; guard against warm-up/partial data (require two closes and an OK status per symbol) and abort computation if incomplete.
  - Derive window start/end labels from the bar datetimes converted to JST and compute the 8 equal-weighted strength scores.
  - Observable completion: running the compute function within the window logs a snapshot object with 8 scores summing ≈ 0 and correct window labels.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 6.2_
  - _Boundary: currencyStrength.gs_

- [x] 2.2 Session-gated hourly recompute with cached snapshot and retain-on-error
  - Register an hourly trigger via a one-time setup function and gate recompute on the shared weekday 15:00–26:00 JST session check.
  - Persist the latest successful snapshot to Script Properties; on fetch/parse/partial failure or outside the window, leave the previously stored snapshot unchanged.
  - Observable completion: within the window Script Properties holds the freshly computed snapshot; outside the window or on a forced fetch error the stored value is unchanged.
  - _Requirements: 2.1, 2.2, 3.1, 3.2, 5.4, 6.1_
  - _Boundary: currencyStrength.gs_
  - _Depends: 2.1_

- [x] 2.3 Serve the cached snapshot as JSONP
  - Implement the web-app GET handler that wraps the stored snapshot in the requested callback, returning an error-shaped payload when no snapshot exists yet.
  - Observable completion: requesting the deployed web-app URL with a `callback` parameter returns `callback({...snapshot})`, or `callback({result:"error"})` before the first successful compute.
  - _Requirements: 2.3, 2.4, 6.2_
  - _Boundary: currencyStrength.gs_
  - _Depends: 2.2_

- [x] 3. Client: currency strength meter component
- [x] 3.1 Fetch snapshot via JSONP and cache locally
  - Read the strength endpoint URL from the environment variable and add it to the example env file; when unset, the component stays inert.
  - Implement a JSONP fetch (unique callback, timeout, cleanup) modeled on the existing rate fetch, painting from the local cache on mount and reconciling with the endpoint response.
  - Persist each retrieved snapshot to local storage and re-render from it on subsequent loads before/without a network response.
  - Observable completion: on mount a previously cached snapshot renders immediately; a successful fetch updates the view and overwrites the local cache.
  - _Requirements: 2.5, 4.6, 6.3_
  - _Boundary: CurrencyStrengthMeter.tsx_
  - _Depends: 1.1_

- [x] 3.2 Render collapsible ranked bar list with stale and unavailable states
  - Render a header (with window label) collapsed by default; toggling expands the 8 currencies sorted strongest-to-weakest with diverging bars and signed % labels.
  - Show a stale indicator when the snapshot is not the current completed hour, and an "unavailable" placeholder when no snapshot exists (missing URL, error payload, or empty cache).
  - Observable completion: expanded view shows 8 sorted rows with diverging bars; an old snapshot shows the 「古い」 badge; no data shows the 「利用不可」 header.
  - _Requirements: 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2_
  - _Boundary: CurrencyStrengthMeter.tsx_
  - _Depends: 3.1_

- [x] 4. Integration: mount the meter without affecting the calculator
- [x] 4.1 Render the meter under the world clock
  - Place the strength meter beneath the existing session clock in the app root, sharing no calculator state.
  - Verify the lot-size calculator stays fully interactive when strength data is unavailable or failing.
  - Observable completion: the app shows the collapsed strength header under the world clock, and disabling the endpoint leaves the calculator fully usable.
  - _Requirements: 5.3_
  - _Boundary: App.tsx_
  - _Depends: 3.2_

- [x] 5. Validation: failure and reconciliation coverage
- [x] 5.1 Integration tests for fetch reconciliation and graceful degradation
  - Cover JSONP success resolution and cleanup on timeout and script-load error.
  - Cover local-cache-first paint then reconcile, error/no-URL falling back to the stale-or-unavailable states, and the calculator remaining interactive throughout.
  - Observable completion: the test suite passes cases for success, stale fallback, unavailable placeholder, and a non-blocked calculator.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Depends: 4.1_
