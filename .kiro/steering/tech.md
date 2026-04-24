# Technology Stack

## Architecture

Single-page application with no backend. All computation runs client-side. Exchange rates are fetched from a public API at runtime. Deployed as a static site to GitHub Pages.

## Core Technologies

- **Language**: TypeScript ~5.7 (strict mode via `tsc -b`)
- **Framework**: React 19
- **Build tool**: Vite 6 with `@vitejs/plugin-react`
- **Styling**: Tailwind CSS v4 (via `@tailwindcss/vite` plugin — no `tailwind.config.js`)
- **UI library**: Mobiscroll React (iOS theme, `localeJa`) — primary interactive controls
- **Component primitives**: Radix UI (Avatar, Dialog, DropdownMenu, Tooltip, etc.) + shadcn-style wrappers in `src/components/ui/`

## Key Libraries

- `lucide-react` — icons
- `clsx` + `tailwind-merge` + `class-variance-authority` — conditional class composition via `cn()` helper
- `react-mobile-picker` — mobile scroll picker
- `gh-pages` — deployment to GitHub Pages

## Development Standards

### Type Safety
- TypeScript strict mode; avoid `any` — use specific types or generics
- Prefer named types/interfaces over inline type annotations for state shapes

### Code Quality
- ESLint 9 with `eslint-plugin-react-hooks` and `eslint-plugin-react-refresh`
- No Prettier configured — follow existing spacing conventions

### Testing
- No test suite currently configured

## Development Environment

### Required Tools
- Node.js (pnpm lockfile present — use pnpm)
- Mobiscroll license token (trial package referenced in package.json)

### Common Commands
```bash
# Dev:     pnpm dev        (--host flag exposes on LAN)
# Build:   pnpm build      (tsc -b && vite build)
# Deploy:  pnpm rebuild    (build → copy dist → docs for GH Pages)
# Lint:    pnpm lint
```

## Key Technical Decisions

- **Mobiscroll for all selects**: Provides iOS-native scroll picker UX; all Select/Input/Popup components come from `@mobiscroll/react`
- **Tailwind v4 via Vite plugin**: No config file required; utility-first with `tw-animate-css` for animations
- **`@/` path alias**: Maps to `./src`; prefer absolute imports for cross-directory imports
- **GitHub Pages deployment**: `vite.config.ts` sets `base` to `/lotSizing-app/` when `GITHUB_PAGES` env var is set

---
_Document standards and patterns, not every dependency_
