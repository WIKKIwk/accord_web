# Worker record dialog acceptance

The worker profile now retains its outer detail sheet and active tab when Escape closes a nested session, batch or event record. The initiating record button receives focus after the native dialog unmount callback. A scoped window capture listener intercepts the child Escape before the parent's document capture listener; ordinary keys and composing input continue normally, and cleanup restores normal outer dismissal.

Verified with synthetic records only. `npm run test -- src/lib/nested-dialog-escape.test.ts src/lib/worker-profile.test.ts src/components/worker-profile-controls.test.tsx` passes **29 tests across three suites**. The retained real Chromium run at [results.json](synthetic-browser/2026-10-13T22-22-10-021Z/results.json) passes both normal-motion and reduced-motion cases. It checks session and batch detail closure, exact trigger focus, parent tab continuity and the selected worker identity. It waits for Radix's real focus callback rather than moving focus from the test.

The browser run used `http://127.0.0.1:5186`, a fresh isolated Chromium context and the in-memory fixture at `http://127.0.0.1:5199`, version 8, with `/tmp/accord-web-quality-static-visible-guarded-ByOGar`. No production verification is claimed. The earlier reduced-motion failure remains retained at `synthetic-browser/2026-10-13T22-19-23-098Z/results.json`; the failure was the immediate focus assertion preceding the asynchronous unmount callback.

The browser driver is part of the broader pending synthetic acceptance increment. This checkpoint commits only the narrowly reviewed worker UI fix, its helper and focused tests, plus its retained two-case result.
