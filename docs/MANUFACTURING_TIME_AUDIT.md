# Manufacturing time and history contract audit

Audit date: 2026-10-13. Source inspection only; no production data, API calls, database access or reference-project mutations. This document specifies defensible inputs for the stage timeline, history ruler and executive drilldown. It supplies no measured factory durations.

## Decision

The existing API can support a timeline of **recorded queue transitions**, explicit report/freeze/roll markers and **observed elapsed spans** for the returned history. It cannot establish productive machine time, OEE, complete historical queue waiting, or an all-orders bottleneck census.

Use the closed-order feed for retained completed-order history, current sequence controls for current-state context, and an explicit QR report for a selected roll's verified lineage. Retain each source's scope and limits. A complete roll lineage is not a complete state-transition history. Never sum output-batch elapsed timestamps as stage processing time: PostgreSQL reconstructs those timestamps from mutable parent sessions.

## Scope and source notation

- Web: `/Users/wikki/Desktop/Accord_project/sandbox/accord_web_quality`, local commits through `e18e382` and subsequent operational-state guard `2a11cfc` inspected. New calculator/WIP/planning files receive no acceptance credit merely for existing on disk.
- Backend reference: `/Users/wikki/Desktop/Accord_project/mini_rs_erp`, revision `fd59167ca005d522a8fb102e18ff4c80a380807e`, strictly read-only.
- Mobile reference: `/Users/wikki/Desktop/Accord_project/accord_mobile_v2`, revision `2b846b295386f62caa8a94b11386f60014ead02c`, strictly read-only.
- `B/`, `M/`, `W/` mean those repository roots. `PM` means `/v1/mobile/admin/production-maps`; `A` means `/v1/mobile/admin`.
- Endpoint descriptions are wire contracts, not authorization to call production. POST report/lookup endpoints below are semantic reads; they must remain distinct from business mutations in any test transport policy.

## Endpoint inventory

| Endpoint | Useful response and time facts | Scope/completeness and permission | Evidence |
| --- | --- | --- | --- |
| `GET PM/sequence` | Maps, canonical sequences, `queue_states`, `stage_states`, `queue_action_controls`, `order_statuses`, `order_controls`, `epoch`, `rev`, `scope`. Controls have `stage_node_id`, `last_worked_at_unix`, optional preflight/freeze/active-cut-roll markers | Current projection, not chronological history. Any admin/map/queue-read/raw-assign/qolip/preparation read capability; worker/scoped forms differ. No historical-state duration is supplied | `B/src/http/handlers/admin/production_maps_parts/part_02.rs:21,126`; `B/src/core/production_map/queue/types.rs:125`; `W/src/lib/api.ts:285` |
| `GET PM?id=<order>` | `{map,program}`; canonical graph order, node/apparatus/alternative identity and calculation context | No order-created/released timestamp or general execution-history collection in the map DTO. Route shares broad map read guard | `B/src/http/handlers/admin/production_maps_parts/part_01.rs:185,209`; `B/src/core/production_map/catalog/definition.rs:9,53` |
| `GET PM/closed-orders` | `{ok,closed_orders}`; each row has order identity, `completed_at_unix`, closer, optional early close, chronological `logs`, `progress_batches` | Latest 200 qualifying terminal orders, no cursor/offset/date filter/total. Invalid maps may be skipped. Per retained order, underlying queue logs/batches are fetched without a per-order LIMIT, but response has no completeness attestation. Admin/map-manager/queue-read capability | `B/src/http/handlers/admin/production_maps/completion.rs:529`; `B/src/core/production_map/types/completion.rs:137`; `B/src/core/production_map/catalog/service.rs:93,237,260`; `B/src/db/postgres_production_map/order_query/helpers.rs:77,544` |
| `GET PM/completed-orders` | `{ok,completed_orders:[{apparatus,order_id,completed_at_unix,status,issue_note?}]}` | Latest 200 **actor-scoped stage** history; not whole-order closure or all apparatus output. It has no start, session, batch or stage-node history. Same read capabilities as closed feed | `B/src/http/handlers/admin/production_maps/completion.rs:379`; `B/src/core/production_map/queue/service.rs:296`; `B/src/core/production_map/queue/types.rs:237` |
| `GET PM/wip-batches?order_id&apparatus&next_apparatus&current_location&status&limit` | `{batches}` (no ok field); output identity, session, apparent start/end, quantities, current waiting/in-use/processed status, used/processed session and lineage payload | Bounded snapshot, default 100, effective native maximum 500; `status=all` includes processed. Mobile helper clamp1000 does not change native service/store cap500. No cursor or returned total. Admin/map/queue-read; nonmanager order scope enforced. Missing output history cannot be inferred absent | `B/src/http/handlers/admin/production_maps/wip.rs:39,52,124`; `B/src/core/production_map/wip/service.rs:335`; `B/src/db/postgres_production_map/wip/query_helpers.rs:63`; `M/lib/src/core/api/admin/mobile_api_admin_order_lifecycle_MobileApiAdminOrderLifecycle_methods_01.dart:5` |
| `POST PM/progress-qr/report {progress_batch_id}` or `{qr_payload}` | `{ok,scanned_batch,current_batch,current_batches,history_scope,lineage_complete,lineage_edges,session_resources,is_stale,stale_reason,order,order_status,queue_states,logs,corrections,progress_batches,run_sessions,active_sessions,opened_by}` | Read-only report, one **batch_lineage**. Batches/sessions/corrections are pruned to verified lineage; logs are pruned to report IDs and linked transfer/freeze facts. No claim of full order or pause/resume chronology. Training report explicitly marks lineage incomplete. Admin/map/queue-read/queue-manage capability | `B/src/http/handlers/admin/production_maps/progress_qr.rs:186`; `B/src/core/production_map/wip/service.rs:13,86,95,165`; `M/lib/src/core/api/admin/mobile_api_admin_progress_qr_declarations_part_02.dart:240,281` |
| `POST PM/progress-qr/lookup` | Exact batch, resolved route and current eligibility; input accepts batch ID or QR, optional order/apparatus context | Lookup/route validation, not an execution-history feed. Do not interpret `active_order_validated` as measured work | `B/src/http/handlers/admin/production_maps/progress_qr.rs:5,23`; `W/src/lib/wip-admin.ts:342` |
| `GET PM/progress-qr/history?worker_ref&limit` | `{ok,batches}` | Latest worker batches, default 50/max 200, no cursor/order/date history query. Actual admin principal must supply worker refs; nonadmin uses its own ref. Mobile call without worker_ref is not an admin-wide history implementation | `B/src/http/handlers/admin/production_maps/progress_qr.rs:264,272,447`; `M/lib/src/core/api/admin/mobile_api_admin_progress_qr_declarations_part_04.dart:182` |
| `GET A/workers/profile-detail?id=<worker>` | Worker/groups/apparatus, `active_sessions`, `recent_batches`, `recent_logs` | Active sessions <=50, recent batches <=50, logs <=100; independent limits, no cursor/completeness flag. Canonical worker/alias refs, not name equality. Strict admin.access | `B/src/http/handlers/admin/workers_profiles.rs:1,52`; `B/src/http/handlers/admin/workers.rs:63` |
| `GET A/raw-material-assignments/lookup?barcode=<roll>` | Raw stock/assignment/order, order queue states and `logs` when linked | Assignment-specific read; unlinked roll has empty order/logs. Underlying order logs fetch_all, but this is not an order-history endpoint and cannot discover every order or output. Its guard/scope is the raw lookup contract | `B/src/http/handlers/admin/production_maps/raw_materials_history.rs:167,216,240`; `B/src/core/production_map/queue/service.rs:311` |
| `GET A/raw-material-history?warehouse&event_type&limit` | Raw barcode/material/custody events with `occurred_at_unix` and `recorded_at_unix`, order/apparatus context, quantity delta and before/after stock status | Latest warehouse events, default 50/max 200; no barcode/order filter, cursor or total. Admin/catalog-read/raw-assign; material provider owner/warehouse scope. Local barcode filtering is still a bounded sample | `B/src/http/handlers/admin/production_maps/raw_materials_history.rs:1,59`; `B/src/db/postgres_raw_material_events.rs:36,81` |
| `GET PM/rezka-output-report?apparatus&order_id` | Current active cut cycle ID, recorded frames, batch/QR IDs and per-roll input report facts | Active, unfrozen cut session only; current cycle, not historic cut durations. Version/scope conflicts fail the read. Bootstrap capability/actor scope | `B/src/http/handlers/admin/production_maps/rezka_output_report.rs:43,103`; `B/src/core/production_map/queue/rezka_output_report.rs:24` |
| `GET PM/replay?apparatus&from_rev&to_rev` | `{ok,events,epoch}`; revision operations with `created_at`, event type, version and delta ops | Synchronization deltas, not the queue-action log ledger. Postgres limit 200 for revision range, no has_more. Epoch/revision resets and omitted ranges prevent a full lifetime timeline claim | `B/src/http/handlers/admin/production_maps_parts/part_02.rs:205,228`; `B/src/db/postgres_production_map.rs:326` |
| `GET PM/capacity` | `{ok,capacity:[...]}` canonical capacity configuration/provenance; slots, setup/cleanup, efficiency and working-window configuration | Handler returns configuration only, not downtime/reservation history. The older internal ApparatusCapacitySnapshot DTO is not the GET response. POST/PUT downtime and schedule POST return individual write receipts with start/end times, but no public history/preview GET is provided here. Planned configuration is not measured run time/utilization; do not derive historical calendar loss from this GET. Admin/map/queue-read guard | `B/src/http/handlers/admin/production_maps_parts/part_01.rs:27,44,100,128`; `B/src/core/production_map/capacity/mod.rs:72,138` |
| `GET A/apparatus`, `GET A/apparatus/{id}` | Canonical runtime projection, `execution_profile.operation`, technology, revision, lifecycle, display | Operation classification for print/laminate/cut must use canonical metadata, not title/color/factory-map geometry. Current catalog revision is not a historical equipment-profile snapshot | `B/src/http/handlers/admin/system/apparatus.rs:56,94`; `W/src/lib/factory-map.ts:32` |
| `GET PM/audit` | `{ok,checked_order_count,checked_batch_count,checked_session_count,violations}` | Workflow consistency diagnostics; **not a timestamped execution audit trail**. Admin/map manage capability | `B/src/http/handlers/admin/production_maps_parts/part_01.rs:2`; `B/src/core/production_map/types/audit.rs:4` |

## Timestamp meaning and traps

| Source field | Authoritative meaning | Duration use / unknowns | Evidence |
| --- | --- | --- | --- |
| Queue log `created_at_unix` | Persisted transition/report event time, in Unix seconds; SQL extracts TIMESTAMPTZ epoch | Strongest public chronology for queue states. Same-second precision/ties, inconsistent chains and legacy missing stage IDs must remain explicit. Original query order uses created_at + DB id; closed response later sorts seconds + semantic rank + event_id | `B/src/core/production_map/types/completion.rs:113`; `B/src/db/postgres_production_map/order_query/helpers.rs:89`; `B/src/core/production_map/catalog/service.rs:237,664` |
| Session `started_at_unix`, `updated_at_unix` | Session creation and latest update; session ID and stage-node identity are separate | Resume can keep original start and change latest update/worker. `updated-start` is an envelope including gaps, not productive work or a distinct resume interval | `B/src/core/production_map/progress_session/progress.rs:267`; `B/src/core/production_map/progress_session/service_progress.rs:705,1419,1644` |
| Batch `started_at_unix`, `completed_at_unix` | Native batch record initially inherits session start/update. Postgres readers coalesce **current session** start/update, falling back to batch creation/update | Not immutable per-roll begin/end. Sibling cut frames and repeated output records can share/overlap a session envelope. Resume or WIP updates can move apparent end; never sum these into processing hours | `B/src/core/production_map/progress_session/service_progress_support.rs:516,531`; `B/src/db/postgres_production_map/order_query/helpers.rs:557`; `B/src/db/postgres_production_map/wip/query_helpers.rs:75` |
| `last_worked_at_unix` | Maximum session start/update for the apparatus + stage, from the loaded persisted sessions | Label **Last persisted activity**, not last sensor movement, work start, or time entered current state. Zero means unknown. A current state plus this marker alone cannot measure that state's age | `B/src/core/production_map/queue/types.rs:130`; `B/src/core/production_map/queue/service.rs:1347` |
| `stage_work_report.submitted_at_unix`, report sequence/ID | Explicit completed-session report submission; retry/edit does not stamp a new report winner | Useful report/end marker; report submission can differ from physical finish. StageWorkStatus has latest report time internally, but StageWorkControl in sequence does not expose a full report history or duration | `B/src/core/production_map/stage_execution.rs:36,50,73,85,351` |
| Freeze/early close requested/transition/closed times | Administrative request and worker/order transition markers | Freeze requested is not frozen; current request is not an append-only record of all freezes. Synthetic closed freeze entries may have no stage ID; keep them separate from machine work transitions | `B/src/core/production_map/types/control.rs:72,85,93`; `B/src/core/production_map/catalog/service.rs:687` |
| Print-preflight `created/updated/expires_at_unix` | Persisted color-trial hold lifecycle | Show hold markers or a clearly named known hold age. `is_live_at` uses status, not expiry; don't manufacture automatic expiry. Preflight is not productive production time | `B/src/core/production_map/print_preflight.rs:50,67` |
| Active cut partial-roll `started/updated_at_unix` | Current slot/generation's persisted partial-roll markers | Current roll age only with exact slot+generation+input lineage and live state; not full cutting duration across generations, pauses or siblings | `B/src/core/production_map/progress_session/progress.rs:172`; `B/src/core/production_map/queue/types.rs:144` |
| `input_lineage[].linked_at_unix`, optional `processed_at_unix` | Actual input attachment and processing disposition for a specific session/input link | When both are present, same link and chronological, a **mounted-to-processed elapsed** interval can be shown. It includes pauses; it does not establish productive cutting/lamination time or upstream waiting | `B/src/core/production_map/progress_session/progress.rs:132`; `B/src/core/production_map/progress_session/service_progress_support.rs:59,880` |
| Batch payload `wip_in_use_at_unix`, `wip_processed_at_unix`, `worker_handoff_at_unix`, `roll_removed_at_unix`, `roll_claimed_after_handoff_at_unix`, `resumed_at_unix` | Persisted named claim/process/handoff/remove/resume markers when supported by that path | Optional and mutable last facts; recovery may clear conflicting markers. They are not a complete WIP-state event log. No universal immutable waiting-arrival timestamp is supplied. QR scoped session payload retains only approved lineage/protocol fields | `B/src/core/production_map/progress_session/service_progress_support.rs:1003,1038,1132,1145,1164,1185,1235`; `B/src/core/production_map/wip/qr_lineage.rs:299` |
| Raw event `occurred_at_unix` versus `recorded_at_unix` | Stock/custody occurrence versus database recording time | Timeline sorts occurrence, shows recording lag separately. Receipt/unreserve/relocation is not a production start/pause/end. Unknown event types retain their actual name | `B/src/db/postgres_raw_material_events.rs:36,117`; `B/src/http/handlers/admin/production_maps/raw_materials.rs:1511` |
| Closed row `completed_at_unix` | Early-close time, final operation report/event-derived closure time, including later relevant close event | Order closure marker, not final roll productive end or source-order creation. Separate early cancellation/close from normally finished cohorts | `B/src/core/production_map/catalog/service.rs:178,191`; `B/src/core/production_map/types/completion.rs:137` |

All `*_unix` fields inspected use integer **seconds** since Unix epoch. Convert to milliseconds once at the display boundary. Rust uses SystemTime/UNIX_EPOCH; Postgres uses EXTRACT(EPOCH) over TIMESTAMPTZ. Preserve UTC instants, display an explicit chosen IANA timezone, and compute elapsed from instants rather than formatted dates. Millisecond business precision is not available in these response fields. Device clock and database/process clock skew have no explicit synchronization contract; no server `now` accompanies sequence. Client as-of timers are observed estimates and must disclose their as-of time. Zero/missing/future/negative chronology is invalid or unknown, never a valid zero duration.

Capacity working-window weekday/minute matching uses UTC OffsetDateTime from the Unix instant; it does not carry a plant-timezone field. Preserve this native planning meaning and label it separately from the timeline display timezone (`B/src/core/production_map/capacity/scheduler.rs:174`).

Evidence: `B/src/core/production_map/progress_session/ids.rs:39`; `B/migrations/postgres/0001_mini_erp_foundation.sql:286,322`; `B/src/db/postgres_production_map/order_query/helpers.rs:94,356`.

## State and stage identity

Queue states are `pending`, `print_preflight`, `in_progress`, `paused`, `frozen`, `completed`. Session states are `active`, `paused`, `frozen`, `roll_detached`, `completed`. WIP states are `waiting`, `in_use`, `processed`; output report status and order lifecycle are additional contracts. A roll can be waiting while its order still has active work elsewhere. `active_sessions` in a QR report also includes paused and detached sessions; it is not an active-machine count.

Queue action types are `start`, `pause`, `freeze`, `detach_roll`, `resume`, `merge`, `roll_complete`, `complete`. Prefer the returned `from_state`/`to_state` to the action name. `roll_complete` and `merge` can leave queue state in_progress; `detach_roll` uses paused queue transport while the session becomes roll_detached. A partial-cycle complete/requeue does not close an entire repeated/alternative operation. Synthetic transfer/freeze records in closed history are context markers and must not be blindly applied as stage transitions.

Sources: `B/src/core/production_map/queue/state.rs:7,58,128`; `B/src/core/production_map/progress_session/progress_parts/statuses.rs:11,53,102`; `B/src/core/production_map/wip/service.rs:155`; `B/src/core/production_map/progress_session/closed_orders.rs:43,63`.

Use these identities:

- Order: persisted map/order ID. Never group a pending ID or template ID with a production order by title.
- Operation occurrence: `order_id + stage_node_id`, with the saved map's alternative-group identity when grouping alternative participants. A repeated use of one apparatus is a separate stage occurrence.
- Machine lane: canonical `apparatus`/`apparatus_id`, joined to operation occurrence. Transfer creates separate lanes; it does not rename the source history to the new machine.
- Session: exact `session_id`. Output/roll: exact `batch_id` plus revision, and slot/generation for an active cut partial roll. Multi-input and split-output lineage is many-to-many; there is no measured per-input quantity allocation at merge.
- Modern stage-less historical events may only be attributed to a stage when the source map proves one unique compatible occurrence. Otherwise display an unassigned history lane and exclude the event from stage metrics.
- Stable `task:` graph IDs are valid non-apparatus topology identities, not proof of canonical machine work. Persisted native queue-log decoding requires canonical apparatus IDs. Keep task facts as unmeasured markers unless their own explicit timed transition contract is present (`B/src/core/production_map/progress_session/progress.rs:25,113`; `B/src/db/postgres_production_map/progress/helpers.rs:806`).

Sources: `B/src/core/production_map/catalog/definition.rs:53`; `B/src/core/production_map/progress_session/closed_orders.rs:63,98`; `B/src/core/production_map/progress_session/progress.rs:128,172,197`; `B/src/core/production_map/types/completion.rs:113`.

Printing/lamination/cutting labels should join canonical apparatus runtime `execution_profile.operation` (`print`, `laminate`, `cut`) to the saved stage, retain the stage title for display, and record that classification is from the available metadata revision. Do not force every order into three stages, flatten alternatives, or relabel historical events from a machine title alone. If historical operation metadata is absent/ambiguous, keep the lane as an identified apparatus/stage with operation unknown.

## Sample response shapes

These are type shapes, not actual observations or manufactured timing fixtures. `UnixSeconds` is an integer number; strings and arrays are represented by their types. Optional fields are genuinely optional.

```ts
type UnixSeconds = number
type QueueState = 'pending' | 'print_preflight' | 'in_progress' | 'paused' | 'frozen' | 'completed'
type QueueLog = {
  event_id: string; order_id: string; apparatus: string; stage_node_id?: string
  action: 'start' | 'pause' | 'freeze' | 'detach_roll' | 'resume' | 'merge' | 'roll_complete' | 'complete'
  from_state: QueueState; to_state: QueueState; created_at_unix: UnixSeconds
  actor_role: string; actor_ref: string; actor_display_name: string
  completed_with_issue: boolean; issue_note?: string; transfer?: object; freeze?: object
}
type Session = {
  session_id: string; order_id: string; apparatus: string; stage_node_id?: string
  status: 'active' | 'paused' | 'frozen' | 'roll_detached' | 'completed'
  started_at_unix: UnixSeconds; updated_at_unix: UnixSeconds
  worker_role: string; worker_ref: string; worker_display_name: string; payload_json: object
}
type Batch = {
  batch_id: string; revision: number; session_id: string; order_id: string; apparatus: string
  started_at_unix: UnixSeconds; completed_at_unix: UnixSeconds // mutable session-derived envelope
  action: string; status: string; wip_status: 'waiting' | 'in_use' | 'processed'
  produced_qty: number; uom: string; qr_payload: string; parent_batch_id?: string
  used_by_session_id?: string; processed_by_session_id?: string; payload_json: object
}
type ClosedResponse = {
  ok: true
  closed_orders: {
    order_id: string; order_number: string; title: string; product_code: string
    completed_at_unix: UnixSeconds; closed_by_role: string; closed_by_ref: string
    closed_by_display_name: string; early_close?: object; logs: QueueLog[]; progress_batches: Batch[]
  }[] // at most 200, no run_sessions/cursor/total in this response
}
type RollReportResponse = {
  ok: true; history_scope: 'batch_lineage'; lineage_complete: boolean
  scanned_batch: Batch; current_batch: Batch | null; current_batches: Batch[]
  lineage_edges: { parent_batch_id: string; child_batch_id: string }[]
  logs: QueueLog[]; run_sessions: Session[]; active_sessions: Session[]
  progress_batches: Batch[]; corrections: object[]; session_resources: object[]
  is_stale: boolean; stale_reason: string; order?: object; order_status: object; queue_states: object
}
```

The exact native DTOs include additional quantity/resource fields. A decoder must preserve unknown optional metadata, reject mismatched order/identity/nonfinite timestamps, and keep coverage metadata separate from business statuses. Sources: `B/src/core/production_map/types/completion.rs:113,137`; `B/src/core/production_map/progress_session/progress.rs:267,403,672`.

## Defensible metrics and calculation rules

| Metric / label | Rule | Required evidence / exclusion |
| --- | --- | --- |
| Observed stage span | Last known stage end minus first known stage start within the chosen history/window; ongoing spans have no closed end | Both chronological authoritative boundaries for one occurrence. Call it elapsed; it includes recorded pauses and gaps. No start => unknown, not zero |
| Recorded in-progress elapsed | Form consistent state segments between timestamped queue transitions, intersect with requested window, union intervals within an order-stage-machine lane | Full segment boundaries and state consistency. Last prior to_state must match next from_state; missing/tied contradictory events make the interval unknown. Explicitly **not productive time** |
| Recorded paused/frozen elapsed | Same segment method for those known states | Don't derive from session total, final status or order freeze requested. Order-wide administrative freeze without stage attribution stays a separate overlay |
| Recorded pending/preflight elapsed | Same method only after a known event/hold entered that state | Initial queue waiting before first observed transition has no universal start. Preflight hold age is distinct from queue/machine production time |
| Last persisted activity / current known state | Display timestamp and current native state; optional age is `asOf - last_worked_at_unix` | Age describes last record, not state age or idle machine time. If missing, show unknown; stale/offline label and stop growth at last observation |
| Ongoing observed interval | Last unambiguous entered-state event to displayed asOf while a fresh matching snapshot agrees | Clock/skew caveat, open-ended marker, no completed classification. Do not infer an onset from last_worked_at or batch timestamps; conflicting current state => unknown tail |
| Mounted-to-processed input elapsed | `processed_at_unix - linked_at_unix` for one exact input link | Both valid monotonic markers and exact input/session/stage scope. Includes pause/handoff; optional, not a general stage metric |
| Interstage lag | Downstream exact input claim/start minus an independently timestamped upstream report/output fact | Verified lineage and immutable compatible boundaries. Batch completed_at alone is insufficient; overlapping stages may legitimately have negative stage-envelope differences. Never clamp these into a fabricated zero wait |
| Parallel stage elapsed / apparatus exposure | Union same-lane overlaps; show independent machine lanes. For an operation group, wall elapsed uses union/span; summed lane elapsed is separately named apparatus exposure | Deduplicate event/session/batch IDs. Sibling outputs share work; no duration per roll allocation. Do not claim summed parallel hours equal order lead time |
| Executive bottleneck candidates | Rank **loaded, comparable observed** stage spans/paused intervals; drill down to source events, machines and coverage | Explicit retained cohort, eligible/excluded count, sample size, ongoing versus closed split, unit/technology context. Long elapsed suggests a candidate; it does not prove causal bottleneck/capacity loss |
| Current backlog | Count distinct currently returned pending orders/eligible waiting WIP per canonical next stage/apparatus | Snapshot/cap/actor scope disclosed. Different units, orders and rolls are separate counts. No waiting age, throughput or completion ETA without supported facts |
| Productive time, OEE, utilization, true downtime loss, all-time mean | **Unknown / not defensible from this contract** | No machine on/off telemetry, reason-resolved complete state history, full calendar population or exhaustive production cohort. Planned efficiency is configuration, not measured efficiency |

Normalize intervals to half-open `[start,end)` and intersect with the selected range before summing. Build segments from actual state transitions rather than alternating action names. Preserve missing spans as unknown, use union to prevent double counting, and publish coverage alongside every aggregate. Same-second event ties cannot invent subsecond work; present simultaneous markers and avoid an inferred physical order when states conflict. Early-close/cancelled/issue cohorts must be labeled and separable.

## History ruler and executive acceptance

1. Timeline and ruler share one UTC domain and timezone label; zoom/filter only changes the visible domain. Missing intervals are visually distinct from zero, idle or completion. A timestamped event marker can appear even when a duration cannot be calculated.
2. Printing/lamination/cutting lanes use real route occurrences and canonical apparatus. Repeated stages, transfers, alternative apparatus and split/merge rolls retain separate identities. Unassigned legacy history stays visible without contributing to stage totals.
3. Executive cards say **Observed elapsed** / **Recorded state elapsed**, show loaded history coverage and unknown/excluded counts, and drill into the exact source logs. No decorative progress ratio or production estimate is introduced from missing data.
4. A partial feed, exactly-200 closed cohort, exactly-500 WIP snapshot, incomplete lineage, worker-scoped history or failed refresh remains explicitly partial/limited. Fewer-than-cap records do not certify all physical history; no all-time/date-complete claim from these feeds.
5. Ongoing/stale/offline facts are separate. Current snapshot without a timestamped origin shows a state marker rather than a manufactured duration. No unknown field or server error becomes a numerical zero.
6. Preserve the existing theme palette. No decorative gradients or garish multicolor additions; use existing semantic colors only for functional status/selection. The user's six reference PNGs under `W/docs/qa/reference-inputs` guide layout, not data semantics or new color choices.
7. Read-only history/report interactions cannot send business writes. All fixtures remain isolated from production. No backend/mobile API/schema modification is part of this work.

Required controlled fixtures: pause/resume repeated within one session; several cut outputs sharing a session; repeated apparatus stage; parallel alternatives; transfer and stage-less synthetic freeze; incomplete lineage; same-second contradictory events; missing/zero/future timestamps; reverse chronology; early close without production; retained 200-order limit; current state without onset; stale snapshot; timezone/DST display; unknown operation profile; failed refresh and account switch. Verify no doubled duration and no productive-time claim in each case.

## Audit limits and implementation readiness

This review inspected native DTOs, handlers, persistence queries, session mutation semantics and mobile consumers. It did not execute live reads, produce factory metrics or test a timeline implementation. The existing mobile closed-log detail associates batches heuristically by action/apparatus and timestamp distance (`M/lib/src/features/admin/presentation/admin_production_map_orders_closed_log_sheet.dart:22`); that display heuristic is not authoritative event-to-roll attribution for executive timing.

A first web implementation can use the retained closed-order event timeline plus current markers and explicit roll drilldown. Complete ongoing-order stage duration, complete queue waiting, physical productivity and exhaustive executive history remain unknown unless the existing returned records supply unambiguous boundaries and coverage. Missing API capability is documented, not an instruction to change the independent backend.

Read-only report integration rule: whitelist only `POST /v1/mobile/admin/production-maps/progress-qr/report` with selected `{progress_batch_id}` or `{qr_payload}` where a QA transport needs semantic POST reads. The report branch accepts but does not validate optional order/apparatus request context; validate returned scanned_batch.batch_id/order_id against the selected entity. Scope query keys/cancellation to session/server/order/batch, discard late old-scope results, and disclose that the report carries no atomic snapshot revision/epoch. Print/reprint/correct endpoints are separate mutations and do not inherit a read whitelist (`B/src/http/handlers/admin/production_maps/progress_qr.rs:7,186`).

Native PUT transport limit: app-level retry=false/singleflight does not guarantee a browser sends a PUT once. The integration owner's isolated Chromium fixture destroyed the socket before response headers and observed an HTTP-level retransmission. The original fixture evidence is `W/docs/qa/synthetic-browser/2026-10-13T17-29-12-469Z/results.json`. This is not a production observation or permission to change the backend; native PUT handlers without CAS/idempotency cannot be described as transport-replay-proof. Later truncated-after-headers fixtures can verify application GET recovery separately.

Local document verification: all cited source/artifact paths and starting line numbers existed; whitespace check passed. Backend/mobile Git status was clean at the initial source-audit checkpoint. The user subsequently confirmed doing mobile printer work in parallel; those nine modified mobile paths were preserved without edits by this web task. Mobile source evidence remains tied to the audited `2b846b295386f62caa8a94b11386f60014ead02c` baseline. No manufacturing metric or live-service test was performed.
