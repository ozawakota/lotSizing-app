# Research & Design Decisions

## Summary
- **Feature**: `currency-strength-meter`
- **Discovery Scope**: Extension (light discovery)
- **Key Findings**:
  - The priceAlert GAS project already holds the Twelve Data key in Script Properties, a weekday 15:00–26:00 JST session gate (`isWithinSession`), `PropertiesService` state, and a time trigger — all reusable, so strength needs no new secrets and no new infra type.
  - Twelve Data `time_series` supports batch (comma-separated symbols) at **1 credit per symbol**; `interval=1h&outputsize=2` returns the two most recent hourly closes (clock-aligned bars), which directly give window-start and window-end. 7 X/JPY symbols = 7 credits/recompute → ~77/day within the 11h window.
  - The client already has a JSONP-over-`<script>` fetch pattern (`fetchFromGAS`) and a `localStorage` persistence pattern, and an inline self-contained display component (`WorldClock`). The strength meter mirrors all three; it does not touch calculator state.

## Research Log

### Twelve Data time_series contract
- **Context**: Need window-start and window-end rates for 7 X/JPY pairs at 1h granularity, minimizing credits.
- **Sources Consulted**: Twelve Data support — [How to create a request](https://support.twelvedata.com/en/articles/5620512-how-to-create-a-request), [Batch API requests](https://support.twelvedata.com/en/articles/5203360-batch-api-requests), [Getting historical data](https://support.twelvedata.com/en/articles/5214728-getting-historical-data).
- **Findings**:
  - Batch: `symbol=USD/JPY,EUR/JPY,...` in one call; up to 120 symbols; **each symbol = 1 credit**.
  - `interval=1h`, `outputsize=2` → `values` array with the two most recent hourly bars, most-recent first (`values[0]` = latest close, `values[1]` = prior close).
  - Multi-symbol response is keyed by symbol: `{ "USD/JPY": { meta, values, status }, ... }`; single-symbol response is flat. A per-symbol `status` field indicates success/error.
- **Implications**: One batch request per recompute yields the whole snapshot; `values[1].close`→window start, `values[0].close`→window end. Credit cost is deterministic (7).

### Existing integration points
- **Context**: Where to attach server compute and client render without new boundaries.
- **Sources Consulted**: `gas/priceAlert.gs`, `src/App.tsx` (`fetchFromGAS`, `WorldClock`, persistence effect), `.kiro/steering/*`.
- **Findings**: `isWithinSession(date)` already encodes the exact coverage window; Script Properties already stores JSON state; JSONP client helper and `localStorage` lazy-init pattern already exist.
- **Implications**: Reuse `isWithinSession`; add a sibling `.gs` file in the same project; model the client after `WorldClock` + `fetchFromGAS`.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Server-computed cached snapshot (chosen) | GAS computes strength hourly, caches, serves via JSONP; client renders | Quota-safe (shared cache), key stays server-side, math testable in one place | Client cannot recompute if GAS down (mitigated by localStorage + stale badge) | Matches ADR-0002 |
| Client-computed from raw series | GAS proxies raw series; client averages | Client controls presentation math | Every open re-fetches → quota risk; math duplicated per client | Rejected in grilling |
| Client calls Twelve Data directly | No GAS change | Simplest data flow | Leaks API key in public bundle | Violates ADR-0001/0002 |

## Design Decisions

### Decision: Bars define the window, not the trigger clock
- **Context**: GAS `everyHours(1)` triggers are not exactly on :00.
- **Alternatives Considered**: 1) Precise :00 scheduling; 2) Rely on Twelve Data's clock-aligned 1h bars.
- **Selected Approach**: Use `outputsize=2` hourly bars; the bar datetimes define window start/end regardless of trigger jitter.
- **Rationale**: Removes dependence on trigger precision; the displayed window label comes from the data itself.
- **Trade-offs**: Window label reflects data provider's bar boundaries (acceptable).
- **Follow-up**: Confirm `values[1]` exists (warm-up: needs ≥2 bars) before computing.

### Decision: Snapshot persisted in Script Properties, served by doGet
- **Context**: Need a shared, cheap read path for all clients.
- **Selected Approach**: `updateStrength()` writes a JSON snapshot to Script Properties; `doGet(e)` returns it as JSONP.
- **Rationale**: Consistent with priceAlert state handling; no per-client Twelve Data cost.
- **Trade-offs**: Script Properties value size is bounded (snapshot is tiny, ~8 numbers — safe).

## Risks & Mitigations
- **Shared quota exhaustion** — Recompute only within `isWithinSession`; deterministic 7 credits/hour (~77/day) leaves headroom for the alert.
- **Partial/failed Twelve Data response** — If any symbol lacks two closes, abort the recompute and retain the prior snapshot (never overwrite good data with an error).
- **Warm-up / missing prior bar** — Skip compute when fewer than 2 bars are available.
- **Stale reads outside window** — Client marks any non-current-hour snapshot as 「古い」.

## References
- [Twelve Data — Batch API requests](https://support.twelvedata.com/en/articles/5203360-batch-api-requests)
- [Twelve Data — Getting historical data](https://support.twelvedata.com/en/articles/5214728-getting-historical-data)
- ADR-0002 `docs/adr/0002-currency-strength-hourly-on-gas-cached-snapshot.md`
- `CONTEXT.md` — Currency strength, Strength window, Strength coverage
