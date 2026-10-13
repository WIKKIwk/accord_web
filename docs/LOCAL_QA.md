# Local browser acceptance fixture

This fixture uses synthetic QA records and in-memory state. It never reads user data, connects to another server, or writes to a database. Passing these checks demonstrates local UI behavior; it is not production verification. Backend and mobile repositories remain read-only.

Run from the web worktree:

```sh
node --test tests/fixtures/erp-fixture.test.mjs tests/fixtures/erp-workflows.test.mjs
node tests/fixtures/erp-fixture.mjs --port=5199
```

Start Vite separately on the approved browser port:

```sh
VITE_QA_API_ORIGIN=http://127.0.0.1:5199 npm run dev -- --port 5186
```

Open the separate clean origin `http://127.0.0.1:5186`. Port 5184 is already in human use and must not be used for QA. Set the ERP server to `http://127.0.0.1:5199`, phone to `+998900000001`, and code to `QA-CODE`. These are fixed synthetic credentials. The task preview’s `VITE_QA_API_ORIGIN` guard restricts business writes to this fixture origin; normal builds remain unaffected. The server binds only `127.0.0.1`. Browser CORS accepts only localhost/127.0.0.1 web ports 5186, 5184, 5174 and 4174, with GET/POST/PUT/PATCH/DELETE/OPTIONS and Authorization, Content-Type, Idempotency-Key, X-File-Name headers. Acceptance runs use only 5186 and fixture5199. There are no new dependencies.

If the execution sandbox denies listener startup, ask the root agent to start this exact listener with the approved local environment. Do not add production access or change the bind host.

## Useful records

| Record | Purpose |
| --- | --- |
| `zakaz-qa-1001` | Pending native map; calculation source available; all stages editable |
| `zakaz-qa-1002` | Print running; started node/incoming edges locked; future stages editable |
| `zakaz-qa-1003` | Print complete, lamination paused; stage history |
| `apparatus:qa:print-2` | Active unbound apparatus for factory-map placement |
| `QA-PET-12`, `QA-PE-50` | Raw materials for catalog edit/group-move checks |
| `QA-SUPPLIER-1`, `QA-CUSTOMER-1` | Supplier/customer detail and item assignment |
| `qa-worker-1` | Brigader with a warehouse dependency; removal requires confirmation |
| `qa-worker-2` | Worker without dependencies |
| `qa-qolipchi-1`, `QA-MATERIAL-1` | System and material-provider identity maintenance |
| `QA Bo‘sh ombor` | Empty-only warehouse removal |
| `qa-route-template` | Reusable flexo source map; template update/delete |
| `zakaz-2001` | Pending order with reserved number 2001; release keeps identity |
| `qa-wip-1` | Native waiting WIP; current route lookup supersedes stored next apparatus |
| `zakaz-4001` | Synthetic closed order with actual start/pause/resume/complete transition fields |

All native maps include start/end nodes, coordinates, program operations and authoritative metadata. `production-maps` PUT accepts the existing native map and guards started stages/calculation fields. It deliberately has no invented atomic revision header for graph editing. Factory placement PATCH uses `expected_revision`, `patch.placement` and Idempotency-Key. The separate order-edit route accepts its `{original, template}` contract.

The fixture supports read/write contracts used by the implemented catalog and identity controls: item create/rename/delete/group move, group create/reparent, supplier/customer create/phone/items/remove, supplier block/restore/inactive list, empty-only warehouses, worker fields/deletion check, system-user fields, material-provider phone/groups, code rotation, custom roles, role assignments and warehouse/apparatus assignments. It also supports native material upsert/active-ordering, raw stock lookup/candidate/diagnostic/assignment/unlink, order freeze/unfreeze, pause/resume WIP receipts, and versioned idempotent queue moves. Inventory/dashboard reads have small deterministic datasets. Pending queue controls include native blocking reasons and prior-stage identity, so waiting stages remain safe while permitted reordering is testable. Unsupported paths return `fixture_route_not_implemented` HTTP404, making missing fixture coverage visible. Health reports `fixtureVersion: 4`; restart a running listener after updating fixture source.

Workflow fixtures include optimistic calculation edits, reusable templates, pending completion through `with-order`, multiroll opening WIP, used-roll cancellation refusal, and read-only native WIP route lookups. Planning reads share the actual apparatus revision/hash. Capacity and queue policy writes return canonical revision receipts; duplicate keys do not replay canonical commits. Downtime and schedule/cancel use stateful native responses and preserve retained schedule keys. The fixture does not invent downtime or reservation history GET APIs. Calculator responses are deterministic synthetic formula data for UI acceptance, not validation of production calculation accuracy.

Manufacturing history uses six canonical transitions for the closed order: start, pause, resume, complete back to pending, another start, then complete. The resulting recorded spans are 300 seconds in progress and 50 paused within a 500-second retained window. Those are synthetic transition spans, not measured productive time. The native `progress-qr/report` response remains `batch_lineage`, so even a complete lineage must not become full-order elapsed intervals. Worker profile detail/history are bounded native records; genuine KPI aggregates are not supplied by the backend.

## Reset and inspect

Local control routes are fixture-only and require no authorization. They are never part of the production API.

```sh
curl -s http://127.0.0.1:5199/__qa/health
curl -s http://127.0.0.1:5199/__qa/state
curl -s http://127.0.0.1:5199/__qa/log
curl -s -X POST http://127.0.0.1:5199/__qa/reset -H 'Content-Type: application/json' -d '{}'
```

Reset restores seeds, clears sessions/mutations/logs and advances the synthetic epoch. Sign in again after reset. Logs retain at most 500 API requests with method/path, sanitized query/body, status, authorization presence and idempotency-header presence. They omit bearer values, phone numbers, login/rotated codes and credential fields. State remains in RAM; stopping the process discards it.

## Failure scenarios

Config updates preserve omitted fields. Rules match the exact decoded API path and method. A rule with `once: true` applies once; replace `rules` with `[]` to remove all rules. Delay is capped at 30 seconds. Controls can be run from a separate local terminal while the browser remains open.

| Scenario | Local control JSON for POST `/__qa/config` |
| --- | --- |
| Explicit save refusal | `{"rules":[{"method":"PUT","path":"/v1/mobile/admin/production-maps","status":403,"error":"forbidden","once":true}]}` |
| Started-stage conflict | `{"rules":[{"method":"PUT","path":"/v1/mobile/admin/production-maps","status":409,"error":"production_map_started_stage_locked","once":true}]}` |
| Server read failure | `{"rules":[{"method":"GET","path":"/v1/mobile/admin/items","status":500,"error":"store_failed","once":true}]}` |
| Slow save/session change | `{"rules":[{"method":"PUT","path":"/v1/mobile/admin/production-maps","delayMs":10000,"once":true}]}` |
| Saved, response lost | `{"rules":[{"method":"PUT","path":"/v1/mobile/admin/production-maps","dropResponse":true,"once":true}]}` |
| Saved, 500 reply | `{"rules":[{"method":"PUT","path":"/v1/mobile/admin/production-maps","status":500,"error":"store_failed","applyBeforeFailure":true,"once":true}]}` |
| Malformed success JSON | `{"rules":[{"method":"PUT","path":"/v1/mobile/admin/production-maps","invalidJson":true,"once":true}]}` |
| Partial group move, HTTP200 | `{"partialMoveCodes":["QA-PE-50"]}` |
| Block worker removal | `{"workerDeleteBlocked":true}` |
| Lock calculation source | `{"orderEditLocked":true}` |
| Unknown order status | `{"unknownOrderStatuses":["zakaz-qa-1001"]}` |
| Empty production snapshot | `{"emptyProduction":true}` |
| Block selected item delete | `{"blockedDeleteCodes":["QA-PET-12"]}` |
| Empty retained closed history | `{"emptyClosedHistory":true}` |
| Complete roll lineage | `{"manufacturingReportMode":"complete"}` |
| Wrong report order identity | `{"manufacturingReportMode":"wrong_identity"}` |

Apply a scenario:

```sh
curl -s -X POST http://127.0.0.1:5199/__qa/config -H 'Content-Type: application/json' -d '{"rules":[{"method":"PUT","path":"/v1/mobile/admin/production-maps","dropResponse":true,"once":true}]}'
```

For response loss, edit a future stage and save. `dropResponse` applies the write, flushes HTTP status/CORS headers and an incomplete JSON body with a larger declared Content-Length, then closes the response. Reconnect if the browser reports offline, then use “Saqlash holatini tekshirish”. The saved map should be confirmed through GET without another PUT. Inspect the sanitized log to count writes. The HTTP-handler test verifies the flushed, truncated response; the browser case verifies read recovery and exactly one received PUT for this scenario.

The first browser run used a socket close before any response headers and recorded two received PUTs: Chromium transparently retransmitted the idempotent HTTP method in its transport. The original failure report is retained at `docs/qa/synthetic-browser/2026-10-13T17-29-12-469Z/results.json`. The application’s single-flight/no-retry behavior cannot promise one physical request for every transport failure. The truncated-body scenario exercises application recovery deterministically; it does not prove native graph PUT has atomic server idempotency or revision protection.

For partial moves, the native DTO reports requested/updated/failed counts and code arrays while failed items remain in the original group; HTTP200 alone is not evidence of full success.

Revoke permissions while retaining the existing synthetic token to exercise real HTTP403 handling:

```sh
curl -s -X POST http://127.0.0.1:5199/__qa/config -H 'Content-Type: application/json' -d '{"capabilities":["apparatus.queue.read"]}'
```

Re-login after capability configuration to test capability-gated navigation. The web requires `admin.access` for an administrator session, so keep it when testing restricted administrator pages. Native map PUT allows either `admin.access` or `production.map.manage`; explicit rule403 is available for testing a write refusal under an already-visible editor.

## Concurrent state and dependency scenarios

```sh
curl -s -X POST http://127.0.0.1:5199/__qa/order -H 'Content-Type: application/json' -d '{"id":"zakaz-qa-1001","nodePatch":{"id":"cut","x":900}}'
curl -s -X POST http://127.0.0.1:5199/__qa/order -H 'Content-Type: application/json' -d '{"id":"zakaz-qa-1001","stageStates":{"print":"in_progress"}}'
curl -s -X POST http://127.0.0.1:5199/__qa/apparatus -H 'Content-Type: application/json' -d '{"apparatus_id":"apparatus:qa:print-2","placement":{"factory_map_object_id":"node:18:instance:1"}}'
curl -s -X POST http://127.0.0.1:5199/__qa/dependencies -H 'Content-Type: application/json' -d '{"worker_id":"qa-worker-2","active_work":[{"kind":"active_order","label":"QA Faol ish","apparatus":"apparatus:qa:print-1","order_id":"zakaz-qa-1002","status":"in_progress"}],"connections":[]}'
curl -s -X POST http://127.0.0.1:5199/__qa/opening-wip -H 'Content-Type: application/json' -d '{"batch_id":"<returned synthetic batch id>","batchPatch":{"wip_status":"in_use","used_by_session_id":"qa-active-session"}}'
curl -s -X POST http://127.0.0.1:5199/__qa/wip -H 'Content-Type: application/json' -d '{"batch_id":"qa-wip-1","batchPatch":{"next_apparatus":"apparatus:qa:cut-1"}}'
```

`/__qa/order` also accepts `mapPatch`, `templatePatch` and `control` to update synthetic state and advance revisions. `control: "frozen"` overlays frozen apparatus transport while canonical pending downstream stage states stay pending. `templatePatch` advances the calculation revision. `__qa/apparatus` advances its source revision. Recheck worker dependencies before confirming removal and inspect current assignments afterward.

Automated fixture tests use the dispatch layer and HTTP handler without binding sockets. Browser acceptance uses the explicitly started localhost listener. Save screenshots or run notes only inside this web worktree; never label them as production evidence.

## Isolated Playwright acceptance

Use only the official installed Playwright package and its downloaded headless Chromium runtime. The runner creates a fresh temporary browser context for each scenario; it never connects to Safari, another user browser, or an existing profile. Its HTTP and WebSocket guards abort any network origin outside the clean web5186/API5199 pair. It refuses a non-synthetic API or an older fixture version. Port5184 is untouched.

Restart the fixture to load version4, then run:

```sh
PLAYWRIGHT_PACKAGE_PATH=/tmp/accord-web-quality-qa/node_modules/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=/tmp/accord-web-quality-browsers node tests/browser/acceptance.mjs
```

`PLAYWRIGHT_PACKAGE_PATH` accepts an installed module path; its default is `playwright`. Browser binaries/dependencies belong outside this repository and must not be committed. The default app/API origins are fixed loopback5186/5199. Any overrides through `QA_WEB_ORIGIN` or `QA_API_ORIGIN` must still be localhost/127.0.0.1 on those exact ports.

The runner defines 33 scenarios. It retains the original 15 cases for authentication/dashboard, catalog/party/roles, saved-map editing, bundled 3D, materials/raw assignments and production queue controls. New cases cover touch list selection and canvas keyboard selection; calculator order edit/conflict and template update/delete; pending reserved-number release; opening WIP registration/partial cancellation/used lock and lost-response recovery; authoritative WIP route preview; capacity/policy/downtime, capacity conflict and order schedule/cancel; retained history ruler/zoom/filter/order reset, partial/error/empty history and wrong report identity; bounded worker activity/details/history/empty/error recovery; actual stage isolation with one canvas/model, repeated stages/unbound/stale state, and unresolved alternatives with reduced motion on a touch viewport. Each executed case checks visible behavior plus synthetic server state. Missing fixture routes and uncaught page errors fail the case, so unsupported behavior cannot become acceptance proof.

The corrected baseline run is retained at `docs/qa/synthetic-browser/2026-10-13T17-39-50-217Z/results.json`: 14/15 passed, with the fullscreen selection assertion still failing. An isolated stable-source debug retained selection; the runner preserves the assertion and now records checkpoints around search/fullscreen/exit instead of assuming the cause. New scenarios require a fresh run before claiming browser verification.

Screenshots and sanitized reports are written to `docs/qa/synthetic-browser/<run timestamp>/`. `docs/qa/synthetic-browser/results.json` points to the latest run. Each run keeps its own results and screenshot list. Failed cases record their actual error and capture the failure screen when supported. A missing browser/runtime is a failure, not a passing fallback. Results explicitly say `productionVerified: false`.

Review the screenshots against the existing theme: preserve the current palette and theme tokens, avoid decorative gradients, and use additional status colors only where they communicate state. The renderer check requires the bundled canvas to finish loading and retain the selected native object key through fullscreen. Screenshot capture and DOM assertions alone do not constitute a completed human visual review.

Rerun a selected case after fixing a mismatch:

```sh
PLAYWRIGHT_PACKAGE_PATH=/tmp/accord-web-quality-qa/node_modules/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=/tmp/accord-web-quality-browsers node tests/browser/acceptance.mjs --only=materials-micron-reorder,raw-material-assign-unlink,production-pause-resume-freeze
```

Selected runs report only selected scenarios. Do not claim the whole suite passed from a subset. Worker records are bounded loaded data, not genuine KPI aggregates. Touch coverage uses Playwright's fresh touch context on the accessible list target; it does not certify physical-device gestures or hardware.
