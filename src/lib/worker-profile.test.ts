import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Row, Session } from './api-types'
import { MutationScope } from './mutation-scope'
import { WorkerProfileApi, canReadWorkerHistory, canReadWorkerProfile, canReadWorkerRoles, parseWorkerBatch, parseWorkerProfile, stripWorkerSecrets, workerProfileCounts, workerProfileError, workerProfileIdentity } from './worker-profile'

const apparatus = 'apparatus:default:pechat'
const actor = (capabilities = ['admin.access'], role = 'admin', ref = 'admin'): Session => ({ token: 'test-token', profile: { role, ref, display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const api = (session = actor()) => new WorkerProfileApi(new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), session)
const worker = { id: 'worker_1', name: 'Ali', phone: '+998900000001', level: 'Master', code: 'DO-NOT-CACHE-CODE', avatar_url: 'https://erp.example.test/v1/mobile/profile/avatar/view?token=DO-NOT-CACHE-TOKEN', code_locked: false, code_retry_after_sec: 0 }
const session = (status = 'active', id = 'session-1') => ({ session_id: id, apparatus, order_id: 'zakaz-0042', status, worker_role: 'aparatchi', worker_ref: worker.id, worker_display_name: worker.name, started_at_unix: 100, updated_at_unix: 200, payload_json: { secret: 'DO-NOT-CACHE-PAYLOAD' } })
const batch = (overrides: Row = {}): Row => ({ batch_id: 'batch-1', revision: 2, session_id: 'session-1', apparatus, order_id: 'zakaz-0042', action: 'complete', status: 'completed', produced_qty: 100, uom: 'm', started_at_unix: 100, completed_at_unix: 200, worker_role: 'aparatchi', worker_ref: worker.id, worker_display_name: worker.name, executor_name: worker.name, label_item_code: 'SKU-1', label_item_name: 'Plyonka', wip_status: 'waiting', payload_json: { token: 'DO-NOT-CACHE-TOKEN', materials: [{ code: 'DO-NOT-CACHE-CODE' }] }, ...overrides })
const log = { event_id: 'event-1', apparatus, order_id: 'zakaz-0042', action: 'complete', from_state: 'in_progress', to_state: 'completed', actor_role: 'aparatchi', actor_ref: worker.id, actor_display_name: worker.name, created_at_unix: 200, completed_with_issue: true, issue_note: 'Bosma sifati tekshirilsin' }
const group = { apparatus_id: apparatus, apparatus: 'Bosma 1', group_code: 'A', shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6, start_day: 'monday', accounting_enabled: true, worker_ids: [worker.id], workers: [worker] }
const rawProfile = (overrides: Row = {}) => ({ worker, assigned_apparatus: [apparatus], assigned_groups: [group], active_sessions: [session()], recent_batches: [batch()], recent_logs: [log], ...overrides })
const profile = () => parseWorkerProfile(rawProfile(), worker.id)
function respond(...fixtures: unknown[]) {
  let index = 0
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    const item = fixtures[Math.min(index++, fixtures.length - 1)]
    if (item instanceof Error) throw item
    const response = item && typeof item === 'object' && 'status' in item && 'payload' in item ? item as { status: number; payload: unknown } : { status: 200, payload: item }
    return new Response(JSON.stringify(response.payload), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const url = (fetch: ReturnType<typeof respond>, index = 0) => new URL(String(fetch.mock.calls[index][0]))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('worker native identity and credential-free profile policy', () => {
  it('uses the actual worker identity rather than synthetic user-list IDs', () => {
    expect(workerProfileIdentity(worker)).toBe(worker.id)
    expect(workerProfileIdentity({ id: 'worker:worker_1', entity_ref: worker.id, principal_role: 'aparatchi' })).toBe(worker.id)
    for (const row of [{ id: 'worker:worker_1', principal_role: 'aparatchi' }, { id: worker.id, principal_role: 'qolipchi' }, { id: worker.id, role: 'supplier' }, { id: '' }, { id: 'worker_1,worker_2' }, { id: 42 }]) expect(workerProfileIdentity(row)).toBeNull()
  })

  it('strips nested credentials and token-bearing avatar URLs before profile data is retained', () => {
    const parsed = profile(), cached = JSON.stringify(parsed)
    expect(parsed.worker).toEqual({ id: worker.id, name: worker.name, phone: worker.phone, level: worker.level })
    expect(cached).not.toContain('DO-NOT-CACHE')
    expect(cached).not.toContain('avatar_url')
    expect(cached).not.toContain('payload_json')
    expect(cached).not.toContain('code_locked')
    expect(rawProfile().worker.code).toBe('DO-NOT-CACHE-CODE')
    const stripped = stripWorkerSecrets({ password: 'p', Authorization: 't', nested: [{ access_token: 't', refresh_token: 'r', login_code: 'c', name: 'Visible' }] })
    expect(stripped).toEqual({ nested: [{ name: 'Visible' }] })
  })

  it('rejects mismatched profile identity, malformed arrays and duplicate native record IDs', () => {
    expect(() => parseWorkerProfile(rawProfile(), 'worker_other')).toThrow(ApiError)
    expect(() => parseWorkerProfile(rawProfile({ recent_batches: 'broken' }), worker.id)).toThrow(ApiError)
    expect(() => parseWorkerProfile(rawProfile({ active_sessions: [session(), session()] }), worker.id)).toThrow(ApiError)
    expect(() => parseWorkerProfile(rawProfile({ recent_batches: [batch(), batch()] }), worker.id)).toThrow(ApiError)
    expect(() => parseWorkerProfile(rawProfile({ recent_logs: [log, log] }), worker.id)).toThrow(ApiError)
    expect(() => parseWorkerProfile(rawProfile({ assigned_apparatus: ['Bosma 1'] }), worker.id)).toThrow(ApiError)
  })

  it('keeps open active/paused/frozen/detached sessions distinct and refuses completed sessions in the native active list', () => {
    const statuses = ['active', 'paused', 'frozen', 'roll_detached']
    const parsed = parseWorkerProfile(rawProfile({ active_sessions: statuses.map((status, index) => session(status, `session-${index}`)) }), worker.id)
    expect(workerProfileCounts(parsed)).toEqual({ open: 4, active: 1, paused: 1, frozen: 1, roll_detached: 1, batches: 1, events: 1 })
    expect(() => parseWorkerProfile(rawProfile({ active_sessions: [session('completed')] }), worker.id)).toThrow(ApiError)
    expect(() => parseWorkerProfile(rawProfile({ active_sessions: [session('invented')] }), worker.id)).toThrow(ApiError)
  })

  it('retains legacy phone-scoped history rather than rematching people by display name', () => {
    const parsed = parseWorkerProfile(rawProfile({ recent_batches: [batch({ worker_ref: '+998900000000', worker_display_name: 'Old display' })] }), worker.id)
    expect(parsed.recent_batches[0].worker_ref).toBe('+998900000000')
    expect(parsed.worker.id).toBe(worker.id)
  })

  it('preserves actual per-batch units and zero quantities but never derives gross productive totals', () => {
    const parsed = parseWorkerProfile(rawProfile({ recent_batches: [batch({ batch_id: 'paused', status: 'paused', produced_qty: 0 }), batch({ batch_id: 'resumed', status: 'resumed', produced_qty: 100 }), batch({ batch_id: 'finished', produced_qty: 10, uom: 'kg' })] }), worker.id)
    expect(parsed.recent_batches.map(row => [row.status, row.produced_qty, row.uom])).toEqual([['paused', 0, 'm'], ['resumed', 100, 'm'], ['completed', 10, 'kg']])
    expect(workerProfileCounts(parsed)).toMatchObject({ batches: 3 })
    expect(workerProfileCounts(parsed)).not.toHaveProperty('produced_qty')
    expect(workerProfileCounts(parsed)).not.toHaveProperty('efficiency')
  })

  it('validates finite numeric values and optional recorded measurements without replacing missing values by zero', () => {
    const decoded = parseWorkerBatch(batch({ finished_goods_kg: 0, finished_goods_meter: 125, babina_kg: 2 }))
    expect(decoded).toMatchObject({ finished_goods_kg: 0, finished_goods_meter: 125, bobina_kg: 2, total_waste: null })
    for (const patch of [{ produced_qty: -1 }, { produced_qty: Number.NaN }, { finished_goods_kg: Number.POSITIVE_INFINITY }, { revision: 0 }, { completed_at_unix: 1.5 }, { status: 'active' }, { wip_status: 'invented' }]) expect(() => parseWorkerBatch(batch(patch))).toThrow(ApiError)
  })

  it('permits empty native activity and assignments with meaningful zero record counts', () => {
    const decoded = parseWorkerProfile(rawProfile({ active_sessions: [], recent_batches: [], recent_logs: [], assigned_apparatus: [], assigned_groups: [] }), worker.id)
    expect(workerProfileCounts(decoded)).toEqual({ open: 0, active: 0, paused: 0, frozen: 0, roll_detached: 0, batches: 0, events: 0 })
  })
})

describe('worker source-specific guards and read-only native request contracts', () => {
  it('requires admin.access for native profile and role.capability.read independently for roles', async () => {
    const fetch = respond(rawProfile())
    expect(canReadWorkerProfile(actor(['production.map.manage']))).toBe(false)
    expect(canReadWorkerRoles(actor(['admin.access']))).toBe(false)
    expect(canReadWorkerRoles(actor(['role.capability.manage']))).toBe(false)
    await expect(api(actor(['production.map.manage'])).profile(worker.id)).rejects.toMatchObject({ status: 403 })
    await expect(api().assignment(worker.id)).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
    await api().profile(worker.id)
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/workers/profile-detail')
    expect([...url(fetch).searchParams.entries()]).toEqual([['id', worker.id]])
    expect(fetch.mock.calls[0][1]?.method).toBe('GET')
  })

  it('does not silently replace a selected worker history with a non-admin principal’s own history', async () => {
    const fetch = respond({ ok: true, batches: [] }), other = actor(['admin.access'], 'qolipchi', 'qolipchi_1')
    expect(canReadWorkerHistory(other, worker.id)).toBe(false)
    await expect(api(other).history(worker.id)).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
    const self = actor(['apparatus.queue.read'], 'aparatchi', worker.id)
    expect(canReadWorkerHistory(self, worker.id)).toBe(true)
    expect(canReadWorkerHistory(self, 'other')).toBe(false)
    await api(self).history(worker.id, 200)
    expect(url(fetch).searchParams.get('worker_ref')).toBe(worker.id)
    expect(url(fetch).searchParams.get('limit')).toBe('200')
  })

  it('matches the exact history OR capabilities without broadening to arbitrary multi-worker queries', () => {
    for (const code of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']) expect(canReadWorkerHistory(actor([code]), worker.id)).toBe(true)
    expect(canReadWorkerHistory(actor(['role.capability.read']), worker.id)).toBe(false)
    expect(canReadWorkerHistory(actor(), 'worker_1,worker_2')).toBe(false)
  })

  it('expands history through a bounded native limit without offset, date range, or invented has-more metadata', async () => {
    const fetch = respond({ ok: true, batches: [batch()] })
    const history = await api().history(worker.id, 100)
    expect(history).toMatchObject({ limit: 100, atLimit: false })
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/production-maps/progress-qr/history')
    expect([...url(fetch).searchParams.keys()]).toEqual(['worker_ref', 'limit'])
    expect(history).not.toHaveProperty('has_more')
    for (const limit of [0, -1, 201, 1.5]) await expect(api().history(worker.id, limit)).rejects.toThrow('1–200')
    expect(fetch).toHaveBeenCalledTimes(1)
    respond({ ok: true, batches: [batch()] })
    expect((await api().history(worker.id, 1)).atLimit).toBe(true)
  })

  it('refuses malformed history acknowledgements and over-limit or duplicate rows', async () => {
    for (const response of [{ batches: [batch()] }, { ok: true, batches: 'broken' }, { ok: true, batches: [batch(), batch()] }, { ok: true, batches: [batch(), batch({ batch_id: 'other' })] }]) {
      respond(response)
      await expect(api().history(worker.id, 1)).rejects.toBeInstanceOf(ApiError)
    }
  })

  it('loads canonical apparatus labels and reports catalog saturation without guessing a name', async () => {
    const fetch = respond([{ apparatus_id: apparatus, display: { display_name: 'Bosma 1' }, lifecycle: { state: 'retired' } }])
    expect(await api().apparatus()).toEqual({ labels: { [apparatus]: 'Bosma 1' }, bounded: false })
    expect(url(fetch).searchParams.get('limit')).toBe('500')
    await expect(api(actor(['catalog.item.read'])).apparatus()).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reads only the selected native worker assignment and actual server role label', async () => {
    const assignments = [{ principal_role: 'qolipchi', principal_ref: worker.id, role_id: 'wrong' }, { principal_role: 'aparatchi', principal_ref: 'WORKER_1', role_id: 'quality', assigned_apparatus: [apparatus], assigned_item_groups: ['Plyonka'] }]
    const role = { id: 'quality', label: 'Sifat nazorati', system: false, capability_codes: ['catalog.item.read', 'admin.access'], code: 'DO-NOT-CACHE-CODE' }
    const fetch = respond(assignments, [role])
    const result = await api(actor(['admin.access', 'role.capability.read'])).assignment(worker.id)
    expect(result).toEqual({ role_id: 'quality', role: { id: 'quality', label: 'Sifat nazorati', capability_count: 2 }, assigned_apparatus: [apparatus], assigned_item_groups: ['Plyonka'] })
    expect(fetch.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(['/v1/mobile/admin/role-assignments', '/v1/mobile/admin/roles'])
    expect(JSON.stringify(result)).not.toContain('DO-NOT-CACHE')
  })

  it('keeps missing role definitions explicit instead of inventing a role or capability set', async () => {
    respond([{ principal_role: 'aparatchi', principal_ref: worker.id, role_id: 'retired-role' }], [])
    expect(await api(actor(['role.capability.read'])).assignment(worker.id)).toEqual({ role_id: 'retired-role', role: null, assigned_apparatus: [], assigned_item_groups: [] })
    respond([], [])
    expect(await api(actor(['role.capability.read'])).assignment(worker.id)).toBeNull()
  })

  it('shows explicit 403/404 errors and never performs a mutation while reading worker history', async () => {
    const fetch = respond({ status: 403, payload: { error: 'private_profile_guard' } })
    const error = await api().profile(worker.id).catch(error => error)
    expect(workerProfileError(error)).toContain('ruxsat')
    expect(workerProfileError(error)).not.toContain('private_profile_guard')
    expect(workerProfileError(new ApiError(404, 'worker not found'))).toContain('topilmadi')
    expect(fetch.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true)
  })

  it('cancels an old identity response before its profile or embedded credentials can enter cached data', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise<Response>(resolve => { finish = resolve })); vi.stubGlobal('fetch', fetch)
    const mutations = new MutationScope(), lease = mutations.begin(), pending = api().profile(worker.id, lease.controller.signal)
    mutations.cancelAll(); finish(new Response(JSON.stringify(rawProfile()), { status: 200 }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mutations.isCurrent(lease)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
