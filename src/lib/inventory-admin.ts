import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { Page, Query, Row, Session } from './api-types'
import { hasCapability, meetsRequirement } from './permissions'
import { apparatusOption, isCanonicalApparatusId } from './production-map'

const base = '/v1/mobile/admin'
const inventory = `${base}/inventory`
const assetKinds = ['raw_material', 'finished_goods', 'qolip'] as const
const nativeErrors: Record<string, string> = {
  inventory_asset_unavailable: 'Aktiv band qilingan yoki uning qoldig‘i ko‘chirish uchun mavjud emas. Holatni yangilang.',
  inventory_asset_not_in_source_warehouse: 'Aktiv tanlangan manba omborida joylashmagan. Joriy joyini yangilang.',
  inventory_location_inactive: 'Tanlangan joy faolsiz qilingan. Boshqa faol manzilni tanlang.',
  inventory_cross_warehouse_requires_transfer: 'Boshqa omborga ko‘chirish uchun omborlararo transfer kerak.',
  inventory_destination_warehouse_unassigned: 'Qabul qiluvchi omborga foydalanuvchi biriktirilmagan. Transfer server tomonidan rad etildi.',
  inventory_material_warehouse_scope_missing: 'Xomashyoning qabul qiluvchi ombor uchun ruxsat doirasi sozlanmagan.',
  inventory_transfer_transition_invalid: 'Transfer bosqichi o‘zgargan; bu amal hozir ruxsat etilmagan. Holatni yangilang.',
  inventory_idempotency_conflict: 'Avvalgi amal identifikatori boshqa so‘rovga tegishli. Joriy amalni qayta ko‘rib chiqing.',
  'state name already exists': 'Shu nomdagi zavod joyi allaqachon mavjud.',
  'apparatus id is invalid': 'Tanlangan apparat identifikatori faol canonical apparatga mos kelmadi.',
}
export type InventoryAssetKind = typeof assetKinds[number]
export type InventoryTransferAction = 'approve' | 'reject' | 'dispatch' | 'receive' | 'cancel'
export const INVENTORY_API_LIMITATIONS = [
  'No movement-history undo endpoint or relocation movement_id is exposed. Return-to-warehouse and pre-dispatch transfer cancellation are distinct native actions.',
  'Relocation, return and transfer DTOs have idempotency keys but no client expected_placement_version field. Fresh reads detect stale selections; backend transactions remain authoritative.',
  'Factory location APIs have no DELETE, revision precondition or idempotency key. Retirement preserves the location ID and existing references.',
  'current_user_states_only means state assets inside the actor warehouse scope; it does not mean assets last moved by this user.',
  'There is no asset/transfer detail GET or key lookup. Exact identity is resolved from paged scoped feeds; missing records never confirm an uncertain write.',
] as const

const str = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const ascii = (value: string) => value.trim().replace(/[A-Z]/g, letter => letter.toLowerCase())
function invalid(message = 'Inventar javobi to‘liq yoki mos kelgan holda olinmadi.'): never { throw new ApiError(502, 'invalid_response', message) }
function required(value: unknown): string { if (typeof value !== 'string' || !value.trim()) return invalid(); return value.trim() }
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(); return value }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value }

export interface InventoryLocation extends Row { id: string; kind: string; name: string; active: boolean; warehouse_id: string; factory_location_id: string; apparatus: Row[] }
export interface InventoryAsset extends Row {
  kind: InventoryAssetKind; asset_ref: string; custody_warehouse_id: string; custody_warehouse: string; item_code: string; item_name: string; identifier: string
  qty: number; uom: string; status: string; transfer_id: string; placement_version: number; physical_location: Row & { id: string; kind: string; name: string }
}
export interface InventoryTransfer extends Row { id: string; source_warehouse_id: string; source_warehouse: string; destination_warehouse_id: string; destination_warehouse: string; status: string; lines: Row[] }
export interface FactoryLocation extends Row { id: string; name: string; active: boolean; apparatus: Row[]; created_at_unix: number; updated_at_unix: number }

export function inventoryPermissions(session: Session | null | undefined) {
  return {
    inventory: hasCapability(session, 'inventory.movement.manage'),
    factory: hasCapability(session, 'factory.location.manage'),
    apparatus: meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'] }),
  }
}
export function inventoryAssetKey(row: Row): string {
  const kind = str(row.kind), ref = str(row.asset_ref)
  return assetKinds.includes(kind as InventoryAssetKind) && ref ? JSON.stringify([kind, ascii(ref)]) : ''
}
export function factoryLocationId(row: Row): string {
  // Inventory's state projection names the native factory identity explicitly.
  return row.kind !== undefined ? row.kind === 'state' ? str(row.factory_location_id) : '' : str(row.id)
}
export function parseInventoryLocation(value: unknown): InventoryLocation {
  const row = record(value), kind = required(row.kind)
  if (!['warehouse', 'state', 'transit'].includes(kind)) return invalid()
  const apparatus = row.apparatus === undefined ? [] : rows(row.apparatus)
  if (apparatus.some(item => !isCanonicalApparatusId(str(item.id)))) return invalid()
  return { ...row, id: required(row.id), kind, name: required(row.name), active: bool(row.active), warehouse_id: str(row.warehouse_id), factory_location_id: str(row.factory_location_id), apparatus }
}
export function parseInventoryAsset(value: unknown): InventoryAsset {
  const row = record(value), kind = required(row.kind) as InventoryAssetKind, location = record(row.physical_location), version = finite(row.placement_version)
  if (!assetKinds.includes(kind) || !Number.isSafeInteger(version) || version < 1 || !['warehouse', 'state', 'transit'].includes(str(location.kind))) return invalid()
  if (row.transfer_id !== undefined && typeof row.transfer_id !== 'string') return invalid()
  return { ...row, kind, asset_ref: required(row.asset_ref), custody_warehouse_id: required(row.custody_warehouse_id), custody_warehouse: required(row.custody_warehouse), item_code: required(row.item_code), item_name: required(row.item_name), identifier: required(row.identifier),
    qty: finite(row.qty), uom: required(row.uom), status: required(row.status), transfer_id: str(row.transfer_id), placement_version: version, physical_location: { ...location, id: required(location.id), kind: required(location.kind), name: required(location.name) } }
}
export function parseInventoryTransfer(value: unknown): InventoryTransfer {
  const row = record(value), lines = rows(row.lines)
  if (!lines.length || lines.some(line => !assetKinds.includes(str(line.asset_kind) as InventoryAssetKind) || !str(line.asset_ref) || typeof line.qty !== 'number' || !Number.isFinite(line.qty) || Number(line.qty) <= 0 || !str(line.uom) || !str(line.source_physical_location_id))) return invalid()
  if (new Set(lines.map(line => JSON.stringify([line.asset_kind, ascii(str(line.asset_ref))]))).size !== lines.length) return invalid()
  return { ...row, id: required(row.id), source_warehouse_id: required(row.source_warehouse_id), source_warehouse: required(row.source_warehouse), destination_warehouse_id: required(row.destination_warehouse_id), destination_warehouse: required(row.destination_warehouse), status: required(row.status), lines }
}
export function parseFactoryLocation(value: unknown): FactoryLocation {
  const row = record(value), apparatus = rows(row.apparatus)
  if (apparatus.some(item => !isCanonicalApparatusId(str(item.id)) || typeof item.active !== 'boolean' || !Number.isSafeInteger(item.source_revision) || Number(item.source_revision) < 1) || new Set(apparatus.map(item => item.id)).size !== apparatus.length) return invalid()
  return { ...row, id: required(row.id), name: required(row.name), active: bool(row.active), apparatus, created_at_unix: finite(row.created_at_unix), updated_at_unix: finite(row.updated_at_unix) }
}

export async function inventoryLocations(client: ApiClient, signal?: AbortSignal): Promise<InventoryLocation[]> {
  const result = rows(await client.get(`${inventory}/locations`, undefined, signal)).map(parseInventoryLocation)
  if (new Set(result.map(row => row.id)).size !== result.length) return invalid()
  return result
}
export async function inventoryAssetDetail(client: ApiClient, selected: Row, signal?: AbortSignal, currentUserStatesOnly = false): Promise<InventoryAsset> {
  const key = inventoryAssetKey(selected)
  if (!key) throw new Error('Aktiv turi va canonical asset_ref talab qilinadi.')
  // Native search is a substring feed, never an exact identity selector.
  for (let offset = 0; offset < 1000; offset += 100) {
    const items = rows(await client.get(`${inventory}/assets`, { asset_kind: str(selected.kind), query: str(selected.asset_ref), current_user_states_only: currentUserStatesOnly, offset, limit: 100 }, signal)).map(parseInventoryAsset)
    const matches = items.filter(row => inventoryAssetKey(row) === key)
    if (matches.length > 1) return invalid()
    if (matches[0]) return matches[0]
    if (items.length < 100) break
  }
  throw new ApiError(409, 'inventory_asset_snapshot_missing', 'Tanlangan aktiv ruxsatli server ro‘yxatida tasdiqlanmadi. Joriy holatni yangilang.')
}
export async function inventoryTransfersPage(client: ApiClient, query: Query = {}, signal?: AbortSignal): Promise<Page> {
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0)), limit = Math.min(499, Math.max(1, Math.floor(Number(query.limit) || 20)))
  const items = rows(await client.get(`${inventory}/transfers`, { direction: str(query.direction) || 'all', status: str(query.status), offset, limit: limit + 1 }, signal)).map(parseInventoryTransfer)
  if (new Set(items.map(row => row.id)).size !== items.length) return invalid()
  return { items: items.slice(0, limit), hasMore: items.length > limit }
}
export async function inventoryTransferDetail(client: ApiClient, id: string, signal?: AbortSignal): Promise<InventoryTransfer> {
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await inventoryTransfersPage(client, { offset, limit: 100 }, signal)
    const matches = page.items.filter(row => row.id === id)
    if (matches.length > 1) return invalid()
    if (matches[0]) return parseInventoryTransfer(matches[0])
    if (!page.hasMore) break
  }
  throw new ApiError(409, 'inventory_transfer_snapshot_missing', 'Tanlangan transfer joriy server ro‘yxatida tasdiqlanmadi.')
}
export async function factoryLocations(client: ApiClient, signal?: AbortSignal): Promise<FactoryLocation[]> {
  const result = rows(await client.get(`${base}/factory-locations`, undefined, signal)).map(parseFactoryLocation)
  if (new Set(result.map(row => row.id)).size !== result.length) return invalid()
  return result
}

export function inventoryWarehouseAllowed(session: Session | null, warehouse: string): boolean {
  return hasCapability(session, 'admin.access') || Boolean(session?.assigned_warehouses.some(value => ascii(value) === ascii(warehouse)))
}
export function inventoryAvailable(asset: InventoryAsset): boolean { return asset.status === 'available' && !asset.transfer_id && asset.qty > 0 && asset.physical_location.kind !== 'transit' }
export function inventoryRelocationChoices(asset: InventoryAsset, locations: readonly InventoryLocation[]): InventoryLocation[] {
  return locations.filter(row => row.active && row.id !== asset.physical_location.id && (row.kind === 'state' || row.kind === 'warehouse' && row.warehouse_id === asset.custody_warehouse_id))
}
export function inventoryTransferChoices(asset: InventoryAsset, locations: readonly InventoryLocation[]): InventoryLocation[] {
  return locations.filter(row => row.active && row.kind === 'warehouse' && row.warehouse_id && row.warehouse_id !== asset.custody_warehouse_id)
}
export function inventoryTransferActions(transfer: InventoryTransfer, session: Session | null): InventoryTransferAction[] {
  if (!inventoryPermissions(session).inventory) return []
  const source = inventoryWarehouseAllowed(session, transfer.source_warehouse), destination = inventoryWarehouseAllowed(session, transfer.destination_warehouse)
  if (transfer.status === 'requested') return [...(destination ? ['approve', 'reject'] as const : []), ...(source ? ['cancel'] as const : [])]
  if (transfer.status === 'approved') return source ? ['dispatch', 'cancel'] : []
  return transfer.status === 'in_transit' && destination ? ['receive'] : []
}

export interface InventoryCommand {
  id: string
  kind: 'relocate' | 'return' | 'transfer-create' | 'transfer-action' | 'factory-create' | 'factory-edit' | 'factory-apparatus'
  path: string
  method: 'POST' | 'PUT'
  body: Row
  subjects: string[]
  asset?: InventoryAsset
  destination?: InventoryLocation
  transfer?: InventoryTransfer
  action?: InventoryTransferAction
  factory?: FactoryLocation
  apparatusRevisions?: Record<string, number>
  /** Native transfer ID received before a later readback failed; never sent in a DTO. */
  returnedTransferId?: string
}
const selector = (asset: InventoryAsset) => ({ asset_kind: asset.kind, asset_ref: asset.asset_ref })
const noteBody = (note: string) => note.trim() ? { note: note.trim() } : {}
export function inventoryAssetCommand(asset: InventoryAsset, locations: readonly InventoryLocation[], session: Session | null, action: 'relocate' | 'return' | 'transfer-create', destinationId = '', note = '', key: string = crypto.randomUUID()): InventoryCommand {
  if (!inventoryPermissions(session).inventory) throw new ApiError(403, 'forbidden')
  if (!inventoryAvailable(asset) || !inventoryWarehouseAllowed(session, asset.custody_warehouse)) throw new Error('Aktiv band yoki bu ombor uchun ruxsat berilmagan.')
  if (!key.trim()) throw new Error('Amal identifikatori talab qilinadi.')
  let destination: InventoryLocation | undefined
  if (action === 'return') {
    const own = locations.filter(row => row.active && row.kind === 'warehouse' && row.warehouse_id === asset.custody_warehouse_id)
    if (asset.physical_location.kind !== 'state' || own.length !== 1) throw new Error('Qaytarish uchun aktiv state’da va uning faol ombor joyi mavjud bo‘lishi kerak.')
    destination = own[0]
  } else {
    destination = (action === 'relocate' ? inventoryRelocationChoices(asset, locations) : inventoryTransferChoices(asset, locations)).find(row => row.id === destinationId)
    if (!destination || (action === 'transfer-create' && asset.physical_location.kind !== 'warehouse')) throw new Error('Serverdan mos faol manba va joylashuvni tanlang.')
  }
  const body = action === 'relocate' ? { ...selector(asset), physical_location_id: destination.id, idempotency_key: key.trim(), ...noteBody(note) }
    : action === 'return' ? { assets: [selector(asset)], idempotency_key: key.trim(), ...noteBody(note) }
    : { source_warehouse_id: asset.custody_warehouse_id, destination_warehouse_id: destination.warehouse_id, assets: [selector(asset)], idempotency_key: key.trim(), ...noteBody(note) }
  return { id: key.trim(), kind: action, method: 'POST', path: action === 'relocate' ? `${inventory}/relocations` : action === 'return' ? `${inventory}/returns/batch` : `${inventory}/transfers`, body, subjects: [inventoryAssetKey(asset)], asset: structuredClone(asset), destination: structuredClone(destination) }
}
export function inventoryTransferCommand(transfer: InventoryTransfer, session: Session | null, action: InventoryTransferAction, note = '', key: string = crypto.randomUUID()): InventoryCommand {
  if (!inventoryTransferActions(transfer, session).includes(action)) throw new Error('Transferning joriy bosqichida bu amal ruxsat etilmagan.')
  if (!key.trim()) throw new Error('Amal identifikatori talab qilinadi.')
  return { id: key.trim(), kind: 'transfer-action', path: `${inventory}/transfers/${encodeURIComponent(transfer.id)}/${action}`, method: 'POST', body: { idempotency_key: key.trim(), ...noteBody(note) }, subjects: [`transfer:${transfer.id}`, ...transfer.lines.map(line => inventoryAssetKey({ kind: line.asset_kind, asset_ref: line.asset_ref }))], transfer: structuredClone(transfer), action }
}
export function factoryApparatusChoices(catalog: readonly Row[]): { id: string; name: string; revision: number }[] {
  return catalog.map(apparatusOption).filter(option => option.active && isCanonicalApparatusId(option.id)).flatMap(option => {
    const projection = isRecord(option.row.runtime_projection) ? option.row.runtime_projection : option.row
    return Number.isSafeInteger(projection.source_revision) && Number(projection.source_revision) > 0 ? [{ id: option.id, name: option.name || option.id, revision: Number(projection.source_revision) }] : []
  })
}
export function factoryLocationCommand(session: Session | null, action: 'factory-create' | 'factory-edit' | 'factory-apparatus', selected: FactoryLocation | null, input: Row, catalog: readonly Row[] = [], id: string = crypto.randomUUID()): InventoryCommand {
  if (!inventoryPermissions(session).factory) throw new ApiError(403, 'forbidden')
  let body: Row, revisions: Record<string, number> | undefined
  if (action === 'factory-edit') {
    if (!selected) throw new Error('Joriy zavod joyini tanlang.')
    body = {}
    if (Object.hasOwn(input, 'name')) { if (!str(input.name)) throw new Error('Joy nomini kiriting.'); body.name = str(input.name) }
    if (Object.hasOwn(input, 'active')) { if (typeof input.active !== 'boolean') throw new Error('Joyning faol holatini tanlang.'); body.active = input.active }
    if (!Object.keys(body).length) throw new Error('O‘zgarish kiritilmagan.')
  } else {
    const ids = Array.isArray(input.apparatus_ids) ? input.apparatus_ids.map(required) : []
    const options = factoryApparatusChoices(catalog)
    if (new Set(ids).size !== ids.length || ids.some(value => !isCanonicalApparatusId(value) || options.filter(option => option.id === value).length !== 1)) throw new Error('Faqat serverdagi faol canonical apparatlarni tanlang.')
    revisions = Object.fromEntries(ids.map(value => [value, options.find(option => option.id === value)!.revision]))
    body = { apparatus_ids: [...ids].sort() }
    if (action === 'factory-create') { if (!str(input.name)) throw new Error('Joy nomini kiriting.'); body.name = str(input.name) }
    else if (!selected) throw new Error('Joriy zavod joyini tanlang.')
  }
  return { id, kind: action, method: action === 'factory-create' ? 'POST' : 'PUT', path: action === 'factory-create' ? `${base}/factory-locations` : `${base}/factory-locations/${encodeURIComponent(selected!.id)}${action === 'factory-apparatus' ? '/apparatus' : ''}`, body, subjects: [selected ? `factory:${selected.id}` : 'factory:create'], ...(selected ? { factory: structuredClone(selected) } : {}), apparatusRevisions: revisions }
}

function immutableAssetMatch(left: InventoryAsset, right: InventoryAsset): boolean {
  return inventoryAssetKey(left) === inventoryAssetKey(right) && left.item_code === right.item_code && left.identifier === right.identifier && left.qty === right.qty && left.uom === right.uom
}
function assetBaselineMatches(left: InventoryAsset, right: InventoryAsset): boolean {
  return immutableAssetMatch(left, right) && left.custody_warehouse_id === right.custody_warehouse_id && left.physical_location.id === right.physical_location.id && left.physical_location.kind === right.physical_location.kind && left.status === right.status && left.transfer_id === right.transfer_id && left.placement_version === right.placement_version
}
function assetAtDestination(command: InventoryCommand, current: InventoryAsset): boolean {
  return Boolean(command.asset && command.destination && immutableAssetMatch(command.asset, current) && current.custody_warehouse_id === (command.kind === 'transfer-create' ? command.destination.warehouse_id : command.asset.custody_warehouse_id) && current.physical_location.id === command.destination.id && current.physical_location.kind === command.destination.kind && current.status === 'available' && !current.transfer_id && current.placement_version >= command.asset.placement_version)
}
function transferStableMatch(left: InventoryTransfer, right: InventoryTransfer): boolean {
  const lines = (value: InventoryTransfer) => value.lines.map(line => [inventoryAssetKey({ kind: line.asset_kind, asset_ref: line.asset_ref }), str(line.item_code), str(line.identifier), line.qty, str(line.uom), str(line.source_physical_location_id)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return left.id === right.id && left.source_warehouse_id === right.source_warehouse_id && left.destination_warehouse_id === right.destination_warehouse_id && JSON.stringify(lines(left)) === JSON.stringify(lines(right))
}
function transferMatchesCreation(command: InventoryCommand, value: InventoryTransfer): boolean {
  const asset = command.asset
  return Boolean(asset && value.source_warehouse_id === command.body.source_warehouse_id && value.destination_warehouse_id === command.body.destination_warehouse_id && str(value.note) === str(command.body.note) && value.lines.length === 1 && inventoryAssetKey({ kind: value.lines[0].asset_kind, asset_ref: value.lines[0].asset_ref }) === inventoryAssetKey(asset) && value.lines[0].qty === asset.qty && value.lines[0].uom === asset.uom && value.lines[0].source_physical_location_id === asset.physical_location.id)
}
function actionApplied(action: InventoryTransferAction, status: string): boolean {
  return action === 'approve' ? ['approved', 'in_transit', 'received'].includes(status) : action === 'dispatch' ? ['in_transit', 'received'].includes(status) : action === 'receive' ? status === 'received' : action === 'reject' ? status === 'rejected' : status === 'cancelled'
}
function factoryMatchesCommand(command: InventoryCommand, value: FactoryLocation): boolean {
  const apparatusIds = (location: FactoryLocation) => location.apparatus.map(row => str(row.id)).sort()
  if (command.factory && (value.id !== command.factory.id || value.created_at_unix !== command.factory.created_at_unix)) return false
  if (command.kind === 'factory-edit' && command.factory && JSON.stringify(apparatusIds(value)) !== JSON.stringify(apparatusIds(command.factory))) return false
  if (command.kind === 'factory-apparatus' && command.factory && (value.name !== command.factory.name || value.active !== command.factory.active)) return false
  if (command.body.name !== undefined && value.name !== command.body.name || command.body.active !== undefined && value.active !== command.body.active) return false
  if (command.body.apparatus_ids !== undefined && JSON.stringify(value.apparatus.map(row => str(row.id)).sort()) !== JSON.stringify(command.body.apparatus_ids)) return false
  return command.kind !== 'factory-create' || value.active === true
}

export interface InventoryReconciliation { state: 'confirmed' | 'unchanged' | 'changed' | 'missing' | 'replayable'; result?: Row }
export async function reconcileInventoryCommand(client: ApiClient, command: InventoryCommand, signal?: AbortSignal): Promise<InventoryReconciliation> {
  if (command.kind.startsWith('factory-')) {
    const locations = await factoryLocations(client, signal)
    const values = command.factory ? locations.filter(row => row.id === command.factory!.id) : locations.filter(row => ascii(row.name) === ascii(str(command.body.name)))
    if (values.length > 1) return invalid()
    const current = values[0]
    if (!current) return { state: 'missing' }
    if (factoryMatchesCommand(command, current)) return { state: 'confirmed', result: current }
    return { state: command.factory && JSON.stringify(current) === JSON.stringify(command.factory) ? 'unchanged' : 'changed', result: current }
  }
  if (command.kind === 'transfer-action') {
    const current = await inventoryTransferDetail(client, command.transfer!.id, signal)
    if (!transferStableMatch(command.transfer!, current)) return { state: 'changed', result: current }
    return { state: actionApplied(command.action!, current.status) ? 'confirmed' : current.status === command.transfer!.status ? 'unchanged' : 'changed', result: current }
  }
  if (command.kind === 'transfer-create' && command.returnedTransferId) {
    const transfer = await inventoryTransferDetail(client, command.returnedTransferId, signal)
    return { state: transferMatchesCreation(command, transfer) && ['requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled'].includes(transfer.status) ? 'confirmed' : 'changed', result: transfer }
  }
  const current = await inventoryAssetDetail(client, command.asset!, signal)
  if (command.kind === 'transfer-create' && current.transfer_id) {
    const transfer = await inventoryTransferDetail(client, current.transfer_id, signal)
    // A matching asset reservation is not proof that it belongs to our key. Only the
    // native same-key response supplies that identity. A fresh create cannot reserve it twice.
    return { state: immutableAssetMatch(command.asset!, current) && transferMatchesCreation(command, transfer) && ['requested', 'approved', 'in_transit'].includes(transfer.status) ? 'replayable' : 'changed', result: transfer }
  }
  // Internal transfers can finish before their first response reaches the browser.
  // At the exact destination a fresh request cannot pass the native source-warehouse guard.
  if (command.kind === 'transfer-create' && assetAtDestination(command, current)) return { state: 'replayable', result: current }
  if (command.kind !== 'transfer-create' && assetAtDestination(command, current)) return { state: 'confirmed', result: current }
  return { state: assetBaselineMatches(command.asset!, current) ? 'unchanged' : 'changed', result: current }
}

export class InventoryMutationError extends Error {
  readonly uncertain: boolean
  constructor(message: string, uncertain: boolean) { super(message); this.name = 'InventoryMutationError'; this.uncertain = uncertain }
}
function validateCommand(command: InventoryCommand) {
  const keys = (allowed: readonly string[]) => Object.keys(command.body).every(key => allowed.includes(key))
  if (!str(command.id)) throw new Error('Amal identifikatori talab qilinadi.')
  if (command.kind === 'relocate' || command.kind === 'return' || command.kind === 'transfer-create') {
    const path = command.kind === 'relocate' ? `${inventory}/relocations` : command.kind === 'return' ? `${inventory}/returns/batch` : `${inventory}/transfers`
    if (!command.asset || !command.destination || command.method !== 'POST' || command.path !== path || command.body.idempotency_key !== command.id || command.id.length > 200) throw new Error('Inventar amali native so‘rovga mos emas.')
    const asset = command.asset, destination = command.destination, body = command.body
    const selectors = Array.isArray(body.assets) ? body.assets : []
    const exactSelector = selectors.length === 1 && isRecord(selectors[0]) && Object.keys(selectors[0]).length === 2 && selectors[0].asset_kind === asset.kind && selectors[0].asset_ref === asset.asset_ref
    if (command.kind === 'relocate' ? !keys(['asset_kind', 'asset_ref', 'physical_location_id', 'idempotency_key', 'note']) || body.asset_kind !== asset.kind || body.asset_ref !== asset.asset_ref || body.physical_location_id !== destination.id : !exactSelector || !keys(command.kind === 'return' ? ['assets', 'idempotency_key', 'note'] : ['source_warehouse_id', 'destination_warehouse_id', 'assets', 'idempotency_key', 'note']) || command.kind === 'transfer-create' && (body.source_warehouse_id !== asset.custody_warehouse_id || body.destination_warehouse_id !== destination.warehouse_id)) throw new Error('Inventar tanlovi native so‘rovga mos emas.')
  } else if (command.kind === 'transfer-action') {
    if (!command.transfer || !command.action || !['approve', 'reject', 'dispatch', 'receive', 'cancel'].includes(command.action) || command.method !== 'POST' || command.path !== `${inventory}/transfers/${encodeURIComponent(command.transfer.id)}/${command.action}` || command.body.idempotency_key !== command.id || command.id.length > 200 || !keys(['idempotency_key', 'note'])) throw new Error('Transfer amali native so‘rovga mos emas.')
  } else if (['factory-create', 'factory-edit', 'factory-apparatus'].includes(command.kind)) {
    const create = command.kind === 'factory-create', binding = command.kind !== 'factory-edit'
    if ((!create && !command.factory) || command.method !== (create ? 'POST' : 'PUT') || command.path !== (create ? `${base}/factory-locations` : `${base}/factory-locations/${encodeURIComponent(command.factory!.id)}${command.kind === 'factory-apparatus' ? '/apparatus' : ''}`) || !keys(create ? ['name', 'apparatus_ids'] : binding ? ['apparatus_ids'] : ['name', 'active'])) throw new Error('Joy amali native so‘rovga mos emas.')
    if (binding && (!Array.isArray(command.body.apparatus_ids) || command.body.apparatus_ids.some(id => !isCanonicalApparatusId(str(id))) || new Set(command.body.apparatus_ids).size !== command.body.apparatus_ids.length)) throw new Error('Canonical apparat tanlovi talab qilinadi.')
    if ((create || command.body.name !== undefined) && !str(command.body.name) || command.body.active !== undefined && typeof command.body.active !== 'boolean' || !Object.keys(command.body).length) throw new Error('Joy ma’lumotlari noto‘g‘ri.')
  } else throw new Error('Bu inventar amali API’da mavjud emas.')
}
export async function executeInventoryCommand(client: ApiClient, session: Session | null, command: InventoryCommand, signal?: AbortSignal, onDispatch?: () => void, recovery = false, onReceipt?: (result: Row) => void): Promise<Row> {
  const factory = command.kind.startsWith('factory-')
  if (!(factory ? inventoryPermissions(session).factory : inventoryPermissions(session).inventory)) throw new ApiError(403, 'forbidden')
  let started = false, responseReceived = false
  try {
    validateCommand(command)
    let replay = false
    if (recovery) {
      const state = await reconcileInventoryCommand(client, command, signal)
      if (state.state === 'confirmed') return state.result!
      // A setter/unique factory create may repeat the exact request; changed facts never license an overwrite.
      replay = command.kind === 'transfer-create' && state.state === 'replayable'
      if (!replay && !['unchanged', ...(command.kind === 'factory-create' ? ['missing'] : [])].includes(state.state)) throw new Error('Joriy holat avvalgi tanlovdan o‘zgargan. So‘rovni xavfsiz takrorlash tasdiqlanmadi; avvalgi amal saqlanmoqda.')
    }
    if (factory) {
      const current = await factoryLocations(client, signal)
      if (command.factory && !current.some(row => row.id === command.factory!.id && JSON.stringify(row) === JSON.stringify(command.factory))) throw new ApiError(409, 'factory_location_changed', 'Zavod joyi yoki apparat a’zoligi o‘zgargan. Tanlovni yangilang.')
      if (command.kind === 'factory-create' && current.some(row => ascii(row.name) === ascii(str(command.body.name)))) throw new ApiError(409, 'factory_location_name_exists', 'Shu nomdagi joy allaqachon mavjud. Joriy yozuvni tekshiring.')
      if (Object.keys(command.apparatusRevisions ?? {}).length) {
        const catalog = await client.listSnapshot('apparatus', { limit: 500 }, signal)
        const options = factoryApparatusChoices(catalog.items)
        if (Object.entries(command.apparatusRevisions!).some(([id, revision]) => options.find(row => row.id === id)?.revision !== revision)) throw new ApiError(409, 'factory_apparatus_changed', 'Tanlangan apparat faol holati yoki revision’i o‘zgargan.')
      }
    } else if (command.asset && !replay) {
      const [current, locations] = await Promise.all([inventoryAssetDetail(client, command.asset, signal), inventoryLocations(client, signal)])
      if (!assetBaselineMatches(command.asset, current)) throw new ApiError(409, 'inventory_placement_changed', 'Aktiv joyi, miqdori yoki placement_version o‘zgargan. Tanlovni yangilang.')
      const fresh = inventoryAssetCommand(current, locations, session, command.kind as 'relocate' | 'return' | 'transfer-create', command.destination!.id, str(command.body.note), command.id)
      if (JSON.stringify(fresh.body) !== JSON.stringify(command.body)) throw new ApiError(409, 'inventory_location_changed', 'Joylashuv o‘zgargan. Tanlovni yangilang.')
    } else if (!command.asset) {
      const current = await inventoryTransferDetail(client, command.transfer!.id, signal)
      if (!transferStableMatch(command.transfer!, current) || current.status !== command.transfer!.status || !inventoryTransferActions(current, session).includes(command.action!)) throw new ApiError(409, 'inventory_transfer_changed', 'Transfer holati yoki ruxsat doirasi o‘zgargan. Yangilang.')
    }
    if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
    started = true
    onDispatch?.()
    const response = await client.request(command.path, command.method, { body: command.body, signal })
    responseReceived = true
    let result: Row
    if (factory) {
      const value = parseFactoryLocation(response)
      if (!factoryMatchesCommand(command, value) || (command.factory && value.created_at_unix !== command.factory.created_at_unix)) return invalid('Server tanlangan zavod joyini tasdiqlamadi.')
      result = value
    } else if (command.kind === 'relocate' || command.kind === 'return') {
      const value = command.kind === 'return' ? rows(response).map(parseInventoryAsset) : [parseInventoryAsset(response)]
      if (value.length !== 1 || !assetAtDestination(command, value[0])) return invalid('Server tanlangan aktivning haqiqiy joyini tasdiqlamadi.')
      result = value[0]
    } else {
      const value = parseInventoryTransfer(response)
      if (command.kind === 'transfer-create' ? !transferMatchesCreation(command, value) || !['requested', 'approved', 'in_transit', 'received', ...(recovery ? ['rejected', 'cancelled'] : [])].includes(value.status) : !transferStableMatch(command.transfer!, value) || !actionApplied(command.action!, value.status)) return invalid('Server tanlangan transfer amali va holatini tasdiqlamadi.')
      result = value
    }
    onReceipt?.(result)
    if (command.kind === 'transfer-create') {
      const confirmed = await inventoryTransferDetail(client, required(result.id), signal)
      if (!transferMatchesCreation(command, confirmed) || !['requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled'].includes(confirmed.status)) return invalid('Yaratilgan transfer joriy holatda tasdiqlanmadi.')
      return confirmed
    }
    const confirmed = await reconcileInventoryCommand(client, command, signal)
    if (confirmed.state !== 'confirmed' || !confirmed.result || factory && confirmed.result.id !== result.id) return invalid('Amal natijasi joriy server holatida tasdiqlanmadi.')
    return confirmed.result
  } catch (error) {
    const uncertain = started && (responseReceived || !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response')
    throw new InventoryMutationError(uncertain ? 'Amal natijasi aniqlanmagan. Yangi amal boshlamang; server holatini tekshiring.' : error instanceof ApiError ? nativeErrors[error.code] ?? error.message : error instanceof Error ? error.message : 'Amal bajarilmadi.', uncertain)
  }
}

export interface InventoryAttempt { context: string; command: InventoryCommand; phase: 'pending' | 'uncertain' | 'blocked' | 'confirmed'; serial: number; dispatched: boolean; result?: Row; error?: string }
export interface InventoryAttemptLease { scope: string; generation: number; context: string; serial: number; wasUncertain: boolean }
/** Checkpoints contain native DTOs only; auth changes erase them and invalidate every old lease. */
export class InventoryAttemptRegistry {
  private scope = ''; private generation = 0; private revision = 0; private serial = 0
  private entries = new Map<string, InventoryAttempt>(); private listeners = new Set<() => void>()
  activate(scope: string) { if (scope !== this.scope) { this.scope = scope; this.generation++; this.entries.clear(); this.revision++ } }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getRevision = () => this.revision
  private publish() { this.revision++; for (const listener of this.listeners) listener() }
  get(scope: string, context: string, subjects: readonly string[] = []): InventoryAttempt | null {
    if (scope !== this.scope) return null
    const exact = this.entries.get(context), unresolved = [...this.entries.values()].find(value => ['pending', 'uncertain'].includes(value.phase) && (value.context === context || value.command.subjects.some(subject => subjects.includes(subject))))
    const result = unresolved ?? exact
    return result ? structuredClone(result) : null
  }
  begin(scope: string, context: string, command: InventoryCommand, recovery = false): InventoryAttemptLease {
    if (scope !== this.scope) throw new Error('Sessiya o‘zgargan. Oynani qayta oching.')
    const old = [...this.entries.values()].find(value => ['pending', 'uncertain'].includes(value.phase) && (value.context === context || value.command.subjects.some(subject => command.subjects.includes(subject))))
    if (old && (!recovery || old.phase === 'pending' || JSON.stringify(old.command) !== JSON.stringify(command))) throw new Error('Avvalgi amal aniqlanmaguncha yangi amal boshlanmaydi.')
    const target = old?.context ?? context
    if (this.entries.get(target)?.phase === 'confirmed') throw new Error('Amal tasdiqlangan. Yangi amalni alohida boshlang.')
    const serial = ++this.serial
    this.entries.set(target, { context: target, command: structuredClone(command), phase: 'pending', dispatched: old?.dispatched ?? false, serial })
    this.publish()
    return { scope, generation: this.generation, context: target, serial, wasUncertain: old?.phase === 'uncertain' }
  }
  private current(lease: InventoryAttemptLease) { const value = this.entries.get(lease.context); return lease.scope === this.scope && lease.generation === this.generation && value?.serial === lease.serial ? value : undefined }
  dispatched(lease: InventoryAttemptLease) { const value = this.current(lease); if (value) { value.dispatched = true; this.publish() } }
  receipt(lease: InventoryAttemptLease, result: Row) {
    const value = this.current(lease)
    if (value?.command.kind === 'transfer-create' && typeof result.id === 'string' && result.id.trim()) { value.command.returnedTransferId = result.id; this.publish() }
  }
  finish(lease: InventoryAttemptLease, outcome: { result: Row } | { error: string; uncertain: boolean }) {
    const value = this.current(lease); if (!value) return
    if ('result' in outcome) { value.phase = 'confirmed'; value.result = structuredClone(outcome.result); value.error = undefined }
    else { value.phase = outcome.uncertain || lease.wasUncertain ? 'uncertain' : 'blocked'; value.error = outcome.error }
    this.publish()
  }
  interrupt(lease: InventoryAttemptLease) { const value = this.current(lease); if (value?.phase === 'pending') { value.phase = value.dispatched || lease.wasUncertain ? 'uncertain' : 'blocked'; value.error = value.phase === 'uncertain' ? 'So‘rov yuborilgach oyna yopilgan. Avvalgi amal saqlanmoqda.' : 'So‘rov yuborilmasdan to‘xtatildi.'; value.serial = ++this.serial; this.publish() } }
  clear(scope: string, context: string) { if (scope !== this.scope) return; const value = this.entries.get(context); if (value && ['pending', 'uncertain'].includes(value.phase)) throw new Error('Avvalgi amal holati tekshirilmaguncha yangi amal boshlanmaydi.'); if (this.entries.delete(context)) this.publish() }
}
export const inventoryAttempts = new InventoryAttemptRegistry()
