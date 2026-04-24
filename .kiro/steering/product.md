# Product Overview

FX Lot Size Calculator — a mobile-first web app that helps forex traders determine the optimal position size (lots) based on their account parameters and risk tolerance.

## Core Capabilities

- **Lot size calculation**: Derives recommended lots from account balance, risk %, stop-loss pips, leverage, and currency pair
- **Live exchange rates**: Fetches JPY-based rates from open.er-api.com on load; user can refresh manually
- **Multi-currency support**: Account balance in JPY or USD; 8 base currencies (JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF)
- **Margin ratio display**: Shows margin maintenance ratio color-coded by safety threshold
- **Settings summary modal**: Confirms all inputs and calculated results before trading

## Target Use Cases

- Retail forex traders using high-leverage brokers (up to 1000x)
- Traders who manage risk as a fixed percentage of account equity
- Japanese-speaking users (UI language: Japanese; locale: Mobiscroll `localeJa`)

## Value Proposition

Single-screen, no-login calculator optimized for mobile use. Real-time rate fetching eliminates manual rate lookup. Covers both JPY and USD-denominated accounts common with offshore FX brokers.

---
_Focus on patterns and purpose, not exhaustive feature lists_
