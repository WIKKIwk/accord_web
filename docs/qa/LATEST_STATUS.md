# Current verified milestones

**Worker-group administration is implemented in `293ee29`.** On `/app/workers`, open **Ishchi guruhlari** for native create/edit, rename and apparatus move, shift/schedule/accounting and membership. The real group overview remains secondary to the form/list. Native profile checks prove membership changes without granting apparatus access. [Checkpoint](WORKER_GROUP_INTEGRATION.md) · [Verification](WORKER_GROUP_VERIFICATION.json).

Full source tests pass **1,189/74 files**; group-specific tests **96**; fixture tests **143**. Typecheck and production/QA builds pass; focused lint has zero errors and ten warnings. Worker-group browser acceptance passes **25/25 on committed `293ee29`**; the exact report is linked in the verification record. Current local preview serves committed `293ee29` from `/tmp/accord-web-quality-static-worker-groups-committed-YCT8ER` on 5184/5186. Responsive light/dark captures are retained and visually reviewed. Desktop Library screenshot: `libfile_267eb33cd34881918049fdc0c47176d5`, version0, from the passing precommit render.

Regression checks pass 12 queue browser cases, 18 genuine dashboardcn proofs and 31 original-CAD states. They ran on the precommit build; the final source change only repaired recorded-member ID search. Original geometry, themes, isolation and dashboard placement remain intact.

Group writes have no native CAS/idempotency/receipt lookup. Chromium retransmitted a wire PUT after native408; this remains an explicit transport limitation. Pending/unknown intent survives live-session remounts but is RAM-only; the interface warns about full reload/logout and triggers beforeunload. A matching GET does not prove the original write. Complete mobile parity and production readiness are not claimed.

Original web main is clean at `46ed81c`, backend clean at `fd59167`, and all 17 mobile changes at `bc96f1c` are preserved. This increment made no push, merge, deployment, production request, backend/mobile write or dependency change. Next supported bounded gap: S02 apparatus collections, with existing native GET/POST/PUT/DELETE and update/delete revision checks.

Earlier accepted milestones remain available: [queue reorder](SEQUENCE_REORDER_CHECKPOINT.md), [CAD switching](CAD_SELECTION_CHECKPOINT.md), [CAD theme](CAD_THEME_CHECKPOINT.md), [nested worker details](NESTED_DIALOG_CHECKPOINT.md), [genuine dashboardcn](DASHBOARDCN_CHECKPOINT.md), and the retained 117-case combined acceptance. All 54 workflow IDs retain explicit scope/limits in [CURRENT_ACCEPTANCE.md](CURRENT_ACCEPTANCE.md).
