import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, record } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { productionOperationLedger } from './production-operation-ledger'
import {
  executeMaterialIntake, materialIntakeAttempts, materialIntakeCommand, materialIntakeMaterials,
  materialIntakePermissions, materialIntakePolicies, parseIntakeAssignment,
  parseMaterialDeliveryPreview, parseMaterialStartRequirements, readMaterialIntakeOutcome,
} from './material-intake'
import type { IntakeAssignment, MaterialDeliveryPreview, MaterialIntakeCommand, MaterialIntakeMaterials, MaterialIntakeStock } from './material-intake'

const base = '/v1/mobile/admin', orderId = 'order:intake-fixture', machine = 'apparatus:default:printer-1', scope = 'material-intake-auth-scope'
const client = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-material-test' })
const actor = (caps = ['admin.access', 'apparatus.queue.manage'], role = 'admin', assigned = [machine]): Session => ({ token: 'local-material-test', profile: { role, ref: 'fixture-receiver', display_name: 'Receiver' }, capabilities: caps, assigned_apparatus: assigned, assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: ['Main'] })
const apparatus: Row = { apparatus_id: machine, source_revision: 3, source_aasx_sha256: 'a'.repeat(64), display: { display_name: 'Printer' }, lifecycle: { state: 'active' }, execution_profile: { operation: 'print', technology: 'rotogravure' }, capabilities: { print: 2 } }
function snapshot(state = 'in_progress', patch: Partial<ProductionSnapshot> = {}): ProductionSnapshot {
  const interaction = { mode: state === 'pending' ? 'fresh_start' : state, start_materials_mode: state === 'pending' ? 'scan_required' : 'hidden', material_scan_required: state === 'pending', assigned_materials_display_only: false, material_intake_allowed: state !== 'pending', resume_input_required: false, previous_wip_mode: 'not_required', opening_wip_mode: 'not_required', qolip_mode: 'not_required' }
  return { ok: true, epoch: 'fixture-epoch', rev: 1, scope: '', maps: [{ map: { id: orderId, nodes: [{ id: 'work', kind: 'apparatus', apparatus_id: machine, title: 'Print', x: 0, y: 0 }], edges: [] }, program: {} }], order_statuses: { [orderId]: { lifecycle_status: state === 'pending' ? 'released' : 'in_progress', order_status: state === 'pending' ? 'ready' : state } }, order_controls: {}, order_customers: {}, sequences: { [machine]: [orderId] }, queue_states: { [machine]: { [orderId]: state } }, stage_states: { [orderId]: { work: state } }, queue_action_controls: { [machine]: { [orderId]: { state, stage_node_id: 'work', interaction, allowed_actions: state === 'pending' ? ['start'] : ['pause', 'complete'], ...(state === 'pending' ? {} : { work_activity: { state, worker_role: 'aparatchi', worker_ref: 'actual-run-owner' } }) } } }, ...patch }
}
function assignment(staged = true, status = 'available'): IntakeAssignment {
  const received = status === 'in_use'
  return { order_id: orderId, apparatus_id: machine, barcode: 'RAW-1', item_code: 'FILM', item_name: 'PET film', item_group: 'Rulon', assigned_at: '2026-10-13T14:00:00Z', assigned_by_role: 'material_taminotchi', assigned_by_ref: 'original-assignee', stock_status: status, execution_status: received ? 'in_use' : staged ? 'ready' : 'awaiting_delivery', stock_warehouse: 'Main', stock_uom: 'kg', reserved_order_id: received ? orderId : '', stock_qty: 20, received_qty: received ? 20 : 0, consumed_qty: 0, remaining_qty: received ? 20 : 0, roll_width_mm: 1015 }
}
const stock: MaterialIntakeStock = { barcode: 'RAW-1', warehouse: 'Main', item_code: 'FILM', qty: 20, uom: 'kg', source_receipt_id: 'source-receipt-1' }
const deliverer = { role: 'werka', ref: 'actual-deliverer', name: 'Actual warehouse mover' }
function materials(staged = true, state = 'in_progress'): MaterialIntakeMaterials {
  return { assignments: [assignment(staged)], candidates: state === 'pending' ? [] : [assignment(staged)], requirements: { staged: staged ? ['RAW-1'] : [], required: 1, matched: 0, materialScanRequired: state === 'pending', assignmentsSatisfied: true, scanSatisfied: false } }
}
function plan(action: 'intake' | 'delivery' = 'intake', current = snapshot(action === 'delivery' ? 'pending' : 'in_progress'), session = actor()): MaterialIntakeCommand {
  const staged = action === 'intake', state = String(current.queue_states[machine]?.[orderId])
  return materialIntakeCommand(current, orderId, session, scope, [apparatus], machine, materials(staged, state), stock, { alreadyAtApparatus: staged, deliverers: [deliverer] }, action, ' raw-1 ', action === 'delivery' ? deliverer : undefined, 'frozen-native-delivery-key')
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
interface FixtureOptions {
  state?: string; staged?: boolean; status?: string; current?: ProductionSnapshot; meta?: Row
  stock?: Partial<MaterialIntakeStock>; candidates?: unknown; preview?: unknown; writeStatus?: number
  writeResponse?: (value: unknown) => unknown; commitOnError?: boolean; loseFirst?: boolean
  failAfterWrite?: number; missingPlacement?: boolean; history?: (events: Row[]) => unknown
  onRead?: (path: string) => void; onWrite?: () => void; retireControlAfterWrite?: boolean; afterAssignment?: Partial<IntakeAssignment>
}
/** Local-only handlers: delivery uses native keys; intake has no replay receipt. */
function server(options: FixtureOptions = {}) {
  const state = options.state ?? 'in_progress'
  let staged = options.staged ?? true, status = options.status ?? 'available', writes = 0
  const events: Row[] = [], keys = new Map<string, string>()
  const current = () => ({ ...(options.current ?? snapshot(state)), ...(writes && options.retireControlAfterWrite ? { maps: [], queue_action_controls: {}, queue_states: {} } : {}), rev: writes + 1 })
  const enriched = () => ({ ...assignment(staged, status), ...(writes ? options.afterAssignment : {}) })
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, get = init.method === 'GET'
    if (get) {
      options.onRead?.(path)
      if (writes && options.failAfterWrite) return response({ error: 'local_read_denied' }, options.failAfterWrite)
      if (path === `${base}/production-maps/sequence`) return response(current())
      if (path === `${base}/apparatus/${encodeURIComponent(machine)}`) return response(options.meta ?? apparatus)
      if (path === `${base}/raw-material-assignments`) return response([enriched()])
      if (path === `${base}/raw-material-intake-candidates`) return response(options.candidates ?? (status === 'available' && ['in_progress', 'paused'].includes(state) ? [enriched()] : []))
      if (path === `${base}/raw-material-start-requirements`) return response({ material_scan_required: state === 'pending', assignments_satisfied: true, scan_satisfied: false, required_scan_count: 1, matched_scan_count: 0, staged_barcodes: staged ? ['RAW-1'] : [] })
      if (path === `${base}/raw-material-start-receipt`) return status === 'available' ? response(options.preview ?? { already_at_apparatus: staged, deliverers: [deliverer] }) : response({ error: 'raw_material_stock_unavailable' }, 409)
      if (path === `${base}/raw-material-history`) { expect(url.searchParams.get('limit')).toBe('200'); expect(url.searchParams.get('event_type')).toBe('delivery_received'); return response(options.history ? options.history(events) : events) }
      if (path === `${base}/raw-material-assignments/lookup`) return response({ ...stock, ...options.stock, status, reserved_order_id: status === 'in_use' ? orderId : '', assignment: enriched(), order: current().maps[0].map, queue_states: current().queue_states, logs: [] })
      throw new Error(`Unexpected local GET ${path}`)
    }
    if (init.method !== 'POST' || ![`${base}/raw-material-intake`, `${base}/raw-material-start-receipt`].includes(path)) throw new Error(`Unexpected local write ${path}`)
    writes++
    const body = JSON.parse(String(init.body)) as Row
    let result: unknown
    if (path.endsWith('/raw-material-intake')) {
      if (!staged) return response({ error: 'raw_material_state_not_ready' }, 400)
      if (status !== 'available') return response({ error: 'raw_material_stock_unavailable' }, 400)
      if (!options.writeStatus || options.commitOnError) status = 'in_use'
      result = enriched()
    } else {
      const key = String(body.idempotency_key), frozen = JSON.stringify(body)
      if (keys.has(key) && keys.get(key) !== frozen) return response({ error: 'inventory_idempotency_conflict' }, 409)
      if (!options.writeStatus || options.commitOnError) {
        if (!keys.has(key)) {
          keys.set(key, frozen)
          events.push({ event_id: 'delivery-event-1', event_type: 'delivery_received', source_type: 'material_delivery', source_id: key, correlation_id: key, order_id: orderId, apparatus: machine, barcode: 'RAW-1', warehouse: 'Main', item_code: 'FILM', uom: 'kg', qty_delta: 0, actor_role: 'admin', actor_ref: 'fixture-receiver', occurred_at_unix: 1791890000, payload_json: { order_id: orderId, apparatus_id: machine, delivered_by: deliverer, received_by: { role: 'admin', ref: 'fixture-receiver', name: 'Receiver' } } })
        }
        staged = !options.missingPlacement
      }
      result = { ok: true, barcode: 'RAW-1', apparatus: machine }
    }
    options.onWrite?.()
    if (options.writeStatus) return response({ error: 'local_native_refusal' }, options.writeStatus)
    if (options.loseFirst && writes === 1) throw new TypeError('Local response lost after persistence')
    return response(options.writeResponse ? options.writeResponse(result) : result)
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, writes: () => writes, eventCount: () => events.length, status: () => status }
}
const signal = () => new AbortController().signal
function reserve(command: MaterialIntakeCommand, recovery = false) { materialIntakeAttempts.activate(scope); return materialIntakeAttempts.begin(scope, command, recovery) }
afterEach(() => { productionOperationLedger.activate('reset-material-tests'); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native material permission, stage and source contract', () => {
  it('requires queue.manage even for admin and respects actual apparatus assignment scope', () => {
    expect(materialIntakePermissions(actor(['admin.access'])).manage).toBe(false)
    expect(() => plan('intake', snapshot(), actor(['admin.access']))).toThrow('apparatus.queue.manage')
    expect(materialIntakePolicies(snapshot(), orderId, actor(undefined, 'admin', []), [apparatus])[0]).toMatchObject({ intake: false, delivery: true })
    expect(materialIntakePolicies(snapshot(), orderId, actor(['apparatus.queue.manage'], 'werka'), [apparatus])[0]).toMatchObject({ delivery: false })
    expect(materialIntakePolicies(snapshot(), orderId, actor(['apparatus.queue.manage'], 'aparatchi', []), [apparatus])[0]).toMatchObject({ intake: false, delivery: false })
  })

  it('uses actual interaction flags and denies frozen, completed, unknown, repeated or cutting intake', () => {
    expect(materialIntakePolicies(snapshot('paused'), orderId, actor(), [apparatus])[0].intake).toBe(true)
    for (const current of [snapshot('in_progress', { order_controls: { [orderId]: { state: 'frozen' } } }), snapshot('in_progress', { order_statuses: { [orderId]: { lifecycle_status: 'production_completed', order_status: 'completed' } } }), snapshot('future-state')]) expect(materialIntakePolicies(current, orderId, actor(), [apparatus])[0].intake).toBe(false)
    const repeated = snapshot(); (repeated.maps[0].map.nodes as Row[]).push({ id: 'work-again', kind: 'apparatus', apparatus_id: machine, title: 'Again', x: 0, y: 100 })
    expect(materialIntakePolicies(repeated, orderId, actor(), [apparatus])[0]).toMatchObject({ intake: false, delivery: false, bound: false })
    const flags = snapshot(); record(flags.queue_action_controls[machine][orderId].interaction).material_intake_allowed = false
    expect(materialIntakePolicies(flags, orderId, actor(), [apparatus])[0].intake).toBe(false)
    expect(materialIntakePolicies(snapshot(), orderId, actor(), [{ ...apparatus, execution_profile: { operation: 'cut' } }])[0].intake).toBe(false)
  })

  it('rejects incomplete reads and requires exact scan, native material, warehouse and deliverer identities', () => {
    expect(() => parseMaterialDeliveryPreview({ ok: true })).toThrow()
    expect(() => parseMaterialDeliveryPreview({ already_at_apparatus: false, deliverers: [deliverer, deliverer] })).toThrow()
    expect(() => parseMaterialStartRequirements({ staged_barcodes: ['RAW-1'], material_scan_required: true, assignments_satisfied: true, scan_satisfied: true, required_scan_count: 2, matched_scan_count: 1 })).toThrow()
    expect(() => parseIntakeAssignment({ ...assignment(), apparatus_id: 'Printer' }, orderId, machine)).toThrow()
    const current = snapshot('pending'), preview: MaterialDeliveryPreview = { alreadyAtApparatus: false, deliverers: [deliverer] }
    const args = [current, orderId, actor(), scope, [apparatus], machine, materials(false, 'pending'), stock, preview] as const
    expect(() => materialIntakeCommand(...args, 'delivery', 'other-barcode', deliverer)).toThrow('shtrixkod')
    expect(() => materialIntakeCommand(...args, 'delivery', 'RAW-1', { ...deliverer, ref: 'guessed' })).toThrow('xodim')
    expect(() => materialIntakeCommand(snapshot(), orderId, actor(), scope, [apparatus], machine, materials(), { ...stock, warehouse: 'Other' }, { alreadyAtApparatus: true, deliverers: [] }, 'intake', 'RAW-1')).toThrow('ombori')
    expect(() => materialIntakeCommand(snapshot(), orderId, actor(), scope, [apparatus], machine, materials(), stock, { alreadyAtApparatus: false, deliverers: [] }, 'intake', 'RAW-1')).toThrow('yetkazilgani')
  })

  it('rejects candidate rows outside their requested context or missing from the actual assignment list', async () => {
    const policy = materialIntakePolicies(snapshot(), orderId, actor(), [apparatus])[0]
    server({ candidates: [{ ...assignment(), order_id: 'other-order' }] })
    await expect(materialIntakeMaterials(client, orderId, policy)).rejects.toMatchObject({ code: 'invalid_response' })
    server({ candidates: [assignment(), assignment()] })
    await expect(materialIntakeMaterials(client, orderId, policy)).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('shared order reservation and real transport receipts', () => {
  it('requires shared ownership before the first preflight read and blocks foreign same-order operations', async () => {
    const command = plan(), local = server()
    materialIntakeAttempts.activate(scope)
    productionOperationLedger.begin(scope, { channel: 'completion', orderId, plan: { native: 'other-owner' }, proof: {} })
    await expect(executeMaterialIntake(client, actor(), command, { scope, generation: 0, channel: 'material-intake', orderId, serial: 0, wasUncertain: false }, signal())).rejects.toMatchObject({ kind: 'blocked' })
    expect(local.fetch).not.toHaveBeenCalled()
    expect(() => materialIntakeAttempts.begin(scope, command)).toThrow()
  })

  it('sends only the three intake fields and validates actual stock binding without inventing a session receipt', async () => {
    const command = plan(), local = server(), lease = reserve(command)
    const saved = await executeMaterialIntake(client, actor(), command, lease, signal())
    const write = local.fetch.mock.calls.find(([, init]) => init.method === 'POST')!
    expect(JSON.parse(String(write[1].body))).toEqual({ order_id: orderId, apparatus: machine, barcode: 'RAW-1' })
    expect(saved).toMatchObject({ observed: false, sessionConfirmed: false, assignment: { stock_status: 'in_use', execution_status: 'in_use', received_qty: 20, remaining_qty: 20, reserved_order_id: orderId } })
    expect(local.writes()).toBe(1)
    materialIntakeAttempts.finish(lease, { confirmed: true })
    expect(productionOperationLedger.get(scope, orderId)).toBeNull()
  })

  it('uses the native delivery key and checks real placement after the small acknowledgment', async () => {
    const command = plan('delivery'), local = server({ state: 'pending', staged: false }), lease = reserve(command)
    const saved = await executeMaterialIntake(client, actor(), command, lease, signal())
    const body = JSON.parse(String(local.fetch.mock.calls.find(([, init]) => init.method === 'POST')![1].body))
    expect(body).toEqual({ order_id: orderId, apparatus: machine, barcode: 'RAW-1', delivered_by_role: deliverer.role, delivered_by_ref: deliverer.ref, idempotency_key: command.key })
    expect(saved.assignment?.execution_status).toBe('ready')
    expect(saved.sessionConfirmed).toBe(false)
    expect(local.eventCount()).toBe(1)
  })

  it('does not reuse an already-dispatched lease as a new write while the first receipt is still owned', async () => {
    const command = plan(), local = server(), lease = reserve(command)
    await executeMaterialIntake(client, actor(), command, lease, signal())
    const requests = local.fetch.mock.calls.length
    await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toMatchObject({ kind: 'blocked' })
    expect(local.fetch.mock.calls).toHaveLength(requests)
    expect(local.writes()).toBe(1)
  })

  it('does not dispatch when custody, quantity, stage, epoch, auth scope or canonical revision became stale', async () => {
    const command = plan()
    for (const options of [{ stock: { warehouse: 'Other' } }, { stock: { qty: 21 } }, { current: snapshot('in_progress', { epoch: 'other-epoch' }) }, { current: snapshot('in_progress', { scope: 'other-scope' }) }, { meta: { ...apparatus, source_revision: 4 } }]) {
      productionOperationLedger.activate('clear-between-stale-cases')
      const local = server(options), lease = reserve(command)
      await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toThrow()
      expect(local.writes()).toBe(0)
      materialIntakeAttempts.finish(lease, { error: 'preflight rejected', uncertain: false })
      expect(productionOperationLedger.get(scope, orderId)).toBeNull()
    }
  })

  it('checks that its reservation is still live immediately before dispatch', async () => {
    const command = plan(), lease = reserve(command)
    const local = server({ onRead: () => { materialIntakeAttempts.interrupt(lease) } })
    await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toMatchObject({ kind: 'blocked' })
    expect(local.writes()).toBe(0)
  })

  it('rejects generic or mismatched HTTP200 intake responses after dispatch', async () => {
    for (const writeResponse of [() => ({ ok: true }), (value: unknown) => ({ ...record(value), apparatus_id: 'apparatus:default:other' }), (value: unknown) => ({ ...record(value), received_qty: 10 }), (value: unknown) => ({ ...record(value), stock_status: 'available' }), (value: unknown) => ({ ...record(value), reserved_order_id: 'other-order' }), (value: unknown) => ({ ...record(value), assigned_by_ref: 'different-original-assignment' })]) {
      productionOperationLedger.activate('reset-malformed-receipt')
      const command = plan(), local = server({ writeResponse }), lease = reserve(command)
      await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toMatchObject({ kind: 'uncertain' })
      expect(local.writes()).toBe(1)
    }
  })

  it('keeps bad delivery acknowledgments, missing placement, and denied post-write reads uncertain', async () => {
    for (const options of [{ writeResponse: () => ({ ok: true, barcode: 'WRONG', apparatus: machine }) }, { missingPlacement: true }, { afterAssignment: { stock_status: 'in_use', execution_status: 'ready', reserved_order_id: orderId } }, { failAfterWrite: 403 }, { failAfterWrite: 503 }]) {
      productionOperationLedger.activate('reset-delivery-receipt')
      const command = plan('delivery'), local = server({ ...options, state: 'pending', staged: false }), lease = reserve(command)
      await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toMatchObject({ kind: 'uncertain' })
      expect(local.writes()).toBe(1)
      materialIntakeAttempts.finish(lease, { error: 'No exact receipt', uncertain: true })
      expect(materialIntakeAttempts.get(scope, orderId)?.phase).toBe('uncertain')
    }
  })

  it('retains every dispatched native 400/403/409/500 failure and handles a partial fallback outcome', async () => {
    for (const writeStatus of [400, 403, 409, 500]) {
      productionOperationLedger.activate('reset-native-failure')
      const command = plan(), local = server({ writeStatus, commitOnError: writeStatus === 400 }), lease = reserve(command)
      await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toMatchObject({ kind: 'uncertain' })
      materialIntakeAttempts.finish(lease, { error: 'Native refusal after dispatch', uncertain: false })
      expect(materialIntakeAttempts.get(scope, orderId)?.phase).toBe('uncertain')
      if (writeStatus === 400) {
        const read = reserve(command, true)
        expect(await readMaterialIntakeOutcome(client, actor(), command, signal())).toMatchObject({ observed: true, sessionConfirmed: false })
        materialIntakeAttempts.finish(read, { confirmed: true })
      }
      expect(local.writes()).toBe(1)
    }
  })
})

describe('lost receipts, bounded evidence and interrupted recovery', () => {
  it('recovers lost intake as observed exact current stock binding without replay or session attribution', async () => {
    const command = plan(), local = server({ loseFirst: true }), lease = reserve(command)
    await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toMatchObject({ kind: 'uncertain' })
    materialIntakeAttempts.finish(lease, { error: 'Lost after persistence', uncertain: true })
    const read = reserve(command, true)
    expect(await readMaterialIntakeOutcome(client, actor(), command, signal())).toMatchObject({ observed: true, sessionConfirmed: false })
    expect(local.writes()).toBe(1)
    materialIntakeAttempts.finish(read, { confirmed: true })
  })

  it('does not replay unkeyed intake when unchanged readback cannot prove rollback', async () => {
    const command = plan(), local = server({ writeStatus: 503 }), lease = reserve(command)
    await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toThrow()
    materialIntakeAttempts.finish(lease, { error: 'Unknown', uncertain: true })
    const read = reserve(command, true)
    expect(await readMaterialIntakeOutcome(client, actor(), command, signal())).toBeNull()
    await expect(executeMaterialIntake(client, actor(), command, read, signal(), undefined, true)).rejects.toThrow('Unkeyed')
    expect(local.writes()).toBe(1)
  })

  it('does not interpret a missing source receipt field as a legitimate empty legacy source during recovery', async () => {
    const command = plan(); command.stock.source_receipt_id = ''
    server({ status: 'in_use', stock: { source_receipt_id: undefined } }); reserve(command)
    await expect(readMaterialIntakeOutcome(client, actor(), command, signal())).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('recovers exact delivery correlation and refuses another key, actor, warehouse, order or deliverer', async () => {
    for (const field of ['source_id', 'actor_ref', 'warehouse', 'order_id', 'deliverer']) {
      productionOperationLedger.activate('reset-history-evidence')
      const command = plan('delivery'), local = server({ state: 'pending', staged: false, loseFirst: true, history: events => events.map(event => field === 'deliverer' ? { ...event, payload_json: { ...record(event.payload_json), delivered_by: { ...deliverer, ref: 'wrong' } } } : { ...event, [field]: 'wrong' }) }), lease = reserve(command)
      await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toThrow()
      materialIntakeAttempts.finish(lease, { error: 'Lost', uncertain: true }); reserve(command, true)
      expect(await readMaterialIntakeOutcome(client, actor(), command, signal())).toBeNull()
      expect(local.writes()).toBe(1)
    }
    productionOperationLedger.activate('reset-history-valid')
    const command = plan('delivery'), local = server({ state: 'pending', staged: false, loseFirst: true }), lease = reserve(command)
    await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toThrow()
    materialIntakeAttempts.finish(lease, { error: 'Lost', uncertain: true }); reserve(command, true)
    expect(await readMaterialIntakeOutcome(client, actor(), command, signal())).toMatchObject({ observed: true, deliveryRecordId: 'delivery-event-1' })
    expect(local.writes()).toBe(1)
  })

  it('does not treat placement alone or a missing bounded event as the exact old receipt; explicit retry keeps the same key', async () => {
    const command = plan('delivery'), local = server({ state: 'pending', staged: false, loseFirst: true, history: () => [] }), lease = reserve(command)
    await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toThrow()
    materialIntakeAttempts.finish(lease, { error: 'Lost', uncertain: true })
    const retry = reserve(command, true)
    expect(await readMaterialIntakeOutcome(client, actor(), command, signal())).toBeNull()
    expect(await executeMaterialIntake(client, actor(), command, retry, signal(), undefined, true)).toMatchObject({ observed: false })
    const bodies = local.fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([, init]) => JSON.parse(String(init.body)))
    expect(bodies).toEqual([command.body, command.body])
    expect(local.eventCount()).toBe(1)
  })

  it('accepts the exact durable delivery record after the order leaves the active queue without claiming current placement', async () => {
    const command = plan('delivery'), local = server({ state: 'pending', staged: false, loseFirst: true, retireControlAfterWrite: true }), lease = reserve(command)
    await expect(executeMaterialIntake(client, actor(), command, lease, signal())).rejects.toThrow()
    materialIntakeAttempts.finish(lease, { error: 'Lost receipt', uncertain: true }); reserve(command, true)
    const observed = await readMaterialIntakeOutcome(client, actor(), command, signal())
    expect(observed).toMatchObject({ observed: true, deliveryRecordId: 'delivery-event-1', sessionConfirmed: false })
    expect(observed?.assignment).toBeUndefined()
    expect(local.writes()).toBe(1)
  })

  it('retains the frozen request through post-dispatch abort/unmount and rejected recovery', async () => {
    const command = plan(), controller = new AbortController(), lease = reserve(command)
    const local = server({ onWrite: () => { controller.abort(); materialIntakeAttempts.interrupt(lease) } })
    await expect(executeMaterialIntake(client, actor(), command, lease, controller.signal)).rejects.toThrow()
    materialIntakeAttempts.finish(lease, { confirmed: true })
    expect(materialIntakeAttempts.get(scope, orderId)).toMatchObject({ phase: 'uncertain', plan: command })
    const recovery = reserve(command, true)
    materialIntakeAttempts.finish(recovery, { error: '403 recovery denied', uncertain: false })
    expect(materialIntakeAttempts.get(scope, orderId)?.phase).toBe('uncertain')
    expect(local.writes()).toBe(1)
    expect(() => reserve({ ...command, key: 'changed-intent' }, true)).toThrow()
  })

  it('retains unsent drafts, blocks changes during same-order operations and drops retired auth generations', () => {
    materialIntakeAttempts.activate(scope)
    const draft = { apparatusId: machine, barcode: 'RAW-1', scanned: 'raw-1', delivererKey: '' }
    materialIntakeAttempts.saveDraft(scope, orderId, draft)
    expect(materialIntakeAttempts.draft(scope, orderId)).toEqual(draft)
    const command = plan(), lease = reserve(command)
    expect(() => materialIntakeAttempts.saveDraft(scope, orderId, { ...draft, scanned: 'other' })).toThrow()
    materialIntakeAttempts.interrupt(lease)
    expect(productionOperationLedger.get(scope, orderId)).toBeNull()
    materialIntakeAttempts.activate('other-session')
    materialIntakeAttempts.activate(scope)
    expect(materialIntakeAttempts.draft(scope, orderId).barcode).toBe('')
    materialIntakeAttempts.finish(lease, { error: 'Old callback', uncertain: true })
    expect(materialIntakeAttempts.get(scope, orderId)).toBeNull()
  })
})
