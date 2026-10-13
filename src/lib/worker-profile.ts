import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { Row, Session } from './api-types'
import { hasCapability } from './permissions'

const base = '/v1/mobile/admin'
export const workerProfileLimits = { sessions: 50, batches: 50, events: 100, history: 200, apparatus: 500 } as const
export type WorkerSessionStatus = 'active' | 'paused' | 'frozen' | 'roll_detached' | 'completed'
export type WorkerBatchStatus = 'paused' | 'roll_detached' | 'completed' | 'resumed'
export interface WorkerProfilePerson { id: string; name: string; phone: string; level: string }
export interface WorkerProfileGroup {
  apparatus_id: string; apparatus: string; group_code: string; shift: string; start_time: string; end_time: string
  work_days_per_week: number; start_day: string; accounting_enabled: boolean; worker_ids: string[]; workers: WorkerProfilePerson[]
}
export interface WorkerProfileSession {
  session_id: string; apparatus: string; order_id: string; stage_node_id: string; status: WorkerSessionStatus
  worker_role: string; worker_ref: string; worker_display_name: string; started_at_unix: number; updated_at_unix: number
}
export interface WorkerProfileBatch {
  batch_id: string; revision: number; session_id: string; apparatus: string; order_id: string; action: string; status: WorkerBatchStatus
  produced_qty: number; uom: string; label_item_code: string; label_item_name: string; executor_name: string
  worker_role: string; worker_ref: string; worker_display_name: string; started_at_unix: number; completed_at_unix: number
  wip_status: 'waiting' | 'in_use' | 'processed'; current_apparatus: string; current_location: string; next_apparatus: string
  parent_batch_id: string; used_by_apparatus: string; processed_by_apparatus: string; description: string
  status_detail: { code: string; message: string; queue_state: string }
  finished_goods_kg: number | null; finished_goods_meter: number | null; bobina_kg: number | null; total_waste: number | null
  return_ink_kg: number | null; diameter: number | null; rezka_bosma_waste: number | null; rezka_lamination_waste: number | null; rezka_edge_waste: number | null
}
export interface WorkerProfileEvent {
  event_id: string; apparatus: string; order_id: string; stage_node_id: string; action: string; from_state: string; to_state: string
  actor_role: string; actor_ref: string; actor_display_name: string; created_at_unix: number; completed_with_issue: boolean; issue_note: string
}
export interface WorkerProfile {
  worker: WorkerProfilePerson; assigned_apparatus: string[]; assigned_groups: WorkerProfileGroup[]
  active_sessions: WorkerProfileSession[]; recent_batches: WorkerProfileBatch[]; recent_logs: WorkerProfileEvent[]
}
export interface WorkerRoleAssignment { role: { id: string; label: string; capability_count: number } | null; role_id: string; assigned_apparatus: string[]; assigned_item_groups: string[] }
export interface WorkerApparatusCatalog { labels: Record<string, string>; bounded: boolean }
export interface WorkerHistory { batches: WorkerProfileBatch[]; limit: number; atLimit: boolean }
function invalid(): never { throw new ApiError(502, 'invalid_response', 'Ishchi ma’lumotlari to‘liq kelmadi. Qayta yuklang.') }
function string(row: Row, key: string, optional = false): string { const value = row[key]; if (value === undefined && optional) return ''; if (typeof value !== 'string' || !optional && !value.trim()) return invalid(); return value }
function integer(row: Row, key: string, min = 0): number { const value = row[key]; if (!Number.isSafeInteger(value) || Number(value) < min) return invalid(); return Number(value) }
function number(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid(); return value }
function optionalNumber(row: Row, key: string): number | null { return row[key] == null ? null : number(row, key) }
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.some(value => typeof value !== 'string' || !value.trim())) return invalid(); return [...value] as string[] }
function apparatus(value: string, optional = false): string { if (optional && !value) return ''; if (value.length > 128 || !/^apparatus:[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(value)) return invalid(); return value }
function uniqueIds<T>(values: T[], identify: (value: T) => string): T[] { if (new Set(values.map(identify)).size !== values.length) return invalid(); return values }
const secretKeys = new Set(['code', 'login_code', 'access_code', 'auth_code', 'password', 'password_hash', 'token', 'access_token', 'refresh_token', 'authorization', 'credentials', 'secret', 'avatar_url'])
/** Native worker detail includes a login code and its avatar proxy can embed the viewer token. Neither enters cached data. */
export function stripWorkerSecrets(value: unknown, depth = 0): unknown {
  if (depth > 24) return invalid()
  if (Array.isArray(value)) return value.map(item => stripWorkerSecrets(item, depth + 1))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.toLowerCase())).map(([key, value]) => [key, stripWorkerSecrets(value, depth + 1)]))
}
export function workerProfileIdentity(row: Row): string | null {
  const role = row.principal_role ?? row.role
  if (role !== undefined && role !== 'aparatchi') return null
  const id = row.entity_ref ?? row.ref ?? row.id
  return typeof id === 'string' && id.trim() && !/^(worker|system_user|customer|supplier):/.test(id.trim()) && !id.includes(',') ? id.trim() : null
}
export function canReadWorkerProfile(session: Session | null | undefined): boolean { return hasCapability(session, 'admin.access') }
export function canReadWorkerRoles(session: Session | null | undefined): boolean { return hasCapability(session, 'role.capability.read') }
export function canReadWorkerHistory(session: Session | null | undefined, workerId: string): boolean {
  const allowed = ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'].some(cap => hasCapability(session, cap))
  return allowed && !!workerId.trim() && !workerId.includes(',') && (session?.profile.role === 'admin' || session?.profile.ref?.trim() === workerId.trim())
}
function person(value: unknown): WorkerProfilePerson { const row = record(value); return { id: string(row, 'id'), name: string(row, 'name'), phone: string(row, 'phone', true), level: string(row, 'level', true) } }
function group(value: unknown): WorkerProfileGroup {
  const row = record(value), ids = strings(row.worker_ids)
  if (typeof row.accounting_enabled !== 'boolean') return invalid()
  const days = integer(row, 'work_days_per_week', 1); if (days > 7) return invalid()
  return { apparatus_id: apparatus(string(row, 'apparatus_id')), apparatus: string(row, 'apparatus', true), group_code: string(row, 'group_code'), shift: string(row, 'shift', true), start_time: string(row, 'start_time', true), end_time: string(row, 'end_time', true), work_days_per_week: days, start_day: string(row, 'start_day', true), accounting_enabled: row.accounting_enabled, worker_ids: ids, workers: rows(row, 'workers').map(person) }
}
export function parseWorkerSession(value: unknown): WorkerProfileSession {
  const row = record(value), status = string(row, 'status')
  if (!['active', 'paused', 'frozen', 'roll_detached', 'completed'].includes(status)) return invalid()
  return { session_id: string(row, 'session_id'), apparatus: apparatus(string(row, 'apparatus')), order_id: string(row, 'order_id'), stage_node_id: string(row, 'stage_node_id', true), status: status as WorkerSessionStatus, worker_role: string(row, 'worker_role', true), worker_ref: string(row, 'worker_ref', true), worker_display_name: string(row, 'worker_display_name', true), started_at_unix: integer(row, 'started_at_unix'), updated_at_unix: integer(row, 'updated_at_unix') }
}
export function parseWorkerBatch(value: unknown): WorkerProfileBatch {
  const row = record(value), status = string(row, 'status'), wip = string(row, 'wip_status'), detail = isRecord(row.status_detail) ? row.status_detail : {}
  if (!['paused', 'roll_detached', 'completed', 'resumed'].includes(status) || !['waiting', 'in_use', 'processed'].includes(wip)) return invalid()
  const optionalApparatus = (key: string) => apparatus(string(row, key, true), true)
  return { batch_id: string(row, 'batch_id'), revision: row.revision === undefined ? 1 : integer(row, 'revision', 1), session_id: string(row, 'session_id', true), apparatus: apparatus(string(row, 'apparatus')), order_id: string(row, 'order_id'), action: string(row, 'action'), status: status as WorkerBatchStatus, produced_qty: number(row, 'produced_qty'), uom: string(row, 'uom'), label_item_code: string(row, 'label_item_code', true), label_item_name: string(row, 'label_item_name', true), executor_name: string(row, 'executor_name', true), worker_role: string(row, 'worker_role', true), worker_ref: string(row, 'worker_ref', true), worker_display_name: string(row, 'worker_display_name', true), started_at_unix: integer(row, 'started_at_unix'), completed_at_unix: integer(row, 'completed_at_unix'), wip_status: wip as WorkerProfileBatch['wip_status'], current_apparatus: optionalApparatus('current_apparatus'), current_location: string(row, 'current_location', true), next_apparatus: optionalApparatus('next_apparatus'), parent_batch_id: string(row, 'parent_batch_id', true), used_by_apparatus: optionalApparatus('used_by_apparatus'), processed_by_apparatus: optionalApparatus('processed_by_apparatus'), description: string(row, 'description', true), status_detail: { code: string(detail, 'code', true), message: string(detail, 'message', true), queue_state: string(detail, 'queue_state', true) }, finished_goods_kg: optionalNumber(row, 'finished_goods_kg'), finished_goods_meter: optionalNumber(row, 'finished_goods_meter'), bobina_kg: optionalNumber(row, 'bobina_kg') ?? optionalNumber(row, 'babina_kg'), total_waste: optionalNumber(row, 'total_waste'), return_ink_kg: optionalNumber(row, 'return_ink_kg'), diameter: optionalNumber(row, 'diameter'), rezka_bosma_waste: optionalNumber(row, 'rezka_bosma_waste'), rezka_lamination_waste: optionalNumber(row, 'rezka_lamination_waste'), rezka_edge_waste: optionalNumber(row, 'rezka_edge_waste') }
}
function event(value: unknown): WorkerProfileEvent {
  const row = record(value)
  if (typeof row.completed_with_issue !== 'boolean') return invalid()
  return { event_id: string(row, 'event_id'), apparatus: apparatus(string(row, 'apparatus')), order_id: string(row, 'order_id'), stage_node_id: string(row, 'stage_node_id', true), action: string(row, 'action'), from_state: string(row, 'from_state'), to_state: string(row, 'to_state'), actor_role: string(row, 'actor_role', true), actor_ref: string(row, 'actor_ref', true), actor_display_name: string(row, 'actor_display_name', true), created_at_unix: integer(row, 'created_at_unix'), completed_with_issue: row.completed_with_issue, issue_note: string(row, 'issue_note', true) }
}
export function parseWorkerProfile(value: unknown, workerId: string): WorkerProfile {
  const row = record(stripWorkerSecrets(value)), worker = person(row.worker)
  if (worker.id !== workerId) return invalid()
  const sessions = uniqueIds(rows(row, 'active_sessions').map(parseWorkerSession), session => session.session_id)
  if (sessions.some(session => session.status === 'completed')) return invalid()
  return { worker, assigned_apparatus: strings(row.assigned_apparatus).map(id => apparatus(id)), assigned_groups: rows(row, 'assigned_groups').map(group), active_sessions: sessions, recent_batches: uniqueIds(rows(row, 'recent_batches').map(parseWorkerBatch), batch => batch.batch_id), recent_logs: uniqueIds(rows(row, 'recent_logs').map(event), event => event.event_id) }
}
/** Counts describe this bounded read only; output from paused/resumed batches is never summed into productivity. */
export function workerProfileCounts(profile: WorkerProfile) {
  const states = { active: 0, paused: 0, frozen: 0, roll_detached: 0 }
  for (const session of profile.active_sessions) if (session.status !== 'completed') states[session.status] += 1
  return { ...states, open: profile.active_sessions.length, batches: profile.recent_batches.length, events: profile.recent_logs.length }
}
export function workerStateLabel(value: string): string { return ({ active: 'Jarayonda', paused: 'To‘xtatilgan', frozen: 'Muzlatilgan', roll_detached: 'Rulon yechilgan', completed: 'Tugallangan', resumed: 'Davom ettirilgan', waiting: 'Kutilmoqda', in_use: 'Ishlatilmoqda', processed: 'Ishlatilgan', start: 'Boshlash', pause: 'To‘xtatish', resume: 'Davom ettirish', complete: 'Tugatish', detach_roll: 'Rulonni yechish', completed_with_issue: 'Muammo bilan tugallangan', transfer: 'O‘tkazish' } as Record<string, string>)[value] ?? value }
export function workerProfileError(error: unknown): string { return error instanceof ApiError && error.status === 403 ? 'Ishchi ma’lumotlarini ko‘rish uchun ruxsat yetarli emas.' : error instanceof ApiError && error.status === 404 ? 'Ishchi topilmadi. Ro‘yxatni yangilang.' : error instanceof Error ? error.message : 'Ishchi ma’lumotlari yuklanmadi.' }
export class WorkerProfileApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  private validId(id: string): void { if (!id.trim() || id.includes(',')) throw new Error('Ishchini tanlang.') }
  async profile(id: string, signal?: AbortSignal): Promise<WorkerProfile> {
    if (!canReadWorkerProfile(this.session)) throw new ApiError(403, 'forbidden')
    this.validId(id)
    return parseWorkerProfile(await this.client.request(`${base}/workers/profile-detail`, 'GET', { query: { id }, signal }), id)
  }
  async history(id: string, limit = workerProfileLimits.history as number, signal?: AbortSignal): Promise<WorkerHistory> {
    this.validId(id)
    if (!canReadWorkerHistory(this.session, id)) throw new ApiError(403, 'forbidden')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > workerProfileLimits.history) throw new Error('Tarix uchun 1–200 oralig‘ida yozuv sonini tanlang.')
    const response = record(stripWorkerSecrets(await this.client.request(`${base}/production-maps/progress-qr/history`, 'GET', { query: { worker_ref: id, limit }, signal })))
    if (response.ok !== true) return invalid()
    const batches = uniqueIds(rows(response, 'batches').map(parseWorkerBatch), batch => batch.batch_id)
    if (batches.length > limit) return invalid()
    return { batches, limit, atLimit: batches.length === limit }
  }
  async apparatus(signal?: AbortSignal): Promise<WorkerApparatusCatalog> {
    if (!canReadWorkerProfile(this.session)) throw new ApiError(403, 'forbidden')
    const list = rows(stripWorkerSecrets(await this.client.request(`${base}/apparatus`, 'GET', { query: { limit: workerProfileLimits.apparatus }, signal })))
    const labels = Object.fromEntries(list.map(row => [apparatus(string(row, 'apparatus_id')), string(record(row.display), 'display_name')]))
    return { labels, bounded: list.length >= workerProfileLimits.apparatus }
  }
  async assignment(id: string, signal?: AbortSignal): Promise<WorkerRoleAssignment | null> {
    this.validId(id)
    if (!canReadWorkerRoles(this.session)) throw new ApiError(403, 'forbidden')
    const [rawAssignments, rawRoles] = await Promise.all([this.client.request(`${base}/role-assignments`, 'GET', { signal }), this.client.request(`${base}/roles`, 'GET', { signal })])
    const same = (a: string, b: string) => a.replace(/[A-Z]/g, letter => letter.toLowerCase()) === b.replace(/[A-Z]/g, letter => letter.toLowerCase())
    const assignment = rows(stripWorkerSecrets(rawAssignments)).find(row => row.principal_role === 'aparatchi' && typeof row.principal_ref === 'string' && same(row.principal_ref.trim(), id))
    if (!assignment) return null
    const roleId = string(assignment, 'role_id'), role = rows(stripWorkerSecrets(rawRoles)).find(row => row.id === roleId)
    return { role_id: roleId, role: role ? { id: roleId, label: string(role, 'label'), capability_count: strings(role.capability_codes).length } : null, assigned_apparatus: strings(assignment.assigned_apparatus ?? []).map(id => apparatus(id)), assigned_item_groups: strings(assignment.assigned_item_groups ?? []) }
  }
}
