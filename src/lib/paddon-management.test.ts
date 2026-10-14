import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Session } from './api-types'
import {
  PaddonManagementApi, PaddonManagementConflict, PaddonManagementIntentLedger, PaddonManagementUnknown,
  canManagePaddonManagement, canReadPaddonManagement, freeMovementOperation, paddonManagementIntentLedger,
  paddonManagementPath, parsePaddonManagementSettings, samePaddonManagementSettings,
} from './paddon-management'
import type { PaddonManagementOperation, PaddonManagementSettings } from './paddon-management'

const initial: PaddonManagementSettings = { free_movement_enabled: false, worker_visibility_enabled: true }
const envelope = (settings: PaddonManagementSettings) => ({ ok: true, settings })
function session(capabilities = ['admin.access'], role = 'admin', ref = 'qa-admin'): Session {
  return { token: 'local-test-only', profile: { role, ref, display_name: 'QA Administrator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
}
function api(principal = session(), current?: () => boolean) { return new PaddonManagementApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test-only' }), principal, current) }
type WireOptions = { method: string; body?: string; headers: Headers; signal: AbortSignal }
function wire({ settings = initial, read, reply, status = 200, failure, onRead, onWrite, raw, delayed }:
  { settings?: PaddonManagementSettings; read?: unknown; reply?: unknown; status?: number; failure?: Error; raw?: string;
    onRead?: () => void; onWrite?: () => void; delayed?: () => Promise<void> } = {}) {
  let current = { ...settings }
  const fetch = vi.fn(async (_url: URL, options: WireOptions) => {
    if (options.method === 'GET') { onRead?.(); return new Response(JSON.stringify(read ?? envelope(current)), { status: 200 }) }
    onWrite?.(); await delayed?.()
    if (failure) throw failure
    if (status === 200) current = { ...current, free_movement_enabled: JSON.parse(options.body!).free_movement_enabled }
    return new Response(status === 204 ? null : raw ?? JSON.stringify(reply ?? envelope(current)), { status })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, current: () => current, change: (next: PaddonManagementSettings) => { current = { ...next } } }
}
const writes = (fetch: ReturnType<typeof wire>['fetch']) => fetch.mock.calls.filter(([, options]) => options.method !== 'GET')
async function run(service: PaddonManagementApi, ledger: PaddonManagementIntentLedger, operation: PaddonManagementOperation, signal?: AbortSignal) {
  ledger.begin(operation)
  try { const result = await service.execute(operation, signal, () => ledger.dispatched(operation)); ledger.finish(operation); return result }
  catch (error) { if (error instanceof PaddonManagementUnknown) ledger.unknown(operation); else ledger.finish(operation); throw error }
}
afterEach(() => vi.unstubAllGlobals())

describe('native S08 settings guards and partial request', () => {
  it.each(['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'])('GET uses native capability OR for %s, independently of actual role', async capability => {
    const { fetch } = wire(), principal = session([capability], 'aparatchi')
    expect(canReadPaddonManagement(principal)).toBe(true)
    expect(await api(principal).settings()).toEqual(initial)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0].pathname).toBe(paddonManagementPath)
    expect(fetch.mock.calls[0]![0].search).toBe('')
    expect(fetch.mock.calls[0]![1].method).toBe('GET')
  })
  it('does not infer GET permission from the role or unrelated capabilities', async () => {
    const { fetch } = wire()
    for (const principal of [session([], 'admin'), session(['admin.settings.read'], 'admin'), session(['catalog.item.read'], 'aparatchi')]) {
      expect(canReadPaddonManagement(principal)).toBe(false)
      await expect(api(principal).settings()).rejects.toMatchObject({ status: 403 })
    }
    expect(canReadPaddonManagement(null)).toBe(false); expect(fetch).not.toHaveBeenCalled()
  })
  it.each([true, false])('PUT(%s) needs admin.access and the actual admin role', async enabled => {
    const { fetch } = wire(), operation = freeMovementOperation(initial, enabled)
    for (const principal of [session(['admin.access'], 'aparatchi'), session(['admin.access'], 'tayyorlov_masteri'), session(['production.map.manage'], 'admin'), session(['admin.settings.manage'], 'admin'), session([], 'admin')]) {
      expect(canManagePaddonManagement(principal)).toBe(false)
      await expect(api(principal).execute(operation)).rejects.toMatchObject({ status: 403 })
    }
    expect(canManagePaddonManagement(null)).toBe(false); expect(fetch).not.toHaveBeenCalled()
  })
  it('requires the native nonempty actor ref for writes without adding it to the body', async () => {
    const { fetch } = wire()
    for (const ref of ['', '  ', '\u2003\n']) await expect(api(session(['admin.access'], 'admin', ref)).execute(freeMovementOperation(initial, true))).rejects.toMatchObject({ status: 400, code: 'paddon_invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(api(session(['apparatus.queue.read'], 'aparatchi', '')).settings()).resolves.toEqual(initial)
  })
  it.each([true, false])('sends one exact partial PUT for %s and retains the returned visibility', async enabled => {
    const baseline = { free_movement_enabled: !enabled, worker_visibility_enabled: true }, { fetch } = wire({ settings: baseline })
    const saved = await api().execute(freeMovementOperation(baseline, enabled))
    expect(saved).toEqual({ free_movement_enabled: enabled, worker_visibility_enabled: true })
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PUT'])
    const [url, options] = writes(fetch)[0]!
    expect(url.pathname).toBe(paddonManagementPath); expect(url.search).toBe('')
    expect(JSON.parse(options.body!)).toEqual({ free_movement_enabled: enabled })
    expect(options.headers.get('Content-Type')).toBe('application/json')
    expect([...options.headers.keys()].some(key => /idempot|revision|compare/i.test(key))).toBe(false)
  })
})

describe('strict native boolean envelope and frozen intent', () => {
  it.each([false, true])('maps the two flags independently when free movement is %s', free => {
    const result = parsePaddonManagementSettings({ ok: true, settings: { free_movement_enabled: free, worker_visibility_enabled: !free, token: 'UNSOLICITED' } })
    expect(result).toEqual({ free_movement_enabled: free, worker_visibility_enabled: !free })
    expect(Object.isFrozen(result)).toBe(true)
  })
  it.each([
    null, [], {}, { ok: false, settings: initial }, { ok: 'true', settings: initial }, { ok: true },
    { ok: true, settings: [] }, { ok: true, settings: { worker_visibility_enabled: true } },
    { ok: true, settings: { free_movement_enabled: false } },
    ...['true', 1, null, undefined].flatMap(value => [
      { ok: true, settings: { ...initial, free_movement_enabled: value } },
      { ok: true, settings: { ...initial, worker_visibility_enabled: value } },
    ]),
    { ok: true, settings: { freeMovementEnabled: false, workerVisibilityEnabled: true } },
  ])('rejects missing, malformed and renamed flags: %j', value => { expect(() => parsePaddonManagementSettings(value)).toThrow(ApiError) })
  it('freezes a credential-free copy and offers no visibility input', () => {
    const source = { ...initial, token: 'BASELINE-SECRET', revision: 12 }, operation = freeMovementOperation(source, true)
    source.free_movement_enabled = true; source.worker_visibility_enabled = false
    expect(operation).toEqual({ kind: 'free-movement', input: { free_movement_enabled: true }, baseline: initial })
    expect(Object.isFrozen(operation) && Object.isFrozen(operation.input) && Object.isFrozen(operation.baseline)).toBe(true)
    expect(JSON.stringify(operation)).not.toContain('SECRET')
    expect(samePaddonManagementSettings(operation.baseline, initial)).toBe(true)
    expect(() => freeMovementOperation(initial, 'true' as unknown as boolean)).toThrow(ApiError)
  })
  it.each([
    { kind: 'visibility', input: { worker_visibility_enabled: true } },
    { kind: 'free-movement', input: { free_movement_enabled: true, worker_visibility_enabled: false } },
    { kind: 'free-movement', input: { free_movement_enabled: true }, baseline: { ...initial, token: 'SECRET' } },
    { kind: 'free-movement', input: { free_movement_enabled: 'true' } },
  ])('rejects forged write fields before any request', async value => {
    const { fetch } = wire(), operation = Object.freeze({ baseline: Object.freeze(initial), ...value, input: Object.freeze(value.input) }) as unknown as PaddonManagementOperation
    await expect(api().execute(operation)).rejects.toMatchObject({ status: 400 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects a mutable plan before any request', async () => {
    const { fetch } = wire()
    await expect(api().execute({ kind: 'free-movement', input: { free_movement_enabled: true }, baseline: initial })).rejects.toMatchObject({ status: 400 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('fresh baseline and cancellation gates before dispatch', () => {
  it.each([
    { free_movement_enabled: true, worker_visibility_enabled: true },
    { free_movement_enabled: false, worker_visibility_enabled: false },
  ])('stops concurrent changes to either flag at the fresh GET', async current => {
    const { fetch } = wire({ settings: current }), ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true)
    await expect(run(api(), ledger, operation)).rejects.toMatchObject({ name: 'PaddonManagementConflict', current })
    expect(writes(fetch)).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1); expect(ledger.snapshot()).toBeNull()
  })
  it('does a fresh GET after an earlier displayed read; no cached baseline authorizes a write', async () => {
    const server = wire(), service = api(), displayed = await service.settings()
    server.change({ ...initial, free_movement_enabled: true })
    await expect(service.execute(freeMovementOperation(displayed, false))).rejects.toBeInstanceOf(PaddonManagementConflict)
    expect(server.fetch).toHaveBeenCalledTimes(2); expect(writes(server.fetch)).toHaveLength(0)
  })
  it('keeps malformed preflight responses outside the dispatched unknown path', async () => {
    const { fetch } = wire({ read: { ok: true, settings: { worker_visibility_enabled: true } } }), ledger = new PaddonManagementIntentLedger()
    await expect(run(api(), ledger, freeMovementOperation(initial, true))).rejects.toMatchObject({ code: 'invalid_response' })
    expect(writes(fetch)).toHaveLength(0); expect(ledger.snapshot()).toBeNull()
  })
  it('does not send a GET or PUT when cancelled before start', async () => {
    const { fetch } = wire(), controller = new AbortController(), ledger = new PaddonManagementIntentLedger()
    controller.abort()
    await expect(run(api(), ledger, freeMovementOperation(initial, true), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled(); expect(ledger.snapshot()).toBeNull()
  })
  it('interrupts a pending GET without retaining a sent intent', async () => {
    const controller = new AbortController(), { fetch } = wire({ onRead: () => controller.abort() }), ledger = new PaddonManagementIntentLedger()
    await expect(run(api(), ledger, freeMovementOperation(initial, true), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes(fetch)).toHaveLength(0); expect(ledger.snapshot()).toBeNull()
  })
  it.each(['before', 'during'])('checks the actor/session scope %s preflight', async when => {
    let current = when !== 'before'
    const { fetch } = wire({ onRead: () => { current = false } }), ledger = new PaddonManagementIntentLedger()
    await expect(run(api(session(), () => current), ledger, freeMovementOperation(initial, true))).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes(fetch)).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(when === 'before' ? 0 : 1); expect(ledger.snapshot()).toBeNull()
  })
  it('honors an expired owner reservation at the final dispatch callback', async () => {
    const { fetch } = wire(), service = api(), operation = freeMovementOperation(initial, true), ledger = new PaddonManagementIntentLedger()
    ledger.begin(operation)
    await expect(service.execute(operation, undefined, () => { ledger.interrupt(operation); return ledger.dispatched(operation) })).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes(fetch)).toHaveLength(0); expect(ledger.snapshot()).toBeNull()
  })
  it('rechecks cancellation after the final dispatch callback', async () => {
    const controller = new AbortController(), { fetch } = wire()
    await expect(api().execute(freeMovementOperation(initial, true), controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes(fetch)).toHaveLength(0)
  })
  it('detects actual actor changes during preflight and rechecks revoked capability before PUT', async () => {
    const principal = session(), first = wire({ onRead: () => { principal.profile.ref = 'another-admin' } })
    await expect(api(principal).execute(freeMovementOperation(initial, true))).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes(first.fetch)).toHaveLength(0)
    const revoked = session(), second = wire({ onRead: () => { revoked.capabilities = ['apparatus.queue.read'] } })
    await expect(api(revoked).execute(freeMovementOperation(initial, true))).rejects.toMatchObject({ status: 403 })
    expect(writes(second.fetch)).toHaveLength(0)
  })
  it('does not pretend the read preflight supplies a native CAS after dispatch', async () => {
    const server = wire({ onWrite: () => server.change({ ...initial, worker_visibility_enabled: false }) })
    const saved = await api().execute(freeMovementOperation(initial, true))
    expect(saved).toEqual({ free_movement_enabled: true, worker_visibility_enabled: false })
    expect(JSON.parse(writes(server.fetch)[0]![1].body!)).toEqual({ free_movement_enabled: true })
  })
})

describe('exact acknowledgement and unknown outcomes after one PUT', () => {
  it.each([400, 401, 403, 404, 405, 409])('keeps native HTTP %s as a known refusal and does not retry', async status => {
    const { fetch } = wire({ status, reply: { error: status === 403 ? 'forbidden' : 'paddon_invalid_input' } }), ledger = new PaddonManagementIntentLedger()
    await expect(run(api(), ledger, freeMovementOperation(initial, true))).rejects.toMatchObject({ status })
    expect(writes(fetch)).toHaveLength(1); expect(ledger.snapshot()).toBeNull()
  })
  it.each([408, 429, 500, 504])('retains HTTP %s as unknown without application replay', async status => {
    const { fetch } = wire({ status, reply: { error: 'unconfirmed' } }), ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true)
    await expect(run(api(), ledger, operation)).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(ledger.snapshot()).toMatchObject({ operation, status: 'unknown', dispatched: true })
    await expect(api().execute(operation)).rejects.toThrow('takrorlanmaydi')
    expect(() => ledger.begin(freeMovementOperation(initial, false))).toThrow('takrorlanmaydi')
    expect(writes(fetch)).toHaveLength(1)
  })
  it.each([
    {}, { ok: false, settings: initial }, { ok: true, settings: { free_movement_enabled: true } },
    { ok: true, settings: { worker_visibility_enabled: true } },
    { ok: true, settings: { free_movement_enabled: 'true', worker_visibility_enabled: true } },
    { ok: true, settings: { free_movement_enabled: true, worker_visibility_enabled: 'true' } },
    envelope(initial),
  ])('retains malformed/missing/mismatched 200 acknowledgements: %j', async reply => {
    const { fetch } = wire({ reply }), ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true)
    await expect(run(api(), ledger, operation)).rejects.toMatchObject({ name: 'PaddonManagementUnknown', operation })
    expect(ledger.snapshot()?.status).toBe('unknown'); expect(writes(fetch)).toHaveLength(1)
  })
  it('does not accept the visibility flag as a swapped free-movement acknowledgement', async () => {
    const { fetch } = wire({ reply: envelope({ free_movement_enabled: true, worker_visibility_enabled: false }) }), operation = freeMovementOperation(initial, false)
    await expect(api().execute(operation)).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(writes(fetch)).toHaveLength(1)
  })
  it.each([201, 204])('requires the native 200 acknowledgement, including HTTP %s', async status => {
    const { fetch } = wire({ status })
    await expect(api().execute(freeMovementOperation(initial, true))).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(writes(fetch)).toHaveLength(1)
  })
  it.each(['{', ''])('retains a lost/malformed JSON reply %j without another write', async raw => {
    const { fetch } = wire({ raw })
    await expect(api().execute(freeMovementOperation(initial, true))).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(writes(fetch)).toHaveLength(1)
  })
  it('retains a lost response, then observes with GET only and never proves ownership', async () => {
    const failed = wire({ failure: new TypeError('reply lost') }), ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true), service = api()
    await expect(run(service, ledger, operation)).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(writes(failed.fetch)).toHaveLength(1)
    const recovery = wire({ settings: { free_movement_enabled: true, worker_visibility_enabled: false } }), observation = await service.observe(operation)
    expect(observation).toEqual({ settings: { free_movement_enabled: true, worker_visibility_enabled: false }, state: 'matches' })
    ledger.observe(operation, observation); ledger.finish(operation)
    expect(ledger.snapshot()).toMatchObject({ status: 'unknown', observation })
    expect(recovery.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET'])
    expect(() => ledger.begin(freeMovementOperation(observation.settings, false))).toThrow('takrorlanmaydi')
    ledger.resolveReviewed(operation); expect(ledger.snapshot()).toBeNull()
    await expect(service.execute(operation)).rejects.toThrow('takrorlanmaydi')
    expect(writes(recovery.fetch)).toHaveLength(0)
  })
  it('retains abort or actor/session loss after dispatch', async () => {
    const controller = new AbortController(), abortedWire = wire({ onWrite: () => controller.abort() }), firstLedger = new PaddonManagementIntentLedger()
    await expect(run(api(), firstLedger, freeMovementOperation(initial, true), controller.signal)).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(firstLedger.snapshot()?.status).toBe('unknown'); expect(writes(abortedWire.fetch)).toHaveLength(1)
    let current = true
    const scopeWire = wire({ onWrite: () => { current = false } }), secondLedger = new PaddonManagementIntentLedger()
    await expect(run(api(session(), () => current), secondLedger, freeMovementOperation(initial, true))).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(secondLedger.snapshot()?.status).toBe('unknown'); expect(writes(scopeWire.fetch)).toHaveLength(1)
  })
  it('late exact acknowledgements cannot clear an interrupted owner intent', async () => {
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), dispatched = new Promise<void>(resolve => { started = resolve })
    const { fetch } = wire({ onWrite: started, delayed: () => waiting }), ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true), service = api()
    ledger.begin(operation)
    const result = service.execute(operation, undefined, () => ledger.dispatched(operation))
    await dispatched; ledger.interrupt(operation); release()
    await expect(result).resolves.toEqual({ free_movement_enabled: true, worker_visibility_enabled: true })
    ledger.finish(operation)
    expect(ledger.snapshot()).toMatchObject({ operation, status: 'unknown', dispatched: true })
    expect(writes(fetch)).toHaveLength(1)
  })
})

describe('actor/session RAM ledger and read-only review', () => {
  it('isolates scope lookup and owner transitions while retaining a remounted session intent', () => {
    const scope = 'qa-management:actor-a:session-1', first = paddonManagementIntentLedger(scope), other = paddonManagementIntentLedger('qa-management:actor-b:session-1'), next = paddonManagementIntentLedger('qa-management:actor-a:session-2')
    const operation = freeMovementOperation(initial, true), foreign = freeMovementOperation(initial, false)
    first.begin(operation); expect(first.dispatched(operation)).toBe(true); first.unknown(operation)
    expect(paddonManagementIntentLedger(scope)).toBe(first)
    expect(other.snapshot()).toBeNull(); expect(next.snapshot()).toBeNull()
    other.finish(operation); first.finish(foreign); expect(first.dispatched(foreign)).toBe(false)
    expect(first.snapshot()).toMatchObject({ operation, status: 'unknown' })
    expect(() => first.resolveReviewed(operation)).toThrow('tekshiring')
    expect(() => paddonManagementIntentLedger('  ')).toThrow('sessiya')
  })
  it('drops an interrupted preflight reservation and permits a deliberate retry before any dispatch', () => {
    const ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true)
    ledger.begin(operation); ledger.interrupt(operation); expect(ledger.snapshot()).toBeNull()
    ledger.begin(operation); expect(ledger.snapshot()?.dispatched).toBe(false)
    expect(ledger.dispatched(operation)).toBe(true); expect(ledger.dispatched(operation)).toBe(false)
  })
  it('fences concurrent execute calls for the same frozen plan to a single PUT', async () => {
    const { fetch } = wire(), service = api(), operation = freeMovementOperation(initial, true)
    const results = await Promise.allSettled([service.execute(operation), service.execute(operation)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(writes(fetch)).toHaveLength(1)
    await expect(api().execute(operation)).rejects.toThrow('takrorlanmaydi')
    expect(writes(fetch)).toHaveLength(1)
  })
  it('derives observation comparisons from the retained intent and freezes the result', () => {
    const ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true), source = { ...initial }
    ledger.begin(operation); ledger.dispatched(operation); ledger.unknown(operation)
    ledger.observe(operation, { settings: source, state: 'matches' })
    source.free_movement_enabled = true
    expect(ledger.snapshot()?.observation).toEqual({ settings: initial, state: 'different' })
    expect(Object.isFrozen(ledger.snapshot()) && Object.isFrozen(ledger.snapshot()?.observation) && Object.isFrozen(ledger.snapshot()?.observation?.settings)).toBe(true)
    ledger.unknown(operation); ledger.finish(operation)
    expect(ledger.snapshot()?.observation).toEqual({ settings: initial, state: 'different' })
    ledger.resolveReviewed(operation); expect(ledger.snapshot()).toBeNull()
  })
  it('uses no persistent storage and retains no credential fields', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage)
    wire({ failure: new TypeError('reply lost') })
    const ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true)
    await expect(run(api(), ledger, operation)).rejects.toBeInstanceOf(PaddonManagementUnknown)
    expect(JSON.stringify(ledger.snapshot())).not.toContain('local-test-only')
    expect(JSON.stringify(ledger.snapshot())).not.toMatch(/token|authorization|password|credential|actor_ref/i)
    expect(new PaddonManagementIntentLedger().snapshot()).toBeNull()
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.removeItem).not.toHaveBeenCalled()
  })
  it('does not resolve an unknown intent when a recovery read fails', async () => {
    const ledger = new PaddonManagementIntentLedger(), operation = freeMovementOperation(initial, true)
    ledger.begin(operation); ledger.dispatched(operation); ledger.unknown(operation)
    const { fetch } = wire({ read: { ok: true, settings: { free_movement_enabled: true } } })
    await expect(api().observe(operation)).rejects.toMatchObject({ code: 'invalid_response' })
    expect(ledger.snapshot()?.status).toBe('unknown'); expect(ledger.snapshot()?.observation).toBeUndefined()
    expect(writes(fetch)).toHaveLength(0)
  })
})
