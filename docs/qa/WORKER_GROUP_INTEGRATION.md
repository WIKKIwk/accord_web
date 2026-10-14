# Native worker-group administration

Implementation commit: `293ee29a0a48c7fd811794d1bf0b8769d71eb2d8` on `codex/web-worker-groups-20261014`, based on the user's clean `46ed81c` main. This completes the bounded C09 worker-group feature; it does not certify complete mobile parity or production readiness.

Open **Workers / Xodimlar → Ishchi guruhlari** at `/app/workers`. The existing dialog now supports native create/edit, rename and apparatus move, shift/overnight schedule, work days, week start, accounting and member replacement. Four small genuine dashboardcn KPI cards summarize the full native group GET. Optional apparatus counts stay collapsed; forms and the directory remain primary.

## Acceptance

| Behavior | Verified evidence |
| --- | --- |
| Create with normalized name, overnight time, days/start day, accounting and actual member | Browser save, exact native PUT fields, stored group and worker profile |
| Rename/move with previous canonical identity | Browser move to cut apparatus; old identity removed |
| Remove member and assign it to another group | Browser repeated flow and native profile membership removal |
| Membership does not grant apparatus access | Before/after native profile comparison; role assignments unchanged |
| Global one-group-per-worker rule | Disabled already-assigned choices; fresh whole-group preflight and native atomic fixture refusal |
| Directory/worker search and retained selection | Browser names, no matches, 500-bound picker and a member beyond that bound; fallback recorded-ID search unit regression |
| Stale edit, colliding create and inactive exact worker | Fresh reads reject before any PUT; current data/restart remains available |
| Known native 400/403 write refusal | Browser one refused PUT, no commit, usable retained draft and cancel |
| Loading, read failure, permission failure, empty apparatus/worker/group data | Browser states, retry retention and disabled writes; failures are not presented as zero/empty data |
| Loss, malformed 200, 408 reaching fetch and native 429 | Unknown intent, immutable original selection, one application dispatch, remount and read-only explicit review |
| Interrupted dispatched save | Dialog can close; late native commit remains unknown until review; no application replay |
| Interrupted preflight | No PUT, no retained unknown intent; reopening works |
| Repeated submit | One native PUT |
| Reload warning and keyboard closure | Cancelled beforeunload keeps RAM intent; Escape returns toolbar focus |
| Responsive interface | 390×844 dark/reduced-motion create and 1440×1000 light directory; no horizontal overflow; screenshots visually reviewed |
| Existing queue, charts and original CAD | Independent 12 queue cases, 18 chart proofs and 31 CAD states pass on the precommit build; their exercised surfaces are unchanged by the final recorded-ID search fix |

The final committed-build result and exact report paths are in [WORKER_GROUP_VERIFICATION.json](WORKER_GROUP_VERIFICATION.json). Earlier failed runs remain retained, including the original Chromium 408 observation.

Full source gate: **1,189 tests / 74 files**. Group-specific source gate: **96 tests**. All fixture tests: **143**, including **16** native group/route/profile tests. Typecheck and production/QA builds pass. Focused temporary Oxlint has zero errors and ten warnings, including inherited hook/ref and fast-refresh patterns. Independent pinned Sol 6.1/max review identified the fallback-ID search defect; it is fixed with regression coverage. No further actionable issue was found in the requested permission/baseline/remount/abort paths.

## Native and runtime limits

- `GET/PUT /v1/mobile/admin/worker-groups` requires `admin.access`. There is no group DELETE, request receipt lookup, idempotency key or revision/CAS field. Readback cannot establish who saved matching values or prove the original request completed.
- Fresh baseline/identity/member checks protect the observed preflight. Native create still replaces an existing exact identity, and changes after preflight can be overwritten. The native transaction rechecks active workers and cross-group membership, but has no atomic apparatus lifecycle/display assertion.
- Worker enrichment happens after the native commit. An enrichment failure or concurrent deactivation can produce an unverifiable response after persistence, so unknown state is retained.
- In the configured real Chromium transport, a native HTTP408 caused two wire PUTs: 408 then exact200. The application contains no retry. A separate probe delivers the real fixture408 directly to fetch and verifies unknown handling. The wire-level retransmission is recorded as a remaining limitation, not hidden by the passing app-level probe.
- Intent survives dialog and page-component remounts within the same live session scope. Full reload, tab/process loss or identity change loses accessible RAM recovery. The UI discloses this and installs a native beforeunload warning for pending/unknown intent. No auth, persistent secret storage or backend contract was expanded.
- Worker/apparatus pickers are bounded at500 and support native search. The overview counts full native group records and never infers workforce coverage from those picker catalogs.

Native source references: `mini_rs_erp/src/http/handlers/admin/workers_profiles.rs:281`, `workers.rs:407`, `src/core/worker_groups.rs` and `worker_groups/normalize.rs`; mobile reference `accord_mobile_v2/lib/src/core/api/admin/mobile_api_admin_users_workers_MobileApiAdminUsersWorkers_methods_02.dart:188`. Both projects were read-only.

## Review artifacts and continuation

Desktop Library screenshot: [Ishchi guruhlari](https://chatgpt.com/api/library/files/libfile_267eb33cd34881918049fdc0c47176d5/download), version0. The Library copy is the passing precommit light render; the committed-build responsive captures and their actual source metadata are retained in the final report. All imagery is marked synthetic DEMO.

The original web remains clean at `46ed81c`; backend remains clean at `fd59167`; the mobile reference retains all 17 modified paths at `bc96f1c`. No push, merge, deployment, production access, backend/mobile mutation or package change occurred in this increment.

Next bounded supported gap: **S02 apparatus collections**. Native GET/POST list/create and PUT/DELETE by opaque ID exist. Update/delete use `expected_revision`, and writes require `production.map.manage` after apparatus authorization. Mobile already has collection cards/editing. This can be completed in the web without changing shared backend or mobile contracts.
