import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { productionOperationLedger } from './production-operation-ledger'
import { checkProductionCompletion, emptyProductionCompletionDraft, executeProductionCompletion, ProductionCompletionAttemptRegistry, productionCompletionCommand, productionCompletionDraftMatches, productionCompletionPolicies, productionCompletionProof, readProductionCompletionContext, recoverProductionCompletion, validateProductionCompletionReceipt } from './production-completion'
import type { CompletionContext, ProductionCompletionCommand, ProductionCompletionDraft } from './production-completion'

const orderId = 'zakaz-completion-fixture', scope = 'fixture-completion-auth', run = 'run:1234:fixture'
const actor: Session = { token: 'fixture-only-token', profile: { role: 'admin', ref: 'actor-1', display_name: 'Fixture actor' }, capabilities: ['admin.access'], assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
const app = (operation = 'print') => `apparatus:${operation}:fixture`
const signal = () => new AbortController().signal
function machine(operation = 'print', rev = 1): Row { return { runtime_projection: { apparatus_id: app(operation), source_revision: rev, lifecycle: { state: 'active' }, display: { display_name: `${operation} fixture` }, execution_profile: { operation } } } }
export function snapshot(operation = 'print', patch: Row = {}): ProductionSnapshot {
  const control = { state: 'in_progress', stage_node_id: 'stage-1', allowed_actions: ['pause', 'complete'], complete_requires_full_report: true, complete_requires_rezka_total_waste_only: false,
    work_activity: { state: 'in_progress', worker_role: operation === 'laminate' ? 'admin' : 'aparatchi', worker_ref: operation === 'laminate' ? 'actor-1' : 'owner-1' }, rezka_output_kadr_counts: operation === 'cut' ? [2, 1] : undefined,
    rezka_input_lineage: operation === 'cut' ? [{ input_batch_id: 'input-roll', source_kind: 'progress_batch', stage_node_id: 'stage-1', status: 'in_use', sequence_no: 1 }] : undefined, ...patch }
  return { ok: true, epoch: 'fixture-server', scope: '', rev: 1, maps: [{ map: { id: orderId, order_number: 'F-202', title: 'Film fixture', product_code: 'film', nodes: [{ id: 'stage-1', kind: 'apparatus', apparatus_id: app(operation), title: 'Fixture stage', x: 0, y: 0 }], edges: [] }, program: {} }],
    order_statuses: { [orderId]: { lifecycle_status: 'in_progress', order_status: 'in_progress' } }, order_customers: {}, sequences: { [app(operation)]: [orderId] }, queue_states: { [app(operation)]: { [orderId]: 'in_progress' } }, stage_states: {}, order_controls: {}, queue_action_controls: { [app(operation)]: { [orderId]: control } } }
}
export function context(operation = 'print'): CompletionContext {
  if (operation === 'print') return { session: null, sources: [], cut: null }
  if (operation === 'cut') return { session: null, sources: [], cut: { cycleId: run, counts: [2, 1], saved: [], epoch: 'fixture-server', rev: 1 } }
  return { session: { session_id: run, order_id: orderId, apparatus: app(operation), stage_node_id: 'stage-1', status: 'active', worker_role: 'admin', worker_ref: 'actor-1', payload_json: { input_progress_batch_id: 'input-roll', input_wip_source_kind: 'progress_batch' } },
    sources: [{ source_kind: 'progress_batch', source_id: 'input-roll', session_id: run, revision: 2, source_net_kg: 10, item_name: 'Printed film' }, { source_kind: 'raw_material', source_id: 'RAW-1', session_id: run, revision: 8, source_net_kg: 20, item_name: 'Film' }], cut: null }
}
function draft(): ProductionCompletionDraft { return { ...emptyProductionCompletionDraft(), metres: '100', grossKg: '10', tareKg: '1', waste: '2', description: 'Measured fixture report',
  paint: (['rasxot', 'astatka'] as const).flatMap(usage => [1, 2, 3].map(index => ({ usage, category: 'colors' as const, name: `Paint ${index}`, label: 'kg', value: usage === 'rasxot' ? '2' : '1' }))), layers: { 'progress_batch:input-roll': '0', 'raw_material:RAW-1': '2' },
  frames: [1, 2].map(index => ({ metres: String(index * 100), grossKg: String(index * 10), tareKg: '1', diameter: '30', issueNote: '' })) } }
function fixture(operation = 'print', patch: Row = {}, changes: Partial<ProductionCompletionDraft> = {}) {
  const before = snapshot(operation, patch), ctx = context(operation), values = { ...draft(), ...changes }, rows = [machine(operation)]
  return { before, ctx, values, rows, plan: productionCompletionCommand(before, orderId, actor, rows, app(operation), scope, ctx, values, 'fixture-completion-key') }
}
export function response(plan: ProductionCompletionCommand, state = 'completed'): Row {
  if (plan.expectedApproval) return { ok: true, epoch: plan.epoch, rev: 2, states: { [orderId]: 'paused' }, session: null, progress_event: null, progress_batch: null, print: null,
    completion_request: { event_id: 'approval-fixture', order_id: orderId, apparatus: plan.apparatusId, worker_role: 'admin', worker_ref: 'actor-1', description: plan.body.description, notice_kind: 'zero_metric_completion_request', zero_metric_codes: ['total_waste'], decision_required: true } }
  const proof = productionCompletionProof(plan), payload: Row = { input_progress_batch_id: proof.inputBatchId, input_wip_source_kind: proof.inputKind, description: plan.body.description || '', total_waste: plan.body.total_waste,
    return_ink_kg: plan.returnInk && plan.returnInk > 0 || plan.policy.closingBatchId ? plan.returnInk : null, input_lineage: proof.links.map(link => ({ ...link, status: 'processed' })),
    lamination_print_leftover_rolls: plan.body.lamination_print_leftover_rolls, lamination_film_leftover_rolls: plan.body.lamination_film_leftover_rolls }
  if (plan.policy.closingBatchId) Object.assign(payload, { complete_without_output: true, closing_output_batch_id: plan.policy.closingBatchId })
  const session = { session_id: run, order_id: orderId, apparatus: plan.apparatusId, stage_node_id: 'stage-1', status: 'completed', worker_role: 'admin', worker_ref: 'actor-1', payload_json: payload }
  const frames = plan.policy.operation === 'cut' ? plan.body.rezka_frames as Row[] : plan.policy.closingBatchId ? [] : [plan.body]
  const batches = frames.flatMap((frame, index) => {
    if (frame.issue_note || plan.context.cut?.saved.some(slot => slot.frame_index === index + 1)) return []
    return [{ batch_id: `output-${index + 1}`, qr_payload: `QR-${index + 1}`, revision: 1, produced_qty: frame.finished_goods_meter ?? frame.produced_qty, uom: 'm', wip_status: 'waiting', session_id: run, order_id: orderId, apparatus: plan.apparatusId, action: 'complete', status: 'completed', worker_role: 'admin', worker_ref: 'actor-1', parent_batch_id: proof.inputBatchId,
      finished_goods_meter: frame.finished_goods_meter, finished_goods_kg: frame.finished_goods_kg ?? frame.gross_qty, bobina_kg: frame.bobina_kg || null, diameter: frame.diameter,
      payload_json: { stage_node_id: 'stage-1', rezka_frame_index: index + 1, rezka_frame_count: plan.context.cut?.counts.length } }]
  })
  payload.rezka_frame_issues = frames.flatMap((frame, index) => frame.issue_note ? [{ frame_index: index + 1, issue_note: frame.issue_note }] : [])
  const event = { event_id: 'progress-event-fixture', session_id: run, order_id: orderId, apparatus: plan.apparatusId, action: 'complete', worker_role: 'admin', worker_ref: 'actor-1', total_waste: plan.body.total_waste,
    payload_json: { rezka_previously_recorded_batches: plan.context.cut?.saved.flatMap(slot => slot.batch_id ? [slot.batch_id] : []) || [] } }
  if (plan.policy.operation === 'cut') Object.assign(payload, { rezka_output_cycle: event.event_id, rezka_output_report: [] })
  const remainders = plan.keyed ? (plan.body.layer_remainders as Row[]).map(layer => ({ ...layer, apparatus: plan.apparatusId, order_id: orderId, session_id: run, recorded_by: { role: 'admin', ref: 'actor-1' }, operation_id: `remaining-${layer.source_id}`, qr_payload: layer.remaining_net_kg ? `QR-REMAINING-${layer.source_id}` : '' })) : []
  return { ok: true, epoch: plan.epoch, rev: 2, states: { [orderId]: state }, session, progress_event: event, progress_batch: batches[0] || null, progress_batches: batches, remainders, prints: [{ ok: false, error: 'fixture_label_failed' }], ...(plan.keyed ? { action: 'complete', request_id: plan.body.request_id } : {}) }
}
function server(plan: ProductionCompletionCommand, before: ProductionSnapshot, supplied: unknown = response(plan), changedContext = plan.context) {
  let committed = false
  const productionSnapshot = vi.fn(async () => committed ? { ...before, rev: 2 } : before)
  const get = vi.fn(async (path: string, query: Row = {}): Promise<Row> => path.endsWith('rezka-output-report') ? { ok: true, apparatus: plan.apparatusId, order_id: orderId, session_status: 'active', order_control: 'active', epoch: plan.epoch, rev: 1,
    rezka_output_report: { cycle_id: changedContext.cut?.cycleId, frames: changedContext.cut?.saved }, kadr_counts: changedContext.cut?.counts } : { ok: true, session: changedContext.session, sources: changedContext.sources, request_result: query.request_id ? supplied : null })
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('progress-qr/report')) return { ok: true, history_scope: 'batch_lineage', scanned_batch: { batch_id: plan.policy.closingBatchId || plan.draft.inputBatchId, order_id: orderId, apparatus: plan.apparatusId, session_id: run, payload_json: { stage_node_id: 'stage-1' } }, active_sessions: [{ session_id: run, order_id: orderId, apparatus: plan.apparatusId, stage_node_id: 'stage-1', status: 'paused', worker_role: 'aparatchi', worker_ref: 'owner-1', payload_json: {} }] }
    committed = true; if (supplied instanceof Error) throw supplied; return supplied
  })
  const detail = vi.fn(async () => machine(plan.policy.operation))
  return { client: { get, request, detail, productionSnapshot } as unknown as ApiClient, get, request, detail, productionSnapshot }
}
let sequence = 0
beforeEach(() => { productionOperationLedger.activate(`reset-${++sequence}`); productionOperationLedger.activate(scope) })

describe('native complete policy and payloads', () => {
  it('uses native complete permissions, exact graph stage and actual empty admin scope', () => {
    const value = fixture(); expect(value.plan.scope).toBe(''); expect(value.plan.body).toMatchObject({ action: 'complete', print_transport: 'offline', returned_paint_items: expect.any(Array) })
    expect(value.plan.body).not.toHaveProperty('idempotency_key'); expect(value.plan.body).not.toHaveProperty('expected_rev')
    for (const patch of [{ allowed_actions: [] }, { complete_requires_full_report: undefined }, { stage_node_id: 'different-occurrence' }]) expect(productionCompletionPolicies(snapshot('print', patch), orderId, actor, [machine()])[0].allowed).toBe(false)
    const frozen = snapshot(); frozen.order_controls = { [orderId]: { state: 'frozen' } }; expect(productionCompletionPolicies(frozen, orderId, actor, [machine()])[0].allowed).toBe(false)
  })
  it('requires real paint fields and separates scalar-zero approval from valid zero paint accounting', () => {
    expect(() => fixture('print', {}, { paint: draft().paint.slice(0, 3) })).toThrow('uchtadan')
    expect(() => fixture('print', {}, { waste: '0', description: '' })).toThrow('tasdiqlash so‘rovi')
    expect(fixture('print', {}, { waste: '0' }).plan.expectedApproval).toBe(true)
    const fields = draft().paint.map(value => ({ ...value, value: value.usage === 'astatka' ? '0' : value.value })), plan = fixture('print', {}, { paint: fields }).plan
    expect(plan.expectedApproval).toBe(false); expect(plan.returnInk).toBe(0)
    expect(validateProductionCompletionReceipt(response(plan), plan, productionCompletionProof(plan))?.kind).toBe('completed')
    const duplicated = draft().paint; duplicated[1] = { ...duplicated[0] }; expect(() => fixture('print', {}, { paint: duplicated })).toThrow('takrorlangan')
  })
  it('records existing detached Bosma closing without a new roll or invented quantities', async () => {
    const before = snapshot('print', { closing_output_batch_id: 'old-output', state: 'paused', work_activity: { state: 'paused', worker_role: 'aparatchi', worker_ref: 'owner-1' } }); before.queue_states[app()][orderId] = 'paused'
    const values = { ...draft(), metres: '', grossKg: '', tareKg: '', waste: '0' }, plan = productionCompletionCommand(before, orderId, actor, [machine()], app(), scope, context(), values), fake = server(plan, before)
    expect(plan.body).toMatchObject({ complete_without_output: true, progress_batch_id: 'old-output', total_waste: 0 }); expect(plan.body).not.toHaveProperty('finished_goods_meter')
    await expect(executeProductionCompletion(fake.client, actor, plan, signal())).resolves.toMatchObject({ kind: 'completed', batches: [] })
  })
  it('requires an explicit answer for every physical laminate source and preserves native revision identity', () => {
    expect(() => fixture('laminate', {}, { layers: { 'raw_material:RAW-1': '2' } })).toThrow('qoldig‘i')
    expect(() => fixture('laminate', {}, { layers: { 'progress_batch:input-roll': '11', 'raw_material:RAW-1': '2' } })).toThrow('haqiqiy kirish')
    const { plan } = fixture('laminate', {}, { waste: '0', tareKg: '0' })
    expect(plan.body).toMatchObject({ request_id: 'web:fixture-completion-key', session_id: run, full_completion_report_required: true, lamination_print_leftover_rolls: 0, lamination_film_leftover_rolls: 1, total_waste: 0 })
    expect(plan.body.layer_remainders).toEqual([{ source_kind: 'progress_batch', source_id: 'input-roll', expected_revision: 2, remaining_net_kg: 0 }, { source_kind: 'raw_material', source_id: 'RAW-1', expected_revision: 8, remaining_net_kg: 2 }])
    expect(plan.keyed).toBe(true); expect(plan.body).not.toHaveProperty('include_control')
    expect(plan.body).not.toHaveProperty('bobina_kg')
  })

  it('requires the actual active operator for full atomic laminate completion without an admin ownership override', () => {
    const before = snapshot('laminate'), ctx = context('laminate'); ctx.session!.worker_ref = 'another-worker'
    expect(() => productionCompletionCommand(before, orderId, actor, [machine('laminate')], app('laminate'), scope, ctx, draft())).toThrow('Admin roli sessiya egaligini')
  })
  it('uses partial laminate output without falsely returning physical layers or claiming final closure', async () => {
    const { plan, before } = fixture('laminate', { complete_requires_full_report: false }), fake = server(plan, before, response(plan, 'pending'))
    expect(plan.keyed).toBe(false); expect(plan.body).not.toHaveProperty('layer_remainders'); expect(plan.body).not.toHaveProperty('total_waste')
    await expect(executeProductionCompletion(fake.client, actor, plan, signal())).resolves.toMatchObject({ kind: 'partial', batches: expect.arrayContaining([expect.objectContaining({ batch_id: 'output-1' })]) })
  })
  it('preserves saved cut slots and accepts explicit issue slots without fabricating zero output', () => {
    const before = snapshot('cut'), ctx = context('cut'), values = draft()
    ctx.cut!.saved = [{ frame_index: 1, batch_id: 'already-saved', qr_payload: 'SAVED-QR', input: { finished_goods_meter: 80, gross_qty: 9, bobina_kg: 1, diameter: 25 } }]
    values.frames[1] = { metres: '', grossKg: '', tareKg: '', diameter: '', issueNote: 'No healthy output' }
    const plan = productionCompletionCommand(before, orderId, actor, [machine('cut')], app('cut'), scope, ctx, values)
    expect(plan.body.rezka_frames).toEqual([ctx.cut!.saved[0].input, { issue_note: 'No healthy output' }]); expect(plan.body.rezka_output_cycle).toBe(run)
    expect(validateProductionCompletionReceipt(response(plan), plan, productionCompletionProof(plan))?.batches).toEqual([])
    values.frames[1].metres = '1'; expect(() => productionCompletionCommand(before, orderId, actor, [machine('cut')], app('cut'), scope, ctx, values)).toThrow('miqdor yozilmaydi')
  })
  it('permits all-issue cut completion without requiring fictional waste or physical rolls', () => {
    const frames = draft().frames.map(() => ({ metres: '', grossKg: '', tareKg: '', diameter: '', issueNote: 'Damaged frame' })), plan = fixture('cut', {}, { frames, waste: '' }).plan
    expect(plan.body).not.toHaveProperty('total_waste'); expect(validateProductionCompletionReceipt(response(plan), plan, productionCompletionProof(plan))).toMatchObject({ kind: 'completed', batches: [] })
  })
})

describe('real reads, guarded submission and native receipts', () => {
  it('loads exact native laminate/cut read contracts and blocks unsupported full opening-WIP returns', async () => {
    for (const operation of ['laminate', 'cut']) {
      const { plan, before } = fixture(operation), fake = server(plan, before), policy = plan.policy
      expect(await readProductionCompletionContext(fake.client, policy, orderId, signal())).toEqual(plan.context)
      expect(fake.get).toHaveBeenCalledWith(expect.stringContaining(operation === 'cut' ? 'rezka-output-report' : 'laminatsiya-astatka'), { apparatus: app(operation), order_id: orderId }, expect.any(AbortSignal))
    }
    const { plan, before } = fixture('laminate'), opening = structuredClone(plan.context); (opening.session!.payload_json as Row).input_wip_source_kind = 'opening_wip'
    await expect(checkProductionCompletion(server(plan, before, response(plan), opening).client, plan, signal())).rejects.toThrow('native qatlamlarni atomik')
  })
  it('blocks changed physical layer revisions, saved cut slots, stage/epoch, actor and capabilities before any business POST', async () => {
    for (const operation of ['laminate', 'cut']) {
      const { plan, before } = fixture(operation), changed = structuredClone(plan.context)
      if (operation === 'laminate') changed.sources[0].revision++
      else changed.cut!.cycleId = 'run:9999:new-cycle'
      const fake = server(plan, before, response(plan), changed)
      await expect(executeProductionCompletion(fake.client, actor, plan, signal())).rejects.toMatchObject({ kind: 'conflict' }); expect(fake.request).not.toHaveBeenCalled()
    }
    const { plan, before } = fixture(), fake = server(plan, before)
    fake.productionSnapshot.mockResolvedValue({ ...before, epoch: 'new-server' }); await expect(executeProductionCompletion(fake.client, actor, plan, signal())).rejects.toMatchObject({ kind: 'conflict' }); expect(fake.request).not.toHaveBeenCalled()
    for (const changed of [{ ...actor, capabilities: [] }, { ...actor, profile: { ...actor.profile, role: 'aparatchi' } }]) await expect(executeProductionCompletion(fake.client, changed, plan, signal())).rejects.toMatchObject({ kind: 'forbidden' })
  })
  it('classifies approval, remaining-WIP pending and completed reports independently from failed printers', async () => {
    for (const [operation, patch, changes, expected] of [['print', {}, { waste: '0' }, 'approval_requested'], ['laminate', { complete_requires_full_report: false }, {}, 'partial'], ['cut', {}, {}, 'completed']] as const) {
      const { plan, before } = fixture(operation, patch, changes), fake = server(plan, before, response(plan, expected === 'partial' ? 'pending' : 'completed'))
      const result = await executeProductionCompletion(fake.client, actor, plan, signal())
      expect(result.kind).toBe(expected); if (expected !== 'approval_requested') expect(result.prints[0].ok).toBe(false)
      expect(fake.request.mock.calls.filter(([path]) => !path.endsWith('progress-qr/report'))).toHaveLength(1)
    }
  })
  it('does not confirm foreign input/session/batch bindings or different quantities returned as HTTP200', () => {
    const { plan } = fixture('laminate'), proof = productionCompletionProof(plan)
    for (const mutate of [(value: Row) => { (value.session as Row).session_id = 'foreign-run' }, (value: Row) => { ((value.session as Row).payload_json as Row).input_progress_batch_id = 'foreign-roll' },
      (value: Row) => { (value.progress_batches as Row[])[0].finished_goods_kg = 99 }, (value: Row) => { (value.remainders as Row[])[1].remaining_net_kg = 1 }, (value: Row) => { (value.remainders as Row[])[1].recorded_by = { role: 'admin', ref: 'other-actor' } }]) {
      const bad = response(plan); mutate(bad); expect(validateProductionCompletionReceipt(bad, plan, proof)).toBeNull()
    }
    const cut = fixture('cut').plan, bad = response(cut); ((bad.progress_batches as Row[])[0].payload_json as Row).rezka_frame_index = 2
    expect(validateProductionCompletionReceipt(bad, cut, productionCompletionProof(cut))).toBeNull()
  })
  it('rejects wrong output units, waiting state, new revision and contradictory primary batches', () => {
    const { plan } = fixture(), proof = productionCompletionProof(plan)
    for (const change of [{ uom: 'kg' }, { produced_qty: 900 }, { wip_status: 'processed' }, { revision: 9 }]) {
      const bad = response(plan); Object.assign((bad.progress_batches as Row[])[0], change)
      expect(validateProductionCompletionReceipt(bad, plan, proof)).toBeNull()
    }
    const conflicting = response(plan); conflicting.progress_batch = { ...(conflicting.progress_batch as Row), qr_payload: 'another-label' }
    expect(validateProductionCompletionReceipt(conflicting, plan, proof)).toBeNull()
    const cut = fixture('cut').plan, duplicateQr = response(cut); (duplicateQr.progress_batches as Row[])[1].qr_payload = (duplicateQr.progress_batches as Row[])[0].qr_payload
    expect(validateProductionCompletionReceipt(duplicateQr, cut, productionCompletionProof(cut))).toBeNull()
    const staleCycle = response(cut); ((staleCycle.session as Row).payload_json as Row).rezka_output_cycle = cut.context.cut!.cycleId
    expect(validateProductionCompletionReceipt(staleCycle, cut, productionCompletionProof(cut))).toBeNull()
  })
  it('uses native micro-unit normalization and explicit no-tare laminate intent without accepting invented tare', () => {
    const { plan } = fixture('laminate', {}, { metres: '100.0000004', grossKg: '10.0000004', tareKg: '0' })
    expect(plan.body.finished_goods_meter).toBe(100); expect(plan.body.finished_goods_kg).toBe(10); expect(plan.body).not.toHaveProperty('bobina_kg')
    expect(validateProductionCompletionReceipt(response(plan), plan, productionCompletionProof(plan))?.kind).toBe('completed')
    const bad = response(plan); (bad.progress_batches as Row[])[0].bobina_kg = 1
    expect(validateProductionCompletionReceipt(bad, plan, productionCompletionProof(plan))).toBeNull()
  })
  it('accepts actual native atomic receipt fields without invented queue event or state envelope', async () => {
    const { plan, before } = fixture('laminate'), native = response(plan)
    for (const key of ['states', 'progress_event', 'progress_batch']) delete native[key]
    const fake = server(plan, before, native)
    await expect(executeProductionCompletion(fake.client, actor, plan, signal())).resolves.toMatchObject({ kind: 'completed' })
    for (const key of ['epoch', 'rev', 'prints']) delete native[key]
    await expect(recoverProductionCompletion(fake.client, actor, plan, signal())).resolves.toMatchObject({ kind: 'completed', prints: [] })
    expect(fake.request).toHaveBeenCalledTimes(1)
  })
  it('rejects approval replies that silently create output or approve metrics the form did not submit as zero', () => {
    const { plan } = fixture('print', {}, { waste: '0' }), proof = productionCompletionProof(plan)
    for (const mutation of [(value: Row) => { value.progress_batches = [{ batch_id: 'invented-output' }] }, (value: Row) => { (value.completion_request as Row).zero_metric_codes = ['total_waste', 'gross_qty'] }, (value: Row) => { value.states = { [orderId]: 'completed' } }]) {
      const bad = response(plan); mutation(bad); expect(validateProductionCompletionReceipt(bad, plan, proof)).toBeNull()
    }
  })
  it('fails closed on malformed saved cut metrics, issue/quantity mixtures, duplicate one-based slots and empty physical identities', async () => {
    const { plan, before } = fixture('cut'), healthy = { finished_goods_meter: 80, gross_qty: 9, bobina_kg: 1, diameter: 25 }, saved = { frame_index: 1, batch_id: 'saved-roll', qr_payload: 'SAVED-QR', input: healthy }
    const cases = [
      [{ ...saved, input: { ...healthy, gross_qty: '9' } }], [{ ...saved, input: { ...healthy, bobina_kg: 9 } }], [{ ...saved, input: { ...healthy, finished_goods_meter: 0 } }],
      [{ ...saved, input: { ...healthy, diameter: -1 } }], [{ ...saved, input: { ...healthy, foreign: 'field' } }], [{ ...saved, frame_index: 0 }], [saved, saved], [{ ...saved, qr_payload: '' }],
      [{ frame_index: 1, batch_id: '', qr_payload: '', input: { ...healthy, issue_note: 'Damaged' } }],
    ]
    for (const slots of cases) {
      const ctx = structuredClone(plan.context); ctx.cut!.saved = slots
      const fake = server(plan, before, response(plan), ctx)
      await expect(readProductionCompletionContext(fake.client, plan.policy, orderId, signal())).rejects.toMatchObject({ status: 502 })
      expect(fake.request).not.toHaveBeenCalled()
    }
    const actual = structuredClone(plan.context); actual.cut!.saved = [{ ...saved, input: { ...healthy, produced_qty: null, finished_goods_kg: null, rezka_bosma_waste: null, rezka_lamination_waste: null, rezka_edge_waste: null, total_waste: null, issue_note: '' } }]
    const loaded = await readProductionCompletionContext(server(plan, before, response(plan), actual).client, plan.policy, orderId, signal())
    expect(loaded.cut!.saved).toEqual(actual.cut!.saved)
  })
  it('keeps a confirmed business receipt when snapshot refresh or printer preparation fails', async () => {
    const { plan, before } = fixture(), fake = server(plan, before)
    fake.productionSnapshot.mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockRejectedValueOnce(new ApiError(503, 'snapshot_unavailable'))
    const result = await executeProductionCompletion(fake.client, actor, plan, signal())
    expect(result.kind).toBe('completed'); expect(result.snapshot).toBeUndefined(); expect(result.prints[0].ok).toBe(false)
    expect(fake.request).toHaveBeenCalledTimes(1)
  })
  it('never replays a lost unkeyed complete, and retains material fallback HTTP400 ambiguity', async () => {
    for (const status of [0, 400, 503]) {
      const { plan, before } = fixture(), fake = server(plan, before, new ApiError(status, 'fixture_failure')), dispatched = vi.fn()
      await expect(executeProductionCompletion(fake.client, actor, plan, signal(), undefined, dispatched)).rejects.toMatchObject({ kind: 'uncertain' }); expect(dispatched).toHaveBeenCalledTimes(1); expect(fake.request).toHaveBeenCalledTimes(1)
      await expect(recoverProductionCompletion(fake.client, actor, plan, signal(), undefined, true)).rejects.toMatchObject({ kind: 'blocked' }); expect(fake.request).toHaveBeenCalledTimes(1)
    }
  })
  it('does not dispatch when the shared reservation expires during preflight', async () => {
    const { plan, before } = fixture(), fake = server(plan, before)
    await expect(executeProductionCompletion(fake.client, actor, plan, signal(), undefined, () => false)).rejects.toMatchObject({ kind: 'blocked' }); expect(fake.request).not.toHaveBeenCalled()
  })
  it('uses the exact actor-scoped immutable laminate receipt even after its physical sources were consumed', async () => {
    const { plan, before } = fixture('laminate'), receipt = response(plan), fake = server(plan, before, receipt, { session: null, sources: [], cut: null })
    await expect(recoverProductionCompletion(fake.client, actor, plan, signal())).resolves.toMatchObject({ kind: 'completed', remainders: expect.any(Array) })
    expect(fake.get).toHaveBeenCalledWith(expect.stringContaining('laminatsiya-astatka'), { apparatus: plan.apparatusId, order_id: orderId, request_id: plan.body.request_id }, expect.any(AbortSignal)); expect(fake.request).not.toHaveBeenCalled()
    ;(receipt.remainders as Row[])[0].remaining_net_kg = 3
    await expect(recoverProductionCompletion(fake.client, actor, plan, signal())).rejects.toMatchObject({ kind: 'uncertain' }); expect(fake.request).not.toHaveBeenCalled()
  })
  it('only retries the unchanged native laminate body after explicit keyed recovery intent', async () => {
    const { plan, before } = fixture('laminate'), fake = server(plan, before)
    fake.get.mockImplementation(async (_path, query) => query?.request_id ? { ok: true, request_result: null } : { ok: true, session: plan.context.session, sources: plan.context.sources, request_result: null })
    expect(await recoverProductionCompletion(fake.client, actor, plan, signal())).toBeNull(); expect(fake.request).not.toHaveBeenCalled()
    await expect(recoverProductionCompletion(fake.client, actor, plan, signal(), undefined, true)).resolves.toMatchObject({ kind: 'completed' })
    expect(fake.request).toHaveBeenCalledWith(plan.path, 'POST', expect.objectContaining({ body: plan.body })); expect(fake.request).toHaveBeenCalledTimes(1)
  })
})

describe('RAM drafts and shared dispatched checkpoints', () => {
  it('restores drafts only for the same stage/session/source revision and clears them on an auth swap', () => {
    const registry = new ProductionCompletionAttemptRegistry(); registry.activate(scope)
    const { plan } = fixture('laminate'), value = { policy: plan.policy, context: plan.context, draft: plan.draft }
    registry.saveDraft(scope, orderId, value); expect(registry.getDraft(scope, orderId, plan.policy)).toEqual(value)
    const restored = registry.getDraft(scope, orderId, plan.policy)!; expect(productionCompletionDraftMatches(restored, plan.policy, plan.context)).toBe(true)
    const changed = structuredClone(plan.context); changed.sources[0].revision++; expect(productionCompletionDraftMatches(restored, plan.policy, changed)).toBe(false)
    registry.activate('other-auth'); expect(registry.getDraft(scope, orderId, plan.policy)).toBeNull()
  })
  it('retains actual dispatched aborts across detail closure, blocks only the same order and rejects changed recovery bodies', async () => {
    const registry = new ProductionCompletionAttemptRegistry(); registry.activate(scope)
    const { plan, before } = fixture('laminate'), lease = registry.begin(scope, plan), fake = server(plan, before), controller = new AbortController()
    fake.request.mockImplementation(async () => { controller.abort(); return response(plan) })
    await expect(executeProductionCompletion(fake.client, actor, plan, controller.signal, undefined, () => registry.dispatched(lease))).rejects.toMatchObject({ name: 'AbortError' })
    registry.interrupt(lease); registry.activate(scope)
    expect(registry.get(scope, orderId)).toMatchObject({ phase: 'uncertain', dispatched: true, plan: { body: plan.body } })
    expect(() => productionOperationLedger.begin(scope, { channel: 'assignment', orderId, plan: {}, proof: {} })).toThrow('Avvalgi amal')
    const unrelated = productionOperationLedger.begin(scope, { channel: 'assignment', orderId: 'another-order', plan: {}, proof: {} }); productionOperationLedger.interrupt(unrelated)
    const changed = structuredClone(plan); changed.body.request_id = 'different-request'; expect(() => registry.begin(scope, changed, true)).toThrow('Avvalgi amal')
    registry.finish(lease, { confirmed: true }); expect(registry.get(scope, orderId)?.phase).toBe('uncertain')
    expect(JSON.stringify(registry.get(scope, orderId))).not.toContain('fixture-only-token')
  })
  it('releases an undispatched preflight cancellation but retains failed recovery reads', () => {
    const registry = new ProductionCompletionAttemptRegistry(); registry.activate(scope)
    const { plan } = fixture('laminate'), preparing = registry.begin(scope, plan)
    registry.interrupt(preparing); expect(registry.get(scope, orderId)).toBeNull()
    const sent = registry.begin(scope, plan); registry.dispatched(sent); registry.interrupt(sent)
    const recovery = registry.begin(scope, plan, true); registry.finish(recovery, { uncertain: false, error: '403' }); expect(registry.get(scope, orderId)?.phase).toBe('uncertain')
  })
  it('blocks a completion preflight while an assignment or legacy write owns that order', async () => {
    for (const channel of ['assignment', 'legacy-control'] as const) {
      productionOperationLedger.activate(`reset-channel-${channel}`); productionOperationLedger.activate(scope)
      const foreign = productionOperationLedger.begin(scope, { channel, orderId, plan: {}, proof: {} }), { plan, before } = fixture(), fake = server(plan, before)
      await expect(executeProductionCompletion(fake.client, actor, plan, signal())).rejects.toMatchObject({ kind: 'blocked' }); expect(fake.productionSnapshot).not.toHaveBeenCalled(); expect(fake.request).not.toHaveBeenCalled()
      productionOperationLedger.interrupt(foreign)
    }
  })
  it('does not retain accidental credentials in draft payloads', () => {
    const registry = new ProductionCompletionAttemptRegistry(); registry.activate(scope)
    const { plan } = fixture('laminate'), ctx = structuredClone(plan.context); ctx.session!.token = 'must-not-persist'
    expect(() => registry.saveDraft(scope, orderId, { policy: plan.policy, context: ctx, draft: plan.draft })).toThrow('kirish ma’lumotlari')
    expect(registry.getDraft(scope, orderId, plan.policy)).toBeNull()
  })
})
