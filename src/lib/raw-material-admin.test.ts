import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Row, Session } from './api-types'
import {
  RAW_MATERIAL_API_LIMITATIONS, parseRawMaterialAssignment, parseRawMaterialDiagnostic, parseRawMaterialLookup,
  parseRawMaterialStock, rawMaterialAssignmentIssue, rawMaterialAssignments, rawMaterialCandidateOrders,
  rawMaterialCandidates, rawMaterialHistory, rawMaterialMutation, rawMaterialOrderId, rawMaterialPermissions,
  rawMaterialStockId, rawMaterialStockMatches, rawMaterialUnlinkIssue, reconcileRawMaterialMutation,
} from './raw-material-admin'
import type { RawMaterialAssignment, RawMaterialDiagnostic, RawMaterialLookup, RawMaterialOrderCandidate, RawMaterialStock, RawMaterialWrite } from './raw-material-admin'

const client = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-fixture' })
const barcode = 'roll/001 & X'
const stock: RawMaterialStock = { id: 'stock-actual', barcode, warehouse: 'Raw / 1', item_code: 'PET/100/12', item_name: 'PET', qty: 75, uom: 'kg', status: 'available', reserved_order_id: '', width_mm: 100, micron: 12 }
const assignment: RawMaterialAssignment = {
  order_id: 'zakaz-1', barcode, apparatus_id: 'app-print-1', apparatus: 'Display name, never identity', item_code: stock.item_code, item_name: 'PET', item_group: 'Rulon',
  assigned_at: '2026-10-13T10:00:00Z', assigned_by_display_name: 'Operator', stock_status: 'available', execution_status: 'awaiting_delivery', stock_warehouse: stock.warehouse,
  reserved_order_id: '', stock_qty: 75, stock_uom: 'kg', received_qty: 0, consumed_qty: 0, remaining_qty: 75,
}
const orderCandidate: RawMaterialOrderCandidate = { order: { map: { id: 'zakaz-1', title: 'Buyurtma', width_mm: 100 }, program: {} }, apparatus_options: ['app-print-1'] }
const diagnostic: RawMaterialDiagnostic = { barcode, compatible: true, reason: 'compatible', warehouse: stock.warehouse, item_code: stock.item_code, stock_status: 'available', reserved_order_id: '', order_id: 'zakaz-1', apparatus: 'app-print-1', apparatus_options: ['app-print-1'], order_width_mm: 100, roll_width_mm: 100, minimum_width_mm: 90, maximum_width_mm: 130 }
const session = (capabilities = ['admin.access', 'raw_material.assign']): Session => ({ token: 'fixture', profile: { role: 'admin', display_name: 'Fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const write = (action: 'assign' | 'unlink' = 'assign'): RawMaterialWrite => ({ action, stock: { ...stock }, orderId: 'zakaz-1', apparatusId: 'app-print-1', ...(action === 'unlink' ? { assignment: { ...assignment } } : {}) })
const lookup = (linked: RawMaterialAssignment | null = null, values: Row = {}): RawMaterialLookup => ({ ...stock, source_receipt_id: 'receipt-1', assignment: linked, order: linked ? { map: { id: linked.order_id, title: 'Buyurtma' }, program: {} } : null, queue_states: {}, logs: [], ...values })

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status })
}

/** Local responses only; records every request so unsupported writes cannot slip in. */
function server(options: {
  linked?: RawMaterialAssignment | null
  currentStock?: RawMaterialStock
  candidates?: RawMaterialOrderCandidate[]
  diagnostic?: RawMaterialDiagnostic
  mutationResult?: unknown
  status?: number
  afterWrite?: RawMaterialAssignment | null
  failReadback?: boolean
  failWrite?: boolean
} = {}) {
  let linked = options.linked ?? null
  let written = false
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/raw-material-stock')) return response([options.currentStock ?? stock])
    if (url.pathname.endsWith('/candidate-orders')) return response(options.candidates ?? [orderCandidate])
    if (url.pathname.endsWith('/diagnostics')) return response(options.diagnostic ?? diagnostic)
    if (url.pathname.endsWith('/lookup')) {
      if (written && options.failReadback) return response({ error: 'server_unavailable' }, 503)
      return response(lookup(linked))
    }
    if (url.pathname.endsWith('/raw-material-assignments') && ['POST', 'DELETE'].includes(init.method ?? '')) {
      written = true
      if (options.failWrite) throw new TypeError('Fixture network lost')
      linked = Object.hasOwn(options, 'afterWrite') ? options.afterWrite ?? null : init.method === 'POST' ? assignment : null
      return response(Object.hasOwn(options, 'mutationResult') ? options.mutationResult : init.method === 'POST' ? assignment : { ok: true, assignment }, options.status)
    }
    throw new Error(`Unexpected fixture URL ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('raw material policy and canonical identity', () => {
  it('uses endpoint capabilities without treating admin or a role title as assignment permission', () => {
    expect(rawMaterialPermissions(session(['admin.access']))).toMatchObject({ lookup: true, candidates: true, history: true, assign: false })
    expect(rawMaterialPermissions(session(['catalog.item.read']))).toMatchObject({ stock: true, history: true, lookup: false, candidates: false, assign: false })
    expect(rawMaterialPermissions(session(['apparatus.queue.manage']))).toMatchObject({ lookup: true, candidates: false, history: false, assign: false })
    expect(rawMaterialPermissions(session(['raw_material.assign']))).toMatchObject({ stock: true, lookup: true, candidates: true, assign: true })
    expect(rawMaterialPermissions(null).assign).toBe(false)
  })

  it('retains stock id plus barcode, warehouse, item and unit instead of selecting by product', () => {
    expect(rawMaterialStockId(stock)).toBe('stock-actual')
    expect(rawMaterialStockId({ stock_id: 'warehouse-roll-id' })).toBe('warehouse-roll-id')
    expect(rawMaterialOrderId(orderCandidate.order)).toBe('zakaz-1')
    expect(rawMaterialStockMatches(stock, { ...stock, barcode: barcode.toUpperCase() })).toBe(true)
    for (const changed of [{ id: 'other-stock' }, { barcode: 'other-roll' }, { warehouse: 'other-warehouse' }, { item_code: 'other-item' }, { uom: 'm' }]) expect(rawMaterialStockMatches(stock, { ...stock, ...changed })).toBe(false)
    expect(rawMaterialStockMatches({ ...stock, stock_id: 'different-stock' }, stock)).toBe(false)
  })

  it('rejects malformed stock, false envelopes, missing canonical apparatus and mismatched lookup identity', () => {
    expect(parseRawMaterialStock(stock)).toMatchObject({ id: stock.id, width_mm: 100, micron: 12 })
    for (const value of [{ ...stock, id: '' }, { ...stock, qty: '75' }, { ...stock, micron: -1 }, { ...stock, stock_id: 'other' }]) expect(() => parseRawMaterialStock(value)).toThrow()
    expect(() => parseRawMaterialAssignment({ ...assignment, apparatus_id: '', apparatus: 'app-print-1' })).toThrow()
    expect(() => parseRawMaterialAssignment({ ok: true })).toThrow()
    expect(() => parseRawMaterialLookup({ ...lookup(), barcode: 'different' }, barcode)).toThrow()
    expect(() => parseRawMaterialLookup({ ...lookup(assignment), order: null }, barcode)).toThrow()
    expect(() => parseRawMaterialLookup({ ...lookup(), assignment: undefined }, barcode)).toThrow()
    expect(() => parseRawMaterialDiagnostic({ ...diagnostic, compatible: 'true' }, barcode)).toThrow()
  })

  it('requires a matching candidate, current stock, exact order/apparatus diagnostic and available unreserved stock', () => {
    expect(rawMaterialAssignmentIssue(stock, lookup(), orderCandidate, 'app-print-1', diagnostic)).toBe('')
    expect(rawMaterialAssignmentIssue(stock, lookup(assignment), orderCandidate, 'app-print-1', diagnostic)).toContain('allaqachon')
    for (const changed of [{ status: 'in_use' }, { status: 'consumed' }, { reserved_order_id: 'zakaz-2' }, { qty: 0 }]) expect(rawMaterialAssignmentIssue({ ...stock, ...changed }, lookup(), orderCandidate, 'app-print-1', diagnostic)).not.toBe('')
    expect(rawMaterialAssignmentIssue(stock, lookup(), undefined, 'app-print-1', diagnostic)).not.toBe('')
    expect(rawMaterialAssignmentIssue(stock, lookup(), orderCandidate, 'display-name', diagnostic)).not.toBe('')
    for (const changed of [{ barcode: 'other' }, { order_id: 'zakaz-2' }, { apparatus: 'app-other' }, { warehouse: 'other' }, { compatible: false }, { reason: 'raw_material_roll_size_mismatch' }, { reserved_order_id: 'zakaz-2' }]) expect(rawMaterialAssignmentIssue(stock, lookup(), orderCandidate, 'app-print-1', { ...diagnostic, ...changed })).not.toBe('')
  })

  it('honors server width bounds inclusively and preserves micron without inventing a layer/micron allocation', () => {
    for (const width of [90, 130]) expect(rawMaterialAssignmentIssue({ ...stock, width_mm: width }, lookup(), orderCandidate, 'app-print-1', { ...diagnostic, roll_width_mm: width })).toBe('')
    for (const width of [89.9, 130.1]) expect(rawMaterialAssignmentIssue({ ...stock, width_mm: width }, lookup(), orderCandidate, 'app-print-1', { ...diagnostic, roll_width_mm: width })).not.toBe('')
    expect(rawMaterialAssignmentIssue(stock, lookup(), orderCandidate, 'app-print-1', { ...diagnostic, roll_width_mm: 120 })).not.toBe('')
    expect(RAW_MATERIAL_API_LIMITATIONS.join(' ')).toContain('no purchase allocation or layer_index write')
    expect(RAW_MATERIAL_API_LIMITATIONS.join(' ')).toContain('no separate micron compatibility contract')
  })

  it('blocks unlink for in-use, consumed, reserved, unknown stock and a newer same-order assignment', () => {
    expect(rawMaterialUnlinkIssue(assignment, lookup(assignment))).toBe('')
    for (const status of ['in_use', 'consumed', 'unknown', '']) expect(rawMaterialUnlinkIssue({ ...assignment, stock_status: status }, lookup({ ...assignment, stock_status: status }, { status }))).not.toBe('')
    expect(rawMaterialUnlinkIssue(assignment, lookup(assignment, { reserved_order_id: 'zakaz-1' }))).not.toBe('')
    expect(rawMaterialUnlinkIssue({ ...assignment, consumed_qty: 2 }, lookup(assignment))).not.toBe('')
    expect(rawMaterialUnlinkIssue(assignment, lookup({ ...assignment, assigned_at: '2026-10-13T11:00:00Z' }))).toContain('o‘zgargan')
    expect(rawMaterialUnlinkIssue(assignment, lookup(null))).not.toBe('')
    expect(rawMaterialUnlinkIssue({ ...assignment, execution_status: 'unknown' }, lookup(assignment))).not.toBe('')
  })
})

describe('native assignment write contracts and reconciliation', () => {
  it('preflights exact stock and eligibility, posts only supported identity fields, and confirms by lookup', async () => {
    const fetch = server()
    const result = await rawMaterialMutation(client, session(), write())
    expect(result.assignment).toMatchObject({ order_id: 'zakaz-1', apparatus_id: 'app-print-1', execution_status: 'awaiting_delivery' })
    const mutationCalls = fetch.mock.calls.filter(([, init]) => init.method === 'POST')
    expect(mutationCalls).toHaveLength(1)
    expect(new URL(String(mutationCalls[0][0])).pathname).toBe('/v1/mobile/admin/raw-material-assignments')
    expect(JSON.parse(mutationCalls[0][1].body as string)).toEqual({ order_id: 'zakaz-1', barcode, apparatus: 'app-print-1' })
    const stockUrl = new URL(String(fetch.mock.calls.find(([url]) => String(url).includes('/raw-material-stock'))![0]))
    expect(stockUrl.searchParams.get('warehouse')).toBe(stock.warehouse)
    expect(stockUrl.searchParams.get('limit')).toBe('500')
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/lookup'))).toHaveLength(2)
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('barcode')).toBe(barcode)
  })

  it('deletes with a JSON body, checks ok and removed identity, and confirms actual absence', async () => {
    const fetch = server({ linked: assignment })
    expect((await rawMaterialMutation(client, session(), write('unlink'))).assignment).toBe(null)
    const calls = fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ order_id: 'zakaz-1', barcode })
    expect(String(calls[0][0])).not.toContain('order_id=')
  })

  it('rejects missing assignment permission before any request', async () => {
    const fetch = server()
    await expect(rawMaterialMutation(client, session(['admin.access']), write())).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not send a write for stale stock id, unavailable stock, foreign assignment or rejected diagnostic', async () => {
    const cases = [
      { currentStock: { ...stock, id: 'replaced-stock' } },
      { currentStock: { ...stock, status: 'in_use' } },
      { linked: { ...assignment, order_id: 'zakaz-2' } },
      { diagnostic: { ...diagnostic, compatible: false, reason: 'raw_material_roll_size_mismatch' } },
      { candidates: [] },
    ]
    for (const value of cases) {
      const fetch = server(value)
      await expect(rawMaterialMutation(client, session(), write())).rejects.toMatchObject({ uncertain: false })
      expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
    }
  })

  it('rejects a stale unlink even after a new same-order assignment replaced it', async () => {
    const fetch = server({ linked: { ...assignment, assigned_at: '2026-10-13T11:00:00Z' } })
    await expect(rawMaterialMutation(client, session(), write('unlink'))).rejects.toMatchObject({ uncertain: false })
    expect(fetch.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
  })

  it('never treats HTTP 200 as success without the selected assignment identity and actual status', async () => {
    const replies = [
      { ok: true }, { ...assignment, order_id: 'zakaz-2' }, { ...assignment, barcode: 'other' },
      { ...assignment, apparatus_id: 'Display name' }, { ...assignment, stock_status: '' },
      { ...assignment, execution_status: 'future-state' }, { ...assignment, execution_status: 'in_use' },
      { ...assignment, stock_qty: -10 },
    ]
    for (const mutationResult of replies) {
      server({ mutationResult })
      await expect(rawMaterialMutation(client, session(), write())).rejects.toMatchObject({ uncertain: true })
    }
  })

  it('does not accept HTTP 200 false unlink or deletion of a different assignment', async () => {
    for (const mutationResult of [{ ok: false, assignment }, { ok: true }, { ok: true, assignment: { ...assignment, order_id: 'zakaz-2' } }]) {
      server({ linked: assignment, mutationResult })
      await expect(rawMaterialMutation(client, session(), write('unlink'))).rejects.toMatchObject({ uncertain: true })
    }
  })

  it('requires readback even when a mutation response itself looks valid', async () => {
    server({ afterWrite: null })
    await expect(rawMaterialMutation(client, session(), write())).rejects.toMatchObject({ uncertain: true })
    server({ linked: assignment, afterWrite: assignment })
    await expect(rawMaterialMutation(client, session(), write('unlink'))).rejects.toMatchObject({ uncertain: true })
    server({ failReadback: true })
    await expect(rawMaterialMutation(client, session(), write())).rejects.toMatchObject({ uncertain: true })
  })

  it('does not retry a network-lost write; it keeps an uncertain result for explicit readback', async () => {
    const fetch = server({ failWrite: true })
    await expect(rawMaterialMutation(client, session(), write())).rejects.toMatchObject({ uncertain: true })
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it('keeps deterministic stock locks recoverable rather than claiming success', async () => {
    const fetch = server({ linked: assignment, status: 400, mutationResult: { error: 'raw_material_assignment_locked' }, afterWrite: assignment })
    await expect(rawMaterialMutation(client, session(), write('unlink'))).rejects.toMatchObject({ uncertain: false, message: expect.stringContaining('uzib') })
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1)
  })

  it('reconciles exact assignment, actual absence, conflicts and unchanged unlink without sending a mutation', async () => {
    let fetch = server({ linked: assignment })
    expect((await reconcileRawMaterialMutation(client, write())).state).toBe('confirmed')
    expect((await reconcileRawMaterialMutation(client, write('unlink'))).state).toBe('not-applied')
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
    fetch = server({ linked: null })
    expect((await reconcileRawMaterialMutation(client, write())).state).toBe('not-applied')
    expect((await reconcileRawMaterialMutation(client, write('unlink'))).state).toBe('confirmed')
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
    server({ linked: { ...assignment, order_id: 'zakaz-2' } })
    expect((await reconcileRawMaterialMutation(client, write())).state).toBe('changed')
    server({ linked: { ...assignment, assigned_at: '2026-10-13T11:00:00Z' } })
    expect((await reconcileRawMaterialMutation(client, write('unlink'))).state).toBe('changed')
  })

  it('respects cancellation before writing and publishes no successful old-session result', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = server()
    await expect(rawMaterialMutation(client, session(), write(), controller.signal)).rejects.toMatchObject({ uncertain: false })
    expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
  })

  it('marks a cancelled in-flight write uncertain and never returns success from its late response', async () => {
    const controller = new AbortController()
    const fetch = server()
    const respond = fetch.getMockImplementation()!
    fetch.mockImplementation(async (url, init) => {
      const result = await respond(url, init)
      if (init.method === 'POST') controller.abort()
      return result
    })
    await expect(rawMaterialMutation(client, session(), write(), controller.signal)).rejects.toMatchObject({ uncertain: true })
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/lookup'))).toHaveLength(1)
  })

  it('does not reconcile an assignment belonging to a replacement stock id as the original write', async () => {
    server({ linked: assignment, currentStock: { ...stock, id: 'replacement' } })
    expect((await reconcileRawMaterialMutation(client, write())).state).toBe('changed')
  })
})

describe('bounded native reads', () => {
  it('uses real order assignment/candidate paths and rejects a response from another order', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([assignment])).mockResolvedValueOnce(response([{ ...stock, apparatus_options: ['app-print-1'] }])).mockResolvedValueOnce(response([orderCandidate])).mockResolvedValueOnce(response([{ ...assignment, order_id: 'zakaz-2' }]))
    vi.stubGlobal('fetch', fetch)
    expect(await rawMaterialAssignments(client, 'zakaz-1')).toHaveLength(1)
    expect(await rawMaterialCandidates(client, 'zakaz-1')).toHaveLength(1)
    expect(await rawMaterialCandidateOrders(client, barcode)).toHaveLength(1)
    expect(new URL(String(fetch.mock.calls[1][0])).pathname).toBe('/v1/mobile/admin/raw-material-assignments/candidates')
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('order_id')).toBe('zakaz-1')
    await expect(rawMaterialAssignments(client, 'zakaz-1')).rejects.toBeInstanceOf(ApiError)
  })

  it('filters only selected-barcode history from the capped warehouse feed without inventing pagination', async () => {
    const event = { event_id: 'evt-1', event_type: 'unassigned', barcode: barcode.toUpperCase(), qty_delta: 0, occurred_at_unix: 1791885600 }
    const fetch = vi.fn().mockResolvedValue(response([event, { ...event, event_id: 'evt-other', barcode: 'other-roll' }]))
    vi.stubGlobal('fetch', fetch)
    expect(await rawMaterialHistory(client, stock.warehouse, barcode)).toEqual([event])
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(url.pathname).toBe('/v1/mobile/admin/raw-material-history')
    expect(Object.fromEntries(url.searchParams)).toEqual({ warehouse: stock.warehouse, limit: '200' })
  })
})
