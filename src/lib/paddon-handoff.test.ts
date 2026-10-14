import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import type { Session } from './api-types'
import { parseApparatusProjection } from './apparatus-admin'
import {
  PaddonHandoffApi, PaddonHandoffConflict, PaddonHandoffIntentLedger, PaddonHandoffUnknown, canCreatePaddonSuccessor,
  canReadHandoffApparatus, canUsePaddonHandoff, canUsePaddonHandoffApparatus, choosePaddonOperation, clearPaddonOperation,
  isHandoffCutApparatus, nextPaddonOperation, paddonActivePath, paddonHandoffError, paddonHandoffIntentLedger, paddonNextPath,
  parseActivePaddonSelection,
} from './paddon-handoff'
import type { ActivePaddonSelection } from './paddon-handoff'
import type { PaddonSummary } from './paddons'

const cutId = 'apparatus:qa:cut-1', otherId = 'apparatus:qa:cut-2', printId = 'apparatus:qa:print-1'
const initial: ActivePaddonSelection = { apparatus: cutId, code: null }
const summary: PaddonSummary = { id: 'opaque-source-id', code: '00002', location: '', note: '', created_by_ref: 'qa-worker-1', created_by_display_name: 'QA Operator', created_at_unix: 100, updated_at_unix: 101, item_count: 0, locked_at_unix: 101, total_gross_kg: 0, total_net_kg: 0 }
const successor: PaddonSummary = { ...summary, id: 'opaque-successor-id', code: '00003', locked_at_unix: null }
function projection(id = cutId, operation: 'cut' | 'print' = 'cut', retired = false) {
  return { apparatus_id: id, source_revision: 1, source_aasx_sha256: 'a'.repeat(64), display: { display_name: 'QA Machine', description: '', catalog_order: 1 },
    equipment_class_id: 'equipment-class:qa', physical_asset_id: `physical-asset:${id.split(':').at(-1)}`, hierarchy: { enterprise_id: 'enterprise:qa', site_id: 'site:qa', area_id: 'area:qa', work_center_id: 'work-center:qa', work_unit_id: 'work-unit:qa' },
    capabilities: { [operation]: 1 }, execution_profile: { operation, technology: operation === 'cut' ? 'slitting' : 'rotogravure', color_station_count: operation === 'cut' ? null : 7, virtual_tasks: 'disabled', capability_compatible_reroute: true },
    training: { enabled: false, queue_enabled: false, material_tracking_enabled: false }, placement: null, lifecycle: { state: retired ? 'retired' : 'active', retirement_reason: retired ? 'QA retired' : null } }
}
function session(capabilities = ['apparatus.queue.manage', 'apparatus.queue.read'], role = 'aparatchi', assigned = [cutId]): Session {
  return { token: 'local-test', profile: { role, ref: 'qa-worker-1', display_name: 'QA Operator' }, capabilities, assigned_apparatus: assigned, assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
}
function api(principal = session()) { return new PaddonHandoffApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), principal) }
type WireOptions = { method: string; body?: string; headers: Headers; signal: AbortSignal }
function detail(code: string) { const paddon = code === summary.code ? summary : { ...successor, code }; return { ok: true, paddon, items: [], available_items: [], free_movement_enabled: false, can_manage_items: paddon.locked_at_unix === null, can_unlock: paddon.locked_at_unix !== null } }
function wire({ active = { ok: true, ...initial } as unknown, exact = projection() as unknown, catalog = [projection()] as unknown[], paddonDetail = detail, result,
  status = 200, failure, onMutation, onRead, list = { ok: true, paddons: [successor] } as unknown }: {
  active?: unknown; exact?: unknown; catalog?: unknown[]; paddonDetail?: (code: string) => unknown; result?: unknown; status?: number; failure?: Error; onMutation?: () => void; onRead?: (url: URL) => void; list?: unknown;
} = {}) {
  const fetch = vi.fn(async (url: URL, options: WireOptions) => {
    if (options.method !== 'GET') {
      onMutation?.(); if (failure) throw failure
      const body = JSON.parse(options.body!), value = result ?? (options.method === 'POST' ? { ok: true, apparatus: cutId, code: successor.code, paddon: successor } : { ok: true, apparatus: body.apparatus, code: body.code || null })
      return new Response(status === 204 ? null : JSON.stringify(value), { status })
    }
    onRead?.(url)
    const value = url.pathname === paddonActivePath ? active : url.pathname.endsWith('/paddons/detail') ? paddonDetail(url.searchParams.get('code')!)
      : url.pathname.endsWith('/paddons') ? list : url.pathname.endsWith('/apparatus') ? catalog : exact
    return new Response(JSON.stringify(value), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch); return fetch
}
function writes(fetch: ReturnType<typeof wire>) { return fetch.mock.calls.filter(([, options]) => options.method !== 'GET') }
afterEach(() => vi.unstubAllGlobals())

describe('native active-paddon guards and exact canonical CUT reads', () => {
  it('requires active-capability OR even for GET; queue.read cannot view or clear active selection', async () => {
    const fetch = wire(), service = api(session(['apparatus.queue.read']))
    expect(canUsePaddonHandoff(session(['apparatus.queue.read']))).toBe(false)
    for (const action of [() => service.active(cutId), () => service.selectable(), () => service.execute(clearPaddonOperation(initial))]) await expect(action()).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['admin.access', 'production.map.manage', 'apparatus.queue.manage'])('uses native GET OR for %s and checks exact assignment unless admin.access exists', async capability => {
    const fetch = wire(), principal = session([capability], 'tayyorlov_masteri', capability === 'admin.access' ? [] : [cutId])
    expect(await api(principal).active(cutId)).toEqual(initial); expect(fetch).toHaveBeenCalledTimes(1)
    expect(canUsePaddonHandoffApparatus(principal, cutId)).toBe(true)
    if (capability !== 'admin.access') { const denied = api(session([capability], 'admin', ['QA Machine'])); await expect(denied.active(cutId)).rejects.toMatchObject({ status: 400, code: 'apparatus_not_assigned' }) }
  })
  it('does not invent queue.manage permission for canonical catalog reads or infer actual worker role from capabilities', async () => {
    const fetch = wire(), principal = session(['apparatus.queue.manage'])
    expect(canReadHandoffApparatus(principal)).toBe(false); await api(principal).active(cutId)
    await expect(api(principal).apparatus()).rejects.toMatchObject({ status: 403 }); expect(fetch).toHaveBeenCalledTimes(1)
    for (const denied of [session(['admin.access', 'apparatus.queue.manage'], 'admin'), session(['admin.access'], 'aparatchi'), session(['admin.access', 'apparatus.queue.manage'], 'aparatchi', []), session(['apparatus.queue.manage'], 'aparatchi', ['QA Machine'])]) expect(canCreatePaddonSuccessor(denied, cutId)).toBe(false)
    expect(canCreatePaddonSuccessor(session(), cutId)).toBe(true)
  })
  it('requires nonempty actual actor role/ref and canonical apparatus identity before native request', async () => {
    const fetch = wire(), principal = { ...session(['admin.access']), profile: { role: 'admin', ref: '', display_name: 'Admin' } }
    await expect(api(principal).active(cutId)).rejects.toMatchObject({ code: 'paddon_invalid_input' })
    await expect(api().active('QA Machine')).rejects.toThrow('canonical'); expect(fetch).not.toHaveBeenCalled()
  })
  it('reports the native500 bound before active CUT filtering, sends name search, and revalidates exact ID independently', async () => {
    const catalog = Array.from({ length: 500 }, (_, index) => projection(`apparatus:qa:machine-${index}`, index < 499 ? 'print' : 'cut'))
    const fetch = wire({ catalog })
    const result = await api().apparatus('  Machine  '); expect(result.bounded).toBe(true); expect(result.items).toHaveLength(1)
    const url = fetch.mock.calls[0]![0]; expect(url.searchParams.get('q')).toBe('Machine'); expect(url.searchParams.get('limit')).toBe('500')
    expect(await api().projection(cutId)).toEqual(parseApparatusProjection(projection()))
    expect(fetch.mock.calls[1]![0].pathname).toBe(`/v1/mobile/admin/apparatus/${encodeURIComponent(cutId)}`)
    expect(isHandoffCutApparatus(projection())).toBe(true); expect(isHandoffCutApparatus(projection(printId, 'print'))).toBe(false); expect(isHandoffCutApparatus({ apparatus_id: cutId })).toBe(false)
  })
  it.each([projection(otherId), projection(cutId, 'print'), projection(cutId, 'cut', true), { apparatus_id: cutId }])('refuses mismatched/non-CUT/retired/malformed exact projection before dispatch', async exact => {
    const fetch = wire({ exact })
    try { await api().execute(clearPaddonOperation(initial)); expect.fail('bad apparatus accepted') } catch (error) { expect(error).not.toBeInstanceOf(PaddonHandoffUnknown) }
    expect(writes(fetch)).toHaveLength(0)
  })
})

describe('strict active and bounded selectable DTOs', () => {
  it('distinguishes explicitly null selection from a missing or invalid code and strips unsolicited metadata', () => {
    expect(parseActivePaddonSelection({ ok: true, apparatus: cutId, code: null, token: 'SECRET' })).toEqual(initial)
    expect(parseActivePaddonSelection({ ok: true, apparatus: cutId, code: '00003' })).toEqual({ apparatus: cutId, code: '00003' })
  })
  it.each([{}, { ok: false, apparatus: cutId, code: null }, { ok: true, apparatus: cutId }, { ok: true, apparatus: cutId, code: undefined }, { ok: true, apparatus: cutId, code: '' }, { ok: true, apparatus: cutId, code: ' 00003 ' }, { ok: true, apparatus: cutId, code: false }, { ok: true, apparatus: 'QA Machine', code: null }])('rejects invalid active response instead of substituting no selection: %j', value => {
    expect(() => parseActivePaddonSelection(value)).toThrow()
  })
  it('GETs200 selectable-only summaries without claiming global total and supports an older code through fresh detail', async () => {
    const list = { ok: true, paddons: Array.from({ length: 200 }, (_, index) => ({ ...successor, id: `opaque-${index}`, code: String(index + 1).padStart(5, '0') })) }, fetch = wire({ list })
    const result = await api().selectable(); expect(result.items).toHaveLength(200); expect(result.bounded).toBe(true)
    expect(fetch.mock.calls[0]![0].searchParams.get('selectable_only')).toBe('true'); expect(fetch.mock.calls[0]![0].searchParams.get('limit')).toBe('200')
    await api().detail('00205'); expect(fetch.mock.calls[1]![0].searchParams.get('code')).toBe('00205')
  })
  it('freezes original active/source intent and normalizes128-byte code limit without generating native codes', () => {
    const original = { ...initial }, source = { ...summary }, operation = nextPaddonOperation(original, source), chosen = choosePaddonOperation(original, ' 00003 ')
    original.code = '99999'; source.note = 'Changed'
    expect(operation.baseline.code).toBeNull(); expect(operation.kind === 'next' && operation.source.note).toBe(''); expect(chosen.code).toBe('00003')
    for (const value of [operation, operation.baseline, operation.input, operation.kind === 'next' && operation.source]) expect(Object.isFrozen(value)).toBe(true)
    expect(() => choosePaddonOperation(initial, 'Ё'.repeat(65))).toThrow('128 bayt')
    expect(() => nextPaddonOperation(initial, successor)).toThrow('qulflangan')
  })
})

describe('single native dispatch and current-active preflight', () => {
  it('PUTs exact native apparatus/code, clears with empty string and sends no CAS/idempotency/actor fields', async () => {
    const fetch = wire(), result = await api().execute(choosePaddonOperation(initial, '00003'))
    expect(result).toEqual({ active: { apparatus: cutId, code: '00003' } }); expect(writes(fetch)).toHaveLength(1)
    const [url, options] = writes(fetch)[0]!; expect(url.pathname).toBe(paddonActivePath); expect(options.method).toBe('PUT'); expect(JSON.parse(options.body!)).toEqual({ apparatus: cutId, code: '00003' }); expect(options.headers.has('Idempotency-Key')).toBe(false)
    const clearing = wire(); expect(await api().execute(clearPaddonOperation(initial))).toEqual({ active: initial }); expect(JSON.parse(writes(clearing)[0]![1].body!)).toEqual({ apparatus: cutId, code: '' })
  })
  it('blocks a changed observed active code before any write, without timestamp/CAS guesses', async () => {
    const current = { apparatus: cutId, code: '00007' }, fetch = wire({ active: { ok: true, ...current } })
    for (const operation of [choosePaddonOperation(initial, '00003'), clearPaddonOperation(initial), nextPaddonOperation(initial, summary)]) await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonHandoffConflict', current })
    expect(writes(fetch)).toHaveLength(0)
  })
  it('blocks selecting locked or received/open paddons before PUT, even if free movement allows editing a locked one', async () => {
    for (const patch of [{ paddon: { ...successor, locked_at_unix: 100 }, free_movement_enabled: true, can_manage_items: true }, { can_manage_items: false }]) {
      const fetch = wire({ paddonDetail: code => ({ ...detail(code), ...patch }) })
      await expect(api().execute(choosePaddonOperation(initial, '00003'))).rejects.toBeInstanceOf(PaddonHandoffConflict); expect(writes(fetch)).toHaveLength(0)
    }
  })
  it('POSTs next using any visible locked source, allowing a received source and already-populated reused successor', async () => {
    const baseline = { apparatus: cutId, code: '00007' }, populated = { ...successor, item_count: 2, total_gross_kg: 77, total_net_kg: 75 }
    const fetch = wire({ active: { ok: true, ...baseline }, result: { ok: true, apparatus: cutId, code: populated.code, paddon: populated }, paddonDetail: code => ({ ...detail(code), can_manage_items: false, can_unlock: false }) })
    const result = await api().execute(nextPaddonOperation(baseline, summary)); expect(result).toEqual({ active: { apparatus: cutId, code: populated.code }, paddon: populated })
    expect(writes(fetch)[0]![0].pathname).toBe(paddonNextPath); expect(JSON.parse(writes(fetch)[0]![1].body!)).toEqual({ apparatus: cutId, code: summary.code })
    expect(fetch.mock.calls.some(([url]) => /qr|confirm|print|settings/.test(url.pathname))).toBe(false)
  })
  it('fails closed on fresh source unlock/identity change, but does not require lock ownership or source-current equality', async () => {
    for (const paddon of [{ ...summary, locked_at_unix: null }, { ...summary, id: 'changed-source-id' }, { ...summary, locked_at_unix: 202 }]) {
      const fetch = wire({ paddonDetail: () => ({ ok: true, paddon, items: [], available_items: [], free_movement_enabled: false, can_manage_items: false, can_unlock: false }) })
      await expect(api().execute(nextPaddonOperation(initial, summary))).rejects.toBeInstanceOf(PaddonHandoffConflict); expect(writes(fetch)).toHaveLength(0)
    }
  })
  it('does not mistake a cancelled preflight for an uncertain dispatched command', async () => {
    const controller = new AbortController(), fetch = wire({ onRead: () => controller.abort() })
    await expect(api().execute(clearPaddonOperation(initial), controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(writes(fetch)).toHaveLength(0)
  })
})

describe('handoff unknown results, read observations and scoped RAM ledger', () => {
  it.each([{}, { ok: true, apparatus: cutId }, { ok: true, apparatus: cutId, code: '' }, { ok: true, apparatus: otherId, code: '00003' }, { ok: true, apparatus: cutId, code: '00007' }])('retains malformed/mismatched PUT200 without automatic retry or read recovery: %j', async result => {
    const operation = choosePaddonOperation(initial, '00003'), fetch = wire({ result })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonHandoffUnknown', operation }); expect(writes(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(4)
  })
  it.each([{ ok: true, apparatus: cutId, code: null, paddon: successor }, { ok: true, apparatus: cutId, code: '00003' }, { ok: true, apparatus: cutId, code: '00003', paddon: { ...successor, locked_at_unix: 102 } }, { ok: true, apparatus: cutId, code: summary.code, paddon: summary }])('requires coherent open successor summary and explicit returned code: %j', async result => {
    const operation = nextPaddonOperation(initial, summary), fetch = wire({ result })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonHandoffUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
  })
  it.each([201, 204, 408, 429, 500, 503])('retains unexpected/uncertain dispatched HTTP%s once', async status => {
    const operation = clearPaddonOperation(initial), fetch = wire({ status, result: { error: 'uncertain' } })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonHandoffUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
  })
  it.each([400, 403, 404, 409])('reports explicit native HTTP%s refusal without unknown-intent recovery or extra calls', async status => {
    const fetch = wire({ status, result: { error: 'paddon_locked' } })
    await expect(api().execute(choosePaddonOperation(initial, '00003'))).rejects.toMatchObject({ name: 'ApiError', status }); expect(writes(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(4)
  })
  it('retains network loss and abort after dispatch with exact intent and no replay of native next', async () => {
    const operation = nextPaddonOperation(initial, summary), fetch = wire({ failure: new TypeError('lost') })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonHandoffUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
    const controller = new AbortController(), aborted = wire({ onMutation: () => controller.abort() })
    await expect(api().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'PaddonHandoffUnknown', operation }); expect(writes(aborted)).toHaveLength(1)
  })
  it('observes matching/null/current-next state only, without successor mapping lookup or ownership proof', async () => {
    const chosen = choosePaddonOperation(initial, '00003'), fetch = wire({ active: { ok: true, apparatus: cutId, code: '00003' } })
    const observed = await api().observe(chosen); expect(observed.state).toBe('matches'); expect(observed.active.code).toBe('00003'); expect(observed).not.toHaveProperty('receipt'); expect(observed).not.toHaveProperty('saved'); expect(writes(fetch)).toHaveLength(0)
    expect((await api().observe(nextPaddonOperation(initial, summary))).state).toBe('observed')
    wire(); expect(await api().observe(clearPaddonOperation(initial))).toEqual({ active: initial, state: 'matches' })
    wire({ active: { ok: true, apparatus: cutId } }); await expect(api().observe(chosen)).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('preserves unresolved original operation across scopes/remounts and requires current observation before review resolution', () => {
    const ledger = paddonHandoffIntentLedger('handoff-native-tests'), operation = nextPaddonOperation(initial, summary), other = clearPaddonOperation(initial), changed = vi.fn(), unsubscribe = ledger.subscribe(changed)
    ledger.begin(operation); ledger.unknown(operation); expect(paddonHandoffIntentLedger('handoff-native-tests')).toBe(ledger); expect(paddonHandoffIntentLedger('handoff-isolated-tests').snapshot()).toBeNull()
    expect(() => ledger.begin(other)).toThrow('takrorlanmaydi'); ledger.finish(operation); ledger.finish(other); ledger.observe(other, { active: initial, state: 'observed' }); expect(ledger.snapshot()?.operation).toBe(operation)
    expect(() => ledger.resolveReviewed(operation)).toThrow('joriy tanlovni'); ledger.observe(operation, { active: initial, state: 'observed' }); ledger.resolveReviewed(operation); unsubscribe(); expect(changed).toHaveBeenCalledTimes(4)
    const isolated = new PaddonHandoffIntentLedger(); isolated.begin(other); isolated.finish(other); expect(isolated.snapshot()).toBeNull(); expect(paddonHandoffError(new PaddonHandoffUnknown(operation))).toContain('qayta yuborilmaydi')
  })
})
