import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { Row, Session } from './api-types'
import { hasCapability } from './permissions'

export const paddonsPath = '/v1/mobile/admin/production-maps/paddons'
export const paddonListLimit = 200
export const paddonBatchLimit = 500
export interface PaddonSummary {
  id: string; code: string; location: string; note: string
  created_by_ref: string; created_by_display_name: string
  created_at_unix: number; updated_at_unix: number; item_count: number
  locked_at_unix: number | null; total_gross_kg: number | null; total_net_kg: number | null
}
export interface PaddonBatch {
  batch_id: string; order_id: string; apparatus: string; qr_payload: string
  label_item_code: string; label_item_name: string; produced_qty: number; uom: string
  wip_status: 'waiting' | 'in_use' | 'processed'
  finished_goods_kg: number | null; bobina_kg: number | null; finished_goods_meter: number | null
  finished_goods_stock_id: string; received_warehouse: string
}
export interface PaddonSnapshot {
  paddon: PaddonSummary; items: PaddonBatch[]; available_items: PaddonBatch[]
  free_movement_enabled: boolean; can_manage_items: boolean; can_unlock: boolean
}
export interface PaddonList { items: PaddonSummary[]; bounded: boolean }
export interface PaddonCreateInput { location: string; note: string }
export interface PaddonItemsInput { code: string; progress_batch_ids: string[] }
export type PaddonOperation =
  | { readonly kind: 'create'; readonly input: PaddonCreateInput; readonly code: string; readonly progress_batch_ids: string[]; readonly baseline?: undefined }
  | { readonly kind: 'add' | 'remove'; readonly input: PaddonItemsInput; readonly code: string; readonly progress_batch_ids: string[]; readonly baseline: PaddonSnapshot }
  | { readonly kind: 'delete'; readonly input: { code: string }; readonly code: string; readonly progress_batch_ids: string[]; readonly baseline: PaddonSummary }
  | { readonly kind: 'unlock'; readonly input: { code: string }; readonly code: string; readonly progress_batch_ids: string[]; readonly baseline: PaddonSnapshot }
export interface PaddonObservation {
  paddons: PaddonSummary[]; bounded: boolean; snapshot?: PaddonSnapshot
  state: 'listed' | 'matches' | 'different' | 'missing'
}

const nativeTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
const byteLength = (value: string): number => new TextEncoder().encode(value).length
function invalid(): never { throw new ApiError(502, 'invalid_response', 'Paddon haqida to‘liq ma’lumot kelmadi. Joriy holatni qayta yuklang.') }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
function field(row: Row, key: string, empty = false): string {
  const value = row[key]
  if (typeof value !== 'string' || !empty && (!value || value !== nativeTrim(value))) return invalid()
  return value
}
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) return invalid(); return Number(value) }
function optionalWeight(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid()
  return value
}
function flag(row: Row, key: string): boolean {
  if (row[key] === undefined) return false
  if (typeof row[key] !== 'boolean') return invalid()
  return row[key] as boolean
}
export function canReadPaddons(session: Session | null | undefined): boolean {
  return ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'].some(code => hasCapability(session, code))
}
export function canManagePaddons(session: Session | null | undefined): boolean {
  return ['admin.access', 'production.map.manage', 'apparatus.queue.manage'].some(code => hasCapability(session, code))
}
export function normalizePaddonCreateInput(input: PaddonCreateInput): PaddonCreateInput {
  if (typeof input.location !== 'string' || typeof input.note !== 'string') throw new Error('Paddon joyi va izohini matn sifatida kiriting.')
  const location = nativeTrim(input.location), note = nativeTrim(input.note)
  if (byteLength(location) > 160) throw new Error('Paddon joyi 160 baytdan oshmasin.')
  if (byteLength(note) > 500) throw new Error('Paddon izohi 500 baytdan oshmasin.')
  return { location, note }
}
export function normalizePaddonCode(value: string, bounded = false): string {
  if (typeof value !== 'string' || !nativeTrim(value)) throw new Error('Paddon kodini kiriting.')
  const code = nativeTrim(value)
  if (bounded && byteLength(code) > 128) throw new Error('Paddon kodi 128 baytdan oshmasin.')
  return code
}
export function normalizePaddonBatchIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !nativeTrim(value))) throw new Error('WIP ni server ro‘yxatidan tanlang.')
  const ids = [...new Set(values.map(nativeTrim))]
  // The native500 bound applies after deduplication, preserving first-seen order.
  if (!ids.length || ids.length > paddonBatchLimit) throw new Error('1–500 ta turli WIP tanlang.')
  return ids
}
export function parsePaddonSummary(value: unknown): PaddonSummary {
  const row = record(value), location = field(row, 'location', true), note = field(row, 'note', true)
  if (row.ok === false || byteLength(location) > 160 || byteLength(note) > 500 || typeof row.code !== 'string' || !/^\d{5}$/.test(row.code) || !Object.hasOwn(row, 'locked_at_unix')) return invalid()
  const locked_at_unix = row.locked_at_unix === null ? null : integer(row.locked_at_unix)
  return { id: field(row, 'id'), code: field(row, 'code'), location, note,
    created_by_ref: field(row, 'created_by_ref', true), created_by_display_name: field(row, 'created_by_display_name', true),
    created_at_unix: integer(row.created_at_unix), updated_at_unix: integer(row.updated_at_unix), item_count: integer(row.item_count), locked_at_unix,
    total_gross_kg: optionalWeight(row.total_gross_kg), total_net_kg: optionalWeight(row.total_net_kg) }
}
export function parsePaddonBatch(value: unknown): PaddonBatch {
  const row = record(value)
  if (!['waiting', 'in_use', 'processed'].includes(String(row.wip_status)) || typeof row.produced_qty !== 'number' || !Number.isFinite(row.produced_qty) || row.produced_qty < 0) return invalid()
  const payload = isRecord(row.payload_json) ? row.payload_json : {}
  const marker = (key: string): string => {
    const value = Object.hasOwn(payload, key) ? payload[key] : row[key] ?? ''
    if (value === null || value === undefined) return ''
    if (typeof value !== 'string') return invalid()
    return value
  }
  // Keep the display projection only; payload_json may contain credentials and unrelated commands.
  return { batch_id: field(row, 'batch_id'), order_id: field(row, 'order_id'), apparatus: field(row, 'apparatus'),
    qr_payload: field(row, 'qr_payload', true), label_item_code: field(row, 'label_item_code', true), label_item_name: field(row, 'label_item_name', true),
    produced_qty: row.produced_qty, uom: field(row, 'uom'), wip_status: row.wip_status as PaddonBatch['wip_status'],
    finished_goods_kg: optionalWeight(row.finished_goods_kg), bobina_kg: optionalWeight(row.bobina_kg), finished_goods_meter: optionalWeight(row.finished_goods_meter),
    finished_goods_stock_id: marker('finished_goods_stock_id'), received_warehouse: marker('received_warehouse') }
}
export function canAddPaddonBatch(batch: PaddonBatch): boolean { return batch.wip_status === 'waiting' && batch.finished_goods_stock_id === '' && batch.received_warehouse === '' }
export function parsePaddonSnapshot(value: unknown): PaddonSnapshot {
  const row = record(value)
  if (row.ok !== true) return invalid()
  const paddon = parsePaddonSummary(row.paddon), items = rows(row.items).map(parsePaddonBatch), available_items = rows(row.available_items).map(parsePaddonBatch)
  const free_movement_enabled = flag(row, 'free_movement_enabled'), can_manage_items = flag(row, 'can_manage_items'), can_unlock = flag(row, 'can_unlock')
  const assigned = new Set(items.map(item => item.batch_id)), available = new Set(available_items.map(item => item.batch_id))
  if (assigned.size !== items.length || available.size !== available_items.length || available_items.some(item => assigned.has(item.batch_id))
    || paddon.item_count !== items.length || available_items.length > paddonBatchLimit || can_unlock && paddon.locked_at_unix === null
    || can_manage_items && paddon.locked_at_unix !== null && !free_movement_enabled) return invalid()
  return { paddon, items, available_items, free_movement_enabled, can_manage_items, can_unlock }
}
export function parsePaddonList(value: unknown): PaddonList {
  const row = record(value)
  if (row.ok !== true) return invalid()
  const items = rows(row.paddons).map(parsePaddonSummary)
  if (items.length > paddonListLimit || new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => item.code)).size !== items.length) return invalid()
  return { items, bounded: items.length >= paddonListLimit }
}
function freezeSnapshot(snapshot: PaddonSnapshot): PaddonSnapshot {
  Object.freeze(snapshot.paddon); snapshot.items.forEach(Object.freeze); snapshot.available_items.forEach(Object.freeze)
  Object.freeze(snapshot.items); Object.freeze(snapshot.available_items); return Object.freeze(snapshot)
}
function freezeOperation<T extends PaddonOperation>(operation: T): T {
  Object.freeze(operation.progress_batch_ids); Object.freeze(operation.input); return Object.freeze(operation)
}
export function createPaddonOperation(input: PaddonCreateInput): PaddonOperation {
  return freezeOperation({ kind: 'create', input: normalizePaddonCreateInput(input), code: '', progress_batch_ids: [] })
}
export function paddonItemsOperation(kind: 'add' | 'remove', snapshot: PaddonSnapshot, values: readonly string[]): PaddonOperation {
  const baseline = freezeSnapshot(parsePaddonSnapshot({ ...snapshot, ok: true })), progress_batch_ids = normalizePaddonBatchIds(values), code = normalizePaddonCode(baseline.paddon.code)
  return freezeOperation({ kind, input: { code, progress_batch_ids }, code, progress_batch_ids, baseline })
}
export function deletePaddonOperation(summary: PaddonSummary): PaddonOperation {
  const baseline = Object.freeze(parsePaddonSummary(summary)), code = normalizePaddonCode(baseline.code, true)
  return freezeOperation({ kind: 'delete', input: { code }, code, progress_batch_ids: [], baseline })
}
export function unlockPaddonOperation(snapshot: PaddonSnapshot): PaddonOperation {
  const baseline = freezeSnapshot(parsePaddonSnapshot({ ...snapshot, ok: true })), code = normalizePaddonCode(baseline.paddon.code, true)
  return freezeOperation({ kind: 'unlock', input: { code }, code, progress_batch_ids: [], baseline })
}
export class PaddonConflict extends Error {
  readonly current: PaddonSnapshot
  constructor(current: PaddonSnapshot, message: string) { super(message); this.name = 'PaddonConflict'; this.current = current }
}
export class PaddonUnknown extends Error {
  readonly operation: PaddonOperation
  constructor(operation: PaddonOperation) {
    super('Paddon amali natijasi noma’lum. Avvalgi tanlov saqlandi; so‘rov qayta yuborilmaydi. Serverdagi joriy holatni tekshiring.')
    this.name = 'PaddonUnknown'; this.operation = operation
  }
}

/** There is no native revision CAS, idempotency key, command receipt or application replay. */
export class PaddonsApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  private requireRead(): void { if (!canReadPaddons(this.session)) throw new ApiError(403, 'forbidden') }
  private requireManage(): void { if (!canManagePaddons(this.session)) throw new ApiError(403, 'forbidden') }
  async list(signal?: AbortSignal): Promise<PaddonList> {
    this.requireRead(); abort(signal)
    const result = parsePaddonList(await this.client.request(paddonsPath, 'GET', { query: { limit: paddonListLimit }, signal, expectedStatus: 200 }))
    abort(signal); return result
  }
  async detail(value: string, signal?: AbortSignal): Promise<PaddonSnapshot> {
    this.requireRead(); abort(signal); const code = normalizePaddonCode(value)
    const result = parsePaddonSnapshot(await this.client.request(`${paddonsPath}/detail`, 'GET', { query: { code }, signal, expectedStatus: 200 }))
    abort(signal); if (result.paddon.code !== code) return invalid(); return result
  }
  async execute(operation: PaddonOperation, signal?: AbortSignal): Promise<PaddonSummary | PaddonSnapshot | null> {
    this.requireManage(); abort(signal)
    if (!['create', 'add', 'remove', 'delete', 'unlock'].includes(operation.kind)) throw new Error('Paddon amalini qayta tanlang.')
    const input = operation.kind === 'create' ? normalizePaddonCreateInput(operation.input) : operation.kind === 'add' || operation.kind === 'remove'
      ? { code: normalizePaddonCode(operation.code), progress_batch_ids: normalizePaddonBatchIds(operation.progress_batch_ids) } : { code: normalizePaddonCode(operation.code, true) }
    if (operation.kind !== 'create') {
      const current = await this.detail(operation.code, signal); abort(signal)
      const baseline = operation.kind === 'delete' ? operation.baseline : operation.baseline.paddon
      if (current.paddon.id !== baseline.id) throw new PaddonConflict(current, 'Paddon yozuvi o‘zgargan. Joriy holatni ko‘rib, amalni qayta boshlang.')
      if ((operation.kind === 'add' || operation.kind === 'remove') && current.free_movement_enabled !== operation.baseline.free_movement_enabled) throw new PaddonConflict(current, 'Paddon harakati qoidasi o‘zgargan. Joriy holatni ko‘rib, amalni qayta boshlang.')
      if ((operation.kind === 'add' || operation.kind === 'remove') && !current.can_manage_items) throw new PaddonConflict(current, 'Bu paddondagi WIP larni hozir o‘zgartirib bo‘lmaydi. Joriy holatni ko‘ring.')
      if (operation.kind === 'unlock' && !current.can_unlock) throw new PaddonConflict(current, 'Bu paddonni ochish uchun server ruxsat bermadi. Joriy holatni ko‘ring.')
      if (operation.kind === 'add' && operation.progress_batch_ids.some(id => {
        const batch = current.available_items.find(item => item.batch_id === id)
        return batch && !canAddPaddonBatch(batch)
      })) throw new PaddonConflict(current, 'Tanlangan WIP ni paddonga qo‘shib bo‘lmaydi. Joriy holatni ko‘rib, tanlovni yangilang.')
      if (operation.kind === 'remove' && operation.progress_batch_ids.some(id => !current.items.some(item => item.batch_id === id))) throw new PaddonConflict(current, 'Tanlangan WIP paddonda topilmadi. Joriy holatni ko‘rib, tanlovni yangilang.')
      if (operation.kind === 'remove' && current.free_movement_enabled && operation.progress_batch_ids.some(id => {
        const batch = current.items.find(item => item.batch_id === id)
        return batch && !canAddPaddonBatch(batch)
      })) throw new PaddonConflict(current, 'Erkin harakatda bu WIP ni paddondan olib bo‘lmaydi. Joriy holatni ko‘rib, tanlovni yangilang.')
      // Bounded available_items is not the entire WIP directory. Native atomic checks remain final.
    }
    const suffix = operation.kind === 'add' ? 'items/add-batch' : operation.kind === 'remove' ? 'items/remove-batch' : operation.kind
    abort(signal)
    try {
      const result = await this.client.request(`${paddonsPath}/${suffix}`, 'POST', { body: input, signal, expectedStatus: 200 }); abort(signal)
      const receipt = record(result)
      if (receipt.ok !== true) return invalid()
      if (operation.kind === 'delete') return null
      if (operation.kind === 'create') {
        const saved = parsePaddonSummary(receipt.paddon)
        if (saved.location !== operation.input.location || saved.note !== operation.input.note || saved.item_count !== 0 || saved.locked_at_unix !== null) return invalid()
        return saved
      }
      const saved = parsePaddonSnapshot(result)
      if (saved.paddon.code !== operation.code || saved.paddon.id !== operation.baseline.paddon.id
        || operation.kind === 'add' && operation.progress_batch_ids.some(id => !saved.items.some(item => item.batch_id === id))
        || operation.kind === 'remove' && operation.progress_batch_ids.some(id => saved.items.some(item => item.batch_id === id))
        || operation.kind === 'unlock' && saved.paddon.locked_at_unix !== null) return invalid()
      return saved
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || [408, 429].includes(error.status) || error.status >= 500 || error.code === 'invalid_response') throw new PaddonUnknown(operation)
      throw error
    }
  }
  async observe(operation: PaddonOperation, signal?: AbortSignal): Promise<PaddonObservation> {
    if (operation.kind === 'create') {
      const list = await this.list(signal)
      // Unknown creation has no known code. A bounded list is only a manual review aid.
      return { paddons: list.items, bounded: list.bounded, state: 'listed' }
    }
    try {
      const snapshot = await this.detail(operation.code, signal)
      const matches = operation.kind === 'add' ? operation.progress_batch_ids.every(id => snapshot.items.some(item => item.batch_id === id))
        : operation.kind === 'remove' ? operation.progress_batch_ids.every(id => !snapshot.items.some(item => item.batch_id === id))
          : operation.kind === 'unlock' ? snapshot.paddon.locked_at_unix === null : false
      return { paddons: [snapshot.paddon], bounded: false, snapshot, state: matches ? 'matches' : 'different' }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.code !== 'invalid_response') return { paddons: [], bounded: false, state: 'missing' }
      throw error
    }
  }
}

export interface PaddonIntent { readonly operation: PaddonOperation; readonly status: 'pending' | 'unknown'; readonly observation?: PaddonObservation }
export class PaddonIntentLedger {
  private intent: PaddonIntent | null = null
  private readonly listeners = new Set<() => void>()
  snapshot = (): PaddonIntent | null => this.intent
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(intent: PaddonIntent | null): void { this.intent = intent && Object.freeze(intent); this.listeners.forEach(listener => listener()) }
  begin(operation: PaddonOperation): void {
    if (this.intent) throw new Error('Avvalgi paddon amali natijasini tekshiring. So‘rov takrorlanmaydi.')
    this.publish({ operation, status: 'pending' })
  }
  unknown(operation: PaddonOperation): void { if (this.intent?.operation === operation) this.publish({ operation, status: 'unknown' }) }
  finish(operation: PaddonOperation): void { if (this.intent?.operation === operation && this.intent.status === 'pending') this.publish(null) }
  observe(operation: PaddonOperation, observation: PaddonObservation): void {
    if (this.intent?.operation === operation && this.intent.status === 'unknown') this.publish({ operation, status: 'unknown', observation })
  }
  resolveReviewed(operation: PaddonOperation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'unknown' || !this.intent.observation) throw new Error('Avval serverdagi joriy holatni tekshiring.')
    this.publish(null)
  }
}
const ledgers = new Map<string, PaddonIntentLedger>()
export function paddonIntentLedger(scope: string): PaddonIntentLedger {
  let ledger = ledgers.get(scope)
  if (!ledger) { ledger = new PaddonIntentLedger(); ledgers.set(scope, ledger) }
  return ledger
}
export function paddonError(error: unknown): string {
  const messages: Record<string, string> = {
    paddon_invalid_input: 'Paddon joyi, izohi, kodi va WIP tanlovini tekshiring.', paddon_not_found: 'Paddon topilmadi yoki sizga ko‘rinmaydi. Joriy ro‘yxatni yangilang.',
    paddon_locked: 'Paddon qulflangan. Joriy holatni tekshiring.', paddon_unlock_forbidden: 'Bu paddonni ochishga ruxsat yo‘q.',
    paddon_already_received: 'Paddon omborga qabul qilingan. Undagi WIP larni o‘zgartirib bo‘lmaydi.', paddon_code_exhausted: 'Paddon kodlari tugagan.',
    paddon_delete_locked: 'Ishlatilgan, qulflangan yoki tarixga ega paddonni o‘chirib bo‘lmaydi.', paddon_item_already_assigned: 'WIP boshqa paddonga biriktirilgan. Joriy holatni tekshiring.',
    paddon_item_not_assigned: 'Tanlangan WIP bu paddonga biriktirilmagan.', progress_batch_not_found: 'Tanlangan WIP topilmadi.', progress_batch_not_accepted: 'Tanlangan WIP ni paddonga qo‘shib yoki undan olib bo‘lmaydi.',
  }
  if (error instanceof ApiError) return messages[error.code] || error.message
  return error instanceof Error ? error.message : 'Paddon amali bajarilmadi.'
}
