import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import {
  APPARATUS_PLANNING_API_LIMITATIONS, ApparatusPlanningApi, PlanningConflict, PlanningSaveUnknown,
  apparatusPlanningError, apparatusPlanningPermissions, isPlanningApparatusId, parsePlanningCapacity,
  parsePlanningDowntime, parsePlanningReservation, planningApparatusId, planningCapacityForm,
  planningCapacityInput, planningDowntimeOperation, planningOrderId, planningOrderPolicy,
  planningPatchOperation, planningQueuePolicyLocked, planningReservedMinutes, planningScheduleOperation, planningUtcUnix,
} from './apparatus-planning'
import type { ApparatusPlanningSnapshot, PlanningCapacity, PlanningDiscipline, PlanningScheduleOperation } from './apparatus-planning'

const id = 'apparatus:default:asset-001', secondId = 'apparatus:default:asset-002', orderId = 'order:001'
const actor = (capabilities = ['admin.access'], role = 'admin', ref = 'admin'): Session => ({ token: 'test-token', profile: { role, ref, display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const service = (session = actor()) => new ApparatusPlanningApi(new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), session)
const actorRow = { role: 'admin', ref: 'admin', display_name: 'Operator' }
const source = { apparatus_id: id, source_revision: 3, source_aasx_sha256: 'a'.repeat(64) }
const capacityInput = (overrides: Partial<PlanningCapacity> = {}): PlanningCapacity => ({ capacity_slots: 1, setup_minutes: 5, cleanup_minutes: 5, efficiency_percent: 100, finite_capacity: true, availability: { mode: 'always' }, ...overrides })
const capacity = (overrides: Row = {}) => ({ ...source, capacity_slots: 1, setup_minutes: 5, cleanup_minutes: 5, efficiency_percent: 100, finite_capacity: true, always_available: true, working_windows: [], ...overrides })
const projection = (overrides: Row = {}) => ({ ...source, display: { display_name: 'Bosma 01' }, execution_profile: { operation: 'cut' }, lifecycle: { state: 'active' }, capabilities: { print: 3, cut: 3, tooling: 1 }, ...overrides })
const queue = (overrides: Row = {}) => ({ ...source, discipline: 'strict_sequence', ...overrides })
const orders = (): ProductionSnapshot => ({ ok: true, epoch: 'production-epoch', rev: 3, scope: 'all', maps: [{ map: { id: orderId, nodes: [{ id: 'print', kind: 'apparatus', apparatus_id: id }, { id: 'end', kind: 'end' }], edges: [{ from: 'print', to: 'end' }] }, program: {} }], order_statuses: { [orderId]: { lifecycle_status: 'released', order_status: 'not_started', work_status: 'not_started', flow_status: 'not_started' } }, order_controls: {}, order_customers: { [orderId]: 'Acme' }, sequences: { [id]: [orderId] }, queue_states: { [id]: { [orderId]: 'pending' } }, stage_states: {}, queue_action_controls: {} })
const snapshot = (): ApparatusPlanningSnapshot => ({ apparatus: { ...source, name: 'Bosma 01', operation: 'cut', active: true, capabilities: { print: 3, cut: 3, tooling: 1 } }, capacity: parsePlanningCapacity(capacity()), policy: { ...source, discipline: 'strict_sequence' } })
const scheduleOperation = (): PlanningScheduleOperation => planningScheduleOperation(snapshot(), orders(), { orderId, start: '2026-10-13T10:00', end: '2026-10-13T13:00', duration: '60', priority: '2', reason: 'Yetkazish muddati', requirements: [{ code: 'print', min_level: 2 }] })
function reservation(operation: PlanningScheduleOperation, overrides: Row = {}) {
  const body = operation.body
  return { reservation_id: `apparatus-reservation:${body.idempotency_key}`, idempotency_key: body.idempotency_key, order_id: body.order_id, apparatus_id: body.apparatus_id, apparatus: 'Bosma 01', starts_at_unix: body.earliest_start_unix, ends_at_unix: body.earliest_start_unix + operation.expectedReservedMinutes * 60, requested_duration_minutes: body.duration_minutes, reserved_duration_minutes: operation.expectedReservedMinutes, status: 'planned', priority: body.priority, source: body.source, reason: body.reason, capability_requirements: body.capability_requirements, actor: actorRow, created_at_unix: 1_790_000_000, ...overrides }
}
function receipt(operation: ReturnType<typeof planningPatchOperation>, overrides: Row = {}) {
  const hash = 'b'.repeat(64), profile = operation.capacity ?? capacityInput(), discipline = operation.discipline ?? 'strict_sequence'
  return { ok: true, revision: { revision: { apparatus_id: id, revision_metadata: { revision: 4, command_id: `apparatus-command:${operation.key}`, actor_id: 'principal:admin' }, capacity: profile, policies: { queue: discipline }, ...overrides }, runtime_projection: projection({ source_revision: 4, source_aasx_sha256: hash }), aasx_sha256: hash } }
}
type Hook = (path: string, method: string, body: Row | undefined, options: RequestInit | undefined) => unknown | Promise<unknown>
function mockApi(hook?: Hook) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, options) => {
    const path = new URL(String(input)).pathname, method = options?.method ?? 'GET', body: Row | undefined = options?.body ? JSON.parse(String(options.body)) : undefined
    let payload = await hook?.(path, method, body, options)
    if (payload === undefined) {
      if (method === 'GET' && path === `/v1/mobile/admin/apparatus/${encodeURIComponent(id)}`) payload = projection()
      else if (method === 'GET' && path.endsWith('/capacity')) payload = { ok: true, capacity: [capacity()] }
      else if (method === 'GET' && path.endsWith('/queue-policies')) payload = { ok: true, policies: [queue()] }
      else if (method === 'GET' && path.endsWith('/sequence')) payload = orders()
      else if (method === 'GET' && path === '/v1/mobile/admin/apparatus') payload = [projection()]
      else throw new Error(`Unexpected mocked endpoint: ${method} ${path}`)
    }
    const response = payload && typeof payload === 'object' && 'status' in payload && 'payload' in payload ? payload as { status: number; payload: unknown } : { status: 200, payload }
    return new Response(JSON.stringify(response.payload), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const writes = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.filter(call => call[1]?.method !== 'GET')
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('canonical planning identity and endpoint permissions', () => {
  it('uses opaque canonical apparatus identity and the current order identity', () => {
    expect(isPlanningApparatusId(id)).toBe(true)
    for (const value of ['Bosma 01', 'apparatus:default:Asset-001', 'apparatus:default:a:extra', ' apparatus:default:a', 'apparatus:default:a/', `apparatus:default:${'a'.repeat(130)}`]) expect(isPlanningApparatusId(value)).toBe(false)
    expect(planningApparatusId({ runtime_projection: projection(), apparatus_id: secondId })).toBe(id)
    expect(planningApparatusId({ name: 'Bosma 01' })).toBe('')
    expect(planningOrderId({ id: 'template:old', map: { id: orderId } })).toBe(orderId)
  })

  it('matches actual any-capability handler guards without a role-label wildcard', async () => {
    expect(apparatusPlanningPermissions(actor([], 'admin'))).toEqual({ read: false, write: false })
    expect(apparatusPlanningPermissions(actor(['apparatus.queue.read'], 'aparatchi'))).toEqual({ read: true, write: false })
    expect(apparatusPlanningPermissions(actor(['production.map.manage'], 'aparatchi'))).toEqual({ read: true, write: true })
    expect(apparatusPlanningPermissions(actor(['apparatus.queue.manage']))).toEqual({ read: false, write: false })
    expect(apparatusPlanningPermissions(null)).toEqual({ read: false, write: false })
    const fetch = mockApi()
    await service(actor(['apparatus.queue.read'], 'aparatchi')).read(id)
    await expect(service(actor(['apparatus.queue.read'])).patch(planningPatchOperation(snapshot(), 'free_pick'))).rejects.toMatchObject({ status: 403 })
    await expect(service(actor([])).read(id)).rejects.toMatchObject({ status: 403 })
    expect(writes(fetch)).toHaveLength(0)
  })

  it('reads current capacity/policy projections and rejects missing legacy or mixed-revision profiles', async () => {
    mockApi()
    expect(await service().read(id)).toEqual(snapshot())
    mockApi(path => path.endsWith('/capacity') ? { ok: true, profiles: [capacity()], downtimes: [], reservations: [] } : undefined)
    await expect(service().read(id)).rejects.toMatchObject({ status: 502 })
    mockApi(path => path.endsWith('/queue-policies') ? { ok: true, policies: [queue({ source_revision: 4 })] } : undefined)
    await expect(service().read(id)).rejects.toThrow('turli revisionlardan')
    mockApi(path => path.endsWith('/capacity') ? { ok: true, capacity: [capacity(), capacity()] } : undefined)
    await expect(service().read(id)).rejects.toMatchObject({ status: 502 })
    mockApi(path => path.includes('/apparatus/') ? projection({ apparatus_id: secondId }) : undefined)
    await expect(service().read(id)).rejects.toMatchObject({ status: 502 })
  })
})

describe('capacity units, calendars, and schedule policy', () => {
  it('validates canonical limits, full-day time windows, sorting and duplicate windows', () => {
    const form = planningCapacityForm(snapshot().capacity)
    expect(planningCapacityInput({ ...form, scheduled: true, windows: [{ key: 'a', weekday: '7', start: '00:00', end: '24:00' }, { key: 'b', weekday: '1', start: '08:00', end: '16:00' }] }).availability).toEqual({ mode: 'scheduled', working_windows: [{ weekday: 1, start_minute: 480, end_minute: 960 }, { weekday: 7, start_minute: 0, end_minute: 1440 }] })
    for (const patch of [{ slots: '0' }, { slots: '65' }, { slots: '1.5' }, { efficiency: '0' }, { efficiency: '201' }, { setup: '-1' }, { cleanup: '4294967296' }, { setup: '1e3' }, { setup: 'NaN' }]) expect(() => planningCapacityInput({ ...form, ...patch })).toThrow()
    expect(() => planningCapacityInput({ ...form, scheduled: true, windows: [] })).toThrow('Kamida bitta')
    const window = { key: 'a', weekday: '1', start: '08:00', end: '17:00' }
    expect(() => planningCapacityInput({ ...form, scheduled: true, windows: [window, { ...window, key: 'b' }] })).toThrow('takrorlamang')
    expect(() => planningCapacityInput({ ...form, scheduled: true, windows: [{ ...window, start: '22:00', end: '06:00' }] })).toThrow('ikki kunga')
    expect(() => planningCapacityInput({ ...form, scheduled: true, windows: [{ ...window, weekday: '8' }] })).toThrow()
    expect(() => planningCapacityInput({ ...form, scheduled: true, windows: [{ ...window, start: '24:00' }] })).toThrow()
    expect(() => parsePlanningCapacity(capacity({ efficiency_percent: 0 }))).toThrow(ApiError)
    expect(() => parsePlanningCapacity(capacity({ always_available: false }))).toThrow(ApiError)
  })

  it('interprets explicit time inputs as UTC and rejects normalized invalid dates', () => {
    expect(planningUtcUnix('2026-10-13T10:00')).toBe(Date.parse('2026-10-13T10:00:00Z') / 1000)
    for (const value of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-10-13T24:00', '13/10/2026 10:00', '2026-10-13T10:00Z', '']) expect(() => planningUtcUnix(value)).toThrow()
    expect(planningReservedMinutes(capacityInput({ efficiency_percent: 80 }), 1)).toBe(12)
  })

  it('only offers current route apparatus for live, unfrozen orders', () => {
    expect(planningOrderPolicy(orders(), orderId)).toEqual({ apparatusIds: [id], reason: '' })
    for (const lifecycle of ['production_completed', 'closed', 'cancelled', 'unknown']) {
      const changed = orders(); changed.order_statuses[orderId].lifecycle_status = lifecycle
      expect(planningOrderPolicy(changed, orderId).apparatusIds).toEqual([])
    }
    for (const state of ['frozen', 'freeze_requested', 'unknown']) {
      const changed = orders(); changed.order_controls[orderId] = { state }
      expect(planningOrderPolicy(changed, orderId).apparatusIds).toEqual([])
    }
    const changed = orders(); changed.order_controls[orderId] = { state: 'active', early_close: { reason: 'closed' } }
    expect(planningOrderPolicy(changed, orderId).apparatusIds).toEqual([])
    expect(() => planningScheduleOperation({ ...snapshot(), apparatus: { ...snapshot().apparatus, apparatus_id: secondId } }, orders(), { orderId, start: '2026-10-13T10:00', end: '2026-10-13T13:00', duration: '60', priority: '0', reason: '' })).toThrow('xaritasiga')
  })

  it('decodes sparse native active controls and fails closed for malformed controls and native order_status', () => {
    expect(planningOrderPolicy(orders(), orderId).apparatusIds).toEqual([id])
    const explicit = orders(); explicit.order_controls[orderId] = { order_id: orderId, state: 'active', early_close: null }
    expect(planningOrderPolicy(explicit, orderId).apparatusIds).toEqual([id])
    for (const control of [null, [], 'active', {}, { state: 'active', order_id: 'order:other' }, { state: 'active', early_close: 'malformed' }, { state: 'active', early_close: {} }]) {
      const changed = orders(); changed.order_controls[orderId] = control as unknown as Row
      expect(planningOrderPolicy(changed, orderId).apparatusIds).toEqual([])
    }
    for (const state of ['completed', 'completed_with_issue', 'frozen', 'unknown_state', '', undefined, null, 5]) {
      const changed = orders(); changed.order_statuses[orderId].order_status = state
      expect(planningOrderPolicy(changed, orderId).apparatusIds).toEqual([])
    }
    const oldAlias = orders(); delete oldAlias.order_statuses[orderId].order_status; oldAlias.order_statuses[orderId].operational_status = 'in_progress'
    expect(planningOrderPolicy(oldAlias, orderId).apparatusIds).toEqual([])
    const malformed = orders(); malformed.order_controls = null as unknown as Record<string, Row>
    expect(planningOrderPolicy(malformed, orderId).apparatusIds).toEqual([])
  })

  it('validates duration minutes, total reserved time, requirements, and priority before requests', () => {
    const input = { orderId, start: '2026-10-13T10:00', end: '2026-10-13T13:00', duration: '60', priority: '0', reason: '' }
    expect(scheduleOperation().expectedReservedMinutes).toBe(70)
    for (const patch of [{ duration: '0' }, { duration: '43201' }, { duration: '1.5' }, { duration: 'NaN' }, { end: '2026-10-13T10:20' }, { priority: '2147483648' }, { priority: 'Infinity' }]) expect(() => planningScheduleOperation(snapshot(), orders(), { ...input, ...patch })).toThrow()
    expect(() => planningScheduleOperation(snapshot(), orders(), { ...input, requirements: [{ code: 'laminate', min_level: 1 }] })).toThrow('mos emas')
    expect(() => planningScheduleOperation(snapshot(), orders(), { ...input, requirements: [{ code: 'print', min_level: 4 }] })).toThrow('mos emas')
    expect(() => planningScheduleOperation(snapshot(), orders(), { ...input, requirements: [{ code: 'print', min_level: 1 }, { code: 'print', min_level: 1 }] })).toThrow('takrorlamang')
    expect(() => planningPatchOperation({ ...snapshot(), apparatus: { ...snapshot().apparatus, active: false } }, 'free_pick')).toThrow('faol')
    expect(() => planningPatchOperation(snapshot(), 'toString' as PlanningDiscipline)).toThrow('noto‘g‘ri')
  })

  it('locks printing policy from canonical operation/capability without fabricating its stored value', () => {
    const printing = { ...snapshot(), apparatus: { ...snapshot().apparatus, name: 'Uskuna 1', operation: 'print' }, policy: { ...snapshot().policy, discipline: 'free_pick' as const } }
    expect(planningQueuePolicyLocked(printing.apparatus)).toBe(true)
    expect(printing.policy.discipline).toBe('free_pick')
    expect(() => planningPatchOperation(printing, 'strict_sequence')).toThrow('qulflangan')
    expect(planningQueuePolicyLocked(snapshot().apparatus)).toBe(false)
    expect(planningQueuePolicyLocked({ ...printing.apparatus, capabilities: { cut: 1 } })).toBe(false)
    expect(() => planningPatchOperation(printing, capacityInput())).not.toThrow()
  })
})

describe('revision-based capacity and queue writes', () => {
  it('sends the actual capacity patch with revision and native idempotency header', async () => {
    const operation = planningPatchOperation(snapshot(), capacityInput({ capacity_slots: 2 }))
    const fetch = mockApi((path, method) => method === 'PUT' && path.endsWith('/capacity') ? receipt(operation) : undefined)
    const result = await service().patch(operation)
    const call = writes(fetch)[0]
    expect(JSON.parse(String(call[1]?.body))).toEqual({ apparatus_id: id, expected_revision: 3, capacity: operation.capacity })
    expect(new Headers(call[1]?.headers).get('Idempotency-Key')).toBe(operation.key)
    expect(result.apparatus.source_revision).toBe(4)
    expect(result.capacity.capacity_slots).toBe(2)
    expect(result.policy.discipline).toBe('strict_sequence')
  })

  it('sends only discipline for queue policy and never starts or reorders work', async () => {
    const operation = planningPatchOperation(snapshot(), 'free_pick')
    const fetch = mockApi((_path, method) => method === 'PUT' ? receipt(operation) : undefined)
    const result = await service().patch(operation)
    expect(String(writes(fetch)[0][0])).toContain('/queue-policies')
    expect(JSON.parse(String(writes(fetch)[0][1]?.body))).toEqual({ apparatus_id: id, expected_revision: 3, discipline: 'free_pick' })
    expect(result.policy.discipline).toBe('free_pick')
    expect(fetch.mock.calls.every(call => !String(call[0]).includes('/queue-action'))).toBe(true)
  })

  it('blocks a stale preflight without overwriting the current canonical revision', async () => {
    const operation = planningPatchOperation(snapshot(), 'free_pick')
    const fetch = mockApi(path => path.includes('/apparatus/') ? projection({ source_revision: 4, source_aasx_sha256: 'b'.repeat(64) }) : path.endsWith('/capacity') ? { ok: true, capacity: [capacity({ source_revision: 4, source_aasx_sha256: 'b'.repeat(64) })] } : path.endsWith('/queue-policies') ? { ok: true, policies: [queue({ source_revision: 4, source_aasx_sha256: 'b'.repeat(64) })] } : undefined)
    await expect(service().patch(operation)).rejects.toBeInstanceOf(PlanningConflict)
    expect(writes(fetch)).toHaveLength(0)
  })

  it('shows a native 409 and never retries a rejected write', async () => {
    const operation = planningPatchOperation(snapshot(), 'free_pick')
    const fetch = mockApi((_path, method) => method === 'PUT' ? { status: 409, payload: { error: 'apparatus_revision_conflict' } } : undefined)
    await expect(service().patch(operation)).rejects.toMatchObject({ status: 409, code: 'apparatus_revision_conflict' })
    expect(writes(fetch)).toHaveLength(1)
    expect(apparatusPlanningError(new ApiError(409, 'apparatus_revision_conflict'))).toContain('revisioni')
  })

  it('treats invalid identity, command or saved values as uncertain rather than success', async () => {
    const operation = planningPatchOperation(snapshot(), 'free_pick')
    for (const changed of [{ apparatus_id: secondId }, { revision_metadata: { revision: 4, actor_id: 'principal:admin', command_id: 'apparatus-command:other' } }, { policies: { queue: 'strict_sequence' } }]) {
      const fetch = mockApi((_path, method) => method === 'PUT' ? receipt(operation, changed) : undefined)
      await expect(service().patch(operation)).rejects.toMatchObject({ name: 'PlanningSaveUnknown', operation })
      expect(writes(fetch)).toHaveLength(1)
    }
  })

  it('recovers only by reading matching persisted state and exposes a current copy on mismatch', async () => {
    const operation = planningPatchOperation(snapshot(), capacityInput({ capacity_slots: 2 }))
    const fetch = mockApi(path => path.includes('/apparatus/') ? projection({ source_revision: 4, source_aasx_sha256: 'b'.repeat(64) }) : path.endsWith('/capacity') ? { ok: true, capacity: [capacity({ capacity_slots: 2, source_revision: 4, source_aasx_sha256: 'b'.repeat(64) })] } : path.endsWith('/queue-policies') ? { ok: true, policies: [queue({ source_revision: 4, source_aasx_sha256: 'b'.repeat(64) })] } : undefined)
    expect((await service().recoverPatch(operation)).capacity.capacity_slots).toBe(2)
    expect(writes(fetch)).toHaveLength(0)
    mockApi()
    await expect(service().recoverPatch(operation)).rejects.toMatchObject({ name: 'PlanningConflict', current: snapshot() })
  })
})

describe('downtime and server-authoritative scheduling', () => {
  it('creates a unique downtime identity and roundtrips server stamped actor and exact interval', async () => {
    const input = { start: '2026-10-13T10:00', end: '2026-10-13T11:00', reason: ' Texnik xizmat ' }
    const operation = planningDowntimeOperation(snapshot(), input), other = planningDowntimeOperation(snapshot(), input)
    expect(operation.body.id).not.toBe(other.body.id)
    const fetch = mockApi((_path, method, body) => method === 'POST' ? { ok: true, downtime: { ...body, actor: actorRow } } : undefined)
    const result = await service().downtime(operation)
    expect(result.reason).toBe('Texnik xizmat')
    expect(JSON.parse(String(writes(fetch)[0][1]?.body))).toEqual(operation.body)
    const edit = planningDowntimeOperation(snapshot(), { ...input, end: '2026-10-13T12:00' }, result)
    expect(edit.method).toBe('PUT'); expect(edit.body.id).toBe(result.id)
    expect(() => planningDowntimeOperation(snapshot(), { ...input, reason: ' ' })).toThrow()
    expect(() => planningDowntimeOperation(snapshot(), { ...input, end: input.start })).toThrow()
    expect(() => parsePlanningDowntime({ ...result, apparatus_id: secondId }, operation)).toThrow(ApiError)
    expect(() => parsePlanningDowntime({ ...result, actor: { ...actorRow, ref: 'another' } }, operation, actor())).toThrow('foydalanuvchi')
  })

  it('keeps an uncertain downtime identity and body, with no automatic duplicate creation', async () => {
    const operation = planningDowntimeOperation(snapshot(), { start: '2026-10-13T10:00', end: '2026-10-13T11:00', reason: 'Texnik xizmat' })
    const fetch = mockApi((_path, method) => { if (method === 'POST') throw new TypeError('disconnected'); return undefined })
    await expect(service().downtime(operation)).rejects.toMatchObject({ name: 'PlanningSaveUnknown', operation })
    expect(writes(fetch)).toHaveLength(1)
  })

  it('only schedules an explicit current order/apparatus window with native request key', async () => {
    const operation = scheduleOperation()
    const fetch = mockApi((_path, method) => method === 'POST' ? { ok: true, reservation: reservation(operation, { starts_at_unix: operation.body.earliest_start_unix + 3600, ends_at_unix: operation.body.earliest_start_unix + 3600 + 70 * 60 }), conflicts: [] } : undefined)
    const result = await service().schedule(operation)
    expect(result.reservation.starts_at_unix).toBe(operation.body.earliest_start_unix + 3600)
    expect(JSON.parse(String(writes(fetch)[0][1]?.body))).toEqual(operation.body)
    expect(operation.body.candidate_apparatuses).toEqual([])
    expect(writes(fetch)).toHaveLength(1)
    expect(fetch.mock.calls.every(call => !String(call[0]).includes('preview') && !String(call[0]).includes('queue-action'))).toBe(true)
  })

  it('refuses to send after the current order route/state changes', async () => {
    const operation = scheduleOperation(), changed = orders(); changed.order_controls[orderId] = { state: 'frozen' }
    const fetch = mockApi(path => path.endsWith('/sequence') ? changed : undefined)
    await expect(service().schedule(operation)).rejects.toBeInstanceOf(PlanningConflict)
    expect(writes(fetch)).toHaveLength(0)
  })

  it('keeps native conflict rejection visible without replacing existing reservations', async () => {
    const operation = scheduleOperation()
    const fetch = mockApi((_path, method) => method === 'POST' ? { status: 409, payload: { error: 'capacity_no_working_window' } } : undefined)
    await expect(service().schedule(operation)).rejects.toMatchObject({ status: 409, code: 'capacity_no_working_window' })
    expect(apparatusPlanningError(new ApiError(409, 'capacity_no_working_window'))).toContain('mos bo‘sh ish vaqti')
    expect(writes(fetch)).toHaveLength(1)
  })

  it('validates server reservation identity, bounds, duration, requirements and status', () => {
    const operation = scheduleOperation()
    for (const patch of [{ order_id: 'order:002' }, { apparatus_id: secondId }, { reservation_id: 'fabricated' }, { idempotency_key: 'other' }, { requested_duration_minutes: 1 }, { reserved_duration_minutes: 60 }, { starts_at_unix: operation.body.earliest_start_unix - 60 }, { ends_at_unix: operation.body.latest_end_unix + 60 }, { capability_requirements: [] }, { status: 'unknown' }]) expect(() => parsePlanningReservation(reservation(operation, patch), operation)).toThrow(ApiError)
  })

  it('recovers an uncertain scheduling request with the unchanged key/body and no automatic retry', async () => {
    const operation = scheduleOperation()
    let count = 0
    const fetch = mockApi((_path, method) => { if (method === 'POST') { if (++count === 1) throw new TypeError('response lost'); return { ok: true, reservation: reservation(operation), conflicts: [] } } return undefined })
    await expect(service().schedule(operation)).rejects.toBeInstanceOf(PlanningSaveUnknown)
    expect(writes(fetch)).toHaveLength(1)
    const recovered = await service().schedule(operation, undefined, true)
    expect(recovered.reservation.reservation_id).toBe(reservation(operation).reservation_id)
    expect(writes(fetch)).toHaveLength(2)
    expect(writes(fetch)[0][1]?.body).toBe(writes(fetch)[1][1]?.body)
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'GET')).toHaveLength(8)
  })

  it('keeps recovery uncertain if state changed, without creating a previously uncommitted reservation', async () => {
    const operation = scheduleOperation(), changed = orders(); changed.order_controls[orderId] = { state: 'frozen' }
    const fetch = mockApi(path => path.endsWith('/sequence') ? changed : undefined)
    await expect(service().schedule(operation, undefined, true)).rejects.toMatchObject({ name: 'PlanningSaveUnknown', operation })
    expect(writes(fetch)).toHaveLength(0)
  })

  it('cancels only the returned planned reservation and validates the exact cancelled result', async () => {
    const operation = scheduleOperation(), original = { reservation: parsePlanningReservation(reservation(operation), operation), conflicts: [], operation }
    const fetch = mockApi(path => path.endsWith('/schedule/cancel') ? { ok: true, reservation: reservation(operation, { status: 'cancelled', reason: `${operation.body.reason}; cancelled: Mijoz so‘rovi` }) } : undefined)
    const result = await service().cancel({ kind: 'cancel', original, reason: 'Mijoz so‘rovi' })
    expect(JSON.parse(String(writes(fetch)[0][1]?.body))).toEqual({ reservation_id: original.reservation.reservation_id, reason: 'Mijoz so‘rovi' })
    expect(result.reservation.status).toBe('cancelled')
    const before = fetch.mock.calls.length
    await expect(service().cancel({ kind: 'cancel', original: result, reason: '' })).rejects.toThrow('planned')
    expect(fetch.mock.calls).toHaveLength(before)
    mockApi(path => path.endsWith('/schedule/cancel') ? { ok: true, reservation: reservation(operation) } : undefined)
    await expect(service().cancel({ kind: 'cancel', original, reason: '' })).rejects.toBeInstanceOf(PlanningSaveUnknown)
  })

  it('ignores an interrupted response after a record/session swap instead of publishing success', async () => {
    const operation = planningDowntimeOperation(snapshot(), { start: '2026-10-13T10:00', end: '2026-10-13T11:00', reason: 'Texnik xizmat' })
    const controller = new AbortController()
    mockApi(async (_path, method, body) => { if (method === 'POST') { controller.abort(); return { ok: true, downtime: { ...body, actor: actorRow } } } return undefined })
    await expect(service().downtime(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('documents unsupported read/preview/speed APIs instead of inventing them', () => {
    expect(APPARATUS_PLANNING_API_LIMITATIONS.join(' ')).toContain('oldindan tekshirish API mavjud emas')
    expect(APPARATUS_PLANNING_API_LIMITATIONS.join(' ')).toContain('revision sharti yo‘q')
    expect(APPARATUS_PLANNING_API_LIMITATIONS.join(' ')).toContain('Tezlik')
  })
})
