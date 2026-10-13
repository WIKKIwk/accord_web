import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { CalculateOrderTemplate, Row, Session } from './api-types'
import { newOrderDraft } from './order-draft'
import { MutationScope } from './mutation-scope'
import {
  CalculatorManagementApi, CalculatorMemory, CalculatorSaveUnknown, CalculatorSourceConflict,
  calculatorCanManage, calculatorFingerprint, calculatorManagementError, calculatorMemoryKey, calculatorMode,
  calculatorRouteCompatible, calculatorTemplateMatches, cloneCalculatorRoute, draftFromCalculatorTemplate,
  managedCalculationInput, managedCalculationSignature, managedCalculatorTemplate, parseCalculatorTemplate,
  parseOpenedCalculation, parsePendingCalculation, validateOpenedCalculationChange,
} from './calculator-management'
import type { CalculatorOperation, CalculatorSource } from './calculator-management'

const actor = (capabilities = ['admin.access']): Session => ({ token: 'fixture-session', profile: { role: 'admin', ref: 'admin', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const api = (capabilities = ['admin.access'], onWrite?: (operation: CalculatorOperation) => void) => new CalculatorManagementApi(new ApiClient({ endpoint: 'https://erp.example.test', token: 'fixture-session' }), actor(capabilities), onWrite)
const template: CalculateOrderTemplate = {
  id: 'template-a', code: 'Z-a', saved_at: '123', order_number: '0042', source_map_id: 'template-map-a',
  name: 'Bosma mahsulot shabloni', product: 'Mahsulot', item_code: 'SKU-01', customer_ref: 'customer-1', customer: 'Mijoz', status: 'rulon',
  kg: 100, frame_product_size_mm: 50, frame_count: 4, edge_allowance_mm: 15, width_mm: 215, waste_percent: 5, roll_count: 4,
  layers: [{ material_id: 'material-bopp', material: 'BOPP', micron: '20' }], note: 'Izoh', color: 'Oq',
  production_options: { print_method: 'metal', cold_glue: false, diameter_mm: null }, print_val_size_mm: null,
  image_id: 'img1', image_name: 'order.webp', image_mime: 'image/webp', image_size_bytes: 24, image_url: '/v1/mobile/calculate/orders/image/view?id=img1',
}
const route: Row = {
  id: 'template-map-a', code: '', order_number: '', title: 'Mahsulot', product_code: 'SKU-01', customer_name: 'Mijoz',
  width_mm: 215, order_kg: null, base_length: null, roll_count: 4, print_val_size_mm: null,
  nodes: [{ id: 'node1', apparatus_id: 'apparatus:default:pechat', item_code: 'MAT-01', alternative_assigned_title: 'Ali', alternative_assigned_apparatus_id: 'apparatus:default:pechat2', x: 1, y: 2 }, { id: 'finish', kind: 'finish', x: 1, y: 3 }],
  edges: [{ id: 'edge1', source: 'node1', target: 'finish', material_id: 'MAT-01' }],
}
const result: Row = { width_mm: 215, kg: 100, results: [{ rounded_length: 2468 }] }
const orderRaw = (revision = 2, changed = {}): Row => ({ map: { ...route, id: 'zakaz-0042', code: '0042', order_number: '0042', order_kg: 100, base_length: 2468 }, template: { ...template, code: '0042', source_map_id: 'zakaz-0042', ...changed }, revision, native_extension: { keep: 'lossless' } })
const order = () => parseOpenedCalculation(orderRaw(), 'zakaz-0042')
const orderSource = (): CalculatorSource => ({ kind: 'order', order: order(), template: order().template })
const pendingRaw = (completion: Row | null = null, changed = {}): Row => ({ id: 'zakaz-9011', template: { ...template, id: 'pending-template', code: 'TG-9011', order_number: '9011', source_map_id: '', ...changed }, telegram_user_id: '123', manager_name: 'Manager', created_at: 1234, completion })
const pending = () => parsePendingCalculation(pendingRaw(), 'zakaz-9011')
const templates = (items: CalculateOrderTemplate[] = [template]) => ({ ok: true, templates: items })
const completed = (): Row => ({ saved: { map: { ...route, id: 'zakaz-9011', code: '9011', order_number: '9011' }, program: { actions: [] } }, template: { ...template, id: 'pending-template', code: 'TG-9011', order_number: '9011', source_map_id: 'template-server-created' } })
function respond(...fixtures: unknown[]) {
  let index = 0
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    const item = fixtures[Math.min(index++, fixtures.length - 1)]
    if (item instanceof Error) throw item
    const response = item && typeof item === 'object' && 'payload' in item && 'status' in item ? item as { status: number; payload: unknown } : { status: 200, payload: item }
    return new Response(JSON.stringify(response.payload), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const url = (fetch: ReturnType<typeof respond>, index = 0) => new URL(String(fetch.mock.calls[index][0]))
const body = (fetch: ReturnType<typeof respond>, index = 0): Row => JSON.parse(String(fetch.mock.calls[index][1]?.body))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('calculator identity, hydration, and existing-route policy', () => {
  it('uses explicit query modes and rejects ambiguous or blank identities', () => {
    expect(calculatorMode(new URLSearchParams())).toEqual({ kind: 'new' })
    expect(calculatorMode(new URLSearchParams('orderId=zakaz-0042'))).toEqual({ kind: 'order', id: 'zakaz-0042' })
    expect(calculatorMode(new URLSearchParams('pendingId=zakaz-9011'))).toEqual({ kind: 'pending', id: 'zakaz-9011' })
    expect(calculatorMode(new URLSearchParams('templateId=template-a'))).toEqual({ kind: 'template', id: 'template-a', edit: false })
    expect(calculatorMode(new URLSearchParams('templateId=template-a&edit=1'))).toEqual({ kind: 'template', id: 'template-a', edit: true })
    expect(() => calculatorMode(new URLSearchParams('templateId=template-a&orderId=zakaz-0042'))).toThrow('bitta')
    expect(() => calculatorMode(new URLSearchParams('orderId='))).toThrow('bo‘sh')
  })

  it('hydrates omitted zero KG and legacy layers while retaining unknown native snapshot fields', () => {
    const legacy = { ...template, kg: undefined, layers: undefined, first_layer_material: 'BOPP', first_layer_micron: '20', second_layer_material: 'PET', second_layer_micron: '12', native_extra: { retained: true } }
    const decoded = parseCalculatorTemplate(legacy)
    expect(decoded.kg).toBe(0)
    expect(decoded.layers).toEqual([{ material: 'BOPP', micron: '20' }, { material: 'PET', micron: '12' }])
    expect(decoded.native_extra).toEqual({ retained: true })
    const raw = orderRaw(); expect(parseOpenedCalculation(raw, 'zakaz-0042').original).toEqual(raw)
    expect(raw).toEqual(orderRaw())
  })

  it('rejects malformed numeric, optional, array, and identity contracts', () => {
    for (const patch of [{ frame_count: Number.NaN }, { waste_percent: 100 }, { roll_count: 1.5 }, { print_val_size_mm: -1 }, { kg: -1 }, { layers: 'broken' }, { layers: [{ material: '', micron: '20' }] }]) expect(() => parseCalculatorTemplate({ ...template, ...patch })).toThrow(ApiError)
    expect(() => parseOpenedCalculation(orderRaw(-1), 'zakaz-0042')).toThrow(ApiError)
    expect(() => parseOpenedCalculation(orderRaw(), 'zakaz-other')).toThrow(ApiError)
    expect(() => parsePendingCalculation(pendingRaw(), 'zakaz-0042')).toThrow(ApiError)
    expect(() => parsePendingCalculation(pendingRaw(null, { order_number: '9012' }), 'zakaz-9011')).toThrow(ApiError)
  })

  it('preserves KG for existing/pending edits but leaves reusable template quantity blank', () => {
    expect(draftFromCalculatorTemplate(template, true).kg).toBe('100')
    const draft = draftFromCalculatorTemplate(template, false)
    expect(draft.kg).toBe('')
    expect(draft.layers).toEqual([{ key: 'loaded-0', material_id: 'material-bopp', material: 'BOPP', micron: '20' }])
    expect(draft.image?.image_id).toBe('img1')
    expect(draftFromCalculatorTemplate({ ...template, status: 'flexo', production_options: undefined }, false)).toMatchObject({ status: 'Rulon', print_method: 'flexo' })
  })

  it('uses existing edge allowance in both calculation requests and staleness signatures', () => {
    const source = orderSource(), draft = { ...draftFromCalculatorTemplate(template, true), edge_allowance_mm: '20' }
    expect(managedCalculationInput(draft).edge_allowance_mm).toBe(15)
    expect(managedCalculationInput(draft, source).edge_allowance_mm).toBe(20)
    expect(managedCalculationSignature(draft, source)).not.toBe(managedCalculationSignature({ ...draft, edge_allowance_mm: '21' }, source))
    expect(managedCalculationSignature(draft)).toBe(managedCalculationSignature({ ...draft, edge_allowance_mm: '21' }))
    expect(() => managedCalculationInput({ ...draft, edge_allowance_mm: '' }, source)).toThrow('Chet')
  })

  it('clears new identities and quantity while preserving reusable source metadata and options', () => {
    const source: CalculatorSource = { kind: 'template', template: { ...template, production_options: { print_method: 'metal', cold_glue: true, diameter_mm: 80 } }, templates: [template] }
    const draft = { ...draftFromCalculatorTemplate(source.template, false), roll_count: '' }
    const reusable = managedCalculatorTemplate(draft, null, source, true, 'Yangi shablon')
    expect(reusable).toMatchObject({ id: '', code: '', order_number: '', kg: 0, name: 'Yangi shablon', source_map_id: 'template-map-a', color: 'Oq', roll_count: null })
    expect(reusable.production_options).toEqual({ print_method: 'metal', cold_glue: true, diameter_mm: 80 })
    const opened = managedCalculatorTemplate({ ...draft, kg: '200' }, result, source)
    expect(opened).toMatchObject({ id: '', code: '', order_number: '', source_map_id: '', kg: 200 })
  })

  it('keeps existing native identity, name, status, and production options unchanged', () => {
    const source = orderSource(), draft = { ...draftFromCalculatorTemplate(source.template, true), kg: '150', status: 'Paket' as const, print_method: 'flexo' as const }
    expect(managedCalculatorTemplate(draft, result, source)).toMatchObject({ id: template.id, code: '0042', order_number: '0042', source_map_id: 'zakaz-0042', name: template.name, status: 'rulon', production_options: template.production_options, kg: 150 })
  })

  it('blocks unsafe existing-route edits and preserves custom routes rather than guessing topology', () => {
    const source = order()
    expect(() => validateOpenedCalculationChange(source, { ...source.template, kg: 150 })).not.toThrow()
    for (const patch of [{ status: 'paket' }, { production_options: { print_method: 'flexo', cold_glue: false } }, { frame_count: 1025 }, { frame_count: 1.5 }, { roll_count: null }, { item_code: 'OTHER' }, { layers: [...template.layers, template.layers[0]] }]) expect(() => validateOpenedCalculationChange(source, { ...source.template, ...patch } as CalculateOrderTemplate)).toThrow()
    expect(calculatorRouteCompatible(template, { ...template, kg: 200, frame_count: 5 })).toBe(true)
    expect(calculatorRouteCompatible(template, { ...template, status: 'paket' })).toBe(false)
    expect(calculatorRouteCompatible(template, { ...template, production_options: { print_method: 'metal', cold_glue: true } })).toBe(false)
  })

  it('clones same-product material-bound topology into a fresh identity and clears old operator overrides', () => {
    const cloned = cloneCalculatorRoute(route, { ...template, kg: 200 }, result, 'zakaz-draft-test')
    expect(cloned).toMatchObject({ id: 'zakaz-draft-test', code: '', order_number: '', order_kg: 200, width_mm: 215, base_length: 2468 })
    expect((cloned.nodes as Row[])[0]).toMatchObject({ item_code: 'MAT-01', apparatus_id: 'apparatus:default:pechat', alternative_assigned_title: '', alternative_assigned_apparatus_id: '' })
    expect(cloned.edges).toEqual(route.edges)
    expect(route.nodes).not.toEqual(cloned.nodes)
    expect(() => cloneCalculatorRoute(route, { ...template, item_code: 'OTHER' }, result, 'draft')).toThrow('boshqa mahsulot')
    expect(() => cloneCalculatorRoute(route, template, { width_mm: 0 }, 'draft')).toThrow('Hisoblash')
  })

  it('compares business input while accepting server-stamped width, identity, and dates', () => {
    expect(calculatorTemplateMatches({ ...template, id: 'server-id', code: 'server-code', width_mm: 999, saved_at: '999' }, template)).toBe(true)
    expect(calculatorTemplateMatches({ ...template, kg: 99 }, template)).toBe(false)
    expect(calculatorTemplateMatches({ ...template, source_map_id: 'wrong-route' }, template)).toBe(false)
    expect(calculatorTemplateMatches({ ...template, frame_product_size_mm: 0 }, { ...template, frame_product_size_mm: 1e-12 })).toBe(false)
  })
})

describe('calculator native contracts and capability guards', () => {
  it('requires admin.access OR production.map.manage for reads and every mutation', async () => {
    const fetch = respond(templates())
    expect(calculatorCanManage(actor(['production.map.manage']))).toBe(true)
    expect((await api(['production.map.manage']).templates())).toHaveLength(1)
    const forbidden = api(['production.map.read'])
    await expect(forbidden.templates()).rejects.toMatchObject({ status: 403 })
    await expect(forbidden.saveOrder(order(), order().template)).rejects.toMatchObject({ status: 403 })
    await expect(forbidden.saveTemplate(template, null)).rejects.toMatchObject({ status: 403 })
    await expect(forbidden.deleteTemplate(template, true)).rejects.toMatchObject({ status: 403 })
    await expect(forbidden.openWithRoute(template, template, result, pending())).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('loads owned templates and refuses an inaccessible template identity', async () => {
    const fetch = respond(templates())
    expect((await api().load({ kind: 'template', id: 'template-a', edit: false })).kind).toBe('template')
    await expect(api().load({ kind: 'template', id: 'other', edit: true })).rejects.toMatchObject({ status: 404 })
    expect(url(fetch).pathname).toBe('/v1/mobile/calculate/orders')
  })

  it('sends the raw full revisioned original and trusts fresh server dimensions after save', async () => {
    const baseline = order(), intended = { ...baseline.template, kg: 150 }, updated = orderRaw(3, { kg: 150, width_mm: 215 })
    const fetch = respond(orderRaw(), updated), onWrite = vi.fn()
    const saved = await api(['production.map.manage'], onWrite).saveOrder(baseline, intended)
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT'])
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/admin/production-maps/order-edit')
    expect(url(fetch, 1).searchParams.get('id')).toBe('zakaz-0042')
    expect(body(fetch, 1)).toEqual({ original: baseline.original, template: intended })
    expect(saved).toMatchObject({ kind: 'order', order: { revision: 3 } })
    expect(onWrite).toHaveBeenCalledTimes(1)
  })

  it('rejects changed calculation, map, or revision before PUT and preserves native eligibility errors', async () => {
    const fetch = respond(orderRaw(3))
    await expect(api().saveOrder(order(), { ...order().template, kg: 150 })).rejects.toBeInstanceOf(CalculatorSourceConflict)
    expect(fetch).toHaveBeenCalledTimes(1)
    const reason = 'Buyurtmada ish boshlangan. Tahrirlash bloklandi.'
    respond({ status: 409, payload: { error: reason } })
    const error = await api().order('zakaz-0042').catch(error => error)
    expect(calculatorManagementError(error)).toBe(reason)
    expect(calculatorManagementError(new ApiError(403, 'forbidden'))).toContain('ruxsat')
  })

  it('saves a reusable template with empty new identity and server-assigned identity', async () => {
    const input = { ...template, id: 'old-id', code: 'old-code', kg: 500, order_number: '0042' }
    const saved = { ...input, id: 'template-server', code: 'Z-server', kg: undefined, order_number: '', saved_at: '124' }
    const fetch = respond(templates(), { ok: true, template: saved })
    expect(await api().saveTemplate(input, null)).toMatchObject({ kind: 'template', template: { id: 'template-server', kg: 0 } })
    expect(body(fetch, 1)).toMatchObject({ id: '', code: '', order_number: '', kg: 0 })
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/calculate/orders')
    expect(fetch.mock.calls[1][1]?.method).toBe('POST')
  })

  it('updates only the selected owned template identity after a fresh exact baseline read', async () => {
    const original = parseCalculatorTemplate(template), changed = { ...template, name: 'Tahrirlangan' }
    const fetch = respond(templates(), { ok: true, template: { ...changed, kg: 0, order_number: '' } })
    await api().saveTemplate(changed, original)
    expect(body(fetch, 1)).toMatchObject({ id: original.id, code: original.code, name: 'Tahrirlangan', kg: 0 })
    const staleFetch = respond(templates([{ ...template, saved_at: 'other' }]))
    await expect(api().saveTemplate(changed, original)).rejects.toBeInstanceOf(CalculatorSourceConflict)
    expect(staleFetch).toHaveBeenCalledTimes(1)
  })

  it('requires delete confirmation and uses native POST delete after a fresh baseline check', async () => {
    const fetch = respond(templates(), { ok: true })
    await expect(api().deleteTemplate(template, false)).rejects.toThrow('tasdiqlang')
    expect(fetch).not.toHaveBeenCalled()
    expect(await api().deleteTemplate(parseCalculatorTemplate(template), true)).toEqual({ kind: 'deleted', id: 'template-a' })
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/calculate/orders/delete')
    expect(fetch.mock.calls[1][1]?.method).toBe('POST')
    expect(body(fetch, 1)).toEqual({ id: 'template-a' })
  })

  it('releases pending orders through with-order with their reserved identity and a cloned saved route', async () => {
    const source = pending(), fetch = respond(templates(), pendingRaw(), { map: route, program: {} }, { ok: true, ...completed() })
    const saved = await api().openWithRoute(parseCalculatorTemplate(template), source.template, result, source)
    expect(saved).toMatchObject({ kind: 'opened', saved: { map: { id: 'zakaz-9011', order_number: '9011' } } })
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'GET', 'GET', 'PUT'])
    expect(url(fetch, 3).pathname).toBe('/v1/mobile/admin/production-maps/with-order')
    expect(body(fetch, 3)).toMatchObject({ pending_order_id: 'zakaz-9011', template: { id: 'pending-template', code: 'TG-9011', order_number: '9011' }, map: { id: 'zakaz-9011', code: '', order_number: '', base_length: 2468 } })
    expect(fetch.mock.calls.every(call => !String(call[0]).includes('auto-open'))).toBe(true)
  })

  it('uses native existing completion without writing a second pending order', async () => {
    const fetch = respond(templates(), pendingRaw(completed()))
    expect(await api().openWithRoute(parseCalculatorTemplate(template), pending().template, result, pending())).toMatchObject({ kind: 'opened' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true)
  })

  it('blocks changed pending intake and stale or incompatible routes before any write', async () => {
    let fetch = respond(templates(), pendingRaw(null, { kg: 999 }))
    await expect(api().openWithRoute(parseCalculatorTemplate(template), pending().template, result, pending())).rejects.toBeInstanceOf(CalculatorSourceConflict)
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch = respond(templates([{ ...template, note: 'changed' }]))
    await expect(api().openWithRoute(parseCalculatorTemplate(template), template, result)).rejects.toBeInstanceOf(CalculatorSourceConflict)
    expect(fetch).toHaveBeenCalledTimes(1)
    respond(templates())
    await expect(api().openWithRoute(parseCalculatorTemplate(template), { ...template, status: 'paket' }, result)).rejects.toThrow('mos xarita')
  })

  it('opens template routes with a new draft identity and empty old order identity', async () => {
    const opened = { ok: true, saved: { map: { ...route, id: 'zakaz-0043', code: '0043', order_number: '0043' }, program: {} }, template: null }
    const fetch = respond(templates(), { map: route, program: {} }, opened)
    await api().openWithRoute(parseCalculatorTemplate(template), { ...template, kg: 200 }, result)
    const sent = body(fetch, 2)
    expect(sent).not.toHaveProperty('pending_order_id')
    expect(sent.template).toMatchObject({ id: '', code: '', order_number: '', source_map_id: 'template-map-a' })
    expect((sent.map as Row).id).toMatch(/^zakaz-draft-/)
    expect((sent.map as Row).id).not.toBe(route.id)
  })
})

describe('uncertain save recovery and retained interruption safety', () => {
  it('recovers revisioned order writes through GET without a second PUT', async () => {
    const intended = { ...order().template, kg: 150 }, fetch = respond(orderRaw(), new TypeError('Lost response'), orderRaw(3, { kg: 150 }))
    expect(await api().saveOrder(order(), intended)).toMatchObject({ kind: 'order', recovered: true })
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET'])
  })

  it('never confirms an unchanged revision or a different server input after uncertain order writes', async () => {
    const fetch = respond(orderRaw(), { status: 500, payload: { error: 'store_failed' } }, orderRaw(2, { kg: 150 }))
    await expect(api().saveOrder(order(), { ...order().template, kg: 150 })).rejects.toBeInstanceOf(CalculatorSaveUnknown)
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1)
  })

  it('recovers pending release from its native completion and never retries the write', async () => {
    const fetch = respond(templates(), pendingRaw(), { map: route, program: {} }, new TypeError('Lost response'), pendingRaw(completed()))
    expect(await api().openWithRoute(parseCalculatorTemplate(template), pending().template, result, pending())).toMatchObject({ kind: 'opened', recovered: true })
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'GET', 'GET', 'PUT', 'GET'])
  })

  it('recovers template creation only when exactly one new owned template matches the intent', async () => {
    const input = { ...template, name: 'Nusxa', kg: 0, order_number: '' }, created = { ...input, id: 'template-created', code: 'Z-new', saved_at: '124' }
    const fetch = respond(templates(), new TypeError('Lost response'), templates([template, created]))
    expect(await api().saveTemplate(input, null)).toMatchObject({ kind: 'template', recovered: true, template: { id: 'template-created' } })
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'POST', 'GET'])
    const ambiguous = respond(templates(), new TypeError('Lost response'), templates([template, created, { ...created, id: 'also-new' }]))
    await expect(api().saveTemplate(input, null)).rejects.toBeInstanceOf(CalculatorSaveUnknown)
    expect(ambiguous.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
  })

  it('recovers delete by reading absence and keeps rejected writes as business errors', async () => {
    const fetch = respond(templates(), new TypeError('Lost response'), templates([]))
    expect(await api().deleteTemplate(parseCalculatorTemplate(template), true)).toEqual({ kind: 'deleted', id: 'template-a', recovered: true })
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'POST', 'GET'])
    const rejected = respond(templates(), { status: 403, payload: { error: 'forbidden' } })
    await expect(api().deleteTemplate(parseCalculatorTemplate(template), true)).rejects.toMatchObject({ status: 403 })
    expect(rejected).toHaveBeenCalledTimes(2)
  })

  it('freezes a template-route open with an uncertain outcome instead of guessing an order or replaying', async () => {
    const fetch = respond(templates(), { map: route, program: {} }, new TypeError('Lost response'))
    let failure: unknown
    try { await api().openWithRoute(parseCalculatorTemplate(template), template, result) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(CalculatorSaveUnknown)
    expect((failure as CalculatorSaveUnknown).operation.kind).toBe('template-open')
    await expect(api().recover((failure as CalculatorSaveUnknown).operation)).rejects.toBeInstanceOf(CalculatorSaveUnknown)
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'GET', 'PUT'])
  })

  it('retains separate managed drafts and baseline across navigation and rejects foreign-session reads and writes', () => {
    const memory = new CalculatorMemory(), mode = { kind: 'order' as const, id: 'zakaz-0042' }, key = calculatorMemoryKey(mode)
    memory.activate('actor-a')
    memory.patch('actor-a', key, { source: orderSource(), draft: { ...draftFromCalculatorTemplate(template, true), kg: '175' } })
    expect(memory.read('actor-a', key)?.draft?.kg).toBe('175')
    expect(memory.read('actor-a', calculatorMemoryKey({ kind: 'template', id: 'template-a', edit: false }))?.draft).toBeNull()
    expect(memory.read('actor-a', key)?.source?.kind).toBe('order')
    memory.activate('actor-b')
    expect(memory.read('actor-a', key)).toBeNull()
    expect(memory.patch('actor-a', key, { draft: newOrderDraft() })).toBe(false)
    expect(memory.read('actor-b', key)?.draft).toBeNull()
  })

  it('retains sent operation uncertainty across draft resets and dialog dismissal until explicitly reconciled', () => {
    const memory = new CalculatorMemory(), key = calculatorMemoryKey({ kind: 'template', id: 'template-a', edit: false }), operation: CalculatorOperation = { kind: 'template-open', template }
    memory.activate('actor-a'); memory.markSent('actor-a', key, operation)
    memory.resetDraft('actor-a', key)
    expect(memory.read('actor-a', key)?.operation).toEqual(operation)
    expect(memory.read('actor-a', key)?.error).toBeInstanceOf(CalculatorSaveUnknown)
    const listener = vi.fn(), cancel = memory.subscribe('actor-a', key, listener)
    memory.patch('actor-a', key, { error: null, operation: null })
    expect(listener).toHaveBeenCalledTimes(1)
    cancel(); memory.patch('actor-a', key, { uncertain: true }); expect(listener).toHaveBeenCalledTimes(1)
  })

  it('cancels before a write when identity changes during the precheck and records no sent operation', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise<Response>(resolve => { finish = resolve })), onWrite = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const mutations = new MutationScope(), lease = mutations.begin(), work = api(['admin.access'], onWrite).saveOrder(order(), { ...order().template, kg: 150 }, lease.controller.signal)
    mutations.cancelAll(); finish(new Response(JSON.stringify(orderRaw()), { status: 200 }))
    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onWrite).not.toHaveBeenCalled()
  })

  it('records an interrupted sent write for read-only recovery without publishing late success', async () => {
    const memory = new CalculatorMemory(), key = 'order:zakaz-0042:use'; memory.activate('actor-a')
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => new Response(JSON.stringify(orderRaw()), { status: 200 })).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetch)
    const mutations = new MutationScope(), lease = mutations.begin(), work = api(['admin.access'], operation => memory.markSent('actor-a', key, operation)).saveOrder(order(), { ...order().template, kg: 150 }, lease.controller.signal)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    mutations.cancelAll(); finish(new Response(JSON.stringify(orderRaw(3, { kg: 150 })), { status: 200 }))
    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    expect(memory.read('actor-a', key)?.error).toBeInstanceOf(CalculatorSaveUnknown)
    const operation = memory.read('actor-a', key)!.operation!
    const recoveredFetch = respond(orderRaw(3, { kg: 150 }))
    expect(await api().recover(operation)).toMatchObject({ kind: 'order', recovered: true })
    expect(recoveredFetch.mock.calls[0][1]?.method).toBe('GET')
  })

  it('does not let old in-flight operation registration repopulate a newer session', () => {
    const memory = new CalculatorMemory(); memory.activate('actor-a'); memory.activate('actor-b')
    expect(() => memory.markSent('actor-a', 'old', { kind: 'template-open', template })).toThrowError(expect.objectContaining({ name: 'AbortError' }))
    expect(memory.read('actor-b', 'old')?.operation).toBeNull()
    expect(calculatorFingerprint({ a: 1, b: 2 })).toBe(calculatorFingerprint({ b: 2, a: 1 }))
  })

  it('retains a direct automatic-open attempt when navigation interrupts its late committed response', async () => {
    const memory = new CalculatorMemory(), key = calculatorMemoryKey({ kind: 'new' }); memory.activate('actor-a')
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetch)
    const mutations = new MutationScope(), lease = mutations.begin()
    const service = api(['admin.access'], operation => memory.markSent('actor-a', key, operation))
    const opening = service.automaticOpen({ ...template, id: '', code: '', order_number: '', source_map_id: '' }, lease.controller.signal)
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe('/v1/mobile/admin/production-maps/auto-open')
    expect(memory.read('actor-a', key)?.operation?.kind).toBe('automatic-open')
    mutations.cancelAll()
    finish(new Response(JSON.stringify({ ok: true, saved: { map: { ...route, id: 'zakaz-0043', code: '0043', order_number: '0043' }, program: {} }, template: { ...template, order_number: '0043' } }), { status: 200 }))
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(memory.read('actor-a', key)?.error).toBeInstanceOf(CalculatorSaveUnknown)
    const retainedOperation = memory.read('actor-a', key)!.operation!
    await expect(service.recover(retainedOperation)).rejects.toBeInstanceOf(CalculatorSaveUnknown)
    await expect(service.automaticOpen(template)).rejects.toBeInstanceOf(CalculatorSaveUnknown)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.method).toBe('POST')
    expect(mutations.isCurrent(lease)).toBe(false)
  })

  it('does not dispatch or record an automatic open after scope cancellation', async () => {
    const fetch = respond({}), onWrite = vi.fn(), controller = new AbortController(); controller.abort()
    await expect(api(['admin.access'], onWrite).automaticOpen(template, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    expect(onWrite).not.toHaveBeenCalled()
  })
})
