# Direct apparatus isolation acceptance

The original bug was reproduced on the previous preview: selecting QA Flexo1 isolated `node:1:instance:0`; selecting QA Laminator next selected B but switched the renderer to overview with no isolated object or isolated contour segments. The retained before report and screenshots are in `cad-selection/before/`. This matches the supplied private user references.

Direct apparatus browsing now owns its isolation independently of order-route membership. Explicit stage selection still follows a refreshed route and clears/rebinds a removed or unbound stage safely. Explicit Overview exits isolation. The stage strip describes an outside-route or no-order apparatus by its actual name and does not mark Overview as current while the apparatus is isolated. Execution status and future-stage motion guards retain their existing native rules.

The fix changes only `FactoryMapPage.tsx`, `factory-map-selection.ts` and `factory-stage-strip.tsx`. Original GLB files, geometry, contours, transforms, renderer, materials, theme bridge and motion logic are unchanged.

Focused checks: **81/81 tests across seven suites**, TypeScript and build passed. The real fresh Chromium run at [capture-evidence.json](cad-selection/2026-10-13T23-03-45-624Z/capture-evidence.json) passes **31/31 state checks with nine captures** against `http://127.0.0.1:5184`, synthetic fixture5199 and `/tmp/accord-web-quality-static-cad-selection-final-E8bbLu` (`index-7bh5X4et.js`). It covers A→B→C→A→B in both themes; bound-idle and unbound apparatus without active orders; data refresh; explicit Overview and keyboard switching; theme/camera/contour preservation; removed/unbound explicit stages and future-stage motion suppression. One original canvas and model remain mounted. Zero outside requests, business writes or uncaught browser errors occurred. Production was not tested.

Root independently inspected [second selection in light](cad-selection/2026-10-13T23-03-45-624Z/selected-B-light.png) and [second selection in dark](cad-selection/2026-10-13T23-03-45-624Z/selected-B-dark-theme-toggle.png). Both show only the original laminator CAD with contours, coherent selection/caption and native paused order1003. The synthetic screen is labelled DEMO; supplied user screenshots are private, excluded from commits and not re-uploaded.

```sh
npm run test -- src/lib/factory-map-selection.test.ts src/lib/factory-stage-navigation.test.ts src/lib/factory-cad-isolation.test.ts src/lib/factory-cad-theme.test.ts src/components/FactoryMapViewer.test.ts src/lib/factory-map.test.ts src/components/factory-stage-strip.test.tsx
npm run typecheck
QA_SOURCE_REV=ab2f7d0-plus-frozen-cad-selection QA_BUILD_DIR=/tmp/accord-web-quality-static-cad-selection-final-E8bbLu PLAYWRIGHT_BROWSERS_PATH=/tmp/accord-web-quality-browsers PLAYWRIGHT_PACKAGE_PATH=/tmp/accord-web-quality-qa/node_modules/playwright/index.mjs node tests/browser/cad-selection.mjs
```
