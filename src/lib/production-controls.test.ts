import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { ProductionOperationLedger } from './production-operation-ledger'
import { executeProductionCommand, productionControlOrderId, productionOrderCommand, productionOrderControlState, productionOrderPolicy, productionQueueCommand, productionQueuePolicies, productionReorderCommand } from './production-controls'

const orderId = 'zakaz-1048'
const otherId = 'zakaz-1049'
const apparatusId = 'apparatus:default:asset-1'
const version = 'a'.repeat(64)
const session = (capabilities = ['admin.access']): Session => ({ token: 'fixture-token', profile: { role: 'admin', display_name: 'Fixture admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
function interaction(mode = 'in_progress', patch: Row = {}): Row {
  return { mode, start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: true, material_intake_allowed: false, previous_wip_mode: 'not_required', resume_input_required: false, opening_wip_mode: 'not_required', qolip_mode: 'not_required', ...patch }
}
function control(state = 'in_progress', mode = state, allowed = state === 'paused' ? ['resume'] : ['pause'], patch: Row = {}): Row {
  return { state, stage_node_id: 'print', allowed_actions: allowed, previous_stage_ready: true, complete_requires_full_report: false, interaction: interaction(mode), ...patch }
}
function machine(operation = 'print', revision = 4): Row {
  return { apparatus_id: apparatusId, source_revision: revision, display: { display_name: 'Fixture press' }, execution_profile: { operation }, lifecycle: { state: 'active' } }
}
function snapshot(patch: Partial<ProductionSnapshot> = {}): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'fixture-epoch', scope: 'admin', maps: [orderId, otherId].map(id => ({ map: { id, title: id, nodes: [{ id: 'print', kind: 'apparatus', title: 'Bosma', apparatus_id: apparatusId }], edges: [] }, program: {} })),
    order_statuses: { [orderId]: { lifecycle_status: 'in_progress', order_status: 'in_progress', work_status: 'in_progress' }, [otherId]: { lifecycle_status: 'released', order_status: 'ready' } }, order_customers: {},
    sequences: { [apparatusId]: [orderId, otherId] }, sequence_versions: { [apparatusId]: version }, sequence_revisions: { [apparatusId]: 4 }, visible_order_ids: { [apparatusId]: [otherId, orderId] },
    queue_states: { [apparatusId]: { [orderId]: 'in_progress', [otherId]: 'pending' } }, stage_states: {}, queue_action_controls: { [apparatusId]: { [orderId]: control(), [otherId]: control('pending', 'fresh_start_blocked', [], { interaction: interaction('fresh_start_blocked', { blocking_reason_code: 'sequence_blocked' }) }) } }, order_controls: {}, ...patch }
}
function pendingSnapshot(): ProductionSnapshot {
  return snapshot({ order_statuses: { [orderId]: { lifecycle_status: 'released', order_status: 'ready' } }, queue_states: { [apparatusId]: { [orderId]: 'pending', [otherId]: 'pending' } }, queue_action_controls: { [apparatusId]: { [orderId]: control('pending', 'fresh_start_blocked', [], { interaction: interaction('fresh_start_blocked', { blocking_reason_code: 'wip_missing' }) }) } } })
}
const freezeRequest = { request_id: 'freeze-fixture', status: 'pending', target_apparatus: apparatusId, target_session_id: 'session-fixture' }
function freezingSnapshot(): ProductionSnapshot {
  return snapshot({ rev: 2, order_controls: { [orderId]: { order_id: orderId, state: 'freeze_requested', freeze_request: freezeRequest } } })
}
const signal = () => new AbortController().signal
function fakeClient(reads: ProductionSnapshot[], write: (body: Row) => Promise<unknown> | unknown, metadata = machine()) {
  let read = 0
  const productionSnapshot = vi.fn(async () => reads[Math.min(read++, reads.length - 1)])
  const request = vi.fn(async (_path: string, _method: string, options: { body: Row }) => write(options.body))
  const detail = vi.fn(async () => metadata)
  return { client: { productionSnapshot, request, detail } as unknown as ApiClient, request, productionSnapshot, detail }
}

describe('native production control policy', () => {
  it('accepts only one consistent native order identity', () => {
    expect(productionControlOrderId({ id: orderId })).toBe(orderId)
    expect(productionControlOrderId({ map: { id: orderId }, id: orderId })).toBe(orderId)
    expect(productionControlOrderId({ map: { id: orderId }, id: otherId })).toBe('')
    expect(productionControlOrderId({ map: { id: orderId }, id: 0 })).toBe('')
    expect(productionControlOrderId({ id: 123 })).toBe('')
  })

  it('recognizes sparse active overrides without accepting a missing or malformed contract', () => {
    expect(productionOrderControlState(snapshot(), orderId)).toBe('active')
    expect(productionOrderControlState(snapshot({ order_controls: undefined as unknown as ProductionSnapshot['order_controls'] }), orderId)).toBe('unknown')
    expect(productionOrderControlState(snapshot({ order_controls: { [orderId]: { state: 'future_state' } } }), orderId)).toBe('unknown')
    expect(productionOrderControlState(snapshot({ order_controls: { [orderId]: { state: 'freeze_requested' } } }), orderId)).toBe('unknown')
  })

  it('gates freeze, cancellation, unfreeze and early close by known lifecycle/control state and permissions', () => {
    expect(productionOrderPolicy(snapshot(), orderId, session()).actions).toEqual(['freeze', 'close_early'])
    expect(productionOrderPolicy(pendingSnapshot(), orderId, session()).actions).toEqual(['close_early'])
    expect(productionOrderPolicy(freezingSnapshot(), orderId, session()).actions).toEqual(['cancel_freeze', 'close_early'])
    expect(productionOrderPolicy(snapshot({ order_controls: { [orderId]: { state: 'frozen' } } }), orderId, session()).actions).toEqual(['unfreeze', 'close_early'])
    for (const lifecycle of ['production_completed', 'closed', 'cancelled']) expect(productionOrderPolicy(snapshot({ order_statuses: { [orderId]: { lifecycle_status: lifecycle, order_status: 'completed' } } }), orderId, session()).actions).toEqual([])
    expect(productionOrderPolicy(snapshot(), orderId, session(['catalog.item.read'])).actions).toEqual([])
    expect(productionOrderPolicy(snapshot({ order_statuses: {} }), orderId, session()).actions).toEqual([])
  })

  it('blocks all recovery actions once early close is requested and requires the native reason limit', () => {
    const closing = snapshot({ order_controls: { [orderId]: { state: 'frozen', early_close: { comment: 'Stopped', closed_at_unix: 1000 } } } })
    expect(productionOrderPolicy(closing, orderId, session()).actions).toEqual([])
    expect(() => productionOrderCommand(pendingSnapshot(), orderId, session(), 'close_early', '   ')).toThrow('sababini')
    expect(() => productionOrderCommand(pendingSnapshot(), orderId, session(), 'close_early', 'x'.repeat(2001))).toThrow('2000')
    expect(productionOrderCommand(pendingSnapshot(), orderId, session(), 'close_early', '😀'.repeat(2000)).body.comment).toBe('😀'.repeat(2000))
    expect(productionOrderCommand(pendingSnapshot(), orderId, session(), 'close_early', '  Customer cancelled  ').body).toEqual({ order_id: orderId, action: 'close_early', comment: 'Customer cancelled' })
  })

  it('never derives queue actions from a raw status when the server action contract is absent or contradictory', () => {
    expect(productionQueuePolicies(snapshot({ queue_action_controls: {} }), orderId, session(), [machine()])[0]).toMatchObject({ pause: false, resume: false, moveUp: false, moveDown: false })
    expect(productionQueuePolicies(snapshot({ queue_states: { [apparatusId]: { [orderId]: 'paused' } } }), orderId, session(), [machine()])[0]).toMatchObject({ pause: false, resume: false })
    expect(productionQueuePolicies(snapshot(), orderId, session(['catalog.item.read']), [machine()])[0].pause).toBe(false)
    expect(productionQueuePolicies(snapshot(), orderId, session(), [machine()])[0].pause).toBe(true)
    expect(productionQueuePolicies(snapshot(), orderId, session(), [])[0].pause).toBe(false)
    expect(productionQueuePolicies(snapshot({ order_statuses: { [orderId]: { lifecycle_status: 'in_progress', order_status: 'completed' } } }), orderId, session(), [machine()])[0]).toMatchObject({ pause: false, resume: false })
    expect(productionQueuePolicies(snapshot({ order_statuses: { [orderId]: { lifecycle_status: 'in_progress' } } }), orderId, session(), [machine()])[0]).toMatchObject({ pause: false, resume: false })
  })

  it('blocks an Aparatchi admin-panel pause because the native handler would detach the roll', async () => {
    const operator: Session = { ...session(['admin.access', 'apparatus.queue.manage']), profile: { role: 'aparatchi', display_name: 'Fixture operator' } }
    expect(productionQueuePolicies(snapshot(), orderId, operator, [machine()])[0]).toMatchObject({ pause: false, reason: 'Bu rol uchun to‘xtatish mobil operator oqimida bajariladi.' })
    expect(() => productionQueueCommand(snapshot(), orderId, operator, [machine()], apparatusId, 'pause', { quantity: '100', uom: 'm' })).toThrow('ruxsat qilmagan')
    const plan = productionQueueCommand(snapshot(), orderId, session(), [machine()], apparatusId, 'pause', { quantity: '100', uom: 'm' })
    const server = fakeClient([snapshot()], () => ({}))
    await expect(executeProductionCommand(server.client, operator, plan, signal())).rejects.toMatchObject({ kind: 'conflict' })
    expect(server.request).not.toHaveBeenCalled()
  })

  it('offers safe reordering only with the native version/revision and a pending active order', () => {
    expect(productionQueuePolicies(pendingSnapshot(), orderId, session())[0]).toMatchObject({ moveUp: false, moveDown: true, position: 0 })
    for (const patch of [{ sequence_versions: {} }, { sequence_revisions: {} }, { sequence_versions: { [apparatusId]: 'legacy-version' } }]) expect(productionQueuePolicies(pendingSnapshotWith(patch), orderId, session())[0].moveDown).toBe(false)
    expect(productionQueuePolicies(snapshot(), orderId, session())[0].moveDown).toBe(false)
    expect(productionQueuePolicies(pendingSnapshot(), orderId, session(['apparatus.queue.manage']))[0].moveDown).toBe(false)
  })
})
function pendingSnapshotWith(patch: Row): ProductionSnapshot { return { ...pendingSnapshot(), ...patch } }

describe('native command payloads', () => {
  it('sends only native pause report fields and never fabricates revision, command ID, route, or zero quantity fields', () => {
    const plan = productionQueueCommand(snapshot(), orderId, session(), [machine()], apparatusId, 'pause', { quantity: '1250.5', uom: 'm', description: ' shift stop ' })
    expect(plan.body).toEqual({ apparatus: apparatusId, order_id: orderId, action: 'pause', include_control: true, produced_qty: 1250.5, uom: 'm', description: 'shift stop', print_transport: 'offline' })
    for (const quantity of ['', '0', '-1', 'NaN', 'Infinity']) expect(() => productionQueueCommand(snapshot(), orderId, session(), [machine()], apparatusId, 'pause', { quantity, uom: 'm' })).toThrow('noldan katta')
    expect(() => productionQueueCommand(snapshot(), orderId, session(), [machine()], apparatusId, 'pause', { quantity: '10', uom: '' })).toThrow('birligini')
  })

  it('requires complete per-roll Rezka quantities and does not turn a missing bobina weight into zero', () => {
    const cutting = snapshot({ queue_action_controls: { [apparatusId]: { [orderId]: control('in_progress', 'in_progress', ['pause'], { rezka_output_kadr_counts: [2, 1], rezka_output_report: null }) } } })
    const frames = [{ metres: '500', grossKg: '12', diameter: '45', tareKg: '' }, { metres: '700', grossKg: '20', diameter: '50', tareKg: '2' }]
    expect(productionQueueCommand(cutting, orderId, session(), [machine('cut')], apparatusId, 'pause', { frames }).body.rezka_frames).toEqual([{ finished_goods_meter: 500, gross_qty: 12, diameter: 45 }, { finished_goods_meter: 700, gross_qty: 20, diameter: 50, bobina_kg: 2 }])
    expect(() => productionQueueCommand(cutting, orderId, session(), [machine('cut')], apparatusId, 'pause', { frames: frames.slice(0, 1) })).toThrow('Har bir')
    expect(() => productionQueueCommand(cutting, orderId, session(), [machine('cut')], apparatusId, 'pause', { frames: frames.map(frame => ({ ...frame, tareKg: frame.grossKg })) })).toThrow('kichik')
  })

  it('collects only server-required resume scans and refuses to guess readiness', () => {
    const resumedControl = control('paused', 'paused', ['resume'], { previous_stage: 'upstream', interaction: interaction('paused', { resume_input_required: true, start_materials_mode: 'scan_required', material_scan_required: true, previous_wip_mode: 'scan_required', qolip_mode: 'scan_required' }) })
    const paused = snapshot({ queue_states: { [apparatusId]: { [orderId]: 'paused' } }, queue_action_controls: { [apparatusId]: { [orderId]: resumedControl } } })
    expect(() => productionQueueCommand(paused, orderId, session(), [], apparatusId, 'resume', {})).toThrow('WIP')
    expect(() => productionQueueCommand(paused, orderId, session(), [], apparatusId, 'resume', { qr: 'QR' })).toThrow('xomashyo')
    expect(productionQueueCommand(paused, orderId, session(), [], apparatusId, 'resume', { qr: ' WIP-QR ', materialBarcodes: [' RAW-1 '], qolipCodes: ['QOLIP-1'] }).body).toEqual({ apparatus: apparatusId, order_id: orderId, action: 'resume', include_control: true, qr_payload: 'WIP-QR', material_barcodes: ['RAW-1'], qolip_codes: ['QOLIP-1'] })
  })

  it('moves one order with a native anchor, version and stable command key rather than replacing the sequence', () => {
    const plan = productionReorderCommand(pendingSnapshot(), orderId, session(), apparatusId, 'move_down', 'fixture-command-key')
    expect(plan.body).toEqual({ apparatus: apparatusId, order_id: orderId, after_order_id: otherId, expected_version: version, idempotency_key: 'fixture-command-key' })
    expect(plan.body).not.toHaveProperty('order_ids')
    expect(plan.body).not.toHaveProperty('expected_revision')
  })
})

describe('production mutation preflight, receipts and session scope', () => {
  it('reads fresh policy before an order write and validates its exact native response', async () => {
    const before = snapshot(), after = freezingSnapshot()
    const { client, request, productionSnapshot } = fakeClient([before, after], () => ({ ok: true, control: after.order_controls[orderId] }))
    const result = await executeProductionCommand(client, session(), productionOrderCommand(before, orderId, session(), 'freeze'), signal())
    expect(request).toHaveBeenCalledWith('/v1/mobile/admin/production-maps/order-control', 'POST', expect.objectContaining({ body: { order_id: orderId, action: 'freeze' } }))
    expect(productionSnapshot).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ snapshot: after, reconciled: false })
  })

  it('refuses a changed order, phase, sequence version or server epoch before sending a mutation', async () => {
    const plan = productionOrderCommand(snapshot(), orderId, session(), 'freeze')
    for (const after of [freezingSnapshot(), snapshot({ epoch: 'retired' }), snapshot({ order_statuses: {} })]) {
      const server = fakeClient([after], () => { throw new Error('Must not write') })
      await expect(executeProductionCommand(server.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'conflict' })
      expect(server.request).not.toHaveBeenCalled()
    }
    const reorder = productionReorderCommand(pendingSnapshot(), orderId, session(), apparatusId, 'move_down', 'same-key')
    const server = fakeClient([pendingSnapshotWith({ sequence_versions: { [apparatusId]: 'b'.repeat(64) } })], () => ({}))
    await expect(executeProductionCommand(server.client, session(), reorder, signal())).rejects.toMatchObject({ kind: 'conflict' })
    expect(server.request).not.toHaveBeenCalled()
  })

  it('revalidates apparatus metadata and refuses to pause a different stage occurrence', async () => {
    const plan = productionQueueCommand(snapshot(), orderId, session(), [machine()], apparatusId, 'pause', { quantity: '100', uom: 'm' })
    const server = fakeClient([snapshot()], () => ({}), machine('cut', 5))
    await expect(executeProductionCommand(server.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'conflict' })
    expect(server.request).not.toHaveBeenCalled()
    const changed = fakeClient([snapshot({ queue_action_controls: { [apparatusId]: { [orderId]: control('in_progress', 'in_progress', ['pause'], { stage_node_id: 'again' }) } } })], () => ({}))
    await expect(executeProductionCommand(changed.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'conflict' })
    expect(changed.request).not.toHaveBeenCalled()
  })

  it('never retries or clears an unkeyed mutation merely because its target state is observed', async () => {
    const plan = productionOrderCommand(snapshot(), orderId, session(), 'freeze')
    const committed = fakeClient([snapshot(), freezingSnapshot()], () => { throw new ApiError(0, 'network') })
    await expect(executeProductionCommand(committed.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'uncertain', snapshot: freezingSnapshot(), message: expect.stringContaining('kutilgan holatga mos') })
    expect(committed.request).toHaveBeenCalledTimes(1)
    const missing = fakeClient([snapshot()], () => { throw new ApiError(0, 'network') })
    await expect(executeProductionCommand(missing.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'uncertain' })
    expect(missing.request).toHaveBeenCalledTimes(1)
    const queuePlan = productionQueueCommand(snapshot(), orderId, session(), [machine()], apparatusId, 'pause', { quantity: '100', uom: 'm' })
    const queue = fakeClient([snapshot()], () => { throw new ApiError(0, 'timeout') })
    await expect(executeProductionCommand(queue.client, session(), queuePlan, signal())).rejects.toMatchObject({ kind: 'uncertain' })
    expect(queue.request).toHaveBeenCalledTimes(1)
    const paused = snapshot({ rev: 2, queue_states: { [apparatusId]: { [orderId]: 'paused' } }, queue_action_controls: { [apparatusId]: { [orderId]: control('paused') } } })
    const observedPause = fakeClient([snapshot(), paused], () => ({ ok: false }))
    await expect(executeProductionCommand(observedPause.client, session(), queuePlan, signal())).rejects.toMatchObject({ kind: 'uncertain', snapshot: paused })
    expect(observedPause.request).toHaveBeenCalledTimes(1)
  })

  it('marks dispatch after preflight and before each exact keyed request, never for rejected preflight', async () => {
    const plan = productionOrderCommand(snapshot(), orderId, session(), 'freeze'), events: string[] = []
    const server = fakeClient([snapshot()], () => { events.push('write'); return { ok: true, control: { order_id: orderId, state: 'frozen' } } })
    server.productionSnapshot.mockImplementation(async () => { events.push('read'); return snapshot() })
    await executeProductionCommand(server.client, session(), plan, signal(), undefined, false, () => { events.push('dispatch') })
    expect(events.slice(0, 3)).toEqual(['read', 'dispatch', 'write'])
    const dispatched = vi.fn(), conflict = fakeClient([pendingSnapshot()], () => ({}))
    await expect(executeProductionCommand(conflict.client, session(), plan, signal(), undefined, false, dispatched)).rejects.toMatchObject({ kind: 'conflict' })
    expect(dispatched).not.toHaveBeenCalled(); expect(conflict.request).not.toHaveBeenCalled()
    await expect(executeProductionCommand(server.client, session(), plan, signal(), undefined, true, dispatched)).rejects.toMatchObject({ kind: 'blocked' })
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('reuses the identical idempotent reorder body after a lost receipt, with no whole-list PUT or fresh key', async () => {
    const before = pendingSnapshot()
    const after = pendingSnapshotWith({ rev: 2, sequence_versions: { [apparatusId]: 'b'.repeat(64) }, sequence_revisions: { [apparatusId]: 5 }, sequences: { [apparatusId]: [otherId, orderId] } })
    const receipt = { ok: true, order_ids: [otherId, orderId], version: 'b'.repeat(64), adjusted: false, revision: 5, epoch: before.epoch }
    let writes = 0
    const server = fakeClient([before, after], () => { if (++writes === 1) throw new ApiError(0, 'network'); return receipt })
    const plan = productionReorderCommand(before, orderId, session(), apparatusId, 'move_down', 'fixture-idempotency-key')
    expect(await executeProductionCommand(server.client, session(), plan, signal())).toMatchObject({ snapshot: after, adjusted: false, reconciled: false })
    expect(server.request).toHaveBeenCalledTimes(2)
    expect(server.request.mock.calls[0][2].body).toBe(server.request.mock.calls[1][2].body)
    expect(server.request.mock.calls.every(call => call[0] === '/v1/mobile/admin/production-maps/sequence' && call[1] === 'POST')).toBe(true)
  })

  it('does not retry 403/409 responses or manufacture confirmation from a malformed response', async () => {
    const plan = productionOrderCommand(snapshot(), orderId, session(), 'freeze')
    for (const status of [403, 409]) {
      const server = fakeClient([snapshot()], () => { throw new ApiError(status, 'fixture-error') })
      await expect(executeProductionCommand(server.client, session(), plan, signal())).rejects.toMatchObject({ status })
      expect(server.request).toHaveBeenCalledTimes(1)
    }
    const malformed = fakeClient([snapshot()], () => ({ ok: true, control: { order_id: otherId, state: 'frozen' } }))
    await expect(executeProductionCommand(malformed.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'uncertain' })
    expect(malformed.request).toHaveBeenCalledTimes(1)
  })

  it('keeps a validated queue receipt while discarding an older post-write snapshot', async () => {
    const before = snapshot()
    const plan = productionQueueCommand(before, orderId, session(), [machine()], apparatusId, 'pause', { quantity: '100', uom: 'm' })
    const server = fakeClient([before, before], () => ({ ok: true, epoch: before.epoch, rev: 2, states: { [orderId]: 'paused' }, order_status: {}, progress_batch: { batch_id: 'output-1', order_id: orderId, apparatus: apparatusId, action: 'pause', produced_qty: 100 } }))
    expect(await executeProductionCommand(server.client, session(), plan, signal())).toMatchObject({ snapshot: undefined, reconciled: false })
  })

  it('stops before writing if the session changes during preflight or the caller aborts', async () => {
    let current = true
    const server = fakeClient([snapshot()], () => ({}))
    server.productionSnapshot.mockImplementation(async () => { current = false; return snapshot() })
    const plan = productionOrderCommand(snapshot(), orderId, session(), 'freeze')
    await expect(executeProductionCommand(server.client, session(), plan, signal(), () => current)).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.request).not.toHaveBeenCalled()
    const abort = new AbortController(); abort.abort()
    await expect(executeProductionCommand(server.client, session(), plan, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.request).not.toHaveBeenCalled()
  })

  it('keeps the exact dispatched legacy intent when navigation aborts before a late native receipt', async () => {
    const plan = productionOrderCommand(snapshot(), orderId, session(), 'freeze'), ledger = new ProductionOperationLedger(), scope = 'controlled-scope'
    ledger.activate(scope)
    const operation = ledger.begin(scope, { channel: 'legacy-control', orderId, plan, proof: { actor: { role: 'admin' } } })
    let resolveWrite!: (response: unknown) => void, started!: () => void
    const wrote = new Promise<void>(resolve => { started = resolve })
    const server = fakeClient([snapshot()], () => new Promise(resolve => { resolveWrite = resolve; started() }))
    const controller = new AbortController()
    const execution = executeProductionCommand(server.client, session(), plan, controller.signal, undefined, false, () => { expect(ledger.dispatched(operation)).toBe(true) })
    await wrote
    expect(() => ledger.begin(scope, { channel: 'assignment', orderId, plan: {}, proof: {} })).toThrow('Avvalgi amal')
    controller.abort(); ledger.interrupt(operation)
    resolveWrite({ ok: true, control: { order_id: orderId, state: 'frozen' } })
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
    ledger.finish(operation, { confirmed: true })
    expect(ledger.get(scope, orderId)).toMatchObject({ phase: 'uncertain', plan: { body: plan.body } })
    expect(server.request).toHaveBeenCalledTimes(1)
  })

  it('does not publish or reconcile a late write response after its session has been retired', async () => {
    let current = true
    const server = fakeClient([snapshot(), freezingSnapshot()], () => { current = false; return { ok: true, control: freezingSnapshot().order_controls[orderId] } })
    const plan = productionOrderCommand(snapshot(), orderId, session(), 'freeze')
    await expect(executeProductionCommand(server.client, session(), plan, signal(), () => current)).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.productionSnapshot).toHaveBeenCalledTimes(1)
  })
})
