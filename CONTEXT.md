# FX Lot Size Calculator

A mobile-first web app that helps forex traders size positions from account balance, risk tolerance, and live exchange rates. This glossary defines the domain language shared across the calculator and any auxiliary services (e.g. price-move alerting).

## Language

### Pricing & market data

**Pip**:
The standard unit of price change for a currency pair. For **USD/JPY**, 1 pip = 0.01 yen (so 25 pips = 0.25 yen). The sub-pip 0.001 unit is a _pipette_ and is **not** used as the pip in this project.
_Avoid_: point, tick (when you mean pip)

**Spot price**:
The current single quoted rate for a pair (e.g. USD/JPY = 150.27). Distinct from OHLC candle data — a spot price is one number at one instant, with no open/high/low/close.
_Avoid_: rate, quote (when precision matters)

**Rate source**:
An external provider of exchange rates. Providers differ in **freshness** (how stale the number is) and **granularity** (how often it updates). GOOGLEFINANCE-via-GAS and ExchangeRate-API are treated as _display-grade_ (delayed / daily) — adequate for the calculator, **not** for detecting minute-scale moves.

**Market session** (取引セッション):
One of the three major FX trading windows the app tracks — **Tokyo**, **London**, **New York**. Each has an **open** and **close** boundary expressed in that session's *local* time (so DST is handled automatically): Tokyo 09:00–18:00 JST, London 08:00–17:00 local, New York 08:00–17:00 local (BabyPips convention). A session is either **open** or **closed** at a given instant.
_Avoid_: market, timezone, city clock (a session is a market-activity window, not merely a place's wall-clock time)

**Session overlap**:
An interval when two sessions are simultaneously open (notably London↔New York). Overlaps are when liquidity and volatility are highest, so they matter to a trader deciding position size.
_Avoid_: rush hour, peak (too informal)

### Price-move alerting

**Price-move alert**:
A push notification sent to the user when USD/JPY moves sharply. It is a server-side concern: the monitoring runs independently of any open browser tab.
_Avoid_: notification, signal (too generic)

**Rolling 5-minute move**:
The trigger metric — the absolute difference between the current spot price and the spot price from 5 minutes ago: `|price(now) − price(now − 5min)|`. Measured on a **rolling** window sampled by polling, **not** aligned to fixed 5-minute candle boundaries and **not** derived from candle high−low or open−close.
_Avoid_: candle range, volatility, 5-minute candle (these imply OHLC, which this metric is not)

**Alert threshold**:
The move size that fires an alert. Currently **25 pips** (0.25 yen for USD/JPY).

### Currency strength

**Currency strength** (通貨強弱):
A per-currency momentum score: for each of the app's **8 currencies**, the equal-weighted average of its **% change against each of the other 7** over a lookback **window**. Scores are relative and sum to ~0 across the basket — a currency is "strong" only relative to the others, never in absolute terms. Distinct from a **Spot price** (one rate at one instant) and from a **Rolling 5-minute move** (a single-pair spike metric).
_Avoid_: momentum, trend, index (too generic); "strong currency" as an absolute claim.

**Strength window**:
The lookback the % change is measured over: the **last completed clock hour** (intraday — the two most recent hourly closes from the time-series source, e.g. 09:00→10:00). This is **hourly/intraday**, sourced from a keyed intraday provider (Twelve Data) via a server, because a keyless source can only give daily data.
_Avoid_: interval, period (say "window"); "daily" (the window is intraday again — see ADR-0004).

**Strength refresh**:
A **Cloudflare Worker Cron** recomputes the snapshot **once per hour**: it fetches the 7 X/JPY hourly series from **Twelve Data** (key held server-side in a Worker secret), computes the scores, and caches them in **Workers KV**. The client reads the cached snapshot from the Worker endpoint and **auto-refreshes every hour while open** (plus a manual button). No GAS; the SPA stays on GitHub Pages.
_Avoid_: "on demand only", "keyless", "Frankfurter" (superseded — see ADR-0004); "GAS" (deliberately not used).

## Flagged ambiguities

- **"毎時" (hourly) — restored, on a non-GAS server.** The request "毎時、通貨強弱を表示" is intraday/hourly. Design history: ADR-0002 (GAS cron, rejected — "no GAS") → ADR-0003 (keyless daily, on-demand button — rejected — "want hourly-moving values") → **ADR-0004 (current): Cloudflare Worker Cron + KV cache + Twelve Data, client auto-refreshes hourly.** "毎時" now means both the recompute cadence and the intraday window granularity.

- **"5-minute candle" (5分足)** — In common trading language this implies OHLC candle data (open/high/low/close on fixed boundaries). In *this* project the trigger is a **Rolling 5-minute move** on spot price, which is deliberately *not* candle-based. When someone says "5分足で25pips変化", they mean the rolling spot difference, not a candle's range.

## Example dialogue

> **Trader:** ドル円が5分足で25pips動いたら通知して。
> **Dev:** 「5分足」でも、確定ローソクの高値−安値ではなく、**今の値 − 5分前の値**の絶対値で判定します。25 pips = 0.25円ですね。
> **Trader:** それでいい。データはどこから？
> **Dev:** GOOGLEFINANCE経由は15〜20分遅延なので使えません。分単位で更新される**スポット価格のRate source**が別途必要です。
