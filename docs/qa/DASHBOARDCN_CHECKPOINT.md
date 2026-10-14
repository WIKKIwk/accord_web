# Genuine dashboardcn distribution acceptance

Eight supported dashboardcn components are manually reviewed source ports at immutable upstream commit `b1ffacbca0f7a0be60135c8665b9e8c267205c48`. Original core API/markup is retained with documented local imports, finite/unknown guards, localization and exact duration tooltip support. The nine requested raw sources and registry payloads were reviewed; source hashes, exact adaptation diff, upstream MIT and shadcn MIT notices are retained in [PROVENANCE.md](../../src/components/dashboardcn/PROVENANCE.md). Radar is audited and deferred because the native APIs do not establish comparable normalized operational scores.

| Route / existing view | Purposeful use |
| --- | --- |
| `/app/home` | Genuine KPI cards/value primitives for six native snapshot counts |
| `/app/production-time` | Recorded-date ComposedChart + PeriodTabs first, followed by the distinct existing duration ranking and selected-order history |
| `/app/apparatus` → Umumiy ko‘rinish | Exact visible queue distribution + per-apparatus MetricList |
| `/app/materials` → Umumiy ko‘rinish | Compact material × micron variant-presence HeatmapChart |
| `/app/warehouses`, `/app/stock` → Umumiy ko‘rinish | Native KPI facts and individual MetricList values; stock quantities retain their own units |
| `/app/closed` → selected detail → Hodisalar | Genuine Timeline primitives for that saved order's actual events |

Production-time no longer contains the newly added queue DotPlot, large apparatus Heatmap, duplicate queue-pressure panel or default duplicate event feed. The date chart is operational history, not fabricated OEE, equal-product efficiency or planned/actual performance. Loaded feeds, unknowns, filters and stale data remain qualified.

Apparatus marks and category labels share four equal tracks. The unchanged upstream DotPlot receives `max=rows=16`, so one dot equals one apparatus up to an explicit 16-dot column cap; exact native counts always remain below each category and in the per-apparatus list. The browser confirms 2/0/1/2 apparatus as 2/0/1/2 dots and all four mark/label centers match exactly. Manual list refresh also refreshes the scoped native queue snapshot. Connection checks qualify previously loaded observations until the session is online.

Production daily boundaries use the same existing browser/user IANA timezone as the timeline; the zone is visible. Timestamp durations, same-apparatus interval union and fetch-as-of cutoffs remain unchanged. Pure tests cover Tashkent midnight,23/25-hour and half-hour DST days, fractional offsets, repeated/skipped clock times and skipped civil dates. Invalid zones remain unknown. Trailing7×24-hour/30×24-hour filters apply only to retained records and do not claim complete calendar totals.

Focused source gate: **118 tests across 11 files**, app and Node TypeScript checks, reviewed-source diff checks and guarded build passed. Root combined source gate passes 1112 tests across 70 files;68 tests/two files belong to the separately paused, unmounted worker-group checkpoint and are excluded from delivered UI acceptance. Temporary Oxlint1.88 reports zero errors and 123 warnings across 193 files; two reviewed upstream helpers produce Fast Refresh export warnings, without functional build/runtime failure.

The fresh isolated Chromium report [capture-evidence.json](dashboardcn/2026-10-13T23-15-05-426Z/capture-evidence.json) passes **18 proofs with 10 captures** against the frozen combined build `/tmp/accord-web-quality-static-combined-final-N5RcqT` (`index-Bfm4-FhV.js`). It verifies all relevant routes, genuine Card header/title structure, date chart ordering, the actual Asia/Tashkent browser timezone, exact/aligned dots, native refresh GET, period selection, closed event selection, real pointer and keyboard matrix tooltips,390px layout without horizontal overflow, and honest empty history. Finite transitions settle before every screenshot. Zero outside requests, business writes or uncaught browser errors occurred. Production was not tested.

Root visually inspected the accepted queue/date corrections, compact material matrix, closed-order event detail, exact stock units and mobile date chart. Six relevant Library identities were versioned with the accepted DEMO captures, preserving earlier versions. The full 117-scenario broader workflow run is separate and was still running at this UI checkpoint.

```sh
npm run test -- --reporter=dot
npm run test:fixtures
npm run typecheck
QA_SOURCE_REV=d2f0bbd-plus-frozen-genuine-dashboardcn QA_BUILD_DIR=/tmp/accord-web-quality-static-combined-final-N5RcqT PLAYWRIGHT_BROWSERS_PATH=/tmp/accord-web-quality-browsers PLAYWRIGHT_PACKAGE_PATH=/tmp/accord-web-quality-qa/node_modules/playwright/index.mjs node tests/browser/dashboardcn.mjs
```
