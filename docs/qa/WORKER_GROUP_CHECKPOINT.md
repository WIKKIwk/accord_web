# Preserved worker-group source checkpoint

This checkpoint is committed at the user's explicit instruction to commit all task-owned work. It preserves the existing, paused worker-group implementation without adding a route, toolbar, import or API call to the application. **The controls remain unmounted and the standalone fixture is not integrated with the running ERP fixture.** This is not a delivered or browser-accepted group workflow.

Owned files are `src/lib/worker-groups.ts` and its tests, `src/components/worker-group-controls.tsx` and its tests, and `tests/fixtures/erp-worker-groups.mjs` and its tests. The native API model covers strict admin access, canonical apparatus identities, exact group upsert/rename identity, validated active worker membership, global duplicate-member refusal, schedules/defaults and uncertain-write preservation. It invents no DELETE, atomic CAS or idempotency contract.

The frozen checkpoint passes **68 unit tests across two suites** and **12 standalone fixture tests**. It was already included in the successful combined TypeScript checks. These tests are separated from the 1044 delivered application tests and 122 delivered fixture tests. Mounting, running browser scenarios and accepting the workflow remain future work; no feature integration was performed at this checkpoint.

```sh
npm run test -- src/lib/worker-groups.test.ts src/components/worker-group-controls.test.tsx
node --test tests/fixtures/erp-worker-groups.test.mjs
```
