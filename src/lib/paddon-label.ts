import { ApiClient, ApiError, record, rows } from './api'
import type { Row, Session } from './api-types'
import { canReadPaddons, normalizePaddonCode, paddonError, paddonsPath, parsePaddonBatch, parsePaddonSummary } from './paddons'
import type { PaddonBatch, PaddonSummary } from './paddons'

export const paddonQrReportPath = `${paddonsPath}/qr/report`
export const paddonQrPrintPath = `${paddonsPath}/qr/print`
export interface PaddonLabelReport {
  paddon: PaddonSummary; items: PaddonBatch[]; qr_payload: string
  free_movement_enabled: boolean; can_manage_items: boolean; can_unlock: boolean
}
export interface PaddonLabelOptions { printer?: string; print_mode?: string; print_count?: number }
export interface PaddonLabelInput { code: string; print_transport: 'offline'; printer: string; print_mode: string; print_count: number }
export interface PaddonLabelOperation {
  readonly kind: 'prepare'; readonly code: string; readonly input: PaddonLabelInput; readonly baseline: PaddonLabelReport
}
export interface PaddonPreparedLabel {
  ok: true; status: 'prepared'; printer_status: 'client_usb_pending'
  qr_payload: string; item_code: string; item_name: string
  apparatus: ''; apparatus_display_name: ''; customer_name: ''; executor_name: string
  qty: 1; gross_qty: 1; tare_enabled: false; tare_kg: 0
  unit: 'dona'; progress_unit: 'dona'; label_kind: 'paddon_code'
  printer: string; print_mode: string; print_count: number
}
export interface PaddonLabelPreparation {
  paddon: PaddonSummary; items: PaddonBatch[]; qr_payload: string
  print: PaddonPreparedLabel; can_close_after_print: boolean
}
export interface PaddonLabelObservation { report?: PaddonLabelReport; state: 'matches' | 'different' | 'missing' }

const nativeTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase())
const maxPrintCount = 0xffff_ffff
function invalid(): never { throw new ApiError(502, 'invalid_response', 'Paddon yorlig‘i haqida to‘liq ma’lumot kelmadi. Joriy hisobotni qayta yuklang.') }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
function flag(row: Row, key: string): boolean { if (typeof row[key] !== 'boolean') return invalid(); return row[key] as boolean }
function string(row: Row, key: string): string { if (typeof row[key] !== 'string') return invalid(); return row[key] as string }
function contents(row: Row): { paddon: PaddonSummary; items: PaddonBatch[]; qr_payload: string } {
  if (row.ok !== true) return invalid()
  const paddon = parsePaddonSummary(row.paddon), items = rows(row.items).map(parsePaddonBatch), qr_payload = string(row, 'qr_payload')
  if (qr_payload !== paddon.code || paddon.item_count !== items.length || new Set(items.map(item => item.batch_id)).size !== items.length) return invalid()
  return { paddon, items, qr_payload }
}
function freezeContents<T extends { paddon: PaddonSummary; items: PaddonBatch[] }>(value: T): T {
  Object.freeze(value.paddon); value.items.forEach(Object.freeze); Object.freeze(value.items); return Object.freeze(value)
}
export function canReadPaddonLabelReport(session: Session | null | undefined): boolean { return canReadPaddons(session) }
/** Native preparation authenticates the session and checks visibility; it has no capability guard. */
export function canPreparePaddonLabel(session: Session | null | undefined): boolean { return !!session && typeof session.token === 'string' && !!nativeTrim(session.token) }
export function parsePaddonLabelReport(value: unknown): PaddonLabelReport {
  const row = record(value), base = contents(row), free_movement_enabled = flag(row, 'free_movement_enabled'), can_manage_items = flag(row, 'can_manage_items'), can_unlock = flag(row, 'can_unlock')
  if (can_unlock && base.paddon.locked_at_unix === null || can_manage_items && base.paddon.locked_at_unix !== null && !free_movement_enabled) return invalid()
  return { ...base, free_movement_enabled, can_manage_items, can_unlock }
}
export function normalizePaddonLabelOptions(options: PaddonLabelOptions = {}): Required<PaddonLabelOptions> {
  if (options.printer !== undefined && typeof options.printer !== 'string' || options.print_mode !== undefined && typeof options.print_mode !== 'string') throw new Error('Yorliq variantini matn sifatida tanlang.')
  const count = options.print_count ?? 1
  if (!Number.isSafeInteger(count) || count < 0 || count > maxPrintCount) throw new Error('Yorliq nusxalari sonini butun son sifatida kiriting.')
  // Native progress-label preparation accepts u32 counts and normalizes0 to1; mobile caps its own UI at100.
  return { printer: asciiLower(nativeTrim(options.printer ?? '')) || 'godex', print_mode: asciiLower(nativeTrim(options.print_mode ?? '')) || 'label', print_count: count || 1 }
}
export function preparePaddonLabelOperation(value: PaddonLabelReport, options: PaddonLabelOptions = {}): PaddonLabelOperation {
  const baseline = freezeContents(parsePaddonLabelReport({ ...value, ok: true })), code = baseline.paddon.code
  const input: PaddonLabelInput = Object.freeze({ code, print_transport: 'offline', ...normalizePaddonLabelOptions(options) })
  return Object.freeze({ kind: 'prepare', code, input, baseline })
}
function sameReport(left: PaddonLabelReport, right: PaddonLabelReport): boolean {
  const signature = (report: PaddonLabelReport): string => JSON.stringify({ ...report, items: [...report.items].sort((a, b) => a.batch_id.localeCompare(b.batch_id)) })
  return signature(left) === signature(right)
}
export function parsePaddonLabelPreparation(value: unknown, operation: PaddonLabelOperation): PaddonLabelPreparation {
  const row = record(value), base = contents(row), print = record(row.print), code = operation.code
  if (base.paddon.code !== code || base.paddon.id !== operation.baseline.paddon.id || base.qr_payload !== code
    || print.ok !== true || print.status !== 'prepared' || print.printer_status !== 'client_usb_pending'
    || print.qr_payload !== code || print.item_code !== code || print.item_name !== `Paddon ${code}`
    || print.apparatus !== '' || print.apparatus_display_name !== '' || print.customer_name !== ''
    || print.qty !== 1 || print.gross_qty !== 1 || print.tare_enabled !== false || print.tare_kg !== 0
    || print.unit !== 'dona' || print.progress_unit !== 'dona' || print.label_kind !== 'paddon_code'
    || print.printer !== operation.input.printer || print.print_mode !== operation.input.print_mode || print.print_count !== operation.input.print_count) return invalid()
  const can_close_after_print = flag(row, 'can_close_after_print')
  if (can_close_after_print && base.paddon.locked_at_unix !== null) return invalid()
  const prepared: PaddonPreparedLabel = Object.freeze({ ok: true, status: 'prepared', printer_status: 'client_usb_pending', qr_payload: code, item_code: code, item_name: `Paddon ${code}`,
    apparatus: '', apparatus_display_name: '', customer_name: '', executor_name: string(print, 'executor_name'), qty: 1, gross_qty: 1, tare_enabled: false, tare_kg: 0,
    unit: 'dona', progress_unit: 'dona', label_kind: 'paddon_code', printer: operation.input.printer, print_mode: operation.input.print_mode, print_count: operation.input.print_count })
  return freezeContents({ ...base, print: prepared, can_close_after_print })
}
export class PaddonLabelConflict extends Error {
  readonly current: PaddonLabelReport
  constructor(current: PaddonLabelReport, message: string) { super(message); this.name = 'PaddonLabelConflict'; this.current = freezeContents(current) }
}
export class PaddonLabelUnknown extends Error {
  readonly operation: PaddonLabelOperation
  constructor(operation: PaddonLabelOperation) {
    super('Yorliq tayyorlash javobi noma’lum. Avvalgi tanlov shu sessiya xotirasida saqlandi; so‘rov qayta yuborilmaydi. Hisobotni tekshirish qog‘ozga bosilganini tasdiqlamaydi.')
    this.name = 'PaddonLabelUnknown'; this.operation = operation
  }
}

/** Offline metadata only. There is no driver submission, confirmation, prepare receipt lookup or automatic replay. */
export class PaddonLabelApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  async report(value: string | PaddonSummary, signal?: AbortSignal): Promise<PaddonLabelReport> {
    if (!canPreparePaddonLabel(this.session)) throw new ApiError(401, 'unauthorized')
    if (!canReadPaddonLabelReport(this.session)) throw new ApiError(403, 'forbidden')
    abort(signal)
    const expected = typeof value === 'string' ? undefined : parsePaddonSummary(value), code = normalizePaddonCode(typeof value === 'string' ? value : expected!.code)
    const report = parsePaddonLabelReport(await this.client.request(paddonQrReportPath, 'GET', { query: { code }, signal, expectedStatus: 200 }))
    abort(signal)
    if (report.paddon.code !== code || expected && report.paddon.id !== expected.id) return invalid()
    return report
  }
  async execute(operation: PaddonLabelOperation, signal?: AbortSignal): Promise<PaddonLabelPreparation> {
    if (!canPreparePaddonLabel(this.session)) throw new ApiError(401, 'unauthorized')
    abort(signal)
    if (operation.kind !== 'prepare' || operation.code !== operation.baseline.paddon.code || operation.input.code !== operation.code || operation.input.print_transport !== 'offline') throw new Error('Avvalgi yorliq tanlovini qayta tekshiring.')
    const options = normalizePaddonLabelOptions(operation.input)
    if (options.printer !== operation.input.printer || options.print_mode !== operation.input.print_mode || options.print_count !== operation.input.print_count) throw new Error('Avvalgi yorliq variantini qayta tekshiring.')
    // This report-based UI needs native report access too; preparation itself does not acquire a stronger capability guard.
    const current = await this.report(operation.code, signal); abort(signal)
    if (!sameReport(current, operation.baseline)) throw new PaddonLabelConflict(current, 'Paddon hisoboti o‘zgargan. Joriy a’zolar va jami vaznlarni ko‘rib, yorliqni qayta tayyorlang.')
    abort(signal)
    try {
      const result = await this.client.request(paddonQrPrintPath, 'POST', { body: { code: operation.code, print_transport: 'offline', ...options }, signal, expectedStatus: 200 })
      abort(signal)
      return parsePaddonLabelPreparation(result, operation)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || [408, 429].includes(error.status) || error.status >= 500 || error.code === 'invalid_response') throw new PaddonLabelUnknown(operation)
      throw error
    }
  }
  async observe(operation: PaddonLabelOperation, signal?: AbortSignal): Promise<PaddonLabelObservation> {
    try {
      const report = await this.report(operation.code, signal); abort(signal)
      return { report, state: sameReport(report, operation.baseline) ? 'matches' : 'different' }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.code !== 'invalid_response') return { state: 'missing' }
      throw error
    }
  }
}

export interface PaddonLabelIntent { readonly operation: PaddonLabelOperation; readonly status: 'pending' | 'unknown'; readonly observation?: PaddonLabelObservation }
export class PaddonLabelIntentLedger {
  private intent: PaddonLabelIntent | null = null
  private readonly listeners = new Set<() => void>()
  snapshot = (): PaddonLabelIntent | null => this.intent
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(intent: PaddonLabelIntent | null): void { this.intent = intent && Object.freeze(intent); this.listeners.forEach(listener => listener()) }
  begin(operation: PaddonLabelOperation): void { if (this.intent) throw new Error('Avvalgi yorliq tayyorlash javobini tekshiring. So‘rov takrorlanmaydi.'); this.publish({ operation, status: 'pending' }) }
  unknown(operation: PaddonLabelOperation): void { if (this.intent?.operation === operation) this.publish({ operation, status: 'unknown' }) }
  finish(operation: PaddonLabelOperation): void { if (this.intent?.operation === operation && this.intent.status === 'pending') this.publish(null) }
  observe(operation: PaddonLabelOperation, value: PaddonLabelObservation): void {
    if (this.intent?.operation === operation && this.intent.status === 'unknown') {
      const report = value.report && freezeContents(parsePaddonLabelReport({ ...value.report, ok: true }))
      this.publish({ operation, status: 'unknown', observation: Object.freeze({ state: value.state, ...(report ? { report } : {}) }) })
    }
  }
  resolveReviewed(operation: PaddonLabelOperation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'unknown' || !this.intent.observation) throw new Error('Avval serverdagi joriy hisobotni tekshiring.')
    this.publish(null)
  }
}
const ledgers = new Map<string, PaddonLabelIntentLedger>()
export function paddonLabelIntentLedger(scope: string): PaddonLabelIntentLedger {
  let ledger = ledgers.get(scope); if (!ledger) { ledger = new PaddonLabelIntentLedger(); ledgers.set(scope, ledger) }; return ledger
}
export function paddonLabelError(error: unknown): string { return paddonError(error) }
