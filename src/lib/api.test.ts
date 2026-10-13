import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, isAdminSession, normalizeEndpoint, valueAt } from './api'
import type { CalculateOrderTemplate, CalculatorInput, Row, Session } from './api-types'

const endpoint = 'https://erp.example.com'
const client = () => new ApiClient({ endpoint, token: 'session-token' })
function respond(payload: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function calledUrl(fetch: ReturnType<typeof respond>, index = 0) { return new URL(String(fetch.mock.calls[index][0])) }
function calledBody(fetch: ReturnType<typeof respond>, index = 0): Row { return JSON.parse(String(fetch.mock.calls[index][1]?.body)) as Row }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ERP transport and session authority', () => {
  it('explains protected deletion blockers without exposing arbitrary server error text', () => {
    expect(new ApiError(409, 'item is used by active order').message).toContain('faol buyurtmada')
    expect(new ApiError(409, 'warehouse contains 3 products').message).toContain('3 ta mahsulot')
    expect(new ApiError(409, 'untrusted private payload').message).not.toContain('private payload')
  })
  it('uses the inactive supplier snapshot and strips access credentials', async () => {
    const fetch = respond([{ ref: 'removed-1', name: 'Removed', removed: true, code: 'secret' }])
    const page = await client().listSnapshot('suppliers', { inactive: true })
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/admin/suppliers/inactive')
    expect(page.items).toEqual([{ ref: 'removed-1', name: 'Removed', removed: true }])
    expect(page.hasMore).toBe(false)
  })
  it('reports recovered connectivity from an ERP response, including a rejected operation', async () => {
    const onConnectionChange = vi.fn()
    const api = new ApiClient({ endpoint, token: 'session-token', onConnectionChange })
    respond({ role: 'admin', display_name: 'Admin' })
    await api.me()
    respond({ error: 'store_failed' }, 500)
    await expect(api.get('/v1/mobile/admin/production-maps')).rejects.toMatchObject({ status: 500 })
    expect(onConnectionChange.mock.calls).toEqual([[true], [true]])
  })

  it('reports a lost connection without treating caller cancellation as a network outage', async () => {
    const onConnectionChange = vi.fn()
    const api = new ApiClient({ endpoint, token: 'session-token', onConnectionChange })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network unavailable')))
    await expect(api.me()).rejects.toMatchObject({ code: 'network' })
    expect(onConnectionChange).toHaveBeenCalledExactlyOnceWith(false)
    onConnectionChange.mockClear()
    const controller = new AbortController()
    controller.abort()
    await expect(api.me(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(onConnectionChange).not.toHaveBeenCalled()
  })

  it('normalizes domains and rejects credential-bearing or query-bearing endpoints', () => {
    expect(normalizeEndpoint(' erp.example.com/ ')).toBe(endpoint)
    expect(normalizeEndpoint('http://localhost:8080///')).toBe('http://localhost:8080')
    expect(() => normalizeEndpoint('https://user:secret@erp.example.com')).toThrow()
    expect(() => normalizeEndpoint('https://erp.example.com/?token=secret')).toThrow()
    expect(() => normalizeEndpoint('https://erp.example.com/#private')).toThrow()
  })

  it('logs in using phone and code without forwarding an existing bearer', async () => {
    const fetch = respond({ token: 'new-token', profile: { role: 'admin', display_name: 'Administrator' }, capabilities: ['admin.access'] })
    const session = await client().login('+998901234567', 'code-1')
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/auth/login')
    expect(calledBody(fetch)).toEqual({ phone: '+998901234567', code: 'code-1' })
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
    expect(session.assigned_warehouses).toEqual([])
    expect(isAdminSession(session)).toBe(true)
    expect(isAdminSession({ ...session, capabilities: [] })).toBe(false)
  })

  it('sends bearer authorization and omits cookies, browser cache and redirects', async () => {
    const fetch = respond({ role: 'admin', display_name: 'Administrator' })
    await client().me()
    const options = fetch.mock.calls[0][1]
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/me')
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer session-token')
    expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' })
  })

  it('invokes unauthorized handling for a real HTTP401, not a transport outage', async () => {
    const onUnauthorized = vi.fn()
    const api = new ApiClient({ endpoint, token: 'session-token', onUnauthorized })
    respond({ error: 'unauthorized' }, 401)
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Offline')))
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: 'network' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('does not publish a stale response or revoke a new session after cancellation', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(fulfill => { resolve = fulfill })))
    const onUnauthorized = vi.fn()
    const api = new ApiClient({ endpoint, token: 'old-token', onUnauthorized })
    const controller = new AbortController()
    const pending = api.me(controller.signal)
    controller.abort()
    resolve(new Response('{"error":"unauthorized"}', { status: 401 }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('rejects malformed server data instead of silently manufacturing records', async () => {
    respond({ token: 'token', profile: { role: 'admin', display_name: 'Admin' }, capabilities: ['admin.access'], assigned_warehouses: [42] })
    await expect(client().login('phone', 'code')).rejects.toBeInstanceOf(ApiError)
    respond({ items: [{ id: 'user' }] })
    await expect(client().list('users')).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('verified list and presentation contracts', () => {
  it('uses offset and one-record lookahead for real item pagination', async () => {
    const fetch = respond([{ code: 'A' }, { code: 'B' }, { code: 'C' }])
    expect(await client().list('items', { limit: 2, offset: 4, q: 'Film', group: 'Rulon' })).toEqual({ items: [{ code: 'A' }, { code: 'B' }], hasMore: true })
    expect(Object.fromEntries(calledUrl(fetch).searchParams)).toEqual({ q: 'Film', group: 'Rulon', offset: '4', limit: '3' })
  })

  it.each([20, 30, 50])('returns complete %i-record pages without dropping a capped customer record', async limit => {
    const source = Array.from({ length: 127 }, (_, index) => ({ ref: `customer-${index}`, name: `Customer ${index}` }))
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => {
      const url = new URL(String(input))
      const offset = Number(url.searchParams.get('offset') || 0)
      const requested = Math.min(Number(url.searchParams.get('limit') || 20), 50)
      return new Response(JSON.stringify(source.slice(offset, offset + requested)))
    })
    vi.stubGlobal('fetch', fetch)
    const loaded: Row[] = []
    const api = client()
    let hasMore = true
    for (let offset = 0; hasMore; offset += limit) {
      const page = await api.list('customers', { q: 'Customer', offset, limit })
      loaded.push(...page.items)
      hasMore = page.hasMore
    }
    expect(loaded).toEqual(source)
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).searchParams.get('q') === 'Customer')).toBe(true)
    if (limit === 50) {
      expect(calledUrl(fetch, 0).searchParams.get('limit')).toBe('50')
      expect(Object.fromEntries(calledUrl(fetch, 1).searchParams)).toEqual({ q: 'Customer', offset: '50', limit: '1' })
    } else {
      expect(fetch.mock.calls.every(([input]) => new URL(String(input)).searchParams.get('limit') === String(limit + 1))).toBe(true)
    }
  })

  it('uses a separate lookahead to recognize an exact final full supplier page', async () => {
    const source = Array.from({ length: 50 }, (_, index) => ({ ref: `supplier-${index}` }))
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify(source))).mockResolvedValueOnce(new Response('[]'))
    vi.stubGlobal('fetch', fetch)
    expect(await client().list('suppliers', { limit: 50, offset: 0 })).toEqual({ items: source, hasMore: false })
    expect(calledUrl(fetch, 1).searchParams.get('offset')).toBe('50')
    expect(calledUrl(fetch, 1).searchParams.get('limit')).toBe('1')
  })

  it('does not send unsupported supplier search and omits access codes from list state', async () => {
    const fetch = respond([{ ref: 'supplier-1', name: 'Factory', code: 'private-code' }])
    expect((await client().list('suppliers', { q: 'ignored' })).items).toEqual([{ ref: 'supplier-1', name: 'Factory' }])
    expect(calledUrl(fetch).searchParams.has('q')).toBe(false)
  })

  it('locally pages limit-only worker endpoints and reports a reached server cap', async () => {
    const fetch = respond(Array.from({ length: 500 }, (_, index) => ({ id: String(index) })))
    const result = await client().list('workers', { offset: 2, limit: 2 })
    expect(result).toEqual({ items: [{ id: '2' }, { id: '3' }], hasMore: true, bounded: true })
    expect(calledUrl(fetch).searchParams.get('limit')).toBe('500')
    expect(calledUrl(fetch).searchParams.has('offset')).toBe(false)
  })

  it('uses server has_more and maps inventory search to its actual query parameter', async () => {
    respond({ items: [{ id: 'user-1' }], has_more: true })
    expect((await client().list('users')).hasMore).toBe(true)
    const fetch = respond([])
    await client().list('assets', { q: 'Roll', warehouse_id: 'warehouse-1' })
    expect(calledUrl(fetch).searchParams.get('query')).toBe('Roll')
    expect(calledUrl(fetch).searchParams.has('q')).toBe(false)
  })

  it('requires the actual warehouse before requesting aggregate stock', async () => {
    const fetch = respond([])
    await expect(client().list('stock')).rejects.toThrow('Omborni tanlang.')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes production from authoritative statuses while preserving its map', async () => {
    const map = { id: 'zakaz-1', title: 'Film', nodes: [], edges: [], order_kg: 120 }
    respond({ ok: true, rev: 1, epoch: 'epoch', scope: '', maps: [{ map, program: { operations: [] } }], order_statuses: { 'zakaz-1': { order_status: 'in_progress' } }, order_customers: { 'zakaz-1': 'Customer' }, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {} })
    const order = (await client().list('orders')).items[0]
    expect(order).toMatchObject({ id: 'zakaz-1', customer_name: 'Customer', order_kg: 120, status: 'in_progress', map })
    expect(order.current_stage).toBeUndefined()
  })

  it('flattens opening WIP intake records into their actual batches', async () => {
    respond({ records: [{ intake: { order_id: 'zakaz-1', current_location: 'Warehouse' }, batches: [{ batch_id: 'batch-1', quantity: 12, uom: 'Kg' }] }] })
    expect((await client().list('opening-wip')).items[0]).toMatchObject({ batch_id: 'batch-1', order_id: 'zakaz-1', current_location: 'Warehouse', quantity: 12, uom: 'Kg' })
  })

  it.each([
    { kind: 'pending' as const, payload: [{ id: 'pending-1', template: { order_number: 'ORD-9', customer: 'Navro‘z Foods' } }], queries: ['ORD-9', 'Navro‘z'] },
    { kind: 'item-groups' as const, payload: [{ name: 'group-1', item_group_name: 'Polimer plyonkalar', parent_item_group: 'Xomashyo' }], queries: ['Plyonkalar', 'Xomashyo'] },
    { kind: 'roles' as const, payload: [{ id: 'role-1', label: 'Katta usta', base_role: 'boyoqchi', capability_codes: ['production.map.manage'], system: false }], queries: ['Katta usta', 'boyoqchi', 'production.map.manage'] },
  ])('searches actual nested values for $kind', async ({ kind, payload, queries }) => {
    for (const q of queries) {
      respond(payload)
      expect((await client().list(kind, { q })).items).toHaveLength(1)
    }
    respond(payload)
    expect((await client().list(kind, { q: 'no matching value' })).items).toEqual([])
  })

  it('does not search JSON property names or arbitrarily deep structures', async () => {
    respond([{ name: 'group-1', item_group_name: 'Polimer', parent_item_group: 'Xomashyo' }])
    expect((await client().list('item-groups', { q: 'parent_item_group' })).items).toEqual([])
    respond([{ id: 'role-1', nested: { second: { third: { fourth: { fifth: 'too-deep-value' } } } } }])
    expect((await client().list('roles', { q: 'too-deep-value' })).items).toEqual([])
  })

  it('reads array counts safely without exposing inherited properties', () => {
    const row = { nodes: [{ title: 'Print' }], capability_codes: ['admin.access', 'production.map.manage'], variants: [] }
    expect(valueAt(row, 'nodes.length')).toBe(1)
    expect(valueAt(row, 'nodes.0.title')).toBe('Print')
    expect(valueAt(row, 'capability_codes.length')).toBe(2)
    expect(valueAt(row, 'variants.length')).toBe(0)
    expect(valueAt(row, 'constructor')).toBeUndefined()
    expect(valueAt(row, 'nodes.constructor')).toBeUndefined()
  })
})

describe('server-owned admin mutations', () => {
  it('opens orders by forwarding the template without frontend business calculations', async () => {
    const opened = { ok: true, saved: { map: { id: 'zakaz-0001', order_number: '0001', nodes: [], edges: [] }, program: {} }, template: null }
    const fetch = respond(opened)
    const template = { name: 'Film', product: 'Film', order_number: '', frame_product_size_mm: 320, frame_count: 2, edge_allowance_mm: 15, kg: 100, print_val_size_mm: 600, production_options: { print_method: 'metal', cold_glue: false } }
    expect(await client().autoOpenOrder(template)).toEqual(opened)
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/admin/production-maps/auto-open')
    expect(calledBody(fetch)).toEqual({ template })
  })

  it.each([
    { id: 'zakaz-1', nodes: [], edges: [] },
    { id: '', order_number: '0001', nodes: [], edges: [] },
    { id: 'zakaz-1', order_number: '0001', edges: [] },
  ])('rejects an opening acknowledgement without generated identity or a complete map', async map => {
    respond({ ok: true, saved: { map, program: {} }, template: null })
    await expect(client().autoOpenOrder({ product: 'Film' })).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('validates completion acknowledgement against the exact submitted decision', async () => {
    const fetch = respond({ ok: true, decision: { request_event_id: 'event-1', decision: 'approved' } })
    await client().decideCompletion('event-1', 'approve')
    expect(calledBody(fetch)).toEqual({ event_id: 'event-1', decision: 'approve' })
    respond({ ok: true, decision: { request_event_id: 'other-event', decision: 'approved' } })
    await expect(client().decideCompletion('event-1', 'approve')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('preserves required settings metadata and never returns or submits an existing access code', async () => {
    const current = { default_target_warehouse: 'Old', default_uom: 'Kg', admin_name: 'Admin', admin_phone: '1', werka_name: 'Warehouse user', werka_phone: '2', werka_avatar_url: '/avatar', werka_code: 'secret', werka_code_locked: true, werka_code_retry_after_sec: 90 }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify(current))).mockResolvedValueOnce(new Response(JSON.stringify({ ...current, default_target_warehouse: 'New' })))
    vi.stubGlobal('fetch', fetch)
    const saved = await client().saveSettings({ default_target_warehouse: 'New', default_uom: 'Kg', admin_name: 'Stale admin', admin_phone: 'Old phone', werka_name: 'Warehouse user', werka_phone: '2' })
    expect(calledBody(fetch, 1)).toMatchObject({ default_target_warehouse: 'New', admin_name: 'Admin', admin_phone: '1', werka_avatar_url: '/avatar', werka_code: '', werka_code_locked: true, werka_code_retry_after_sec: 90 })
    expect(saved.werka_code).toBeUndefined()
    expect(JSON.stringify(calledBody(fetch, 1))).not.toContain('secret')
  })
})

describe('mobile new-order contracts', () => {
  const input: CalculatorInput = { kg: 120, frame_product_size_mm: 320, frame_count: 2, edge_allowance_mm: 15, waste_percent: 5, layers: [{ material_id: 'pet', material: 'PET', micron: '12' }], product: 'Film', order_number: '', color: '', material_display: '' }
  const calculation = { ...input, ok: true, width_mm: 655, min_mold_size_mm: 700, rubber_size_mm: 700, roll_count: null, results: [{ film_gsm: 16.8, adhesive_gsm: 0, total_gsm: 16.8, first_coeff: 0, other_coeff: 0, coeff_sum: 0, width_sm: 65.5, base_length: 10000, waste_length: 500, rounded_length: 10500 }] }
  const image = { image_id: 'img123', image_name: 'rang.webp', image_mime: 'image/webp', image_size_bytes: 300, image_url: '/v1/mobile/calculate/orders/image/view?id=img123' }

  it('uses only the calculate endpoint and preserves server-derived dimensions', async () => {
    const fetch = respond(calculation)
    expect(await client().calculate(input)).toEqual(calculation)
    expect(fetch).toHaveBeenCalledOnce()
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/calculate')
    expect(calledBody(fetch)).toEqual(input)
    expect(calledBody(fetch).width_mm).toBeUndefined()
    expect(calledBody(fetch).print_val_size_mm).toBeUndefined()
  })

  it.each([
    { ...calculation, width_mm: '655' },
    { ...calculation, results: [] },
    { ...calculation, results: [{ rounded_length: 10500 }] },
  ])('rejects incomplete calculation data before it can be used to open an order', async payload => {
    respond(payload)
    await expect(client().calculate(input)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('preserves the actual calculation failure reason from the server', async () => {
    respond({ ok: false, error: 'invalid_input', detail: 'Atxod foiz noto‘g‘ri' }, 400)
    await expect(client().calculate(input)).rejects.toMatchObject({ status: 400, code: 'invalid_input', message: 'Atxod foiz noto‘g‘ri' })
  })

  it('filters active material names before paging instead of producing empty pages', async () => {
    const fetch = respond({ ok: true, materials: [{ id: 'off', name: 'PET', active: false }, { id: 'p1', name: 'PET white', active: true }, { id: 'p2', name: 'PE-T transparent', active: true }, { id: 'p3', name: 'PP', active: true }] })
    expect(await client().calculateMaterials({ q: 'p-et', offset: 0, limit: 1 })).toEqual({ items: [{ id: 'p1', name: 'PET white', active: true }], hasMore: true })
    expect(await client().calculateMaterials({ q: 'p-et', offset: 1, limit: 1 })).toEqual({ items: [{ id: 'p2', name: 'PE-T transparent', active: true }], hasMore: false })
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/admin/calculate-materials')
    expect(calledUrl(fetch).search).toBe('')
  })

  it('queries only finished products when no customer is selected', async () => {
    const fetch = respond([{ code: 'f1', name: 'Film', item_group: 'Tayyor mahsulot' }, { code: 'f2', name: 'Film 2', item_group: 'Tayyor mahsulot' }])
    expect(await client().calculateProducts({ q: 'Film', offset: 4, limit: 1 })).toEqual({ items: [{ code: 'f1', name: 'Film', item_group: 'Tayyor mahsulot' }], hasMore: true })
    expect(Object.fromEntries(calledUrl(fetch).searchParams)).toEqual({ q: 'Film', group: 'Tayyor mahsulot', offset: '4', limit: '2' })
  })

  it('uses only customer-assigned finished products and searches before paging', async () => {
    const fetch = respond({ ref: 'customer-1', code: 'private', assigned_items: [{ code: 'raw', name: 'Film', item_group: 'Xomashyo' }, { code: 'f1', name: 'Film white', item_group: 'Tayyor mahsulot' }, { code: 'f2', name: 'Film white 2', item_group: ' tayyor mahsulot ' }, { code: 'other', name: 'Packet', item_group: 'Tayyor mahsulot' }] })
    expect(await client().calculateProducts({ customerRef: ' customer-1 ', q: 'film white', offset: 1, limit: 1 })).toEqual({ items: [{ code: 'f2', name: 'Film white 2', item_group: ' tayyor mahsulot ' }], hasMore: false })
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/admin/customers/detail')
    expect(Object.fromEntries(calledUrl(fetch).searchParams)).toEqual({ ref: 'customer-1' })
  })

  it('preserves mobile transliteration and multiple-word search for assigned products', async () => {
    respond({ assigned_items: [{ code: 'f1', name: 'Oq plyonka', item_group: 'Tayyor mahsulot' }] })
    expect((await client().calculateProducts({ customerRef: 'customer-1', q: 'оқ плёнка' })).items).toHaveLength(1)
    expect((await client().calculateProducts({ customerRef: 'customer-1', q: 'oq piyonka' })).items).toHaveLength(1)
    expect((await client().calculateProducts({ customerRef: 'customer-1', q: 'customer-1' })).items).toHaveLength(0)
  })

  it('automatically selects the first primary customer and omits private access codes', async () => {
    const fetch = respond({ code: 'f1', customers: [{ ref: 's', name: ' Saidamin ' }, { ref: '', name: 'Missing ref' }, { ref: 'c', name: 'Foods', code: 'private-code' }, { ref: 'd', name: 'Other' }] })
    expect(await client().productCustomer(' f1 ')).toEqual({ ref: 'c', name: 'Foods' })
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/admin/items/detail')
    expect(Object.fromEntries(calledUrl(fetch).searchParams)).toEqual({ code: 'f1' })
  })

  it('falls back to a secondary customer and returns null for an unassigned product', async () => {
    respond({ customers: [{ ref: 's', name: 'Saidamin' }] })
    expect(await client().productCustomer('f1')).toEqual({ ref: 's', name: 'Saidamin' })
    const fetch = respond({ customers: [] })
    expect(await client().productCustomer('f2')).toBeNull()
    expect(await client().productCustomer(' ')).toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('uploads raw image bytes using the shared authenticated transport', async () => {
    const fetch = respond({ ok: true, image })
    const file = new Blob(['native-image-bytes'], { type: 'image/png' })
    expect(await client().uploadOrderImage(file, 'rang.png')).toEqual(image)
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/calculate/orders/image')
    const options = fetch.mock.calls[0][1]
    expect(options?.body).toBe(file)
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error' })
    expect(new Headers(options?.headers).get('Content-Type')).toBe('image/png')
    expect(new Headers(options?.headers).get('X-File-Name')).toBe('rang.png')
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer session-token')
  })

  it('validates the native image size and formats before sending a request', async () => {
    const fetch = respond({ ok: true, image })
    await expect(client().uploadOrderImage(new Blob(['gif'], { type: 'image/gif' }), 'x.gif')).rejects.toThrow('JPEG')
    await expect(client().uploadOrderImage(new Blob([new Uint8Array(6 * 1024 * 1024 + 1)], { type: 'image/png' }), 'x.png')).rejects.toThrow('6 MB')
    await expect(client().uploadOrderImage(new Blob([], { type: 'image/png' }), 'x.png')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts non-ASCII filenames safely and rejects incomplete image acknowledgements', async () => {
    const fetch = respond({ ok: true, image })
    await client().uploadOrderImage(new Blob(['png'], { type: 'image/png' }), 'rang🎨\r\n.png')
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('X-File-Name')).toBe('rang_.png')
    respond({ ok: true, image: { image_id: 'img123' } })
    await expect(client().uploadOrderImage(new Blob(['png'], { type: 'image/png' }), 'rang.png')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('does not publish an uploaded image after its account request was cancelled', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(fulfill => { resolve = fulfill })))
    const onUnauthorized = vi.fn()
    const api = new ApiClient({ endpoint, token: 'old-token', onUnauthorized })
    const controller = new AbortController()
    const upload = api.uploadOrderImage(new Blob(['png'], { type: 'image/png' }), 'rang.png', controller.signal)
    controller.abort()
    resolve(new Response('{"error":"unauthorized"}', { status: 401 }))
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('replaces the nested order map with the freshly fetched map', async () => {
    const previous = { id: 'zakaz-0001', title: 'Old', nodes: [{ id: 'old' }], edges: [] }
    const fresh = { ...previous, title: 'Updated', nodes: [{ id: 'new' }] }
    respond({ map: fresh, program: { operations: [] } })
    expect(await client().detail('orders', { ...previous, map: previous })).toMatchObject({ title: 'Updated', map: fresh, nodes: fresh.nodes })
  })
})

describe('visual production-map order saving', () => {
  const map: Row = {
    id: 'zakaz-draft-123', code: '', order_number: '', product_code: 'FILM-1', title: 'Film',
    width_mm: 655, print_val_size_mm: 600, roll_count: 7,
    nodes: [
      { id: 'start', kind: 'start', title: 'Start', x: 420, y: 32 },
      { id: 'order', kind: 'task', title: 'Film', role_code: 'zakaz', x: 420, y: 164 },
      { id: 'cut', kind: 'apparatus', title: 'Rezka', apparatus_id: 'apparatus:default:rezka', rezka_kadr_count: 3, rezka_frame_groups: [1, 2], x: 420, y: 296 },
      { id: 'end', kind: 'end', title: 'Film', item_code: 'FILM-1', x: 420, y: 428 },
    ],
    edges: [{ from: 'start', to: 'order' }, { from: 'order', to: 'cut' }, { from: 'cut', to: 'end' }],
  }
  const template: CalculateOrderTemplate = {
    id: '', code: '', order_number: '', name: 'Film', product: 'Film', item_code: 'FILM-1',
    customer_ref: '', customer: '', kg: 120, frame_product_size_mm: 320, frame_count: 2,
    edge_allowance_mm: 15, waste_percent: 5, print_val_size_mm: 600, roll_count: 7,
    layers: [{ material_id: 'pet', material: 'PET', micron: '12' }],
    production_options: { print_method: 'metal', cold_glue: false },
    image_id: 'img123', image_name: 'Film.webp', image_mime: 'image/webp', image_size_bytes: 300,
  }
  const savedMap = { ...map, id: 'zakaz-0001', code: '0001', order_number: '0001', order_kg: 120, base_length: 10500 }
  const saved = { map: savedMap, program: { map_id: 'zakaz-0001', product_code: 'FILM-1', operations: [] } }

  it('puts the visual map and calculation template in one exact server-side operation', async () => {
    const payload = { ok: true, saved, template: { ...template, id: 'template-1', code: '0001', order_number: '0001', source_map_id: 'template-map-1' } }
    const fetch = respond(payload)
    expect(await client().saveProductionMapWithOrder(map, template)).toEqual(payload)
    expect(fetch).toHaveBeenCalledOnce()
    expect(calledUrl(fetch).pathname).toBe('/v1/mobile/admin/production-maps/with-order')
    expect(fetch.mock.calls[0][1]?.method).toBe('PUT')
    expect(calledBody(fetch)).toEqual({ map, template })
    expect(calledBody(fetch)).not.toHaveProperty('pending_order_id')
    expect(calledBody(fetch)).not.toHaveProperty('protocol_version')
    expect(calledBody(fetch)).not.toHaveProperty('split_maps')
    expect(map.id).toBe('zakaz-draft-123')
    expect(template.order_number).toBe('')
  })

  it('accepts a null reusable-template result without manufacturing one', async () => {
    const payload = { ok: true, saved, template: null }
    respond(payload)
    expect(await client().saveProductionMapWithOrder(map, template)).toEqual(payload)
  })

  it.each([
    { ...savedMap, id: 'zakaz-draft-123' },
    { ...savedMap, order_number: '' },
    { ...savedMap, code: 'other-number' },
    { ...savedMap, id: 'zakaz-0099' },
    { ...savedMap, nodes: ['invalid-node'] },
  ])('rejects incomplete or inconsistent generated order acknowledgements', async returnedMap => {
    respond({ ok: true, saved: { ...saved, map: returnedMap }, template: null })
    await expect(client().saveProductionMapWithOrder(map, template)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('requires the compiled program and explicit successful acknowledgement', async () => {
    respond({ ok: true, saved: { map: savedMap }, template: null })
    await expect(client().saveProductionMapWithOrder(map, template)).rejects.toMatchObject({ code: 'invalid_response' })
    respond({ ok: false, saved, template: null })
    await expect(client().saveProductionMapWithOrder(map, template)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('passes cancellation through the save without publishing an old-session result', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise<Response>(fulfill => { resolve = fulfill }))
    vi.stubGlobal('fetch', fetch)
    const onUnauthorized = vi.fn()
    const api = new ApiClient({ endpoint, token: 'old-token', onUnauthorized })
    const controller = new AbortController()
    const saving = api.saveProductionMapWithOrder(map, template, controller.signal)
    controller.abort()
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    resolve(new Response('{"error":"unauthorized"}', { status: 401 }))
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

// Role labels are presentation; backend capability codes are the admin gate.
const roleOnly: Pick<Session, 'profile' | 'capabilities'> = { profile: { role: 'admin', display_name: 'Admin' }, capabilities: [] }
it('requires backend administrator capability rather than trusting a display role', () => {
  expect(isAdminSession(roleOnly as Session)).toBe(false)
})
