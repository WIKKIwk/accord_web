# Native apparatus collections

Implementation: `bc94a341927b0c85a0d33d35845179f30ec192db` on `codex/web-apparatus-collections-20261014`, based on accepted worker-group source/evidence `dff37ce`. Original main remains clean at `46ed81c`. This completes bounded S02 collection management; complete mobile parity and production readiness are not claimed.

Open `/app/apparatus` → **Apparat guruhlari**. Users can list/search collections, create one, edit its name and selected members, or confirm deletion. Read-only users see the directory without write actions. Empty collections and overlapping apparatus memberships follow native behavior. The simple count line answers how many collections and distinct recorded members exist; no additional chart is imposed.

## Verified behavior

| Flow | Evidence |
| --- | --- |
| Create | Native POST fields only, server-shaped ID/revision1, exact200; apparatus configuration and role access unchanged |
| Rename/member replacement | Same ID, revision increment, native PUT expected_revision; shared memberships allowed |
| Delete | Reviewed group-only confirmation, native expected_revision and exact204; apparatus records/access remain intact |
| Permissions | Native seven-capability OR for read; production.map.manage independently required for writes; readonly UI accepted |
| Conflicts | Stale preflight blocks before write; changes after preflight produce real native409 in update/delete; explicit fresh-read restart |
| Duplicate name | Native409 preserves an editable draft; full GET is not rejected by a client Unicode/collation assumption |
| Bounded and retired members | Existing selection beyond500 survives search; every selected ID is read individually before save; retired selection fails safely or can be removed |
| Unknown create/update/delete | Frozen original intent, no application replay, live-session remount, current GET and explicit review; missing/matching values are not receipt proof |
| Interruption | Both dispatched create/delete loss and preflight cancellation accepted; no blind command replay |
| Usability | Empty/loading/error/retry/cancel/search states, repeated submit, Escape focus return, mobile dark and reduced motion; responsive captures visually reviewed |

The committed-source browser suite passes **25/25**. On the same build, worker-group regression passes **25/25**, queue reorder **12/12**, and genuine dashboardcn **18/18**. Source tests pass **1,288/76 files**, including **97 collection tests** and two new core transport regressions; fixture tests pass **167**, including **24 collection tests**. Typecheck, QA build and normal production build pass. Focused temporary Oxlint has zero errors and eight warnings. Exact commands/reports are in [COLLECTION_VERIFICATION.json](COLLECTION_VERIFICATION.json).

Independent Sol 6.1/max review found one Unicode-name defect, now corrected with regressions. Native Rust whole-string lowercasing has contextual Greek sigma; PostgreSQL uniqueness depends database `lower(name)` collation. The frontend validates duplicate IDs but does not manufacture a name-fold invariant for full GET. Exact duplicate names may be caught in preflight; native409 remains authoritative for case/collation conflicts.

The initial delete-loss failure was a fixture bug: trying to measure an absent 204 body returned 400. It is fixed. Proper 204 loss occurs before headers; configured Chromium then retransmits native DELETE and receives 404. This probe records two wire requests and one deletion. A separate probe delivers real loss directly to fetch with `maxRetries:0` and verifies app unknown handling. The app contains no automatic command replay. Earlier failed artifacts are retained without being relabeled as passes.

## Native limits

- Native PUT/DELETE revision CAS is atomic. Create has no idempotency key, and no operation has a receipt-lookup endpoint. Matching or missing current data cannot establish which request committed it.
- PostgreSQL GET reads collection metadata and member rows separately outside one read transaction; a concurrent change may yield a mixed snapshot. The frontend's fresh read cannot manufacture a transactional snapshot.
- Active apparatus validation precedes persistence. The member FK preserves canonical identity existence, without an atomic active-lifecycle assertion.
- The active picker is bounded500. Selected IDs are retained outside search results and checked individually. Unavailable names remain honest ID fallbacks.
- Recovery remains RAM-only across full reload, process loss or identity change. The UI warns and installs beforeunload for pending/unknown intent. No auth/storage scope was expanded.

Primary read-only evidence: backend `src/http/handlers/admin/system/apparatus_collections.rs`, `system/apparatus.rs:184`, `src/core/apparatus_collections.rs`, `src/db/postgres_apparatus_collection.rs`, `migrations/postgres/0075_apparatus_collections.sql`; mobile API `mobile_api_admin_items_MobileApiAdminItems_methods_02.dart` and native collection editor/cards. The PostgreSQL store's CAS/name-check ordering, not the differing Memory-store ordering, is used by the fixture. The fixture's Unicode fold is a documented memory-store approximation, not a live database collation certificate.

Desktop [Library screenshot](https://chatgpt.com/api/library/files/libfile_0ccc1139326481918bd05ac774ffcc5e/download), version0. The final committed-build report retains mobile/editor/delete/recovery captures, all labeled synthetic DEMO. Preview 5184/5186 serves `/tmp/accord-web-quality-static-collections-committed-btbwUB`, source `bc94a34`.

Backend remains clean at `fd59167`; mobile remains at `bc96f1c` with all 17 modified paths preserved. No backend/mobile write, dependency change, push, merge, deployment or production access occurred. The brief Mac connection interruption was recovered from existing files/processes; no worker or command was blindly duplicated.
