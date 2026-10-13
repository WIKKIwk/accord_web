import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Row, Session } from './api-types'
import {
  PASSPORT_API_LIMITATIONS, PassportConflict, PassportDraftLedger, PassportPrintFailure, PassportUnknown,
  ProgressPassportApi, parseOpeningPassport, parsePassportBatch, parseProgressPassport,
  passportCorrectionIssue, passportCorrectionOperation, passportForm, passportPermissions,
  passportPrintIssue, passportPrintOperation, progressPassportIdentity,
} from './progress-passport'
import type { PassportBatch, PassportIdentity, PassportOperation, PassportPrintForm, ProgressPassport } from './progress-passport'

const base = '/v1/mobile/admin/production-maps', batchId = 'progress-roll-001', orderId = 'order:001', apparatus = 'apparatus:default:asset-001', qr = 'progress:roll-001'
const actor = (capabilities = ['admin.access'], role = 'admin', ref = 'worker:001'): Session => ({ token: 'fixture-only', profile: { role, ref, display_name: 'Fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const service = (session = actor(), onUnauthorized?: () => void) => new ProgressPassportApi(new ApiClient({ endpoint: 'https://erp.example.test', token: session.token, onUnauthorized }), session)
const identity: PassportIdentity = { kind: 'wip', batchId, orderId, qr }
export function fixturePassportBatch(changes: Row = {}): PassportBatch {
  return parsePassportBatch({ batch_id: batchId, revision: 2, order_id: orderId, qr_payload: qr, apparatus, session_id: 'session:001', started_at_unix: 1790000000, completed_at_unix: 1790000100, worker_ref: 'worker:001', worker_role: 'aparatchi', worker_display_name: 'Worker', executor_name: 'Worker', label_item_code: 'PRODUCT', label_item_name: 'Saved product', produced_qty: 100, uom: 'm', status: 'completed', action: 'roll_complete', wip_status: 'waiting', status_detail: { work_status: 'completed', wip_status: 'waiting', flow_status: 'waiting_next_stage' }, next_apparatus: 'apparatus:default:asset-002', current_location: 'Native location', finished_goods_meter: 100, finished_goods_kg: 25, bobina_kg: 1, total_waste: 2, description: 'Initial', payload_json: { gross_qty: 27, stage_node_id: 'print', lineage_fact: 'retain', start_resources: { native: true } }, ...changes })
}
export function fixturePassportReport(batch = fixturePassportBatch(), changes: Row = {}): Row {
  return { ok: true, scanned_batch: batch, current_batch: batch, current_batches: [batch], progress_batches: [batch], history_scope: 'batch_lineage', lineage_complete: true, lineage_edges: [], session_resources: [], is_stale: false, stale_reason: '', order: { id: batch.order_id }, order_status: { lifecycle_status: 'released', order_status: 'not_started' }, queue_states: {}, logs: [], corrections: [], run_sessions: [], active_sessions: [], opened_by: null, ...changes }
}
function passport(batch = fixturePassportBatch()): ProgressPassport { return { ...parseProgressPassport(fixturePassportReport(batch), identity), ownership: 'direct' } }
const openingIdentity: PassportIdentity = { kind: 'opening-wip', batchId: 'opening-roll-001', orderId, qr: 'opening-qr-001' }
export function fixtureOpeningPassport(): Row {
  return { ok: true, record: { intake: { intake_id: 'intake:001', idempotency_key: 'opening-key', order_id: orderId, entry_apparatus: apparatus, source_apparatus: apparatus, source_operation: 'print', resume_stage_node_id: 'print', current_location: '', resume_apparatus: '', history_status: 'external', status: 'confirmed', actor: { role: 'admin', ref: 'worker:001', display_name: 'Fixture' }, created_at_unix: 1790000000, updated_at_unix: 1790000000 }, batches: [{ batch_id: openingIdentity.batchId, intake_id: 'intake:001', order_id: orderId, sequence_no: 1, qr_payload: openingIdentity.qr, quantity_basis: 'measured', quantity: 100, uom: 'm', finished_goods_meter: 100, finished_goods_kg: 25, bobina_kg: 1, wip_status: 'waiting', label_item_code: 'PRODUCT', label_item_name: 'Saved opening product', created_at_unix: 1790000000, updated_at_unix: 1790000000 }] } }
}
const printForm = (changes: Partial<PassportPrintForm> = {}): PassportPrintForm => ({ transport: 'offline', printer: 'godex', mode: 'label', count: '1', driverUrl: '', ...changes })
function correction(current = passport(), fields: Row = {}) { return passportCorrectionOperation(current, actor(), { ...passportForm(current.batch), description: 'Updated description', reason: 'Measured correction', ...fields }) }
function nativeCorrect(operation: Extract<PassportOperation, { kind: 'correct' }>, batch = operation.baseline.batch): PassportBatch {
  const fields: Row = { ...operation.body }; delete fields.batch_id; delete fields.expected_revision; delete fields.reason
  const payload: Row = { ...batch.payload_json, ...fields, correction_revision: batch.revision + 1 }
  if (fields.finished_goods_kg !== (batch.finished_goods_kg ?? null)) payload.gross_qty = fields.finished_goods_kg
  const result: Row = { ...batch, ...fields, revision: batch.revision + 1, payload_json: payload }
  for (const [key, value] of Object.entries(result)) if (value === null) delete result[key]
  return parsePassportBatch(result)
}
function audit(operation: Extract<PassportOperation, { kind: 'correct' }>, after = nativeCorrect(operation)): Row { return { batch_id: batchId, previous_revision: operation.body.expected_revision, new_revision: operation.body.expected_revision + 1, reason: operation.body.reason, actor: { role: 'admin', ref: 'worker:001', display_name: 'Fixture' }, old_values: operation.baseline.batch, new_values: after, created_at_unix: 1790000101 } }
function printReceipt(body: Row, current: ReturnType<typeof passport> | ReturnType<typeof parseOpeningPassport>): Row {
  const batch = current.batch, gross = current.kind === 'wip' ? current.batch.payload_json.gross_qty ?? batch.finished_goods_kg ?? batch.produced_qty : batch.finished_goods_kg, progress = batch.finished_goods_meter ?? (current.kind === 'wip' ? batch.produced_qty : gross)
  return { ok: true, batch, print: { ok: true, status: body.print_transport === 'offline' ? 'prepared' : 'printed', qr_payload: current.identity.qr, item_code: batch.label_item_code, item_name: 'Native current label name', apparatus: current.kind === 'wip' ? batch.apparatus : current.intake.source_apparatus || current.intake.entry_apparatus, apparatus_display_name: 'Native display', customer_name: 'Customer', executor_name: 'Worker', qty: progress, gross_qty: gross, tare_enabled: true, tare_kg: batch.bobina_kg, unit: 'kg', progress_unit: batch.uom || 'm', label_kind: 'progress', printer: body.printer, print_mode: body.print_mode, print_count: body.print_count, printer_status: body.print_transport === 'offline' ? 'client_usb_pending' : 'Printer OK' } }
}
type Hook = (path: string, method: string, body: Row | undefined, request: RequestInit | undefined) => unknown | Promise<unknown>
function mockApi(current: Row | (() => Row) = fixturePassportReport(), hook?: Hook) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, request) => {
    const url = new URL(String(input)), method = request?.method ?? 'GET', body = typeof request?.body === 'string' ? JSON.parse(request.body) as Row : undefined
    let payload = await hook?.(url.pathname, method, body, request)
    if (payload instanceof Response) return payload
    if (payload === undefined) {
      if (url.pathname.endsWith('/progress-qr/report') && method === 'POST') payload = typeof current === 'function' ? current() : current
      else if (url.pathname.endsWith('/progress-qr/history') && method === 'GET') payload = { ok: true, batches: [] }
      else if (url.pathname.endsWith('/opening-wip/qr-report') && method === 'POST') payload = fixtureOpeningPassport()
      else throw new Error(`Unexpected fixture endpoint: ${method} ${url.pathname}`)
    }
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch); return fetch
}
const mutations = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.filter(call => /\/(correct|reprint|print)$/.test(new URL(String(call[0])).pathname))
const failure = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native identity, principal and lineage read contract', () => {
  it('keeps progress and opening stores distinct and requires saved identity', () => {
    expect(progressPassportIdentity(fixturePassportBatch())).toEqual(identity)
    const openingBatch = ((fixtureOpeningPassport().record as Row).batches as Row[])[0]
    expect(progressPassportIdentity({ batch: openingBatch })).toEqual(openingIdentity)
    expect(progressPassportIdentity({ ...fixturePassportBatch(), intake_id: 'opening' }, 'wip')).toBeNull()
    expect(progressPassportIdentity({ batch_id: 'title' })).toBeNull()
    expect(progressPassportIdentity({ ...fixturePassportBatch(), qr_payload: '' })).toEqual({ ...identity, qr: '' })
  })

  it('uses native OR capabilities and actual ownership without a role-label override', async () => {
    expect(passportPermissions(actor([], 'admin')).read).toBe(false)
    expect(passportPermissions(null).correct).toBe(false)
    expect(passportPermissions(actor(['apparatus.queue.read'], 'aparatchi')).correct).toBe(true)
    const fetch = mockApi(), own = await service(actor(['apparatus.queue.read'], 'aparatchi')).read(identity)
    expect(own.kind === 'wip' && own.ownership).toBe('direct')
    await expect(service(actor([])).read(identity)).rejects.toMatchObject({ status: 403 })
    const different = await service(actor(['admin.access'], 'admin', 'another-admin')).read(identity)
    expect(passportCorrectionIssue(different, actor(['admin.access'], 'admin', 'another-admin'))).toContain('Admin roli')
    expect(mutations(fetch)).toHaveLength(0)
  })

  it('proves a phone alias only from native bounded worker history and handles unavailable proof', async () => {
    const batch = fixturePassportBatch({ worker_ref: '+998 90 123 45 67' }), report = fixturePassportReport(batch)
    const fetch = mockApi(report, path => path.endsWith('/history') ? { ok: true, batches: [batch] } : undefined)
    const result = await service().read(identity)
    expect(result.kind === 'wip' && result.ownership).toBe('history')
    const history = new URL(String(fetch.mock.calls.find(call => String(call[0]).includes('/history'))![0]))
    expect(history.searchParams.get('worker_ref')).toBe('worker:001'); expect(history.searchParams.get('limit')).toBe('200')
    mockApi(report, path => path.endsWith('/history') ? failure(403, 'forbidden') : undefined)
    const denied = await service().read(identity)
    expect(denied.kind === 'wip' && denied.ownership).toBe('unconfirmed')
    expect(denied.kind === 'wip' && denied.ownershipError).toBeTruthy()
  })

  it('binds every read to exact batch/order/QR and never invokes correction or printing', async () => {
    const fetch = mockApi()
    expect((await service().read(identity)).identity).toEqual(identity)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ progress_batch_id: batchId, qr_payload: qr })
    expect((await service().read(openingIdentity)).kind).toBe('opening-wip')
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body))).toEqual({ qr_payload: openingIdentity.qr })
    expect(mutations(fetch)).toHaveLength(0)
    for (const changes of [{ batch_id: 'wrong' }, { order_id: 'wrong' }, { qr_payload: 'wrong' }]) { mockApi(fixturePassportReport(fixturePassportBatch(changes))); await expect(service().read(identity)).rejects.toMatchObject({ status: 502 }) }
  })

  it('rejects unrelated order data, missing scope and contradictory lineage projections', () => {
    for (const change of [{ history_scope: 'whole_order' }, { lineage_complete: 'yes' }, { progress_batches: [] }, { current_batches: [fixturePassportBatch({ revision: 3 })] }, { lineage_edges: [{ parent_batch_id: batchId, child_batch_id: 'unrelated' }] }, { logs: [{ order_id: 'another' }] }, { run_sessions: [{ session_id: 'other', order_id: 'another' }] }, { order: { id: 'another' } }]) expect(() => parseProgressPassport(fixturePassportReport(undefined, change), identity)).toThrow(ApiError)
    expect(() => parsePassportBatch({ ...fixturePassportBatch(), revision: undefined })).toThrow(ApiError)
    expect(() => parsePassportBatch({ ...fixturePassportBatch(), produced_qty: Infinity })).toThrow(ApiError)
    const opening = fixtureOpeningPassport(); ((opening.record as Row).batches as Row[])[0].wip_status = 'void'
    expect(() => parseOpeningPassport(opening, openingIdentity)).toThrow(ApiError)
  })

  it('rejects fabricated current quantities and cyclic lineage, while retaining real multi-input alternatives', () => {
    const batch = fixturePassportBatch(), child = fixturePassportBatch({ batch_id: 'child-roll', qr_payload: 'child-QR' })
    expect(() => parseProgressPassport(fixturePassportReport(batch, { current_batch: null }), identity)).toThrow(ApiError)
    expect(() => parseProgressPassport(fixturePassportReport(batch, { current_batch: { ...batch, produced_qty: 999 }, current_batches: [{ ...batch, produced_qty: 999 }] }), identity)).toThrow(ApiError)
    const cyclic = { progress_batches: [batch, child], lineage_edges: [{ parent_batch_id: batch.batch_id, child_batch_id: child.batch_id }, { parent_batch_id: child.batch_id, child_batch_id: batch.batch_id }] }
    expect(() => parseProgressPassport(fixturePassportReport(batch, cyclic), identity)).toThrow('sikl')
    expect(parseProgressPassport(fixturePassportReport(batch, { progress_batches: [batch, child], current_batch: child, current_batches: [child], lineage_edges: [{ parent_batch_id: batch.batch_id, child_batch_id: child.batch_id }] }), identity).currentBatches[0].batch_id).toBe(child.batch_id)
  })
})

describe('owner and measured correction policy', () => {
  it('locks used/stale/training/layer and unknown kind or action states', () => {
    for (const patch of [{ wip_status: 'in_use' }, { wip_status: 'processed' }, { used_by_session_id: 'used' }, { processed_by_apparatus: apparatus }, { payload_json: { origin: 'layer_remainder' } }, { payload_json: { training: true } }, { order_id: 'training-001' }, { status: 'resumed' }, { action: 'pause' }]) {
      const batch = fixturePassportBatch(patch), candidate = { ...passport(), batch }
      expect(passportCorrectionIssue(candidate, actor())).not.toBe('')
    }
    expect(passportCorrectionIssue({ ...passport(), stale: true }, actor())).toContain('Ishlatilgan')
    expect(passportCorrectionIssue(parseOpeningPassport(fixtureOpeningPassport(), openingIdentity), actor())).toContain('API mavjud emas')
  })

  it('keeps saved fields and native optional clears explicit, validates positive decimal units and reasons', () => {
    const current = passport(), form = passportForm(current.batch), operation = correction(current, { produced_qty: '105,5' })
    expect(operation.body).toMatchObject({ batch_id: batchId, expected_revision: 2, produced_qty: 105.5, finished_goods_kg: 25, bobina_kg: 1, return_ink_kg: null, uom: 'm' })
    expect(operation.body).not.toHaveProperty('order_id'); expect(operation.body).not.toHaveProperty('qr_payload'); expect(operation.body).not.toHaveProperty('worker_ref')
    for (const patch of [{ produced_qty: '0' }, { produced_qty: '-1' }, { produced_qty: '1e3' }, { produced_qty: '1.0000001' }, { produced_qty: 'Infinity' }, { reason: '' }, { uom: '' }, { measures: { ...form.measures, finished_goods_kg: '0' } }]) expect(() => passportCorrectionOperation(current, actor(), { ...form, description: 'change', reason: 'reason', ...patch })).toThrow()
    expect(() => passportCorrectionOperation(current, actor(), { ...form, reason: 'reason' })).toThrow('o‘zgarmagan')
    const cleared = correction(current, { measures: { ...form.measures, total_waste: '' } })
    expect(cleared.body.total_waste).toBeNull()
  })

  it('preserves independent measured gross on core/description changes and validates tare against corrected gross', () => {
    const current = passport(), form = passportForm(current.batch)
    expect(() => correction(current, { measures: { ...form.measures, bobina_kg: '26' } })).not.toThrow()
    expect(() => correction(current, { measures: { ...form.measures, bobina_kg: '28' } })).toThrow('gross')
    expect(() => correction(current, { measures: { ...form.measures, finished_goods_kg: '2', bobina_kg: '3' } })).toThrow('gross')
    expect(nativeCorrect(correction(current)).payload_json.gross_qty).toBe(27)
  })

  it('sends exact native CAS correction once and confirms actor/reason/old/new values through audit readback', async () => {
    const operation = correction(), after = nativeCorrect(operation); let report = fixturePassportReport()
    const fetch = mockApi(() => report, (path, _method, body) => { if (path.endsWith('/correct')) { expect(body).toEqual(operation.body); report = fixturePassportReport(after, { corrections: [audit(operation, after)] }); return { ok: true, batch: after } } })
    const result = await service().execute(operation)
    expect(result).toMatchObject({ kind: 'correct', correctedBatch: { revision: 3 }, recovered: false })
    expect(mutations(fetch)).toHaveLength(1)
    const request = mutations(fetch)[0][1]
    expect(new Headers(request?.headers).has('Idempotency-Key')).toBe(false)
    expect(fetch.mock.calls.filter(call => String(call[0]).endsWith('/report'))).toHaveLength(2)
  })

  it('stops changed revision, ownership or consumed state before dispatch', async () => {
    const operation = correction()
    for (const change of [{ revision: 3 }, { worker_ref: 'another' }, { wip_status: 'processed' }, { used_by_session_id: 'used' }]) {
      const fetch = mockApi(fixturePassportReport(fixturePassportBatch(change))), dispatch = vi.fn()
      await expect(service().execute(operation, undefined, dispatch)).rejects.toBeInstanceOf(PassportConflict)
      expect(dispatch).not.toHaveBeenCalled(); expect(mutations(fetch)).toHaveLength(0)
    }
  })

  it('does not transmit protected or swapped batch/body fields', async () => {
    for (const change of [{ worker_ref: 'another' }, { batch_id: 'another' }, { expected_revision: 1 }, { produced_qty: -1 }]) {
      const operation = correction(); Object.assign(operation.body, change)
      const fetch = mockApi()
      await expect(service().execute(operation)).rejects.toThrow()
      expect(mutations(fetch)).toHaveLength(0)
    }
  })

  it('retains native 403/409/locked/unchanged failures without repeated writes', async () => {
    for (const [status, code] of [[403, 'progress_batch_correction_forbidden'], [409, 'progress_batch_correction_conflict'], [409, 'progress_batch_correction_locked'], [400, 'progress_batch_correction_unchanged']] as const) {
      const fetch = mockApi(undefined, path => path.endsWith('/correct') ? failure(status, code) : undefined)
      await expect(service().execute(correction())).rejects.toMatchObject({ status, code })
      expect(mutations(fetch)).toHaveLength(1)
    }
  })

  it('rejects malformed success, wrong protected ownership, payload or missing audit proof as an unknown save', async () => {
    const operation = correction(), after = nativeCorrect(operation)
    for (const result of [{ ok: true }, { ok: true, batch: { ...after, revision: 2 } }, { ok: true, batch: { ...after, qr_payload: 'wrong' } }, { ok: true, batch: { ...after, worker_ref: 'wrong' } }, { ok: true, batch: { ...after, payload_json: { ...after.payload_json, start_resources: 'wrong' } } }, { ok: true, batch: { ...after, payload_json: { ...after.payload_json, produced_qty: 900 } } }, { ok: true, batch: after }]) {
      const fetch = mockApi(undefined, path => path.endsWith('/correct') ? result : undefined)
      await expect(service().execute(operation)).rejects.toBeInstanceOf(PassportUnknown)
      expect(mutations(fetch)).toHaveLength(1)
    }
  })
})

describe('exact unknown correction recovery and interrupted RAM retention', () => {
  it('recovers a lost response only from the matching native audit, even if the roll was later consumed', async () => {
    const operation = correction(), corrected = nativeCorrect(operation); let report = fixturePassportReport()
    const fetch = mockApi(() => report, path => { if (path.endsWith('/correct')) { report = fixturePassportReport(corrected, { corrections: [audit(operation, corrected)] }); throw new TypeError('lost response after commit') } })
    await expect(service().execute(operation)).rejects.toBeInstanceOf(PassportUnknown)
    const current = fixturePassportBatch({ ...corrected, wip_status: 'processed', processed_by_session_id: 'next-session' }); report = fixturePassportReport(current, { is_stale: true, stale_reason: 'processed_by_next_stage', corrections: [audit(operation, corrected)] })
    const result = await service().recover(operation)
    expect(result.correctedBatch.revision).toBe(3); expect(result.passport.batch.wip_status).toBe('processed'); expect(result.recovered).toBe(true)
    expect(mutations(fetch)).toHaveLength(1)
  })

  it('never infers our save from matching quantities without exact actor, reason and revision audit', async () => {
    const operation = correction(), after = nativeCorrect(operation), entry = audit(operation, after)
    for (const corrections of [[], [{ ...entry, reason: 'another reason' }], [{ ...entry, actor: { role: 'admin', ref: 'another', display_name: 'Another' } }]]) {
      const fetch = mockApi(fixturePassportReport(after, { corrections }))
      await expect(service().recover(operation)).rejects.toBeInstanceOf(PassportUnknown)
      expect(mutations(fetch)).toHaveLength(0)
    }
  })

  it('retains unknown on unavailable readback and suppresses late aborted writes', async () => {
    const operation = correction(), aborted = new AbortController(); aborted.abort()
    const fetch = mockApi()
    await expect(service().execute(operation, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    mockApi(undefined, path => path.endsWith('/report') ? failure(503, 'unavailable') : undefined)
    await expect(service().recover(operation)).rejects.toBeInstanceOf(PassportUnknown)
    const controller = new AbortController(), after = nativeCorrect(operation), late = mockApi(undefined, path => { if (path.endsWith('/correct')) { controller.abort(); return { ok: true, batch: after } } })
    await expect(service().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mutations(late)).toHaveLength(1)
  })

  it('keeps drafts/baseline in scoped RAM and preserves only dispatched or recovering attempts on interruption', () => {
    const ledger = new PassportDraftLedger(), operation = correction(), context = 'session-one:roll-one', form = passportForm(operation.baseline.batch)
    ledger.saveDraft(context, form, operation.baseline); form.description = 'caller mutation'
    expect(ledger.draft(context)?.description).toBe('Initial'); expect(ledger.draftBase(context)?.batch.revision).toBe(2)
    expect(ledger.draft('session-two:roll-one')).toBeUndefined()
    const checking = ledger.begin(context, operation); ledger.interrupt(checking)
    expect(ledger.attempt(context)).toBeUndefined(); expect(ledger.draft(context)).toBeDefined()
    const dispatched = ledger.begin(context, operation); ledger.dispatch(dispatched); ledger.interrupt(dispatched)
    expect(ledger.attempt(context)?.phase).toBe('unknown')
    ledger.fail(dispatched, new DOMException('Cancelled after unmount', 'AbortError'))
    expect(ledger.attempt(context)?.phase).toBe('unknown')
    ledger.fail(dispatched, new ApiError(0, 'network'))
    expect(ledger.attempt(context)?.phase).toBe('unknown')
    expect(() => ledger.begin(context, operation)).toThrow('avvalgi')
    expect(ledger.finish(checking)).toBe(false)
    const recovering = ledger.begin(context, operation, true); ledger.interrupt(recovering)
    expect(ledger.attempt(context)?.phase).toBe('unknown')
    const verified = ledger.begin(context, operation, true); expect(ledger.finish(verified)).toBe(true)
    expect(ledger.draft(context)).toBeUndefined(); expect(ledger.draftBase(context)).toBeUndefined()
  })
})

describe('saved label identity and distinct offline/server outcomes', () => {
  it('prepares offline metadata only for the saved normal QR with no completion recreation', async () => {
    const current = passport(), operation = passportPrintOperation(current, actor(), printForm())
    const fetch = mockApi(undefined, (path, _method, body) => path.endsWith('/reprint') ? printReceipt(body!, current) : undefined)
    const result = await service().execute(operation)
    expect(result).toMatchObject({ kind: 'print', outcome: 'prepared', print: { printer_status: 'client_usb_pending' } })
    expect(operation.body).toEqual({ progress_batch_id: batchId, qr_payload: qr, print_transport: 'offline', printer: 'godex', print_mode: 'label', print_count: 1 })
    expect(mutations(fetch)).toHaveLength(1); expect(fetch.mock.calls.some(call => String(call[0]).includes('queue-action'))).toBe(false)
  })

  it('uses the separate opening endpoint and never submits opening WIP to progress correction', async () => {
    const current = parseOpeningPassport(fixtureOpeningPassport(), openingIdentity), operation = passportPrintOperation(current, actor(), printForm())
    const fetch = mockApi(undefined, (path, _method, body) => path.endsWith('/opening-wip/print') ? printReceipt(body!, current) : undefined)
    expect(await service().execute(operation)).toMatchObject({ kind: 'print', outcome: 'prepared' })
    expect(operation.body).toMatchObject({ batch_id: openingIdentity.batchId, qr_payload: openingIdentity.qr })
    expect(operation.body).not.toHaveProperty('progress_batch_id')
    expect(mutations(fetch).map(call => new URL(String(call[0])).pathname)).toEqual([`${base}/opening-wip/print`])
    expect(passportPrintIssue(current, actor(['apparatus.queue.read'], 'aparatchi'))).toContain('ruxsat berilmagan')
  })

  it('requires actual server printed receipt and validates saved measurements/count/QR', async () => {
    const current = passport(), operation = passportPrintOperation(current, actor(), printForm({ transport: 'server', count: '2', driverUrl: 'http://127.0.0.1:9292/' }))
    expect(operation.body).toMatchObject({ print_count: 2, driver_url: 'http://127.0.0.1:9292' }); expect(operation.body).not.toHaveProperty('print_transport')
    mockApi(undefined, (path, _method, body) => path.endsWith('/reprint') ? printReceipt(body!, current) : undefined)
    expect(await service().execute(operation)).toMatchObject({ outcome: 'printed' })
    const native = printReceipt(operation.body, current)
    for (const change of [{ status: 'prepared' }, { qr_payload: 'another' }, { print_count: 1 }, { gross_qty: 999 }, { item_code: 'another' }, { apparatus: 'another' }]) {
      const fetch = mockApi(undefined, path => path.endsWith('/reprint') ? { ...native, print: { ...(native.print as Row), ...change } } : undefined)
      await expect(service().execute(operation)).rejects.toBeInstanceOf(PassportUnknown)
      expect(mutations(fetch)).toHaveLength(1)
    }
  })

  it('handles native print failure while keeping the saved batch separate and never retries completion', async () => {
    const current = passport(), operation = passportPrintOperation(current, actor(), printForm({ transport: 'server' }))
    const fetch = mockApi(undefined, path => path.endsWith('/reprint') ? { ok: false, batch: current.batch, print: { ok: false, status: 'failed', code: 'print_failed', error: 'Driver rejected job' } } : undefined)
    await expect(service().execute(operation)).rejects.toBeInstanceOf(PassportPrintFailure)
    expect(mutations(fetch)).toHaveLength(1)
  })

  it('keeps an uncertain physical print unknown after readback and requires explicit local acknowledgement', async () => {
    const operation = passportPrintOperation(passport(), actor(), printForm({ transport: 'server' })), ledger = new PassportDraftLedger(), fetch = mockApi(undefined, path => { if (path.endsWith('/reprint')) throw new TypeError('ambiguous printer response') })
    const ticket = ledger.begin('scope', operation); ledger.dispatch(ticket)
    try { await service().execute(operation) } catch (error) { ledger.fail(ticket, error) }
    expect(ledger.attempt('scope')?.phase).toBe('unknown')
    await expect(service().recover(operation)).rejects.toMatchObject({ name: 'PassportUnknown', current: { identity } })
    expect(mutations(fetch)).toHaveLength(1)
    ledger.acknowledgePrint('scope'); expect(ledger.attempt('scope')).toBeUndefined()
  })

  it('blocks malformed transport/count/credentials and mismatched saved-label bodies before printer dispatch', async () => {
    const current = passport()
    for (const change of [{ count: '0' }, { count: '101' }, { count: '1.5' }, { driverUrl: 'file:///tmp/printer' }, { driverUrl: 'http://user:password@localhost' }, { printer: '' }]) expect(() => passportPrintOperation(current, actor(), printForm(change))).toThrow()
    const operation = passportPrintOperation(current, actor(), printForm()); operation.body.qr_payload = 'invented-QR'
    const fetch = mockApi()
    await expect(service().execute(operation)).rejects.toThrow('ko‘rib chiqilgan')
    expect(mutations(fetch)).toHaveLength(0)
    expect(passportPrintIssue({ ...current, batch: { ...current.batch, payload_json: { origin: 'layer_remainder' } } }, actor())).toContain('alohida native')
  })

  it('invalidates an unauthorized session and documents unavailable print/correction recovery contracts', async () => {
    const onUnauthorized = vi.fn(); mockApi(undefined, () => failure(401, 'unauthorized'))
    await expect(service(actor(), onUnauthorized).read(identity)).rejects.toMatchObject({ status: 401 }); expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(PASSPORT_API_LIMITATIONS.join(' ')).toContain('no command key')
    expect(PASSPORT_API_LIMITATIONS.join(' ')).toContain('no progress correction method')
    expect(PASSPORT_API_LIMITATIONS.join(' ')).toContain('no native USB transport')
  })
})
