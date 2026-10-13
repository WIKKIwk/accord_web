import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { checkProductionAssignmentInputs, executeProductionAssignment, ProductionAssignmentAttemptRegistry, productionAssignmentCommand, productionAssignmentPolicies, readProductionAssignmentOutcome } from './production-assignment'
import type { ProductionAssignmentCommand } from './production-assignment'

const id = 'zakaz-assignment-fixture', source = 'apparatus:print:source', target = 'apparatus:print:target'
function session(role = 'admin', capabilities = ['admin.access']): Session { return { token: 'fixture-only-token', profile: { role, ref: 'fixture-user', display_name: 'Fixture user' }, capabilities, assigned_apparatus: [source], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] } }
function machine(app = source, operation = 'print', revision = 1): Row { return { runtime_projection: { apparatus_id: app, source_revision: revision, lifecycle: { state: 'active' }, display: { display_name: app === source ? 'Bosma 1' : 'Bosma 2' },
  execution_profile: { operation, technology: operation === 'laminate' ? 'adhesive_lamination' : 'rotogravure', capability_compatible_reroute: true }, capabilities: { [operation]: 2 } } } }
function control(state = 'pending', patch: Row = {}): Row {
  const mode = state === 'pending' ? 'fresh_start' : state === 'in_progress' ? 'in_progress' : 'paused'
  return { state, stage_node_id: 'work-1', previous_stage_ready: true, complete_requires_full_report: false, allowed_actions: state === 'pending' ? ['start'] : state === 'in_progress' ? ['pause', 'complete'] : ['resume'],
    interaction: { mode, start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: false, material_intake_allowed: state !== 'pending', resume_input_required: false,
      previous_wip_mode: 'not_required', opening_wip_mode: 'not_required', qolip_mode: 'not_required' }, ...patch }
}
function snapshot(state = 'pending', patch: Partial<ProductionSnapshot> = {}): ProductionSnapshot { return { ok: true, rev: 1, epoch: 'fixture', scope: 'admin', maps: [{ map: { id, order_number: 'F-1', title: 'Film', product_code: 'film',
  nodes: [{ id: 'work-1', kind: 'apparatus', title: 'Bosma', apparatus_id: source, x: 0, y: 0 }], edges: [] }, program: {} }], order_statuses: { [id]: { lifecycle_status: state === 'pending' ? 'released' : 'in_progress', order_status: state === 'pending' ? 'ready' : state } },
  order_customers: {}, sequences: { [source]: [id] }, queue_states: { [source]: { [id]: state } }, stage_states: { [id]: { 'work-1': state } }, order_controls: {}, queue_action_controls: { [source]: { [id]: control(state) } }, ...patch } }
const signal = () => new AbortController().signal
function makePlan(action: ProductionAssignmentCommand['action'], before = snapshot(), input = {}, role = session(), rows = [machine(), machine(target)]) { return productionAssignmentCommand(before, id, role, rows, source, action, input, 'fixture-command-key') }
function reply(plan: ProductionAssignmentCommand): Row {
  if (plan.action === 'assign' || plan.action === 'transfer') {
    const map = structuredClone(plan.map); map.nodes[0].apparatus_id = target
    return { ok: true, saved: { map, program: {} }, ...(plan.action === 'transfer' ? { transfer_id: `apparatus-transfer:${plan.body.idempotency_key}`, queue_state: 'paused', session_id: 'run-1', progress_batch_id: 'paused-roll' } : {}) }
  }
  if (plan.action === 'hold' || plan.action.startsWith('preflight_')) return { ok: true, hold: { hold_id: plan.body.hold_id, idempotency_key: plan.body.idempotency_key, order_id: id, apparatus: source, stage_node_id: 'work-1', status: plan.action === 'hold' ? 'running' : plan.action.replace('preflight_', '').replace('cancel', 'cancelled') } }
  const payload: Row = { input_progress_batch_id: plan.input.batchId || '', input_wip_source_kind: (plan.policy.control.interaction as Row).opening_wip_mode === 'scan_required' ? 'opening_wip' : 'progress_batch' }
  if (plan.action === 'handoff') Object.assign(payload, { worker_handoff: true, roll_removed_from_apparatus: false, lamination_print_leftover_rolls: plan.body.lamination_print_leftover_rolls,
    lamination_film_leftover_rolls: plan.body.lamination_film_leftover_rolls, total_waste: plan.body.total_waste, total_waste_uom: 'kg', description: plan.body.description || '' })
  return { ok: true, epoch: 'fixture', rev: 2, states: { [id]: plan.action === 'start' ? 'in_progress' : 'paused' }, session: { session_id: 'run-1', order_id: id, apparatus: source, stage_node_id: 'work-1', status: plan.action === 'start' ? 'active' : 'paused', payload_json: payload } }
}
function server(before: ProductionSnapshot, response: unknown | (() => unknown), rows = [machine(), machine(target)], readResponses: Record<string, unknown> = {}) {
  const request = vi.fn(async (path: string) => { if (path in readResponses) return readResponses[path]; return typeof response === 'function' ? response() : response })
  const productionSnapshot = vi.fn(async () => before), detail = vi.fn(async (_kind: unknown, row: Row) => rows.find(value => (value.runtime_projection as Row).apparatus_id === row.apparatus_id)!)
  const get = vi.fn(async () => ({ requires_material: true, material_scan_required: true, assignments_satisfied: true, scan_satisfied: true, required_scan_count: 1, matched_scan_count: 1, eligible_barcodes: ['RAW-1'] }))
  return { client: { request, productionSnapshot, detail, get } as unknown as ApiClient, request, productionSnapshot, detail, get }
}
function progressReport(status: 'active' | 'paused' = 'active'): Row {
  return { ok: true, history_scope: 'batch_lineage', scanned_batch: { batch_id: status === 'active' ? 'input-roll' : 'paused-roll', order_id: id, apparatus: source,
    session_id: 'run-1', status: status === 'active' ? 'completed' : 'paused', action: status === 'active' ? 'complete' : 'pause', wip_status: status === 'active' ? 'in_use' : 'waiting', used_by_apparatus: source, used_by_session_id: 'run-1' },
    active_sessions: [{ session_id: 'run-1', order_id: id, apparatus: source, stage_node_id: 'work-1', status, worker_role: 'aparatchi', worker_ref: 'owner-1', payload_json: { input_progress_batch_id: 'input-roll' } }] }
}

describe('native assignment policy', () => {
  it('uses backend-owned start permissions even for a sparse pending queue row', () => {
    expect(productionAssignmentPolicies(snapshot('pending', { queue_states: {} }), id, session(), [machine(), machine(target)])[0].actions).toContain('start')
    const disabled = snapshot('pending', { queue_action_controls: { [source]: { [id]: control('pending', { allowed_actions: [], interaction: { ...(control().interaction as Row), mode: 'fresh_start_blocked', blocking_reason_code: 'raw_material_assignment_required' } }) } } })
    expect(productionAssignmentPolicies(disabled, id, session(), [machine()])[0].actions).not.toContain('start')
    for (const patch of [{ order_statuses: { [id]: { lifecycle_status: 'released', order_status: 'future_state' } } }, { queue_states: { [source]: { [id]: 'paused' } } }, { order_controls: { [id]: { state: 'frozen' } } }]) {
      expect(productionAssignmentPolicies(snapshot('pending', patch), id, session(), [machine()])[0].actions).toEqual([])
    }
  })

  it('fails closed for incomplete interaction, unknown metadata and missing permission', () => {
    const incomplete = snapshot('pending', { queue_action_controls: { [source]: { [id]: control('pending', { interaction: { ...(control().interaction as Row), resume_input_required: undefined } }) } } })
    expect(productionAssignmentPolicies(incomplete, id, session(), [machine()])[0].actions).toEqual([])
    expect(productionAssignmentPolicies(snapshot(), id, session(), [])[0].actions).toEqual([])
    expect(productionAssignmentPolicies(snapshot(), id, session('worker', ['catalog.item.read']), [machine()])[0].actions).toEqual([])
  })

  it('blocks broad native moves for repeated machines while preserving current-stage start', () => {
    const before = snapshot(); (before.maps[0].map.nodes as Row[]).push({ id: 'work-again', kind: 'apparatus', apparatus_id: source, title: 'Again', x: 0, y: 200 })
    const policy = productionAssignmentPolicies(before, id, session(), [machine(), machine(target)])[0]
    expect(policy.actions).toContain('start')
    expect(policy.actions).not.toContain('assign')
    expect(policy.reason).toContain('takrorlangan')
  })

  it('preserves native alternative group candidate IDs and does not invent an unsupported bound-group transfer', () => {
    const before = snapshot()
    before.maps[0].map.nodes = ['work-1', 'work-2'].map((nodeId, index) => ({ id: nodeId, kind: 'apparatus', title: `Candidate ${index}`, apparatus_id: index ? target : source,
      alternative_group_id: 'native-alt', alternative_assigned_apparatus_id: source, x: 0, y: index * 100 }))
    const policy = productionAssignmentPolicies(before, id, session(), [machine(), machine(target)])[0]
    expect(policy.targets.map(value => value.id)).toEqual([target])
    expect(policy.actions).toContain('assign')
    expect(policy.transferTargets).toEqual([])
    expect(makePlan('assign', before, { targetId: target }).body).toEqual({ map_id: id, from_apparatus: source, to_apparatus: target })
  })
})

describe('actual native command bodies', () => {
  it('accepts the native empty unscoped admin scope and retains exact scope equality', async () => {
    const before = snapshot('pending', { scope: '' }), plan = makePlan('start', before), fake = server(before, reply(plan))
    expect(plan.scope).toBe('')
    await expect(executeProductionAssignment(fake.client, session(), plan, signal())).resolves.toMatchObject({ message: expect.stringContaining('boshlanganligi') })
    fake.productionSnapshot.mockResolvedValue(snapshot('pending', { scope: 'worker:another-scope' }))
    await expect(executeProductionAssignment(fake.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'conflict' })
    expect(fake.request).toHaveBeenCalledTimes(1)
  })
  it('requires the server-declared scans and sends no invented revision or command fields on start', () => {
    const before = snapshot(), interaction = before.queue_action_controls[source][id].interaction as Row
    Object.assign(interaction, { start_materials_mode: 'scan_required', material_scan_required: true, qolip_mode: 'scan_required', previous_wip_mode: 'scan_required' })
    before.queue_action_controls[source][id].previous_stage = 'Previous print'
    expect(() => makePlan('start', before)).toThrow('xomashyo')
    expect(() => makePlan('start', before, { materialBarcodes: ['RAW-1'] })).toThrow('qolip')
    expect(() => makePlan('start', before, { materialBarcodes: ['RAW-1'], qolipCodes: ['MOLD-1'] })).toThrow('WIP')
    const plan = makePlan('start', before, { materialBarcodes: [' RAW-1 '], qolipCodes: ['MOLD-1'], batchId: 'input-roll' })
    expect(plan.body).toEqual({ apparatus: source, order_id: id, include_control: true, action: 'start', material_barcodes: ['RAW-1'], qolip_codes: ['MOLD-1'], progress_batch_id: 'input-roll' })
    expect(plan.replayable).toBe(false)
  })

  it('labels native lamination handoff explicitly and never falls into Aparatchi legacy detach', () => {
    const before = snapshot('in_progress'); before.queue_action_controls[source][id].work_activity = { state: 'in_progress', worker_role: 'aparatchi', worker_ref: 'owner-1' }
    const plan = makePlan('handoff', before, { batchId: 'input-roll', printLeftover: '0', filmLeftover: '2', totalWaste: '0' }, session('aparatchi'), [machine(source, 'laminate')])
    expect(plan.body).toEqual({ apparatus: source, order_id: id, include_control: true, action: 'pause', worker_handoff: true, print_transport: 'offline', lamination_print_leftover_rolls: 0, lamination_film_leftover_rolls: 2, total_waste: 0 })
    expect(plan.body).not.toHaveProperty('remove_roll_from_apparatus')
    expect(() => makePlan('handoff', before, { batchId: 'input-roll', filmLeftover: '2', totalWaste: '0' }, session('aparatchi'), [machine(source, 'laminate')])).toThrow('Bosma qoldiq')
    expect(productionAssignmentPolicies(before, id, session('aparatchi'), [machine()])[0].actions).not.toContain('handoff')
  })

  it('uses durable native identities only for transfer and print-preflight', () => {
    const transfer = makePlan('transfer', snapshot('paused'), { targetId: target, batchId: 'paused-roll', reason: 'Motor stopped' })
    expect(transfer.body).toEqual({ order_id: id, from_apparatus: source, to_apparatus: target, reason: 'Motor stopped', idempotency_key: 'web-transfer:fixture-command-key' })
    const before = snapshot(); before.queue_action_controls[source][id].print_preflight_allowed = true
    const hold = makePlan('hold', before)
    expect(hold.body).toEqual({ apparatus: source, order_id: id, include_control: true, action: 'hold', hold_id: 'web-preflight:fixture-command-key', idempotency_key: 'web-preflight-command:fixture-command-key' })
    expect(makePlan('assign', snapshot(), { targetId: target }).body).not.toHaveProperty('idempotency_key')
  })
})

describe('readiness and guarded execution', () => {
  it('validates actual raw material, full mold set and scoped waiting WIP before start', async () => {
    const before = snapshot(); Object.assign(before.queue_action_controls[source][id].interaction as Row, { start_materials_mode: 'scan_required', material_scan_required: true, qolip_mode: 'scan_required', previous_wip_mode: 'scan_required' }); before.queue_action_controls[source][id].previous_stage = 'Previous print'
    const plan = makePlan('start', before, { materialBarcodes: ['RAW-1'], qolipCodes: ['MOLD-1'], batchId: 'input-roll' })
    const reads = { '/v1/mobile/admin/production-maps/qolip-validate': { ok: true, qolip: { qolip_code: 'MOLD-1', required_qolip_codes: ['MOLD-1'], required_qolip_count: 1 } },
      '/v1/mobile/admin/production-maps/progress-qr/lookup': { ok: true, validated_apparatus: source, validated_order_id: id, active_order_validated: true, batch: { batch_id: 'input-roll', order_id: id, wip_status: 'waiting' } } }
    const fake = server(before, reply(plan), undefined, reads)
    const proof = await checkProductionAssignmentInputs(fake.client, plan, signal())
    expect(proof.summary).toHaveLength(3)
    expect(fake.get).toHaveBeenCalledWith('/v1/mobile/admin/raw-material-start-requirements', { order_id: id, apparatus: source, material_barcodes: 'RAW-1' }, expect.any(AbortSignal))
    const result = await executeProductionAssignment(fake.client, session(), plan, signal())
    expect(result.message).toContain('boshlanganligi')
    expect(fake.request).toHaveBeenLastCalledWith('/v1/mobile/admin/production-maps/queue-action', 'POST', expect.objectContaining({ body: plan.body }))
  })

  it('rejects incomplete/mismatched scan validation instead of making the queue write', async () => {
    const before = snapshot(); Object.assign(before.queue_action_controls[source][id].interaction as Row, { start_materials_mode: 'scan_required', material_scan_required: true })
    const plan = makePlan('start', before, { materialBarcodes: ['RAW-1'] }), fake = server(before, reply(plan))
    fake.get.mockResolvedValue({ scan_satisfied: true } as never)
    await expect(executeProductionAssignment(fake.client, session(), plan, signal())).rejects.toMatchObject({ code: 'invalid_response' })
    expect(fake.request).not.toHaveBeenCalled()
  })

  it('validates opening-WIP QR through its real scoped lookup', async () => {
    const before = snapshot(); (before.queue_action_controls[source][id].interaction as Row).opening_wip_mode = 'scan_required'
    const plan = makePlan('start', before, { batchId: 'opening-roll', qr: 'OPENING-QR' }), fake = server(before, { ok: true, batch: { batch_id: 'opening-roll', order_id: id, qr_payload: 'OPENING-QR', wip_status: 'waiting' } })
    expect((await checkProductionAssignmentInputs(fake.client, plan, signal())).batchId).toBe('opening-roll')
    expect(fake.request).toHaveBeenCalledWith('/v1/mobile/admin/production-maps/opening-wip/lookup', 'POST', expect.objectContaining({ body: { apparatus: source, order_id: id, batch_id: 'opening-roll', qr_payload: 'OPENING-QR' } }))
  })

  it('requires exact mounted lamination input and rejects detached/foreign transfer sessions', async () => {
    const before = snapshot('in_progress'); before.queue_action_controls[source][id].work_activity = { state: 'in_progress', worker_role: 'aparatchi', worker_ref: 'owner-1' }
    const plan = makePlan('handoff', before, { batchId: 'input-roll', printLeftover: '0', filmLeftover: '0', totalWaste: '0' }, session(), [machine(source, 'laminate')])
    const fake = server(before, progressReport(), [machine(source, 'laminate')])
    expect(await checkProductionAssignmentInputs(fake.client, plan, signal())).toMatchObject({ sessionId: 'run-1', batchId: 'input-roll' })
    const wrong = progressReport(); (wrong.active_sessions as Row[])[0].stage_node_id = 'different-occurrence'
    fake.request.mockResolvedValue(wrong)
    await expect(checkProductionAssignmentInputs(fake.client, plan, signal())).rejects.toThrow('faol sessiyasi')
    const transfer = makePlan('transfer', snapshot('paused'), { targetId: target, batchId: 'paused-roll', reason: 'Motor stopped' })
    const detached = progressReport('paused'); (detached.active_sessions as Row[])[0].status = 'roll_detached'
    await expect(checkProductionAssignmentInputs(server(snapshot('paused'), detached).client, transfer, signal())).rejects.toThrow('pauza WIPsi')
  })

  it('does not confirm start with a missing, foreign or wrong-kind mounted input', async () => {
    for (const opening of [false, true]) {
      const before = snapshot(); (before.queue_action_controls[source][id].interaction as Row)[opening ? 'opening_wip_mode' : 'previous_wip_mode'] = 'scan_required'
      if (!opening) before.queue_action_controls[source][id].previous_stage = 'Previous print'
      const input = { batchId: opening ? 'opening-roll' : 'input-roll', qr: opening ? 'OPENING-QR' : '' }, plan = makePlan('start', before, input)
      const read = { ok: true, validated_apparatus: source, validated_order_id: id, active_order_validated: true, batch: { batch_id: input.batchId, order_id: id, wip_status: 'waiting', qr_payload: input.qr } }
      const reads = { [`/v1/mobile/admin/production-maps/${opening ? 'opening-wip' : 'progress-qr'}/lookup`]: read }
      await expect(executeProductionAssignment(server(before, reply(plan), undefined, reads).client, session(), plan, signal())).resolves.toBeDefined()
      for (const patch of [{ input_progress_batch_id: undefined }, { input_progress_batch_id: 'foreign-roll' }, { input_wip_source_kind: opening ? 'progress_batch' : 'opening_wip' }]) {
        const bad = reply(plan); Object.assign((bad.session as Row).payload_json as Row, patch)
        const fake = server(before, bad, undefined, reads)
        await expect(executeProductionAssignment(fake.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'uncertain' })
        expect(fake.request.mock.calls.filter(([path]) => path.endsWith('/queue-action'))).toHaveLength(1)
      }
    }
  })

  it('confirms handoff only when its mounted binding, not-detached flag and exact report match', async () => {
    const before = snapshot('in_progress'); before.queue_action_controls[source][id].work_activity = { state: 'in_progress', worker_role: 'aparatchi', worker_ref: 'owner-1' }
    const plan = makePlan('handoff', before, { batchId: 'input-roll', printLeftover: '0', filmLeftover: '2', totalWaste: '0.5', reason: 'Next shift' }, session(), [machine(source, 'laminate')])
    const reads = { '/v1/mobile/admin/production-maps/progress-qr/report': progressReport() }
    await expect(executeProductionAssignment(server(before, reply(plan), [machine(source, 'laminate')], reads).client, session(), plan, signal())).resolves.toMatchObject({ message: expect.stringContaining('ulangan') })
    for (const patch of [{ input_progress_batch_id: undefined }, { input_progress_batch_id: 'foreign-roll' }, { roll_removed_from_apparatus: true }, { roll_removed_from_apparatus: undefined },
      { lamination_print_leftover_rolls: 1 }, { lamination_film_leftover_rolls: 1 }, { total_waste: 1 }, { total_waste_uom: 'meter' }, { description: 'different report' }]) {
      const bad = reply(plan); Object.assign((bad.session as Row).payload_json as Row, patch)
      await expect(executeProductionAssignment(server(before, bad, [machine(source, 'laminate')], reads).client, session(), plan, signal())).rejects.toMatchObject({ kind: 'uncertain' })
    }
  })

  it('prevents stale stage, revision, epoch, permission and account-swap writes', async () => {
    const plan = makePlan('start')
    for (const before of [snapshot('pending', { epoch: 'new-server' }), snapshot('in_progress'), snapshot('pending', { queue_action_controls: { [source]: { [id]: control('pending', { stage_node_id: 'another-stage' }) } } })]) {
      const fake = server(before, reply(plan)); await expect(executeProductionAssignment(fake.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'conflict' }); expect(fake.request).not.toHaveBeenCalled()
    }
    const metadataChanged = server(snapshot(), reply(plan), [machine(source, 'print', 2)])
    await expect(executeProductionAssignment(metadataChanged.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'conflict' })
    expect(metadataChanged.request).not.toHaveBeenCalled()
    const forbidden = server(snapshot(), reply(plan))
    await expect(executeProductionAssignment(forbidden.client, session('worker', []), plan, signal())).rejects.toMatchObject({ kind: 'forbidden' })
    expect(forbidden.productionSnapshot).not.toHaveBeenCalled()
    const changedIdentity = server(snapshot(), reply(plan))
    await expect(executeProductionAssignment(changedIdentity.client, session(), plan, signal(), () => false)).rejects.toMatchObject({ name: 'AbortError' })
    expect(changedIdentity.productionSnapshot).not.toHaveBeenCalled()
  })

  it('never replays unkeyed start or assignment after a lost response', async () => {
    for (const plan of [makePlan('start'), makePlan('assign', snapshot(), { targetId: target })]) {
      const fake = server(snapshot(), () => { throw new ApiError(0, 'network') })
      await expect(executeProductionAssignment(fake.client, session(), plan, signal())).rejects.toMatchObject({ kind: 'uncertain' })
      expect(fake.request).toHaveBeenCalledTimes(1)
      await expect(executeProductionAssignment(fake.client, session(), plan, signal(), undefined, { summary: [], sessionId: '', batchId: '' })).rejects.toMatchObject({ kind: 'blocked' })
      expect(fake.request).toHaveBeenCalledTimes(1)
    }
  })

  it('uses exact durable transfer receipt for recovery and never overwrites topology', async () => {
    const before = snapshot('paused'), plan = makePlan('transfer', before, { targetId: target, batchId: 'paused-roll', reason: 'Motor stopped' })
    const fake = server(before, reply(plan), undefined, { '/v1/mobile/admin/production-maps/progress-qr/report': progressReport('paused') })
    const proof = await checkProductionAssignmentInputs(fake.client, plan, signal())
    await executeProductionAssignment(fake.client, session(), plan, signal(), undefined, proof)
    expect(fake.request).toHaveBeenLastCalledWith('/v1/mobile/admin/production-maps/apparatus-transfer', 'POST', expect.objectContaining({ body: plan.body }))
    const wrong = reply(plan); ((wrong.saved as Row).map as Row).edges = [{ from: 'new-stage', to: 'work-1' }]
    fake.request.mockImplementation(async path => path.endsWith('progress-qr/report') ? progressReport('paused') : wrong)
    await expect(executeProductionAssignment(fake.client, session(), plan, signal(), undefined, proof)).rejects.toMatchObject({ kind: 'uncertain' })
  })

  it('treats 403/409 as definitive rejects without automatic retry', async () => {
    for (const status of [403, 409]) {
      const fake = server(snapshot(), () => { throw new ApiError(status, status === 403 ? 'forbidden' : 'conflict') })
      await expect(executeProductionAssignment(fake.client, session(), makePlan('start'), signal())).rejects.toMatchObject({ status })
      expect(fake.request).toHaveBeenCalledTimes(1)
    }
  })

  it('retains dispatched start HTTP400 ambiguity after native fallback material settlement', async () => {
    const fake = server(snapshot(), () => { throw new ApiError(400, 'bad_request', 'material stock status update failed') }), dispatched = vi.fn()
    await expect(executeProductionAssignment(fake.client, session(), makePlan('start'), signal(), undefined, undefined, dispatched)).rejects.toMatchObject({ kind: 'uncertain' })
    expect(dispatched).toHaveBeenCalledTimes(1)
    expect(fake.request).toHaveBeenCalledTimes(1)
    expect(fake.productionSnapshot).toHaveBeenCalledTimes(2)
  })

  it('recovers exact keyed preflight creation at later native states and displays the real state', async () => {
    const before = snapshot(); before.queue_action_controls[source][id].print_preflight_allowed = true
    const plan = makePlan('hold', before), proof = { summary: [], sessionId: '', batchId: '' }
    for (const status of ['running', 'passed', 'failed', 'cancelled', 'consumed']) {
      const response = reply(plan); (response.hold as Row).status = status
      const fake = server(before, response)
      await expect(executeProductionAssignment(fake.client, session(), plan, signal(), undefined, proof)).resolves.toMatchObject({ message: expect.not.stringContaining('holati o‘zgargan') })
      expect(fake.request).toHaveBeenLastCalledWith('/v1/mobile/admin/production-maps/print-preflight', 'POST', expect.objectContaining({ body: plan.body }))
    }
    const wrong = reply(plan); (wrong.hold as Row).idempotency_key = 'different-command'
    await expect(executeProductionAssignment(server(before, wrong).client, session(), plan, signal(), undefined, proof)).rejects.toMatchObject({ kind: 'uncertain' })
  })
})

describe('dispatched assignment attempts survive detail lifecycle', () => {
  const proof = { summary: [], sessionId: '', batchId: '' }, scope = 'fixture-auth-scope'
  it('retains the original stage and body across interruption and locks the whole selected order', () => {
    const registry = new ProductionAssignmentAttemptRegistry(); registry.activate(scope)
    const plan = makePlan('start'), lease = registry.begin(scope, plan, proof)
    registry.dispatched(lease); registry.interrupt(lease)
    expect(registry.get(scope, id)).toMatchObject({ phase: 'uncertain', dispatched: true, plan: { stageNodeId: 'work-1', body: plan.body } })
    expect(() => registry.begin(scope, makePlan('assign', snapshot(), { targetId: target }), proof)).toThrow('Avvalgi amal')
    // Neither a normal query refresh nor a late response from the closed detail clears it.
    registry.activate(scope); registry.finish(lease, { confirmed: true })
    expect(registry.get(scope, id)?.phase).toBe('uncertain')
  })
  it('permits only exact recovery, and a recovery rejection never erases the previous unknown write', () => {
    const registry = new ProductionAssignmentAttemptRegistry(); registry.activate(scope)
    const before = snapshot('paused'), plan = makePlan('transfer', before, { targetId: target, reason: 'Motor stopped', batchId: 'paused-roll' })
    const lease = registry.begin(scope, plan, proof); registry.dispatched(lease); registry.interrupt(lease)
    const changed = structuredClone(plan); changed.body.idempotency_key = 'new-key'
    expect(() => registry.begin(scope, changed, proof, true)).toThrow('Avvalgi amal')
    const recovery = registry.begin(scope, plan, proof, true)
    registry.finish(recovery, { error: '403', uncertain: false })
    expect(registry.get(scope, id)).toMatchObject({ phase: 'uncertain', plan: { body: plan.body } })
    const confirmed = registry.begin(scope, plan, proof, true); registry.finish(confirmed, { confirmed: true })
    expect(registry.get(scope, id)).toBeNull()
  })
  it('clears only an undispatched new attempt, and retires attempts on an auth scope swap', () => {
    const registry = new ProductionAssignmentAttemptRegistry(); registry.activate(scope)
    const plan = makePlan('start'), prepared = registry.begin(scope, plan, proof)
    registry.interrupt(prepared); expect(registry.get(scope, id)).toBeNull()
    const sent = registry.begin(scope, plan, proof); registry.dispatched(sent)
    registry.activate('another-account'); registry.finish(sent, { confirmed: true })
    expect(registry.get(scope, id)).toBeNull(); expect(registry.get('another-account', id)).toBeNull()
    expect(JSON.stringify(registry.get(scope, id))).not.toContain('fixture-only-token')
  })
})

describe('explicit readback for unkeyed attempts', () => {
  it('observes actual changed map bindings without replay or topology replacement', async () => {
    const plan = makePlan('assign', snapshot(), { targetId: target }), updated = snapshot('pending', { rev: 2 })
    updated.maps[0].map = (reply(plan).saved as Row).map as Row
    const fake = server(updated, {}), proof = { summary: [], sessionId: '', batchId: '' }
    expect(await readProductionAssignmentOutcome(fake.client, session(), plan, proof, signal())).toMatchObject({ snapshot: updated })
    expect(fake.request).not.toHaveBeenCalled()
    updated.maps[0].map.edges = [{ from: 'work-1', to: 'invented' }]
    expect(await readProductionAssignmentOutcome(fake.client, session(), plan, proof, signal())).toBeNull()
  })
  it('requires a newer same-scope stage, actor and mounted native input before resolving an observed start', async () => {
    const before = snapshot(); (before.queue_action_controls[source][id].interaction as Row).previous_wip_mode = 'scan_required'
    before.queue_action_controls[source][id].previous_stage = 'Previous print'
    const plan = makePlan('start', before, { batchId: 'input-roll' }), updated = snapshot('in_progress', { rev: 2 }), proof = { summary: [], sessionId: '', batchId: 'input-roll' }
    updated.queue_action_controls[source][id].work_activity = { state: 'in_progress', worker_role: 'admin', worker_ref: 'fixture-user' }
    const report = progressReport(); Object.assign((report.active_sessions as Row[])[0], { worker_role: 'admin', worker_ref: 'fixture-user' }); ((report.active_sessions as Row[])[0].payload_json as Row).input_wip_source_kind = 'progress_batch'
    const fake = server(updated, report)
    expect(await readProductionAssignmentOutcome(fake.client, session(), plan, proof, signal())).toMatchObject({ snapshot: updated, message: expect.stringContaining('qayta yuborilmadi') })
    expect(fake.request).toHaveBeenCalledTimes(1); expect(fake.request.mock.calls[0][0]).toContain('progress-qr/report')
    ;((report.active_sessions as Row[])[0].payload_json as Row).input_progress_batch_id = 'other-roll'
    expect(await readProductionAssignmentOutcome(fake.client, session(), plan, proof, signal())).toBeNull()
    updated.queue_action_controls[source][id].work_activity = { state: 'in_progress', worker_role: 'admin', worker_ref: 'another-worker' }
    expect(await readProductionAssignmentOutcome(fake.client, session(), plan, proof, signal())).toBeNull()
  })
  it('keeps handoff totals and opening-WIP starts unknown when public readback cannot prove them', async () => {
    const before = snapshot('in_progress'); before.queue_action_controls[source][id].work_activity = { state: 'in_progress', worker_role: 'aparatchi', worker_ref: 'owner-1' }
    const plan = makePlan('handoff', before, { batchId: 'input-roll', printLeftover: '0', filmLeftover: '0', totalWaste: '0' }, session(), [machine(source, 'laminate')]), fake = server(snapshot('paused', { rev: 2 }), {})
    expect(await readProductionAssignmentOutcome(fake.client, session(), plan, { summary: [], sessionId: 'run-1', batchId: 'input-roll' }, signal())).toBeNull()
    expect(fake.request).not.toHaveBeenCalled()
  })
})
