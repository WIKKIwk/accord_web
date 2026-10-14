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
| `docs/qa/reference-inputs/` | User-provided private screenshots; ignored, preserved locally, never re-uploaded or committed |
| ignored `node_modules`, build/type caches | Dependencies isolated under `/tmp`; original project's dependency tree preserved |
| `/tmp/accord-web-quality-*` | Task-only static bundles, detached listener registries/logs, temporary tooling and check output; current preview remains available |

The original React web and backend working trees are clean. The mobile reference keeps the user's nine intentional printer-related changes. No source or generated file was written into either reference project. No production access, push, merge or deployment occurred.
