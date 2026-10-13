import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { Row, Session } from './api-types'
import { meetsRequirement } from './permissions'
import { isCanonicalApparatusId } from './production-map'
import { isOpeningWipRow, parseOpeningWipBatch, parseOpeningWipRecord } from './wip-admin'
import type { OpeningWipBatch, OpeningWipIntake } from './wip-admin'

const base = '/v1/mobile/admin/production-maps'
const capabilities = ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']
const optionalMeasures = ['return_ink_kg', 'lamination_print_leftover_rolls', 'lamination_film_leftover_rolls', 'rezka_bosma_waste', 'rezka_lamination_waste', 'rezka_edge_waste', 'total_waste', 'finished_goods_kg', 'bobina_kg', 'finished_goods_meter', 'diameter'] as const
export type PassportMeasure = typeof optionalMeasures[number]
export const passportMeasureLabels: Record<PassportMeasure, string> = { return_ink_kg: 'Qaytgan bo‘yoq, kg', lamination_print_leftover_rolls: 'Bosma qoldig‘i, rulon', lamination_film_leftover_rolls: 'Plyonka qoldig‘i, rulon', rezka_bosma_waste: 'Kesishdagi bosma chiqindisi', rezka_lamination_waste: 'Kesishdagi laminatsiya chiqindisi', rezka_edge_waste: 'Yon chiqindi', total_waste: 'Jami chiqindi', finished_goods_kg: 'Mahsulot / gross, kg', bobina_kg: 'Bobina / tara, kg', finished_goods_meter: 'Mahsulot uzunligi, m', diameter: 'Diametr' }
export const PASSPORT_API_LIMITATIONS = [
  'Correction is owner-scoped, including for administrators. Native worker history can establish an identity alias; its 200-row cap cannot establish ownership from absence.',
  'Progress corrections use expected_revision with native waiting/ownership/layer locks, but have no command key or replay endpoint. Recovery requires the matching immutable correction audit record.',
  'Opening WIP lives in a separate native store and has no progress correction method. Only its own QR report and saved-label print endpoints are used.',
  'Reprint has no idempotency key, print status lookup or physical-print recovery. Unknown outcomes are retained and never automatically repeated.',
  'Offline preparation returns saved-label metadata with client_usb_pending, not rendered printer bytes or physical print confirmation. This web app has no native USB transport.',
] as const
export type ProgressPassportKind = 'wip' | 'opening-wip'
export interface PassportIdentity { kind: ProgressPassportKind; batchId: string; orderId: string; qr: string }
export interface PassportBatch extends Row { batch_id: string; revision: number; order_id: string; qr_payload: string; apparatus: string; session_id: string; worker_ref: string; produced_qty: number; uom: string; wip_status: string; status: string; action: string; payload_json: Row; description: string }
export interface PassportCorrection extends Row { batch_id: string; previous_revision: number; new_revision: number; reason: string; actor: Row; old_values: PassportBatch; new_values: PassportBatch; created_at_unix: number }
export interface ProgressPassport { kind: 'wip'; identity: PassportIdentity; batch: PassportBatch; batches: PassportBatch[]; currentBatches: PassportBatch[]; corrections: PassportCorrection[]; lineageEdges: Row[]; lineageComplete: boolean; stale: boolean; staleReason: string; sessions: Row[]; resources: Row[]; logs: Row[]; orderStatus: Row; ownership: 'direct' | 'history' | 'unconfirmed'; ownershipError?: string }
export interface OpeningPassport { kind: 'opening-wip'; identity: PassportIdentity; batch: OpeningWipBatch; intake: OpeningWipIntake }
export type Passport = ProgressPassport | OpeningPassport
export interface PassportForm { produced_qty: string; uom: string; measures: Record<PassportMeasure, string>; description: string; reason: string }
export interface PassportCorrectionBody extends Row { batch_id: string; expected_revision: number; produced_qty: number; uom: string; description: string; reason: string }
export interface PassportPrintForm { transport: 'offline' | 'server'; printer: string; mode: string; count: string; driverUrl: string }
export type PassportOperation = { kind: 'correct'; id: string; baseline: ProgressPassport; body: PassportCorrectionBody } | { kind: 'print'; id: string; baseline: Passport; form: PassportPrintForm; body: Row }
export interface PassportCorrectionResult { kind: 'correct'; passport: ProgressPassport; correctedBatch: PassportBatch; recovered: boolean }
export interface PassportPrintResult { kind: 'print'; passport: Passport; print: Row; outcome: 'prepared' | 'printed' }
export type PassportResult = PassportCorrectionResult | PassportPrintResult
export class PassportConflict extends Error { readonly current?: Passport; constructor(message: string, current?: Passport) { super(message); this.name = 'PassportConflict'; this.current = current } }
export class PassportUnknown extends Error { readonly operation: PassportOperation; readonly current?: Passport; constructor(operation: PassportOperation, message = 'So‘rov natijasi tasdiqlanmadi. Avval serverdagi saqlangan rulonni tekshiring.', current?: Passport) { super(message); this.name = 'PassportUnknown'; this.operation = operation; this.current = current } }
export class PassportPrintFailure extends Error { readonly code: string; constructor(code: string, detail: string) { super(`${detail} Saqlangan rulon o‘zgartirilmagan; fizik bosma tasdiqlanmadi.`); this.name = 'PassportPrintFailure'; this.code = code } }
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const invalid = (message = 'Rulon pasporti serverdan to‘liq yoki mos kelgan holda olinmadi.'): never => { throw new ApiError(502, 'invalid_response', message) }
function required(value: unknown): string { const result = text(value); if (!result || /[\u0000-\u001f\u007f]/u.test(result)) return invalid(); return result }
function integer(value: unknown, min = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return invalid(); return value }
function number(value: unknown, min = 0): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return invalid(); return value }
const stable = (value: unknown): string => JSON.stringify(value, (_key, next) => isRecord(next) ? Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) : next)
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
const uncertain = (error: unknown): boolean => error instanceof ApiError ? error.status === 0 || error.status >= 500 || error.code === 'invalid_response' : !(error instanceof PassportConflict || error instanceof PassportPrintFailure)
const rounding = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
function sameNumber(left: unknown, right: unknown): boolean { return typeof left === 'number' && typeof right === 'number' && rounding(left) === rounding(right) }

export function passportPermissions(session: Session | null | undefined) {
  const authenticated = Boolean(session?.token && session.profile.role), permitted = authenticated && meetsRequirement(session, { any: capabilities })
  return { read: permitted, correct: permitted && Boolean(text(session?.profile.ref)), openingPrint: authenticated && meetsRequirement(session, { any: ['admin.access', 'production.map.manage'] }), progressPrint: authenticated && meetsRequirement(session, { any: [...capabilities, 'werka.access'] }) }
}
export function progressPassportIdentity(row: Row, kind?: ProgressPassportKind): PassportIdentity | null {
  const batch = isRecord(row.batch) ? row.batch : row, opening = isOpeningWipRow(row) || Boolean(text(batch.intake_id)), resolved = kind ?? (opening ? 'opening-wip' : 'wip')
  const batchId = text(batch.batch_id), orderId = text(batch.order_id), qr = text(batch.qr_payload)
  if (!batchId || !orderId || resolved === 'wip' && opening || resolved === 'opening-wip' && (!opening || !qr)) return null
  return { kind: resolved, batchId, orderId, qr }
}
export function parsePassportBatch(value: unknown): PassportBatch {
  const row = record(value)
  for (const field of ['session_id', 'apparatus', 'worker_ref', 'worker_role', 'worker_display_name', 'executor_name', 'label_item_code', 'label_item_name', 'status', 'action', 'uom']) if (typeof row[field] !== 'string') return invalid()
  for (const field of ['current_apparatus', 'current_location', 'next_apparatus', 'parent_batch_id', 'used_by_session_id', 'used_by_apparatus', 'processed_by_session_id', 'processed_by_apparatus', 'description']) if (row[field] !== undefined && typeof row[field] !== 'string') return invalid()
  for (const field of optionalMeasures) if (row[field] != null) number(row[field])
  integer(row.started_at_unix); integer(row.completed_at_unix)
  if (!['waiting', 'in_use', 'processed'].includes(required(row.wip_status))) return invalid()
  return { ...row, batch_id: required(row.batch_id), revision: integer(row.revision, 1), order_id: required(row.order_id), qr_payload: required(row.qr_payload), apparatus: required(row.apparatus), session_id: text(row.session_id), worker_ref: text(row.worker_ref), produced_qty: number(row.produced_qty), uom: text(row.uom), wip_status: row.wip_status as string, status: row.status as string, action: row.action as string, payload_json: record(row.payload_json), description: text(row.description) }
}
function batchIdentity(batch: Row): unknown { return ['batch_id', 'order_id', 'qr_payload', 'session_id', 'apparatus', 'action', 'worker_ref', 'worker_role', 'worker_display_name', 'executor_name', 'label_item_code'].map(key => batch[key] ?? '') }
function protectedBatch(batch: PassportBatch): unknown { return Object.fromEntries(Object.entries(batch).filter(([key]) => !['revision', 'payload_json', 'parent_batch_id', 'status_detail', 'description', 'produced_qty', 'uom', ...optionalMeasures].includes(key))) }
function correctionValues(batch: Row): Row { return { produced_qty: batch.produced_qty, uom: text(batch.uom), description: text(batch.description), ...Object.fromEntries(optionalMeasures.map(key => [key, batch[key] ?? null])) } }
function sameValues(batch: Row, body: Row): boolean { return Object.entries(correctionValues(body)).every(([key, expected]) => typeof expected === 'number' ? sameNumber(batch[key], expected) : (batch[key] ?? (key === 'description' ? '' : null)) === expected) }
function validateBound(batch: Row, identity: PassportIdentity): void { if (batch.batch_id !== identity.batchId || batch.order_id !== identity.orderId || identity.qr && batch.qr_payload !== identity.qr) return invalid('Pasport tanlangan rulon, QR yoki buyurtmaga mos emas.') }
export function parseProgressPassport(value: unknown, identity: PassportIdentity): ProgressPassport {
  const report = record(value), batch = parsePassportBatch(report.scanned_batch)
  if (identity.kind !== 'wip' || report.ok !== true || report.history_scope !== 'batch_lineage' || typeof report.lineage_complete !== 'boolean' || typeof report.is_stale !== 'boolean' || typeof report.stale_reason !== 'string') return invalid()
  validateBound(batch, identity)
  const batches = rows(report.progress_batches).map(parsePassportBatch), currentBatches = rows(report.current_batches).map(parsePassportBatch)
  if (!batches.some(entry => entry.batch_id === batch.batch_id) || new Set(batches.map(entry => entry.batch_id)).size !== batches.length || new Set(currentBatches.map(entry => entry.batch_id)).size !== currentBatches.length || [...batches, ...currentBatches].some(entry => entry.order_id !== identity.orderId) || currentBatches.some(entry => !batches.some(saved => stable(saved) === stable(entry)))) return invalid()
  if (stable(batches.find(entry => entry.batch_id === batch.batch_id)) !== stable(batch)) return invalid()
  if (report.order != null && record(report.order).id !== identity.orderId) return invalid()
  if (!Object.hasOwn(report, 'current_batch') || (report.current_batch == null) !== (currentBatches.length !== 1)) return invalid()
  if (report.current_batch != null) { const current = parsePassportBatch(report.current_batch); if (currentBatches.length !== 1 || stable(current) !== stable(currentBatches[0])) return invalid() }
  const ids = new Set(batches.map(entry => entry.batch_id)), lineageEdges = rows(report.lineage_edges)
  if (lineageEdges.some(edge => !ids.has(required(edge.parent_batch_id)) || !ids.has(required(edge.child_batch_id)) || edge.parent_batch_id === edge.child_batch_id) || new Set(lineageEdges.map(edge => stable(edge))).size !== lineageEdges.length) return invalid()
  const indegrees = new Map([...ids].map(id => [id, 0])), children = new Map<string, string[]>()
  for (const edge of lineageEdges) { const parent = edge.parent_batch_id as string, child = edge.child_batch_id as string; indegrees.set(child, indegrees.get(child)! + 1); children.set(parent, [...children.get(parent) ?? [], child]) }
  const ready = [...ids].filter(id => indegrees.get(id) === 0); let visited = 0
  while (visited < ready.length) { for (const child of children.get(ready[visited++]) ?? []) { const count = indegrees.get(child)! - 1; indegrees.set(child, count); if (count === 0) ready.push(child) } }
  if (visited !== ids.size) return invalid('Lineage bog‘lanishlari sikl hosil qilgan.')
  const corrections = rows(report.corrections).map(row => {
    const oldValues = parsePassportBatch(row.old_values), newValues = parsePassportBatch(row.new_values), actor = record(row.actor), previous = integer(row.previous_revision, 1), revision = integer(row.new_revision, 2)
    if (revision !== previous + 1 || row.batch_id !== oldValues.batch_id || row.batch_id !== newValues.batch_id || !ids.has(required(row.batch_id)) || oldValues.order_id !== identity.orderId || newValues.order_id !== identity.orderId || oldValues.revision !== previous || newValues.revision !== revision) return invalid()
    required(actor.ref); required(actor.role); if (typeof actor.display_name !== 'string') return invalid()
    return { ...row, batch_id: required(row.batch_id), previous_revision: previous, new_revision: revision, reason: required(row.reason), actor, old_values: oldValues, new_values: newValues, created_at_unix: integer(row.created_at_unix) }
  })
  const sessions = rows(report.run_sessions), active = rows(report.active_sessions), resources = rows(report.session_resources), logs = rows(report.logs)
  if ([...sessions, ...active, ...logs].some(entry => entry.order_id !== identity.orderId) || sessions.some(entry => !text(entry.session_id)) || new Set(sessions.map(entry => entry.session_id)).size !== sessions.length || active.some(entry => !sessions.some(session => session.session_id === entry.session_id))) return invalid()
  for (const resource of resources) { if (!sessions.some(session => session.session_id === resource.session_id) || typeof resource.raw_materials_available !== 'boolean' || typeof resource.qolip_available !== 'boolean' || !Array.isArray(resource.qolip_codes) || resource.qolip_codes.some(code => typeof code !== 'string') || !Array.isArray(resource.raw_materials)) return invalid(); rows(resource.raw_materials).forEach(material => { required(material.barcode); required(material.item_code); if (material.source_qty != null) number(material.source_qty) }) }
  return { kind: 'wip', identity: { ...identity, qr: batch.qr_payload }, batch, batches, currentBatches, corrections, lineageEdges, lineageComplete: report.lineage_complete, stale: report.is_stale, staleReason: report.stale_reason, sessions, resources, logs, orderStatus: report.order_status == null ? {} : record(report.order_status), ownership: 'unconfirmed' }
}
export function parseOpeningPassport(value: unknown, identity: PassportIdentity): OpeningPassport {
  const result = record(value); if (identity.kind !== 'opening-wip' || result.ok !== true) return invalid()
  const saved = parseOpeningWipRecord(result.record), matching = saved.batches.filter(batch => batch.batch_id === identity.batchId)
  if (saved.intake.status !== 'confirmed' || saved.batches.length !== 1 || matching.length !== 1 || matching[0].wip_status === 'void') return invalid()
  const batch = matching[0]; validateBound(batch, identity)
  if (!['waiting', 'in_use', 'processed'].includes(batch.wip_status) || !['measured', 'estimated', 'unknown'].includes(batch.quantity_basis)) return invalid()
  return { kind: 'opening-wip', identity: { ...identity, qr: batch.qr_payload }, batch, intake: saved.intake }
}
export function passportCorrectionIssue(passport: Passport, session: Session | null | undefined): string {
  if (passport.kind !== 'wip') return 'Boshlang‘ich WIP uchun correction API mavjud emas.'
  if (!passportPermissions(session).correct) return 'Tahrirlash uchun joriy hisob va native ruxsat kerak.'
  if (passport.batch.payload_json.origin === 'layer_remainder') return 'Qaytgan qatlam xomashyo hisobiga tegishli; progress correction qulflangan.'
  if (passport.batch.payload_json.training === true || passport.batch.order_id.startsWith('training-')) return 'O‘quv ruloni production correction endpointiga yuborilmaydi.'
  if (passport.ownership === 'unconfirmed') return 'Tahrir faqat rulon egasiga ruxsat etiladi. Admin roli egalikni almashtirmaydi; egalik tasdiqlanmadi.'
  if (passport.stale || passport.batch.wip_status !== 'waiting' || ['used_by_session_id', 'processed_by_session_id', 'used_by_apparatus', 'processed_by_apparatus'].some(key => text(passport.batch[key]))) return 'Ishlatilgan, almashtirilgan yoki kutmayotgan rulon tahrirlanmaydi.'
  const status = passport.batch.action === 'pause' ? 'paused' : passport.batch.action === 'detach_roll' ? 'roll_detached' : ['roll_complete', 'complete'].includes(passport.batch.action) ? 'completed' : ''
  if (!isCanonicalApparatusId(passport.batch.apparatus) || passport.batch.status !== status || !status) return 'Rulon turi yoki ish holati tasdiqlanmagan.'
  return ''
}
export function passportForm(batch: PassportBatch): PassportForm { return { produced_qty: String(batch.produced_qty), uom: batch.uom, measures: Object.fromEntries(optionalMeasures.map(key => [key, batch[key] == null ? '' : String(batch[key])])) as PassportForm['measures'], description: batch.description, reason: '' } }
function inputNumber(raw: string, label: string, optional = false): number | null { const value = raw.trim().replace(',', '.'); if (!value && optional) return null; const result = Number(value); if (!/^\d+(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(result) || result <= 0 || !Number.isSafeInteger(Math.round(result * 1_000_000))) throw new Error(`${label}: musbat son, eng ko‘p 6 kasr xonasi kiriting. Ixtiyoriy maydonni bo‘sh qoldirish uni tozalaydi.`); return result }
export function passportCorrectionOperation(passport: ProgressPassport, session: Session, form: PassportForm): Extract<PassportOperation, { kind: 'correct' }> {
  const issue = passportCorrectionIssue(passport, session); if (issue) throw new Error(issue)
  const reason = form.reason.trim(), description = form.description.trim(), uom = form.uom.trim()
  if (!reason || !uom || /[\u0000-\u001f\u007f]/u.test(`${reason}${description}${uom}`)) throw new Error('Sabab va o‘lchov birligini kiriting; boshqaruv belgilaridan foydalanmang.')
  const body: PassportCorrectionBody = { batch_id: passport.batch.batch_id, expected_revision: passport.batch.revision, produced_qty: inputNumber(form.produced_qty, 'Miqdor')!, uom, ...Object.fromEntries(optionalMeasures.map(key => [key, inputNumber(form.measures[key], passportMeasureLabels[key], true)])), description, reason }
  const oldKg = passport.batch.finished_goods_kg ?? null, newKg = body.finished_goods_kg ?? null, changedKg = stable(oldKg) !== stable(newKg), gross = changedKg ? newKg : passport.batch.payload_json.gross_qty ?? oldKg
  if (typeof gross === 'number' && typeof body.bobina_kg === 'number' && rounding(body.bobina_kg) > rounding(gross)) throw new Error('Bobina / tara saqlanadigan gross vazndan oshmasligi kerak.')
  if (sameValues(passport.batch, body)) throw new Error('Qiymatlar o‘zgarmagan. Sababning o‘zi yangi correction yaratmaydi.')
  return { kind: 'correct', id: crypto.randomUUID(), baseline: structuredClone(passport), body }
}
export function passportPrintIssue(passport: Passport, session: Session | null | undefined): string {
  const permissions = passportPermissions(session)
  if (!(passport.kind === 'wip' ? permissions.progressPrint : permissions.openingPrint)) return 'Saqlangan yorliqni chiqarish uchun ruxsat berilmagan.'
  if (!passport.identity.qr || passport.kind === 'opening-wip' && (passport.intake.status !== 'confirmed' || passport.batch.wip_status === 'void')) return 'Saqlangan QR yoki qabul holati tasdiqlanmagan.'
  if (passport.kind === 'wip') {
    if (passport.batch.payload_json.origin === 'layer_remainder') return 'Qaytgan qatlam yorlig‘i alohida native jarayonga tegishli.'
    if (!['admin', 'werka', 'aparatchi'].includes(session?.profile.role ?? '') && text(session?.profile.ref) !== passport.batch.worker_ref) return 'Native reprint qoidasi bu hisobga rulonni chiqarishga ruxsat bermaydi.'
  }
  const apparatus = passport.kind === 'wip' ? passport.batch.apparatus : passport.intake.source_apparatus || passport.intake.entry_apparatus
  if (!isCanonicalApparatusId(apparatus) || !text(passport.batch.label_item_code)) return 'Yorliqning saqlangan mahsulot yoki apparat identifikatori tasdiqlanmagan.'
  return ''
}
export function passportPrintOperation(passport: Passport, session: Session, form: PassportPrintForm): Extract<PassportOperation, { kind: 'print' }> {
  const issue = passportPrintIssue(passport, session); if (issue) throw new Error(issue)
  if (!['offline', 'server'].includes(form.transport) || !/^\d+$/.test(form.count.trim()) || Number(form.count) < 1 || Number(form.count) > 100) throw new Error('Transport va nusxa sonini tekshiring (1–100, mobil chegara).')
  const driver = form.driverUrl.trim().replace(/\/+$/, ''), printer = form.printer.trim().toLowerCase(), mode = form.mode.trim().toLowerCase()
  if (!printer || !mode || /[\u0000-\u001f\u007f]/u.test(`${printer}${mode}`)) throw new Error('Printer va bosma rejimini kiriting.')
  if (driver) { let url: URL; try { url = new URL(driver) } catch { throw new Error('Drayver manzili HTTP(S) manzil bo‘lishi kerak.') } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Drayver manzili HTTP(S), maxfiy kirish yoki fragmentsiz bo‘lishi kerak.') }
  return { kind: 'print', id: crypto.randomUUID(), baseline: structuredClone(passport), form: { ...form, driverUrl: driver, printer, mode }, body: { [passport.kind === 'wip' ? 'progress_batch_id' : 'batch_id']: passport.identity.batchId, qr_payload: passport.identity.qr, ...(driver && form.transport === 'server' ? { driver_url: driver } : {}), ...(form.transport === 'offline' ? { print_transport: 'offline' } : {}), printer, print_mode: mode, print_count: Number(form.count) } }
}
function matchingCorrection(report: ProgressPassport, operation: Extract<PassportOperation, { kind: 'correct' }>, session: Session): PassportBatch | null {
  const matches = report.corrections.filter(entry => entry.batch_id === operation.body.batch_id && entry.previous_revision === operation.body.expected_revision && entry.new_revision === operation.body.expected_revision + 1 && entry.reason === operation.body.reason && entry.actor.ref === session.profile.ref && sameValues(entry.old_values, operation.baseline.batch) && sameValues(entry.new_values, operation.body) && stable(batchIdentity(entry.new_values)) === stable(batchIdentity(operation.baseline.batch)) && stable(protectedBatch(entry.new_values)) === stable(protectedBatch(entry.old_values)) && (entry.new_values.parent_batch_id ?? '') === (entry.old_values.parent_batch_id ?? ''))
  return matches.length === 1 && report.batch.revision >= matches[0].new_revision ? matches[0].new_values : null
}
function validateCorrectionBatch(batch: PassportBatch, operation: Extract<PassportOperation, { kind: 'correct' }>): void {
  if (batch.revision !== operation.body.expected_revision + 1 || stable(protectedBatch(batch)) !== stable(protectedBatch(operation.baseline.batch)) || !sameValues(batch, operation.body) || !sameValues(batch.payload_json, operation.body) || batch.payload_json.correction_revision !== batch.revision) return invalid('Saqlangan correction revisioni yoki himoyalangan rulon qiymatlari mos emas.')
  const writablePayload = ['produced_qty', 'uom', 'description', 'correction_revision', ...optionalMeasures], changedKg = stable(batch.finished_goods_kg ?? null) !== stable(operation.baseline.batch.finished_goods_kg ?? null)
  if (changedKg) writablePayload.push('gross_qty')
  const retainedPayload = (payload: Row) => Object.fromEntries(Object.entries(payload).filter(([key]) => !writablePayload.includes(key)))
  if (stable(retainedPayload(batch.payload_json)) !== stable(retainedPayload(operation.baseline.batch.payload_json))) return invalid('Correction himoyalangan resurs yoki gross ma’lumotini o‘zgartirgan.')
  if (changedKg && (batch.payload_json.gross_qty ?? null) !== (batch.finished_goods_kg ?? null)) return invalid()
}
function printReceipt(value: unknown, operation: Extract<PassportOperation, { kind: 'print' }>, current: Passport): PassportPrintResult {
  const result = record(value), batch = current.kind === 'wip' ? parsePassportBatch(result.batch) : parseOpeningWipBatch(result.batch)
  validateBound(batch, current.identity)
  if (stable(batch) !== stable(current.batch)) return invalid('Printer javobi boshqa yoki o‘zgargan saqlangan rulonga tegishli.')
  const print = record(result.print)
  if (result.ok === false && print.ok === false && print.status === 'failed' && text(print.code)) throw new PassportPrintFailure(text(print.code), text(print.error) || 'Printer xatosi.')
  const expected = operation.form.transport === 'offline' ? 'prepared' : 'printed'
  if (result.ok !== true || print.ok !== true || print.status !== expected || print.qr_payload !== current.identity.qr || print.item_code !== current.batch.label_item_code || print.label_kind !== 'progress' || print.print_count !== Number(operation.form.count) || !text(print.item_name) || !text(print.printer) || !text(print.print_mode) || !text(print.printer_status) || expected === 'prepared' && (print.printer_status !== 'client_usb_pending' || print.printer !== operation.form.printer || print.print_mode !== operation.form.mode)) return invalid('Yorliqning QR, nusxa yoki tasdiqlangan bosma holati mos emas.')
  const apparatus = current.kind === 'wip' ? current.batch.apparatus : current.intake.source_apparatus || current.intake.entry_apparatus
  const gross = current.kind === 'wip' ? current.batch.payload_json.gross_qty ?? current.batch.finished_goods_kg ?? current.batch.produced_qty : current.batch.finished_goods_kg ?? 0
  const progress = current.batch.finished_goods_meter ?? (current.kind === 'wip' ? current.batch.produced_qty : 0), qty = typeof progress === 'number' && progress > 0 ? progress : gross
  const tare = current.batch.bobina_kg ?? 0
  if (print.apparatus !== apparatus || !sameNumber(print.gross_qty, gross) || !sameNumber(print.qty, qty) || print.unit !== 'kg' || print.progress_unit !== (current.kind === 'wip' ? current.batch.uom || 'm' : 'm') || !sameNumber(print.tare_kg, typeof tare === 'number' && tare > 0 && typeof gross === 'number' ? Math.min(tare, gross) : 0) || print.tare_enabled !== (typeof tare === 'number' && tare > 0)) return invalid('Printer yorlig‘idagi saqlangan o‘lchov va apparat qiymatlari mos emas.')
  return { kind: 'print', passport: current, print, outcome: expected }
}

export class ProgressPassportApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = structuredClone(session) }
  private authorize(): void { if (!passportPermissions(this.session).read) throw new ApiError(403, 'forbidden') }
  async read(identity: PassportIdentity, signal?: AbortSignal): Promise<Passport> {
    this.authorize(); abort(signal)
    if (!identity.batchId || !identity.orderId || identity.kind === 'opening-wip' && !identity.qr) throw new Error('Saqlangan rulon va buyurtma identifikatorini tanlang.')
    if (identity.kind === 'opening-wip') return parseOpeningPassport(await this.client.post(`${base}/opening-wip/qr-report`, { qr_payload: identity.qr }, signal), identity)
    const passport = parseProgressPassport(await this.client.post(`${base}/progress-qr/report`, { progress_batch_id: identity.batchId, ...(identity.qr ? { qr_payload: identity.qr } : {}) }, signal), identity)
    if (text(this.session.profile.ref) && passport.batch.worker_ref === this.session.profile.ref) passport.ownership = 'direct'
    else if (passportPermissions(this.session).correct) {
      try {
        const history = record(await this.client.get(`${base}/progress-qr/history`, { worker_ref: this.session.profile.ref!, limit: 200 }, signal)); if (history.ok !== true) return invalid()
        const batches = rows(history.batches).map(parsePassportBatch); if (batches.length > 200 || new Set(batches.map(batch => batch.batch_id)).size !== batches.length) return invalid()
        if (batches.some(batch => stable(batchIdentity(batch)) === stable(batchIdentity(passport.batch)))) passport.ownership = 'history'
      } catch (error) { abort(signal); passport.ownershipError = progressPassportError(error) }
    }
    return passport
  }
  async execute(operation: PassportOperation, signal?: AbortSignal, onDispatch?: () => void): Promise<PassportResult> {
    this.authorize(); abort(signal)
    const current = await this.read(operation.baseline.identity, signal); abort(signal)
    if (operation.kind === 'correct') {
      if (current.kind !== 'wip') throw new Error('Bu rulon correction endpointiga tegishli emas.')
      const issue = passportCorrectionIssue(current, this.session); if (issue) throw new PassportConflict(issue, current)
      if (stable(current.batch) !== stable(operation.baseline.batch)) throw new PassportConflict('Rulon revisioni, holati yoki miqdori o‘zgargan. Joriy pasportni yuklang.', current)
      const supported = ['batch_id', 'expected_revision', 'produced_qty', 'uom', 'description', 'reason', ...optionalMeasures]
      if (Object.keys(operation.body).some(key => !supported.includes(key)) || operation.body.batch_id !== current.batch.batch_id || operation.body.expected_revision !== current.batch.revision) throw new Error('Correction tanlangan rulon va revisionga mos emas.')
      passportCorrectionOperation(current, this.session, { produced_qty: String(operation.body.produced_qty), uom: operation.body.uom, description: operation.body.description, reason: operation.body.reason, measures: Object.fromEntries(optionalMeasures.map(key => [key, operation.body[key] == null ? '' : String(operation.body[key])])) as PassportForm['measures'] })
    } else {
      const issue = passportPrintIssue(current, this.session); if (issue) throw new PassportConflict(issue, current)
      if (stable(current.batch) !== stable(operation.baseline.batch) || current.kind === 'opening-wip' && operation.baseline.kind === 'opening-wip' && stable(current.intake) !== stable(operation.baseline.intake)) throw new PassportConflict('Saqlangan yorliq ma’lumoti o‘zgargan. Joriy pasportni yuklang.', current)
      if (stable(passportPrintOperation(current, this.session, operation.form).body) !== stable(operation.body)) throw new Error('Yorliq so‘rovi ko‘rib chiqilgan saqlangan rulonga mos emas.')
    }
    abort(signal)
    try {
      onDispatch?.()
      if (operation.kind === 'print') return printReceipt(await this.client.post(`${base}/${current.kind === 'wip' ? 'progress-qr/reprint' : 'opening-wip/print'}`, operation.body, signal), operation, current)
      const result = record(await this.client.post(`${base}/progress-qr/correct`, operation.body, signal)); if (result.ok !== true) return invalid()
      validateCorrectionBatch(parsePassportBatch(result.batch), operation)
      const after = await this.read(current.identity, signal); if (after.kind !== 'wip') return invalid()
      const correctedBatch = matchingCorrection(after, operation, this.session); if (!correctedBatch) return invalid('Correctionning native audit yozuvi tasdiqlanmadi.')
      validateCorrectionBatch(correctedBatch, operation)
      return { kind: 'correct', passport: after, correctedBatch, recovered: false }
    } catch (error) { abort(signal); if (uncertain(error)) throw new PassportUnknown(operation); throw error }
  }
  async recover(operation: PassportOperation, signal?: AbortSignal): Promise<PassportCorrectionResult> {
    this.authorize(); abort(signal)
    try {
      const current = await this.read(operation.baseline.identity, signal)
      if (operation.kind === 'print') throw new PassportUnknown(operation, 'Saqlangan rulon tekshirildi. API fizik bosma holatini o‘qimaydi; printer natijasini qo‘lda tekshirish kerak. So‘rov takrorlanmadi.', current)
      if (current.kind !== 'wip') return invalid()
      const correctedBatch = matchingCorrection(current, operation, this.session)
      if (!correctedBatch) throw new PassportUnknown(operation, 'Avvalgi correctionning aynan mos audit yozuvi tasdiqlanmadi. Bu saqlanmaganini isbotlamaydi; so‘rov takrorlanmaydi.', current)
      validateCorrectionBatch(correctedBatch, operation)
      return { kind: 'correct', passport: current, correctedBatch, recovered: true }
    } catch (error) { abort(signal); if (error instanceof PassportUnknown) throw error; throw new PassportUnknown(operation, `${progressPassportError(error)} Avvalgi so‘rov natijasi noma’lum.`) }
  }
}
export function progressPassportError(error: unknown): string {
  if (error instanceof ApiError) { const messages: Record<string, string> = { progress_batch_correction_locked: 'Ishlatilgan yoki qaytgan qatlam ruloni tahrirlanmaydi.', progress_batch_correction_forbidden: 'Bu rulon joriy hisobga tegishli emas.', progress_batch_correction_conflict: 'Rulon revisioni boshqa joyda o‘zgargan. Joriy nusxani yuklang.', progress_batch_correction_unchanged: 'Correction qiymatlari o‘zgarmagan.', progress_batch_correction_reason_required: 'Correction sababini kiriting.', progress_batch_not_found: 'Saqlangan rulon yoki QR topilmadi.', opening_wip_qr_not_found: 'Boshlang‘ich WIP QR topilmadi yoki bekor qilingan.', bobina_exceeds_gross: 'Bobina / tara gross vazndan oshmasligi kerak.', progress_input_invalid: 'Miqdor yoki pasport maydonlari native talablarga mos emas.' }; return messages[error.code] ?? error.message }
  return error instanceof Error ? error.message : 'Rulon pasporti amali bajarilmadi.'
}

export interface PassportTicket { context: string; serial: number; operation: PassportOperation; recovery: boolean }
interface RetainedPassportAttempt { serial: number; operation: PassportOperation; phase: 'checking' | 'dispatched' | 'unknown'; recovery: boolean }
/** Session/record-scoped RAM only. Closing/unmounting never replays a dispatched mutation. */
export class PassportDraftLedger {
  private serial = 0
  private drafts = new Map<string, PassportForm>()
  private draftBases = new Map<string, ProgressPassport>()
  private attempts = new Map<string, RetainedPassportAttempt>()
  draft(context: string): PassportForm | undefined { const value = this.drafts.get(context); return value ? structuredClone(value) : undefined }
  draftBase(context: string): ProgressPassport | undefined { const value = this.draftBases.get(context); return value ? structuredClone(value) : undefined }
  saveDraft(context: string, value: PassportForm, baseline?: ProgressPassport): void { this.drafts.set(context, structuredClone(value)); if (baseline) this.draftBases.set(context, structuredClone(baseline)) }
  attempt(context: string): Readonly<RetainedPassportAttempt> | undefined { return this.attempts.get(context) }
  begin(context: string, operation: PassportOperation, recovery = false): PassportTicket {
    const existing = this.attempts.get(context)
    if (existing && !(recovery && existing.phase === 'unknown' && existing.operation.id === operation.id)) throw new Error('Bu rulonning avvalgi so‘rov natijasi hali tasdiqlanmagan.')
    const serial = ++this.serial; this.attempts.set(context, { serial, operation, phase: 'checking', recovery }); return { context, serial, operation, recovery }
  }
  dispatch(ticket: PassportTicket): void { const value = this.attempts.get(ticket.context); if (value?.serial === ticket.serial) value.phase = 'dispatched' }
  finish(ticket: PassportTicket): boolean { if (this.attempts.get(ticket.context)?.serial !== ticket.serial) return false; this.attempts.delete(ticket.context); if (ticket.operation.kind === 'correct') { this.drafts.delete(ticket.context); this.draftBases.delete(ticket.context) } return true }
  fail(ticket: PassportTicket, error: unknown): void { const value = this.attempts.get(ticket.context); if (value?.serial !== ticket.serial) return; if (ticket.recovery || value.phase === 'unknown' || error instanceof PassportUnknown || value.phase === 'dispatched' && error instanceof DOMException && error.name === 'AbortError') value.phase = 'unknown'; else this.attempts.delete(ticket.context) }
  interrupt(ticket: PassportTicket): void { const value = this.attempts.get(ticket.context); if (value?.serial !== ticket.serial) return; if (value.phase === 'dispatched' || value.recovery) value.phase = 'unknown'; else this.attempts.delete(ticket.context) }
  acknowledgePrint(context: string): void { const value = this.attempts.get(context); if (value?.phase === 'unknown' && value.operation.kind === 'print') this.attempts.delete(context) }
  discardDraft(context: string): void { if (!this.attempts.has(context)) { this.drafts.delete(context); this.draftBases.delete(context) } }
}
