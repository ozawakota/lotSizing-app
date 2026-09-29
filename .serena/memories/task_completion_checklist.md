# Task Completion Checklist

When completing a development task in this project:

1. **Type check**: `npm run build` (runs `tsc -b && vite build`)
2. **Lint**: `npm run lint`
3. **Manual test**: `npm run dev` and verify in browser (mobile-first UI)
4. **Deploy** (if releasing): `npm run rebuild` then `npm run deploy`

## Notes
- No automated tests exist — manual browser testing is required
- The app is primarily mobile-targeted (Mobiscroll touchUi=true)
- Japanese locale is set globally via `setOptions({ locale: localeJa })`
- Alpha Vantage API rate fetching is commented out by default (free tier: 5 req/min)
