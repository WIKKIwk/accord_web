# W12 paddon administration checkpoint

Worktree: `/Users/wikki/Desktop/Accord_project/sandbox/accord_web_quality`.
Baseline: `abf3f02c22df9e377b1526a009ffe835ae560d41`, branch `codex/web-apparatus-collections-20261014`.

Application source: `110650c58b2ad8a2832e690e4ff99aec430ff8ca`. Open `/app/paddons` from **Ishlab chiqarish → Paddonlar**. Native directory/detail, creation, deletion of unused paddons, atomic batch add/remove, and authorized unlock are implemented. Printing/reporting, print confirmation, active apparatus selection/successor handoff, QR scanning and S08 settings remain separate acceptance work. W12 is partially accepted, not complete mobile parity. Backend/mobile are reference-only; no production access, push, merge or deployment occurred.

All acceptance below uses fresh isolated Chromium profiles, synthetic localhost fixture version12 and the actual committed application build. The fixture models native contracts; it does not execute PostgreSQL or mobile/hardware runtime.

| Workflow | Required behavior |
| --- | --- |
| Directory/detail | Accepted: latest 200 visible native records, direct code lookup beyond that list, authoritative nullable product weights, bounded 500 available-item disclosure, loading/error/empty and safe read retry. |
| Create/delete | Accepted: UTF-8 limits160/500 bytes; server-generated identity from explicit native200 confirmation; unused deletion uses POST200 `{ok:true}`. Native history remains final; empty historically used deletion is rejected. |
| Batch membership | Accepted: 1–500 distinct batches after native deduplication; capability plus fresh `can_manage_items`; selection retained through local search; atomic mixed-invalid rejection; free movement transfer across unreceipted paddons, including printed source paddons. |
| Unlock | Accepted: capability plus fresh `can_unlock`; explicit in-product confirmation; printed reopening and received/lock-owner protection. Missing lock state in a HTTP200 reply remains unknown. |
| Interrupted writes | Accepted: frozen RAM intent; no application replay; post-dispatch loss, throttle/server errors, malformed/incomplete/unexpected-success confirmations retained. A read never proves receipt. Offline users can explicitly request a read-only observation; writes still require online status. Pending closure and same-scope navigation are covered. |
| Local QA | Passed: 1,366 unit tests/78 files (69 paddon API +8 UI +1 route permission added), 193 fixtures (21 pure paddon +5 integration added), typecheck and production/QA builds; lint zero errors/one Fast Refresh warning. Browser paddons35/35; collections25/25, worker groups25/25, queue12/12 and dashboardcn18/18. |

Root owned page/navigation/integration/browser evidence. The pinned Sol 6.1/max API worker owned only four new API/fixture files. The pinned Sol 6.1/max independent reviewer confirmed no remaining P1/P2 in corrected source and rechecked the offline observation/pending-closure fix on `110650c`.

Review and browser findings fixed in this increment: native normal available-item responses can contain ineligible rolls; free-mode removal has additional eligibility rules; null stock/receipt markers are valid; observed movement-mode changes require fresh review; detail-only observations do not replace the complete directory cache; malformed unlock confirmations cannot imply an unlocked state; read-only recovery remains reachable after transport failure; a completed create preserves an intentionally closed dialog.

Native limits remain explicit:

- No revision CAS, expected-mode precondition, idempotency key or command-receipt lookup exists. State/mode changes after preflight can still affect a native write. PostgreSQL mutations are transactional; response enrichment can fail after commit.
- A free-mode add can move eligible rolls from another unreceipted paddon. Native transfer SQL does not impose a separate source-owner visibility check. The page describes this behavior without inventing ownership restrictions.
- List and available-item feeds have no pagination or whole-system total. Native item/weight snapshots are observations, not write receipts or fully atomic read snapshots.
- Weights are product weights only, excluding pallet tare. Unknown values remain unknown; received totals are frozen. No totals are reconstructed from WIP lengths or quantities.
- Recovery stays in session RAM. Full reload/logout/identity change loses accessible recovery state. The interface warns about this and sets beforeunload for pending/unknown intents.
- The application sends no automatic replay. Browser/transport retransmission is outside this guarantee; prior native408 behavior remains recorded in the worker-group checkpoint.

Original web main remains clean at `46ed81c`; backend remains clean at `fd59167`; all 17 user-modified mobile paths at `bc96f1c` are preserved. No dependency change or reference-project write occurred.

[Verification and exact commands](PADDON_VERIFICATION.json) · [Current parity matrix](CURRENT_ACCEPTANCE.md) · [DEMO desktop screenshot](deliverables/accord-demo-paddon-directory-light.png). Current private Library screenshot: `libfile_562fc5ae97a48191a5d45fed6316bdc8`, version0. Supplemental true-viewport desktop and mobile captures pass2/2; full-page captures remain available separately.
