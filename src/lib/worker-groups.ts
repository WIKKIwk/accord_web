import { ApiClient, ApiError, record, rows } from './api'
import type { Row, Session } from './api-types'
import { isIdentityApparatusId, workerLevels } from './admin-identity'
import { hasCapability } from './permissions'

const base = '/v1/mobile/admin'
export const workerGroupCatalogLimit = 500
export const workerGroupStartDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
export type WorkerGroupStartDay = typeof workerGroupStartDays[number]
export interface GroupWorker { id: string; name: string; phone: string; level: string }
export interface GroupApparatus { id: string; name: string; active: boolean }
export interface GroupCatalog<T> { items: T[]; bounded: boolean }
export interface WorkerGroupInput {
  apparatus_id: string
  apparatus: string
  group_code: string
  shift: string
  start_time: string
  end_time: string
  work_days_per_week: number
  start_day: WorkerGroupStartDay
  accounting_enabled: boolean
  worker_ids: string[]
}
export interface WorkerGroup extends WorkerGroupInput { workers: GroupWorker[] }
export interface WorkerGroupOperation { readonly input: WorkerGroupInput; readonly baseline?: WorkerGroup }
export interface WorkerGroupObservation {
  groups: WorkerGroup[]
  target?: WorkerGroup
  previous?: WorkerGroup
  state: 'matches' | 'different' | 'missing'
}

function invalid(): never { throw new ApiError(502, 'invalid_response', 'Ishchi guruhlari haqida to‘liq ma’lumot kelmadi. Qayta yuklang.') }
function field(row: Row, key: string, empty = false): string {
  const value = row[key]
  if (typeof value !== 'string' || value !== value.trim() || !empty && !value) return invalid()
  return value
}
function utf8Length(value: string): number { return new TextEncoder().encode(value).length }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim())) return invalid()
  const result = [...value] as string[]
  if (new Set(result.map(id => id.toLowerCase())).size !== result.length) return invalid()
  return result
}
function membership(values: string[]): string { return [...values].sort().join('\0') }
export function workerGroupIdentity(value: Pick<WorkerGroupInput, 'apparatus_id' | 'group_code'>): string { return JSON.stringify([value.apparatus_id, value.group_code]) }
export function workerGroupsAllowed(session: Session | null | undefined): boolean { return hasCapability(session, 'admin.access') }
/** Mirrors the apparatus read handler; admin.access is one of its actual guards. */
export function canReadGroupApparatus(session: Session | null | undefined): boolean {
  return ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'].some(code => hasCapability(session, code))
}
export function normalizeWorkerGroupCode(value: string): string {
  const normalized = value.trim().split(/\s+/u).join(' ').toUpperCase()
  if (!normalized || utf8Length(normalized) > 64 || !/^[\p{L}\p{N} ]+$/u.test(normalized)) throw new Error('Guruh nomi 64 baytgacha bo‘lsin; faqat harflar, raqamlar va bo‘shliq kiriting.')
  return normalized
}
function normalizedTime(value: string, fallback: string): string {
  const normalized = value.trim() || fallback, match = /^(\d{1,2}):(\d{1,2})$/.exec(normalized)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Vaqtni 00:00–23:59 oralig‘ida kiriting.')
  return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`
}
export function normalizeWorkerGroupInput(input: WorkerGroupInput): WorkerGroupInput {
  if (!isIdentityApparatusId(input.apparatus_id)) throw new Error('Apparatni server ro‘yxatidan tanlang.')
  const group_code = normalizeWorkerGroupCode(input.group_code), shift = input.shift.trim() || 'kunduz'
  if (utf8Length(shift) > 64) throw new Error('Smena nomi 64 baytdan oshmasin.')
  const days = input.work_days_per_week === 0 ? 6 : input.work_days_per_week
  if (!Number.isSafeInteger(days) || days < 1 || days > 7) throw new Error('Haftadagi ish kunlarini 1–7 oralig‘ida tanlang.')
  const start_day = input.start_day.trim().toLowerCase() || 'monday'
  if (!workerGroupStartDays.includes(start_day as WorkerGroupStartDay)) throw new Error('Hafta boshlanish kunini ro‘yxatdan tanlang.')
  if (typeof input.accounting_enabled !== 'boolean') throw new Error('Hisoblash holatini tanlang.')
  const worker_ids = input.worker_ids.map(id => id.trim())
  if (worker_ids.some(id => !id) || new Set(worker_ids.map(id => id.toLowerCase())).size !== worker_ids.length) throw new Error('Ishchini guruhga faqat bir marta biriktiring.')
  return { apparatus_id: input.apparatus_id, apparatus: input.apparatus.trim(), group_code, shift,
    start_time: normalizedTime(input.start_time, '08:00'), end_time: normalizedTime(input.end_time, '20:00'),
    work_days_per_week: days, start_day: start_day as WorkerGroupStartDay, accounting_enabled: input.accounting_enabled, worker_ids }
}
export function parseGroupWorker(value: unknown): GroupWorker {
  const row = record(value)
  if (row.principal_role !== undefined && row.principal_role !== 'aparatchi' || row.role !== undefined && row.role !== 'aparatchi' || row.active === false) return invalid()
  const id = field(row, 'id'), level = field(row, 'level')
  if (/^(worker|system_user|customer|supplier):/.test(id) || !workerLevels.some(item => item === level)) return invalid()
  // Worker-detail can contain a login code and token-bearing avatar URL. Only these fields survive.
  return { id, name: field(row, 'name'), phone: row.phone === undefined ? '' : field(row, 'phone', true), level }
}
export function parseGroupApparatus(value: unknown): GroupApparatus {
  const row = record(value), id = field(row, 'apparatus_id'), display = record(row.display), lifecycle = record(row.lifecycle)
  if (!isIdentityApparatusId(id) || !['active', 'retired'].includes(String(lifecycle.state))) return invalid()
  return { id, name: field(display, 'display_name'), active: lifecycle.state === 'active' }
}
export function parseWorkerGroup(value: unknown): WorkerGroup {
  const row = record(value)
  if (row.ok === false || typeof row.accounting_enabled !== 'boolean' || !Number.isSafeInteger(row.work_days_per_week)) return invalid()
  const apparatus_id = field(row, 'apparatus_id'), group_code = field(row, 'group_code'), shift = field(row, 'shift')
  const start_time = field(row, 'start_time'), end_time = field(row, 'end_time'), start_day = field(row, 'start_day')
  const days = Number(row.work_days_per_week), worker_ids = ids(row.worker_ids), workers = rows(row.workers).map(parseGroupWorker)
  if (!isIdentityApparatusId(apparatus_id) || days < 1 || days > 7 || !workerGroupStartDays.includes(start_day as WorkerGroupStartDay)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start_time) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end_time) || utf8Length(shift) > 64
    || new Set(workers.map(worker => worker.id.toLowerCase())).size !== workers.length || workers.some(worker => !worker_ids.includes(worker.id))) return invalid()
  try { if (normalizeWorkerGroupCode(group_code) !== group_code) return invalid() } catch { return invalid() }
  return { apparatus_id, apparatus: field(row, 'apparatus', true), group_code, shift, start_time, end_time,
    work_days_per_week: days, start_day: start_day as WorkerGroupStartDay, accounting_enabled: row.accounting_enabled, worker_ids, workers }
}
export function parseWorkerGroups(value: unknown): WorkerGroup[] {
  const groups = rows(value).map(parseWorkerGroup)
  if (new Set(groups.map(workerGroupIdentity)).size !== groups.length) return invalid()
  const assigned = groups.flatMap(group => group.worker_ids.map(id => id.toLowerCase()))
  if (new Set(assigned).size !== assigned.length) return invalid()
  return groups
}
export function sameWorkerGroup(left: WorkerGroupInput, right: WorkerGroupInput): boolean {
  return left.apparatus_id === right.apparatus_id && left.apparatus === right.apparatus && left.group_code === right.group_code
    && left.shift === right.shift && left.start_time === right.start_time && left.end_time === right.end_time
    && left.work_days_per_week === right.work_days_per_week && left.start_day === right.start_day
    && left.accounting_enabled === right.accounting_enabled && membership(left.worker_ids) === membership(right.worker_ids)
}
export function createWorkerGroupOperation(input: WorkerGroupInput, baseline?: WorkerGroup): WorkerGroupOperation {
  const normalized = normalizeWorkerGroupInput(input), original = baseline ? parseWorkerGroup(baseline) : undefined
  Object.freeze(normalized.worker_ids); Object.freeze(normalized)
  if (original) { original.workers.forEach(Object.freeze); Object.freeze(original.workers); Object.freeze(original.worker_ids); Object.freeze(original) }
  return Object.freeze({ input: normalized, ...(original ? { baseline: original } : {}) })
}
export function assignedWorkerGroups(groups: WorkerGroup[], except?: WorkerGroup): Map<string, WorkerGroup> {
  return new Map(groups.filter(group => !except || workerGroupIdentity(group) !== workerGroupIdentity(except)).flatMap(group => group.worker_ids.map(id => [id.toLowerCase(), group] as const)))
}
export class WorkerGroupConflict extends Error {
  readonly current: WorkerGroup[]
  constructor(message: string, current: WorkerGroup[]) { super(message); this.name = 'WorkerGroupConflict'; this.current = current }
}
export class WorkerGroupUnknown extends Error {
  readonly operation: WorkerGroupOperation
  constructor(operation: WorkerGroupOperation) {
    super('Saqlash natijasi noma’lum. Avvalgi tanlov saqlandi; so‘rov qayta yuborilmaydi. Joriy ma’lumotni tekshiring.')
    this.name = 'WorkerGroupUnknown'; this.operation = operation
  }
}
/** GET/PUT are the complete native group contract. There is no native DELETE or write receipt lookup. */
export class WorkerGroupsApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  private require(): void { if (!workerGroupsAllowed(this.session)) throw new ApiError(403, 'forbidden') }
  async groups(signal?: AbortSignal): Promise<WorkerGroup[]> {
    this.require(); return parseWorkerGroups(await this.client.request(`${base}/worker-groups`, 'GET', { signal }))
  }
  async apparatus(q = '', signal?: AbortSignal): Promise<GroupCatalog<GroupApparatus>> {
    this.require()
    if (!canReadGroupApparatus(this.session)) throw new ApiError(403, 'forbidden')
    const list = rows(await this.client.request(`${base}/apparatus`, 'GET', { query: { q: q.trim(), limit: workerGroupCatalogLimit }, signal })).map(parseGroupApparatus)
    if (new Set(list.map(item => item.id)).size !== list.length) return invalid()
    return { items: list.filter(item => item.active), bounded: list.length >= workerGroupCatalogLimit }
  }
  async workers(q = '', signal?: AbortSignal): Promise<GroupCatalog<GroupWorker>> {
    this.require()
    const list = rows(await this.client.request(`${base}/workers`, 'GET', { query: { q: q.trim(), role: 'aparatchi', limit: workerGroupCatalogLimit }, signal })).map(parseGroupWorker)
    if (new Set(list.map(item => item.id.toLowerCase())).size !== list.length) return invalid()
    return { items: list, bounded: list.length >= workerGroupCatalogLimit }
  }
  async execute(operation: WorkerGroupOperation, signal?: AbortSignal): Promise<WorkerGroup> {
    this.require(); abort(signal)
    const input = normalizeWorkerGroupInput(operation.input), baseline = operation.baseline
    const current = await this.groups(signal); abort(signal)
    const previous = baseline && current.find(group => workerGroupIdentity(group) === workerGroupIdentity(baseline))
    if (baseline && (!previous || !sameWorkerGroup(previous, baseline))) throw new WorkerGroupConflict('Guruh boshqa joyda o‘zgargan yoki topilmadi. Joriy nusxani ko‘rib, tahrirni qayta boshlang.', current)
    const existing = current.find(group => workerGroupIdentity(group) === workerGroupIdentity(input))
    if (existing && (!baseline || workerGroupIdentity(existing) !== workerGroupIdentity(baseline))) throw new WorkerGroupConflict('Bu apparatda shu nomli guruh mavjud. Boshqa nom tanlang.', current)
    const assigned = assignedWorkerGroups(current, baseline), duplicate = input.worker_ids.find(id => assigned.has(id.toLowerCase()))
    if (duplicate) throw new WorkerGroupConflict(`${assigned.get(duplicate.toLowerCase())!.group_code} guruhiga biriktirilgan ishchini avval o‘sha guruhdan olib tashlang.`, current)
    const apparatus = parseGroupApparatus(await this.client.request(`${base}/apparatus/${encodeURIComponent(input.apparatus_id)}`, 'GET', { signal })); abort(signal)
    if (apparatus.id !== input.apparatus_id || !apparatus.active) throw new Error('Faol apparatni server ro‘yxatidan tanlang.')
    if (apparatus.name !== input.apparatus) throw new Error('Apparat nomi o‘zgargan. Uni ro‘yxatdan qayta tanlang.')
    // Exact active worker reads avoid treating a bounded/search result as the entire directory.
    for (let offset = 0; offset < input.worker_ids.length; offset += 10) {
      await Promise.all(input.worker_ids.slice(offset, offset + 10).map(async id => {
        const worker = parseGroupWorker(await this.client.request(`${base}/workers/detail`, 'GET', { query: { id }, signal }))
        if (worker.id !== id) return invalid()
      }))
      abort(signal)
    }
    const body = { ...input, ...(baseline ? { previous_apparatus_id: baseline.apparatus_id, previous_group_code: baseline.group_code } : {}) }
    // No CAS or idempotency is available here: after dispatch, loss/malformed 200/abort stays unknown.
    abort(signal)
    try {
      const saved = parseWorkerGroup(await this.client.request(`${base}/worker-groups`, 'PUT', { body, signal })); abort(signal)
      if (!sameWorkerGroup(saved, input) || membership(saved.workers.map(worker => worker.id)) !== membership(input.worker_ids)) return invalid()
      return saved
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || [408, 429].includes(error.status) || error.status >= 500 || error.code === 'invalid_response') throw new WorkerGroupUnknown(operation)
      throw error
    }
  }
  async observe(operation: WorkerGroupOperation, signal?: AbortSignal): Promise<WorkerGroupObservation> {
    const groups = await this.groups(signal); abort(signal)
    const target = groups.find(group => workerGroupIdentity(group) === workerGroupIdentity(operation.input))
    const previous = operation.baseline && groups.find(group => workerGroupIdentity(group) === workerGroupIdentity(operation.baseline!))
    return { groups, ...(target ? { target } : {}), ...(previous ? { previous } : {}), state: target ? sameWorkerGroup(target, operation.input) ? 'matches' : 'different' : 'missing' }
  }
}

export interface WorkerGroupIntent { readonly operation: WorkerGroupOperation; readonly status: 'pending' | 'unknown'; readonly observation?: WorkerGroupObservation }
/** RAM only, scoped by the session manager. A dialog remount cannot resend an unresolved intent. */
export class WorkerGroupIntentLedger {
  private intent: WorkerGroupIntent | null = null
  private readonly listeners = new Set<() => void>()
  snapshot = (): WorkerGroupIntent | null => this.intent
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(intent: WorkerGroupIntent | null): void { this.intent = intent; this.listeners.forEach(listener => listener()) }
  begin(operation: WorkerGroupOperation): void {
    if (this.intent) throw new Error('Avvalgi saqlash natijasini tekshiring. So‘rov takrorlanmaydi.')
    this.publish({ operation, status: 'pending' })
  }
  unknown(operation: WorkerGroupOperation): void { if (this.intent?.operation === operation) this.publish({ operation, status: 'unknown' }) }
  finish(operation: WorkerGroupOperation): void { if (this.intent?.operation === operation) this.publish(null) }
  observe(operation: WorkerGroupOperation, observation: WorkerGroupObservation): void {
    if (this.intent?.operation === operation && this.intent.status === 'unknown') this.publish({ operation, status: 'unknown', observation })
  }
  resolveReviewed(operation: WorkerGroupOperation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'unknown' || !this.intent.observation) throw new Error('Avval serverdagi joriy ma’lumotni tekshiring.')
    this.publish(null)
  }
}
const ledgers = new Map<string, WorkerGroupIntentLedger>()
export function workerGroupIntentLedger(scope: string): WorkerGroupIntentLedger {
  let ledger = ledgers.get(scope)
  if (!ledger) { ledger = new WorkerGroupIntentLedger(); ledgers.set(scope, ledger) }
  return ledger
}
export function workerGroupError(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      'worker is duplicated in worker groups': 'Ishchi boshqa guruhga biriktirilgan. Guruhlarni yangilang.',
      'worker group name already exists': 'Bu apparatda shu nomli guruh bor. Boshqa nom tanlang.',
      'worker group was not found': 'Guruh topilmadi. Ro‘yxatni yangilang.',
      'worker not found': 'Tanlangan ishchi topilmadi yoki faol emas. Ishchilarni yangilang.',
      'worker group is invalid': 'Guruh nomini tekshiring.', 'worker shift is invalid': 'Smena nomini tekshiring.',
      'worker schedule is invalid': 'Ish vaqti va hafta kunlarini tekshiring.',
    }
    if (messages[error.code]) return messages[error.code]
  }
  return error instanceof Error ? error.message : 'Ishchi guruhlari amali bajarilmadi.'
}
