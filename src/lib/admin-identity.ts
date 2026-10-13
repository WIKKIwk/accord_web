import { ApiClient, ApiError, record, rows, text } from './api'
import type { ResourceKind, Row, Session } from './api-types'
import { hasCapability } from './permissions'

const base = '/v1/mobile/admin'
const systemUserRoles = ['qolipchi', 'boyoqchi', 'tayyorlov_masteri', 'homashyo_rezkachi']
// mini_rs_erp/core/workers.rs: the backend has no levels catalog endpoint.
export const workerLevels = ['Brigader', 'Master', '1 - darajali', '2 - darajali', '3 - darajali'] as const

export interface AdminIdentity {
  kind: 'worker' | 'system' | 'material'
  role: string
  ref: string
  name: string
  phone: string
  level: string
}
export interface IdentityDetail extends AdminIdentity {
  codeLocked: boolean
  codeRetryAfterSec: number
  assignedItemGroups: string[]
}
export interface CapabilityChoice { code: string; label: string; default_roles: string[] }
export interface IdentityRole { id: string; label: string; base_role?: string; capability_codes: string[]; system: boolean }
export interface IdentityAssignment { principal_role: string; principal_ref: string; role_id: string; assigned_apparatus: string[]; assigned_item_groups: string[] }
export interface ScopeChoice { value: string; label: string }
export interface ScopeCatalog { items: ScopeChoice[]; bounded: boolean }
export interface WarehouseIdentityAssignment {
  assignment_kind: 'warehouse' | 'apparatus'
  warehouse: string
  warehouse_name?: string
  apparatus_id?: string
  principal_role: string
  principal_ref: string
  display_name: string
}
export interface WorkerDependency { kind: string; label: string; apparatus: string; order_id: string; status: string }
export interface WorkerRemovalCheck {
  worker_id: string
  worker_name: string
  blocked: boolean
  requires_confirmation: boolean
  active_work: WorkerDependency[]
  connections: WorkerDependency[]
}

function invalidResponse(): never { throw new ApiError(502, 'invalid_response', 'Serverdan kutilgan ma’lumot to‘liq kelmadi. Yangilab qayta urinib ko‘ring.') }
function stringField(row: Row, field: string, allowEmpty = false): string {
  const value = row[field]
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) return invalidResponse()
  return value
}
function stringArray(value: unknown, optional = false): string[] {
  if (value === undefined && optional) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) return invalidResponse()
  return [...value] as string[]
}
function unique(values: string[]): string[] { return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort() }
export function isIdentityApparatusId(value: string): boolean {
  return value.length <= 128 && /^apparatus:[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(value)
}

/** User-list IDs are presentation IDs; only entity_ref identifies the native record. */
export function resolveAdminIdentity(kind: ResourceKind, row: Row): AdminIdentity | null {
  if (kind !== 'users' && kind !== 'workers') return null
  const role = kind === 'workers' ? 'aparatchi' : text(row.principal_role ?? row.role, '').trim()
  const identityKind = role === 'aparatchi' ? 'worker' : systemUserRoles.includes(role) ? 'system' : role === 'material_taminotchi' ? 'material' : null
  if (!identityKind) return null
  const ref = text(kind === 'workers' ? row.id : row.entity_ref ?? row.ref ?? row.id, '').trim()
  if (!ref || /^(worker|system_user|customer|supplier):/.test(ref)) return null
  return {
    kind: identityKind, role, ref, name: text(row.name, ''), phone: text(row.phone, ''),
    level: identityKind === 'worker' ? text(row.level ?? row.role_label, '') : '',
  }
}
export function isCurrentIdentity(session: Session | null | undefined, identity: AdminIdentity): boolean {
  return session?.profile.role === identity.role && session.profile.ref?.trim() === identity.ref
}
export function canReadIdentityItemGroups(session: Session | null | undefined): boolean {
  return hasCapability(session, 'catalog.item_group.read') || hasCapability(session, 'gscale.catalog.read')
}
export function warehouseAssigneeAllowed(identity: AdminIdentity): boolean {
  return ['material_taminotchi', 'qolipchi', 'tayyorlov_masteri', 'homashyo_rezkachi'].includes(identity.role)
    || identity.role === 'aparatchi' && identity.level.trim().toLowerCase() === 'brigader'
}
export function canAssignIdentityRole(role: IdentityRole, identity: AdminIdentity): boolean {
  if (!role.system) return true
  if (role.id === 'aparatchi') return identity.role === 'aparatchi'
  return Boolean(role.base_role && role.base_role === identity.role)
}
export function roleFromRow(value: unknown): IdentityRole {
  const row = record(value)
  if (typeof row.system !== 'boolean' || row.base_role !== undefined && row.base_role !== null && typeof row.base_role !== 'string') return invalidResponse()
  return { id: stringField(row, 'id'), label: stringField(row, 'label'), system: row.system,
    ...(typeof row.base_role === 'string' ? { base_role: row.base_role } : {}), capability_codes: stringArray(row.capability_codes) }
}
function assignmentFromRow(value: unknown): IdentityAssignment {
  const row = record(value)
  const apparatus = stringArray(row.assigned_apparatus, true)
  if (apparatus.some(value => !isIdentityApparatusId(value))) return invalidResponse()
  return { principal_role: stringField(row, 'principal_role'), principal_ref: stringField(row, 'principal_ref'),
    role_id: stringField(row, 'role_id'), assigned_apparatus: apparatus, assigned_item_groups: stringArray(row.assigned_item_groups, true) }
}
export function assignmentForIdentity(assignments: IdentityAssignment[], identity: AdminIdentity): IdentityAssignment | undefined {
  return assignments.find(assignment => assignment.principal_role === identity.role && assignment.principal_ref.trim() === identity.ref)
}
export function ownRoleAccessPreserved(session: Session, roleId: string, selectedCodes: string[], assignments: IdentityAssignment[]): boolean {
  const ownAssignment = assignments.find(assignment => assignment.principal_role === session.profile.role && assignment.principal_ref.trim() === session.profile.ref?.trim())
  return ownAssignment?.role_id !== roleId || ['admin.access', 'role.capability.read', 'role.capability.manage'].every(code => !session.capabilities.includes(code) || selectedCodes.includes(code))
}
function safeDetail(value: unknown, identity: AdminIdentity): IdentityDetail {
  const row = record(value)
  const ref = stringField(row, identity.kind === 'material' ? 'ref' : 'id')
  if (ref !== identity.ref || identity.kind === 'system' && row.role !== identity.role) return invalidResponse()
  if (row.code_locked !== undefined && typeof row.code_locked !== 'boolean') return invalidResponse()
  if (row.code_retry_after_sec !== undefined && (typeof row.code_retry_after_sec !== 'number' || !Number.isFinite(row.code_retry_after_sec) || row.code_retry_after_sec < 0)) return invalidResponse()
  const level = identity.kind === 'worker' ? stringField(row, 'level') : ''
  if (identity.kind === 'worker' && !workerLevels.some(value => value === level)) return invalidResponse()
  // Never retain a code returned by a detail/update endpoint in React Query.
  return { ...identity, ref, name: stringField(row, 'name'), phone: stringField(row, 'phone', true), level,
    codeLocked: row.code_locked === true, codeRetryAfterSec: Number(row.code_retry_after_sec) || 0,
    assignedItemGroups: stringArray(row.assigned_item_groups, true) }
}
function warehouseAssignment(value: unknown): WarehouseIdentityAssignment {
  const row = record(value)
  const kind = row.assignment_kind ?? 'warehouse'
  if (kind !== 'warehouse' && kind !== 'apparatus') return invalidResponse()
  const result: WarehouseIdentityAssignment = { assignment_kind: kind, warehouse: stringField(row, 'warehouse', true),
    principal_role: stringField(row, 'principal_role'), principal_ref: stringField(row, 'principal_ref'), display_name: stringField(row, 'display_name', true) }
  if (typeof row.warehouse_name === 'string' && row.warehouse_name.trim()) result.warehouse_name = row.warehouse_name
  if (typeof row.apparatus_id === 'string' && row.apparatus_id.trim()) result.apparatus_id = row.apparatus_id
  if (kind === 'apparatus' ? !result.apparatus_id || !isIdentityApparatusId(result.apparatus_id) : !(result.warehouse_name || result.warehouse)) return invalidResponse()
  return result
}
export function warehouseAssignmentKey(assignment: WarehouseIdentityAssignment): string {
  return `${assignment.assignment_kind}:${assignment.assignment_kind === 'apparatus' ? assignment.apparatus_id : assignment.warehouse_name || assignment.warehouse}`
}
export function parseWorkerRemovalCheck(value: unknown, workerId: string): WorkerRemovalCheck {
  const row = record(value)
  if (row.worker_id !== workerId || typeof row.blocked !== 'boolean' || typeof row.requires_confirmation !== 'boolean') return invalidResponse()
  const parseDependencies = (field: string) => rows(row, field).map(item => {
    const apparatus = stringField(item, 'apparatus', true)
    if (apparatus && !isIdentityApparatusId(apparatus)) return invalidResponse()
    return { kind: stringField(item, 'kind'), label: stringField(item, 'label', true), apparatus,
      order_id: stringField(item, 'order_id', true), status: stringField(item, 'status', true) }
  })
  const activeWork = parseDependencies('active_work'), connections = parseDependencies('connections')
  return { worker_id: workerId, worker_name: stringField(row, 'worker_name'),
    blocked: row.blocked || activeWork.length > 0, requires_confirmation: row.requires_confirmation || connections.length > 0,
    active_work: activeWork, connections }
}
function removalFingerprint(check: WorkerRemovalCheck): string {
  return JSON.stringify({ blocked: check.blocked, confirmation: check.requires_confirmation,
    active: check.active_work.map(row => JSON.stringify(row)).sort(), connections: check.connections.map(row => JSON.stringify(row)).sort() })
}
export class WorkerRemovalConflict extends Error {
  readonly check: WorkerRemovalCheck
  constructor(check: WorkerRemovalCheck) {
    super(check.blocked ? 'Ishchining faol ishi bor. Ishlar tugagandan so‘ng qayta tekshiring.' : 'Ishchining ulanishlari o‘zgargan. Yangilangan ro‘yxatni ko‘rib, qayta tasdiqlang.')
    this.name = 'WorkerRemovalConflict'
    this.check = check
  }
}
export function identityErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Bu amal uchun ruxsat yetarli emas.'
  if (error instanceof ApiError && error.status === 409) return 'Ma’lumot yoki ulanishlar o‘zgargan. Yangilab qayta urinib ko‘ring.'
  if (error instanceof ApiError && error.status === 429) return 'Kod yangilash chegarasiga yetildi. Birozdan keyin qayta urinib ko‘ring.'
  return error instanceof Error ? error.message : 'Amal bajarilmadi. Qayta urinib ko‘ring.'
}

/** Native identity contracts; deliberately excludes unsupported remove/block operations. */
export class AdminIdentityApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  private require(code: string): void { if (!hasCapability(this.session, code)) throw new ApiError(403, 'forbidden') }
  private identity(identity: AdminIdentity, kind?: AdminIdentity['kind']): void {
    const resolved = resolveAdminIdentity('users', { principal_role: identity.role, entity_ref: identity.ref })
    if (!resolved || resolved.kind !== identity.kind || resolved.ref !== identity.ref || kind && identity.kind !== kind) throw new Error('Foydalanuvchi tanlovi noto‘g‘ri.')
  }
  async detail(identity: AdminIdentity, signal?: AbortSignal): Promise<IdentityDetail> {
    this.identity(identity)
    this.require(identity.kind === 'material' ? 'party.customer.read' : 'admin.access')
    const path = identity.kind === 'worker' ? 'workers/detail' : identity.kind === 'system' ? 'system-users/detail' : 'material-taminotchilar/detail'
    return safeDetail(await this.client.request(`${base}/${path}`, 'GET', { query: { [identity.kind === 'material' ? 'ref' : 'id']: identity.ref }, signal }), identity)
  }
  async capabilities(signal?: AbortSignal): Promise<CapabilityChoice[]> {
    this.require('role.capability.read')
    const result = rows(await this.client.request(`${base}/capabilities`, 'GET', { signal })).map(row => ({ code: stringField(row, 'code'), label: stringField(row, 'label'), default_roles: stringArray(row.default_roles) }))
    if (new Set(result.map(row => row.code)).size !== result.length) return invalidResponse()
    return result
  }
  async roles(signal?: AbortSignal): Promise<IdentityRole[]> {
    this.require('role.capability.read')
    return rows(await this.client.request(`${base}/roles`, 'GET', { signal })).map(roleFromRow)
  }
  async assignments(signal?: AbortSignal): Promise<IdentityAssignment[]> {
    this.require('role.capability.read')
    return rows(await this.client.request(`${base}/role-assignments`, 'GET', { signal })).map(assignmentFromRow)
  }
  async saveRole(input: Pick<IdentityRole, 'id' | 'label' | 'capability_codes'>, catalog: CapabilityChoice[], knownRoles: IdentityRole[], creating: boolean, signal?: AbortSignal): Promise<IdentityRole> {
    this.require('role.capability.manage')
    const id = input.id.trim().toLowerCase(), label = input.label.trim(), codes = unique(input.capability_codes)
    const existing = knownRoles.find(role => role.id === id)
    if (existing?.system) throw new Error('Tizim roli himoyalangan.')
    if (creating && existing) throw new Error('Bu rol kodi mavjud. Boshqa kod kiriting.')
    if (!creating && !existing) throw new Error('Rol topilmadi. Ro‘yxatni yangilang.')
    if (!/^[a-z0-9_-]+$/.test(id) || !label || !codes.length) throw new Error('Rol kodi, nomi va kamida bitta ruxsatni kiriting.')
    if (codes.some(code => !catalog.some(choice => choice.code === code))) throw new Error('Ruxsatni server ro‘yxatidan tanlang.')
    if (!ownRoleAccessPreserved(this.session, id, codes, await this.assignments(signal))) throw new Error('O‘z boshqaruv ruxsatlaringizni saqlab qoling.')
    const saved = roleFromRow(await this.client.request(`${base}/roles`, 'PUT', { body: { id, label, capability_codes: codes }, signal }))
    if (saved.id !== id || saved.system || saved.label !== label || unique(saved.capability_codes).join('\0') !== codes.join('\0')) return invalidResponse()
    return saved
  }
  async saveAssignment(identity: AdminIdentity, input: Pick<IdentityAssignment, 'role_id' | 'assigned_apparatus' | 'assigned_item_groups'>, roles: IdentityRole[], signal?: AbortSignal): Promise<IdentityAssignment> {
    this.require('role.capability.manage'); this.identity(identity)
    if (isCurrentIdentity(this.session, identity)) throw new Error('O‘z rolingizni bu yerdan o‘zgartirib bo‘lmaydi.')
    const role = roles.find(role => role.id === input.role_id)
    if (!role || !canAssignIdentityRole(role, identity)) throw new Error('Bu foydalanuvchiga mos rolni tanlang.')
    const apparatus = unique(input.assigned_apparatus), groups = unique(input.assigned_item_groups)
    if (apparatus.some(value => !isIdentityApparatusId(value))) throw new Error('Apparatni ro‘yxatdan tanlang.')
    if (role.capability_codes.includes('apparatus.queue.read') && !apparatus.length) throw new Error('Kamida bitta apparatni biriktiring.')
    if (identity.role === 'material_taminotchi' && role.id === 'material_taminotchi' && !groups.length) throw new Error('Kamida bitta mahsulot guruhini biriktiring.')
    const saved = assignmentFromRow(await this.client.request(`${base}/role-assignments`, 'PUT', { body: {
      principal_role: identity.role, principal_ref: identity.ref, role_id: role.id, assigned_apparatus: apparatus, assigned_item_groups: groups,
    }, signal }))
    if (saved.principal_role !== identity.role || saved.principal_ref !== identity.ref || saved.role_id !== role.id || unique(saved.assigned_apparatus).join('\0') !== apparatus.join('\0') || unique(saved.assigned_item_groups).join('\0') !== groups.join('\0')) return invalidResponse()
    return saved
  }
  async updateWorker(identity: AdminIdentity, field: 'name' | 'phone' | 'level', value: string, signal?: AbortSignal): Promise<IdentityDetail> {
    this.require('admin.access'); this.identity(identity, 'worker')
    const normalized = value.trim()
    if (!normalized) throw new Error(field === 'name' ? 'Ismni kiriting.' : field === 'phone' ? 'Telefon raqamini kiriting.' : 'Darajani tanlang.')
    if (field === 'level' && !workerLevels.some(level => level === normalized)) throw new Error('Darajani ro‘yxatdan tanlang.')
    // The handler dispatches based on fields: a combined body only updates level.
    const saved = safeDetail(await this.client.request(`${base}/workers`, 'PUT', { body: { id: identity.ref, [field]: normalized }, signal }), identity)
    if (saved[field] !== normalized) return invalidResponse()
    return saved
  }
  async updateSystemUser(identity: AdminIdentity, name: string, phone: string, signal?: AbortSignal): Promise<IdentityDetail> {
    this.require('admin.access'); this.identity(identity, 'system')
    if (!name.trim() || !phone.trim()) throw new Error('Ism va telefon raqamini kiriting.')
    const saved = safeDetail(await this.client.request(`${base}/system-users`, 'PUT', { body: { id: identity.ref, role: identity.role, name: name.trim(), phone: phone.trim() }, signal }), identity)
    if (saved.name !== name.trim() || saved.phone !== phone.trim()) return invalidResponse()
    return saved
  }
  async updateMaterialPhone(identity: AdminIdentity, phone: string, signal?: AbortSignal): Promise<IdentityDetail> {
    this.require('party.customer.manage'); this.identity(identity, 'material')
    if (!phone.trim()) throw new Error('Telefon raqamini kiriting.')
    return safeDetail(await this.client.request(`${base}/material-taminotchilar/phone`, 'PUT', { query: { ref: identity.ref }, body: { phone: phone.trim() }, signal }), identity)
  }
  async updateMaterialGroups(identity: AdminIdentity, groups: string[], signal?: AbortSignal): Promise<IdentityDetail> {
    this.require('admin.access'); this.identity(identity, 'material')
    if (isCurrentIdentity(this.session, identity)) throw new Error('O‘z ruxsat doirangizni bu yerdan o‘zgartirib bo‘lmaydi.')
    const selected = unique(groups)
    if (!selected.length) throw new Error('Kamida bitta mahsulot guruhini biriktiring.')
    return safeDetail(await this.client.request(`${base}/material-taminotchilar/item-groups`, 'PUT', { query: { ref: identity.ref }, body: { assigned_item_groups: selected }, signal }), identity)
  }
  async apparatus(q = '', signal?: AbortSignal): Promise<ScopeCatalog> {
    this.require('admin.access')
    const list = rows(await this.client.request(`${base}/apparatus`, 'GET', { query: { q, limit: 500 }, signal }))
    const items = list.flatMap(row => {
      const id = stringField(row, 'apparatus_id'), display = record(row.display), lifecycle = record(row.lifecycle)
      if (!isIdentityApparatusId(id)) return invalidResponse()
      return lifecycle.state === 'active' ? [{ value: id, label: stringField(display, 'display_name') }] : []
    })
    return { items, bounded: list.length >= 500 }
  }
  async itemGroups(signal?: AbortSignal): Promise<ScopeCatalog> {
    if (!canReadIdentityItemGroups(this.session)) throw new ApiError(403, 'forbidden')
    const list = rows(await this.client.request(`${base}/item-groups/tree`, 'GET', { signal }))
    return { items: list.map(row => ({ value: stringField(row, 'item_group_name'), label: stringField(row, 'item_group_name') })), bounded: false }
  }
  async warehouses(q = '', signal?: AbortSignal): Promise<ScopeCatalog> {
    this.require('admin.access')
    const list = rows(await this.client.request(`${base}/warehouses`, 'GET', { query: { q, limit: 500 }, signal }))
    return { items: list.filter(row => row.is_group !== true).map(row => ({ value: stringField(row, 'warehouse'), label: stringField(row, 'warehouse') })), bounded: list.length >= 500 }
  }
  async warehouseAssignments(identity: AdminIdentity, signal?: AbortSignal): Promise<WarehouseIdentityAssignment[]> {
    this.identity(identity)
    this.require(this.session.profile.role === 'material_taminotchi' ? 'raw_material.assign' : this.session.profile.role === 'werka' ? 'inventory.movement.manage' : 'catalog.item.read')
    return rows(await this.client.request(`${base}/warehouses/assignments`, 'GET', { signal })).map(warehouseAssignment)
      .filter(row => row.principal_role === identity.role && row.principal_ref.trim() === identity.ref)
  }
  async assignWarehouse(identity: AdminIdentity, kind: 'warehouse' | 'apparatus', value: string, signal?: AbortSignal): Promise<WarehouseIdentityAssignment> {
    this.require('admin.access'); this.identity(identity)
    const current = await this.detail(identity, signal)
    if (!warehouseAssigneeAllowed(current)) throw new Error('Bu vazifaga ombor biriktirib bo‘lmaydi.')
    if (!value.trim() || kind === 'apparatus' && !isIdentityApparatusId(value)) throw new Error('Ombor yoki apparatni ro‘yxatdan tanlang.')
    const body = { assignment_kind: kind, warehouse: kind === 'warehouse' ? value : '',
      ...(kind === 'warehouse' ? { warehouse_name: value } : { apparatus_id: value }),
      principal_role: identity.role, principal_ref: identity.ref, display_name: current.name }
    const saved = warehouseAssignment(await this.client.request(`${base}/warehouses/assignments`, 'POST', { body, signal }))
    if (saved.principal_role !== identity.role || saved.principal_ref !== identity.ref || warehouseAssignmentKey(saved) !== `${kind}:${value}`) return invalidResponse()
    return saved
  }
  async unassignWarehouse(identity: AdminIdentity, assignment: WarehouseIdentityAssignment, confirmed: boolean, signal?: AbortSignal): Promise<void> {
    this.require('admin.access'); this.identity(identity)
    if (!confirmed || assignment.principal_role !== identity.role || assignment.principal_ref !== identity.ref) throw new Error('Ombor ulanishini olib tashlashni tasdiqlang.')
    const { display_name: _displayName, ...body } = assignment
    const saved = record(await this.client.request(`${base}/warehouses/assignments`, 'DELETE', { body, signal }))
    const removed = warehouseAssignment(saved.assignment)
    if (saved.ok !== true || removed.principal_role !== identity.role || removed.principal_ref !== identity.ref || warehouseAssignmentKey(removed) !== warehouseAssignmentKey(assignment)) return invalidResponse()
  }
  async regenerateCode(identity: AdminIdentity, confirmed: boolean, signal?: AbortSignal): Promise<{ code: string; detail: IdentityDetail }> {
    this.identity(identity)
    this.require(identity.kind === 'material' ? 'party.customer.code.manage' : 'admin.access')
    if (!confirmed) throw new Error('Kirish kodini yangilashni tasdiqlang.')
    const path = identity.kind === 'worker' ? 'workers' : identity.kind === 'system' ? 'system-users' : 'material-taminotchilar'
    const result = record(await this.client.request(`${base}/${path}/code/regenerate`, 'POST', { query: { [identity.kind === 'material' ? 'ref' : 'id']: identity.ref }, signal }))
    return { code: stringField(result, 'code'), detail: safeDetail(result, identity) }
  }
  async workerRemovalCheck(identity: AdminIdentity, signal?: AbortSignal): Promise<WorkerRemovalCheck> {
    this.require('admin.access'); this.identity(identity, 'worker')
    if (isCurrentIdentity(this.session, identity)) throw new Error('O‘z hisobingizni faolsizlantirib bo‘lmaydi.')
    return parseWorkerRemovalCheck(await this.client.request(`${base}/workers/delete-check`, 'GET', { query: { id: identity.ref }, signal }), identity.ref)
  }
  async removeWorker(identity: AdminIdentity, observed: WorkerRemovalCheck, confirmed: boolean, confirmConnections: boolean, signal?: AbortSignal): Promise<void> {
    this.require('admin.access'); this.identity(identity, 'worker')
    if (!confirmed || observed.worker_id !== identity.ref) throw new Error('Ishchini faolsizlantirishni tasdiqlang.')
    if (observed.blocked || observed.active_work.length) throw new WorkerRemovalConflict(observed)
    if ((observed.requires_confirmation || observed.connections.length > 0) && !confirmConnections) throw new Error('Ko‘rsatilgan ulanishlarni olib tashlashni tasdiqlang.')
    const current = await this.workerRemovalCheck(identity, signal)
    if (current.blocked || removalFingerprint(current) !== removalFingerprint(observed)) throw new WorkerRemovalConflict(current)
    try {
      const result = record(await this.client.request(`${base}/workers`, 'DELETE', { query: { id: identity.ref, ...(confirmConnections ? { confirm_connections: true } : {}) }, signal }))
      if (result.ok !== true) return invalidResponse()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && !signal?.aborted) throw new WorkerRemovalConflict(await this.workerRemovalCheck(identity, signal))
      throw error
    }
  }
}
