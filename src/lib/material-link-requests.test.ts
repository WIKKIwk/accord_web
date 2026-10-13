import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { ProductionOperationLedger } from './production-operation-ledger'
import {
  executeMaterialLink, isMaterialLinkRequestId, materialLinkApparatusChoices, MaterialLinkAttemptRegistry,
  materialLinkAttempts, materialLinkCanAct, materialLinkCreatePlan, materialLinkDecisionPlan,
  materialLinkPermissions, MATERIAL_LINK_PATH, parseMaterialLinkCandidate, parseMaterialLinkOverview,
  parseMaterialLinkRequest, readMaterialLinkOutcome, readMaterialLinkOverview, readMaterialLinkRequest,
} from './material-link-requests'
import type { MaterialLinkCandidate, MaterialLinkCreatePlan, MaterialLinkDecisionPlan, MaterialLinkPlan, MaterialLinkRequest } from './material-link-requests'

const orderId = 'zakaz-link-fixture', machine = 'apparatus:default:printer-1', scope = 'link-auth-scope'
const client = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-link-fixture' })
const requestId = (value = 1) => `material-link-${String(value).padStart(32, '0')}`
function actor(role = 'aparatchi', ref = 'worker', capabilities = ['admin.access', 'apparatus.queue.manage']): Session { return { token: 'local-link-fixture', profile: { role, ref, display_name: ref }, capabilities, assigned_apparatus: [machine], assigned_apparatus_labels: ['Printer'], assigned_item_groups: [], assigned_warehouses: ['Main'] } }
const manager = () => actor('admin', 'actual-admin', ['admin.access', 'raw_material.assign'])
function roll(barcode = 'RAW-1', mover = 'mover'): MaterialLinkCandidate { return { stock_id: `stock-${barcode}`, barcode, item_name: 'Film', qty: 20, uom: 'kg', location_id: 'native-state', location_name: 'Printer state', placement_version: 3, mover_ref: mover, mover_display_name: mover } }
function request(value = 1, rolls = [roll()], patch: Partial<MaterialLinkRequest> = {}): MaterialLinkRequest { return { request_id: requestId(value), status: 'pending', event_sequence: 1, order_id: orderId, order_number: 'L001', order_title: 'Native order', apparatus_id: machine, apparatus_name: 'Printer', requester_ref: 'worker', requester_display_name: 'Worker', mover_ref: rolls[0].mover_ref, mover_display_name: rolls[0].mover_display_name, candidates: rolls, selected_barcodes: [], decided_by_name: '', decided_by_role: '', decided_at_unix: 0, reason: '', requested_at_unix: 1791889000, expires_at_unix: 1791890800, ...patch } }
function terminal(initial: MaterialLinkRequest, status: MaterialLinkRequest['status'] = 'approved', selected = ['RAW-1'], role = 'admin', name = 'Saved decision maker'): MaterialLinkRequest { return { ...structuredClone(initial), status, event_sequence: initial.event_sequence + 1, selected_barcodes: status === 'approved' ? selected : [], decided_by_name: ['stale', 'expired'].includes(status) ? '' : name, decided_by_role: ['stale', 'expired'].includes(status) ? '' : role, decided_at_unix: 1791889050, reason: status === 'stale' ? 'Rulon holati o‘zgargan' : '' } }
function snapshot(patch: Partial<ProductionSnapshot> = {}): ProductionSnapshot { return { ok: true, epoch: 'fixture-epoch', scope: '', rev: 1, maps: [{ map: { id: orderId, nodes: [{ id: 'work', kind: 'apparatus', apparatus_id: machine, title: 'Print', x: 0, y: 0 }], edges: [] }, program: {} }], order_statuses: { [orderId]: { lifecycle_status: 'released', order_status: 'ready' } }, order_controls: {}, order_customers: {}, stage_states: { [orderId]: { work: 'pending' } }, sequences: { [machine]: [orderId] }, queue_states: { [machine]: { [orderId]: 'pending' } }, queue_action_controls: { [machine]: { [orderId]: { state: 'pending', stage_node_id: 'work', interaction: { start_materials_mode: 'scan_required', material_scan_required: true, assigned_materials_display_only: false } } } }, ...patch } }
function createPlan(rolls = [roll()], saved: MaterialLinkRequest[] = [], native = snapshot()): MaterialLinkCreatePlan { return materialLinkCreatePlan(native, actor(), scope, orderId, machine, { available_count: rolls.length, candidates: rolls, requests: saved }, rolls.map(value => value.barcode)) }
function decisionPlan(action: MaterialLinkDecisionPlan['action'] = 'approve', initial = request(), session = manager(), selected = ['RAW-1']): MaterialLinkDecisionPlan { return materialLinkDecisionPlan(session, scope, { can_decide: session.profile.role !== 'aparatchi', request: initial }, action, action === 'approve' ? selected : []) }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
interface FixtureOptions { candidates?: MaterialLinkCandidate[]; saved?: MaterialLinkRequest[]; current?: ProductionSnapshot; beforeRead?: (url: URL) => void; beforeWrite?: (body: Row) => void; writeStatus?: number; commitOnError?: boolean; loseFirst?: boolean; result?: (value: Row) => unknown; partialGroupFailure?: boolean; decisionRace?: MaterialLinkRequest; canDecide?: boolean; failRead?: number; actor?: Session; }
/** Mock-only native fixture: independent create groups, atomic decision, saved terminal repeat. */
function server(options: FixtureOptions = {}) {
  let writes = 0, sequence = 10
  const saved = structuredClone(options.saved ?? []), nativeCandidates = options.candidates ?? [roll()], bodies: Row[] = []
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(String(input)); expect(url.origin).toBe('http://127.0.0.1:5199')
    if (init.method === 'GET') {
      options.beforeRead?.(url)
      if (options.failRead) return response({ error: 'local_read_denied' }, options.failRead)
      if (url.pathname.endsWith('/production-maps/sequence')) return response(options.current ?? snapshot())
      if (url.pathname !== MATERIAL_LINK_PATH) throw new Error(`Unexpected GET ${url.pathname}`)
      const id = url.searchParams.get('request_id')
      if (id) { const found = saved.find(value => value.request_id === id); return found ? response({ can_decide: options.canDecide ?? ((options.actor ?? manager()).profile.role !== 'aparatchi'), request: found }) : response({ error: 'material_link_not_found' }, 404) }
      expect(url.searchParams.get('order_id')).toBe(orderId); expect(url.searchParams.get('apparatus')).toBe(machine)
      return response({ available_count: nativeCandidates.length, candidates: nativeCandidates, requests: saved.slice(-50).reverse() })
    }
    expect(init.method).toBe('POST'); expect(url.pathname).toBe(MATERIAL_LINK_PATH)
    const body = JSON.parse(String(init.body)) as Row; bodies.push(body); writes++
    options.beforeWrite?.(body)
    let result: Row
    if (body.action === 'create') {
      expect(Object.keys(body).sort()).toEqual(['action', 'apparatus', 'barcodes', 'order_id'])
      const groups = new Map<string, MaterialLinkCandidate[]>()
      for (const value of nativeCandidates.filter(value => (body.barcodes as string[]).includes(value.barcode))) groups.set(value.mover_ref, [...groups.get(value.mover_ref) ?? [], value])
      const created: MaterialLinkRequest[] = []
      if (!options.writeStatus || options.commitOnError || options.partialGroupFailure) for (const [mover, values] of groups) {
        const prior = saved.find(value => value.status === 'pending' && value.mover_ref === mover)
        const next = prior || request(sequence++, values); if (!prior) saved.push(next); created.push(next)
        if (options.partialGroupFailure) return response({ error: 'material_link_store_failed' }, 500)
      }
      result = { requests: created }
    } else {
      expect(Object.keys(body).sort()).toEqual(['action', 'barcodes', 'request_id'])
      const index = saved.findIndex(value => value.request_id === body.request_id)
      if (index < 0) return response({ error: 'material_link_not_found' }, 404)
      if (options.decisionRace) saved[index] = options.decisionRace
      else if (saved[index].status === 'pending' && (!options.writeStatus || options.commitOnError)) saved[index] = terminal(saved[index], body.action === 'approve' ? 'approved' : 'cancelled', body.barcodes as string[], body.action === 'cancel' ? 'aparatchi' : 'admin')
      result = { request: saved[index] }
    }
    if (options.writeStatus) return response({ error: 'local_native_refusal' }, options.writeStatus)
    if (options.loseFirst && writes === 1) throw new TypeError('Local receipt interrupted after commit')
    return response(options.result ? options.result(result) : result)
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, writes: () => writes, saved, bodies }
}
const signal = () => new AbortController().signal
const reserve = (plan: MaterialLinkPlan, recovery = false) => { materialLinkAttempts.activate(scope); return materialLinkAttempts.begin(scope, plan, recovery) }
async function sentFailure(plan: MaterialLinkPlan, session: Session) { const lease = reserve(plan); try { await executeMaterialLink(client, session, plan, lease, signal()); throw new Error('Expected a native failure') } catch (error) { materialLinkAttempts.finish(lease, { error: String(error), uncertain: true }); return lease } }
afterEach(() => { materialLinkAttempts.activate('reset-material-link-tests'); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native actor, candidate and immutable request contracts', () => {
  it('preserves exact native manager membership and separate strict capability gates', () => {
    const saved = request(), detail = { request: saved, can_decide: true }
    expect(materialLinkPermissions(actor('admin', 'admin', ['admin.access'])).create).toBe(false)
    expect(materialLinkCanAct(actor('admin', 'admin', ['admin.access']), detail, 'approve')).toBe(false)
    expect(materialLinkCanAct(manager(), detail, 'approve')).toBe(true)
    expect(materialLinkCanAct(actor('material_taminotchi', 'unrelated', ['raw_material.assign']), detail, 'approve')).toBe(false)
    expect(materialLinkCanAct(actor('material_taminotchi', 'mover', ['raw_material.assign']), detail, 'approve')).toBe(true)
    const unassignedMover = { ...actor('material_taminotchi', 'mover', ['raw_material.assign']), assigned_apparatus: [] }
    expect(materialLinkCanAct(unassignedMover, detail, 'approve')).toBe(false); expect(materialLinkCanAct(unassignedMover, detail, 'reject')).toBe(true)
    expect(materialLinkCanAct(actor(), { ...detail, can_decide: false }, 'cancel')).toBe(true)
    expect(materialLinkCanAct(actor('aparatchi', 'other'), detail, 'cancel')).toBe(false)
    expect(materialLinkPermissions(actor('supplier', 'mover', ['admin.access', 'raw_material.assign'])).read).toBe(false)
  })
  it('does not expose worker overview to admin or unassigned workers, without any HTTP call', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(readMaterialLinkOverview(client, manager(), orderId, machine)).rejects.toMatchObject({ kind: 'forbidden' })
    await expect(readMaterialLinkOverview(client, { ...actor(), assigned_apparatus: [] }, orderId, machine)).rejects.toMatchObject({ kind: 'forbidden' })
    await expect(readMaterialLinkRequest(client, manager(), 'guessed-id')).rejects.toMatchObject({ kind: 'forbidden' })
    expect(fetch).not.toHaveBeenCalled(); expect(isMaterialLinkRequestId(requestId())).toBe(true)
  })
  it('requires complete stock, placement and actual mover source identity, with no quantity edits', () => {
    expect(parseMaterialLinkCandidate(roll())).toEqual(roll())
    for (const patch of [{ stock_id: '' }, { mover_ref: '' }, { qty: 0 }, { qty: NaN }, { placement_version: -1 }, { placement_version: 1.5 }]) expect(() => parseMaterialLinkCandidate({ ...roll(), ...patch })).toThrow()
    expect(() => parseMaterialLinkOverview({ available_count: 2, candidates: [roll()], requests: [] }, actor(), orderId, machine)).toThrow()
    expect(() => parseMaterialLinkOverview({ available_count: 2, candidates: [roll(), { ...roll(), barcode: 'raw-1', stock_id: 'other' }], requests: [] }, actor(), orderId, machine)).toThrow()
    expect(() => parseMaterialLinkOverview({ available_count: 0, candidates: [], requests: [request(1, [roll()], { requester_ref: 'other' })] }, actor(), orderId, machine)).toThrow()
    expect(() => parseMaterialLinkOverview({ available_count: 0, candidates: [], requests: Array.from({ length: 51 }, (_, i) => request(i + 1)) }, actor(), orderId, machine)).toThrow()
  })
  it('rejects bad HTTP200 request statuses, missing lineage and impossible approved subsets', () => {
    for (const patch of [{ request_id: 'foreign' }, { status: 'rejected' }, { apparatus_id: 'Printer' }, { candidates: [{ ...roll(), mover_ref: 'other' }] }, { selected_barcodes: ['RAW-1'] }, { event_sequence: 0 }, { requested_at_unix: 0 }]) expect(() => parseMaterialLinkRequest({ ...request(), ...patch })).toThrow()
    expect(() => parseMaterialLinkRequest(terminal(request(), 'approved', []))).toThrow()
    expect(() => parseMaterialLinkRequest(terminal(request(), 'approved', ['NOT-REQUESTED']))).toThrow()
    expect(() => parseMaterialLinkRequest(terminal(request(), 'approved', ['RAW-1', 'raw-1']))).toThrow()
    expect(parseMaterialLinkRequest(terminal(request(), 'expired'))).toMatchObject({ status: 'expired', decided_by_role: '' })
  })
  it('validates native detail can_decide and selected order even for an admin reader', async () => {
    server({ saved: [request()], canDecide: false })
    await expect(readMaterialLinkRequest(client, manager(), requestId(), signal(), orderId)).rejects.toMatchObject({ code: 'invalid_response' })
    server({ saved: [request()] })
    await expect(readMaterialLinkRequest(client, manager(), requestId(), signal(), 'other-order')).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(readMaterialLinkRequest(client, actor('material_taminotchi', 'other', ['raw_material.assign']), requestId(), signal())).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('follows synchronized start-material flags, active native order and actual apparatus scope', () => {
    expect(materialLinkApparatusChoices(snapshot(), orderId, actor())[0]).toMatchObject({ create: true, stageNodeId: 'work' })
    expect(materialLinkApparatusChoices(snapshot(), orderId, manager())).toEqual([])
    expect(materialLinkApparatusChoices(snapshot({ order_controls: { [orderId]: { state: 'frozen' } } }), orderId, actor())[0].create).toBe(false)
    expect(materialLinkApparatusChoices(snapshot({ order_statuses: { [orderId]: { lifecycle_status: 'released', order_status: 'unknown' } } }), orderId, actor())[0].create).toBe(false)
    for (const state of ['completed', 'frozen', 'unknown']) { const current = snapshot(); current.queue_action_controls[machine][orderId].state = state; current.queue_states[machine][orderId] = state; expect(materialLinkApparatusChoices(current, orderId, actor())[0].create).toBe(false) }
    expect(materialLinkApparatusChoices(snapshot({ queue_action_controls: { [machine]: { [orderId]: { state: 'pending', stage_node_id: 'work', interaction: { start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: true } } } } }), orderId, actor())[0].create).toBe(false)
    const repeated = snapshot(); (repeated.maps[0].map.nodes as Row[]).push({ id: 'repeat', kind: 'apparatus', apparatus_id: machine, title: 'Again', x: 0, y: 0 })
    expect(() => createPlan([roll()], [], repeated)).toThrow('bir nechta bosqichda')
    expect(() => createPlan([roll()], [request()])).toThrow('tasdiq kutilmoqda')
  })
  it('only selects explicit server barcodes; approval cannot add another mover or preselect every roll', () => {
    expect(() => materialLinkCreatePlan(snapshot(), actor(), scope, orderId, machine, { available_count: 1, candidates: [roll()], requests: [] }, [])).toThrow()
    expect(() => materialLinkDecisionPlan(manager(), scope, { can_decide: true, request: request() }, 'approve', ['RAW-1', 'raw-1'])).toThrow()
    expect(() => decisionPlan('approve', request(), manager(), ['OTHER'])).toThrow()
    expect(() => materialLinkDecisionPlan(manager(), scope, { can_decide: true, request: request() }, 'reject', ['RAW-1'])).toThrow()
  })
})

describe('native create, decision and retained outcomes', () => {
  it('creates only selected mover groups and validates every native request receipt', async () => {
    const values = [roll('RAW-1'), roll('RAW-2', 'mover-b')], plan = createPlan(values), fixture = server({ candidates: [...values, roll('UNSELECTED', 'mover-c')] }), lease = reserve(plan)
    const result = await executeMaterialLink(client, actor(), plan, lease, signal())
    expect(result.confirmed).toBe(true); expect(result.requests.map(value => value.mover_ref).sort()).toEqual(['mover', 'mover-b'])
    expect(fixture.writes()).toBe(1); expect(fixture.bodies[0]).toEqual({ action: 'create', order_id: orderId, apparatus: machine, barcodes: ['RAW-1', 'RAW-2'] })
    expect(JSON.stringify(plan)).not.toContain('local-link-fixture')
    materialLinkAttempts.finish(lease, { confirmed: true }); expect(materialLinkAttempts.get(scope, orderId)).toBeNull()
  })
  it('rejects changed placement/mover/quantity before POST; client preflight is honest and unkeyed', async () => {
    for (const patch of [{ placement_version: 4 }, { mover_ref: 'mover-b' }, { qty: 21 }, { uom: 'm' }]) {
      materialLinkAttempts.activate(`reset-${JSON.stringify(patch)}`)
      const plan = createPlan(), fixture = server({ candidates: [{ ...roll(), ...patch }] }), lease = reserve(plan)
      await expect(executeMaterialLink(client, actor(), plan, lease, signal())).rejects.toMatchObject({ kind: 'conflict' }); expect(fixture.writes()).toBe(0)
      materialLinkAttempts.finish(lease, { error: 'native changed', uncertain: false }); expect(materialLinkAttempts.get(scope, orderId)).toBeNull()
    }
    const plan = createPlan(), fixture = server({ current: snapshot({ epoch: 'restarted' }) }), lease = reserve(plan)
    await expect(executeMaterialLink(client, actor(), plan, lease, signal())).rejects.toMatchObject({ kind: 'conflict' }); expect(fixture.writes()).toBe(0)
  })
  it('does not send without a reserved shared lease or after a preflight interrupt', async () => {
    const plan = createPlan(), fixture = server()
    await expect(executeMaterialLink(client, actor(), plan, { scope, generation: 0, channel: 'material-link', orderId, serial: 0, wasUncertain: false }, signal())).rejects.toMatchObject({ kind: 'blocked' })
    const lease = reserve(plan)
    server({ beforeRead: url => { if (url.pathname === MATERIAL_LINK_PATH) materialLinkAttempts.interrupt(lease) } })
    await expect(executeMaterialLink(client, actor(), plan, lease, signal())).rejects.toMatchObject({ kind: 'blocked' })
    expect(fixture.writes()).toBe(0); expect(materialLinkAttempts.get(scope, orderId)).toBeNull()
  })
  it('retains partial group creation and native IDs; bounded matching observations never prove its own create', async () => {
    const values = [roll(), roll('RAW-2', 'mover-b')], plan = createPlan(values), fixture = server({ candidates: values, partialGroupFailure: true })
    await sentFailure(plan, actor()); expect(fixture.saved).toHaveLength(1)
    const lease = reserve(plan, true), result = await readMaterialLinkOutcome(client, actor(), plan, signal())
    expect(result).toMatchObject({ confirmed: false, observed: true }); expect(result.requests).toHaveLength(1)
    materialLinkAttempts.finish(lease, { error: result.message, uncertain: true })
    expect(materialLinkAttempts.observed(scope, orderId).map(value => value.request_id)).toEqual([fixture.saved[0].request_id])
    expect(() => reserve(plan)).toThrow(); expect(fixture.writes()).toBe(1)
  })
  it('retains lost create even when every returned-looking request is visible, with no automatic replay', async () => {
    const plan = createPlan(), fixture = server({ loseFirst: true })
    await sentFailure(plan, actor())
    const lease = reserve(plan, true), result = await readMaterialLinkOutcome(client, actor(), plan, signal())
    expect(result.requests).toHaveLength(1); expect(result.confirmed).toBe(false)
    await expect(executeMaterialLink(client, actor(), plan, lease, signal(), () => true, true)).rejects.toMatchObject({ kind: 'blocked' })
    materialLinkAttempts.finish(lease, { error: result.message, uncertain: true }); expect(fixture.writes()).toBe(1)
  })
  it('keeps valid partial IDs from malformed HTTP200 but rejects the complete success receipt', async () => {
    const values = [roll(), roll('RAW-2', 'mover-b')], plan = createPlan(values)
    server({ candidates: values, result: value => ({ requests: [...(value.requests as MaterialLinkRequest[]).slice(0, 1), { ok: false }] }) })
    await sentFailure(plan, actor())
    expect(materialLinkAttempts.get(scope, orderId)?.phase).toBe('uncertain'); expect(materialLinkAttempts.observed(scope, orderId)).toHaveLength(1)
  })
  it('approves only the selected subset and returns the saved original decision facts', async () => {
    const initial = request(1, [roll(), roll('RAW-2')]), plan = decisionPlan('approve', initial), fixture = server({ saved: [initial] }), lease = reserve(plan)
    const result = await executeMaterialLink(client, manager(), plan, lease, signal())
    expect(result.requests[0]).toMatchObject({ status: 'approved', selected_barcodes: ['RAW-1'], decided_by_name: 'Saved decision maker' })
    expect(fixture.bodies[0]).toEqual({ request_id: initial.request_id, action: 'approve', barcodes: ['RAW-1'] })
    expect(result.message).not.toContain('Siz'); expect(result.confirmed).toBe(true)
  })
  it('reflects a competing terminal approval or refusal rather than falsely reporting the requested action', async () => {
    const initial = request(1, [roll(), roll('RAW-2')]), plan = decisionPlan('approve', initial)
    const race = terminal(initial, 'cancelled', [], 'material_taminotchi', 'Other manager'), fixture = server({ saved: [initial], decisionRace: race }), lease = reserve(plan)
    const result = await executeMaterialLink(client, manager(), plan, lease, signal())
    expect(result.requests[0]).toEqual(race); expect(result.message).toContain('Bekor qilingan'); expect(fixture.writes()).toBe(1)
  })
  it('never POSTs a decision whose fresh native request is already stale, expired or terminal', async () => {
    for (const status of ['stale', 'expired', 'approved', 'cancelled'] as const) {
      materialLinkAttempts.activate(`reset-${status}`)
      const initial = request(), plan = decisionPlan('approve', initial), fixture = server({ saved: [terminal(initial, status)] }), lease = reserve(plan)
      const result = await executeMaterialLink(client, manager(), plan, lease, signal())
      expect(result).toMatchObject({ confirmed: true, observed: true }); expect(result.requests[0].status).toBe(status); expect(fixture.writes()).toBe(0)
      materialLinkAttempts.finish(lease, { confirmed: true })
    }
  })
  it('recovers an exact terminal request after a lost decision, without attributing an actor ref not in the DTO', async () => {
    const plan = decisionPlan(), fixture = server({ saved: [request()], loseFirst: true })
    await sentFailure(plan, manager()); expect(materialLinkAttempts.orderForRequest(scope, requestId())).toBe(orderId)
    const lease = reserve(plan, true), result = await readMaterialLinkOutcome(client, manager(), plan, signal())
    expect(result.confirmed).toBe(true); expect(result.requests[0].decided_by_name).toBe('Saved decision maker')
    expect(Object.hasOwn(result.requests[0], 'decided_by_ref')).toBe(false)
    materialLinkAttempts.finish(lease, { confirmed: true }); expect(fixture.writes()).toBe(1)
  })
  it('permits only an explicit same frozen request decision retry, preserving terminal once-only semantics', async () => {
    const plan = decisionPlan(), fixture = server({ saved: [request()], writeStatus: 500 })
    await sentFailure(plan, manager()); fixture.saved[0] = terminal(request())
    const lease = reserve(plan, true), result = await executeMaterialLink(client, manager(), plan, lease, signal(), () => true, true)
    expect(result).toMatchObject({ confirmed: true, observed: true }); expect(fixture.writes()).toBe(1)
  })
  it('manual retry sends the identical decision body only after pending source facts still match', async () => {
    const options: FixtureOptions = { saved: [request()], writeStatus: 500 }, fixture = server(options), plan = decisionPlan()
    await sentFailure(plan, manager()); expect(fixture.saved[0].status).toBe('pending')
    options.writeStatus = undefined
    const lease = reserve(plan, true), result = await executeMaterialLink(client, manager(), plan, lease, signal(), () => true, true)
    expect(result.confirmed).toBe(true); expect(fixture.bodies).toEqual([plan.body, plan.body]); expect(fixture.writes()).toBe(2)
    materialLinkAttempts.finish(lease, { confirmed: true })
  })
  it('HTTP200 pending/foreign-stock approval remains unknown; rejected recovery does not erase intent', async () => {
    const plan = decisionPlan()
    server({ saved: [request()], result: () => ({ request: request() }) }); await sentFailure(plan, manager())
    expect(materialLinkAttempts.get(scope, orderId)?.phase).toBe('uncertain')
    server({ saved: [request()], failRead: 403 }); const lease = reserve(plan, true)
    await expect(readMaterialLinkOutcome(client, manager(), plan, signal())).rejects.toMatchObject({ status: 403 })
    materialLinkAttempts.finish(lease, { error: 'Forbidden during recovery', uncertain: false }); expect(materialLinkAttempts.get(scope, orderId)?.phase).toBe('uncertain')
  })
  it('rejects a malformed HTTP200 approval with changed stock identity or requested quantity', async () => {
    for (const patch of [{ stock_id: 'foreign-stock' }, { qty: 200 }]) {
      materialLinkAttempts.activate(`reset-${JSON.stringify(patch)}`)
      const plan = decisionPlan(), fixture = server({ saved: [request()], result: value => ({ request: { ...(value.request as MaterialLinkRequest), candidates: [{ ...roll(), ...patch }] } }) })
      await sentFailure(plan, manager()); expect(materialLinkAttempts.get(scope, orderId)?.phase).toBe('uncertain'); expect(fixture.writes()).toBe(1)
    }
  })
  it('refusal and worker cancellation have no selected rolls and preserve actual native cancel actor', async () => {
    for (const action of ['reject', 'cancel'] as const) {
      materialLinkAttempts.activate(`reset-${action}`)
      const session = action === 'cancel' ? actor() : manager(), plan = decisionPlan(action, request(), session), fixture = server({ saved: [request()], actor: session }), lease = reserve(plan)
      const result = await executeMaterialLink(client, session, plan, lease, signal())
      expect(result.requests[0]).toMatchObject({ status: 'cancelled', selected_barcodes: [], decided_by_role: action === 'cancel' ? 'aparatchi' : 'admin' }); expect(fixture.bodies[0].barcodes).toEqual([])
      materialLinkAttempts.finish(lease, { confirmed: true })
    }
  })
})

describe('RAM registry interruption, shared ownership and session generation', () => {
  it('survives close/remount, blocks another channel and retires drafts and IDs across authentication scope', () => {
    const ledger = new ProductionOperationLedger(), registry = new MaterialLinkAttemptRegistry(ledger), plan = decisionPlan()
    registry.activate(scope); registry.saveDraft(scope, orderId, { apparatusId: machine, barcodes: ['RAW-1'], requestId: requestId() })
    const lease = registry.begin(scope, plan); ledger.dispatched(lease); registry.interrupt(lease)
    expect(registry.get(scope, orderId)).toMatchObject({ phase: 'uncertain', plan }); expect(registry.orderForRequest(scope, requestId())).toBe(orderId)
    expect(() => ledger.begin(scope, { channel: 'assignment', orderId, plan: { action: 'start' }, proof: {} })).toThrow()
    expect(() => registry.saveDraft(scope, orderId, { apparatusId: machine, barcodes: [], requestId: requestId() })).toThrow()
    registry.finish(lease, { confirmed: true }); expect(registry.get(scope, orderId)?.phase).toBe('uncertain')
    registry.activate('new-auth-scope'); expect(registry.get(scope, orderId)).toBeNull(); expect(registry.orderForRequest(scope, requestId())).toBeUndefined(); expect(registry.draft('new-auth-scope', orderId).barcodes).toEqual([])
    expect(ledger.dispatched(lease)).toBe(false)
  })
  it('unsent abort clears initial intent; changed frozen recovery cannot replace a sent request', () => {
    const ledger = new ProductionOperationLedger(), registry = new MaterialLinkAttemptRegistry(ledger), plan = createPlan()
    registry.activate(scope); const first = registry.begin(scope, plan); registry.interrupt(first); expect(registry.get(scope, orderId)).toBeNull()
    const second = registry.begin(scope, plan); ledger.dispatched(second); registry.interrupt(second)
    expect(() => registry.begin(scope, { ...plan, body: { ...plan.body, barcodes: ['OTHER'] } }, true)).toThrow()
    expect(registry.get(scope, orderId)?.plan.body.barcodes).toEqual(['RAW-1'])
  })
  it('a late response after post-dispatch interruption cannot clear unknown or overwrite recovery observations', async () => {
    const plan = createPlan(), lease = reserve(plan)
    const fixture = server({ beforeWrite: () => materialLinkAttempts.interrupt(lease) })
    await expect(executeMaterialLink(client, actor(), plan, lease, signal())).rejects.toMatchObject({ kind: 'uncertain' })
    materialLinkAttempts.finish(lease, { confirmed: true })
    expect(materialLinkAttempts.get(scope, orderId)?.phase).toBe('uncertain'); expect(materialLinkAttempts.observed(scope, orderId)).toEqual([]); expect(fixture.writes()).toBe(1)
  })
  it('a new authentication generation cancels preflight without issuing any business write', async () => {
    const plan = createPlan(), lease = reserve(plan)
    const fixture = server({ beforeRead: url => { if (url.pathname === MATERIAL_LINK_PATH) materialLinkAttempts.activate('different-auth-generation') } })
    await expect(executeMaterialLink(client, actor(), plan, lease, signal())).rejects.toMatchObject({ kind: 'blocked' })
    expect(fixture.writes()).toBe(0); expect(materialLinkAttempts.get(scope, orderId)).toBeNull()
  })
})
