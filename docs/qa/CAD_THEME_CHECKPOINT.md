# Original CAD theme acceptance

Verified on 2026-10-13 against the actual local task preview, `http://127.0.0.1:5184/app/factory-map?orderId=zakaz-qa-1002`, serving `/tmp/accord-web-quality-static-visible-guarded-ByOGar` (`index-Bhb3LUjp.js`). The stale preview previously served `/tmp/accord-web-quality-static-acceptance-p8klE3`; only those verified task-owned listeners were restarted.

Dark application theme now renders neutral gray original CAD surfaces and off-white original contours on a dark canvas. Light restores the exact original material references. Theme variants belong to each renderer; cached CAD geometry, original textures, transforms and contour indices are preserved. Fullscreen exposes the existing application theme switch and keeps both switch labels synchronized.

The fresh synthetic Chromium run at `cad-theme/2026-10-13T22-08-56-195Z/capture-evidence.json` passed **31 state comparisons and eight captures**. It covers three repeated dark/light cycles each in overview, isolated print and isolated lamination; a user camera gesture; fullscreen; resize; and remount. Theme switches retain the canvas, model requests, selected stage/object, visible apparatus, triangle/contour counts, reel state, exact rounded camera diagnostics, clip and orbit bounds. The test waits across actual 250 ms diagnostic windows before comparing native OrbitControls damping. Zero outside requests, uncaught browser errors or business writes occurred. Production was not tested.

Root visually inspected the current served overview and isolated dark pixels. Generated evidence is marked DEMO/Synthetic. Supplied user screenshots remain private reference inputs and are not re-uploaded or committed.

Checks:

```sh
npm run test -- src/lib/factory-cad-theme.test.ts src/lib/factory-cad-isolation.test.ts src/lib/factory-stage-navigation.test.ts src/lib/factory-map.test.ts src/components/FactoryMapViewer.test.ts
npm run typecheck
node --check public/factory-map/factory-map-cad-theme.js
node --check public/factory-map/factory-map-cad-companions.js
node --check public/factory-map/factory-map-renderer.js
QA_WEB_ORIGIN=http://127.0.0.1:5184 QA_SOURCE_REV=d1b8e90-plus-frozen-visible-fixes QA_BUILD_DIR=/tmp/accord-web-quality-static-visible-guarded-ByOGar PLAYWRIGHT_BROWSERS_PATH=/tmp/accord-web-quality-browsers PLAYWRIGHT_PACKAGE_PATH=/tmp/accord-web-quality-qa/node_modules/playwright/index.mjs node tests/browser/cad-theme.mjs
```

Focused unit check: **68/68 passed across five files**; TypeScript and JavaScript parsing passed. All thirteen GLB sources were exercised by the material/geometry guard tests; three browser model views were visually reviewed. This does not claim all thirteen apparatus were visually inspected.

Current deliverables: `deliverables/accord-demo-cad-overview-dark.png`, `deliverables/accord-demo-cad-print-dark.png`, `deliverables/accord-demo-cad-laminate-dark.png`. The overview Library identity is `libfile_87baaf0368748191953e74ac622f949d`, version 0. Broader dashboard and workflow acceptance remains separate.
