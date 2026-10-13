import { describe, expect, it } from 'vitest'
import type { ProductionSnapshot, Row } from './api-types'
import { buildManufacturingTimeline, manufacturingDurationLabel, manufacturingEventPosition, manufacturingOverview, manufacturingTimeLabel, manufacturingUnionSeconds, manufacturingUnix, manufacturingZoomWindow } from './manufacturing-time'

const orderId = 'zakaz-time-fixture', apparatus = 'apparatus:print:fixture', base = 1_800_000_000
function log(id: string, offset: number, action: string, from: string, to: string, patch: Row = {}): Row {
  return { event_id: id, order_id: orderId, apparatus, stage_node_id: 'print-stage', action, from_state: from, to_state: to,
    actor_display_name: 'Fixture operator', created_at_unix: base + offset, ...patch }
}
function closed(logs: Row[], patch: Row = {}): Row {
  return { order_id: orderId, order_number: 'F-100', title: 'Fixture film', completed_at_unix: base + 500, logs, progress_batches: [], ...patch }
}
function timeline(logs: Row[], patch: Row = {}) {
  return buildManufacturingTimeline({ orderId, closedOrder: closed(logs, patch), asOfUnix: base + 1000 })
}
function snapshot(patch: Partial<ProductionSnapshot> = {}): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'fixture-epoch', scope: 'admin', maps: [{ map: { id: orderId, title: 'Fixture live order', product_code: 'film',
    nodes: [{ id: 'print-stage', kind: 'apparatus', title: 'Bosma', apparatus_id: apparatus }], edges: [] }, program: {} }],
    order_statuses: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {}, ...patch }
}
const logs = () => [
  log('start', 0, 'start', 'pending', 'in_progress'),
  log('pause', 100, 'pause', 'in_progress', 'paused'),
  log('resume', 150, 'resume', 'paused', 'in_progress'),
  log('report-pending', 250, 'complete', 'in_progress', 'pending'),
  log('next-start', 300, 'start', 'pending', 'in_progress'),
  log('complete', 400, 'complete', 'in_progress', 'completed'),
]

describe('manufacturing time native evidence', () => {
  it('uses actual from/to states and never treats complete action as an unconditional terminal state', () => {
    const result = timeline(logs())
    expect(result.source).toBe('closed_order')
    expect(result.stages[0]).toMatchObject({ inProgressSeconds: 300, pausedSeconds: 50, recordedSeconds: 400 })
    expect(result.stages[0].intervals.map(interval => interval.state)).toEqual(['in_progress', 'paused', 'in_progress', 'pending', 'in_progress'])
    expect(result.observedWindowSeconds).toBe(500)
    expect(result.stages[0].intervals.at(-1)?.endUnix).toBe(base + 400)
    expect(result.coverage).toMatchObject({ measuredStageCount: 1, gapCount: 0 })
  })

  it('does not sum mutable session/batch timestamps or overlapping sibling outputs', () => {
    const result = timeline(logs(), { progress_batches: [1, 2, 3].map(number => ({ batch_id: `batch-${number}`, order_id: orderId, apparatus, session_id: 'same-session',
      started_at_unix: base - 1000, completed_at_unix: base + 999, payload_json: { stage_node_id: 'print-stage' } })) })
    expect(result.stages[0]).toMatchObject({ inProgressSeconds: 300, recordedSeconds: 400 })
    expect(result.events.filter(event => event.kind === 'batch_marker')).toHaveLength(0)
    expect(result.window?.startUnix).toBe(base)
  })

  it('keeps a complete roll lineage unmeasured because report logs are not full order transitions', () => {
    const report: Row = { ok: true, history_scope: 'batch_lineage', lineage_complete: true, scanned_batch: { order_id: orderId }, logs: logs(),
      run_sessions: [{ session_id: 'session-1', order_id: orderId, apparatus, stage_node_id: 'print-stage', status: 'completed',
        started_at_unix: base, updated_at_unix: base + 600, payload_json: { stage_work_report: { report_id: 'report-1', submitted_at_unix: base + 400 } } }], active_sessions: [], progress_batches: [] }
    const result = buildManufacturingTimeline({ orderId, report, asOfUnix: base + 1000 })
    expect(result.coverage.lineageComplete).toBe(true)
    expect(result.stages[0]).toMatchObject({ inProgressSeconds: null, pausedSeconds: null, recordedSeconds: null, intervals: [] })
    expect(result.events.find(event => event.kind === 'session_update')?.atUnix).toBe(base + 600)
    expect(result.events.find(event => event.kind === 'work_report')?.atUnix).toBe(base + 400)
    expect(result.coverage.issues.some(issue => issue.includes('barcha holat almashishlari'))).toBe(true)
  })

  it('shows exact persisted batch markers without inventing WIP waiting arrival or elapsed time', () => {
    const result = timeline([], { progress_batches: [{ batch_id: 'roll-1', order_id: orderId, apparatus, session_id: 'session-1',
      started_at_unix: base - 500, completed_at_unix: base + 600, payload_json: { stage_node_id: 'print-stage', wip_in_use_at_unix: base + 10, wip_processed_at_unix: base + 90, worker_handoff_at_unix: base + 100 } }] })
    expect(result.events.filter(event => event.kind === 'batch_marker').map(event => event.atUnix)).toEqual([base + 10, base + 90, base + 100])
    expect(result.stages[0].recordedSeconds).toBeNull()
    expect(result.window?.startUnix).toBe(base + 10)
  })

  it('does not turn current state or last_worked into state-entry time, even when data is fresh', () => {
    const live = snapshot({ stage_states: { [orderId]: { 'print-stage': 'in_progress' } }, queue_states: { [apparatus]: { [orderId]: 'in_progress' } },
      queue_action_controls: { [apparatus]: { [orderId]: { stage_node_id: 'print-stage', state: 'in_progress', last_worked_at_unix: base + 100 } } } })
    const result = buildManufacturingTimeline({ orderId, snapshot: live, asOfUnix: base + 1000 })
    expect(result).toMatchObject({ source: 'snapshot_only', observedWindowSeconds: null })
    expect(result.stages[0]).toMatchObject({ currentState: 'in_progress', lastActivityAtUnix: base + 100, inProgressSeconds: null, intervals: [] })
    expect(result.events[0].label).toBe('Oxirgi saqlangan faollik')
  })

  it('keeps a state mismatch as a visible gap and never bridges it', () => {
    const result = timeline([log('start', 0, 'start', 'pending', 'in_progress'), log('resume', 100, 'resume', 'paused', 'in_progress'), log('end', 200, 'complete', 'in_progress', 'completed')])
    expect(result.stages[0]).toMatchObject({ inProgressSeconds: 100, gaps: [{ startUnix: base, endUnix: base + 100, reason: 'inconsistent' }] })
    expect(result.coverage.gapCount).toBe(1)
  })

  it('does not assign stage-less transitions to repeated physical apparatus or bridge across them', () => {
    const result = buildManufacturingTimeline({ orderId, closedOrder: closed([
      log('start', 0, 'start', 'pending', 'in_progress'), log('unattributed-pause', 100, 'pause', 'in_progress', 'paused', { stage_node_id: '' }),
      log('complete', 200, 'complete', 'in_progress', 'completed'),
    ]), snapshot: snapshot({ maps: [{ map: { id: orderId, title: 'Repeated machine', nodes: [
      { id: 'print-stage', kind: 'apparatus', apparatus_id: apparatus, title: 'First' }, { id: 'print-again', kind: 'apparatus', apparatus_id: apparatus, title: 'Second' },
    ], edges: [{ from: 'print-stage', to: 'print-again' }] }, program: {} }] }), asOfUnix: base + 1000 })
    expect(result.coverage.unattributedEvents).toBe(1)
    expect(result.stages.every(stage => stage.inProgressSeconds === null)).toBe(true)
    expect(result.stages[0].gaps[0].reason).toBe('unattributed')
    expect(result.events.find(event => event.id === 'queue:unattributed-pause')?.stageKey).toBeNull()
  })

  it('keeps synthetic transfer/freeze state fields out of elapsed calculations', () => {
    const result = timeline([
      log('start', 0, 'start', 'pending', 'in_progress'),
      log('freeze-audit', 100, 'freeze', 'in_progress', 'frozen', { stage_node_id: '', freeze: { request_id: 'freeze-1', status: 'frozen' } }),
      log('transfer-audit', 150, 'pause', 'paused', 'paused', { stage_node_id: 'print-stage', transfer: { transfer_id: 'transfer-1' } }),
      log('end', 200, 'complete', 'in_progress', 'completed'),
    ])
    expect(result.stages[0].inProgressSeconds).toBeNull()
    expect(result.stages[0].gaps[0].reason).toBe('unattributed')
    expect(result.events.filter(event => ['freeze', 'transfer'].includes(event.kind)).every(event => !event.transition)).toBe(true)
  })

  it('preserves response ties and refuses positive intervals adjacent to ambiguous seconds', () => {
    const result = timeline([
      log('start', 0, 'start', 'pending', 'in_progress'), log('z-pause', 100, 'pause', 'in_progress', 'paused'),
      log('a-resume', 100, 'resume', 'paused', 'in_progress'), log('end', 200, 'complete', 'in_progress', 'completed'),
    ])
    expect(result.events.filter(event => event.atUnix === base + 100).map(event => event.id)).toEqual(['queue:z-pause', 'queue:a-resume'])
    expect(result.stages[0].inProgressSeconds).toBeNull()
    expect(result.coverage.gapCount).toBe(2)
    expect(result.stages[0].gaps.every(gap => gap.reason === 'same_second')).toBe(true)
  })

  it('deduplicates identical events and fails closed for conflicting event identity', () => {
    const clean = timeline([...logs(), logs()[0]])
    expect(clean.coverage.duplicateRecords).toBe(1)
    expect(clean.stages[0].inProgressSeconds).toBe(300)
    const conflict = timeline([...logs(), log('pause', 101, 'pause', 'in_progress', 'paused')])
    expect(conflict.coverage.conflictingRecords).toBe(1)
    expect(conflict.stages[0].recordedSeconds).toBeNull()
    expect(conflict.stages[0].gaps.every(gap => gap.reason === 'conflict')).toBe(true)
  })

  it('excludes foreign orders, invalid/future timestamps, and unknown states from measurements', () => {
    const result = timeline([
      log('start', 0, 'start', 'pending', 'in_progress'), log('unknown', 100, 'future_action', 'in_progress', 'new_state'),
      log('end', 200, 'complete', 'in_progress', 'completed'), log('foreign', 20, 'pause', 'in_progress', 'paused', { order_id: 'another-order' }),
      log('invalid', 30, 'pause', 'in_progress', 'paused', { created_at_unix: '1800000030' }), log('future', 1001, 'pause', 'in_progress', 'paused'),
    ])
    expect(result.coverage.discardedRecords).toBe(3)
    expect(result.stages[0].recordedSeconds).toBeNull()
    expect(result.events.some(event => event.id === 'queue:foreign')).toBe(false)
    expect(result.events.find(event => event.id === 'queue:unknown')?.transition).toBe(false)
  })

  it('keeps task station facts unmeasured instead of assigning them to a machine', () => {
    const result = timeline([log('task-start', 0, 'start', 'pending', 'in_progress', { apparatus: 'task:prepare', stage_node_id: 'task:prepare' }),
      log('task-end', 100, 'complete', 'in_progress', 'completed', { apparatus: 'task:prepare', stage_node_id: 'task:prepare' })])
    expect(result.stages).toHaveLength(0)
    expect(result.coverage.unattributedEvents).toBe(2)
  })

  it('rejects a report for another order and does not leak its title or event rows', () => {
    const result = buildManufacturingTimeline({ orderId, report: { ok: true, history_scope: 'batch_lineage', scanned_batch: { order_id: 'other-order' }, order: { id: 'other-order', title: 'Other title' }, logs: logs() }, asOfUnix: base + 1000 })
    expect(result).toMatchObject({ source: 'unavailable', title: orderId, events: [], stages: [] })
  })

  it('requires the native report success envelope and exact optional map identity', () => {
    const result = buildManufacturingTimeline({ orderId, report: { history_scope: 'batch_lineage', scanned_batch: { order_id: orderId }, logs: logs() },
      map: { id: 'another-order', title: 'Foreign map', nodes: [] }, asOfUnix: base + 1000 })
    expect(result).toMatchObject({ source: 'unavailable', title: orderId, stages: [] })
    const contextual = buildManufacturingTimeline({ orderId, closedOrder: closed(logs()), map: snapshot().maps[0].map, asOfUnix: base + 1000 })
    expect(contextual.stages[0].title).toBe('Bosma')
    expect(contextual.stages[0].currentState).toBeNull()
  })

  it('does not erase a malformed timestamp boundary and bridge across it', () => {
    const result = timeline([log('start', 0, 'start', 'pending', 'in_progress'),
      log('lost-time', 100, 'pause', 'in_progress', 'paused', { created_at_unix: null }), log('complete', 200, 'complete', 'in_progress', 'completed')])
    expect(result.stages[0].inProgressSeconds).toBeNull()
    expect(result.coverage.discardedRecords).toBe(1)
    expect(result.stages[0].gaps[0].reason).toBe('inconsistent')
  })
})

describe('time presentation and bounded cohort', () => {
  it('unions overlapping observations and keeps unavailable data distinct from zero', () => {
    expect(manufacturingUnionSeconds([{ startUnix: base, endUnix: base + 100 }, { startUnix: base + 50, endUnix: base + 150 }, { startUnix: base + 200, endUnix: base + 250 }])).toBe(200)
    expect(manufacturingUnionSeconds([{ startUnix: base, endUnix: base }, { startUnix: base + 1, endUnix: base }])).toBeNull()
    expect(manufacturingDurationLabel(null)).toBe('—')
    expect(manufacturingDurationLabel(0)).toBe('0 son')
    expect(manufacturingDurationLabel(3661)).toBe('1 soat 1 daq')
    for (const invalid of [0, -1, NaN, Infinity, 1.5, '1800000000']) expect(manufacturingUnix(invalid)).toBeNull()
    expect(manufacturingTimeLabel(base, 'UTC')).toContain('08:00:00')
    expect(manufacturingTimeLabel(null, 'UTC')).toBe('—')
  })

  it('ranks only the unique loaded retained cohort and reports eligibility/exclusions', () => {
    const measured = timeline(logs()), noHistory = buildManufacturingTimeline({ orderId: 'zakaz-empty', closedOrder: closed([], { order_id: 'zakaz-empty' }), asOfUnix: base + 1000 })
    const lineage = buildManufacturingTimeline({ orderId, report: { ok: true, history_scope: 'batch_lineage', scanned_batch: { order_id: orderId }, logs: logs() }, asOfUnix: base + 1000 })
    const overview = manufacturingOverview([measured, measured, noHistory, lineage])
    expect(overview).toMatchObject({ loadedOrders: 2, eligibleOrders: 1, excludedOrders: 1 })
    expect(overview.rankings).toHaveLength(1)
    expect(overview.rankings[0]).toMatchObject({ orderId, inProgressSeconds: 300 })
  })

  it('clamps zoom and positioning to real timestamp extents', () => {
    const extent = { startUnix: base, endUnix: base + 1000 }
    expect(manufacturingZoomWindow(extent, extent, .5, base + 900)).toEqual({ startUnix: base + 500, endUnix: base + 1000 })
    expect(manufacturingZoomWindow({ startUnix: base, endUnix: base + 100 }, extent, 2)).toEqual({ startUnix: base, endUnix: base + 200 })
    expect(manufacturingEventPosition(base - 10, extent)).toBe(0)
    expect(manufacturingEventPosition(base + 500, extent)).toBe(.5)
    expect(manufacturingEventPosition(base + 1, { startUnix: base, endUnix: base })).toBe(.5)
  })

  it('retains the supplied stale observation cutoff and never advances it to the browser clock', () => {
    const result = buildManufacturingTimeline({ orderId, closedOrder: closed(logs()), asOfUnix: base + 500, fresh: false })
    expect(result).toMatchObject({ asOfUnix: base + 500, fresh: false })
    expect(result.stages[0].inProgressSeconds).toBe(300)
  })
})
