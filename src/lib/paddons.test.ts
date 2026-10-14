import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Session } from './api-types'
import {
  PaddonsApi, PaddonConflict, PaddonIntentLedger, PaddonUnknown, canAddPaddonBatch, canManagePaddons, canReadPaddons,
  createPaddonOperation, deletePaddonOperation, normalizePaddonBatchIds, normalizePaddonCode, normalizePaddonCreateInput,
  paddonError, paddonIntentLedger, paddonItemsOperation, paddonsPath, parsePaddonBatch, parsePaddonList, parsePaddonSnapshot,
  parsePaddonSummary, unlockPaddonOperation,
} from './paddons'
import type { PaddonBatch, PaddonOperation, PaddonSnapshot, PaddonSummary } from './paddons'

const summary: PaddonSummary = { id: 'legacy-opaque-paddon-id', code: '00001', location: '', note: '', created_by_ref: 'qa-admin', created_by_display_name: 'QA Administrator',
  created_at_unix: 100, updated_at_unix: 100, item_count: 0, locked_at_unix: null, total_gross_kg: 0, total_net_kg: 0 }
const batch = (id = 'wip-1'): PaddonBatch => ({ batch_id: id, order_id: 'order-1', apparatus: 'apparatus:qa:cut-1', qr_payload: `QA-WIP:${id}`, label_item_code: 'QA-FILM', label_item_name: 'QA Film', produced_qty: 1500, uom: 'm',
  wip_status: 'waiting', finished_goods_kg: 10, bobina_kg: 0.5, finished_goods_meter: 1500, finished_goods_stock_id: '', received_warehouse: '' })
function snapshot(items = [] as PaddonBatch[], available_items = [batch()]): PaddonSnapshot {
  return { paddon: { ...summary, item_count: items.length }, items, available_items, free_movement_enabled: false, can_manage_items: true, can_unlock: false }
}
const native = (value: PaddonSnapshot): unknown => ({ ...value, ok: true })
function session(capabilities = ['admin.access']): Session { return { token: 'local-test', profile: { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] } }
function api(capabilities = ['admin.access']) { return new PaddonsApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), session(capabilities)) }
type WireOptions = { method: string; body?: string; headers: Headers; signal: AbortSignal }
function wire({ detail = native(snapshot()), list = { ok: true, paddons: [summary] } as unknown, result = { ok: true, paddon: summary } as unknown,
  status = 200, detailStatus = 200, failure, onPost, onRead }: { detail?: unknown; list?: unknown; result?: unknown; status?: number; detailStatus?: number; failure?: Error; onPost?: () => void; onRead?: () => void } = {}) {
  const fetch = vi.fn(async (url: URL, options: WireOptions) => {
    if (options.method === 'POST') { onPost?.(); if (failure) throw failure; return new Response(status === 204 ? null : JSON.stringify(result), { status }) }
    onRead?.(); const isList = url.pathname === paddonsPath
    return new Response(JSON.stringify(isList ? list : detail), { status: isList ? 200 : detailStatus })
  })
  vi.stubGlobal('fetch', fetch); return fetch
}
function posts(fetch: ReturnType<typeof wire>) { return fetch.mock.calls.filter(([, options]) => options.method === 'POST') }
afterEach(() => vi.unstubAllGlobals())

describe('native paddon authority and routes', () => {
  it.each(['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'])('uses native read OR for %s independently of role and assignments', async capability => {
    const fetch = wire(), principal = { ...session([capability]), profile: { role: 'aparatchi', ref: 'worker-1', display_name: 'Worker' } }
    const service = new PaddonsApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), principal)
    expect(canReadPaddons(principal)).toBe(true); expect(canManagePaddons(principal)).toBe(capability !== 'apparatus.queue.read')
    await service.list(); await service.detail('00001'); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('denies unrelated capabilities for read, observation and every write, regardless of admin actor label', async () => {
    const fetch = wire(), service = api(['role.capability.manage']), locked = { ...snapshot(), paddon: { ...summary, locked_at_unix: 101 }, can_manage_items: false, can_unlock: true }
    for (const action of [() => service.list(), () => service.detail('00001'), () => service.observe(createPaddonOperation({ location: '', note: '' }))]) await expect(action()).rejects.toMatchObject({ status: 403 })
    for (const operation of [createPaddonOperation({ location: '', note: '' }), deletePaddonOperation(summary), paddonItemsOperation('add', snapshot(), ['wip-1']), paddonItemsOperation('remove', snapshot([batch()], []), ['wip-1']), unlockPaddonOperation(locked)]) await expect(service.execute(operation)).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled(); expect(canReadPaddons(null)).toBe(false)
  })
  it('requires native write OR, so queue.read cannot write even when server flag is true', async () => {
    const fetch = wire()
    await expect(api(['apparatus.queue.read']).execute(paddonItemsOperation('add', snapshot(), ['wip-1']))).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
    for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.manage']) expect(canManagePaddons(session([capability]))).toBe(true)
  })
  it('lists limit200 and exactly addresses detail by native code query without fictional paging or count', async () => {
    const fetch = wire(), service = api()
    expect(await service.list()).toEqual({ items: [summary], bounded: false }); expect(await service.detail(' 00001 ')).toEqual(snapshot())
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://127.0.0.1:5199${paddonsPath}?limit=200`)
    expect(String(fetch.mock.calls[1]![0])).toBe(`http://127.0.0.1:5199${paddonsPath}/detail?code=00001`)
    expect(fetch.mock.calls.every(([url]) => !url.pathname.includes('qr') && !url.pathname.includes('settings'))).toBe(true)
  })
  it('POSTs create location/note only and trusts authoritative created summary without deriving its opaque ID', async () => {
    const operation = createPaddonOperation({ location: ' QA Cut ', note: '  QA note  ', actor_ref: 'forged', expected_revision: 2 } as { location: string; note: string })
    const saved = { ...summary, location: 'QA Cut', note: 'QA note' }, fetch = wire({ result: { ok: true, paddon: saved, token: 'SECRET' } })
    expect(await api().execute(operation)).toEqual(saved)
    const [url, options] = posts(fetch)[0]!
    expect(url.pathname).toBe(`${paddonsPath}/create`); expect(JSON.parse(options.body!)).toEqual({ location: 'QA Cut', note: 'QA note' })
    expect(options.headers.has('Idempotency-Key')).toBe(false); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('POSTs native delete code after fresh selected detail and requires200 oktrue rather than204', async () => {
    const fetch = wire({ result: { ok: true } })
    expect(await api().execute(deletePaddonOperation(summary))).toBeNull()
    expect(posts(fetch)[0]![0].pathname).toBe(`${paddonsPath}/delete`); expect(JSON.parse(posts(fetch)[0]![1].body!)).toEqual({ code: '00001' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('uses atomic batch add/remove POSTs with native deduplication, never single-row loops', async () => {
    const add = paddonItemsOperation('add', snapshot(), [' wip-1 ', 'wip-1', 'wip-2']), added = snapshot([batch(), batch('wip-2')], []), fetch = wire({ result: native(added) })
    expect(await api().execute(add)).toEqual(added)
    expect(posts(fetch)).toHaveLength(1); expect(posts(fetch)[0]![0].pathname).toBe(`${paddonsPath}/items/add-batch`)
    expect(JSON.parse(posts(fetch)[0]![1].body!)).toEqual({ code: '00001', progress_batch_ids: ['wip-1', 'wip-2'] })
    const removed = snapshot([], [batch(), batch('wip-2')]), removing = wire({ detail: native(added), result: native(removed) })
    expect(await api().execute(paddonItemsOperation('remove', added, ['wip-2', 'wip-1']))).toEqual(removed)
    expect(posts(removing)[0]![0].pathname).toBe(`${paddonsPath}/items/remove-batch`)
    expect(JSON.parse(posts(removing)[0]![1].body!)).toEqual({ code: '00001', progress_batch_ids: ['wip-2', 'wip-1'] })
  })
  it('POSTs unlock code and validates full authoritative snapshot instead of invoking print/confirm/successor/settings', async () => {
    const locked = { ...snapshot(), paddon: { ...summary, locked_at_unix: 101 }, available_items: [], can_manage_items: false, can_unlock: true }, fetch = wire({ detail: native(locked), result: native(snapshot()) })
    expect(await api().execute(unlockPaddonOperation(locked))).toEqual(snapshot())
    expect(posts(fetch)[0]![0].pathname).toBe(`${paddonsPath}/unlock`); expect(JSON.parse(posts(fetch)[0]![1].body!)).toEqual({ code: '00001' })
  })
})

describe('paddon DTOs, weights and native validation', () => {
  it('enforces native trimmed UTF-8 byte160/500 limits with valid empty values and Unicode whitespace', () => {
    expect(normalizePaddonCreateInput({ location: '\u0085 Ё \u0085', note: '' })).toEqual({ location: 'Ё', note: '' })
    expect(normalizePaddonCreateInput({ location: 'Ё'.repeat(80), note: '😀'.repeat(125) })).toEqual({ location: 'Ё'.repeat(80), note: '😀'.repeat(125) })
    expect(() => createPaddonOperation({ location: 'Ё'.repeat(81), note: '' })).toThrow('160 bayt')
    expect(() => createPaddonOperation({ location: '', note: '😀'.repeat(126) })).toThrow('500 bayt')
    expect(normalizePaddonCode(' 00001 ')).toBe('00001'); expect(() => normalizePaddonCode(' ')).toThrow()
    expect(() => normalizePaddonCode('Ё'.repeat(65), true)).toThrow('128 bayt')
  })
  it('bounds distinct batch IDs after native case-sensitive deduplication and preserves first occurrence order', () => {
    expect(normalizePaddonBatchIds([' b ', 'a', 'b', 'A'])).toEqual(['b', 'a', 'A'])
    expect(normalizePaddonBatchIds(Array(501).fill('wip-1'))).toEqual(['wip-1'])
    expect(() => normalizePaddonBatchIds(Array.from({ length: 501 }, (_, index) => `wip-${index}`))).toThrow('1–500')
    for (const values of [[], [''], [' '], ['wip-1', ' ']]) expect(() => normalizePaddonBatchIds(values)).toThrow()
  })
  it('keeps authoritative independent unknown/zero weights and strips all unrelated nested fields', () => {
    const raw = { ...native(snapshot([batch()], [])) as object, paddon: { ...summary, item_count: 1, total_gross_kg: 88, total_net_kg: null, token: 'SECRET' }, items: [{ ...batch(), payload_json: { password: 'SECRET', gross_qty: 999, finished_goods_stock_id: 'native-stock' }, avatar: '/image?token=SECRET' }] }
    const parsed = parsePaddonSnapshot(raw)
    expect(parsed.paddon.total_gross_kg).toBe(88); expect(parsed.paddon.total_net_kg).toBeNull(); expect(parsed.items[0]!.finished_goods_stock_id).toBe('native-stock')
    expect(parsed.items[0]!.produced_qty).toBe(1500); expect(JSON.stringify(parsed)).not.toContain('SECRET'); expect(parsed.items[0]).not.toHaveProperty('payload_json')
    expect(parsePaddonSummary({ ...summary, total_gross_kg: null, total_net_kg: 0 })).toMatchObject({ total_gross_kg: null, total_net_kg: 0 })
  })
  it('does not treat available-list membership as add eligibility; native markers default empty and nonblank blocks', () => {
    const raw = { ...batch(), finished_goods_stock_id: undefined, received_warehouse: undefined, payload_json: {} }
    expect(canAddPaddonBatch(parsePaddonBatch(raw))).toBe(true)
    expect(canAddPaddonBatch(parsePaddonBatch({ ...raw, payload_json: { finished_goods_stock_id: null, received_warehouse: null } }))).toBe(true)
    expect(() => parsePaddonBatch({ ...raw, payload_json: { received_warehouse: 7 } })).toThrow()
    for (const patch of [{ wip_status: 'in_use' }, { wip_status: 'processed' }, { payload_json: { finished_goods_stock_id: 'stock' } }, { payload_json: { received_warehouse: ' ' } }]) expect(canAddPaddonBatch(parsePaddonBatch({ ...raw, ...patch }))).toBe(false)
    expect(parsePaddonBatch({ ...raw, payload_json: { finished_goods_stock_id: '', received_warehouse: 'Warehouse', token: 'SECRET' } })).toMatchObject({ finished_goods_stock_id: '', received_warehouse: 'Warehouse' })
  })
  it('fails closed on missing server permission flags without substituting !locked', () => {
    const raw = native(snapshot()) as Record<string, unknown>; delete raw.can_manage_items; delete raw.can_unlock; delete raw.free_movement_enabled
    expect(parsePaddonSnapshot(raw)).toMatchObject({ can_manage_items: false, can_unlock: false, free_movement_enabled: false })
    const missingLock = { ...summary } as Record<string, unknown>; delete missingLock.locked_at_unix
    expect(() => parsePaddonSummary(missingLock)).toThrow()
  })
  it.each([{ id: '' }, { code: '1' }, { code: 1 }, { item_count: -1 }, { item_count: 0.5 }, { created_at_unix: '100' }, { locked_at_unix: '101' }, { total_gross_kg: '10' }, { total_net_kg: -1 }, { total_gross_kg: Number.POSITIVE_INFINITY }])('refuses malformed summary fields instead of defaulting them to success: %j', patch => {
    expect(() => parsePaddonSummary({ ...summary, ...patch })).toThrow()
  })
  it.each([{ ok: false }, { items: null }, { available_items: null }, { items: [batch(), batch()] }, { available_items: [batch(), batch()] }, { items: [batch()] }, { can_manage_items: 'true' }, { can_unlock: true }])('refuses malformed full snapshots: %j', patch => {
    expect(() => parsePaddonSnapshot({ ...native(snapshot()) as object, ...patch })).toThrow()
  })
  it('preserves opaque IDs independently of five-digit codes and labels 200 rows as a bounded list', () => {
    expect(parsePaddonSummary(summary).id).toBe('legacy-opaque-paddon-id')
    const items = Array.from({ length: 200 }, (_, index) => ({ ...summary, id: `opaque-${index}`, code: String(index + 1).padStart(5, '0') }))
    expect(parsePaddonList({ ok: true, paddons: items })).toEqual({ items, bounded: true })
    expect(() => parsePaddonList({ ok: true, paddons: [summary, summary] })).toThrow()
    expect(() => parsePaddonList({ paddons: [] })).toThrow(); expect(() => parsePaddonList([])).toThrow()
  })
  it('freezes defensive intent/baseline/selection copies while retaining safe marker fields', () => {
    const original = snapshot(), operation = paddonItemsOperation('add', original, ['wip-1']), create = createPaddonOperation({ location: '', note: '' })
    original.available_items[0]!.received_warehouse = 'Changed'; original.paddon.location = 'Changed'
    expect(operation.baseline).toMatchObject({ paddon: { location: '' }, available_items: [{ received_warehouse: '' }] })
    for (const target of [operation, operation.input, operation.progress_batch_ids, operation.baseline, operation.kind === 'add' ? operation.baseline.available_items[0] : undefined, create.input]) expect(Object.isFrozen(target)).toBe(true)
  })
})

describe('fresh paddon selected-detail preflight without fabricated CAS', () => {
  it('rechecks can_manage_items and can_unlock before dispatch and treats refusals as known conflicts', async () => {
    const op = paddonItemsOperation('add', snapshot(), ['wip-1']), denied = { ...snapshot(), can_manage_items: false }, fetch = wire({ detail: native(denied) })
    await expect(api().execute(op)).rejects.toMatchObject({ name: 'PaddonConflict', current: denied }); expect(posts(fetch)).toHaveLength(0)
    const locked = { ...snapshot(), paddon: { ...summary, locked_at_unix: 101 }, available_items: [], can_manage_items: false, can_unlock: true }, lockedFetch = wire({ detail: native({ ...locked, can_unlock: false }) })
    await expect(api().execute(unlockPaddonOperation(locked))).rejects.toBeInstanceOf(PaddonConflict); expect(posts(lockedFetch)).toHaveLength(0)
  })
  it('uses server can_manage_items=true on a printed locked paddon when free movement is enabled', async () => {
    const locked = { ...snapshot(), paddon: { ...summary, locked_at_unix: 101 }, free_movement_enabled: true, can_manage_items: true, can_unlock: true }
    const result = { ...locked, paddon: { ...locked.paddon, item_count: 1, total_gross_kg: 71, total_net_kg: 70 }, items: [batch()], available_items: [] }, fetch = wire({ detail: native(locked), result: native(result) })
    expect(await api().execute(paddonItemsOperation('add', locked, ['wip-1']))).toEqual(result); expect(posts(fetch)).toHaveLength(1)
  })
  it.each([{ wip_status: 'in_use' }, { payload_json: { finished_goods_stock_id: 'stock' } }, { payload_json: { received_warehouse: 'warehouse' } }])('rejects a selected available row that became natively ineligible before POST: %j', patch => {
    const current = { ...native(snapshot()) as object, available_items: [{ ...batch(), ...patch }] }, fetch = wire({ detail: current })
    return expect(api().execute(paddonItemsOperation('add', snapshot(), ['wip-1']))).rejects.toBeInstanceOf(PaddonConflict).then(() => expect(posts(fetch)).toHaveLength(0))
  })
  it('does not drop a selected ID because it is outside a bounded available catalog; native atomic response remains final', async () => {
    const original = snapshot([], [batch('selected-late')]), fresh = snapshot([], Array.from({ length: 500 }, (_, index) => batch(`bounded-${index}`))), result = snapshot([batch('selected-late')], [])
    const fetch = wire({ detail: native(fresh), result: native(result) })
    await api().execute(paddonItemsOperation('add', original, ['selected-late'])); expect(JSON.parse(posts(fetch)[0]![1].body!).progress_batch_ids).toEqual(['selected-late'])
  })
  it('blocks changed opaque target identity and stale removal selection before POST', async () => {
    const fetch = wire({ detail: native({ ...snapshot(), paddon: { ...summary, id: 'different-native-id' } }) })
    await expect(api().execute(deletePaddonOperation(summary))).rejects.toBeInstanceOf(PaddonConflict); expect(posts(fetch)).toHaveLength(0)
    const absent = wire()
    await expect(api().execute(paddonItemsOperation('remove', snapshot([batch()], []), ['wip-1']))).rejects.toBeInstanceOf(PaddonConflict); expect(posts(absent)).toHaveLength(0)
  })
  it('requires fresh review on a movement-mode change without inventing native expected_mode or CAS', async () => {
    const original = snapshot([batch()], []), changed = { ...original, free_movement_enabled: true }, fetch = wire({ detail: native(changed) })
    for (const kind of ['add', 'remove'] as const) await expect(api().execute(paddonItemsOperation(kind, original, ['wip-1']))).rejects.toMatchObject({ name: 'PaddonConflict', current: changed })
    expect(posts(fetch)).toHaveLength(0)
  })
  it('validates movable rolls for free-mode removal, while allowing native normal-mode removal of in-use members', async () => {
    const inUse = { ...batch(), wip_status: 'in_use' as const }, normal = snapshot([inUse], []), free = { ...normal, free_movement_enabled: true }
    const blocked = wire({ detail: native(free) }); await expect(api().execute(paddonItemsOperation('remove', free, ['wip-1']))).rejects.toBeInstanceOf(PaddonConflict); expect(posts(blocked)).toHaveLength(0)
    const allowed = wire({ detail: native(normal), result: native(snapshot()) }); await api().execute(paddonItemsOperation('remove', normal, ['wip-1'])); expect(posts(allowed)).toHaveLength(1)
    for (const markers of [{ finished_goods_stock_id: 'stock' }, { received_warehouse: 'warehouse' }]) {
      const marked = { ...snapshot([{ ...batch(), ...markers }], []), free_movement_enabled: true }, fetch = wire({ detail: native(marked) })
      await expect(api().execute(paddonItemsOperation('remove', marked, ['wip-1']))).rejects.toBeInstanceOf(PaddonConflict); expect(posts(fetch)).toHaveLength(0)
    }
  })
  it('does not manufacture a CAS token from timestamps; concurrent native changes remain authoritative', async () => {
    const current = { ...snapshot(), paddon: { ...summary, updated_at_unix: 999, note: 'Other device' } }, result = snapshot([batch()], []), fetch = wire({ detail: native(current), result: native(result) })
    await api().execute(paddonItemsOperation('add', snapshot(), ['wip-1']))
    const body = JSON.parse(posts(fetch)[0]![1].body!)
    expect(body).toEqual({ code: '00001', progress_batch_ids: ['wip-1'] }); expect(body).not.toHaveProperty('expected_revision')
  })
  it('retains known native history/lock/receipt deletion refusal rather than preflight guessing an active selection', async () => {
    const fetch = wire({ status: 409, result: { error: 'paddon_delete_locked' } })
    await expect(api().execute(deletePaddonOperation(summary))).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'paddon_delete_locked' }); expect(posts(fetch)).toHaveLength(1)
  })
  it('keeps interrupted preflight safe, with no dispatched mutation or uncertain result', async () => {
    const controller = new AbortController(), fetch = wire({ onRead: () => controller.abort() })
    await expect(api().execute(deletePaddonOperation(summary), controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(posts(fetch)).toHaveLength(0)
    fetch.mockClear(); await expect(api().execute(createPaddonOperation({ location: '', note: '' }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled()
  })
})

describe('one-dispatch paddon result validation and RAM recovery', () => {
  it.each([{}, { ok: false }, { ok: true, paddon: {} }, { ok: true, paddon: { ...summary, note: 'different' } }, { ok: true, paddon: { ...summary, item_count: 1 } }])('retains malformed/mismatched create200 with original immutable intent: %j', async result => {
    const operation = createPaddonOperation({ location: '', note: '' }), fetch = wire({ result })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonUnknown', operation }); expect(posts(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([201, 204])('requires200 for create/delete/batch/unlock; unexpected HTTP%s stays unknown', async status => {
    const fetch = wire({ status, result: { ok: true } })
    await expect(api().execute(deletePaddonOperation(summary))).rejects.toBeInstanceOf(PaddonUnknown); expect(posts(fetch)).toHaveLength(1)
  })
  it('does not accept200 deletion without native oktrue or membership receipts that omit/mismatch selected changes', async () => {
    const deleting = wire({ result: {} }); await expect(api().execute(deletePaddonOperation(summary))).rejects.toBeInstanceOf(PaddonUnknown); expect(posts(deleting)).toHaveLength(1)
    const absentAdd = wire({ result: native(snapshot()) }); await expect(api().execute(paddonItemsOperation('add', snapshot(), ['wip-1']))).rejects.toBeInstanceOf(PaddonUnknown); expect(posts(absentAdd)).toHaveLength(1)
    const assigned = snapshot([batch()], []), failedRemove = wire({ detail: native(assigned), result: native(assigned) })
    await expect(api().execute(paddonItemsOperation('remove', assigned, ['wip-1']))).rejects.toBeInstanceOf(PaddonUnknown); expect(posts(failedRemove)).toHaveLength(1)
    const wrongCode = wire({ result: native({ ...snapshot([batch()], []), paddon: { ...summary, code: '00002', item_count: 1 } }) })
    await expect(api().execute(paddonItemsOperation('add', snapshot(), ['wip-1']))).rejects.toBeInstanceOf(PaddonUnknown); expect(posts(wrongCode)).toHaveLength(1)
  })
  it('retains a malformed unlock200 that omits the native lock field instead of clearing intent', async () => {
    const locked = { ...snapshot(), paddon: { ...summary, locked_at_unix: 101 }, available_items: [], can_manage_items: false, can_unlock: true }
    const unlocked = native(snapshot()) as { paddon: Record<string, unknown> }; delete unlocked.paddon.locked_at_unix
    const operation = unlockPaddonOperation(locked), fetch = wire({ detail: native(locked), result: unlocked })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonUnknown', operation }); expect(posts(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each([408, 429, 500, 503])('never automatically retries or rereads a dispatched HTTP%s', async status => {
    const operation = paddonItemsOperation('add', snapshot(), ['wip-1']), fetch = wire({ status, result: { error: `http_${status}` } })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonUnknown', operation }); expect(posts(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each([400, 403, 404, 409])('keeps an explicit native HTTP%s business/permission refusal known after dispatch', async status => {
    const fetch = wire({ status, result: { error: 'native_refusal' } })
    await expect(api().execute(deletePaddonOperation(summary))).rejects.toMatchObject({ name: 'ApiError', status }); expect(posts(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('retains network loss and abort after dispatch without adding read recovery or a second write', async () => {
    const operation = deletePaddonOperation(summary), fetch = wire({ failure: new TypeError('lost') })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonUnknown', operation }); expect(posts(fetch)).toHaveLength(1)
    const controller = new AbortController(), aborted = wire({ onPost: () => controller.abort(), result: { ok: true } })
    await expect(api().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'PaddonUnknown', operation }); expect(posts(aborted)).toHaveLength(1)
  })
  it('observes unknown creation using a bounded list only, without guessing a code or matching a note as receipt proof', async () => {
    const operation = createPaddonOperation({ location: '', note: '' }), fetch = wire()
    const observation = await api().observe(operation)
    expect(observation).toEqual({ paddons: [summary], bounded: false, state: 'listed' }); expect(observation).not.toHaveProperty('snapshot')
    expect(observation).not.toHaveProperty('saved'); expect(observation).not.toHaveProperty('receipt'); expect(posts(fetch)).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('observes exact native target membership/current lock without replay or ownership proof, and preserves visibility refusal', async () => {
    const operation = paddonItemsOperation('add', snapshot(), ['wip-1']), current = snapshot([batch()], []), fetch = wire({ detail: native(current) })
    expect(await api().observe(operation)).toEqual({ paddons: [current.paddon], bounded: false, snapshot: current, state: 'matches' }); expect(posts(fetch)).toHaveLength(0)
    wire({ detail: native(snapshot()) }); expect(await api().observe(operation)).toMatchObject({ state: 'different' })
    wire({ detailStatus: 404, detail: { error: 'paddon_not_found' } }); expect(await api().observe(deletePaddonOperation(summary))).toEqual({ paddons: [], bounded: false, state: 'missing' })
    wire({ detailStatus: 403, detail: { error: 'forbidden' } }); await expect(api().observe(operation)).rejects.toMatchObject({ status: 403 })
  })
  it('guards repeated submission and stale completion through a scoped ledger until current state is reviewed', () => {
    const ledger = paddonIntentLedger('paddon-native-tests'), operation = createPaddonOperation({ location: 'Draft', note: '' }), other = deletePaddonOperation(summary), listener = vi.fn(), unsubscribe = ledger.subscribe(listener)
    ledger.begin(operation); ledger.unknown(operation); expect(paddonIntentLedger('paddon-native-tests')).toBe(ledger); expect(paddonIntentLedger('paddon-isolated-tests').snapshot()).toBeNull()
    expect(() => ledger.begin(other)).toThrow('takrorlanmaydi'); expect(() => ledger.resolveReviewed(operation)).toThrow('joriy holatni')
    ledger.finish(operation); ledger.finish(other); ledger.observe(other, { paddons: [], bounded: false, state: 'missing' }); expect(ledger.snapshot()?.operation).toBe(operation)
    ledger.observe(operation, { paddons: [], bounded: false, state: 'listed' }); ledger.resolveReviewed(operation); unsubscribe(); expect(listener).toHaveBeenCalledTimes(4)
    const isolated = new PaddonIntentLedger(); isolated.begin(other); isolated.finish(other); expect(isolated.snapshot()).toBeNull()
    expect(paddonError(new PaddonUnknown(operation))).toContain('qayta yuborilmaydi'); expect(paddonError(new ApiError(409, 'paddon_delete_locked'))).toContain('tarixga')
    const identity: PaddonOperation = operation; expect(identity.code).toBe(''); expect(Object.isFrozen(identity.progress_batch_ids)).toBe(true)
  })
})
