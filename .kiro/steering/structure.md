# Project Structure

## Organization Philosophy

Mostly flat `src/` with three supporting subdirectories. Business logic lives directly in `App.tsx` (single-component pattern); supporting infrastructure is split into focused directories.

## Directory Patterns

### Application Root
**Location**: `src/`  
**Purpose**: Top-level application components and entry point  
**Example**: `App.tsx` (all calculator logic + state), `HelpModal.tsx`, `main.tsx`

### UI Primitives
**Location**: `src/components/ui/`  
**Purpose**: Reusable Radix-based shadcn-style primitives — no business logic  
**Example**: `button.tsx`, `input.tsx`, `sidebar.tsx` — each exports component + TypeScript props interface

### Layout / Navigation Components
**Location**: `src/components/`  
**Purpose**: App-level layout shells and navigation structures  
**Example**: `app-sidebar.tsx`, `nav-main.tsx`, `nav-user.tsx`

### Custom Hooks
**Location**: `src/hooks/`  
**Purpose**: Reusable React hooks extracted from components  
**Example**: `use-mobile.ts` — returns boolean for mobile breakpoint detection

### Utilities
**Location**: `src/lib/`  
**Purpose**: Pure helper functions  
**Example**: `utils.ts` — exports `cn()` (clsx + tailwind-merge combinator)

## Naming Conventions

- **Files**: `kebab-case.tsx` for components in `components/`, `PascalCase.tsx` for top-level page components (`App.tsx`, `HelpModal.tsx`)
- **Components**: PascalCase (`UpdateRatesButton`, `HelpModal`)
- **Hooks**: `use-kebab-case.ts` prefix convention
- **Functions/variables**: camelCase

## Import Organization

```typescript
// External libraries first
import { Select, Page } from '@mobiscroll/react';
import { useState, useEffect } from 'react';

// Absolute (via @/ alias) for cross-directory
import HelpModal from './HelpModal';   // same-level: relative
import { cn } from '@/lib/utils';      // cross-directory: absolute

// Types inline or co-located with usage
type CurrencyCode = 'JPY' | 'USD' | 'EUR' | ...;
```

**Path Aliases**:
- `@/`: Maps to `./src`

## Code Organization Principles

- State and derived calculations co-located in `App.tsx` (no separate state management library)
- `useEffect` for reactive calculation on input change — dependencies listed explicitly
- Formatting helpers (`formatNumberWithCommas`, `formatBalance`) defined as local functions within the component file
- Inline component definitions (`UpdateRatesButton`) acceptable for small render-only subcomponents

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
