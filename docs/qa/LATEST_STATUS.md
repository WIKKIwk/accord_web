# Current verified milestones

**Paddon administration is implemented in `110650c`.** Open `/app/paddons` for native list/detail/create, unused deletion, atomic batch add/remove and authorized unlock. Fresh capability/state guards, explicit destructive confirmation, bounded feeds, authoritative product weights, retained uncertain intent and offline read-only observation are accepted. [Checkpoint](PADDON_CHECKPOINT.md) · [Verification](PADDON_VERIFICATION.json).

The actual committed application passes paddons35/35, collections25/25, worker groups25/25, queue12/12 and dashboardcn18/18. Supplemental true-viewport captures pass2/2. Source tests1366/78 files and fixtures193/193 pass; typecheck and production/QA builds pass. Focused lint has zero errors and one Fast Refresh warning. Current preview5184/5186 serves `/tmp/accord-web-quality-static-paddons-committed-tGQuV2`. Library DEMO screenshot: `libfile_562fc5ae97a48191a5d45fed6316bdc8`, version0; local identity and xattrs are verified.

Native responses provide no CAS/expected-mode/idempotency/receipt protocol. Response enrichment can fail after commit, snapshots remain observations, and recovery is RAM-only. Printing/QR work, print confirmation, active selection/successor handoff and S08 settings remain explicit W12/adjacent gaps. This does not certify complete parity or production readiness.

Original web main `46ed81c` and backend `fd59167` remain clean. All 17 modified mobile paths at `bc96f1c` are preserved. No production access, push, merge, deployment, dependency or backend/mobile change occurred.

## Retained collections checkpoint

**Apparatus collections are implemented in `bc94a34`.** Open `/app/apparatus` → **Apparat guruhlari** for native create/edit/member replacement/delete. Read-only access, revision conflicts, duplicate-name correction, interrupted/unknown saves and retained bounded selections are accepted. [Checkpoint](COLLECTION_CHECKPOINT.md) · [Verification](COLLECTION_VERIFICATION.json).

Committed-source browser gates pass collections 25/25, worker groups 25/25, queue 12/12 and dashboardcn 18/18. Full source tests pass 1,288/76 files; fixtures 167/167; typecheck and production/QA builds pass. Focused lint has zero errors and eight warnings. The current preview serves `/tmp/accord-web-quality-static-collections-committed-btbwUB` on 5184/5186, source `bc94a34`. Desktop/mobile rendering was visually reviewed. Library screenshot: `libfile_0ccc1139326481918bd05ac774ffcc5e`, version0.

The 204 loss fixture and incorrect Unicode name-fold assumption are corrected. Native revision CAS remains final authority; create has no idempotency/receipt lookup. GET snapshot/lifecycle races, browser DELETE retransmission and RAM-only recovery remain explicit. Original main `46ed81c` and backend `fd59167` are clean; all 17 mobile changes at `bc96f1c` remain preserved. No push, merge, deployment, production access or backend/mobile write occurred.

Earlier worker-group milestone remains preserved in `293ee29`/`dff37ce`; all 54 workflow IDs retain current scope in [CURRENT_ACCEPTANCE.md](CURRENT_ACCEPTANCE.md). Complete parity/product readiness is not claimed.

## Retained worker-group checkpoint


**Worker-group administration is implemented in `293ee29`.** On `/app/workers`, open **Ishchi guruhlari** for native create/edit, rename and apparatus move, shift/schedule/accounting and membership. The real group overview remains secondary to the form/list. Native profile checks prove membership changes without granting apparatus access. [Checkpoint](WORKER_GROUP_INTEGRATION.md) · [Verification](WORKER_GROUP_VERIFICATION.json).

Full source tests pass **1,189/74 files**; group-specific tests **96**; fixture tests **143**. Typecheck and production/QA builds pass; focused lint has zero errors and ten warnings. Worker-group browser acceptance passes **25/25 on committed `293ee29`**; the exact report is linked in the verification record. Current local preview serves committed `293ee29` from `/tmp/accord-web-quality-static-worker-groups-committed-YCT8ER` on 5184/5186. Responsive light/dark captures are retained and visually reviewed. Desktop Library screenshot: `libfile_267eb33cd34881918049fdc0c47176d5`, version0, from the passing precommit render.

Regression checks pass 12 queue browser cases, 18 genuine dashboardcn proofs and 31 original-CAD states. They ran on the precommit build; the final source change only repaired recorded-member ID search. Original geometry, themes, isolation and dashboard placement remain intact.

Group writes have no native CAS/idempotency/receipt lookup. Chromium retransmitted a wire PUT after native408; this remains an explicit transport limitation. Pending/unknown intent survives live-session remounts but is RAM-only; the interface warns about full reload/logout and triggers beforeunload. A matching GET does not prove the original write. Complete mobile parity and production readiness are not claimed.

Original web main is clean at `46ed81c`, backend clean at `fd59167`, and all 17 mobile changes at `bc96f1c` are preserved. This increment made no push, merge, deployment, production request, backend/mobile write or dependency change. Next supported bounded gap: S02 apparatus collections, with existing native GET/POST/PUT/DELETE and update/delete revision checks.

Earlier accepted milestones remain available: [queue reorder](SEQUENCE_REORDER_CHECKPOINT.md), [CAD switching](CAD_SELECTION_CHECKPOINT.md), [CAD theme](CAD_THEME_CHECKPOINT.md), [nested worker details](NESTED_DIALOG_CHECKPOINT.md), [genuine dashboardcn](DASHBOARDCN_CHECKPOINT.md), and the retained 117-case combined acceptance. All 54 workflow IDs retain explicit scope/limits in [CURRENT_ACCEPTANCE.md](CURRENT_ACCEPTANCE.md).
