# Project Overview: lotSizing-app

## Purpose
FX (Forex) Lot Size Calculator - A Japanese-language web app for calculating optimal lot sizes in FX trading based on account balance, risk percentage, stop-loss pips, currency pair, and leverage.

## Tech Stack
- **Framework**: React 19 + TypeScript 5.7
- **Build Tool**: Vite 6
- **Styling**: Tailwind CSS v4
- **UI Components**: Mobiscroll React (Select, Input, Popup, Page), Radix UI primitives, shadcn/ui components
- **Icons**: lucide-react
- **Deployment**: GitHub Pages (via gh-pages)
- **Package Manager**: npm (also has pnpm-lock.yaml)

## Key Features
- Lot size calculation based on risk % and stop-loss pips
- Support for JPY and USD account currencies
- Support for 8 base currencies: JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF
- Real-time currency rate fetching via Alpha Vantage API
- Leverage selection (1x to 1000x)
- Margin ratio calculation
- Japanese locale UI (Mobiscroll with localeJa)

## Target Users
Japanese FX traders needing quick lot size calculations on mobile/desktop.
