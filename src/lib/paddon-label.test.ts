import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import type { Session } from './api-types'
import {
  PaddonLabelApi, PaddonLabelConflict, PaddonLabelIntentLedger, PaddonLabelUnknown, canPreparePaddonLabel, canReadPaddonLabelReport,
  normalizePaddonLabelOptions, paddonLabelError, paddonLabelIntentLedger, paddonQrPrintPath, paddonQrReportPath,
  parsePaddonLabelPreparation, parsePaddonLabelReport, preparePaddonLabelOperation,
} from './paddon-label'
import type { PaddonLabelReport } from './paddon-label'
import type { PaddonSummary } from './paddons'

const summary: PaddonSummary = { id: 'legacy/opaque-paddon:kept-id', code: '00001', location: 'QA Cut', note: 'QA report', created_by_ref: 'qa-worker-1', created_by_display_name: 'QA Operator', created_at_unix: 100, updated_at_unix: 101, item_count: 1, locked_at_unix: null, total_gross_kg: 12, total_net_kg: 11.5 }
const batch = { batch_id: 'qa-label-wip-1', order_id: 'qa-order-1', apparatus: 'apparatus:qa:cut-1', qr_payload: 'QA:ROLL:1', label_item_code: 'QA-FILM', label_item_name: 'QA Film', produced_qty: 1500, uom: 'm', wip_status: 'waiting', finished_goods_kg: 10, bobina_kg: 0.5, finished_goods_meter: 1500, payload_json: { gross_qty: 12, password: 'do-not-return' } }
function rawReport(paddon = summary) { return { ok: true, paddon, items: [batch], qr_payload: paddon.code, free_movement_enabled: false, can_manage_items: paddon.locked_at_unix === null, can_unlock: paddon.locked_at_unix !== null, available_items: [{ secret: 'omit' }] } }
function report(): PaddonLabelReport { return parsePaddonLabelReport(rawReport()) }
function prepared(options = normalizePaddonLabelOptions()) {
  return { ok: true, paddon: summary, items: [batch], qr_payload: summary.code, print: {
    ok: true, status: 'prepared', printer_status: 'client_usb_pending', qr_payload: summary.code, item_code: summary.code, item_name: `Paddon ${summary.code}`,
    apparatus: '', apparatus_display_name: '', customer_name: '', executor_name: 'QA Operator', qty: 1, gross_qty: 1, tare_enabled: false, tare_kg: 0,
    unit: 'dona', progress_unit: 'dona', label_kind: 'paddon_code', ...options,
  }, can_close_after_print: true }
}
function session(capabilities = ['apparatus.queue.read'], token = 'local-test'): Session {
  return { token, capabilities, profile: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
}
function api(principal = session()) { return new PaddonLabelApi(new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: principal.token }), principal) }
type WireOptions = { method: string; body?: string; signal: AbortSignal }
function wire({ read = rawReport() as unknown, result, status = 200, readStatus = 200, failure, onRead, onMutation }: { read?: unknown; result?: unknown; status?: number; readStatus?: number; failure?: Error; onRead?: () => void; onMutation?: () => void } = {}) {
  const fetch = vi.fn(async (_url: URL, options: WireOptions) => {
    if (options.method === 'GET') { onRead?.(); return new Response(JSON.stringify(read), { status: readStatus }) }
    onMutation?.(); if (failure) throw failure
    const input = JSON.parse(options.body!), value = result ?? prepared({ printer: input.printer, print_mode: input.print_mode, print_count: input.print_count })
    return new Response(status === 204 ? null : JSON.stringify(value), { status })
  })
  vi.stubGlobal('fetch', fetch); return fetch
}
function writes(fetch: ReturnType<typeof wire>) { return fetch.mock.calls.filter(([, options]) => options.method !== 'GET') }
afterEach(() => vi.unstubAllGlobals())

describe('strict native paddon QR report and offline preparation DTOs', () => {
  it('keeps raw leading-zero QR code, legacy opaque ID and authoritative kg separate from one-label dona defaults', () => {
    const operation = preparePaddonLabelOperation(report()), result = parsePaddonLabelPreparation(prepared(), operation)
    expect(result.paddon.id).toBe(summary.id); expect(result.qr_payload).toBe('00001'); expect(result.print.item_code).toBe('00001')
    expect(result.paddon.total_gross_kg).toBe(12); expect(result.paddon.total_net_kg).toBe(11.5)
    expect(result.print).toMatchObject({ qty: 1, gross_qty: 1, unit: 'dona', progress_unit: 'dona', label_kind: 'paddon_code', status: 'prepared', printer_status: 'client_usb_pending' })
    expect(result.items[0]).not.toHaveProperty('payload_json'); expect(result).not.toHaveProperty('available_items'); expect(result).not.toHaveProperty('printed')
  })
  it('normalizes native ASCII case/defaults and0→1 without inventing a server100-copy cap', () => {
    expect(normalizePaddonLabelOptions()).toEqual({ printer: 'godex', print_mode: 'label', print_count: 1 })
    expect(normalizePaddonLabelOptions({ printer: ' GODEX ', print_mode: ' QR ', print_count: 0 })).toEqual({ printer: 'godex', print_mode: 'qr', print_count: 1 })
    expect(normalizePaddonLabelOptions({ printer: 'İ-GODEX', print_mode: 'LABEL', print_count: 101 })).toEqual({ printer: 'İ-godex', print_mode: 'label', print_count: 101 })
    expect(normalizePaddonLabelOptions({ print_count: 0xffff_ffff }).print_count).toBe(0xffff_ffff)
    for (const print_count of [-1, 0.5, NaN, Infinity, 0x1_0000_0000]) expect(() => normalizePaddonLabelOptions({ print_count })).toThrow()
  })
  it.each([
    { ...rawReport(), ok: false }, { ...rawReport(), qr_payload: '1' }, { ...rawReport(), paddon: { ...summary, code: '1' } },
    { ...rawReport(), items: [] }, { ...rawReport(), items: [batch, batch], paddon: { ...summary, item_count: 2 } },
    { ...rawReport(), free_movement_enabled: undefined }, { ...rawReport(), can_manage_items: 'true' }, { ...rawReport(), can_unlock: true },
    { ...rawReport(), paddon: { ...summary, locked_at_unix: undefined } },
  ])('rejects malformed/unbound report instead of a plausible label: %j', value => { expect(() => parsePaddonLabelReport(value)).toThrow() })
  it('preserves locked, received or unknown-weight server display states without inferring permission from lock alone', () => {
    const value = { ...rawReport({ ...summary, locked_at_unix: 102, total_gross_kg: null, total_net_kg: null }), free_movement_enabled: true, can_manage_items: true, can_unlock: false }
    expect(parsePaddonLabelReport(value)).toMatchObject({ paddon: { locked_at_unix: 102, total_gross_kg: null, total_net_kg: null }, can_manage_items: true })
    const operation = preparePaddonLabelOperation(parsePaddonLabelReport(value)), result = { ...prepared(), paddon: value.paddon, can_close_after_print: false }
    expect(parsePaddonLabelPreparation(result, operation).paddon.locked_at_unix).toBe(102)
  })
  it.each([
    ['status', 'printed'], ['printer_status', 'success'], ['qr_payload', '00002'], ['item_code', '00002'], ['item_name', 'Paddon 2'],
    ['label_kind', 'progress'], ['qty', 12], ['gross_qty', 12], ['unit', 'kg'], ['progress_unit', 'm'], ['tare_enabled', true], ['tare_kg', 0.5],
    ['printer', 'zebra'], ['print_mode', 'qr'], ['print_count', 2], ['apparatus', 'QA Machine'], ['executor_name', undefined],
  ])('requires native prepared metadata field %s and bound copies/options', (key, value) => {
    const payload = prepared(); (payload.print as Record<string, unknown>)[key] = value
    expect(() => parsePaddonLabelPreparation(payload, preparePaddonLabelOperation(report()))).toThrow()
  })
})

describe('report guards, frozen selections and fresh preflight', () => {
  it('models any-authenticated native prepare separately from the actual four-capability report guard', async () => {
    expect(canPreparePaddonLabel(session([]))).toBe(true); expect(canReadPaddonLabelReport(session([]))).toBe(false)
    for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']) expect(canReadPaddonLabelReport(session([capability]))).toBe(true)
    expect(canPreparePaddonLabel(null)).toBe(false); expect(canPreparePaddonLabel(session([], ' '))).toBe(false)
    const fetch = wire()
    await expect(api(session([])).report('00001')).rejects.toMatchObject({ status: 403 })
    await expect(api(session([])).execute(preparePaddonLabelOperation(report()))).rejects.toMatchObject({ status: 403 })
    await expect(api(session([], '')).report('00001')).rejects.toMatchObject({ status: 401 }); expect(fetch).not.toHaveBeenCalled()
  })
  it('binds GET to selected code and optional exact opaque identity with expected200', async () => {
    const fetch = wire(); expect(await api().report(summary)).toEqual(report())
    expect(fetch.mock.calls[0]![0].pathname).toBe(paddonQrReportPath); expect(fetch.mock.calls[0]![0].searchParams.get('code')).toBe('00001')
    wire({ read: rawReport({ ...summary, id: 'swapped-opaque-id' }) }); await expect(api().report(summary)).rejects.toMatchObject({ code: 'invalid_response' })
    wire({ read: { ...rawReport(), paddon: { ...summary, code: '00002' }, qr_payload: '00002' } }); await expect(api().report('00001')).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('copies and freezes original report and options so later source/current picker changes cannot retarget a request', async () => {
    const source = report(), options = { printer: ' Zebra ', print_mode: 'QR', print_count: 2 }, operation = preparePaddonLabelOperation(source, options)
    source.paddon.code = '00002'; source.items[0]!.label_item_name = 'Changed draft'; options.print_count = 3
    expect(operation.code).toBe('00001'); expect(operation.baseline.items[0]!.label_item_name).toBe('QA Film'); expect(operation.input.print_count).toBe(2)
    expect(Object.isFrozen(operation)).toBe(true); expect(Object.isFrozen(operation.baseline.items[0])).toBe(true)
    const fetch = wire(); const result = await api().execute(operation)
    expect(JSON.parse(writes(fetch)[0]![1].body!)).toEqual({ code: '00001', print_transport: 'offline', printer: 'zebra', print_mode: 'qr', print_count: 2 })
    expect(writes(fetch)[0]![0].pathname).toBe(paddonQrPrintPath); expect(fetch).toHaveBeenCalledTimes(2)
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.print)).toBe(true); expect(Object.isFrozen(result.items[0])).toBe(true)
    expect(fetch.mock.calls.some(([url]) => /confirm|driver|settings|active/.test(url.pathname))).toBe(false)
  })
  it.each([
    rawReport({ ...summary, id: 'other-opaque-id' }), rawReport({ ...summary, updated_at_unix: 102 }), rawReport({ ...summary, note: 'Concurrent note' }),
    rawReport({ ...summary, total_gross_kg: 20 }), { ...rawReport(), items: [{ ...batch, label_item_name: 'Changed server label' }] },
    { ...rawReport(), free_movement_enabled: true },
  ])('rejects changed fresh source before POST with reviewable current report: %j', async read => {
    const fetch = wire({ read }), operation = preparePaddonLabelOperation(report())
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonLabelConflict', current: { paddon: read.paddon } }); expect(writes(fetch)).toHaveLength(0)
  })
  it('keeps preflight refusal/cancellation known with no dispatched request', async () => {
    let fetch = wire({ readStatus: 403, read: { error: 'forbidden' } }); await expect(api().execute(preparePaddonLabelOperation(report()))).rejects.toMatchObject({ status: 403 }); expect(writes(fetch)).toHaveLength(0)
    const controller = new AbortController(); fetch = wire({ onRead: () => controller.abort() })
    await expect(api().execute(preparePaddonLabelOperation(report()), controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(writes(fetch)).toHaveLength(0)
    fetch = wire(); const before = new AbortController(); before.abort(); await expect(api().execute(preparePaddonLabelOperation(report()), before.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled()
  })
  it('cannot emit driver_url, server transport, arbitrary choice or mutable forged options even if extra runtime fields exist', async () => {
    const fetch = wire(), operation = preparePaddonLabelOperation(report())
    await api().execute({ ...operation, input: { ...operation.input, driver_url: 'http://never-called.invalid' } } as typeof operation)
    expect(JSON.parse(writes(fetch)[0]![1].body!)).not.toHaveProperty('driver_url')
    for (const modified of [{ ...operation, input: { ...operation.input, print_transport: 'wifi' } }, { ...operation, code: '00002' }, { ...operation, input: { ...operation.input, print_count: 0 } }]) {
      await expect(api().execute(modified as typeof operation)).rejects.toThrow(); expect(writes(fetch)).toHaveLength(1)
    }
  })
})

describe('uncertain replies, read-only observations and scoped RAM recovery', () => {
  it.each([{}, { ...prepared(), qr_payload: '00002' }, { ...prepared(), paddon: { ...summary, id: 'swapped-id' } }, { ...prepared(), print: { ...prepared().print, status: 'printed' } }, { ...prepared(), can_close_after_print: undefined }])('retains malformed/swapped200 once without automatic replay or extra recovery GET: %j', async result => {
    const operation = preparePaddonLabelOperation(report()), fetch = wire({ result })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonLabelUnknown', operation }); expect(writes(fetch)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each([201, 204, 408, 429, 500, 503])('classifies dispatched HTTP%s as unknown without repeat', async status => {
    const operation = preparePaddonLabelOperation(report()), fetch = wire({ status })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonLabelUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
  })
  it.each([400, 401, 403, 404, 409])('preserves explicit native HTTP%s refusal', async status => {
    const fetch = wire({ status, result: { error: 'paddon_not_found' } })
    await expect(api().execute(preparePaddonLabelOperation(report()))).rejects.toMatchObject({ name: 'ApiError', status }); expect(writes(fetch)).toHaveLength(1)
  })
  it('retains loss and abort after dispatch with the original operation and no replay', async () => {
    const operation = preparePaddonLabelOperation(report()); let fetch = wire({ failure: new TypeError('lost') })
    await expect(api().execute(operation)).rejects.toMatchObject({ name: 'PaddonLabelUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
    const controller = new AbortController(); fetch = wire({ onMutation: () => controller.abort() })
    await expect(api().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'PaddonLabelUnknown', operation }); expect(writes(fetch)).toHaveLength(1)
  })
  it('observes matching/changed/missing reports only, without prepare receipt or physical proof', async () => {
    const operation = preparePaddonLabelOperation(report()); let fetch = wire()
    const observation = await api().observe(operation); expect(observation.state).toBe('matches'); expect(observation).not.toHaveProperty('printed'); expect(observation).not.toHaveProperty('receipt'); expect(writes(fetch)).toHaveLength(0)
    wire({ read: rawReport({ ...summary, note: 'New server note' }) }); expect((await api().observe(operation)).state).toBe('different')
    fetch = wire({ readStatus: 404, read: { error: 'paddon_not_found' } }); expect(await api().observe(operation)).toEqual({ state: 'missing' }); expect(writes(fetch)).toHaveLength(0)
    wire({ readStatus: 403, read: { error: 'forbidden' } }); await expect(api().observe(operation)).rejects.toMatchObject({ status: 403 })
    wire({ read: {} }); await expect(api().observe(operation)).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('retains one frozen unknown intent across remounts, guards repetition and requires explicit read review before resolution', () => {
    const ledger = paddonLabelIntentLedger('label-tests'), operation = preparePaddonLabelOperation(report()), other = preparePaddonLabelOperation(report(), { print_count: 2 }), changed = vi.fn(), unsubscribe = ledger.subscribe(changed)
    ledger.begin(operation); ledger.unknown(operation); expect(paddonLabelIntentLedger('label-tests')).toBe(ledger); expect(paddonLabelIntentLedger('label-other-tests').snapshot()).toBeNull()
    expect(() => ledger.begin(other)).toThrow('takrorlanmaydi'); ledger.finish(operation); ledger.finish(other); ledger.observe(other, { state: 'missing' }); expect(ledger.snapshot()?.operation).toBe(operation)
    expect(() => ledger.resolveReviewed(operation)).toThrow('joriy hisobotni')
    const observed = { report: report(), state: 'matches' as const }; ledger.observe(operation, observed); observed.report.paddon.note = 'Later UI edit'
    expect(ledger.snapshot()?.observation?.report?.paddon.note).toBe(summary.note); expect(Object.isFrozen(ledger.snapshot()?.observation?.report?.items)).toBe(true)
    ledger.resolveReviewed(operation); unsubscribe(); expect(changed).toHaveBeenCalledTimes(4)
    const pending = new PaddonLabelIntentLedger(); pending.begin(other); pending.finish(other); expect(pending.snapshot()).toBeNull()
    expect(paddonLabelError(new PaddonLabelUnknown(operation))).toContain('tasdiqlamaydi'); expect(new PaddonLabelConflict(report(), 'changed').current).toEqual(report())
  })
})
