import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import type { Session } from './api-types'
import {
  WorkerGroupConflict, WorkerGroupIntentLedger, WorkerGroupUnknown, WorkerGroupsApi, canReadGroupApparatus,
  createWorkerGroupOperation, normalizeWorkerGroupCode, normalizeWorkerGroupInput, parseGroupWorker, parseWorkerGroup,
  parseWorkerGroups, workerGroupError, workerGroupIdentity, workerGroupIntentLedger, workerGroupsAllowed,
} from './worker-groups'
import type { WorkerGroup, WorkerGroupInput, WorkerGroupOperation } from './worker-groups'

const apparatusId = 'apparatus:default:pechat', secondApparatusId = 'apparatus:default:lamination'
const worker = { id: 'worker-1', name: 'Ali', phone: '+998901234567', level: 'Master' }
const secondWorker = { id: 'worker-2', name: 'Vali', phone: '', level: 'Brigader' }
const input: WorkerGroupInput = { apparatus_id: apparatusId, apparatus: 'Bosma 1', group_code: 'A GURUH', shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6, start_day: 'monday', accounting_enabled: false, worker_ids: [worker.id] }
const group: WorkerGroup = { ...input, workers: [worker] }
const apparatus = { apparatus_id: apparatusId, display: { display_name: 'Bosma 1' }, lifecycle: { state: 'active' } }
function session(capabilities = ['admin.access']): Session { return { token: 'local-test', profile: { role: 'admin', ref: 'admin-ref', display_name: 'Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] } }
function api(capabilities = ['admin.access']) { return new WorkerGroupsApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), session(capabilities)) }
type WireOptions = { method: string; body?: string; signal: AbortSignal }
function wire({ groups = [] as WorkerGroup[], receipt = group as unknown, apparatusResult = apparatus as unknown, detail = worker as unknown, status = 200, mutationFailure, onMutation }: {
  groups?: WorkerGroup[]; receipt?: unknown; apparatusResult?: unknown; detail?: unknown; status?: number; mutationFailure?: Error; onMutation?: () => void;
} = {}) {
  const fetch = vi.fn(async (url: URL, options: WireOptions) => {
    let value: unknown
    if (options.method === 'PUT') { onMutation?.(); if (mutationFailure) throw mutationFailure; return new Response(JSON.stringify(receipt), { status }) }
    if (url.pathname.endsWith('/worker-groups')) value = groups
    else if (url.pathname.endsWith('/workers/detail')) value = detail
    else if (url.pathname.includes('/apparatus/')) value = apparatusResult
    else value = []
    return new Response(JSON.stringify(value), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function putCalls(fetch: ReturnType<typeof wire>) { return fetch.mock.calls.filter(([, options]) => options.method === 'PUT') }
afterEach(() => vi.unstubAllGlobals())

describe('worker groups native contract and authority', () => {
  it('requires actual admin.access for every group/directory operation, regardless of actor role', async () => {
    const fetch = wire()
    const noAdmin = api(['production.map.manage', 'role.capability.manage', 'apparatus.queue.read'])
    for (const action of [() => noAdmin.groups(), () => noAdmin.workers(), () => noAdmin.apparatus(), () => noAdmin.execute(createWorkerGroupOperation(input)), () => noAdmin.observe(createWorkerGroupOperation(input))]) await expect(action()).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
    expect(workerGroupsAllowed(session([]))).toBe(false)
    expect(workerGroupsAllowed({ ...session(), profile: { role: 'aparatchi', ref: worker.id, display_name: worker.name } })).toBe(true)
    expect(canReadGroupApparatus(session(['preparation.access']))).toBe(true)
    expect(canReadGroupApparatus(session(['role.capability.read']))).toBe(false)
  })
  it('reads all native groups without fictional pagination and does not fetch worker roles', async () => {
    const fetch = wire({ groups: [group] })
    expect(await api().groups()).toEqual([group])
    expect(fetch.mock.calls).toHaveLength(1)
    expect(String(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:5199/v1/mobile/admin/worker-groups')
  })
  it('uses canonical apparatus identity and exact edited identity, with only native writable fields', async () => {
    const next = { ...input, apparatus_id: secondApparatusId, apparatus: 'Laminatsiya 1', group_code: ' b   guruh ', shift: ' tun ', start_time: '20:00', end_time: '8:0', accounting_enabled: true }
    const operation = createWorkerGroupOperation({ ...next, actor_role: 'admin', actor_ref: 'admin-ref', previous_apparatus: 'fake' } as WorkerGroupInput, group)
    const saved = { ...operation.input, workers: [worker], ignored_code: 'SECRET' }
    const fetch = wire({ groups: [group], receipt: saved, apparatusResult: { ...apparatus, apparatus_id: secondApparatusId, display: { display_name: 'Laminatsiya 1' } } })
    const result = await api().execute(operation)
    expect(result).toEqual({ ...operation.input, workers: [worker] })
    const [url, options] = putCalls(fetch)[0]!
    expect(String(url)).toBe('http://127.0.0.1:5199/v1/mobile/admin/worker-groups')
    expect(JSON.parse(options.body!)).toEqual({ ...operation.input, previous_apparatus_id: apparatusId, previous_group_code: 'A GURUH' })
    expect(fetch.mock.calls.some(([url]) => url.pathname === `/v1/mobile/admin/apparatus/${encodeURIComponent(secondApparatusId)}`)).toBe(true)
    expect(fetch.mock.calls.find(([url]) => url.pathname.endsWith('/workers/detail'))![0].searchParams.get('id')).toBe(worker.id)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
  it('creates a group with no previous identity, no viewer membership and no unnecessary role assignment', async () => {
    const operation = createWorkerGroupOperation({ ...input, worker_ids: [] })
    const fetch = wire({ receipt: { ...operation.input, workers: [] } })
    await api().execute(operation)
    expect(JSON.parse(putCalls(fetch)[0]![1].body!)).toEqual(operation.input)
    expect(fetch.mock.calls.some(([url]) => url.pathname.includes('workers/detail') || url.pathname.includes('role-assignments'))).toBe(false)
  })
  it('takes worker choices only from the active native aparatchi directory and reports its bound', async () => {
    const fetch = vi.fn(async (_url: URL, _options: WireOptions) => new Response(JSON.stringify(Array.from({ length: 500 }, (_, index) => ({ ...worker, id: `worker-${index}`, code: 'SECRET', avatar_url: '/profile?token=SECRET' }))), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const directory = await api().workers(' Ali ')
    expect(directory.bounded).toBe(true); expect(directory.items).toHaveLength(500)
    expect(directory.items[0]).toEqual({ ...worker, id: 'worker-0' })
    const url = new URL(String(fetch.mock.calls[0]![0]))
    expect(url.searchParams.get('role')).toBe('aparatchi'); expect(url.searchParams.get('q')).toBe('Ali'); expect(url.searchParams.get('limit')).toBe('500')
    expect(JSON.stringify(directory)).not.toContain('SECRET')
  })
  it('excludes retired apparatus from the actual bounded picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([apparatus, { ...apparatus, apparatus_id: secondApparatusId, lifecycle: { state: 'retired' } }]))))
    expect(await api().apparatus()).toEqual({ items: [{ id: apparatusId, name: 'Bosma 1', active: true }], bounded: false })
  })
})

describe('worker group native validation and secret-free DTOs', () => {
  it('mirrors Unicode name normalization and UTF-8 byte limits, schedule defaults, and overnight shifts', () => {
    expect(normalizeWorkerGroupCode('  guruh   ё  2  ')).toBe('GURUH Ё 2')
    expect(() => normalizeWorkerGroupCode('A_GROUP')).toThrow('Guruh nomi')
    expect(() => normalizeWorkerGroupCode('Ё'.repeat(33))).toThrow('64 bayt')
    expect(() => normalizeWorkerGroupInput({ ...input, shift: 'Ё'.repeat(33) })).toThrow('Smena')
    expect(normalizeWorkerGroupInput({ ...input, shift: '', start_time: '', end_time: '', work_days_per_week: 0 })).toMatchObject({ shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6 })
    expect(normalizeWorkerGroupInput({ ...input, start_time: '20:00', end_time: '8:0' })).toMatchObject({ start_time: '20:00', end_time: '08:00' })
    // The native schedule permits equal times; do not invent a duration policy.
    expect(normalizeWorkerGroupInput({ ...input, start_time: '08:00', end_time: '08:00' }).end_time).toBe('08:00')
  })
  it.each([{ apparatus_id: 'Bosma 1' }, { start_time: '24:00' }, { end_time: '20:60' }, { work_days_per_week: -1 }, { work_days_per_week: 8 }, { work_days_per_week: 2.5 }, { start_day: 'today' }, { worker_ids: ['worker-1', 'WORKER-1'] }, { worker_ids: [' '] }])('rejects invalid intent before any request: %j', async patch => {
    const fetch = wire()
    expect(() => createWorkerGroupOperation({ ...input, ...patch } as WorkerGroupInput)).toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('strips all unsolicited worker secrets instead of retaining nested native detail', () => {
    const parsed = parseWorkerGroup({ ...group, code: 'SECRET', workers: [{ ...worker, code: 'SECRET', avatar_url: 'https://server/avatar?token=SECRET', audit: { token: 'SECRET' } }] })
    expect(parsed).toEqual(group)
    expect(JSON.stringify(parsed)).not.toContain('SECRET')
  })
  it.each([{ id: 'system_user:admin' }, { principal_role: 'admin' }, { role: 'admin' }, { active: false }, { level: 'admin' }])('rejects non-native, inactive or non-worker choices: %j', patch => {
    expect(() => parseGroupWorker({ ...worker, ...patch })).toThrow()
  })
  it.each([{ ok: false }, { apparatus_id: 'Bosma 1' }, { workers: [{ ...worker, id: 'other' }] }, { worker_ids: [worker.id, worker.id.toUpperCase()] }, { group_code: 'a guruh' }, { work_days_per_week: '6' }, { accounting_enabled: 0 }, { start_time: '8:00' }, { end_time: '99:00' }, { start_day: '' }, { shift: '' }])('rejects malformed group DTO: %j', patch => {
    expect(() => parseWorkerGroup({ ...group, ...patch })).toThrow()
  })
  it('rejects duplicated identities and globally duplicated workers across apparatus', () => {
    expect(() => parseWorkerGroups([group, group])).toThrow()
    expect(() => parseWorkerGroups([group, { ...group, apparatus_id: secondApparatusId }])).toThrow()
    const historical = parseWorkerGroup({ ...group, workers: [] })
    expect(historical.worker_ids).toEqual([worker.id])
  })
})

describe('worker group collision, conflict and exact preflight', () => {
  it('blocks same-name create instead of silently replacing native upsert state', async () => {
    const fetch = wire({ groups: [group] })
    await expect(api().execute(createWorkerGroupOperation(input))).rejects.toBeInstanceOf(WorkerGroupConflict)
    expect(putCalls(fetch)).toHaveLength(0)
  })
  it('blocks a stale edit and does not mutate its original draft or baseline', async () => {
    const operation = createWorkerGroupOperation({ ...input, shift: 'tun' }, group), fetch = wire({ groups: [{ ...group, accounting_enabled: true }] })
    await expect(api().execute(operation)).rejects.toBeInstanceOf(WorkerGroupConflict)
    expect(operation.baseline?.accounting_enabled).toBe(false); expect(operation.input.shift).toBe('tun')
    expect(Object.isFrozen(operation.input.worker_ids)).toBe(true); expect(Object.isFrozen(operation.baseline?.workers[0])).toBe(true)
    expect(putCalls(fetch)).toHaveLength(0)
  })
  it('blocks renaming or moving into another group identity', async () => {
    const other = { ...group, apparatus_id: secondApparatusId, apparatus: 'Laminatsiya 1', worker_ids: [], workers: [] }
    const fetch = wire({ groups: [group, other] })
    await expect(api().execute(createWorkerGroupOperation({ ...input, apparatus_id: secondApparatusId, apparatus: 'Laminatsiya 1' }, group))).rejects.toThrow('nomli guruh')
    expect(putCalls(fetch)).toHaveLength(0)
  })
  it('blocks globally duplicated membership on a different apparatus', async () => {
    const other = { ...group, apparatus_id: secondApparatusId, apparatus: 'Laminatsiya 1', group_code: 'B GURUH', worker_ids: [secondWorker.id], workers: [secondWorker] }
    const fetch = wire({ groups: [group, other] })
    await expect(api().execute(createWorkerGroupOperation({ ...input, worker_ids: [worker.id, secondWorker.id] }, group))).rejects.toThrow('B GURUH')
    expect(putCalls(fetch)).toHaveLength(0)
  })
  it.each([{ apparatusResult: { ...apparatus, lifecycle: { state: 'retired' } } }, { apparatusResult: { ...apparatus, apparatus_id: secondApparatusId } }, { apparatusResult: { ...apparatus, display: { display_name: 'Renamed' } } }, { detail: { ...worker, id: 'other' } }, { detail: { ...worker, active: false } }])('validates the selected exact native apparatus and active worker before PUT', async patch => {
    const fetch = wire(patch)
    try { await api().execute(createWorkerGroupOperation(input)); expect.fail('invalid exact choice accepted') } catch (error) { expect(error).not.toBeInstanceOf(WorkerGroupUnknown) }
    expect(putCalls(fetch)).toHaveLength(0)
  })
  it('does not label a preflight abort as an uncertain dispatched write', async () => {
    const fetch = wire(), controller = new AbortController(); controller.abort()
    await expect(api().execute(createWorkerGroupOperation(input), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('worker group uncertain writes and RAM intent continuity', () => {
  it.each([{}, { ok: false }, { ...group, group_code: 'OTHER' }, { ...group, shift: 'tun' }, { ...group, start_time: '09:00' }, { ...group, work_days_per_week: 5 }, { ...group, start_day: 'tuesday' }, { ...group, accounting_enabled: true }, { ...group, worker_ids: [], workers: [] }, { ...group, workers: [] }])('never treats malformed/mismatched HTTP 200 as success: %j', async receipt => {
    const operation = createWorkerGroupOperation(input), fetch = wire({ receipt })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'WorkerGroupUnknown', operation })
    expect(putCalls(fetch)).toHaveLength(1)
    expect(fetch.mock.calls).toHaveLength(4)
  })
  it('retains an interrupted dispatched save and never retries or performs automatic read recovery', async () => {
    const operation = createWorkerGroupOperation(input), controller = new AbortController()
    const fetch = wire({ onMutation: () => controller.abort() })
    await expect(api().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'WorkerGroupUnknown', operation })
    expect(putCalls(fetch)).toHaveLength(1); expect(fetch.mock.calls).toHaveLength(4)
  })
  it('distinguishes known native business rejections from an uncertain network/server result', async () => {
    const operation = createWorkerGroupOperation(input)
    wire({ status: 400, receipt: { error: 'worker is duplicated in worker groups' } })
    await expect(api().execute(operation)).rejects.toMatchObject({ status: 400, code: 'worker is duplicated in worker groups' })
    wire({ status: 503, receipt: { error: 'worker group store failed' } })
    await expect(api().execute(operation)).rejects.toBeInstanceOf(WorkerGroupUnknown)
    const fetch = wire({ mutationFailure: new TypeError('lost') })
    await expect(api().execute(operation)).rejects.toBeInstanceOf(WorkerGroupUnknown)
    expect(putCalls(fetch)).toHaveLength(1)
  })
  it('observes a matching current value without claiming ownership or retransmitting a write', async () => {
    const operation = createWorkerGroupOperation(input), fetch = wire({ groups: [group] })
    const observation = await api().observe(operation)
    expect(observation).toMatchObject({ state: 'matches', target: group })
    expect(observation).not.toHaveProperty('recovered'); expect(observation).not.toHaveProperty('saved')
    expect(putCalls(fetch)).toHaveLength(0); expect(fetch.mock.calls).toHaveLength(1)
  })
  it.each([408, 429, 503])('retains an uncertain dispatched HTTP %s without retry', async status => {
    const operation = createWorkerGroupOperation(input), fetch = wire({ status, receipt: { error: `http_${status}` } })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'WorkerGroupUnknown', operation })
    expect(putCalls(fetch)).toHaveLength(1)
  })
  it('observes missing/changed/renamed identities as current state only', async () => {
    const operation = createWorkerGroupOperation({ ...input, group_code: 'RENAMED' }, group)
    wire({ groups: [group] })
    expect(await api().observe(operation)).toMatchObject({ state: 'missing', previous: group })
    wire({ groups: [{ ...group, group_code: 'RENAMED', shift: 'tun' }] })
    expect(await api().observe(operation)).toMatchObject({ state: 'different' })
  })
  it('keeps the exact original operation across dialog/remount scope access and blocks resubmission', () => {
    const operation = createWorkerGroupOperation(input), ledger = workerGroupIntentLedger('worker-groups-test-continuity'), other = workerGroupIntentLedger('worker-groups-test-other')
    ledger.begin(operation); ledger.unknown(operation)
    expect(workerGroupIntentLedger('worker-groups-test-continuity')).toBe(ledger)
    expect(ledger.snapshot()?.operation).toBe(operation); expect(other.snapshot()).toBeNull()
    expect(() => ledger.begin(createWorkerGroupOperation(input))).toThrow('takrorlanmaydi')
    expect(() => ledger.resolveReviewed(operation)).toThrow('joriy ma’lumotni')
    ledger.observe(operation, { groups: [group], target: group, state: 'matches' })
    expect(ledger.snapshot()?.status).toBe('unknown')
    ledger.resolveReviewed(operation); expect(ledger.snapshot()).toBeNull()
  })
  it('ignores stale completion/observation from a different original intent', () => {
    const ledger = new WorkerGroupIntentLedger(), operation = createWorkerGroupOperation(input), other: WorkerGroupOperation = createWorkerGroupOperation({ ...input, group_code: 'B GURUH' }), changed = vi.fn()
    const unsubscribe = ledger.subscribe(changed)
    ledger.begin(operation); ledger.unknown(operation)
    ledger.finish(other); ledger.observe(other, { groups: [], state: 'missing' })
    expect(ledger.snapshot()?.operation).toBe(operation); expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe(); ledger.finish(operation); expect(changed).toHaveBeenCalledTimes(2)
    expect(workerGroupIdentity(group)).not.toBe(workerGroupIdentity({ ...group, apparatus_id: secondApparatusId }))
    expect(workerGroupError(new WorkerGroupUnknown(operation))).toContain('qayta yuborilmaydi')
  })
})
