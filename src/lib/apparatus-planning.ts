import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { meetsRequirement } from './permissions'
import { productionOrderControlState } from './production-controls'

const base = '/v1/mobile/admin/production-maps'
const u32 = 4_294_967_295
const hashPattern = /^[a-f0-9]{64}$/
export const planningWeekdays = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'] as const
export const planningPolicyLabels = { strict_sequence: 'Qat’iy navbat', free_pick: 'Tayyor buyurtmani erkin tanlash' } as const
export type PlanningDiscipline = keyof typeof planningPolicyLabels

/** The current handler exposes configuration only, despite older mobile snapshot models. */
export const APPARATUS_PLANNING_API_LIMITATIONS = [
  'API ish to‘xtashi va jadval bandlari tarixini qaytarmaydi. Faqat shu oynada server tasdiqlagan yozuvlar ko‘rsatiladi.',
  'Jadval uchun serverda oldindan tekshirish API mavjud emas. Bandlik saqlash vaqtida tekshiriladi; server so‘ralgan oraliqda keyingi mos vaqtni tanlashi mumkin.',
  'Ish to‘xtashi va bandni bekor qilishda revision sharti yo‘q. Ish to‘xtashi natijasini alohida o‘qib tekshirish API mavjud emas.',
  'Tezlik, ishlab chiqarish miqdori va uning o‘lchov birligini o‘zgartirish capacity API tomonidan qo‘llab-quvvatlanmaydi.',
  'Bosma apparat navbati mobil qoidaga ko‘ra tahrirdan qulflangan. Joriy queue-policies GET qulflash maydonini qaytarmaydi; web haqiqiy saqlangan siyosatni ko‘rsatadi.',
] as const

export interface PlanningWindow { weekday: number; start_minute: number; end_minute: number }
export interface PlanningCapacity {
  capacity_slots: number
  setup_minutes: number
  cleanup_minutes: number
  efficiency_percent: number
  finite_capacity: boolean
  availability: { mode: 'always' } | { mode: 'scheduled'; working_windows: PlanningWindow[] }
}
export interface PlanningSource { apparatus_id: string; source_revision: number; source_aasx_sha256: string }
export interface PlanningApparatus extends PlanningSource { name: string; operation: string; active: boolean; capabilities: Record<string, number> }
export interface PlanningCapacityProjection extends PlanningSource, Omit<PlanningCapacity, 'availability'> { always_available: boolean; working_windows: PlanningWindow[] }
export interface PlanningQueueProjection extends PlanningSource { discipline: PlanningDiscipline }
export interface ApparatusPlanningSnapshot { apparatus: PlanningApparatus; capacity: PlanningCapacityProjection; policy: PlanningQueueProjection }
export interface PlanningCapacityForm {
  slots: string; setup: string; cleanup: string; efficiency: string; finite: boolean; scheduled: boolean
  windows: { key: string; weekday: string; start: string; end: string }[]
}
export interface PlanningDowntime {
  id: string; apparatus_id: string; apparatus: string; starts_at_unix: number; ends_at_unix: number
  reason: string; active: boolean; actor: Row; created_at_unix: number
}
export interface PlanningRequirement { code: string; min_level: number }
export interface PlanningReservation {
  reservation_id: string; idempotency_key: string; order_id: string; apparatus_id: string; apparatus: string
  starts_at_unix: number; ends_at_unix: number; requested_duration_minutes: number; reserved_duration_minutes: number
  status: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled'; priority: number; source: string; reason: string
  capability_requirements: PlanningRequirement[]; actor: Row; created_at_unix: number
}
export interface PlanningConflictRecord { reservation_id: string; order_id: string; starts_at_unix: number; ends_at_unix: number; detail: string }
export interface PlanningScheduleResult { reservation: PlanningReservation; conflicts: PlanningConflictRecord[]; operation: PlanningScheduleOperation }
export interface PlanningPatchOperation {
  kind: 'capacity' | 'policy'; apparatusId: string; expectedRevision: number; key: string
  baseline: ApparatusPlanningSnapshot; capacity?: PlanningCapacity; discipline?: PlanningDiscipline
}
export interface PlanningDowntimeOperation { kind: 'downtime'; method: 'POST' | 'PUT'; body: PlanningDowntime }
export interface PlanningScheduleOperation {
  kind: 'schedule'; apparatusId: string; expectedRevision: number; expectedReservedMinutes: number; orderFingerprint: string
  body: { order_id: string; apparatus_id: string; apparatus: string; earliest_start_unix: number; latest_end_unix: number; duration_minutes: number; priority: number; source: string; reason: string; idempotency_key: string; capability_requirements: PlanningRequirement[]; candidate_apparatuses: never[] }
}
export interface PlanningCancelOperation { kind: 'cancel'; original: PlanningScheduleResult; reason: string }
export type PlanningOperation = PlanningPatchOperation | PlanningDowntimeOperation | PlanningScheduleOperation | PlanningCancelOperation

export class PlanningConflict extends Error {
  readonly current?: ApparatusPlanningSnapshot
  constructor(message: string, current?: ApparatusPlanningSnapshot) { super(message); this.name = 'PlanningConflict'; this.current = current }
}
export class PlanningSaveUnknown extends Error {
  readonly operation: PlanningOperation
  constructor(operation: PlanningOperation, message = 'Serverdagi natija tasdiqlanmadi. Yangi yozuv yuborishdan oldin aynan shu amalning natijasini tekshiring.') {
    super(message)
    this.name = 'PlanningSaveUnknown'; this.operation = operation
  }
}

function invalid(message = 'Rejalashtirish javobi to‘liq yoki mos holda kelmadi. Ma’lumotni yangilang.'): never { throw new ApiError(502, 'invalid_response', message) }
function string(value: unknown, empty = false): string { if (typeof value !== 'string' || value !== value.trim() || !empty && !value) return invalid(); return value }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(); return value }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value }
function source(value: unknown): PlanningSource {
  const row = record(value), id = string(row.apparatus_id), hash = string(row.source_aasx_sha256)
  if (!isPlanningApparatusId(id) || !hashPattern.test(hash)) return invalid()
  return { apparatus_id: id, source_revision: integer(row.source_revision, 1), source_aasx_sha256: hash }
}
export function isPlanningApparatusId(value: unknown): value is string { return typeof value === 'string' && value.length <= 128 && /^apparatus:[a-z0-9._-]+:[a-z0-9._-]+$/.test(value) }
export function planningApparatusId(row: Row): string { const value = isRecord(row.runtime_projection) ? row.runtime_projection.apparatus_id : row.apparatus_id; return isPlanningApparatusId(value) ? value : '' }
export function planningOrderId(row: Row): string { const map = isRecord(row.map) ? row.map : row; return typeof map.id === 'string' ? map.id.trim() : '' }
export function apparatusPlanningPermissions(session: Session | null | undefined) {
  const authenticated = Boolean(session?.token && session.profile.role)
  return { read: authenticated && meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'apparatus.queue.read'] }), write: authenticated && meetsRequirement(session, { any: ['admin.access', 'production.map.manage'] }) }
}
/** Mobile's isPechat guard uses canonical operation and capability, never a title. */
export function planningQueuePolicyLocked(apparatus: PlanningApparatus): boolean { return apparatus.active && apparatus.operation === 'print' && (apparatus.capabilities.print ?? 0) > 0 }
export function parsePlanningApparatus(value: unknown): PlanningApparatus {
  const row = record(value), projection = isRecord(row.runtime_projection) ? row.runtime_projection : row
  const lifecycle = string(record(projection.lifecycle).state)
  if (!['active', 'retired'].includes(lifecycle)) return invalid()
  const capabilities: Record<string, number> = {}
  for (const [code, level] of Object.entries(record(projection.capabilities))) { if (!/^[a-z][a-z0-9_]*$/.test(code)) return invalid(); capabilities[code] = integer(level, 1, 100) }
  return { ...source(projection), name: string(record(projection.display).display_name), operation: string(record(projection.execution_profile).operation), active: lifecycle === 'active', capabilities }
}
function parseWindows(value: unknown): PlanningWindow[] {
  if (!Array.isArray(value)) return invalid()
  const windows = value.map(item => { const row = record(item); const result = { weekday: integer(row.weekday, 1, 7), start_minute: integer(row.start_minute, 0, 1439), end_minute: integer(row.end_minute, 1, 1440) }; if (result.start_minute >= result.end_minute) return invalid(); return result })
  const keys = windows.map(window => `${window.weekday}:${window.start_minute}:${window.end_minute}`)
  if (new Set(keys).size !== keys.length) return invalid()
  return windows
}
export function parsePlanningCapacity(value: unknown): PlanningCapacityProjection {
  const row = record(value), windows = parseWindows(row.working_windows), always = boolean(row.always_available)
  if (always && windows.length || !always && !windows.length) return invalid()
  return { ...source(row), capacity_slots: integer(row.capacity_slots, 1, 64), setup_minutes: integer(row.setup_minutes, 0, u32), cleanup_minutes: integer(row.cleanup_minutes, 0, u32), efficiency_percent: integer(row.efficiency_percent, 1, 200), finite_capacity: boolean(row.finite_capacity), always_available: always, working_windows: windows }
}
export function parsePlanningQueuePolicy(value: unknown): PlanningQueueProjection {
  const row = record(value), discipline = string(row.discipline)
  if (discipline !== 'strict_sequence' && discipline !== 'free_pick') return invalid()
  return { ...source(row), discipline }
}
function sameSource(left: PlanningSource, right: PlanningSource): boolean { return left.apparatus_id === right.apparatus_id && left.source_revision === right.source_revision && left.source_aasx_sha256 === right.source_aasx_sha256 }
function selectSource<T extends PlanningSource>(values: T[], id: string): T {
  if (new Set(values.map(value => value.apparatus_id)).size !== values.length) return invalid()
  const value = values.find(value => value.apparatus_id === id)
  if (!value) return invalid('Aparatning amaldagi rejalashtirish profili topilmadi. Standart qiymatlar bilan almashtirib bo‘lmaydi.')
  return value
}
function capacityInput(profile: PlanningCapacityProjection): PlanningCapacity {
  return { capacity_slots: profile.capacity_slots, setup_minutes: profile.setup_minutes, cleanup_minutes: profile.cleanup_minutes, efficiency_percent: profile.efficiency_percent, finite_capacity: profile.finite_capacity, availability: profile.always_available ? { mode: 'always' } : { mode: 'scheduled', working_windows: profile.working_windows } }
}
export function planningMinuteLabel(minute: number): string { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` }
export function planningCapacityForm(profile: PlanningCapacityProjection): PlanningCapacityForm {
  return { slots: String(profile.capacity_slots), setup: String(profile.setup_minutes), cleanup: String(profile.cleanup_minutes), efficiency: String(profile.efficiency_percent), finite: profile.finite_capacity, scheduled: !profile.always_available, windows: profile.working_windows.map((window, index) => ({ key: String(index), weekday: String(window.weekday), start: planningMinuteLabel(window.start_minute), end: planningMinuteLabel(window.end_minute) })) }
}
export function planningInteger(value: string, label: string, min: number, max: number): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label}: butun son kiriting.`)
  const result = Number(value.trim()); if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${label}: ${min}–${max} oralig‘ida kiriting.`); return result
}
function minute(value: string, end: boolean): number { if (end && value === '24:00') return 1440; if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Ish vaqti HH:mm shaklida bo‘lishi kerak.'); return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) }
export function planningCapacityInput(form: PlanningCapacityForm): PlanningCapacity {
  const windows = form.scheduled ? form.windows.map(window => { const start = minute(window.start, false), end = minute(window.end, true); if (end <= start) throw new Error('Ish tugashi boshlanishdan keyin bo‘lishi kerak. Yarim tundan o‘tgan smenani ikki kunga ajrating.'); return { weekday: planningInteger(window.weekday, 'Hafta kuni', 1, 7), start_minute: start, end_minute: end } }).sort((a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute || a.end_minute - b.end_minute) : []
  if (form.scheduled && !windows.length) throw new Error('Kamida bitta ish vaqtini kiriting.')
  if (new Set(windows.map(window => JSON.stringify(window))).size !== windows.length) throw new Error('Ish vaqtlarini takrorlamang.')
  return { capacity_slots: planningInteger(form.slots, 'Parallel joylar', 1, 64), setup_minutes: planningInteger(form.setup, 'Tayyorlash, daqiqa', 0, u32), cleanup_minutes: planningInteger(form.cleanup, 'Tozalash, daqiqa', 0, u32), efficiency_percent: planningInteger(form.efficiency, 'Samaradorlik, %', 1, 200), finite_capacity: form.finite, availability: form.scheduled ? { mode: 'scheduled', working_windows: windows } : { mode: 'always' } }
}
export function planningUtcInput(unix: number): string { return new Date(unix * 1000).toISOString().slice(0, 16) }
export function planningUtcUnix(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Sana va vaqtni kiriting (UTC).')
  const parsed = Date.parse(`${value}:00Z`), result = parsed / 1000
  if (!Number.isSafeInteger(result) || result <= 0 || new Date(parsed).toISOString().slice(0, 16) !== value) throw new Error('Sana yoki vaqt noto‘g‘ri (UTC).')
  return result
}
export function planningWindowLabel(start: number, end: number): string { return `${new Date(start * 1000).toISOString().replace('T', ' ').slice(0, 16)} — ${new Date(end * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC` }
export function planningReservedMinutes(capacity: PlanningCapacityProjection | PlanningCapacity, duration: number): number {
  const result = Math.ceil(duration * 100 / capacity.efficiency_percent) + capacity.setup_minutes + capacity.cleanup_minutes
  if (!Number.isSafeInteger(result) || result < 1 || result > u32) throw new Error('Tayyorlash va tozalash bilan jami davomiylik API chegarasidan oshadi.')
  return result
}
function newKey(kind: string): string { return `web-planning:${kind}:${crypto.randomUUID()}` }
export function planningPatchOperation(snapshot: ApparatusPlanningSnapshot, input: PlanningCapacity | PlanningDiscipline): PlanningPatchOperation {
  if (!snapshot.apparatus.active || !sameSource(snapshot.apparatus, snapshot.capacity) || !sameSource(snapshot.apparatus, snapshot.policy)) throw new Error('Aparatning faol va mos revisioni talab qilinadi.')
  if (typeof input === 'string') { if (input !== 'strict_sequence' && input !== 'free_pick') throw new Error('Navbat siyosati noto‘g‘ri.'); if (planningQueuePolicyLocked(snapshot.apparatus)) throw new Error('Bosma apparat navbat siyosati mobil qoidaga ko‘ra qulflangan.'); return { kind: 'policy', apparatusId: snapshot.apparatus.apparatus_id, expectedRevision: snapshot.apparatus.source_revision, key: newKey('policy'), baseline: structuredClone(snapshot), discipline: input } }
  // Reuse the strict form validator so direct callers cannot bypass the controls.
  const projection = { ...snapshot.capacity, ...input, always_available: input.availability.mode === 'always', working_windows: input.availability.mode === 'scheduled' ? input.availability.working_windows : [] }
  const capacity = planningCapacityInput(planningCapacityForm(parsePlanningCapacity(projection)))
  return { kind: 'capacity', apparatusId: snapshot.apparatus.apparatus_id, expectedRevision: snapshot.apparatus.source_revision, key: newKey('capacity'), baseline: structuredClone(snapshot), capacity }
}
export function planningOrderPolicy(snapshot: ProductionSnapshot, orderId: string): { apparatusIds: string[]; reason: string } {
  if (!isRecord(snapshot.order_statuses) || !isRecord(snapshot.order_controls)) return { apparatusIds: [], reason: 'Buyurtmaning joriy holati to‘liq kelmadi.' }
  const maps = snapshot.maps.filter(saved => saved.map.id === orderId)
  if (maps.length !== 1) return { apparatusIds: [], reason: 'Buyurtma joriy xaritalarda topilmadi.' }
  const status = snapshot.order_statuses[orderId], control = snapshot.order_controls[orderId]
  if (!isRecord(status) || !['released', 'in_progress'].includes(typeof status.lifecycle_status === 'string' ? status.lifecycle_status : '') || !['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'waiting_next_stage', 'partially_completed'].includes(typeof status.order_status === 'string' ? status.order_status : '')) return { apparatusIds: [], reason: 'Buyurtmaning joriy holatida rejalashtirish mumkin emas.' }
  if (productionOrderControlState(snapshot, orderId) !== 'active' || isRecord(control) && control.early_close != null) return { apparatusIds: [], reason: 'Muzlatilgan, noma’lum yoki erta yopish so‘rovi bor buyurtma rejalashtirilmaydi.' }
  const nodes = maps[0].map.nodes
  if (!Array.isArray(nodes) || nodes.some(node => !isRecord(node))) return { apparatusIds: [], reason: 'Buyurtma xaritasi to‘liq kelmadi.' }
  const apparatusIds = [...new Set(nodes.filter(node => node.kind === 'apparatus').map(node => node.apparatus_id).filter(isPlanningApparatusId))]
  return { apparatusIds, reason: apparatusIds.length ? '' : 'Buyurtma xaritasida canonical apparat yo‘q.' }
}
function orderFingerprint(snapshot: ProductionSnapshot, orderId: string): string { return JSON.stringify([snapshot.maps.filter(saved => saved.map.id === orderId).map(saved => saved.map), snapshot.order_statuses[orderId], snapshot.order_controls[orderId]]) }
export function planningScheduleOperation(snapshot: ApparatusPlanningSnapshot, orders: ProductionSnapshot, input: { orderId: string; start: string; end: string; duration: string; priority: string; reason: string; requirements?: PlanningRequirement[] }): PlanningScheduleOperation {
  const orderId = input.orderId.trim(), policy = planningOrderPolicy(orders, orderId), apparatus = snapshot.apparatus
  if (!apparatus.active || !policy.apparatusIds.includes(apparatus.apparatus_id)) throw new Error(policy.reason || 'Tanlangan apparat buyurtmaning joriy xaritasiga tegishli emas.')
  const duration = planningInteger(input.duration, 'Davomiylik, daqiqa', 1, 43_200), start = planningUtcUnix(input.start), end = planningUtcUnix(input.end)
  if (end <= start || start + planningReservedMinutes(snapshot.capacity, duration) * 60 > end) throw new Error('Band qilish uchun vaqt oralig‘i yetarli emas. Tayyorlash, tozalash va samaradorlikni hisobga oling.')
  const requirements = (input.requirements ?? []).map(item => { const level = integer(item.min_level, 1, 100), code = string(item.code); if ((apparatus.capabilities[code] ?? 0) < level) throw new Error('Aparat imkoniyati yoki uning darajasi talabga mos emas.'); return { code, min_level: level } })
  if (new Set(requirements.map(item => item.code)).size !== requirements.length) throw new Error('Imkoniyat talablarini takrorlamang.')
  const priority = input.priority.trim(); if (!/^-?\d+$/.test(priority) || !Number.isSafeInteger(Number(priority)) || Number(priority) < -2_147_483_648 || Number(priority) > 2_147_483_647) throw new Error('Ustuvorlik butun i32 son bo‘lishi kerak.')
  return { kind: 'schedule', apparatusId: apparatus.apparatus_id, expectedRevision: apparatus.source_revision, expectedReservedMinutes: planningReservedMinutes(snapshot.capacity, duration), orderFingerprint: orderFingerprint(orders, orderId), body: { order_id: orderId, apparatus_id: apparatus.apparatus_id, apparatus: apparatus.name, earliest_start_unix: start, latest_end_unix: end, duration_minutes: duration, priority: Number(priority), source: 'web_apparatus_planning', reason: input.reason.trim(), idempotency_key: newKey('schedule'), capability_requirements: requirements, candidate_apparatuses: [] } }
}
export function planningDowntimeOperation(snapshot: ApparatusPlanningSnapshot, input: { start: string; end: string; reason: string }, previous?: PlanningDowntime): PlanningDowntimeOperation {
  const starts = planningUtcUnix(input.start), ends = planningUtcUnix(input.end), reason = input.reason.trim()
  if (!snapshot.apparatus.active || ends <= starts || !reason) throw new Error('Faol apparat, tugash vaqti va ish to‘xtashi sababini kiriting.')
  if (previous && previous.apparatus_id !== snapshot.apparatus.apparatus_id) throw new Error('Ish to‘xtashi boshqa apparatga tegishli.')
  return { kind: 'downtime', method: previous ? 'PUT' : 'POST', body: { id: previous?.id ?? `apparatus-downtime:${newKey('downtime')}`, apparatus_id: snapshot.apparatus.apparatus_id, apparatus: snapshot.apparatus.name, starts_at_unix: starts, ends_at_unix: ends, reason, active: previous?.active ?? true, actor: { role: '', ref: '', display_name: '' }, created_at_unix: previous?.created_at_unix ?? Math.floor(Date.now() / 1000) } }
}
function parseActor(value: unknown, session?: Session): Row {
  const actor = record(value); string(actor.role); string(actor.ref, true); string(actor.display_name, true)
  if (session && (actor.role !== session.profile.role || session.profile.ref && actor.ref !== session.profile.ref)) return invalid('Server boshqa foydalanuvchi nomidan natija qaytardi.')
  return actor
}
export function parsePlanningDowntime(value: unknown, operation: PlanningDowntimeOperation, session?: Session): PlanningDowntime {
  const row = record(value), body = operation.body
  for (const field of ['id', 'apparatus_id', 'starts_at_unix', 'ends_at_unix', 'reason', 'active'] as const) if (row[field] !== body[field]) return invalid('Server boshqa ish to‘xtashi yozuvini qaytardi.')
  return { id: string(row.id), apparatus_id: string(row.apparatus_id), apparatus: string(row.apparatus), starts_at_unix: integer(row.starts_at_unix, 1), ends_at_unix: integer(row.ends_at_unix, 1), reason: string(row.reason), active: boolean(row.active), actor: parseActor(row.actor, session), created_at_unix: integer(row.created_at_unix, 1) }
}
export function parsePlanningReservation(value: unknown, operation: PlanningScheduleOperation): PlanningReservation {
  const row = record(value), body = operation.body, status = string(row.status)
  if (row.reservation_id !== `apparatus-reservation:${body.idempotency_key}` || row.idempotency_key !== body.idempotency_key || row.order_id !== body.order_id || row.apparatus_id !== body.apparatus_id || row.requested_duration_minutes !== body.duration_minutes || !['planned', 'active', 'paused', 'completed', 'cancelled'].includes(status)) return invalid('Server boshqa buyurtma, apparat yoki jadval bandini qaytardi.')
  const start = integer(row.starts_at_unix, body.earliest_start_unix), end = integer(row.ends_at_unix, start + 1, body.latest_end_unix), reserved = integer(row.reserved_duration_minutes, 1, u32)
  if (end - start !== reserved * 60 || reserved !== operation.expectedReservedMinutes || row.priority !== body.priority || row.source !== body.source || !string(row.reason, true).startsWith(body.reason)) return invalid()
  const requirements = rows(row.capability_requirements).map(item => ({ code: string(item.code), min_level: integer(item.min_level, 1, 100) }))
  if (JSON.stringify(requirements) !== JSON.stringify(body.capability_requirements)) return invalid()
  return { reservation_id: string(row.reservation_id), idempotency_key: string(row.idempotency_key), order_id: string(row.order_id), apparatus_id: string(row.apparatus_id), apparatus: string(row.apparatus), starts_at_unix: start, ends_at_unix: end, requested_duration_minutes: body.duration_minutes, reserved_duration_minutes: reserved, status: status as PlanningReservation['status'], priority: body.priority, source: body.source, reason: string(row.reason, true), capability_requirements: requirements, actor: parseActor(row.actor), created_at_unix: integer(row.created_at_unix, 1) }
}
function parseScheduleResult(value: unknown, operation: PlanningScheduleOperation): PlanningScheduleResult {
  const envelope = record(value); if (envelope.ok !== true) return invalid()
  const conflicts = rows(envelope.conflicts).map(item => { const start = integer(item.starts_at_unix, 1); return { reservation_id: string(item.reservation_id), order_id: string(item.order_id), starts_at_unix: start, ends_at_unix: integer(item.ends_at_unix, start + 1), detail: string(item.detail) } })
  return { reservation: parsePlanningReservation(envelope.reservation, operation), conflicts, operation }
}
function patchMatches(snapshot: ApparatusPlanningSnapshot, operation: PlanningPatchOperation): boolean { return operation.kind === 'capacity' ? JSON.stringify(capacityInput(snapshot.capacity)) === JSON.stringify(operation.capacity) : snapshot.policy.discipline === operation.discipline }
function parsePatchReceipt(value: unknown, operation: PlanningPatchOperation, session: Session): ApparatusPlanningSnapshot {
  const payload = record(value); if (payload.ok !== true) return invalid()
  const committed = record(payload.revision), revision = record(committed.revision), metadata = record(revision.revision_metadata), apparatus = parsePlanningApparatus(committed.runtime_projection), hash = string(committed.aasx_sha256)
  if (revision.apparatus_id !== operation.apparatusId || apparatus.apparatus_id !== operation.apparatusId || metadata.revision !== operation.expectedRevision + 1 || metadata.revision !== apparatus.source_revision || metadata.command_id !== `apparatus-command:${operation.key}` || !hashPattern.test(hash) || apparatus.source_aasx_sha256 !== hash || session.profile.ref && metadata.actor_id !== `principal:${session.profile.ref}`) return invalid('Saqlangan canonical revision yoki apparat mos kelmadi.')
  const capacity = record(revision.capacity), availability = record(capacity.availability), policies = record(revision.policies)
  if (!['always', 'scheduled'].includes(String(availability.mode))) return invalid()
  const sourceFields = { apparatus_id: apparatus.apparatus_id, source_revision: apparatus.source_revision, source_aasx_sha256: hash }
  const snapshot = { apparatus, capacity: parsePlanningCapacity({ ...capacity, ...sourceFields, always_available: availability.mode === 'always', working_windows: availability.mode === 'scheduled' ? availability.working_windows : [] }), policy: parsePlanningQueuePolicy({ ...sourceFields, discipline: policies.queue }) }
  if (!patchMatches(snapshot, operation)) return invalid('Server tasdiqlagan qiymatlar yuborilgan o‘zgarishga mos kelmadi.')
  return snapshot
}
function uncertain(error: unknown): boolean { return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response' }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }

export class ApparatusPlanningApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = structuredClone(session) }
  private authorize(write = false) { const permissions = apparatusPlanningPermissions(this.session); if (!(write ? permissions.write : permissions.read)) throw new ApiError(403, 'forbidden') }
  async read(apparatusId: string, signal?: AbortSignal): Promise<ApparatusPlanningSnapshot> {
    this.authorize(); if (!isPlanningApparatusId(apparatusId)) throw new Error('Canonical apparatni tanlang.')
    const [apparatusValue, capacityValue, policyValue] = await Promise.all([this.client.get(`/v1/mobile/admin/apparatus/${encodeURIComponent(apparatusId)}`, undefined, signal), this.client.get(`${base}/capacity`, undefined, signal), this.client.get(`${base}/queue-policies`, undefined, signal)])
    checkAbort(signal)
    const apparatus = parsePlanningApparatus(apparatusValue), capacityEnvelope = record(capacityValue), policyEnvelope = record(policyValue)
    if (capacityEnvelope.ok !== true || policyEnvelope.ok !== true || apparatus.apparatus_id !== apparatusId) return invalid()
    const capacity = selectSource(rows(capacityEnvelope.capacity).map(parsePlanningCapacity), apparatusId), policy = selectSource(rows(policyEnvelope.policies).map(parsePlanningQueuePolicy), apparatusId)
    if (!sameSource(apparatus, capacity) || !sameSource(apparatus, policy)) return invalid('Aparat profillari turli revisionlardan kelgan. Ma’lumotni qayta yuklang.')
    return { apparatus, capacity, policy }
  }
  async orders(signal?: AbortSignal): Promise<ProductionSnapshot> { this.authorize(); return this.client.productionSnapshot(signal) }
  async apparatus(signal?: AbortSignal): Promise<PlanningApparatus[]> { this.authorize(); const result = rows(await this.client.get('/v1/mobile/admin/apparatus', { limit: 500 }, signal)).map(parsePlanningApparatus); if (new Set(result.map(item => item.apparatus_id)).size !== result.length) return invalid(); return result }
  async patch(operation: PlanningPatchOperation, signal?: AbortSignal): Promise<ApparatusPlanningSnapshot> {
    this.authorize(true)
    const current = await this.read(operation.apparatusId, signal)
    if (!current.apparatus.active || current.apparatus.source_revision !== operation.expectedRevision || current.apparatus.source_aasx_sha256 !== operation.baseline.apparatus.source_aasx_sha256) throw new PlanningConflict('Aparat boshqa joyda o‘zgargan. Joriy nusxani yuklab o‘zgarishni qayta ko‘rib chiqing.', current)
    if (operation.kind === 'policy' && planningQueuePolicyLocked(current.apparatus)) throw new PlanningConflict('Bosma apparat navbat siyosati mobil qoidaga ko‘ra qulflangan.', current)
    checkAbort(signal)
    try {
      const body = operation.kind === 'capacity' ? { apparatus_id: operation.apparatusId, expected_revision: operation.expectedRevision, capacity: operation.capacity } : { apparatus_id: operation.apparatusId, expected_revision: operation.expectedRevision, discipline: operation.discipline }
      return parsePatchReceipt(await this.client.request(`${base}/${operation.kind === 'capacity' ? 'capacity' : 'queue-policies'}`, 'PUT', { body, headers: { 'Idempotency-Key': operation.key }, signal }), operation, this.session)
    } catch (error) { checkAbort(signal); if (uncertain(error)) throw new PlanningSaveUnknown(operation); throw error }
  }
  async recoverPatch(operation: PlanningPatchOperation, signal?: AbortSignal): Promise<ApparatusPlanningSnapshot> {
    this.authorize(true); const current = await this.read(operation.apparatusId, signal)
    if (patchMatches(current, operation) && current.apparatus.source_revision > operation.expectedRevision) return current
    throw new PlanningConflict('Yuborilgan qiymatlar joriy profilda tasdiqlanmadi. Joriy nusxani yuklab qayta ko‘rib chiqing.', current)
  }
  async downtime(operation: PlanningDowntimeOperation, signal?: AbortSignal): Promise<PlanningDowntime> {
    this.authorize(true); checkAbort(signal)
    try { const response = record(await this.client.request(`${base}/capacity/downtime`, operation.method, { body: operation.body, signal })); if (response.ok !== true) return invalid(); return parsePlanningDowntime(response.downtime, operation, this.session) }
    catch (error) { checkAbort(signal); if (uncertain(error)) throw new PlanningSaveUnknown(operation); throw error }
  }
  async schedule(operation: PlanningScheduleOperation, signal?: AbortSignal, recover = false): Promise<PlanningScheduleResult> {
    this.authorize(true)
    try {
      const [current, orders] = await Promise.all([this.read(operation.apparatusId, signal), this.orders(signal)])
      if (!current.apparatus.active || current.apparatus.source_revision !== operation.expectedRevision) throw new PlanningConflict('Aparat profili o‘zgargan. Rejani qayta ko‘rib chiqing.', current)
      if (!planningOrderPolicy(orders, operation.body.order_id).apparatusIds.includes(operation.apparatusId) || orderFingerprint(orders, operation.body.order_id) !== operation.orderFingerprint) throw new PlanningConflict('Buyurtma xaritasi yoki holati o‘zgargan. Rejani qayta ko‘rib chiqing.')
    } catch (error) { checkAbort(signal); if (recover) throw new PlanningSaveUnknown(operation, `${apparatusPlanningError(error)} Oldingi band natijasi noma’lum: API uni alohida o‘qib tekshirishni qo‘llamaydi.`); throw error }
    checkAbort(signal)
    try { const result = parseScheduleResult(await this.client.post(`${base}/schedule`, operation.body, signal), operation); if (!recover && result.reservation.status !== 'planned') return invalid('Yangi jadval bandining planned holati tasdiqlanmadi.'); if (!recover) parseActor(result.reservation.actor, this.session); return result }
    catch (error) { checkAbort(signal); if (uncertain(error)) throw new PlanningSaveUnknown(operation); throw error }
  }
  async cancel(operation: PlanningCancelOperation, signal?: AbortSignal): Promise<PlanningScheduleResult> {
    this.authorize(true); checkAbort(signal)
    if (operation.original.reservation.status !== 'planned') throw new Error('Faqat server tasdiqlagan planned bandni bekor qilish mumkin.')
    try {
      const response = record(await this.client.post(`${base}/schedule/cancel`, { reservation_id: operation.original.reservation.reservation_id, reason: operation.reason.trim() }, signal)); if (response.ok !== true) return invalid()
      const reservation = parsePlanningReservation(response.reservation, operation.original.operation)
      parseActor(reservation.actor, this.session)
      if (reservation.status !== 'cancelled' || reservation.reservation_id !== operation.original.reservation.reservation_id || reservation.starts_at_unix !== operation.original.reservation.starts_at_unix || reservation.ends_at_unix !== operation.original.reservation.ends_at_unix) return invalid('Bandning bekor qilinishi tasdiqlanmadi.')
      return { ...operation.original, reservation }
    } catch (error) { checkAbort(signal); if (uncertain(error)) throw new PlanningSaveUnknown(operation); throw error }
  }
}

export function apparatusPlanningError(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = { apparatus_revision_conflict: 'Aparat revisioni o‘zgargan. Joriy nusxani yuklang.', apparatus_retired: 'Aparat foydalanishdan chiqarilgan. Profilini o‘zgartirib bo‘lmaydi.', capacity_conflict: 'Tanlangan vaqtda apparat band. Boshqa oraliqni tanlang.', capacity_no_working_window: 'So‘ralgan oraliqda mos bo‘sh ish vaqti topilmadi.', capacity_unavailable: 'Apparat bu vaqtda mavjud emas.', capability_not_supported: 'Aparat talab qilingan imkoniyatni qo‘llamaydi.', capability_level_insufficient: 'Aparat imkoniyati darajasi yetarli emas.', schedule_idempotency_conflict: 'Bu so‘rov kaliti boshqa reja bilan band. Natijani tekshiring.', schedule_reservation_locked: 'Band ishga tushgan yoki holati o‘zgargan. Uni bekor qilib bo‘lmaydi.', schedule_reservation_not_found: 'Jadval bandi topilmadi.', schedule_input_invalid: 'Jadval qiymatlari API talablariga mos emas.', apparatus_revision_invalid: 'Profil qiymatlari canonical apparat talablariga mos emas.' }
    return messages[error.code] ?? error.message
  }
  return error instanceof Error ? error.message : 'Rejalashtirish amali bajarilmadi.'
}
