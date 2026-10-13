import { ApiClient, ApiError, record, rows } from './api'
import type { Row, ResourceKind, Session } from './api-types'
import { hasCapability } from './permissions'

export const resourceCreateKinds = ['items', 'item-groups', 'customers', 'suppliers', 'workers', 'users', 'warehouses'] as const
export type ResourceCreateKind = typeof resourceCreateKinds[number]
export const resourceCreateCapabilities: Record<ResourceCreateKind, string> = { items: 'catalog.item.create', 'item-groups': 'catalog.item_group.manage', suppliers: 'party.supplier.manage', customers: 'party.customer.manage', warehouses: 'production.map.manage', workers: 'admin.access', users: 'admin.access' }
const paths: Record<ResourceCreateKind, string> = { items: 'items', 'item-groups': 'item-groups', customers: 'customers', suppliers: 'suppliers', workers: 'workers', users: 'system-users', warehouses: 'warehouses' }
const base = '/v1/mobile/admin'
const systemRoles = ['qolipchi', 'boyoqchi', 'tayyorlov_masteri', 'homashyo_rezkachi']
const levels = ['Brigader', 'Master', '1 - darajali', '2 - darajali', '3 - darajali']
const fields: Record<ResourceCreateKind, string[]> = { items: ['code', 'name', 'uom', 'item_group', 'customer_ref', 'customer_name'], 'item-groups': ['name', 'parent', 'is_group'], customers: ['name', 'phone'], suppliers: ['name', 'phone'], workers: ['name', 'phone', 'level'], users: ['role', 'name', 'phone'], warehouses: ['warehouse', 'company', 'parent_warehouse', 'is_group'] }
export interface ResourceCreateContext { groups?: Row[] }
export interface ResourceCreateIntent { kind: ResourceCreateKind; body: Row; codePolicy: 'exact' | 'generated' | 'server' }
export interface ResourceCreateReceipt { kind: ResourceCreateKind; id: string; row: Row; disposition: 'created' | 'saved' | 'existing' }
export interface ResourceCreateReview { kind: ResourceCreateKind; candidates: ResourceCreateReceipt[]; loaded: number; limit: number | null; atLimit: boolean; offset: number; absenceConfirmed: false }
export interface ResourceCreateEntry { values: Row; intent: ResourceCreateIntent | null; error: unknown; review: ResourceCreateReview | null }
export function isResourceCreateKind(kind: ResourceKind | string): kind is ResourceCreateKind { return resourceCreateKinds.some(value => value === kind) }
export function canCreateResource(session: Session | null | undefined, kind: ResourceKind): boolean { return isResourceCreateKind(kind) && hasCapability(session, resourceCreateCapabilities[kind]) && !(kind === 'items' && session?.profile.role === 'material_taminotchi') }
export function canReviewResourceCreate(session: Session | null | undefined, kind: ResourceCreateKind): boolean {
  return kind === 'items' ? hasCapability(session, 'catalog.item.read') && session?.profile.role !== 'material_taminotchi'
    : kind === 'item-groups' ? hasCapability(session, 'catalog.item_group.read') || hasCapability(session, 'gscale.catalog.read')
    : kind === 'customers' ? hasCapability(session, 'party.customer.read') : kind === 'suppliers' ? hasCapability(session, 'party.supplier.read')
    : kind === 'workers' || kind === 'users' ? hasCapability(session, 'admin.access')
    : ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'gscale.catalog.read'].some(code => hasCapability(session, code))
}
function invalid(): never { throw new ApiError(502, 'invalid_create_receipt', 'Saqlangan yozuv server javobida tasdiqlanmadi. Ro‘yxatdagi holatni tekshiring.') }
function value(input: Row, field: string, optional = false): string {
  const fieldValue = input[field]
  if (optional && fieldValue === undefined) return ''
  if (typeof fieldValue !== 'string' || !optional && !fieldValue.trim()) throw new Error('Majburiy maydonlarni to‘ldiring.')
  return fieldValue.trim()
}
function bool(input: Row, field: string): boolean { if (input[field] === undefined) return false; if (typeof input[field] !== 'boolean') throw new Error('Guruh turini tanlang.'); return input[field] as boolean }
function string(row: Row, field: string, empty = false): string { const v = row[field]; if (typeof v !== 'string' || !empty && !v.trim()) return invalid(); return v }
function boolean(row: Row, field: string): boolean { if (typeof row[field] !== 'boolean') return invalid(); return row[field] as boolean }
function same(a: unknown, b: unknown): void { if (a !== b) return invalid() }
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) return invalid(); return [...value] as string[] }
const asciiLower = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase())
export function resourceCreateItemCodePolicy(groupName: string, groups?: Row[]): ResourceCreateIntent['codePolicy'] {
  if (groups?.some(group => typeof group.name !== 'string' || !group.name.trim() || typeof group.item_group_name !== 'string' || !group.item_group_name.trim() || typeof group.parent_item_group !== 'string' || typeof group.is_group !== 'boolean')) throw new Error('Material guruhlari to‘liq yuklanmagan. Qayta yuklang.')
  let current = groupName.trim() || 'All Item Groups'
  const visited = new Set<string>()
  while (current && !visited.has(asciiLower(current))) {
    if (asciiLower(current) === 'tayyor mahsulot') return 'generated'
    visited.add(asciiLower(current))
    if (asciiLower(current) === 'all item groups') return 'exact'
    const group = groups?.find(group => typeof group.name === 'string' && asciiLower(group.name.trim()) === asciiLower(current) || typeof group.item_group_name === 'string' && asciiLower(group.item_group_name.trim()) === asciiLower(current))
    if (!group) return groups ? 'exact' : 'server'
    if (typeof group.parent_item_group !== 'string') throw new Error('Material guruhlari to‘liq yuklanmagan. Qayta yuklang.')
    current = group.parent_item_group.trim()
  }
  return 'exact'
}
export function normalizeCreateCustomerPhone(phone: string): string {
  let clean = phone.trim().replace(/[ ()-]/g, '')
  if (!clean.startsWith('+') && clean.length === 9) clean = `998${clean}`
  const digits = clean.replaceAll('+', '')
  if (!/^\d{9,12}$/.test(digits)) throw new Error('Telefon raqamini tekshiring: 9–12 ta raqam kiriting.')
  return `+${digits}`
}
/** Only native create fields are sent. Native worker/system POSTs are upserts; a supplied ID must never turn this form into an update. */
export function resourceCreateIntent(kind: ResourceCreateKind, input: Row, context: ResourceCreateContext = {}): ResourceCreateIntent {
  for (const key of ['id', 'ref', 'entity_ref', 'original_code']) if (input[key] !== undefined && input[key] !== '') throw new Error('Yangi yozuv uchun mavjud identifikatorni yubormang.')
  let body: Row, codePolicy: ResourceCreateIntent['codePolicy'] = 'exact'
  if (kind === 'items') {
    const itemGroup = value(input, 'item_group', true) || 'All Item Groups'
    codePolicy = resourceCreateItemCodePolicy(itemGroup, context.groups)
    const customer = value(input, 'customer_ref', true), code = value(input, 'code', true)
    if (codePolicy === 'generated' && !customer) throw new Error('Tayyor mahsulot uchun mijozni tanlang.')
    if (codePolicy === 'exact' && !code) throw new Error('Mahsulot kodini kiriting.')
    body = { code: codePolicy === 'generated' ? '' : code, name: value(input, 'name'), uom: value(input, 'uom'), item_group: itemGroup, customer_ref: customer }
  } else if (kind === 'item-groups') body = { name: value(input, 'name'), parent: value(input, 'parent', true) || 'All Item Groups', is_group: bool(input, 'is_group') }
  else if (kind === 'warehouses') body = { warehouse: value(input, 'warehouse'), company: value(input, 'company', true), parent_warehouse: value(input, 'parent_warehouse', true), is_group: bool(input, 'is_group') }
  else {
    const name = value(input, 'name'), phone = value(input, 'phone', true)
    body = { name, phone: kind === 'customers' && phone ? normalizeCreateCustomerPhone(phone) : phone }
    if (kind === 'workers') { const level = levels.find(level => asciiLower(level) === asciiLower(value(input, 'level'))); if (!level) throw new Error('Ishchining malaka darajasini tanlang.'); body.level = level }
    if (kind === 'users') { const role = value(input, 'role'); if (!systemRoles.includes(role)) throw new Error('Foydalanuvchi vazifasini tanlang.'); if (!phone) throw new Error('Telefon raqamini kiriting.'); body.role = role }
  }
  return { kind, body, codePolicy }
}
export function resourceCreateDraft(kind: ResourceKind, input: Row): Row {
  if (!isResourceCreateKind(kind)) return {}
  return Object.fromEntries(fields[kind].filter(key => typeof input[key] === 'string' || typeof input[key] === 'boolean').map(key => [key, input[key]]))
}
/** Whitelisted receipts preserve item codes as business identity; login codes/avatars/unknown fields are never retained. */
export function parseResourceCreateReceipt(intent: ResourceCreateIntent, response: unknown, existing = false): ResourceCreateReceipt {
  const raw = record(response), { kind, body } = intent
  if (raw.ok === false || typeof raw.error === 'string' && raw.error.trim()) return invalid()
  let row: Row, id: string
  if (kind === 'items') {
    id = string(raw, 'code'); if (intent.codePolicy === 'exact') same(id, body.code)
    row = { code: id, name: string(raw, 'name'), uom: string(raw, 'uom'), item_group: string(raw, 'item_group') }
    same(row.name, body.name); same(row.uom, body.uom); same(row.item_group, body.item_group)
  } else if (kind === 'item-groups') {
    id = string(raw, 'name'); row = { name: id, item_group_name: string(raw, 'item_group_name'), parent_item_group: string(raw, 'parent_item_group', true), is_group: boolean(raw, 'is_group') }
    same(id, body.name); same(row.item_group_name, body.name); same(row.parent_item_group, body.parent); same(row.is_group, body.is_group)
  } else if (kind === 'warehouses') {
    id = string(raw, 'warehouse'); row = { warehouse: id, company: string(raw, 'company', true), parent_warehouse: string(raw, 'parent_warehouse', true), is_group: boolean(raw, 'is_group') }
    for (const key of Object.keys(body)) same(row[key], body[key])
  } else {
    id = string(raw, kind === 'suppliers' || kind === 'customers' ? 'ref' : 'id')
    row = { [kind === 'suppliers' || kind === 'customers' ? 'ref' : 'id']: id, name: string(raw, 'name'), phone: string(raw, 'phone', true) }
    same(row.name, body.name); same(row.phone, body.phone)
    if (kind === 'workers') { row.level = string(raw, 'level'); same(row.level, body.level); if (!existing && !/^worker_[a-f0-9]{24}$/.test(id)) return invalid() }
    if (kind === 'users') { row.role = string(raw, 'role'); same(row.role, body.role); if (!existing && !new RegExp(`^${String(body.role)}_[a-f0-9]{24}$`).test(id)) return invalid() }
    if (kind === 'suppliers') {
      row.blocked = boolean(raw, 'blocked'); row.removed = boolean(raw, 'removed'); row.assigned_item_codes = strings(raw.assigned_item_codes)
      if (!Number.isSafeInteger(raw.assigned_item_count) || Number(raw.assigned_item_count) < 0) return invalid()
      row.assigned_item_count = raw.assigned_item_count
      if (row.blocked || row.removed) return invalid()
    }
  }
  if (id !== id.trim() || !id.trim()) return invalid()
  return { kind, id, row, disposition: existing ? 'existing' : kind === 'warehouses' || kind === 'item-groups' ? 'saved' : 'created' }
}
export class ResourceCreateUnknown extends Error {
  readonly intent: ResourceCreateIntent
  constructor(intent: ResourceCreateIntent) { super('Saqlash natijasi tasdiqlanmadi. Takroriy yozuv yaratmaslik uchun avval ro‘yxatni tekshiring.'); this.name = 'ResourceCreateUnknown'; this.intent = structuredClone(intent) }
}
export function resourceCreateError(error: unknown): string { return error instanceof ApiError && error.status === 403 ? 'Bu amal uchun ruxsat yetarli emas.' : error instanceof Error ? error.message : 'Yozuv saqlanmadi.' }
export class ResourceCreateMemory {
  private scope: string | null = null
  private entries = new Map<string, ResourceCreateEntry>()
  private listeners = new Map<string, Set<() => void>>()
  activate(scope: string): void { if (this.scope !== scope) { this.scope = scope; this.entries.clear(); this.listeners.clear() } }
  read(scope: string, kind: ResourceKind, initial: Row = {}): ResourceCreateEntry | null {
    if (scope !== this.scope) return null
    let entry = this.entries.get(kind)
    if (!entry) { entry = { values: resourceCreateDraft(kind, initial), intent: null, error: null, review: null }; this.entries.set(kind, entry) }
    return entry
  }
  patch(scope: string, kind: ResourceKind, patch: Partial<ResourceCreateEntry>): boolean {
    const before = this.read(scope, kind); if (!before) return false
    this.entries.set(kind, { ...before, ...patch, ...(patch.values ? { values: resourceCreateDraft(kind, patch.values) } : {}) })
    for (const listener of this.listeners.get(kind) ?? []) listener()
    return true
  }
  subscribe(scope: string, kind: ResourceKind, listener: () => void): () => void {
    if (scope !== this.scope) return () => {}
    const listeners = this.listeners.get(kind) ?? new Set<() => void>(); listeners.add(listener); this.listeners.set(kind, listeners)
    return () => { listeners.delete(listener) }
  }
  markSent(scope: string, intent: ResourceCreateIntent): void {
    const entry = this.read(scope, intent.kind)
    if (!entry) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
    if (entry.intent) throw new ResourceCreateUnknown(entry.intent)
    this.patch(scope, intent.kind, { intent: structuredClone(intent), values: Object.keys(entry.values).length ? entry.values : intent.body, error: new ResourceCreateUnknown(intent), review: null })
  }
  newDecision(scope: string, kind: ResourceKind, initial: Row, confirmed: boolean): void {
    if (!confirmed) throw new Error('Yangi yozuv boshlash qarorini tasdiqlang.')
    this.patch(scope, kind, { values: initial, intent: null, error: null, review: null })
  }
}
export const resourceCreateMemory = new ResourceCreateMemory()
export class ResourceCreateApi {
  private readonly client: ApiClient
  private readonly session: Session
  private readonly onWrite: (intent: ResourceCreateIntent) => void
  constructor(client: ApiClient, session: Session, onWrite: (intent: ResourceCreateIntent) => void = () => {}) { this.client = client; this.session = session; this.onWrite = onWrite }
  async create(kind: ResourceCreateKind, body: Row, context: ResourceCreateContext = {}, signal?: AbortSignal): Promise<ResourceCreateReceipt> {
    if (!canCreateResource(this.session, kind)) throw new ApiError(403, 'forbidden')
    const intent = resourceCreateIntent(kind, body, context)
    if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
    this.onWrite(intent)
    try { return parseResourceCreateReceipt(intent, await this.client.request(`${base}/${paths[kind]}`, 'POST', { body: intent.body, signal })) }
    catch (error) {
      if (signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error
      if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status >= 200 && error.status < 300) throw new ResourceCreateUnknown(intent)
      throw error
    }
  }
  async review(intent: ResourceCreateIntent, offset = 0, signal?: AbortSignal): Promise<ResourceCreateReview> {
    const { kind, body } = intent
    if (!canReviewResourceCreate(this.session, kind)) throw new ApiError(403, 'forbidden')
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Ro‘yxat sahifasini tekshiring.')
    const paged = ['items', 'customers', 'suppliers'].includes(kind), limit = kind === 'item-groups' ? null : paged ? 50 : 500
    const path = kind === 'item-groups' ? 'item-groups/tree' : kind === 'customers' || kind === 'suppliers' ? `${kind}/list` : paths[kind]
    const query = kind === 'item-groups' ? {} : { limit: limit!, ...(paged ? { offset } : {}), ...(kind === 'items' ? { q: intent.codePolicy === 'exact' ? String(body.code) : String(body.name) } : kind === 'suppliers' ? {} : kind === 'warehouses' ? { q: String(body.warehouse) } : { q: String(body.name) }), ...(kind === 'users' ? { role: String(body.role) } : {}) }
    const list = rows(await this.client.request(`${base}/${path}`, 'GET', { query, signal }))
    const candidates: ResourceCreateReceipt[] = []
    for (const candidate of list) { try { candidates.push(parseResourceCreateReceipt(intent, candidate, true)) } catch (error) { if (!(error instanceof ApiError) || error.code !== 'invalid_create_receipt') throw error } }
    return { kind, candidates, loaded: list.length, limit, atLimit: limit !== null && list.length >= limit, offset: paged ? offset : 0, absenceConfirmed: false }
  }
  acknowledgeExisting(intent: ResourceCreateIntent, candidate: Row, confirmed: boolean): ResourceCreateReceipt {
    if (!confirmed) throw new Error('Topilgan yozuvdan foydalanishni tasdiqlang.')
    return parseResourceCreateReceipt(intent, candidate, true)
  }
}
