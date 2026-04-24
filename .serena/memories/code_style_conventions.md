# Code Style and Conventions

## Language
- TypeScript with strict typing
- React functional components with FC type annotation
- Japanese comments and UI text throughout (app is in Japanese)
- English for type names and variable names

## Naming Conventions
- Components: PascalCase (e.g., `HelpModal`, `UpdateRatesButton`)
- Functions/handlers: camelCase with `handle` prefix for event handlers (e.g., `handleRiskChange`)
- State variables: camelCase (e.g., `calculatedLot`, `balanceCurrency`)
- Type aliases: PascalCase (e.g., `CurrencyCode`, `BalanceCurrency`)

## File Structure
```
src/
  App.tsx              # Main app component (all core logic)
  HelpModal.tsx        # Help modal component
  main.tsx             # Entry point
  index.css            # Global styles
  App.css              # App-specific styles
  components/
    ui/                # shadcn/ui components (button, input, etc.)
    app-sidebar.tsx    # Sidebar (unused/scaffold)
    nav-*.tsx          # Navigation components
  hooks/               # Custom React hooks
  lib/                 # Utility functions
```

## Linting
- ESLint with typescript-eslint recommended
- react-hooks plugin (recommended rules)
- react-refresh plugin

## No test framework configured.
