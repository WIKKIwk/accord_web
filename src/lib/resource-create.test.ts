import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Row, Session } from './api-types'
import { MutationScope } from './mutation-scope'
import { ResourceCreateApi, ResourceCreateMemory, ResourceCreateUnknown, canCreateResource, canReviewResourceCreate, normalizeCreateCustomerPhone, parseResourceCreateReceipt, resourceCreateDraft, resourceCreateIntent, resourceCreateItemCodePolicy } from './resource-create'
import type { ResourceCreateKind, ResourceCreateIntent } from './resource-create'

const actor = (capabilities = ['admin.access'], role = 'admin'): Session => ({ token: 'fixture-session', profile: { role, ref: 'fixture-actor', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const api = (session = actor(), onWrite?: (intent: ResourceCreateIntent) => void) => new ResourceCreateApi(new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), session, onWrite)
const workerId = `worker_${'a'.repeat(24)}`, userId = `qolipchi_${'b'.repeat(24)}`
const groups = [{ name: 'All Item Groups', item_group_name: 'All Item Groups', parent_item_group: '', is_group: true }, { name: 'Finished', item_group_name: 'Tayyor mahsulot', parent_item_group: 'All Item Groups', is_group: true }, { name: 'Paketlar', item_group_name: 'Paketlar', parent_item_group: 'Tayyor mahsulot', is_group: false }, { name: 'Raw', item_group_name: 'Xomashyo', parent_item_group: 'All Item Groups', is_group: false }]
const bodies: Record<ResourceCreateKind, Row> = { items: { code: 'SKU-1', name: 'Plyonka', uom: 'm', item_group: 'Xomashyo', customer_ref: '' }, 'item-groups': { name: 'Materiallar', parent: '', is_group: false }, customers: { name: 'Mijoz', phone: '(90) 123-45-67' }, suppliers: { name: 'Ta’minotchi', phone: '+998901234567' }, workers: { name: 'Ali', phone: '', level: 'master' }, users: { role: 'qolipchi', name: 'Vali', phone: '901234568' }, warehouses: { warehouse: 'Asosiy ombor', company: 'Korxona', is_group: false, parent_warehouse: '' } }
const receipts: Record<ResourceCreateKind, Row> = { items: { code: 'SKU-1', name: 'Plyonka', uom: 'm', item_group: 'Xomashyo' }, 'item-groups': { name: 'Materiallar', item_group_name: 'Materiallar', parent_item_group: 'All Item Groups', is_group: false }, customers: { ref: 'CUS-1', name: 'Mijoz', phone: '+998901234567' }, suppliers: { ref: 'SUP-1', name: 'Ta’minotchi', phone: '+998901234567', code: 'DO-NOT-CACHE-LOGIN', blocked: false, removed: false, assigned_item_codes: [], assigned_item_count: 0 }, workers: { id: workerId, name: 'Ali', phone: '', level: 'Master' }, users: { id: userId, role: 'qolipchi', name: 'Vali', phone: '901234568' }, warehouses: { warehouse: 'Asosiy ombor', company: 'Korxona', is_group: false, parent_warehouse: '' } }
const caps: Record<ResourceCreateKind, string> = { items: 'catalog.item.create', 'item-groups': 'catalog.item_group.manage', customers: 'party.customer.manage', suppliers: 'party.supplier.manage', workers: 'admin.access', users: 'admin.access', warehouses: 'production.map.manage' }
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
const body = (fetch: ReturnType<typeof respond>, index = 0): Row => JSON.parse(String(fetch.mock.calls[index][1]?.body))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('native create request normalization and source policy', () => {
  it('does not treat matching business fields as success when the receipt explicitly reports failure', async () => {
    for (const failure of [{ ok: false }, { error: 'store_failed' }]) {
      const memory = new ResourceCreateMemory(); memory.activate('receipt-failure')
      const intent = resourceCreateIntent('workers', bodies.workers)
      const fetch = respond({ ...receipts.workers, ...failure })
      await expect(api(actor(), sent => memory.markSent('receipt-failure', sent)).create('workers', bodies.workers)).rejects.toBeInstanceOf(ResourceCreateUnknown)
      expect(memory.read('receipt-failure', 'workers')?.intent).toEqual(intent)
      expect(fetch).toHaveBeenCalledOnce()
    }
  })
  it('requires each resource’s own create capability, including the material-provider actor exclusion', () => {
    for (const kind of Object.keys(caps) as ResourceCreateKind[]) {
      expect(canCreateResource(actor([caps[kind]]), kind)).toBe(true)
      expect(canCreateResource(actor(['unrelated.permission']), kind)).toBe(false)
    }
    expect(canCreateResource(actor(['admin.access']), 'items')).toBe(false)
    expect(canCreateResource(actor(['catalog.item.create'], 'material_taminotchi'), 'items')).toBe(false)
    expect(canCreateResource(actor(['admin.access']), 'orders')).toBe(false)
    expect(canCreateResource(null, 'workers')).toBe(false)
  })

  it('respects separate read capabilities for explicit review without assuming manage implies read', () => {
    expect(canReviewResourceCreate(actor(['party.customer.manage']), 'customers')).toBe(false)
    expect(canReviewResourceCreate(actor(['party.customer.read']), 'customers')).toBe(true)
    expect(canReviewResourceCreate(actor(['gscale.catalog.read']), 'item-groups')).toBe(true)
    expect(canReviewResourceCreate(actor(['catalog.item.read'], 'material_taminotchi'), 'items')).toBe(false)
    expect(canReviewResourceCreate(actor(['production.map.manage']), 'warehouses')).toBe(true)
    expect(canReviewResourceCreate(actor(['admin.access']), 'users')).toBe(true)
  })

  it('uses server group ancestry for finished-code generation without loose word matches', () => {
    expect(resourceCreateItemCodePolicy('Paketlar', groups)).toBe('generated')
    expect(resourceCreateItemCodePolicy('Tayyor mahsulot', groups)).toBe('generated')
    expect(resourceCreateItemCodePolicy('Xomashyo', groups)).toBe('exact')
    expect(resourceCreateItemCodePolicy('Yarim tayyor mahsulot', groups)).toBe('exact')
    expect(resourceCreateItemCodePolicy('Unknown subgroup')).toBe('server')
    expect(resourceCreateItemCodePolicy('')).toBe('exact')
    expect(resourceCreateItemCodePolicy('A', [{ name: 'A', item_group_name: 'A', parent_item_group: 'B', is_group: true }, { name: 'B', item_group_name: 'B', parent_item_group: 'A', is_group: true }])).toBe('exact')
    expect(() => resourceCreateItemCodePolicy('A', [{ name: 'A', parent_item_group: null }])).toThrow('to‘liq yuklanmagan')
  })

  it('requires a customer for finished goods and clears the ignored requested code', () => {
    const input = { ...bodies.items, item_group: 'Paketlar', code: 'ignored', customer_ref: 'CUS-1' }
    expect(resourceCreateIntent('items', input, { groups })).toMatchObject({ codePolicy: 'generated', body: { code: '', item_group: 'Paketlar', customer_ref: 'CUS-1' } })
    expect(() => resourceCreateIntent('items', { ...input, customer_ref: '' }, { groups })).toThrow('mijoz')
    expect(() => resourceCreateIntent('items', { ...bodies.items, code: '' }, { groups })).toThrow('kodini')
  })

  it('matches native customer phone normalization while leaving other create phones trimmed', () => {
    expect(normalizeCreateCustomerPhone(' (90) 123-45-67 ')).toBe('+998901234567')
    expect(normalizeCreateCustomerPhone('998901234567')).toBe('+998901234567')
    expect(resourceCreateIntent('customers', { name: ' Mijoz ', phone: '' }).body).toEqual({ name: 'Mijoz', phone: '' })
    for (const phone of ['abc', '123', '1234567890123']) expect(() => normalizeCreateCustomerPhone(phone)).toThrow('Telefon')
    expect(resourceCreateIntent('users', bodies.users).body.phone).toBe('901234568')
    expect(resourceCreateIntent('suppliers', { name: ' Supplier ', phone: '(90) 123-45-67' }).body.phone).toBe('(90) 123-45-67')
  })

  it('forbids existing record identifiers and whitelists native create DTOs', () => {
    for (const kind of Object.keys(bodies) as ResourceCreateKind[]) for (const key of ['id', 'ref', 'entity_ref', 'original_code']) expect(() => resourceCreateIntent(kind, { ...bodies[kind], [key]: 'existing' }, { groups })).toThrow('identifikator')
    const intent = resourceCreateIntent('workers', { ...bodies.workers, code: 'LOGIN', token: 'TOKEN', avatar_url: 'SECRET', unknown: 'EXTRA' })
    expect(intent.body).toEqual({ name: 'Ali', phone: '', level: 'Master' })
    expect(resourceCreateIntent('item-groups', bodies['item-groups']).body.parent).toBe('All Item Groups')
    expect(resourceCreateIntent('warehouses', { warehouse: ' Test ' }).body).toEqual({ warehouse: 'Test', company: '', parent_warehouse: '', is_group: false })
  })

  it('validates worker levels, allowed system roles, required phone, and actual input types before dispatch', () => {
    expect(resourceCreateIntent('workers', bodies.workers).body.level).toBe('Master')
    expect(() => resourceCreateIntent('workers', { ...bodies.workers, level: 'invented' })).toThrow('malaka')
    expect(() => resourceCreateIntent('users', { ...bodies.users, role: 'admin' })).toThrow('vazifasini')
    expect(() => resourceCreateIntent('users', { ...bodies.users, phone: '' })).toThrow('Telefon')
    expect(() => resourceCreateIntent('warehouses', { warehouse: 'W', is_group: 'false' })).toThrow('Guruh')
    expect(() => resourceCreateIntent('customers', { name: { nested: 'not text' } })).toThrow('Majburiy')
  })

  it('keeps only form business fields in retained drafts, including item code but never a party login code', () => {
    expect(resourceCreateDraft('items', { ...bodies.items, token: 'SECRET', avatar_url: 'SECRET' })).toEqual(bodies.items)
    expect(resourceCreateDraft('suppliers', { ...bodies.suppliers, code: 'LOGIN', password: 'SECRET', nested: {} })).toEqual(bodies.suppliers)
  })
})

describe('native create receipt identity and field binding', () => {
  it('validates every native response and distinguishes upsert save from newly created entity receipts', () => {
    for (const kind of Object.keys(receipts) as ResourceCreateKind[]) {
      const receipt = parseResourceCreateReceipt(resourceCreateIntent(kind, bodies[kind], { groups }), receipts[kind])
      expect(receipt.id).toBeTruthy()
      expect(receipt.disposition).toBe(['warehouses', 'item-groups'].includes(kind) ? 'saved' : 'created')
    }
  })

  it('rejects malformed HTTP200 objects instead of treating an ok flag or arbitrary object as success', () => {
    for (const kind of Object.keys(receipts) as ResourceCreateKind[]) for (const malformed of [{}, { ok: true }, { id: 'wrong' }, null, [], 'success']) expect(() => parseResourceCreateReceipt(resourceCreateIntent(kind, bodies[kind], { groups }), malformed)).toThrow(ApiError)
  })

  it('rejects wrong requested code, native identity shape, role, boolean, or business field', () => {
    expect(() => parseResourceCreateReceipt(resourceCreateIntent('items', bodies.items, { groups }), { ...receipts.items, code: 'OTHER' })).toThrow(ApiError)
    expect(() => parseResourceCreateReceipt(resourceCreateIntent('workers', bodies.workers), { ...receipts.workers, id: 'worker:wrong' })).toThrow(ApiError)
    expect(() => parseResourceCreateReceipt(resourceCreateIntent('users', bodies.users), { ...receipts.users, id: workerId })).toThrow(ApiError)
    expect(() => parseResourceCreateReceipt(resourceCreateIntent('users', bodies.users), { ...receipts.users, role: 'boyoqchi' })).toThrow(ApiError)
    expect(() => parseResourceCreateReceipt(resourceCreateIntent('customers', bodies.customers), { ...receipts.customers, name: 'Other' })).toThrow(ApiError)
    expect(() => parseResourceCreateReceipt(resourceCreateIntent('warehouses', bodies.warehouses), { ...receipts.warehouses, is_group: 0 })).toThrow(ApiError)
    expect(() => parseResourceCreateReceipt(resourceCreateIntent('suppliers', bodies.suppliers), { ...receipts.suppliers, removed: true })).toThrow(ApiError)
  })

  it('accepts native generated finished code while binding exact item name, unit and group', () => {
    const intent = resourceCreateIntent('items', { ...bodies.items, item_group: 'Paketlar', code: '', customer_ref: 'CUS-1' }, { groups })
    expect(parseResourceCreateReceipt(intent, { ...receipts.items, code: 'native-epc', item_group: 'Paketlar' }).id).toBe('native-epc')
    expect(() => parseResourceCreateReceipt(intent, { ...receipts.items, code: 'native-epc', item_group: 'Other' })).toThrow(ApiError)
  })

  it('omits rotated login credentials, avatars and unknown nested fields from every retained receipt', () => {
    for (const kind of ['customers', 'suppliers', 'workers', 'users'] as const) {
      const row = { ...receipts[kind], code: 'DO-NOT-CACHE-LOGIN', avatar_url: '?token=DO-NOT-CACHE-TOKEN', token: 'DO-NOT-CACHE-TOKEN', nested: { code: 'DO-NOT-CACHE-LOGIN' } }
      expect(JSON.stringify(parseResourceCreateReceipt(resourceCreateIntent(kind, bodies[kind]), row))).not.toContain('DO-NOT-CACHE')
    }
    expect(parseResourceCreateReceipt(resourceCreateIntent('items', bodies.items, { groups }), receipts.items).row.code).toBe('SKU-1')
  })

  it('allows explicit selection of legitimate legacy existing IDs without claiming they were newly created', () => {
    const intent = resourceCreateIntent('workers', bodies.workers), legacy = { ...receipts.workers, id: 'legacy-worker' }
    expect(parseResourceCreateReceipt(intent, legacy, true)).toMatchObject({ id: 'legacy-worker', disposition: 'existing' })
    expect(() => parseResourceCreateReceipt(intent, legacy)).toThrow(ApiError)
    expect(() => api().acknowledgeExisting(intent, legacy, false)).toThrow('tasdiqlang')
    expect(api().acknowledgeExisting(intent, legacy, true).disposition).toBe('existing')
  })
})

describe('native request authority and unkeyed create outcomes', () => {
  it('uses one exact native POST with whitelisted body and validates its receipt', async () => {
    for (const kind of Object.keys(receipts) as ResourceCreateKind[]) {
      const fetch = respond(receipts[kind]), onWrite = vi.fn()
      expect((await api(actor([caps[kind]]), onWrite).create(kind, bodies[kind], { groups })).kind).toBe(kind)
      expect(url(fetch).pathname).toBe(`/v1/mobile/admin/${kind === 'users' ? 'system-users' : kind}`)
      expect(fetch.mock.calls[0][1]?.method).toBe('POST')
      expect(body(fetch)).toEqual(resourceCreateIntent(kind, bodies[kind], { groups }).body)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects unauthorized actors and invalid input before recording or dispatching an intent', async () => {
    const fetch = respond({}), onWrite = vi.fn()
    await expect(api(actor(['admin.access']), onWrite).create('items', bodies.items)).rejects.toMatchObject({ status: 403 })
    await expect(api(actor(['catalog.item.create'], 'material_taminotchi'), onWrite).create('items', bodies.items)).rejects.toMatchObject({ status: 403 })
    await expect(api(actor(['admin.access']), onWrite).create('users', { ...bodies.users, id: 'existing' })).rejects.toThrow('identifikator')
    expect(fetch).not.toHaveBeenCalled(); expect(onWrite).not.toHaveBeenCalled()
  })

  it('keeps malformed200, network errors and post-write server errors unresolved with no automatic GET or second POST', async () => {
    for (const fixture of [{}, { ok: true }, new TypeError('Lost response'), { status: 500, payload: { error: 'postwrite_store_failed' } }]) {
      const fetch = respond(fixture)
      await expect(api().create('workers', bodies.workers)).rejects.toBeInstanceOf(ResourceCreateUnknown)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0][1]?.method).toBe('POST')
    }
  })

  it('preserves rejected native 400/403/409 business errors instead of treating them as successful or recoverable creates', async () => {
    for (const status of [400, 403, 409]) { const fetch = respond({ status, payload: { error: 'worker phone already exists' } }); await expect(api().create('workers', bodies.workers)).rejects.toMatchObject({ status }); expect(fetch).toHaveBeenCalledTimes(1) }
  })

  it('treats a committed HTTP200 with unreadable JSON as unresolved rather than clearing the sent marker', async () => {
    const memory = new ResourceCreateMemory(); memory.activate('actor-a')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('<html>created but wrong response</html>', { status: 200 })); vi.stubGlobal('fetch', fetch)
    await expect(api(actor(), intent => memory.markSent('actor-a', intent)).create('workers', bodies.workers)).rejects.toBeInstanceOf(ResourceCreateUnknown)
    expect(memory.read('actor-a', 'workers')?.intent).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('provides explicit read-only matching records without claiming that bounded absence proves failure', async () => {
    const intent = resourceCreateIntent('workers', bodies.workers), fetch = respond([receipts.workers, { ...receipts.workers, id: 'other', name: 'Other' }])
    const review = await api().review(intent)
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/workers')
    expect(url(fetch).searchParams.get('q')).toBe('Ali')
    expect(url(fetch).searchParams.get('limit')).toBe('500')
    expect(review.candidates).toHaveLength(1); expect(review.candidates[0].disposition).toBe('existing'); expect(review.absenceConfirmed).toBe(false)
    respond([])
    expect((await api().review(intent)).absenceConfirmed).toBe(false)
  })

  it('respects native paged party directories and system-role search rather than inventing query parameters', async () => {
    const fetch = respond([receipts.suppliers])
    const service = api(actor(['party.supplier.read']))
    const review = await service.review(resourceCreateIntent('suppliers', bodies.suppliers), 50)
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/suppliers/list')
    expect([...url(fetch).searchParams.entries()]).toEqual([['limit', '50'], ['offset', '50']])
    expect(review.offset).toBe(50); expect(JSON.stringify(review)).not.toContain('DO-NOT-CACHE')
    const userFetch = respond([receipts.users]); await api().review(resourceCreateIntent('users', bodies.users))
    expect(url(userFetch).pathname).toBe('/v1/mobile/admin/system-users'); expect(url(userFetch).searchParams.get('role')).toBe('qolipchi')
  })

  it('does not dispatch review when its separate directory read capability is absent', async () => {
    const fetch = respond([])
    await expect(api(actor(['party.customer.manage'])).review(resourceCreateIntent('customers', bodies.customers))).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('scoped RAM drafts and interrupted create replay prevention', () => {
  it('retains submitted fields and intent across route navigation, isolates resource kinds, and requires an explicit new decision', () => {
    const memory = new ResourceCreateMemory(); memory.activate('actor-a')
    const intent = resourceCreateIntent('workers', bodies.workers)
    memory.patch('actor-a', 'workers', { values: bodies.workers }); memory.markSent('actor-a', intent)
    expect(memory.read('actor-a', 'workers')?.values).toEqual(bodies.workers)
    expect(memory.read('actor-a', 'workers')?.intent).toEqual(intent)
    expect(memory.read('actor-a', 'users')?.intent).toBeNull()
    expect(() => memory.markSent('actor-a', intent)).toThrow(ResourceCreateUnknown)
    expect(() => memory.newDecision('actor-a', 'workers', {}, false)).toThrow('tasdiqlang')
    memory.newDecision('actor-a', 'workers', { name: '', level: 'Master' }, true)
    expect(memory.read('actor-a', 'workers')).toMatchObject({ intent: null, error: null, values: { name: '', level: 'Master' } })
  })

  it('does not retain credentials through draft updates or reference a mutable submitted body', () => {
    const memory = new ResourceCreateMemory(); memory.activate('actor-a')
    const intent = resourceCreateIntent('workers', bodies.workers)
    memory.markSent('actor-a', intent); intent.body.name = 'Changed afterwards'
    expect(memory.read('actor-a', 'workers')?.intent?.body.name).toBe('Ali')
    memory.patch('actor-a', 'workers', { values: { ...bodies.workers, code: 'LOGIN', token: 'TOKEN' } })
    expect(JSON.stringify(memory.read('actor-a', 'workers')?.values)).not.toContain('LOGIN')
    expect(JSON.stringify(memory.read('actor-a', 'workers')?.values)).not.toContain('TOKEN')
  })

  it('clears identity-specific memory and refuses late old-session intent registration or updates', () => {
    const memory = new ResourceCreateMemory(); memory.activate('actor-a'); memory.markSent('actor-a', resourceCreateIntent('workers', bodies.workers)); memory.activate('actor-b')
    expect(memory.read('actor-a', 'workers')).toBeNull()
    expect(memory.patch('actor-a', 'workers', { error: new Error('old') })).toBe(false)
    expect(() => memory.markSent('actor-a', resourceCreateIntent('workers', bodies.workers))).toThrowError(expect.objectContaining({ name: 'AbortError' }))
    expect(memory.read('actor-b', 'workers')?.intent).toBeNull()
  })

  it('keeps a dispatched late successful creation unresolved after navigation cancellation and refuses replay', async () => {
    const memory = new ResourceCreateMemory(); memory.activate('actor-a')
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise<Response>(resolve => { finish = resolve })); vi.stubGlobal('fetch', fetch)
    const mutations = new MutationScope(), lease = mutations.begin(), service = api(actor(), intent => memory.markSent('actor-a', intent))
    const request = service.create('workers', bodies.workers, {}, lease.controller.signal)
    expect(memory.read('actor-a', 'workers')?.intent).toBeTruthy()
    mutations.cancelAll(); finish(new Response(JSON.stringify(receipts.workers), { status: 200 }))
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(memory.read('actor-a', 'workers')?.error).toBeInstanceOf(ResourceCreateUnknown)
    await expect(service.create('workers', bodies.workers)).rejects.toBeInstanceOf(ResourceCreateUnknown)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(mutations.isCurrent(lease)).toBe(false)
  })

  it('records no intent or HTTP request if cancellation happened before dispatch', async () => {
    const controller = new AbortController(), onWrite = vi.fn(), fetch = respond({}); controller.abort()
    await expect(api(actor(), onWrite).create('workers', bodies.workers, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(onWrite).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
})
