import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Session } from './api-types'
import {
  AdminIdentityApi, WorkerRemovalConflict, assignmentForIdentity, canAssignIdentityRole,
  identityErrorMessage, isIdentityApparatusId, ownRoleAccessPreserved, parseWorkerRemovalCheck,
  resolveAdminIdentity, warehouseAssigneeAllowed, warehouseAssignmentKey,
} from './admin-identity'
import type { AdminIdentity, CapabilityChoice, IdentityAssignment, IdentityRole, WarehouseIdentityAssignment, WorkerRemovalCheck } from './admin-identity'
import { MutationScope } from './mutation-scope'

const caps = ['admin.access', 'role.capability.read', 'role.capability.manage', 'catalog.item.read', 'catalog.item_group.read', 'party.customer.read', 'party.customer.manage', 'party.customer.code.manage']
const session = (capabilities = caps, role = 'admin', ref = 'admin'): Session => ({ token: 'test-session', profile: { role, ref, display_name: 'Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const api = (actor = session()) => new AdminIdentityApi(new ApiClient({ endpoint: 'https://erp.example.test', token: actor.token }), actor)
const worker: AdminIdentity = { kind: 'worker', role: 'aparatchi', ref: 'worker_1', name: 'Ali', phone: '+998901234567', level: 'Brigader' }
const system: AdminIdentity = { kind: 'system', role: 'qolipchi', ref: 'qolipchi_1', name: 'Vali', phone: '+998901234568', level: '' }
const material: AdminIdentity = { kind: 'material', role: 'material_taminotchi', ref: 'MAT-001', name: 'Hasan', phone: '+998901234569', level: '' }
const workerRow = (overrides = {}) => ({ id: worker.ref, name: worker.name, phone: worker.phone, level: worker.level, code: 'NEVER-CACHE-THIS-CODE', ...overrides })
const systemRow = (overrides = {}) => ({ id: system.ref, role: system.role, name: system.name, phone: system.phone, code: 'NEVER-CACHE-THIS-CODE', ...overrides })
const materialRow = (overrides = {}) => ({ ref: material.ref, name: material.name, phone: material.phone, assigned_item_groups: ['Xomashyo'], code: 'NEVER-CACHE-THIS-CODE', ...overrides })
const assignment = (overrides = {}): IdentityAssignment => ({ principal_role: worker.role, principal_ref: worker.ref, role_id: 'aparatchi', assigned_apparatus: ['apparatus:default:rezka'], assigned_item_groups: [], ...overrides })
const nativeRole: IdentityRole = { id: 'aparatchi', label: 'Aparatchi', capability_codes: ['apparatus.queue.read'], system: true }
const customRole: IdentityRole = { id: 'quality', label: 'Sifat nazorati', capability_codes: ['catalog.item.read'], system: false }
const catalog: CapabilityChoice[] = ['catalog.item.read', 'admin.access', 'role.capability.read', 'role.capability.manage'].map(code => ({ code, label: code, default_roles: [] }))
const warehouseAssignment: WarehouseIdentityAssignment = { assignment_kind: 'warehouse', warehouse: 'Asosiy ombor', warehouse_name: 'Asosiy ombor', principal_role: worker.role, principal_ref: worker.ref, display_name: worker.name }
const check = (overrides = {}): WorkerRemovalCheck => ({ worker_id: worker.ref, worker_name: worker.name, blocked: false, requires_confirmation: false, active_work: [], connections: [], ...overrides })
const connection = { kind: 'worker_group', label: 'A guruhi', apparatus: 'apparatus:default:rezka', order_id: '', status: '' }

function respond(...payloads: (unknown | { payload: unknown; status: number })[]) {
  let index = 0
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    const item = payloads[Math.min(index++, payloads.length - 1)]
    const response = item && typeof item === 'object' && 'payload' in item && 'status' in item ? item as { payload: unknown; status: number } : { payload: item, status: 200 }
    return new Response(JSON.stringify(response.payload), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function url(fetch: ReturnType<typeof respond>, index = 0) { return new URL(String(fetch.mock.calls[index][0])) }
function body(fetch: ReturnType<typeof respond>, index = 0) { return JSON.parse(String(fetch.mock.calls[index][1]?.body)) }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native identity and protected account policy', () => {
  it('uses entity_ref rather than the prefixed user-list identity', () => {
    expect(resolveAdminIdentity('users', { id: 'worker:worker_1', principal_role: 'aparatchi', entity_ref: 'worker_1', role_label: 'Master' })).toMatchObject({ kind: 'worker', ref: 'worker_1', level: 'Master' })
    expect(resolveAdminIdentity('users', { id: 'system_user:qolipchi_1', principal_role: 'qolipchi', entity_ref: 'qolipchi_1' })).toMatchObject({ kind: 'system', role: 'qolipchi', ref: 'qolipchi_1' })
    expect(resolveAdminIdentity('users', { principal_role: 'material_taminotchi', entity_ref: 'MAT-001' })).toMatchObject({ kind: 'material' })
    expect(resolveAdminIdentity('users', { id: 'worker:worker_1', principal_role: 'aparatchi' })).toBeNull()
    expect(resolveAdminIdentity('workers', { id: worker.ref, name: worker.name })).toMatchObject({ kind: 'worker', ref: worker.ref })
  })

  it('does not expose account maintenance for protected admin/werka or party identities', () => {
    for (const role of ['admin', 'werka', 'supplier', 'customer', 'unknown']) expect(resolveAdminIdentity('users', { principal_role: role, entity_ref: 'same-ref' })).toBeNull()
    expect(resolveAdminIdentity('roles', { id: 'admin' })).toBeNull()
  })

  it('matches the canonical apparatus contract exactly', () => {
    expect(isIdentityApparatusId('apparatus:default:asset-010')).toBe(true)
    for (const value of ['Rezka', 'apparatus:default:rezka:extra', 'apparatus:default:Rezka', ' apparatus:default:rezka', 'apparatus:default:rezka/', 'apparatus:default:', `apparatus:default:${'a'.repeat(130)}`]) expect(isIdentityApparatusId(value)).toBe(false)
  })

  it('limits system roles to their native principals', () => {
    expect(canAssignIdentityRole(nativeRole, worker)).toBe(true)
    expect(canAssignIdentityRole(nativeRole, system)).toBe(false)
    expect(canAssignIdentityRole({ ...nativeRole, id: 'qolipchi', base_role: 'qolipchi' }, system)).toBe(true)
    expect(canAssignIdentityRole({ ...nativeRole, id: 'qolipchi', base_role: 'qolipchi' }, worker)).toBe(false)
    expect(canAssignIdentityRole(customRole, material)).toBe(true)
  })

  it('does not mistake admin.access for role/catalog/material permissions', async () => {
    const fetch = respond([]), limited = api(session(['admin.access']))
    await expect(limited.roles()).rejects.toMatchObject({ status: 403 })
    await expect(limited.capabilities()).rejects.toMatchObject({ status: 403 })
    await expect(limited.assignments()).rejects.toMatchObject({ status: 403 })
    await expect(limited.itemGroups()).rejects.toMatchObject({ status: 403 })
    await expect(limited.warehouseAssignments(worker)).rejects.toMatchObject({ status: 403 })
    await expect(limited.updateMaterialPhone(material, material.phone)).rejects.toMatchObject({ status: 403 })
    await expect(limited.regenerateCode(material, true)).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('protects an operator from removing their own identity or changing their role', async () => {
    const fetch = respond([]), ownApi = api(session(caps, worker.role, worker.ref))
    await expect(ownApi.workerRemovalCheck(worker)).rejects.toThrow('O‘z hisobingizni')
    await expect(ownApi.saveAssignment(worker, { role_id: customRole.id, assigned_apparatus: [], assigned_item_groups: [] }, [customRole])).rejects.toThrow('O‘z rolingizni')
    expect(fetch).not.toHaveBeenCalled()
    expect(ownRoleAccessPreserved(session(), 'quality', ['catalog.item.read'], [assignment({ principal_role: 'admin', principal_ref: 'admin', role_id: 'quality' })])).toBe(false)
    expect(ownRoleAccessPreserved(session(), 'quality', caps, [assignment({ principal_role: 'admin', principal_ref: 'admin', role_id: 'quality' })])).toBe(true)
    expect(ownRoleAccessPreserved(session(), 'quality', [], [assignment()])).toBe(true)
  })
})

describe('verified edit and role builder request contracts', () => {
  it('updates worker fields separately without accidentally dispatching only a level update', async () => {
    const fetch = respond(workerRow({ name: 'Ali Valiyev' }), workerRow({ phone: '+998909876543' }), workerRow({ level: 'Master' }))
    const service = api()
    const renamed = await service.updateWorker(worker, 'name', ' Ali Valiyev ')
    await service.updateWorker(worker, 'phone', '+998909876543')
    await service.updateWorker(worker, 'level', 'Master')
    expect(fetch.mock.calls.map((_, index) => body(fetch, index))).toEqual([
      { id: worker.ref, name: 'Ali Valiyev' }, { id: worker.ref, phone: '+998909876543' }, { id: worker.ref, level: 'Master' },
    ])
    expect(fetch.mock.calls.every(call => call[1]?.method === 'PUT')).toBe(true)
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/workers')
    expect(renamed).not.toHaveProperty('code')
    expect(JSON.stringify(renamed)).not.toContain('NEVER-CACHE')
  })

  it('preserves native system-user identity and role in a complete update', async () => {
    const fetch = respond(systemRow({ name: 'Vali Karimov', phone: '+998909876544' }))
    const saved = await api().updateSystemUser(system, ' Vali Karimov ', ' +998909876544 ')
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/system-users')
    expect(body(fetch)).toEqual({ id: system.ref, role: 'qolipchi', name: 'Vali Karimov', phone: '+998909876544' })
    expect(saved).not.toHaveProperty('code')
    await expect(api().updateSystemUser({ ...system, role: 'admin' }, 'Admin', '1')).rejects.toThrow('tanlovi')
    await expect(api().updateWorker(worker, 'phone', '')).rejects.toThrow('Telefon')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('updates a material provider through its resource-specific phone endpoint', async () => {
    const fetch = respond(materialRow({ phone: '+998909876545' }))
    const saved = await api(session(['party.customer.manage'])).updateMaterialPhone(material, '+998909876545')
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/material-taminotchilar/phone')
    expect(url(fetch).searchParams.get('ref')).toBe(material.ref)
    expect(body(fetch)).toEqual({ phone: '+998909876545' })
    expect(saved).not.toHaveProperty('code')
  })

  it('uses the server capability catalog and writes only the custom-role DTO', async () => {
    const fetch = respond(catalog, [], { ...customRole, label: 'Sifat' })
    const service = api()
    const choices = await service.capabilities()
    await service.saveRole({ id: ' QUALITY ', label: ' Sifat ', capability_codes: ['catalog.item.read', 'catalog.item.read'] }, choices, [customRole], false)
    expect(url(fetch, 0).pathname).toBe('/v1/mobile/admin/capabilities')
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/admin/role-assignments')
    expect(url(fetch, 2).pathname).toBe('/v1/mobile/admin/roles')
    expect(fetch.mock.calls[2][1]?.method).toBe('PUT')
    expect(body(fetch, 2)).toEqual({ id: 'quality', label: 'Sifat', capability_codes: ['catalog.item.read'] })
  })

  it('rejects protected role updates, guessed capabilities, and duplicate role creation before writing', async () => {
    const fetch = respond([]), service = api()
    await expect(service.saveRole(nativeRole, catalog, [nativeRole], false)).rejects.toThrow('himoyalangan')
    await expect(service.saveRole(customRole, catalog, [customRole], true)).rejects.toThrow('mavjud')
    await expect(service.saveRole({ ...customRole, capability_codes: ['guessed.permission'] }, catalog, [customRole], false)).rejects.toThrow('server ro‘yxatidan')
    await expect(service.saveRole({ ...customRole, capability_codes: [] }, catalog, [customRole], false)).rejects.toThrow('kamida bitta')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('creates a new custom role through the backend PUT contract', async () => {
    const created = { ...customRole, id: 'new-quality' }
    const fetch = respond([], created)
    expect(await api().saveRole(created, catalog, [nativeRole], true)).toEqual(created)
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/admin/roles')
    expect(fetch.mock.calls[1][1]?.method).toBe('PUT')
    expect(body(fetch, 1)).toEqual({ id: 'new-quality', label: customRole.label, capability_codes: ['catalog.item.read'] })
  })

  it('checks the current operator role assignment before a custom-role update can remove admin access', async () => {
    const fetch = respond([assignment({ principal_role: 'admin', principal_ref: 'admin', role_id: customRole.id })])
    await expect(api().saveRole(customRole, catalog, [customRole], false)).rejects.toThrow('boshqaruv ruxsatlaringizni')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.method).toBe('GET')
  })

  it('preserves principal identity and deduplicates canonical apparatus/item-group scopes', async () => {
    const saved = assignment({ role_id: 'quality', assigned_item_groups: ['Xomashyo'] })
    const fetch = respond(saved)
    await api().saveAssignment(worker, { role_id: 'quality', assigned_apparatus: ['apparatus:default:rezka', 'apparatus:default:rezka'], assigned_item_groups: [' Xomashyo ', 'Xomashyo'] }, [customRole])
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/role-assignments')
    expect(body(fetch)).toEqual(saved)
    expect(assignmentForIdentity([assignment({ principal_ref: 'different' }), assignment()], worker)).toEqual(assignment())
  })

  it('requires native role compatibility and scopes used by queue/material roles', async () => {
    const fetch = respond([]), service = api()
    await expect(service.saveAssignment(system, { role_id: 'aparatchi', assigned_apparatus: ['apparatus:default:rezka'], assigned_item_groups: [] }, [nativeRole])).rejects.toThrow('mos rolni')
    await expect(service.saveAssignment(worker, { role_id: 'aparatchi', assigned_apparatus: [], assigned_item_groups: [] }, [nativeRole])).rejects.toThrow('Kamida bitta apparat')
    await expect(service.saveAssignment(worker, { role_id: customRole.id, assigned_apparatus: ['Rezka'], assigned_item_groups: [] }, [customRole])).rejects.toThrow('ro‘yxatdan')
    const materialRole = { ...nativeRole, id: 'material_taminotchi', base_role: 'material_taminotchi', capability_codes: ['raw_material.assign'] }
    await expect(service.saveAssignment(material, { role_id: materialRole.id, assigned_apparatus: [], assigned_item_groups: [] }, [materialRole])).rejects.toThrow('mahsulot guruhini')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the dedicated material group replacement contract and refuses an empty group scope', async () => {
    const fetch = respond(materialRow())
    await api(session(['admin.access'])).updateMaterialGroups(material, [' Xomashyo ', 'Xomashyo'])
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/material-taminotchilar/item-groups')
    expect(url(fetch).searchParams.get('ref')).toBe(material.ref)
    expect(body(fetch)).toEqual({ assigned_item_groups: ['Xomashyo'] })
    await expect(api().updateMaterialGroups(material, [])).rejects.toThrow('Kamida bitta')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('warehouse assignment contracts and worker eligibility', () => {
  it('requires Brigader workers and backend-supported system/material roles', () => {
    expect(warehouseAssigneeAllowed(worker)).toBe(true)
    expect(warehouseAssigneeAllowed({ ...worker, level: 'Master' })).toBe(false)
    expect(warehouseAssigneeAllowed(system)).toBe(true)
    expect(warehouseAssigneeAllowed(material)).toBe(true)
    expect(warehouseAssigneeAllowed({ ...system, role: 'boyoqchi' })).toBe(false)
  })

  it('reads assignments with the actor-specific capability and keeps other principals out', async () => {
    const fetch = respond([warehouseAssignment, { ...warehouseAssignment, principal_ref: 'other-worker' }])
    expect(await api(session(['raw_material.assign'], 'material_taminotchi', 'MAT-admin')).warehouseAssignments(worker)).toEqual([warehouseAssignment])
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/warehouses/assignments')
    await expect(api(session(['catalog.item.read'], 'material_taminotchi', 'MAT-admin')).warehouseAssignments(worker)).rejects.toMatchObject({ status: 403 })
  })

  it('loads canonical active apparatus IDs and server warehouse names without making up catalogs', async () => {
    const fetch = respond([
      { apparatus_id: 'apparatus:default:rezka', display: { display_name: 'Rezka' }, lifecycle: { state: 'active' } },
      { apparatus_id: 'apparatus:default:old', display: { display_name: 'Old' }, lifecycle: { state: 'retired' } },
    ], [{ warehouse: 'Asosiy ombor', is_group: false }, { warehouse: 'Parent', is_group: true }], [{ name: 'GROUP-1', item_group_name: 'Xomashyo' }])
    expect(await api().apparatus('Rez')).toEqual({ items: [{ value: 'apparatus:default:rezka', label: 'Rezka' }], bounded: false })
    expect(url(fetch).searchParams.get('q')).toBe('Rez')
    expect(url(fetch).searchParams.get('limit')).toBe('500')
    expect((await api().warehouses()).items).toEqual([{ value: 'Asosiy ombor', label: 'Asosiy ombor' }])
    expect((await api().itemGroups()).items).toEqual([{ value: 'Xomashyo', label: 'Xomashyo' }])
  })

  it('marks a server-capped warehouse catalog so the picker can ask for a narrower search', async () => {
    respond(Array.from({ length: 500 }, (_, index) => ({ warehouse: `Ombor ${index}`, is_group: false })))
    const result = await api().warehouses()
    expect(result.bounded).toBe(true)
    expect(result.items).toHaveLength(500)
  })

  it('checks the current worker level before posting a warehouse/apparatus assignment', async () => {
    const apparatusAssignment = { ...warehouseAssignment, assignment_kind: 'apparatus', warehouse: '', warehouse_name: undefined, apparatus_id: 'apparatus:default:rezka' }
    const fetch = respond(workerRow(), apparatusAssignment)
    await api().assignWarehouse(worker, 'apparatus', 'apparatus:default:rezka')
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/workers/detail')
    expect(body(fetch, 1)).toEqual({ assignment_kind: 'apparatus', warehouse: '', apparatus_id: 'apparatus:default:rezka', principal_role: worker.role, principal_ref: worker.ref, display_name: worker.name })
    const rejected = respond(workerRow({ level: 'Master' }))
    await expect(api().assignWarehouse(worker, 'warehouse', 'Asosiy ombor')).rejects.toThrow('biriktirib bo‘lmaydi')
    expect(rejected).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit confirmation and exact principal identity to remove a warehouse link', async () => {
    const fetch = respond({ ok: true, assignment: warehouseAssignment })
    await expect(api().unassignWarehouse(worker, warehouseAssignment, false)).rejects.toThrow('tasdiqlang')
    await expect(api().unassignWarehouse(worker, { ...warehouseAssignment, principal_ref: 'other-worker' }, true)).rejects.toThrow('tasdiqlang')
    expect(fetch).not.toHaveBeenCalled()
    await api().unassignWarehouse(worker, warehouseAssignment, true)
    expect(fetch.mock.calls[0][1]?.method).toBe('DELETE')
    expect(body(fetch)).toEqual({ assignment_kind: 'warehouse', warehouse: 'Asosiy ombor', warehouse_name: 'Asosiy ombor', principal_role: worker.role, principal_ref: worker.ref })
    expect(warehouseAssignmentKey(warehouseAssignment)).toBe('warehouse:Asosiy ombor')
  })
})

describe('worker removal guards, races, and identity cancellation', () => {
  it('fails closed for incomplete or wrong-worker checks and for inconsistent active-work flags', () => {
    expect(() => parseWorkerRemovalCheck({ worker_id: worker.ref }, worker.ref)).toThrow(ApiError)
    expect(() => parseWorkerRemovalCheck(check(), 'different-worker')).toThrow(ApiError)
    expect(parseWorkerRemovalCheck(check({ active_work: [{ ...connection, kind: 'active_order', order_id: 'zakaz-1', status: 'running' }] }), worker.ref).blocked).toBe(true)
    expect(parseWorkerRemovalCheck(check({ connections: [connection] }), worker.ref).requires_confirmation).toBe(true)
  })

  it('cannot delete an occupied worker or bypass reviewed connection confirmation', async () => {
    const fetch = respond({ ok: true }), service = api()
    await expect(service.removeWorker(worker, check({ blocked: true }), true, true)).rejects.toBeInstanceOf(WorkerRemovalConflict)
    await expect(service.removeWorker(worker, check({ requires_confirmation: true, connections: [connection] }), true, false)).rejects.toThrow('ulanishlarni')
    await expect(service.removeWorker(worker, check(), false, false)).rejects.toThrow('tasdiqlang')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refreshes the deletion check before removal and sends confirm_connections only after user consent', async () => {
    const reviewed = check({ requires_confirmation: true, connections: [connection] })
    const fetch = respond(reviewed, { ok: true })
    await api().removeWorker(worker, reviewed, true, true)
    expect(url(fetch, 0).pathname).toBe('/v1/mobile/admin/workers/delete-check')
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/admin/workers')
    expect(url(fetch, 1).searchParams.get('id')).toBe(worker.ref)
    expect(url(fetch, 1).searchParams.get('confirm_connections')).toBe('true')
    expect(fetch.mock.calls[1][1]?.method).toBe('DELETE')
  })

  it('requires another review if links or active work change after the dialog opened', async () => {
    const changed = check({ requires_confirmation: true, connections: [connection] })
    const fetch = respond(changed)
    await expect(api().removeWorker(worker, check(), true, false)).rejects.toMatchObject({ name: 'WorkerRemovalConflict', check: changed })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('turns a raced HTTP409 into the current blocked check instead of reporting success', async () => {
    const active = { ...connection, kind: 'active_order', order_id: 'zakaz-1', status: 'running' }
    const blocked = check({ blocked: true, active_work: [active] })
    const fetch = respond(check(), { payload: blocked, status: 409 }, blocked)
    await expect(api().removeWorker(worker, check(), true, false)).rejects.toMatchObject({ name: 'WorkerRemovalConflict', check: blocked })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(url(fetch, 2).pathname).toBe('/v1/mobile/admin/workers/delete-check')
  })

  it('does not proceed to DELETE after a session/record scope cancels a slow deletion precheck', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise<Response>(complete => { resolve = complete }))
    vi.stubGlobal('fetch', fetch)
    const mutations = new MutationScope(), lease = mutations.begin()
    const pending = api().removeWorker(worker, check(), true, false, lease.controller.signal)
    mutations.cancelAll()
    resolve(new Response(JSON.stringify(check()), { status: 200 }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mutations.isCurrent(lease)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.method).toBe('GET')
  })
})

describe('explicit login code rotation and response safety', () => {
  it('keeps credentials out of every detail result and never auto-regenerates a code', async () => {
    const fetch = respond(workerRow(), systemRow(), materialRow())
    const service = api()
    for (const identity of [worker, system, material]) expect(await service.detail(identity)).not.toHaveProperty('code')
    expect(fetch.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true)
    await expect(service.regenerateCode(worker, false)).rejects.toThrow('tasdiqlang')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('returns a code only from the explicitly confirmed POST and keeps the reusable detail clean', async () => {
    const fetch = respond(systemRow({ code: 'NEW-ONE-TIME-CODE', code_locked: false, code_retry_after_sec: 0 }))
    const rotated = await api().regenerateCode(system, true)
    expect(url(fetch).pathname).toBe('/v1/mobile/admin/system-users/code/regenerate')
    expect(url(fetch).searchParams.get('id')).toBe(system.ref)
    expect(fetch.mock.calls[0][1]?.method).toBe('POST')
    expect(rotated.code).toBe('NEW-ONE-TIME-CODE')
    expect(rotated.detail).not.toHaveProperty('code')
  })

  it('routes worker and material-provider code rotations to their native ID/ref endpoints', async () => {
    const fetch = respond(workerRow({ code: 'WORKER-NEW' }), materialRow({ code: 'MATERIAL-NEW' }))
    expect((await api().regenerateCode(worker, true)).code).toBe('WORKER-NEW')
    expect(url(fetch, 0).pathname).toBe('/v1/mobile/admin/workers/code/regenerate')
    expect(url(fetch, 0).searchParams.get('id')).toBe(worker.ref)
    expect((await api().regenerateCode(material, true)).code).toBe('MATERIAL-NEW')
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/admin/material-taminotchilar/code/regenerate')
    expect(url(fetch, 1).searchParams.get('ref')).toBe(material.ref)
    expect(fetch.mock.calls.every(call => call[1]?.method === 'POST')).toBe(true)
  })

  it('rejects a changed response identity and presents useful forbidden/conflict/cooldown states', async () => {
    respond(workerRow({ id: 'other-worker' }))
    await expect(api().detail(worker)).rejects.toMatchObject({ code: 'invalid_response' })
    expect(identityErrorMessage(new ApiError(403, 'forbidden'))).toContain('ruxsat')
    expect(identityErrorMessage(new ApiError(409, 'conflict'))).toContain('o‘zgargan')
    expect(identityErrorMessage(new ApiError(429, 'code regenerate cooldown'))).toContain('Kod yangilash')
  })
})
