import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Session } from './api-types'
import {
  ApparatusCollectionsApi, CollectionConflict, CollectionIntentLedger, CollectionUnknown, apparatusCollectionsPath,
  canManageCollections, canReadCollections, collectionError, collectionIntentLedger, collectionNameKey,
  createCollectionOperation, deleteCollectionOperation, normalizeCollectionInput, normalizeCollectionName,
  parseApparatusCollection, parseApparatusCollections, sameApparatusCollection,
} from './apparatus-collections'
import type { ApparatusCollection, CollectionInput, CollectionOperation } from './apparatus-collections'

const firstId = 'apparatus:qa:print-1', secondId = 'apparatus:qa:laminate-1'
const collectionId = 'apparatus-collection:00000000000000000000000000000001'
const otherCollectionId = 'apparatus-collection:00000000000000000000000000000002'
const input: CollectionInput = { name: 'Bosma liniyasi', apparatus_ids: [firstId] }
const collection: ApparatusCollection = { id: collectionId, ...input, revision: 1 }
const apparatus = (id = firstId) => ({ apparatus_id: id, display: { display_name: id === firstId ? 'Bosma 1' : 'Laminatsiya 1' }, lifecycle: { state: 'active' } })
function session(capabilities = ['production.map.manage']): Session {
  return { token: 'local-test', profile: { role: 'admin', ref: 'admin-ref', display_name: 'Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
}
function api(capabilities = ['production.map.manage']) { return new ApparatusCollectionsApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), session(capabilities)) }
type WireOptions = { method: string; body?: string; headers: Headers; signal: AbortSignal }
function wire({ current = [] as ApparatusCollection[], mutationBody = collection as unknown, mutationStatus, mutationFailure, onMutation, onRead,
  detail = (id: string): unknown => apparatus(id), directory = [] as unknown[] }: {
  current?: ApparatusCollection[]; mutationBody?: unknown; mutationStatus?: number; mutationFailure?: Error;
  onMutation?: () => void; onRead?: (url: URL) => void; detail?: (id: string) => unknown; directory?: unknown[];
} = {}) {
  const fetch = vi.fn(async (url: URL, options: WireOptions) => {
    if (options.method !== 'GET') {
      onMutation?.(); if (mutationFailure) throw mutationFailure
      const status = mutationStatus ?? (options.method === 'DELETE' ? 204 : 200)
      return new Response(status === 204 ? null : mutationBody === undefined ? null : JSON.stringify(mutationBody), { status })
    }
    onRead?.(url)
    const value = url.pathname === apparatusCollectionsPath ? current : url.pathname.endsWith('/apparatus') ? directory : detail(decodeURIComponent(url.pathname.split('/').at(-1)!))
    return new Response(JSON.stringify(value), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch); return fetch
}
function writes(fetch: ReturnType<typeof wire>) { return fetch.mock.calls.filter(([, options]) => options.method !== 'GET') }
afterEach(() => vi.unstubAllGlobals())

describe('native apparatus collection authority and payloads', () => {
  it.each(['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'])('uses the native read OR for %s without requiring an admin role', async capability => {
    const fetch = wire({ current: [collection] }), principal = { ...session([capability]), profile: { role: 'aparatchi', ref: 'worker-1', display_name: 'Worker' } }
    const service = new ApparatusCollectionsApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), principal)
    expect(canReadCollections(principal)).toBe(true)
    expect(canManageCollections(principal)).toBe(capability === 'production.map.manage')
    expect(await service.list()).toEqual([collection]); await service.apparatus()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('requires production.map.manage for create, update and delete even when admin.access is present', async () => {
    const fetch = wire(), service = api(['admin.access'])
    for (const operation of [createCollectionOperation(input), createCollectionOperation(input, collection), deleteCollectionOperation(collection)]) await expect(service.execute(operation)).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
    expect(canReadCollections(null)).toBe(false); expect(canManageCollections(session(['admin.access']))).toBe(false)
  })
  it('rejects absent native read capability for list, apparatus and observation', async () => {
    const fetch = wire(), service = api(['role.capability.manage'])
    for (const action of [() => service.list(), () => service.apparatus(), () => service.observe(createCollectionOperation(input))]) await expect(action()).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('lists the complete native collection array without invented pagination or detail/receipt routes', async () => {
    const fetch = wire({ current: [collection] })
    expect(await api().list()).toEqual([collection])
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://127.0.0.1:5199${apparatusCollectionsPath}`)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('POSTs only native name and sorted canonical members, with no idempotency or actor metadata', async () => {
    const operation = createCollectionOperation({ name: '  Mixed  Line  ', apparatus_ids: [firstId, secondId, firstId], actor_role: 'admin', idempotency_key: 'fake' } as CollectionInput)
    const saved = { id: collectionId, ...operation.input, revision: 1, token: 'SECRET' }, fetch = wire({ mutationBody: saved })
    expect(await api().execute(operation)).toEqual({ id: collectionId, ...operation.input, revision: 1 })
    const [url, options] = writes(fetch)[0]!
    expect(url.pathname).toBe(apparatusCollectionsPath); expect(options.method).toBe('POST')
    expect(JSON.parse(options.body!)).toEqual(operation.input); expect(options.headers.has('Idempotency-Key')).toBe(false)
    expect(fetch.mock.calls.filter(([url]) => url.pathname.includes('/apparatus/')).map(([url]) => decodeURIComponent(url.pathname.split('/').at(-1)!)).sort()).toEqual(operation.input.apparatus_ids)
    expect(JSON.stringify(operation)).not.toContain('fake')
  })
  it('PUTs encoded native opaque identity and expected_revision without deriving identity from its name', async () => {
    const baseline = { ...collection, revision: 7 }, operation = createCollectionOperation({ name: 'Changed / α?x#y', apparatus_ids: [secondId] }, baseline)
    const saved = { ...baseline, ...operation.input, revision: 8 }, fetch = wire({ current: [baseline], mutationBody: saved })
    expect(await api().execute(operation)).toEqual(saved)
    const [url, options] = writes(fetch)[0]!
    expect(url.pathname).toBe(`${apparatusCollectionsPath}/${encodeURIComponent(baseline.id)}`)
    expect(url.search).toBe(''); expect(url.hash).toBe(''); expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body!)).toEqual({ ...operation.input, expected_revision: 7 })
  })
  it('DELETE sends only expected_revision and requires empty 204, without validating retired memberships', async () => {
    const operation = deleteCollectionOperation(collection), fetch = wire({ current: [collection], detail: () => { throw new Error('delete must not read apparatus') } })
    expect(await api().execute(operation)).toBeNull()
    const [url, options] = writes(fetch)[0]!
    expect(url.pathname).toBe(`${apparatusCollectionsPath}/${encodeURIComponent(collectionId)}`)
    expect(options.method).toBe('DELETE'); expect(JSON.parse(options.body!)).toEqual({ expected_revision: 1 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('permits an empty collection without inventing minimum membership', async () => {
    const operation = createCollectionOperation({ name: 'Empty', apparatus_ids: [] }), fetch = wire({ mutationBody: { ...operation.input, id: collectionId, revision: 1 } })
    await api().execute(operation); expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('collection native normalization and complete DTOs', () => {
  it('trims only ends, preserves internal spacing/case, and counts Unicode scalars rather than UTF-8 bytes', () => {
    expect(normalizeCollectionName('  Bosma  A-1 / Ё  ')).toBe('Bosma  A-1 / Ё')
    expect(normalizeCollectionName('😀'.repeat(80))).toHaveLength(160)
    expect(() => normalizeCollectionName('😀'.repeat(81))).toThrow('80 belgi')
    expect(normalizeCollectionName('\u0085 Name \u0085')).toBe('Name')
    expect(normalizeCollectionName('\uFEFFName\uFEFF')).toBe('\uFEFFName\uFEFF')
    expect(collectionNameKey('ΟΣ')).toBe('ος'); expect(collectionNameKey('Οσ')).toBe('οσ'); expect(collectionNameKey('İ')).toBe('i\u0307')
    expect(collectionNameKey('Bosma  A')).not.toBe(collectionNameKey('Bosma A'))
  })
  it('checks raw membership count before native trim/dedupe/sort', () => {
    expect(normalizeCollectionInput({ ...input, apparatus_ids: [firstId, ` ${secondId} `, firstId] })).toEqual({ ...input, apparatus_ids: [secondId, firstId].sort() })
    expect(() => normalizeCollectionInput({ ...input, apparatus_ids: Array(501).fill(firstId) })).toThrow('500 tagacha')
    expect(normalizeCollectionInput({ ...input, apparatus_ids: Array(500).fill(firstId) }).apparatus_ids).toEqual([firstId])
  })
  it.each([{ name: '' }, { name: ' ' }, { apparatus_ids: ['Bosma 1'] }, { apparatus_ids: ['apparatus:QA:print'] }, { apparatus_ids: [''] }, { apparatus_ids: [7] }, { apparatus_ids: ['apparatus:a:' + 'a'.repeat(117)] }, { apparatus_ids: ['\uFEFF' + firstId] }])('rejects invalid intent before dispatch: %j', patch => {
    const fetch = wire()
    expect(() => createCollectionOperation({ ...input, ...patch } as CollectionInput)).toThrow(); expect(fetch).not.toHaveBeenCalled()
  })
  it.each([{ id: '' }, { id: ' bad ' }, { id: 'legacy opaque ID' }, { id: 'apparatus-collection:' + 'a'.repeat(31) }, { name: '' }, { name: ' padded ' }, { name: '😀'.repeat(81) }, { revision: 0 }, { revision: 1.5 }, { revision: '1' }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { apparatus_ids: null }, { apparatus_ids: ['Bosma 1'] }, { apparatus_ids: [firstId, firstId] }, { apparatus_ids: [firstId, secondId] }, { apparatus_ids: Array(501).fill(firstId) }, { ok: false }])('refuses malformed or noncanonical collection DTO: %j', patch => {
    expect(() => parseApparatusCollection({ ...collection, ...patch })).toThrow()
  })
  it('preserves opaque identities and native names, strips extras and rejects duplicate IDs while allowing shared members', () => {
    expect(parseApparatusCollection({ ...collection, token: 'SECRET', metadata: { password: 'SECRET' } })).toEqual(collection)
    const other = { ...collection, id: otherCollectionId, name: 'Another' }
    expect(parseApparatusCollections([collection, other])).toEqual([collection, other])
    const nativeNames = [collection, { ...other, name: collection.name.toUpperCase() }]
    expect(parseApparatusCollections(nativeNames)).toEqual(nativeNames)
    const nativeUnicodeNames = [{ ...collection, name: 'ΟΣ' }, { ...other, name: 'Ος' }]
    expect(parseApparatusCollections(nativeUnicodeNames)).toEqual(nativeUnicodeNames)
    expect(() => parseApparatusCollections([collection, { ...other, id: collectionId }])).toThrow()
    expect(() => parseApparatusCollections({ items: [collection] })).toThrow()
  })
  it('freezes defensive operation copies and keeps baseline identity independent of later caller edits', () => {
    const draft = { ...input, apparatus_ids: [...input.apparatus_ids] }, baseline = { ...collection, apparatus_ids: [...collection.apparatus_ids] }
    const operation = createCollectionOperation(draft, baseline), deleting = deleteCollectionOperation(baseline)
    draft.apparatus_ids.push(secondId); baseline.name = 'Changed'; baseline.apparatus_ids.length = 0
    expect(operation.input).toEqual(input); expect(operation.baseline).toEqual(collection); expect(deleting.input).toEqual(input)
    for (const target of [operation, operation.input, operation.input.apparatus_ids, operation.baseline, operation.baseline?.apparatus_ids, deleting.input]) expect(Object.isFrozen(target)).toBe(true)
    expect(sameApparatusCollection(collection, { ...collection, revision: 2 })).toBe(false)
  })
})

describe('collection fresh list preflight and selected membership validation', () => {
  it('blocks only an exact native name duplicate before exact membership reads or POST', async () => {
    const fetch = wire({ current: [collection] })
    await expect(api().execute(createCollectionOperation(input))).rejects.toMatchObject({ name: 'CollectionConflict', current: [collection] })
    expect(writes(fetch)).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('leaves Unicode case/collation comparisons to the native write while preserving internal spaces', async () => {
    const operation = createCollectionOperation({ ...input, name: 'ΟΣ' }), existing = { ...collection, name: 'Οσ' }
    const allowed = wire({ current: [existing], mutationBody: { ...collection, id: otherCollectionId, ...operation.input } })
    expect(await api().execute(operation)).toEqual({ ...collection, id: otherCollectionId, ...operation.input }); expect(writes(allowed)).toHaveLength(1)
    const refused = wire({ current: [{ ...collection, name: 'Ος' }], mutationStatus: 409, mutationBody: { error: 'apparatus collection name already exists' } })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'apparatus collection name already exists' })
    expect(writes(refused)).toHaveLength(1); expect(refused).toHaveBeenCalledTimes(3)
    const spaced = createCollectionOperation({ name: 'Bosma  liniyasi', apparatus_ids: [] }), fetch = wire({ current: [collection], mutationBody: { ...collection, id: otherCollectionId, ...spaced.input } })
    await api().execute(spaced); expect(writes(fetch)).toHaveLength(1)
  })
  it('keeps a native case-insensitive name409 as a known refusal without client rejection, reread or replay', async () => {
    const fetch = wire({ current: [{ ...collection, name: input.name.toUpperCase() }], mutationStatus: 409, mutationBody: { error: 'apparatus collection name already exists' } })
    await expect(api().execute(createCollectionOperation(input))).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'apparatus collection name already exists' })
    expect(writes(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each([[], [{ ...collection, revision: 2 }], [{ ...collection, name: 'Changed' }], [{ ...collection, apparatus_ids: [] }], [{ ...collection, id: otherCollectionId }]].map(current => ({ current })))('blocks a stale baseline for both edit and delete: %j', async ({ current }) => {
    const fetch = wire({ current })
    for (const operation of [createCollectionOperation({ ...input, name: 'Renamed' }, collection), deleteCollectionOperation(collection)]) await expect(api().execute(operation)).rejects.toBeInstanceOf(CollectionConflict)
    expect(writes(fetch)).toHaveLength(0)
  })
  it('blocks renaming into another collection, while allowing apparatus shared by multiple collections', async () => {
    const other = { ...collection, id: otherCollectionId, name: 'Other' }, operation = createCollectionOperation({ ...input, name: 'Other' }, collection), fetch = wire({ current: [collection, other] })
    await expect(api().execute(operation)).rejects.toBeInstanceOf(CollectionConflict); expect(writes(fetch)).toHaveLength(0)
    const allowed = createCollectionOperation({ ...input, name: 'Third' }), sharedFetch = wire({ current: [collection, other], mutationBody: { ...collection, id: 'apparatus-collection:00000000000000000000000000000003', ...allowed.input } })
    await api().execute(allowed); expect(writes(sharedFetch)).toHaveLength(1)
  })
  it.each([() => ({ ...apparatus(), lifecycle: { state: 'retired' } }), () => apparatus(secondId), () => ({ apparatus_id: firstId }), () => ({ ...apparatus(), lifecycle: { state: 'unknown' } })])('exactly checks selected active ID before a write even if picker once offered it', async detail => {
    const fetch = wire({ detail })
    try { await api().execute(createCollectionOperation(input)); expect.fail('invalid exact apparatus accepted') } catch (error) { expect(error).not.toBeInstanceOf(CollectionUnknown) }
    expect(writes(fetch)).toHaveLength(0)
  })
  it('reads a bounded/name-filtered apparatus catalog without shrinking existing selected membership', async () => {
    const directory = Array.from({ length: 500 }, (_, index) => apparatus(`apparatus:qa:picker-${index}`)), fetch = wire({ directory, mutationBody: { ...collection, revision: 2 } })
    const service = api(), result = await service.apparatus('  Picker  ')
    expect(result.bounded).toBe(true); expect(result.items).toHaveLength(500)
    const url = fetch.mock.calls[0]![0]; expect(url.searchParams.get('q')).toBe('Picker'); expect(url.searchParams.get('limit')).toBe('500')
    const operation = createCollectionOperation(input, collection)
    wire({ current: [collection], mutationBody: { ...collection, revision: 2 } })
    expect(await service.execute(operation)).toEqual({ ...collection, revision: 2 }); expect(operation.input.apparatus_ids).toEqual([firstId])
  })
  it('reports bounds before filtering retired catalog entries and strips projection-only fields', async () => {
    wire({ directory: [apparatus(), { ...apparatus(secondId), lifecycle: { state: 'retired' } }] })
    expect(await api().apparatus()).toEqual({ items: [{ id: firstId, name: 'Bosma 1', active: true }], bounded: false })
    wire({ directory: Array.from({ length: 500 }, (_, index) => ({ ...apparatus(`apparatus:qa:retired-${index}`), lifecycle: { state: 'retired' } })) })
    expect(await api().apparatus()).toEqual({ items: [], bounded: true })
  })
  it('keeps native revision CAS as final authority when state changes after preflight', async () => {
    const operation = createCollectionOperation({ ...input, name: 'Renamed' }, collection), fetch = wire({ current: [collection], mutationStatus: 409, mutationBody: { error: 'apparatus collection revision conflict' } })
    await expect(api().execute(operation)).rejects.toMatchObject({ status: 409, code: 'apparatus collection revision conflict' })
    expect(writes(fetch)).toHaveLength(1); expect(JSON.parse(writes(fetch)[0]![1].body!).expected_revision).toBe(1)
  })
  it('distinguishes an interrupted preflight from a dispatched write and never writes after abort', async () => {
    const operation = createCollectionOperation(input), controller = new AbortController(), fetch = wire({ onRead: () => controller.abort() })
    await expect(api().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes(fetch)).toHaveLength(0)
    controller.abort(); fetch.mockClear()
    await expect(api().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled()
  })
})

describe('collection uncertain responses and read-only recovery', () => {
  it.each([{}, { ...collection, name: 'Different' }, { ...collection, apparatus_ids: [] }, { ...collection, revision: 2 }, { ...collection, revision: 0 }, { ok: false }])('retains malformed/mismatched create 200 instead of claiming a saved collection: %j', async mutationBody => {
    const operation = createCollectionOperation(input), fetch = wire({ mutationBody })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'CollectionUnknown', operation })
    expect(writes(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each([{ ...collection, id: otherCollectionId, revision: 2 }, { ...collection, revision: 1 }, { ...collection, revision: 3 }])('verifies update identity and exact revision increment: %j', async mutationBody => {
    const operation = createCollectionOperation(input, collection), fetch = wire({ current: [collection], mutationBody })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'CollectionUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
  })
  it.each([['create', 201], ['update', 201], ['delete', 200], ['delete', 202]] as const)('requires exact native success for %s HTTP %s', async (kind, mutationStatus) => {
    const operation = kind === 'delete' ? deleteCollectionOperation(collection) : createCollectionOperation(input, kind === 'update' ? collection : undefined)
    const fetch = wire({ current: kind === 'create' ? [] : [collection], mutationStatus, mutationBody: kind === 'update' ? { ...collection, revision: 2 } : collection })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'CollectionUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
  })
  it.each([408, 429, 500, 503])('retains HTTP %s for create/update/delete after one dispatch', async mutationStatus => {
    for (const operation of [createCollectionOperation(input), createCollectionOperation(input, collection), deleteCollectionOperation(collection)]) {
      const fetch = wire({ current: operation.baseline ? [collection] : [], mutationStatus, mutationBody: { error: `http_${mutationStatus}` } })
      await expect(api().execute(operation)).rejects.toMatchObject({ name: 'CollectionUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
    }
  })
  it.each([400, 401, 403, 404, 409])('keeps a known native HTTP %s refusal safe to report without uncertain-intent recovery', async mutationStatus => {
    const fetch = wire({ mutationStatus, mutationBody: { error: 'native_refusal' } })
    await expect(api().execute(createCollectionOperation(input))).rejects.toMatchObject({ name: 'ApiError', status: mutationStatus }); expect(writes(fetch)).toHaveLength(1)
  })
  it('retains transport loss and abort after dispatch with original operation, without retry or automatic observation', async () => {
    const operation = createCollectionOperation(input), fetch = wire({ mutationFailure: new TypeError('lost') })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'CollectionUnknown', operation }); expect(fetch).toHaveBeenCalledTimes(3)
    const controller = new AbortController(), aborted = wire({ onMutation: () => controller.abort() })
    await expect(api().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'CollectionUnknown', operation }); expect(writes(aborted)).toHaveLength(1)
  })
  it('never reinterprets malformed JSON success as a known pre-dispatch refusal', async () => {
    const fetch = wire(), original = fetch.getMockImplementation()!
    fetch.mockImplementation(async (url, options) => options.method === 'POST' ? new Response('broken JSON', { status: 200 }) : original(url, options))
    await expect(api().execute(createCollectionOperation(input))).rejects.toBeInstanceOf(CollectionUnknown); expect(writes(fetch)).toHaveLength(1)
  })
  it('observes current matching values without proof of ownership, and never retransmits the operation', async () => {
    const operation = createCollectionOperation(input), fetch = wire({ current: [{ ...collection, revision: 9 }] })
    const observation = await api().observe(operation)
    expect(observation).toEqual({ collections: [{ ...collection, revision: 9 }], target: { ...collection, revision: 9 }, state: 'matches' })
    expect(observation).not.toHaveProperty('receipt'); expect(observation).not.toHaveProperty('saved'); expect(writes(fetch)).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('uses contextual whole-string lowercase only as a create-observation hint and prefers an exact native name', async () => {
    const operation = createCollectionOperation({ ...input, name: 'ΟΣ' }), exact = { ...collection, id: otherCollectionId, name: 'ΟΣ' }, folded = { ...collection, name: 'Ος' }
    const fetch = wire({ current: [folded, exact] })
    expect(await api().observe(operation)).toEqual({ collections: [folded, exact], target: exact, state: 'matches' })
    wire({ current: [folded] }); expect(await api().observe(operation)).toMatchObject({ target: folded, state: 'different' })
    const distinct = { ...collection, name: 'Οσ' }
    wire({ current: [distinct] }); expect(await api().observe(operation)).toEqual({ collections: [distinct], state: 'missing' })
    expect(writes(fetch)).toHaveLength(0)
  })
  it('uses baseline opaque ID for rename/update/delete observations, never another collection with the same submitted name', async () => {
    const operation = createCollectionOperation({ ...input, name: 'Renamed' }, collection), impostor = { ...collection, id: otherCollectionId, name: 'Renamed' }
    wire({ current: [impostor] }); expect(await api().observe(operation)).toEqual({ collections: [impostor], state: 'missing' })
    wire({ current: [collection] }); expect(await api().observe(operation)).toMatchObject({ state: 'different', target: collection })
    wire({ current: [{ ...collection, name: 'Renamed', revision: 8 }] }); expect(await api().observe(operation)).toMatchObject({ state: 'matches' })
    wire({ current: [] }); expect(await api().observe(deleteCollectionOperation(collection))).toEqual({ collections: [], state: 'missing' })
    wire({ current: [collection] }); expect(await api().observe(deleteCollectionOperation(collection))).toMatchObject({ state: 'matches' })
    wire({ current: [{ ...collection, revision: 2 }] }); expect(await api().observe(deleteCollectionOperation(collection))).toMatchObject({ state: 'different' })
  })
})

describe('scoped RAM collection intent ledger', () => {
  it('preserves exact operation across remount scopes and guards repeated submit until fresh current state is reviewed', () => {
    const ledger = collectionIntentLedger('collections-native-test'), operation = createCollectionOperation(input), other = collectionIntentLedger('collections-native-other')
    ledger.begin(operation); ledger.unknown(operation)
    expect(collectionIntentLedger('collections-native-test')).toBe(ledger); expect(ledger.snapshot()?.operation).toBe(operation); expect(other.snapshot()).toBeNull()
    expect(() => ledger.begin(createCollectionOperation(input))).toThrow('takrorlanmaydi')
    ledger.finish(operation); expect(ledger.snapshot()?.status).toBe('unknown')
    expect(() => ledger.resolveReviewed(operation)).toThrow('joriy ma’lumotni')
    ledger.observe(operation, { collections: [collection], target: collection, state: 'matches' })
    expect(ledger.snapshot()?.status).toBe('unknown')
    ledger.resolveReviewed(operation); expect(ledger.snapshot()).toBeNull()
  })
  it('ignores stale completion and observations, supports subscription cleanup, and does not permit pending resolution', () => {
    const ledger = new CollectionIntentLedger(), operation = deleteCollectionOperation(collection), stale: CollectionOperation = createCollectionOperation(input), listener = vi.fn(), unsubscribe = ledger.subscribe(listener)
    ledger.begin(operation); ledger.observe(operation, { collections: [], state: 'missing' })
    expect(ledger.snapshot()).not.toHaveProperty('observation'); expect(() => ledger.resolveReviewed(operation)).toThrow()
    ledger.unknown(operation); ledger.finish(stale); ledger.observe(stale, { collections: [], state: 'missing' }); ledger.unknown(stale)
    expect(ledger.snapshot()?.operation).toBe(operation); expect(listener).toHaveBeenCalledTimes(2)
    expect(() => ledger.resolveReviewed(stale)).toThrow()
    ledger.observe(operation, { collections: [], state: 'missing' }); unsubscribe(); ledger.resolveReviewed(operation)
    expect(listener).toHaveBeenCalledTimes(3); expect(ledger.snapshot()).toBeNull()
    expect(collectionError(new CollectionUnknown(operation))).toContain('qayta yuborilmaydi')
    expect(collectionError(new ApiError(409, 'apparatus collection revision conflict'))).toContain('boshqa joyda')
  })
})
