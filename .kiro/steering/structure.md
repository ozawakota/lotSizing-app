# Project Structure

_updated_at: 2026-10-13 — Rewritten to match the current codebase. The app grew from a single calculator component into a multi-page PWA backed by several server-side runtimes; shared pure logic now lives in `src/lib/` and is imported by both the frontend and the Workers._

## Organization Philosophy

**One repository, one frontend, several small backends.** The React SPA at the root is the product; each server-side concern (data caching, push alerts, auth-protected storage, analytics API, broker sync) is a self-contained sibling directory with its own runtime config and README.

Inside the frontend, `src/` stays **mostly flat by page**: each page is one top-level `PascalCase.tsx` file. Logic that can be expressed without React or I/O is pushed down into `src/lib/` as pure functions so it can be unit-tested and reused by the Workers.

```
UI (src/*.tsx page) ──fetch──▶ Worker (worker/, alert-worker/, fund-worker/)
        │                              │
        └──── import ──▶ src/lib/*.ts ◀── import (relative ../../src/lib)
```

## Directory Patterns

### Application Root (pages)
**Location**: `src/`
**Purpose**: Entry point, the app shell, and one file per page / modal / header widget
**Example**: `App.tsx` (shell + lot calculator + view switching), `OrderFlow.tsx`, `FundManager.tsx`, `TimeframeAnalysis.tsx`, `*InfoModal.tsx`, `AlertBell.tsx`
- `App.tsx` owns the current view (`AppView`) and renders the active page; pages are siblings, not nested routes (no router library).
- A page file holds its own state, fetching, and render-only subcomponents. Domain math does **not** live here — it goes to `src/lib/`.
- Pages that depend on a backend read its base URL from a `VITE_*_URL` env var and degrade to an explanatory message when it is unset.

### Shared Domain Logic
**Location**: `src/lib/`
**Purpose**: Pure, side-effect-free domain logic shared by the frontend **and** the Cloudflare Workers (single source of truth for each calculation)
**Example**: `strength.ts` (currency strength), `alert.ts` (price-move detection), `fund.ts` (P&L summary), `stoploss.ts`, `signal.ts`, `news.ts`, `session.ts`
- Each file opens with a header comment stating what domain it covers and which runtimes share it.
- Must run in both browser and Worker runtimes: no DOM APIs (e.g. RSS is parsed with regex, not `DOMParser`), no React.
- Thin I/O helpers are allowed when clearly scoped (`push.ts` = browser push subscription, `googleVerify.ts` = Worker-side JWKS verification, `goldSpot.ts` = single fetch with `null` fallback).
- `utils.ts` keeps the generic `cn()` (clsx + tailwind-merge) helper.

### Layout / Navigation Components
**Location**: `src/components/`
**Purpose**: App-level shell pieces reused across pages
**Example**: `AppHeader.tsx`, `BottomTabBar.tsx` (also exports the `AppView` type), `WorldClock.tsx`, `TfCountdown.tsx`; legacy shadcn sidebar files (`app-sidebar.tsx`, `nav-*.tsx`, currently unused)

### UI Primitives
**Location**: `src/components/ui/`
**Purpose**: Reusable Radix-based shadcn-style primitives — no business logic
**Example**: `button.tsx`, `input.tsx`, `sheet.tsx` — each exports component + TypeScript props interface

### Custom Hooks
**Location**: `src/hooks/`
**Purpose**: Reusable React hooks extracted from components
**Example**: `use-mobile.ts` — returns boolean for mobile breakpoint detection

### Tests
**Location**: `src/lib/__tests__/` (domain logic), `src/__tests__/` (page components)
**Purpose**: Vitest (+ Testing Library / jsdom for components)
**Pattern**: `<module>.test.ts(x)` mirrors the file under test. New domain logic in `src/lib/` is expected to ship with a matching test.

### Cloudflare Workers (TypeScript)
**Location**: `worker/`, `alert-worker/`, `fund-worker/`
**Purpose**: Server-side jobs and APIs the SPA calls; each has `src/index.ts`, `wrangler.toml`, `package.json`, `README.md` (and `schema.sql` when it owns a database)
- `worker/` — market-data cache: Cron fetches → KV, `fetch()` serves cached JSON (strength, flow, news, stop-loss, MTF)
- `alert-worker/` — price-move detection every minute → Web Push; state in D1
- `fund-worker/` — Google-authenticated trade journal API backed by Turso (libSQL)
- Pattern: `scheduled()` does the expensive fetching, `fetch()` only serves; domain logic is imported from `../../src/lib/` rather than duplicated.

### Python Services
**Location**: `backend/` (FastAPI Elliott-wave/ZigZag API, deployable as a Cloudflare Python Worker), `infra/` (MT5 → Turso sync on OCI: `mt5/` EA, `sync/` Python + systemd, `oci/` provisioning, `db/` schema)
**Pattern**: Flat modules under `src/` (or `sync/`), pytest tests in a sibling `tests/`, dependencies in `requirements.txt`.

### Google Apps Script
**Location**: `gas/`
**Purpose**: Legacy standalone server job (USD/JPY move alert via Telegram), independent of the SPA

### Static Assets & Published Build
- `public/` — PWA files copied as-is (`manifest.webmanifest`, `sw.js`, icons)
- `docs/` — **committed build output** for GitHub Pages (regenerated by `pnpm rebuild`; do not hand-edit `docs/assets/`) plus `docs/adr/` (Architecture Decision Records, numbered `NNNN-kebab-title.md`)

### Project Knowledge
- `README.md` per directory describes that runtime's purpose, endpoints, and deployment
- `CONTEXT.md` (root) is the domain glossary; lib headers and ADRs reference its terms
- `.kiro/specs/` holds feature specs; `.kiro/steering/` holds this project memory

## Naming Conventions

- **Files**: `PascalCase.tsx` for pages/modals/widgets in `src/` and shell components in `src/components/`; `kebab-case.tsx` for shadcn primitives and legacy sidebar files; `camelCase.ts` for `src/lib/` modules
- **Components**: PascalCase (`UpdateRatesButton`, `HelpModal`)
- **Hooks**: `use-kebab-case.ts` prefix convention
- **Functions/variables**: camelCase; module-level constants in `UPPER_SNAKE_CASE` (`PAIR_CONFIG`, `FLOW_PAIRS`, `WINDOW_MS`)
- **Union types for domain enums**: string-literal unions (`type AlertPair = 'GBP/JPY' | ...`) paired with an array/record constant listing all values
- **Python**: `snake_case` modules and functions

## Import Organization

```typescript
// External libraries first
import { Select, Page } from '@mobiscroll/react';
import { useState, useEffect } from 'react';

// Same-level: relative
import HelpModal from './HelpModal';
// Cross-directory: absolute via @/
import { ALERT_PAIRS, PAIR_CONFIG } from '@/lib/alert';
import { cn } from '@/lib/utils';

// Types imported with `type` when only types are needed
import type { RateSeries } from './strength';
```

**Workers** import shared logic by relative path (the `@/` alias is a Vite/tsconfig feature of the frontend only):

```typescript
import { computeSummary, type Trade } from '../../src/lib/fund';
```

**Path Aliases**:
- `@/`: Maps to `./src` (frontend only)

## Code Organization Principles

- **Pure logic down, effects up**: calculations, parsing, and prompt building live in `src/lib/` as pure functions; components and Workers only fetch, store, and render.
- **One implementation per formula**: if a Worker and the UI both need a computation, it goes in `src/lib/` and both import it. Never fork the math.
- **No state management library**: each page keeps its own state with hooks; `App.tsx` only coordinates the active view and header-level widgets.
- `useEffect` for reactive calculation on input change — dependencies listed explicitly.
- Formatting helpers (`formatNumberWithCommas`, `formatBalance`) defined as local functions within the component file.
- Inline component definitions (`UpdateRatesButton`) acceptable for small render-only subcomponents.
- **Persistence pattern**: For state that should survive reloads, use a lazy `useState` initializer that reads + validates from `localStorage` (falling back to a safe default on invalid/legacy values), paired with a `useEffect` that writes the persisted keys when they change. Storage keys are named constants (e.g. `VIEW_STORAGE_KEY`, `FLOW_ORDER_STORAGE_KEY`).
- **External-API helpers**: In the calculator, network fetchers (`fetchFromGAS`, `fetchFromExchangeRateAPI`) are local functions inside `App.tsx`, returning `Partial<Record<CurrencyCode, string>>`. The orchestrator (`fetchCurrencyRates`) selects primary/fallback and merges into state via functional updater (`prev => ({ ...prev, ...fetched })`) to avoid clobbering keys not in the response.
- **Cache-then-serve backends**: third-party data is fetched on a Worker schedule and cached (KV/D1); the client reads the cache instead of calling external APIs directly.
- **Comments in Japanese**: header and inline comments explain intent and design rationale (often linking an ADR or `CONTEXT.md` term).

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
