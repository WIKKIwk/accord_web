# Intentionally retained local QA artifacts

All task-owned application source, regression tests, standalone checkpoint source and documentation are committed. Generated artifacts below remain intentionally untracked. They are kept for inspection and traceability, not represented as application changes or a clean directory with no files. Selected immutable reports and useful captures are committed; current screenshot Library identities/versions are in [DELIVERY_MANIFEST.json](DELIVERY_MANIFEST.json).

| Local path category | Purpose / retention |
| --- | --- |
| `docs/qa/synthetic-browser/` | Earlier failed/subset runs and 155 captures from the clean full run; selected immutable result JSON is committed |
| `docs/qa/cad-selection/` | Original two-click reproduction, extra no-order/overview captures and fresh committed-build images; selected 31-state reports and B comparison images are committed |
| `docs/qa/cad-theme/`, `docs/qa/cad-preservation/` | Earlier preservation/theme attempts and additional original-CAD pixel evidence; selected accepted checkpoint reports/captures are committed |
| `docs/qa/dashboardcn/` | Earlier redistributed chart captures and current committed-build screenshots; accepted 18-proof reports and selected complete first acceptance images are committed |
| `docs/qa/dashboard-reference-pass/`, `docs/qa/home-reference-pass/` | Historical visual comparisons, genuine Home desktop/mobile captures and capture metadata |
| `docs/qa/deliverables/` | Local copies for Library upload/versioning, selected before/after pictures and older superseded prototypes; persistent current identities are recorded |
| `docs/qa/dashboard-local-fixture.png`, `docs/qa/synthetic-browser/results.json` | Generated representative snapshot and latest-run pointer; immutable run JSON is committed separately |
| `docs/qa/worker-groups/`, `docs/qa/sequence-reorder/` | Passing and failed group/reorder runs, responsive captures and retained transport observations; selected immutable reports are committed |
| `docs/qa/apparatus-collections/` | Failed fixture-loss attempts, accepted committed-source runs, responsive screenshots and transport observations; selected final evidence committed |
| `docs/qa/paddons/` | Diagnostic failures, accepted35-case committed-application run, supplemental true-viewport captures and retained recovery evidence; selected final reports/images committed. The earlier12:08 diagnostic run had an incorrect build-directory argument and is not current acceptance evidence. |
| `docs/qa/paddon-handoff/` | Initial harness diagnostics and passing37-case implementation acceptance, final4-case true-viewport acceptance and actual recovery/output integration captures. Selected accepted reports/images are committed. Earlier failed harness comparisons are diagnostic only. |
| `docs/qa/reference-inputs/` | User-provided private screenshots; ignored, preserved locally, never re-uploaded or committed |
| ignored `node_modules`, build/type caches | Dependencies isolated under `/tmp`; original project's dependency tree preserved |
| `/tmp/accord-web-quality-*` | Task-only static bundles, detached listener registries/logs, temporary tooling and check output; current preview remains available |

At the2026-10-14 worker-group increment, original web main is clean at `46ed81c` and backend is clean at `fd59167`. The mobile reference keeps all 17 user-modified paths at `bc96f1c`. This increment wrote nothing into either reference project and performed no production access, push, merge or deployment. The earlier separately authorized public push is a historical action, not renewed authority.
