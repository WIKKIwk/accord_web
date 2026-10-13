import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { hasCapability, meetsRequirement } from './permissions'
import { isCanonicalApparatusId, productionMapFromRow } from './production-map'
import { productionOrderPolicy } from './production-controls'
import { rawMaterialAssignments, rawMaterialLookup } from './raw-material-admin'
import { ProductionOperationLedger, productionOperationLedger } from './production-operation-ledger'
import type { ProductionOperation, ProductionOperationLease } from './production-operation-ledger'

const base = '/v1/mobile/admin'
const str = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const keyOf = (value: unknown) => str(value).replace(/[a-z]/g, value => value.toUpperCase())
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const stable = (value: unknown): string => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))])) : value ?? null)
const same = (left: unknown, right: unknown) => stable(left) === stable(right)
const liveStates = new Set(['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'waiting_next_stage', 'partially_completed'])
export const MATERIAL_INTAKE_API_LIMITATIONS = [
  'Intake has no idempotency key, expected revision, stage selector or session receipt. It returns an enriched assignment. Uncertain intake is observed, never replayed.',
  'Delivery uses a native body idempotency_key and returns only ok/barcode/apparatus. Actual asset, custody warehouse and source/destination locations are bound internally by the handler; those IDs are not exposed by its preview.',
  'Delivery history is a warehouse/type feed of at most 200 events. Only an exact key/actor/deliverer/material record proves that receipt; absence never proves rollback.',
  'Production preflight is a fresh read, not native CAS. Repeated apparatus stages are blocked because neither command accepts a stage ID. Cutting receives upstream WIP through its separate workflow.',
  'Postgres intake appends resources to an existing execution in its stock transaction. The response does not attest a session ID or resource record; the UI confirms the actual stock binding only.',
] as const
export class MaterialIntakeError extends Error {
  readonly kind: 'blocked' | 'conflict' | 'forbidden' | 'uncertain'
  constructor(kind: MaterialIntakeError['kind'], message: string) { super(message); this.name = 'MaterialIntakeError'; this.kind = kind }
}
const blocked = (message: string): never => { throw new MaterialIntakeError('blocked', message) }
const invalid = (message = 'Material javobi to‘liq yoki tanlangan buyurtma va rulonga mos kelmadi.'): never => { throw new ApiError(502, 'invalid_response', message) }
function current(signal: AbortSignal, isCurrent: () => boolean) { if (signal.aborted || !isCurrent()) throw new DOMException('Interrupted', 'AbortError') }
export function materialIntakePermissions(session: Session | null) {
  return { manage: hasCapability(session, 'apparatus.queue.manage'), read: meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'] }), history: meetsRequirement(session, { any: ['admin.access', 'catalog.item.read', 'raw_material.assign'] }) }
}
export interface MaterialIntakePolicy {
  apparatusId: string; name: string; stageNodeId: string; stageTitle: string; operation: string
  sourceRevision: number; sourceHash: string; state: string; bound: boolean; intake: boolean; delivery: boolean; reason: string
}
function fingerprint(snapshot: ProductionSnapshot, orderId: string, apparatusId: string): string {
  return stable([snapshot.maps.find(saved => saved.map.id === orderId)?.map, snapshot.order_statuses[orderId], snapshot.order_controls[orderId], snapshot.stage_states[orderId], snapshot.queue_states[apparatusId]?.[orderId], snapshot.queue_action_controls[apparatusId]?.[orderId]])
}
export function materialIntakePolicies(snapshot: ProductionSnapshot | undefined, orderId: string, session: Session | null, apparatusRows: readonly Row[] = []): MaterialIntakePolicy[] {
  const saved = snapshot?.maps.find(value => value.map.id === orderId)
  if (!snapshot || !saved || orderId.startsWith('training-')) return []
  let map: ReturnType<typeof productionMapFromRow>
  try { map = productionMapFromRow(saved.map) } catch { return [] }
  const order = productionOrderPolicy(snapshot, orderId, session), permission = materialIntakePermissions(session)
  const activeOrder = order.state === 'active' && !order.earlyClose && ['released', 'in_progress'].includes(order.lifecycle) && liveStates.has(order.operational)
  return Object.entries(snapshot.queue_action_controls).filter(([id, controls]) => isCanonicalApparatusId(id) && isRecord(controls[orderId])).map(([apparatusId, controls]) => {
    const control = controls[orderId], interaction = record(control.interaction)
    const metadata = apparatusRows.map(value => isRecord(value.runtime_projection) ? value.runtime_projection : value).filter(value => value.apparatus_id === apparatusId)
    const apparatus = metadata.length === 1 ? metadata[0] : {}, sourceRevision = apparatus.source_revision
    const operation = str(record(apparatus.execution_profile).operation), state = str(control.state), stageNodeId = str(control.stage_node_id)
    const matches = map.nodes.filter(node => node.kind === 'apparatus' && (str(node.alternative_assigned_apparatus_id) || str(node.apparatus_id)) === apparatusId)
    const lanes = new Set(matches.map(node => str(node.alternative_group_id) ? `group:${node.alternative_group_id}` : `node:${node.id}`))
    const stage = matches.find(node => node.id === stageNodeId)
    const assigned = Boolean(session?.assigned_apparatus.includes(apparatusId))
    const roleAllowed = session?.profile.role === 'aparatchi' ? assigned : hasCapability(session, 'admin.access')
    const bound = Boolean(stage && lanes.size === 1 && metadata.length === 1 && integer(sourceRevision) && sourceRevision > 0 && /^[a-f0-9]{64}$/.test(str(apparatus.source_aasx_sha256)) && record(apparatus.lifecycle).state === 'active' && ['print', 'laminate', 'cut', 'package', 'glue'].includes(operation)
      && control.state === snapshot.queue_states[apparatusId]?.[orderId] && typeof interaction.material_intake_allowed === 'boolean' && typeof interaction.material_scan_required === 'boolean' && typeof interaction.assigned_materials_display_only === 'boolean'
      && typeof interaction.resume_input_required === 'boolean' && (interaction.start_materials_mode === 'scan_required') === interaction.material_scan_required)
    const valid = activeOrder && bound
    const intakeMode = ['in_progress', 'paused'].includes(state) && interaction.mode === state && interaction.material_intake_allowed === true && interaction.assigned_materials_display_only === false
    const startMode = state === 'pending' && interaction.mode === 'fresh_start' && Array.isArray(control.allowed_actions) && control.allowed_actions.includes('start') && interaction.start_materials_mode === 'scan_required' && !str(interaction.blocking_reason_code)
    const intake = Boolean(permission.manage && valid && intakeMode && assigned && operation !== 'cut')
    const delivery = Boolean(permission.manage && valid && roleAllowed && (startMode || intakeMode && operation !== 'cut'))
    return { apparatusId, name: str(record(apparatus.display).display_name) || apparatusId, stageNodeId, stageTitle: str(stage?.alternative_group_label) || str(stage?.title) || stageNodeId, operation, sourceRevision: integer(sourceRevision) ? sourceRevision : 0, sourceHash: str(apparatus.source_aasx_sha256), state, bound, intake, delivery,
      reason: !permission.manage ? 'Material qabul qilish uchun apparatus.queue.manage ruxsati kerak.' : !activeOrder ? 'Buyurtma faol emas yoki uning boshqaruv holati qabulga ruxsat bermaydi.' : lanes.size !== 1 ? 'Uskuna bir nechta bosqichda takrorlangan. Native qabul amali aniq bosqichni qabul qilmaydi.' : !valid ? 'Canonical apparat, bosqich yoki server ruxsatlari to‘liq va mos olinmadi.' : operation === 'cut' ? 'Kesish bosqichi kirish WIPni alohida oqimda qabul qiladi.' : !assigned && intakeMode ? 'Qo‘shimcha qabul uchun bu apparat sessiyaning haqiqiy biriktirish doirasida bo‘lishi kerak.' : !roleAllowed ? 'Yetkazishni qayd etish uchun bu rolning apparat yoki admin.access doirasi yetarli emas.' : !intake && !delivery ? 'Server joriy bosqichda material qabul qilishga ruxsat bermagan.' : '' }
  })
}
export interface IntakeAssignment {
  order_id: string; apparatus_id: string; barcode: string; item_code: string; item_name: string; item_group: string
  assigned_at: string; assigned_by_role: string; assigned_by_ref: string
  stock_status: string; execution_status: string; stock_warehouse: string; stock_uom: string; reserved_order_id: string
  stock_qty: number; received_qty: number; consumed_qty: number; remaining_qty: number; roll_width_mm: number | null
}
export function parseIntakeAssignment(value: unknown, orderId: string, apparatusId: string): IntakeAssignment {
  const row = record(value), quantities = ['stock_qty', 'received_qty', 'consumed_qty', 'remaining_qty'] as const
  if (row.order_id !== orderId || row.apparatus_id !== apparatusId || !isCanonicalApparatusId(apparatusId) || quantities.some(key => !finite(row[key])) || typeof row.reserved_order_id !== 'string' || typeof row.stock_status !== 'string' || typeof row.execution_status !== 'string' || typeof row.stock_warehouse !== 'string' || typeof row.stock_uom !== 'string' || row.roll_width_mm !== null && !finite(row.roll_width_mm)) return invalid()
  const text = ['barcode', 'item_code', 'item_name', 'item_group', 'assigned_at', 'assigned_by_role', 'assigned_by_ref'] as const
  if (text.some(key => typeof row[key] !== 'string' || !str(row[key]))) return invalid()
  return Object.fromEntries([...text, ...quantities, 'order_id', 'apparatus_id', 'stock_status', 'execution_status', 'stock_warehouse', 'stock_uom', 'reserved_order_id', 'roll_width_mm'].map(key => [key, row[key]])) as unknown as IntakeAssignment
}
export interface MaterialStartRequirements { staged: string[]; required: number; matched: number; materialScanRequired: boolean; assignmentsSatisfied: boolean; scanSatisfied: boolean }
export function parseMaterialStartRequirements(value: unknown): MaterialStartRequirements {
  const row = record(value)
  if (!Array.isArray(row.staged_barcodes) || row.staged_barcodes.some(value => !str(value)) || typeof row.material_scan_required !== 'boolean' || typeof row.assignments_satisfied !== 'boolean' || typeof row.scan_satisfied !== 'boolean' || !integer(row.required_scan_count) || !integer(row.matched_scan_count) || row.scan_satisfied && row.matched_scan_count < row.required_scan_count) return invalid()
  const staged = row.staged_barcodes.map(keyOf)
  if (new Set(staged).size !== staged.length) return invalid()
  return { staged, required: row.required_scan_count, matched: row.matched_scan_count, materialScanRequired: row.material_scan_required, assignmentsSatisfied: row.assignments_satisfied, scanSatisfied: row.scan_satisfied }
}
export interface MaterialDeliverer { role: string; ref: string; name: string }
export interface MaterialDeliveryPreview { alreadyAtApparatus: boolean; deliverers: MaterialDeliverer[] }
export function parseMaterialDeliveryPreview(value: unknown): MaterialDeliveryPreview {
  const row = record(value)
  if (typeof row.already_at_apparatus !== 'boolean') return invalid()
  const deliverers = rows(row.deliverers).map(value => {
    if (['role', 'ref', 'name'].some(key => typeof value[key] !== 'string' || !str(value[key]))) return invalid()
    return { role: str(value.role), ref: str(value.ref), name: str(value.name) }
  })
  if (new Set(deliverers.map(value => stable([value.role, value.ref]))).size !== deliverers.length) return invalid()
  return { alreadyAtApparatus: row.already_at_apparatus, deliverers }
}
export async function materialDeliveryPreview(client: ApiClient, orderId: string, apparatusId: string, barcode: string, signal?: AbortSignal): Promise<MaterialDeliveryPreview> {
  return parseMaterialDeliveryPreview(await client.get(`${base}/raw-material-start-receipt`, { order_id: orderId, apparatus: apparatusId, barcode }, signal))
}
export interface MaterialIntakeMaterials { assignments: IntakeAssignment[]; candidates: IntakeAssignment[]; requirements: MaterialStartRequirements }
export async function materialIntakeMaterials(client: ApiClient, orderId: string, policy: MaterialIntakePolicy, signal?: AbortSignal): Promise<MaterialIntakeMaterials> {
  const [all, candidates, requirements] = await Promise.all([
    rawMaterialAssignments(client, orderId, signal),
    policy.intake ? client.get(`${base}/raw-material-intake-candidates`, { order_id: orderId, apparatus: policy.apparatusId }, signal).then(rows) : Promise.resolve([]),
    client.get(`${base}/raw-material-start-requirements`, { order_id: orderId, apparatus: policy.apparatusId }, signal).then(parseMaterialStartRequirements),
  ])
  const assignments = all.filter(value => value.apparatus_id === policy.apparatusId).map(value => parseIntakeAssignment(value, orderId, policy.apparatusId))
  const parsed = candidates.map(value => parseIntakeAssignment(value, orderId, policy.apparatusId))
  if (new Set(parsed.map(value => keyOf(value.barcode))).size !== parsed.length || parsed.some(value => !assignments.some(assignment => same(assignment, value)))) return invalid()
  return { assignments, candidates: parsed, requirements }
}
function available(assignment: IntakeAssignment): boolean { return assignment.stock_status === 'available' && !assignment.reserved_order_id && assignment.stock_qty > 0 && assignment.received_qty === 0 && assignment.consumed_qty === 0 && assignment.remaining_qty === 0 && Boolean(str(assignment.stock_warehouse) && str(assignment.stock_uom)) && ['ready', 'awaiting_delivery'].includes(assignment.execution_status) }
export function materialIntakeChoices(materials: MaterialIntakeMaterials, policy: MaterialIntakePolicy): IntakeAssignment[] { return (policy.intake ? materials.candidates : policy.delivery ? materials.assignments : []).filter(available) }
export interface MaterialIntakeStock { barcode: string; warehouse: string; item_code: string; qty: number; uom: string; source_receipt_id: string }
export async function materialIntakeStock(client: ApiClient, orderId: string, apparatusId: string, barcode: string, signal?: AbortSignal): Promise<MaterialIntakeStock> {
  const lookup = await rawMaterialLookup(client, barcode, signal)
  if (lookup.assignment?.order_id !== orderId || lookup.assignment.apparatus_id !== apparatusId || keyOf(lookup.assignment.barcode) !== keyOf(barcode) || !str(lookup.warehouse) || !str(lookup.uom) || typeof lookup.source_receipt_id !== 'string' || lookup.status !== lookup.assignment.stock_status || lookup.reserved_order_id !== lookup.assignment.reserved_order_id || lookup.warehouse !== lookup.assignment.stock_warehouse || lookup.qty !== lookup.assignment.stock_qty || lookup.uom !== lookup.assignment.stock_uom) return invalid()
  return { barcode: lookup.barcode, warehouse: lookup.warehouse, item_code: lookup.item_code, qty: lookup.qty, uom: lookup.uom, source_receipt_id: lookup.source_receipt_id }
}
export interface MaterialIntakeCommand {
  action: 'delivery' | 'intake'; orderId: string; apparatusId: string; stageNodeId: string; authScope: string
  epoch: string; scope: string; rev: number; fingerprint: string; sourceRevision: number; sourceHash: string
  actor: { role: string; ref: string }; baseline: IntakeAssignment; stock: MaterialIntakeStock; deliverer?: MaterialDeliverer
  key: string; body: Row
}
export function materialIntakeCommand(snapshot: ProductionSnapshot, orderId: string, session: Session | null, authScope: string, apparatusRows: readonly Row[], apparatusId: string, materials: MaterialIntakeMaterials, stock: MaterialIntakeStock, preview: MaterialDeliveryPreview, action: 'delivery' | 'intake', scanned: string, deliverer?: MaterialDeliverer, key: string = `web-material-delivery:${crypto.randomUUID()}`): MaterialIntakeCommand {
  const policy = materialIntakePolicies(snapshot, orderId, session, apparatusRows).find(value => value.apparatusId === apparatusId)
  if (!policy || !policy[action] || !str(authScope) || !str(snapshot.epoch) || typeof snapshot.scope !== 'string' || !integer(snapshot.rev) || !str(session?.profile.role) || !str(session?.profile.ref)) return blocked(policy?.reason || 'Aniq sessiya, bosqich va server ruxsatlari kerak.')
  const matches = materialIntakeChoices(materials, policy).filter(value => keyOf(value.barcode) === keyOf(scanned))
  if (matches.length !== 1) return blocked('Skanlangan shtrixkod aynan joriy server nomzodiga mos bo‘lishi kerak.')
  const assignment = matches[0]
  if (keyOf(stock.barcode) !== keyOf(assignment.barcode) || stock.warehouse !== assignment.stock_warehouse || stock.item_code !== assignment.item_code || stock.qty !== assignment.stock_qty || stock.uom !== assignment.stock_uom) return blocked('Rulonning haqiqiy ombori, miqdori yoki mahsulot manbasi o‘zgargan.')
  if (action === 'intake' && (!preview.alreadyAtApparatus || assignment.execution_status !== 'ready' || !materials.requirements.staged.includes(keyOf(assignment.barcode)))) return blocked('Rulon apparat oldiga yetkazilgani serverda tasdiqlanishi kerak.')
  if (action === 'delivery' && (preview.alreadyAtApparatus || !deliverer || !preview.deliverers.some(value => same(value, deliverer)))) return blocked('Server ruxsat bergan haqiqiy olib kelgan xodimni tanlang.')
  if (action === 'delivery' && !str(key)) return blocked('Native yetkazish identifikatori kerak.')
  const body: Row = { order_id: orderId, apparatus: apparatusId, barcode: assignment.barcode }
  if (action === 'delivery') Object.assign(body, { delivered_by_role: deliverer!.role, delivered_by_ref: deliverer!.ref, idempotency_key: key })
  return { action, orderId, apparatusId, stageNodeId: policy.stageNodeId, authScope, epoch: snapshot.epoch, scope: snapshot.scope, rev: snapshot.rev, fingerprint: fingerprint(snapshot, orderId, apparatusId), sourceRevision: policy.sourceRevision, sourceHash: policy.sourceHash, actor: { role: str(session?.profile.role), ref: str(session?.profile.ref) }, baseline: structuredClone(assignment), stock: structuredClone(stock), deliverer: action === 'delivery' ? structuredClone(deliverer) : undefined, key: action === 'delivery' ? key : `local-intake:${crypto.randomUUID()}`, body }
}
export interface MaterialIntakeProof { barcode: string; warehouse: string; qty: number; uom: string; stageNodeId: string }
export const materialIntakeProof = (plan: MaterialIntakeCommand): MaterialIntakeProof => ({ barcode: plan.baseline.barcode, warehouse: plan.stock.warehouse, qty: plan.stock.qty, uom: plan.stock.uom, stageNodeId: plan.stageNodeId })
export interface MaterialIntakeResult { message: string; assignment?: IntakeAssignment; observed: boolean; deliveryRecordId?: string; sessionConfirmed: false }
function assertOwned(session: Session | null, plan: MaterialIntakeCommand, signal: AbortSignal, isCurrent: () => boolean) {
  current(signal, isCurrent)
  if (!materialIntakePermissions(session).manage || session?.profile.role !== plan.actor.role || str(session.profile.ref) !== plan.actor.ref) throw new MaterialIntakeError('forbidden', 'Qabul aynan avvalgi operator va sessiya ruxsatlari bilan tekshirilishi kerak.')
  const operation = productionOperationLedger.get<MaterialIntakeCommand, MaterialIntakeProof>(plan.authScope, plan.orderId, 'material-intake')
  if (!operation || operation.phase !== 'pending' || !same(operation.plan, plan) || !same(operation.proof, materialIntakeProof(plan))) return blocked('Avval buyurtmaning umumiy ishlab chiqarish amalini band qiling. Yangi so‘rov yuborilmadi.')
}
function stockMatches(plan: MaterialIntakeCommand, value: MaterialIntakeStock): boolean { return keyOf(value.barcode) === keyOf(plan.stock.barcode) && same({ ...value, barcode: plan.stock.barcode }, plan.stock) }
function assignmentIdentity(plan: MaterialIntakeCommand, value: IntakeAssignment): boolean {
  return ['order_id', 'apparatus_id', 'item_code', 'item_name', 'item_group', 'assigned_at', 'assigned_by_role', 'assigned_by_ref', 'stock_warehouse', 'stock_uom', 'roll_width_mm'].every(key => same(value[key as keyof IntakeAssignment], plan.baseline[key as keyof IntakeAssignment])) && keyOf(value.barcode) === keyOf(plan.baseline.barcode) && value.stock_qty === plan.stock.qty
}
function received(plan: MaterialIntakeCommand, value: IntakeAssignment): boolean { return assignmentIdentity(plan, value) && value.stock_status === 'in_use' && value.execution_status === 'in_use' && value.reserved_order_id === plan.orderId && value.received_qty === plan.stock.qty && value.consumed_qty === 0 && value.remaining_qty === plan.stock.qty }
async function freshContext(client: ApiClient, session: Session | null, plan: MaterialIntakeCommand, signal: AbortSignal, isCurrent: () => boolean, writing: boolean) {
  assertOwned(session, plan, signal, isCurrent)
  const snapshot = await client.productionSnapshot(signal); current(signal, isCurrent)
  if (snapshot.epoch !== plan.epoch || snapshot.scope !== plan.scope || snapshot.rev < plan.rev) throw new MaterialIntakeError('conflict', 'Server yoki uning o‘qish doirasi o‘zgargan; avvalgi amal saqlanmoqda.')
  const apparatus = await client.detail('apparatus', { apparatus_id: plan.apparatusId }, signal); current(signal, isCurrent)
  const policy = materialIntakePolicies(snapshot, plan.orderId, session, [apparatus]).find(value => value.apparatusId === plan.apparatusId)
  if (!policy || !policy.bound || policy.stageNodeId !== plan.stageNodeId || writing && (!policy[plan.action] || policy.sourceRevision !== plan.sourceRevision || policy.sourceHash !== plan.sourceHash || fingerprint(snapshot, plan.orderId, plan.apparatusId) !== plan.fingerprint)) throw new MaterialIntakeError('conflict', 'Buyurtma, aniq bosqich, apparat sozlamalari yoki qabul ruxsatlari o‘zgargan.')
  return { snapshot, policy }
}
export async function readMaterialIntakeOutcome(client: ApiClient, session: Session | null, plan: MaterialIntakeCommand, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<MaterialIntakeResult | null> {
  assertOwned(session, plan, signal, isCurrent)
  if (plan.action === 'delivery') {
    const snapshot = await client.productionSnapshot(signal); current(signal, isCurrent)
    if (snapshot.epoch !== plan.epoch || snapshot.scope !== plan.scope || snapshot.rev < plan.rev) throw new MaterialIntakeError('conflict', 'Server yoki uning o‘qish doirasi o‘zgargan; avvalgi so‘rov saqlanmoqda.')
    if (!materialIntakePermissions(session).history) return null
    const history = rows(await client.get(`${base}/raw-material-history`, { warehouse: plan.stock.warehouse, event_type: 'delivery_received', limit: 200 }, signal)); current(signal, isCurrent)
    const matches = history.filter(event => {
      const payload = record(event.payload_json), deliverer = record(payload.delivered_by), receiver = record(payload.received_by)
      return event.event_type === 'delivery_received' && event.source_type === 'material_delivery' && event.source_id === plan.key && event.correlation_id === plan.key && event.order_id === plan.orderId && event.apparatus === plan.apparatusId && keyOf(event.barcode) === keyOf(plan.baseline.barcode) && event.warehouse === plan.stock.warehouse && event.item_code === plan.stock.item_code && event.uom === plan.stock.uom && event.qty_delta === 0
        && event.actor_role === plan.actor.role && event.actor_ref === plan.actor.ref && payload.order_id === plan.orderId && payload.apparatus_id === plan.apparatusId && deliverer.role === plan.deliverer?.role && deliverer.ref === plan.deliverer?.ref && receiver.role === plan.actor.role && receiver.ref === plan.actor.ref && str(event.event_id) && integer(event.occurred_at_unix) && event.occurred_at_unix > 0
    })
    if (matches.length > 1) return invalid()
    // The exact durable key proves this physical receipt even after the queue advanced.
    // It does not prove that the roll is still at the apparatus or that a run session changed.
    return matches.length === 1 ? { message: 'Aynan avvalgi yetkazish qaydi serverda tasdiqlandi. Joriy material holatini yangilang.', deliveryRecordId: str(matches[0].event_id), observed: true, sessionConfirmed: false } : null
  }
  const { policy } = await freshContext(client, session, plan, signal, isCurrent, false)
  const lookup = await rawMaterialLookup(client, plan.baseline.barcode, signal); current(signal, isCurrent)
  if (!lookup.assignment || lookup.assignment.order_id !== plan.orderId || lookup.assignment.apparatus_id !== plan.apparatusId) return null
  const assignment = parseIntakeAssignment(lookup.assignment, plan.orderId, plan.apparatusId)
  if (typeof lookup.source_receipt_id !== 'string' || lookup.status !== assignment.stock_status || lookup.reserved_order_id !== assignment.reserved_order_id) return invalid()
  const stock = { barcode: lookup.barcode, warehouse: lookup.warehouse, item_code: lookup.item_code, qty: lookup.qty, uom: lookup.uom, source_receipt_id: lookup.source_receipt_id }
  if (!stockMatches(plan, stock) || !assignmentIdentity(plan, assignment)) return null
  return received(plan, assignment) && ['in_progress', 'paused'].includes(policy.state) ? { message: 'Aynan shu rulonning joriy qabul holati serverda tasdiqlandi. Amal qayta yuborilmadi.', assignment, observed: true, sessionConfirmed: false } : null
}
export async function executeMaterialIntake(client: ApiClient, session: Session | null, plan: MaterialIntakeCommand, lease: ProductionOperationLease, signal: AbortSignal, isCurrent: () => boolean = () => true, recovery = false): Promise<MaterialIntakeResult> {
  assertOwned(session, plan, signal, isCurrent)
  const held = productionOperationLedger.get(plan.authScope, plan.orderId, 'material-intake')
  if (lease.scope !== plan.authScope || lease.orderId !== plan.orderId || lease.channel !== 'material-intake' || held?.serial !== lease.serial || recovery && !lease.wasUncertain || !recovery && held.dispatched) return blocked('Avvalgi yuborilgan so‘rov yangi amal sifatida takrorlanmaydi. Bandlik va avvalgi natijani tekshiring.')
  if (recovery) {
    const observed = await readMaterialIntakeOutcome(client, session, plan, signal, isCurrent)
    if (observed) return observed
    if (plan.action !== 'delivery') return blocked('Qabulning native takrorlash identifikatori yo‘q. Unkeyed amal qayta yuborilmaydi.')
  }
  const { policy } = await freshContext(client, session, plan, signal, isCurrent, true)
  const [materials, stock, preview] = await Promise.all([materialIntakeMaterials(client, plan.orderId, policy, signal), materialIntakeStock(client, plan.orderId, plan.apparatusId, plan.baseline.barcode, signal), materialDeliveryPreview(client, plan.orderId, plan.apparatusId, plan.baseline.barcode, signal)])
  current(signal, isCurrent)
  const assignment = materials.assignments.find(value => keyOf(value.barcode) === keyOf(plan.baseline.barcode))
  const baselineMatches = assignment && (recovery && plan.action === 'delivery' ? assignmentIdentity(plan, assignment) : same(assignment, plan.baseline))
  if (!assignment || !baselineMatches || !stockMatches(plan, stock) || !available(assignment) || plan.action === 'intake' && (!materials.candidates.some(value => same(value, assignment)) || !preview.alreadyAtApparatus || !materials.requirements.staged.includes(keyOf(assignment.barcode))) || plan.action === 'delivery' && (!preview.deliverers.some(value => same(value, plan.deliverer)) || !recovery && preview.alreadyAtApparatus)) throw new MaterialIntakeError('conflict', 'Material manbasi, ombori, tayyorligi yoki olib kelgan xodimning ruxsati o‘zgargan.')
  const expected: Row = { order_id: plan.orderId, apparatus: plan.apparatusId, barcode: plan.baseline.barcode }
  if (plan.action === 'delivery') Object.assign(expected, { delivered_by_role: plan.deliverer?.role, delivered_by_ref: plan.deliverer?.ref, idempotency_key: plan.key })
  if (!same(expected, plan.body)) return blocked('Saqlangan so‘rov tanlangan native manbaga mos emas.')
  await freshContext(client, session, plan, signal, isCurrent, true)
  if (!productionOperationLedger.dispatched(lease)) return blocked('Amal bandligi tugagan. Material so‘rovi yuborilmadi.')
  current(signal, isCurrent)
  try {
    const response = await client.request(`${base}/${plan.action === 'delivery' ? 'raw-material-start-receipt' : 'raw-material-intake'}`, 'POST', { body: plan.body, signal }); current(signal, isCurrent)
    if (plan.action === 'intake') {
      const saved = parseIntakeAssignment(response, plan.orderId, plan.apparatusId)
      if (!received(plan, saved)) return invalid('Qabul javobi aynan shu rulonning in_use holati, ombori va to‘liq miqdorini tasdiqlamadi.')
      return { message: 'Rulonning buyurtmaga qabul qilingani serverda tasdiqlandi.', assignment: saved, observed: false, sessionConfirmed: false }
    }
    const ack = record(response)
    if (ack.ok !== true || ack.apparatus !== plan.apparatusId || keyOf(ack.barcode) !== keyOf(plan.baseline.barcode)) return invalid('Yetkazish javobi tanlangan apparat va rulonni tasdiqlamadi.')
    const [ready, after] = await Promise.all([materialDeliveryPreview(client, plan.orderId, plan.apparatusId, plan.baseline.barcode, signal), materialIntakeMaterials(client, plan.orderId, policy, signal)])
    current(signal, isCurrent)
    const saved = after.assignments.find(value => keyOf(value.barcode) === keyOf(plan.baseline.barcode))
    if (!ready.alreadyAtApparatus || !saved || !assignmentIdentity(plan, saved) || !available(saved) || saved.execution_status !== 'ready' || !after.requirements.staged.includes(keyOf(plan.baseline.barcode))) return invalid('Fizik yetkazish qaydidan keyin rulonning apparat oldidagi tayyorligi tasdiqlanmadi.')
    return { message: 'Yetkazish qaydi va rulonning apparat oldidagi tayyorligi serverda tasdiqlandi.', assignment: saved, observed: false, sessionConfirmed: false }
  } catch (caught) {
    const reason = caught instanceof ApiError ? caught.status === 403 ? 'Server qabul yoki tekshirish uchun ruxsat bermadi. ' : caught.status === 409 ? 'Server joriy binding yoki avvalgi yetkazish identifikatorini rad etdi. ' : caught.code === 'raw_material_stock_unavailable' ? 'Server rulonni mavjud deb tasdiqlamadi. ' : caught.code === 'raw_material_state_not_ready' ? 'Server rulon apparat oldida tayyorligini tasdiqlamadi. ' : '' : ''
    throw new MaterialIntakeError('uncertain', `${reason}Yuborilgan qabul natijasi aniqlanmagan. So‘rov saqlangan; avval server holatini tekshiring.`)
  }
}
export interface MaterialIntakeDraft { apparatusId: string; barcode: string; scanned: string; delivererKey: string }
export const emptyMaterialIntakeDraft = (): MaterialIntakeDraft => ({ apparatusId: '', barcode: '', scanned: '', delivererKey: '' })
export class MaterialIntakeAttemptRegistry {
  private ledger: ProductionOperationLedger; private scope = ''; private revision = 0; private drafts = new Map<string, MaterialIntakeDraft>(); private listeners = new Set<() => void>()
  constructor(ledger = new ProductionOperationLedger()) { this.ledger = ledger }
  activate(scope: string) { this.ledger.activate(scope); if (scope !== this.scope) { this.scope = scope; this.drafts.clear(); this.revision++ } }
  subscribe = (callback: () => void) => { this.listeners.add(callback); const remove = this.ledger.subscribe(callback); return () => { this.listeners.delete(callback); remove() } }
  getRevision = () => this.revision + this.ledger.getRevision()
  draft(scope: string, orderId: string) { return scope === this.scope ? structuredClone(this.drafts.get(orderId) ?? emptyMaterialIntakeDraft()) : emptyMaterialIntakeDraft() }
  saveDraft(scope: string, orderId: string, draft: MaterialIntakeDraft) { if (scope !== this.scope || this.ledger.get(scope, orderId)) return blocked('Avvalgi ishlab chiqarish amali hal qilinmaguncha tanlov o‘zgartirilmaydi.'); this.drafts.set(orderId, structuredClone(draft)); this.revision++; for (const callback of this.listeners) callback() }
  get(scope: string, orderId: string): ProductionOperation<MaterialIntakeCommand, MaterialIntakeProof> | null { return this.ledger.get(scope, orderId, 'material-intake') }
  begin(scope: string, plan: MaterialIntakeCommand, recovery = false) { if (plan.authScope !== scope) return blocked('Sessiya doirasi o‘zgargan.'); return this.ledger.begin(scope, { channel: 'material-intake', orderId: plan.orderId, plan, proof: materialIntakeProof(plan) }, recovery) }
  finish(lease: ProductionOperationLease, outcome: { confirmed: true } | { error: string; uncertain: boolean }) { this.ledger.finish(lease, outcome) }
  interrupt(lease: ProductionOperationLease) { this.ledger.interrupt(lease) }
}
export const materialIntakeAttempts = new MaterialIntakeAttemptRegistry(productionOperationLedger)
