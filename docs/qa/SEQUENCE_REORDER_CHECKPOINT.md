# Apparatus queue reorder checkpoint — 2026-10-14

Orders → **Apparat navbati** is now a reachable native-data queue table with
reviewed shadcn dashboard-01 drag handles, mouse/touch dragging, Space/Enter and
arrow keyboard sorting, Escape cancellation, per-row arrow alternatives, a save
confirmation and restored keyboard focus. Existing order-detail arrows remain,
with a link to the full queue. Existing palette and architecture are preserved.

Native POST `/v1/mobile/admin/production-maps/sequence` is the only write. The
command contains an actual canonical apparatus/order, one eligible before/after
anchor, 64-hex expected version and stable idempotency key. No bulk PUT, invented
endpoint or backend/mobile change is used. A fresh preflight rejects changed
membership/version/state. Definitive conflicts require a newly reviewed intent;
transport/408/429/5xx/malformed responses retain the original body and key.

Running, paused, preflight and frozen orders are locked. Drops clamp after the
last active row. Frozen display rows never become anchors; hidden canonical
members survive. Search disables sorting. Unknown data, stale/error/offline
states, demo mode and native permission refusals fail closed. Reorder writers
reserve both the order and apparatus across panels. Interrupted/dispatched
commands survive same-session tab/detail remount and refresh in the shared RAM
ledger. Exact-key recovery can obtain durable native receipts after a backend
epoch change; merely reading a matching queue does not resolve an unknown write.

## Verification

- Full web Vitest suite: **1,161 tests / 72 suites passed**. This includes the
  previously preserved unmounted worker-group module (68 tests / 2 suites);
  it is still not a delivered UI.
- Focused planner, receipt/executor, shared-ledger and controls suite:
  **96 tests / 5 suites passed**.
- TypeScript and production build passed. New queue lazy chunk is ~22KB gzip.
- Oxlint on the changed application files: zero errors, 12 warnings. Four are
  the new panel's existing project patterns for scoped refs, wall-clock freshness
  and synchronization effects; the remainder are prior-file warnings.
- Native fixture v9 adds only an explicit synthetic queue cohort; default
  scenarios are preserved. Initial full fixture run exposed two old v8 health
  assertions; both were updated to v9. Corrected full fixture suite:
  **139/139 passed** (127 delivered fixture checks plus 12 preserved unmounted
  worker-group checks).
- Focused localhost Chromium suite: **12/12 passed**, zero outside requests and
  zero uncaught page errors. It covers pointer save, keyboard save + restored
  focus, repeated arrows, running/paused clamp, global/raw frozen locks, hidden
  canonical preservation, search/empty search and cancellations, stale preflight
  conflict, loss + identical automatic retry, uncertain tab remount/read/recovery,
  interrupted save + exact-key recovery, HTTP403 no commit, mobile reduced-motion
  arrows, and real touch sensor drag.
- Report: `sequence-reorder/2026-10-14T00-52-25-010Z/results.json`.
- Served build: `/tmp/accord-web-quality-static-sequence-committed-VqItXl`, entry
  `index-CAioaJDC.js`, from application commit `477cbea7841fb9f353991fa9d83521c6e9e917b7` atop `621cdb6`.
- Local previews on ports 5184/5186, synthetic API on 5199; only verified
  task-owned processes were restarted. No production ERP/API/DB was accessed.

Early failed keyboard probes are retained. The runner now awaits rendered drag
measurement frames before advancing keyboard events. A real missing focus return
after the programmatic confirmation dialog was fixed and the full suite passed.
No failure is relabeled as a pass.

## Limits

This completes the focused sortable apparatus queue, not the entire ERP parity
matrix. Multi-order batch move breadth and previously recorded unrelated gaps
remain. The existing RAM-only operation ledger survives component remounts and
reads, not full browser reload or logout; there is no fabricated persistent
receipt store. Native constraints and data are verified locally with synthetic
fixtures, not against production. Third-party provenance/licenses are in
`../third-party/sequence-reorder.md`.

Synthetic light queue screenshot: Library `libfile_92afcf13aa74819196b352b9e8c0bee5`.
Full final metrics are in `SEQUENCE_REORDER_VERIFICATION.json`.
