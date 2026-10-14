import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import type { Session } from './api-types'
import {
  OrderImagesApi, canReadOrderImages, canReadPendingImages, canReadTemplateImages, orderFullImageMaxBytes, orderImagePath,
  orderImageRequest, orderThumbnailMaxBytes, parseOrderImageReference, parsePendingImageReference, parseTemplateImageReference,
  pendingImagePath, templateImagePath,
} from './order-images'

const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1])
const ref = { order_id: 'zakaz-0012', image_id: 'image-0012' }
function session(capabilities = ['apparatus.queue.read']): Session {
  return { token: 'local-test', capabilities, profile: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
}
const client = (config = {}) => new ApiClient({ endpoint: 'https://erp.example.test', token: 'local-test', ...config })
const api = (principal = session()) => new OrderImagesApi(client(), principal)
function wire(response: Response | (() => Promise<Response>) = new Response(webp, { headers: { 'Content-Type': 'image/webp' } })) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(typeof response === 'function' ? response : async () => response)
  vi.stubGlobal('fetch', fetch); return fetch
}
const url = (fetch: ReturnType<typeof wire>, index = 0) => new URL(String(fetch.mock.calls[index]![0]))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('native order/template/pending image identity and capabilities', () => {
  it('handles flattened maps and saved {map}, preserves legacy IDs and still looks up maps with no image metadata', () => {
    expect(parseOrderImageReference({ id: ' zakaz-0012 ', image_id: ' image-0012 ' })).toEqual(ref)
    expect(parseOrderImageReference({ map: { id: 'ZAKAZ-0012', image_id: 'image-0012' } })).toEqual(ref)
    expect(parseOrderImageReference({ id: 'zakaz-0012', map: { id: 'zakaz-0012', image_id: 'image-0012' } })).toEqual(ref)
    expect(parseOrderImageReference({ id: 'Legacy-Map' })).toEqual({ order_id: 'legacy-map' })
    expect(parseOrderImageReference({ id: 'legacy-map', image_id: '' })).toEqual({ order_id: 'legacy-map' })
    expect(parseOrderImageReference({ id: 'legacy-map', image_id: null, image_mime: 'unknown' })).toEqual({ order_id: 'legacy-map' })
    expect(Object.isFrozen(parseOrderImageReference({ id: 'legacy-map' }))).toBe(true)
  })
  it('uses only actual production map identity and never guesses from titles, order numbers or private/external image URLs', () => {
    for (const value of [null, [], 'https://assets.invalid/photo.jpg', { image_url: 'https://assets.invalid/photo.jpg' }, { order_number: '0012' }, { order_id: 'zakaz-0012' }, { id: '' }, { map: null, id: 'zakaz-0012' }, { map: { id: 'zakaz-0012' }, id: 'event-12' }]) expect(parseOrderImageReference(value)).toBeNull()
    expect(parseOrderImageReference({ id: 'legacy-map', image_url: '/v1/mobile/calculate/orders/image/view?id=private', image_id: 'https://assets.invalid/photo.jpg?token=secret' })).toEqual({ order_id: 'legacy-map' })
  })
  it('keeps production image_id as an optional hint and explicitly uses the native thumb variant or no full variant', () => {
    expect(orderImageRequest(ref)).toEqual({ path: orderImagePath, query: { order_id: ref.order_id, image_id: ref.image_id, variant: 'thumb-v1' } })
    expect(orderImageRequest({ order_id: 'legacy-map' }, 'full')).toEqual({ path: orderImagePath, query: { order_id: 'legacy-map' } })
    expect(() => orderImageRequest(ref, 'original' as 'full')).toThrow()
    expect(() => orderImageRequest({ order_id: ' ' })).toThrow()
  })
  it('keeps template owner-scoped safe image IDs separate from pending outer IDs and production maps', () => {
    expect(parseTemplateImageReference({ image_id: ' Image_A-1 ' })).toEqual({ image_id: 'Image_A-1' })
    expect(parseTemplateImageReference({ template: { id: 'template-only', image_id: 'Image_A-1' } })).toEqual({ image_id: 'Image_A-1' })
    for (const image_id of ['', 'x'.repeat(65), 'foo/bar', 'legacy&image', 'Ё', 'https://assets.invalid/img']) expect(parseTemplateImageReference({ image_id })).toBeNull()
    expect(parseTemplateImageReference({ map: { id: 'zakaz-0012' }, image_id: 'private-template' })).toBeNull()
    expect(parsePendingImageReference({ id: 'Pending-001', template: { id: 'template-002' } })).toEqual({ id: 'Pending-001' })
    expect(parsePendingImageReference({ template: { id: 'template-002' } })).toBeNull()
  })
  it('models exact native production OR6 and distinct template/pending OR2, without inferring actual-role or queue.manage access', async () => {
    for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access']) expect(canReadOrderImages(session([capability]))).toBe(true)
    expect(canReadOrderImages(session(['apparatus.queue.manage']))).toBe(false); expect(canReadOrderImages(null)).toBe(false)
    for (const capability of ['admin.access', 'production.map.manage']) { const principal = { ...session([capability]), profile: { role: 'supplier', display_name: 'Supplier' } }; expect(canReadTemplateImages(principal)).toBe(true); expect(canReadPendingImages(principal)).toBe(true) }
    expect(canReadTemplateImages(session(['apparatus.queue.read']))).toBe(false)
    const fetch = wire(); await expect(api(session(['apparatus.queue.manage'])).thumbnail(ref)).rejects.toMatchObject({ status: 403 })
    await expect(api().templateThumbnail({ image_id: 'Image_A-1' })).rejects.toMatchObject({ status: 403 }); await expect(api().pendingFull({ id: 'Pending-001' })).rejects.toMatchObject({ status: 403 }); expect(fetch).not.toHaveBeenCalled()
  })
})

describe('read-only native raster image API', () => {
  it('loads only the thumb request and returns selected cache metadata without bearer tokens or external URLs', async () => {
    const fetch = wire(new Response(webp, { headers: { 'Content-Type': 'image/webp', ETag: '"thumb-sha256"', 'Cache-Control': 'private, max-age=0, must-revalidate', Vary: 'Authorization', Authorization: 'never-return-this' } }))
    const result = await api().thumbnail(ref); expect(result).toMatchObject({ kind: 'image', mime: 'image/webp', etag: '"thumb-sha256"', cache_control: 'private, max-age=0, must-revalidate', vary: 'Authorization' })
    expect(fetch).toHaveBeenCalledTimes(1); expect(url(fetch).pathname).toBe(orderImagePath); expect(url(fetch).searchParams.get('variant')).toBe('thumb-v1'); expect(url(fetch).searchParams.get('order_id')).toBe(ref.order_id)
    expect(JSON.stringify(result)).not.toContain('local-test'); expect(result).not.toHaveProperty('url'); expect(result).not.toHaveProperty('headers'); expect(result).not.toHaveProperty('immutable')
    const options = fetch.mock.calls[0]![1]; expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' }); expect(options?.body).toBeUndefined()
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer local-test'); expect(url(fetch).search).not.toContain('local-test')
  })
  it('uses full source only after an explicit full call, independently from the thumbnail bytes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(webp, { headers: { 'Content-Type': 'image/webp' } })).mockResolvedValueOnce(new Response(png, { headers: { 'Content-Type': 'image/png' } })); vi.stubGlobal('fetch', fetch)
    const service = api(), thumbnail = await service.thumbnail(ref); expect(fetch).toHaveBeenCalledTimes(1)
    const full = await service.full(ref); expect(fetch).toHaveBeenCalledTimes(2); expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.has('variant')).toBe(false)
    if (thumbnail.kind !== 'image' || full.kind !== 'image') throw new Error('Missing raster')
    expect(thumbnail.mime).toBe('image/webp'); expect(full.mime).toBe('image/png'); expect(await full.blob.arrayBuffer()).toEqual(png.buffer); expect(full.blob).not.toBe(thumbnail.blob)
  })
  it('looks up a legacy map with empty image_id through the same production route and never calls the private template archive', async () => {
    const fetch = wire(); await api().thumbnail(parseOrderImageReference({ id: 'legacy-map', image_id: '', image_url: '/v1/mobile/calculate/orders/image/view?id=private' })!)
    expect(url(fetch).pathname).toBe(orderImagePath); expect(url(fetch).searchParams.get('order_id')).toBe('legacy-map'); expect(url(fetch).searchParams.has('image_id')).toBe(false); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('safely encodes opaque legacy IDs while preserving the actual native raw-query decoding limitation, without aliases or fallback', async () => {
    const fetch = wire(new Response('{"error":"order topilmadi"}', { status: 404 })), value = parseOrderImageReference({ id: 'Legacy & Кирилл/%' })!
    expect((await api().thumbnail(value)).kind).toBe('missing'); expect(url(fetch).searchParams.get('order_id')).toBe(value.order_id); expect(url(fetch).search).toContain('%26'); expect(url(fetch).search).toContain('%25'); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('separates mutable order hints on each request rather than borrowing cached pixels or immutable image authority', async () => {
    const fetch = wire(async () => new Response(webp, { headers: { 'Content-Type': 'image/webp' } })), service = api()
    await service.thumbnail(ref); await service.thumbnail({ ...ref, image_id: 'relinked-image' }); await service.thumbnail({ order_id: ref.order_id })
    expect(fetch).toHaveBeenCalledTimes(3); expect(url(fetch, 1).searchParams.get('image_id')).toBe('relinked-image'); expect(url(fetch, 2).searchParams.has('image_id')).toBe(false)
  })
  it('uses owner-scoped template thumb/full and pending full-only route with outer ID, without inventing a pending thumbnail method', async () => {
    const fetch = wire(async () => new Response(webp, { headers: { 'Content-Type': 'image/webp' } })), service = api(session(['production.map.manage']))
    await service.templateThumbnail({ image_id: 'Image_A-1' }); expect(url(fetch).pathname).toBe(templateImagePath); expect(url(fetch).searchParams.get('id')).toBe('Image_A-1'); expect(url(fetch).searchParams.get('variant')).toBe('thumb-v1')
    await service.templateFull({ image_id: 'Image_A-1' }); expect(url(fetch, 1).searchParams.has('variant')).toBe(false)
    await service.pendingFull(parsePendingImageReference({ id: 'Pending-001', template: { id: 'template-other' } })!); expect(url(fetch, 2).pathname).toBe(pendingImagePath); expect(url(fetch, 2).searchParams.get('id')).toBe('Pending-001'); expect(url(fetch, 2).searchParams.has('variant')).toBe(false)
    expect(service).not.toHaveProperty('pendingThumbnail'); await expect(service.templateFull({ image_id: 'https://assets.invalid/photo' })).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each([
    ['rasm topilmadi', 'no_image'], ['not_found', 'no_image'], ['order topilmadi', 'order_missing'], ['pending_order_not_found', 'order_missing'], ['unrecognized_absence', 'unknown'],
  ])('classifies native JSON404 %s as absence without image or fallback', async (code, reason) => {
    const fetch = wire(new Response(JSON.stringify({ error: code }), { status: 404 })); expect(await api().thumbnail(ref)).toEqual({ kind: 'missing', reason, code }); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('distinguishes empty404 possibly missing route from native no-photo absence', async () => {
    wire(new Response(null, { status: 404 })); expect(await api().thumbnail(ref)).toEqual({ kind: 'missing', reason: 'route_unavailable', code: 'http_404' })
  })
  it.each([401, 403, 500, 503])('preserves HTTP%s as an error and never promotes full source or calls another authority', async status => {
    const fetch = wire(new Response('{"error":"store_failed"}', { status })); await expect(api().thumbnail(ref)).rejects.toMatchObject({ status }); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { body: '<html>login</html>', mime: 'text/html' }, { body: '{"error":"private"}', mime: 'image/webp' }, { body: '<svg></svg>', mime: 'image/svg+xml' }, { body: png, mime: 'image/webp' },
  ])('rejects unsafe or mismatched200 MIME/signature without a full fallback: %j', async value => {
    const fetch = wire(new Response(value.body, { headers: { 'Content-Type': value.mime } })); await expect(api().thumbnail(ref)).rejects.toMatchObject({ code: 'invalid_response' }); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('allows native raster full formats including JPEG alias but still rejects them as an unhonored thumbnail contract', async () => {
    wire(new Response(jpeg, { headers: { 'Content-Type': 'image/jpg' } })); expect(await api().full(ref)).toMatchObject({ kind: 'image', mime: 'image/jpeg' })
    wire(new Response(png, { headers: { 'Content-Type': 'image/png' } })); await expect(api().thumbnail(ref)).rejects.toMatchObject({ code: 'invalid_response' })
    wire(new Response(null, { status: 200, headers: { 'Content-Type': 'image/webp' } })); await expect(api().thumbnail(ref)).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('narrow bounded authenticated binary GET transport', () => {
  it('never accepts external/protocol-relative/non-mobile/backslash asset paths or caller authorization overrides', async () => {
    const fetch = wire(), service = client()
    for (const path of ['https://assets.invalid/photo.jpg', '//assets.invalid/photo.jpg', '/\\assets.invalid/x', '/images/photo.jpg', '/v1/mobile/x\r\nAuthorization:bearer']) await expect(service.getBinary(path)).rejects.toThrow()
    await expect(client({ token: undefined }).getBinary(orderImagePath)).rejects.toMatchObject({ status: 401 }); expect(fetch).not.toHaveBeenCalled()
  })
  it('supports explicit conditional304 metadata only, and rejects unsolicited304 or other unexpected2xx', async () => {
    let fetch = wire(new Response(null, { status: 304, headers: { 'Content-Type': 'image/webp', ETag: '"same"' } }))
    expect(await client().getBinary(orderImagePath, { ifNoneMatch: '"same"' })).toEqual({ status: 304, mime: 'image/webp', etag: '"same"' }); expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('If-None-Match')).toBe('"same"')
    wire(new Response(null, { status: 304 })); await expect(client().getBinary(orderImagePath)).rejects.toMatchObject({ status: 304, code: 'invalid_response' })
    for (const status of [201, 204, 206]) { fetch = wire(new Response(status === 204 ? null : webp, { status })); await expect(client().getBinary(orderImagePath)).rejects.toMatchObject({ status, code: 'invalid_response' }); expect(fetch).toHaveBeenCalledTimes(1) }
  })
  it('bounds declared and streamed bytes before publishing any blob, including no Content-Length and oversized errors', async () => {
    let fetch = wire(new Response(webp, { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(orderThumbnailMaxBytes + 1) } }))
    await expect(api().thumbnail(ref)).rejects.toMatchObject({ code: 'response_too_large' }); expect(fetch).toHaveBeenCalledTimes(1)
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); }, cancel })
    wire(new Response(body)); await expect(client().getBinary(orderImagePath, { maxBytes: 10 })).rejects.toMatchObject({ code: 'response_too_large' }); expect(cancel).toHaveBeenCalledOnce()
    wire(new Response('x'.repeat(64 * 1024 + 1), { status: 403 })); await expect(client().getBinary(orderImagePath)).rejects.toMatchObject({ status: 403, code: 'http_403' })
    expect(orderFullImageMaxBytes).toBe(8 * 1024 * 1024)
  })
  it('rejects invalid client bounds before fetching', async () => {
    const fetch = wire()
    for (const maxBytes of [0, -1, NaN, 0.5, Infinity, orderFullImageMaxBytes + 1]) await expect(client().getBinary(orderImagePath, { maxBytes })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses existing unauthorized/connectivity callbacks while keeping non-JSON refusal status known', async () => {
    const onUnauthorized = vi.fn(), onConnectionChange = vi.fn(), service = client({ onUnauthorized, onConnectionChange })
    wire(new Response(null, { status: 401 })); await expect(service.getBinary(orderImagePath)).rejects.toMatchObject({ status: 401, code: 'http_401' }); expect(onUnauthorized).toHaveBeenCalledOnce(); expect(onConnectionChange).toHaveBeenLastCalledWith(true)
    wire(async () => { throw new TypeError('offline') }); await expect(service.getBinary(orderImagePath)).rejects.toMatchObject({ status: 0, code: 'network' }); expect(onConnectionChange).toHaveBeenLastCalledWith(false); expect(onUnauthorized).toHaveBeenCalledOnce()
  })
  it('drops a cancelled old-session response before callbacks and never publishes its image or revokes the new session', async () => {
    let resolve!: (response: Response) => void
    const fetch = wire(() => new Promise<Response>(fulfill => { resolve = fulfill })), onUnauthorized = vi.fn(), onConnectionChange = vi.fn(), controller = new AbortController()
    const pending = client({ onUnauthorized, onConnectionChange }).getBinary(orderImagePath, { signal: controller.signal }); controller.abort(); resolve(new Response('{"error":"unauthorized"}', { status: 401 }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(onUnauthorized).not.toHaveBeenCalled(); expect(onConnectionChange).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1)
    const before = new AbortController(); before.abort(); wire(); await expect(api().thumbnail(ref, before.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('cancels streamed bytes on account abort without treating cancellation as a network outage', async () => {
    const cancel = vi.fn(), onConnectionChange = vi.fn(), controller = new AbortController(), body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(webp); }, cancel })
    wire(new Response(body, { headers: { 'Content-Type': 'image/webp' } })); const service = client({ onConnectionChange }), pending = service.getBinary(orderImagePath, { signal: controller.signal })
    await Promise.resolve(); await Promise.resolve(); controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(cancel).toHaveBeenCalledOnce(); expect(onConnectionChange).not.toHaveBeenCalledWith(false)
  })
  it('times out bounded body reads instead of returning partial bytes or leaving a stalled stream alive', async () => {
    vi.useFakeTimers(); const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(webp); }, cancel }), onConnectionChange = vi.fn()
    wire(new Response(body)); const assertion = expect(client({ onConnectionChange }).getBinary(orderImagePath, { timeoutMs: 5 })).rejects.toMatchObject({ status: 0, code: 'timeout' })
    await vi.advanceTimersByTimeAsync(5); await assertion; expect(cancel).toHaveBeenCalledOnce(); expect(onConnectionChange).toHaveBeenLastCalledWith(false)
  })
  it('preserves JSON request behavior alongside the independent binary helper', async () => {
    const fetch = wire(new Response('{"ok":true}', { status: 201, headers: { 'Content-Type': 'application/json' } }))
    expect(await client().get('/v1/mobile/me')).toEqual({ ok: true }); expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Accept')).toBe('application/json')
  })
})
