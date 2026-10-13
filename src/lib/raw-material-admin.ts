import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { Row, Session } from './api-types'
import { hasCapability, meetsRequirement } from './permissions'

const base = '/v1/mobile/admin'
const assignmentsPath = `${base}/raw-material-assignments`

/** These limitations belong to the existing API, not to a simulated web workflow. */
export const RAW_MATERIAL_API_LIMITATIONS = [
  'Assignment uses barcode + order_id + canonical apparatus. The API has no purchase allocation or layer_index write.',
  'Stock id, width and micron are read from stock. Assignment does not accept them; width compatibility comes from server diagnostics. There is no separate micron compatibility contract.',
  'History is a warehouse snapshot of at most 200 events; the API has no barcode filter or history pagination.',
  'Assignment writes have no idempotency key or revision precondition. Uncertain writes require readback and fresh eligibility checks before another explicit confirmation.',
] as const

export interface RawMaterialStock extends Row {
  id: string
  barcode: string
  warehouse: string
  item_code: string
  qty: number
  uom: string
  status: string
  reserved_order_id: string
  width_mm: number | null
  micron: number | null
}

export interface RawMaterialAssignment extends Row {
  order_id: string
  barcode: string
  apparatus_id: string
  item_code: string
  item_name: string
  item_group: string
  assigned_at: string
  stock_status: string
  execution_status: string
  stock_warehouse: string
  reserved_order_id: string
  stock_qty: number
  received_qty: number
  consumed_qty: number
  remaining_qty: number
}

export interface RawMaterialLookup extends Row {
  barcode: string
  warehouse: string
  item_code: string
  qty: number
  uom: string
  status: string
  reserved_order_id: string
  assignment: RawMaterialAssignment | null
  order: Row | null
  queue_states: Row
  logs: Row[]
}

export interface RawMaterialOrderCandidate extends Row {
  order: Row & { map: Row & { id: string } }
  apparatus_options: string[]
}

export interface RawMaterialCandidate extends Row {
  barcode: string
  warehouse: string
  item_code: string
  qty: number
  uom: string
  apparatus_options: string[]
}

export interface RawMaterialDiagnostic extends Row {
  barcode: string
  compatible: boolean
  reason: string
  warehouse: string
  item_code: string
  stock_status: string
  reserved_order_id: string
  apparatus_options: string[]
}

export interface RawMaterialWrite {
  action: 'assign' | 'unlink'
  stock: RawMaterialStock
  orderId: string
  apparatusId: string
  assignment?: RawMaterialAssignment
}

export function rawMaterialPermissions(session: Session | null | undefined) {
  return {
    stock: meetsRequirement(session, { any: ['admin.access', 'catalog.item.read', 'raw_material.assign'] }),
    history: meetsRequirement(session, { any: ['admin.access', 'catalog.item.read', 'raw_material.assign'] }),
    lookup: meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'raw_material.assign', 'apparatus.queue.manage'] }),
    candidates: meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'raw_material.assign'] }),
    assign: hasCapability(session, 'raw_material.assign'),
  }
}

function invalid(message = 'Xomashyo javobi to‘liq kelmadi. Holatni yangilang.'): never {
  throw new ApiError(502, 'invalid_response', message)
}

function string(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) return invalid()
  return value.trim()
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid()
  return value
}

function dimension(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const result = number(value)
  if (result <= 0) return invalid('Rulon o‘lchami noto‘g‘ri. Holatni yangilang.')
  return result
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid()
  const result = value.map(item => string(item))
  if (new Set(result).size !== result.length) return invalid()
  return result
}

function barcodeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function sameText(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** Raw stock exposes `id`; warehouse roll lists elsewhere expose `stock_id`. */
export function rawMaterialStockId(row: Row): string {
  const value = row.id ?? row.stock_id
  return typeof value === 'string' ? value.trim() : ''
}

export function rawMaterialOrderId(row: Row): string {
  const value = isRecord(row.map) ? row.map.id : row.id
  return typeof value === 'string' ? value.trim() : ''
}

export function parseRawMaterialStock(value: unknown): RawMaterialStock {
  const row = record(value)
  const id = string(row.id)
  if (row.stock_id !== undefined && row.stock_id !== id) return invalid()
  return { ...row, id, barcode: string(row.barcode), warehouse: string(row.warehouse), item_code: string(row.item_code), qty: number(row.qty), uom: string(row.uom), status: string(row.status), reserved_order_id: string(row.reserved_order_id, true), width_mm: dimension(row.width_mm), micron: dimension(row.micron) }
}

export function parseRawMaterialAssignment(value: unknown): RawMaterialAssignment {
  const row = record(value)
  return {
    ...row,
    order_id: string(row.order_id), barcode: string(row.barcode), apparatus_id: string(row.apparatus_id),
    item_code: string(row.item_code), item_name: string(row.item_name), item_group: string(row.item_group),
    assigned_at: string(row.assigned_at), stock_status: string(row.stock_status, true), execution_status: string(row.execution_status),
    stock_warehouse: string(row.stock_warehouse, true), reserved_order_id: string(row.reserved_order_id, true),
    stock_qty: number(row.stock_qty), received_qty: number(row.received_qty), consumed_qty: number(row.consumed_qty), remaining_qty: number(row.remaining_qty),
  }
}

export function parseRawMaterialLookup(value: unknown, expectedBarcode: string): RawMaterialLookup {
  const row = record(value)
  const barcode = string(row.barcode)
  if (barcodeKey(barcode) !== barcodeKey(expectedBarcode) || !Object.hasOwn(row, 'assignment') || !Object.hasOwn(row, 'order')) return invalid('Server boshqa rulon ma’lumotini qaytardi. Holatni yangilang.')
  const assignment = row.assignment === null ? null : parseRawMaterialAssignment(row.assignment)
  const order = row.order === null ? null : record(row.order)
  if (assignment && (barcodeKey(assignment.barcode) !== barcodeKey(barcode) || !order || rawMaterialOrderId(order) !== assignment.order_id)) return invalid()
  if (!assignment && order !== null) return invalid()
  return { ...row, barcode, warehouse: string(row.warehouse), item_code: string(row.item_code), qty: number(row.qty), uom: string(row.uom), status: string(row.status), reserved_order_id: string(row.reserved_order_id, true), assignment, order, queue_states: record(row.queue_states), logs: rows(row.logs) }
}

export function parseRawMaterialOrderCandidate(value: unknown): RawMaterialOrderCandidate {
  const row = record(value)
  const order = record(row.order)
  const map = record(order.map)
  return { ...row, order: { ...order, map: { ...map, id: string(map.id) } }, apparatus_options: strings(row.apparatus_options) }
}

export function parseRawMaterialCandidate(value: unknown): RawMaterialCandidate {
  const row = record(value)
  return { ...row, barcode: string(row.barcode), warehouse: string(row.warehouse), item_code: string(row.item_code), qty: number(row.qty), uom: string(row.uom), apparatus_options: strings(row.apparatus_options) }
}

export function parseRawMaterialDiagnostic(value: unknown, barcode: string): RawMaterialDiagnostic {
  const row = record(value)
  if (typeof row.compatible !== 'boolean' || barcodeKey(row.barcode) !== barcodeKey(barcode)) return invalid()
  for (const key of ['order_width_mm', 'roll_width_mm', 'minimum_width_mm', 'maximum_width_mm']) if (row[key] !== undefined && row[key] !== null) number(row[key])
  return { ...row, barcode: string(row.barcode), compatible: row.compatible, reason: string(row.reason), warehouse: string(row.warehouse), item_code: string(row.item_code), stock_status: string(row.stock_status), reserved_order_id: string(row.reserved_order_id, true), apparatus_options: strings(row.apparatus_options) }
}

export async function rawMaterialLookup(client: ApiClient, barcode: string, signal?: AbortSignal): Promise<RawMaterialLookup> {
  const key = string(barcode)
  return parseRawMaterialLookup(await client.get(`${assignmentsPath}/lookup`, { barcode: key }, signal), key)
}

export async function rawMaterialStockSnapshot(client: ApiClient, warehouse: string, signal?: AbortSignal): Promise<RawMaterialStock[]> {
  const stock = rows(await client.get(`${base}/raw-material-stock`, { warehouse: string(warehouse), limit: 500 }, signal)).map(parseRawMaterialStock)
  const keys = stock.map(row => barcodeKey(row.barcode))
  if (new Set(keys).size !== keys.length || new Set(stock.map(row => row.id)).size !== stock.length || stock.some(row => !sameText(row.warehouse, warehouse))) return invalid()
  return stock
}

export async function rawMaterialCandidateOrders(client: ApiClient, barcode: string, signal?: AbortSignal): Promise<RawMaterialOrderCandidate[]> {
  const orders = rows(await client.get(`${assignmentsPath}/candidate-orders`, { barcode: string(barcode) }, signal)).map(parseRawMaterialOrderCandidate)
  if (new Set(orders.map(row => row.order.map.id)).size !== orders.length) return invalid()
  return orders
}

export async function rawMaterialCandidates(client: ApiClient, orderId: string, signal?: AbortSignal): Promise<RawMaterialCandidate[]> {
  const candidates = rows(await client.get(`${assignmentsPath}/candidates`, { order_id: string(orderId) }, signal)).map(parseRawMaterialCandidate)
  if (new Set(candidates.map(row => barcodeKey(row.barcode))).size !== candidates.length) return invalid()
  return candidates
}

export async function rawMaterialAssignments(client: ApiClient, orderId: string, signal?: AbortSignal): Promise<RawMaterialAssignment[]> {
  const result = rows(await client.get(assignmentsPath, { order_id: string(orderId) }, signal)).map(parseRawMaterialAssignment)
  if (result.some(row => row.order_id !== orderId.trim()) || new Set(result.map(row => barcodeKey(row.barcode))).size !== result.length) return invalid()
  return result
}

export async function rawMaterialDiagnostic(client: ApiClient, barcode: string, orderId = '', apparatusId = '', signal?: AbortSignal): Promise<RawMaterialDiagnostic> {
  return parseRawMaterialDiagnostic(await client.get(`${assignmentsPath}/diagnostics`, { barcode: string(barcode), order_id: orderId.trim(), apparatus: apparatusId.trim() }, signal), barcode)
}

/** A bounded warehouse feed is filtered locally; absence never proves no history. */
export async function rawMaterialHistory(client: ApiClient, warehouse: string, barcode: string, signal?: AbortSignal): Promise<Row[]> {
  return rows(await client.get(`${base}/raw-material-history`, { warehouse: string(warehouse), limit: 200 }, signal)).filter(event => barcodeKey(event.barcode) === barcodeKey(barcode)).map(event => {
    string(event.event_id)
    string(event.event_type)
    number(event.qty_delta)
    number(event.occurred_at_unix)
    return event
  })
}

export function rawMaterialStockMatches(selected: Row, current: Row): boolean {
  const selectedId = rawMaterialStockId(selected)
  if (selected.id !== undefined && selected.stock_id !== undefined && selected.id !== selected.stock_id) return false
  return Boolean(barcodeKey(selected.barcode)) && barcodeKey(selected.barcode) === barcodeKey(current.barcode)
    && (!selectedId || selectedId === rawMaterialStockId(current))
    && ['warehouse', 'item_code', 'uom'].every(key => selected[key] === undefined || sameText(selected[key], current[key]))
}

function lookupMatchesStock(stock: RawMaterialStock, lookup: RawMaterialLookup): boolean {
  return barcodeKey(stock.barcode) === barcodeKey(lookup.barcode)
    && sameText(stock.warehouse, lookup.warehouse) && sameText(stock.item_code, lookup.item_code) && sameText(stock.uom, lookup.uom)
}

const diagnosticMessages: Record<string, string> = {
  compatible: 'Server material, guruh va kenglik mosligini tasdiqladi.',
  raw_material_already_assigned_to_order: 'Rulon shu buyurtmaga allaqachon ulangan.',
  raw_material_already_assigned: 'Rulon boshqa buyurtmaga ulangan.',
  raw_material_stock_unavailable: 'Rulon mavjud emas yoki band.',
  raw_material_order_not_active: 'Buyurtma xomashyo ulash uchun faol emas.',
  raw_material_group_not_allowed: 'Material guruhi bu apparatga mos emas.',
  apparatus_not_assigned: 'Apparat sizga biriktirilmagan.',
  raw_material_roll_size_mismatch: 'Rulon kengligi buyurtma uchun ruxsat etilgan oraliqqa mos emas.',
  raw_material_roll_size_missing: 'Rulon yoki buyurtma kengligi yetishmaydi.',
  no_compatible_active_order: 'Rulonga mos faol buyurtma topilmadi.',
  raw_material_assignment_locked: 'Ishlatilayotgan yoki sarflangan rulonni uzib bo‘lmaydi.',
}

export function rawMaterialDiagnosticMessage(reason: string): string {
  return diagnosticMessages[reason] ?? `Server sababi: ${reason}`
}

/** Candidate membership and exact diagnostic identity are both required. */
export function rawMaterialAssignmentIssue(stock: RawMaterialStock, lookup: RawMaterialLookup, candidate: RawMaterialOrderCandidate | undefined, apparatusId: string, diagnostic: RawMaterialDiagnostic | undefined): string {
  if (!lookupMatchesStock(stock, lookup)) return 'Rulon identifikatori o‘zgargan. Ma’lumotni yangilang.'
  if (lookup.assignment) return 'Rulon allaqachon buyurtmaga ulangan.'
  if (stock.status.toLowerCase() !== 'available' || lookup.status.toLowerCase() !== 'available' || stock.reserved_order_id || lookup.reserved_order_id || stock.qty <= 0 || lookup.qty <= 0) return 'Rulon mavjud emas yoki band.'
  if (!candidate) return 'Serverdan mos faol buyurtmani tanlang.'
  if (!apparatusId || !candidate.apparatus_options.includes(apparatusId)) return 'Serverdan mos apparatni tanlang.'
  if (!diagnostic) return 'Server moslik tekshiruvi hali olinmagan.'
  if (diagnostic.order_id !== candidate.order.map.id || diagnostic.apparatus !== apparatusId || !diagnostic.apparatus_options.includes(apparatusId) || barcodeKey(diagnostic.barcode) !== barcodeKey(stock.barcode) || !sameText(diagnostic.warehouse, stock.warehouse) || !sameText(diagnostic.item_code, stock.item_code)) return 'Moslik tekshiruvi boshqa tanlovga tegishli. Yangilang.'
  if (diagnostic.stock_status.toLowerCase() !== 'available' || diagnostic.reserved_order_id) return 'Rulon mavjud emas yoki band.'
  if (!diagnostic.compatible || diagnostic.reason !== 'compatible') return rawMaterialDiagnosticMessage(diagnostic.reason)
  const width = diagnostic.roll_width_mm
  if (typeof width === 'number') {
    if (width <= 0 || (stock.width_mm !== null && stock.width_mm !== width) || (typeof diagnostic.minimum_width_mm === 'number' && width < diagnostic.minimum_width_mm) || (typeof diagnostic.maximum_width_mm === 'number' && width > diagnostic.maximum_width_mm)) return 'Rulon kengligi moslik tekshiruvi bilan tasdiqlanmagan.'
  }
  return ''
}

function sameAssignment(left: RawMaterialAssignment, right: RawMaterialAssignment): boolean {
  return left.order_id === right.order_id && barcodeKey(left.barcode) === barcodeKey(right.barcode)
    && left.apparatus_id === right.apparatus_id && sameText(left.item_code, right.item_code) && left.assigned_at === right.assigned_at
}

export function rawMaterialUnlinkIssue(assignment: RawMaterialAssignment, lookup: RawMaterialLookup): string {
  if (!lookup.assignment || !sameAssignment(assignment, lookup.assignment)) return 'Biriktirish o‘zgargan. Joriy holatni yangilang.'
  if (lookup.status.toLowerCase() !== 'available' || assignment.stock_status.toLowerCase() !== 'available' || lookup.reserved_order_id || assignment.reserved_order_id || assignment.received_qty > 0 || assignment.consumed_qty > 0 || ['in_use', 'consumed'].includes(assignment.execution_status)) return 'Band, ishlatilayotgan yoki sarflangan rulonni uzib bo‘lmaydi.'
  if (!knownAssignmentStatus(assignment)) return 'Biriktirish holati tasdiqlanmagan. Joriy holatni yangilang.'
  return ''
}

export class RawMaterialMutationError extends Error {
  readonly uncertain: boolean
  constructor(message: string, uncertain: boolean) {
    super(message)
    this.name = 'RawMaterialMutationError'
    this.uncertain = uncertain
  }
}

function matchesWrite(assignment: RawMaterialAssignment, write: RawMaterialWrite): boolean {
  return assignment.order_id === write.orderId && barcodeKey(assignment.barcode) === barcodeKey(write.stock.barcode)
    && assignment.apparatus_id === write.apparatusId && sameText(assignment.item_code, write.stock.item_code)
    && sameText(assignment.stock_warehouse, write.stock.warehouse)
}

function knownAssignmentStatus(assignment: RawMaterialAssignment): boolean {
  if ([assignment.stock_qty, assignment.received_qty, assignment.consumed_qty, assignment.remaining_qty].some(qty => qty < 0)) return false
  const status = assignment.stock_status.toLowerCase()
  if (status === 'consumed') return assignment.execution_status === 'consumed'
  if (status === 'in_use') return assignment.execution_status === (assignment.reserved_order_id === assignment.order_id ? 'in_use' : 'unavailable')
  return status === 'available' && ['ready', 'awaiting_delivery', 'compatible', 'needs_cutting', 'width_mismatch', 'dimensions_missing', 'unavailable'].includes(assignment.execution_status)
    && (!assignment.reserved_order_id || assignment.execution_status === 'unavailable')
}

/** No write is retried automatically, including POST: the contract has no idempotency key. */
export async function rawMaterialMutation(client: ApiClient, session: Session | null, write: RawMaterialWrite, signal?: AbortSignal): Promise<RawMaterialLookup> {
  if (!rawMaterialPermissions(session).assign) throw new ApiError(403, 'forbidden')
  if (!write.orderId.trim() || !write.apparatusId.trim() || !rawMaterialStockId(write.stock)) throw new Error('Buyurtma, apparat va rulon identifikatorlarini tekshiring.')
  let started = false
  try {
    const [stockRows, lookup] = await Promise.all([
      rawMaterialStockSnapshot(client, write.stock.warehouse, signal),
      rawMaterialLookup(client, write.stock.barcode, signal),
    ])
    const stock = stockRows.find(row => rawMaterialStockMatches(write.stock, row))
    if (!stock || !lookupMatchesStock(stock, lookup)) throw new Error('Tanlangan rulon joriy qoldiqda tasdiqlanmadi. Ma’lumotni yangilang.')
    if (write.action === 'assign') {
      const [candidates, diagnostic] = await Promise.all([
        rawMaterialCandidateOrders(client, stock.barcode, signal),
        rawMaterialDiagnostic(client, stock.barcode, write.orderId, write.apparatusId, signal),
      ])
      const issue = rawMaterialAssignmentIssue(stock, lookup, candidates.find(row => row.order.map.id === write.orderId), write.apparatusId, diagnostic)
      if (issue) throw new Error(issue)
      if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
      started = true
      const assignment = parseRawMaterialAssignment(await client.post(assignmentsPath, { order_id: write.orderId, barcode: stock.barcode, apparatus: write.apparatusId }, signal))
      if (!matchesWrite(assignment, write) || !knownAssignmentStatus(assignment)) return invalid('Server tanlangan biriktirish holatini tasdiqlamadi.')
      const confirmed = await rawMaterialLookup(client, stock.barcode, signal)
      if (!confirmed.assignment || !sameAssignment(assignment, confirmed.assignment) || !knownAssignmentStatus(confirmed.assignment) || !lookupMatchesStock(stock, confirmed)) return invalid('Biriktirish natijasi joriy server holatida tasdiqlanmadi.')
      return confirmed
    }
    if (!write.assignment || !matchesWrite(write.assignment, write)) throw new Error('Uzish uchun joriy biriktirishni tanlang.')
    const issue = rawMaterialUnlinkIssue(write.assignment, lookup)
    if (issue) throw new Error(issue)
    if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
    started = true
    const result = record(await client.request(assignmentsPath, 'DELETE', { body: { order_id: write.orderId, barcode: stock.barcode }, signal }))
    const removed = parseRawMaterialAssignment(result.assignment)
    if (result.ok !== true || !sameAssignment(removed, write.assignment) || !matchesWrite(removed, write) || !knownAssignmentStatus(removed)) return invalid('Server tanlangan biriktirish uzilganini tasdiqlamadi.')
    const confirmed = await rawMaterialLookup(client, stock.barcode, signal)
    if (confirmed.assignment !== null || !lookupMatchesStock(stock, confirmed)) return invalid('Uzish natijasi joriy server holatida tasdiqlanmadi.')
    return confirmed
  } catch (error) {
    const uncertain = started && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response')
    const message = error instanceof ApiError && diagnosticMessages[error.code] ? rawMaterialDiagnosticMessage(error.code) : error instanceof Error ? error.message : 'So‘rov bajarilmadi.'
    throw new RawMaterialMutationError(uncertain ? 'Amal natijasi aniqlanmagan. Qayta tasdiqlashdan oldin server holatini tekshiring.' : message, uncertain)
  }
}

export async function reconcileRawMaterialMutation(client: ApiClient, write: RawMaterialWrite, signal?: AbortSignal): Promise<{ state: 'confirmed' | 'not-applied' | 'changed'; lookup: RawMaterialLookup }> {
  const [lookup, stock] = await Promise.all([
    rawMaterialLookup(client, write.stock.barcode, signal),
    rawMaterialStockSnapshot(client, write.stock.warehouse, signal),
  ])
  if (!lookupMatchesStock(write.stock, lookup) || !stock.some(row => rawMaterialStockMatches(write.stock, row))) return { state: 'changed', lookup }
  if (write.action === 'assign') {
    if (lookup.assignment) return { state: matchesWrite(lookup.assignment, write) && knownAssignmentStatus(lookup.assignment) ? 'confirmed' : 'changed', lookup }
    return { state: 'not-applied', lookup }
  }
  if (!lookup.assignment) return { state: 'confirmed', lookup }
  return { state: write.assignment && sameAssignment(write.assignment, lookup.assignment) ? 'not-applied' : 'changed', lookup }
}
