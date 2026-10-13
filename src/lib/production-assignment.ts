import { ApiClient, ApiError, isRecord } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { factoryMapApparatus, productionQueueDisplayStatus } from './factory-map'
import { isCanonicalApparatusId, productionMapFromRow } from './production-map'
import type { ProductionMapDefinition, ProductionMapNode } from './production-map'
import { productionCanManageOrders, productionCanManageQueue, productionOrderPolicy } from './production-controls'
import { ProductionOperationLedger, productionOperationLedger } from './production-operation-ledger'
import type { ProductionOperationLease } from './production-operation-ledger'

const base = '/v1/mobile/admin/production-maps'
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const object = (value: unknown): Row => isRecord(value) ? value : {}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const effectiveId = (node: ProductionMapNode) => string(node.alternative_assigned_apparatus_id) || string(node.apparatus_id)
const laneId = (node: ProductionMapNode) => string(node.alternative_group_id) ? `group:${node.alternative_group_id}` : `node:${node.id}`
const liveOrderStates = new Set(['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'waiting_next_stage', 'partially_completed'])
const blockingLabels: Record<string, string> = {
  raw_material_assignment_required: 'Boshlash uchun xomashyo biriktirish kerak.', waiting_previous_stage: 'Oldingi bosqichdan WIP kutilmoqda.', waiting_opening_wip: 'Boshlang‘ich WIP tasdiqlanishi kutilmoqda.',
  previous_stage_not_configured: 'Oldingi bosqich sozlanmagan; ish xaritasini tekshiring.', apparatus_busy: 'Uskunada boshqa ish bor.', print_preflight_in_progress: 'Rang sinovi yakuni kutilmoqda.',
  print_preflight_other_order_active: 'Uskunada boshqa buyurtmaning rang sinovi davom etmoqda.',
}
function stable(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize) : isRecord(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, normalize(entry[key])])) : entry
  return JSON.stringify(normalize(value))
}
export type ProductionAssignmentAction = 'assign' | 'transfer' | 'start' | 'handoff' | 'hold' | 'preflight_passed' | 'preflight_failed' | 'preflight_cancel'
export const productionAssignmentLabels: Record<ProductionAssignmentAction, string> = {
  assign: 'Uskunani almashtirish', transfer: 'To‘xtatilgan ishni ko‘chirish', start: 'Ishni boshlash', handoff: 'Ishni topshirish',
  hold: 'Rang sinovini boshlash', preflight_passed: 'Rang sinovi o‘tdi', preflight_failed: 'Rang sinovi o‘tmadi', preflight_cancel: 'Rang sinovini bekor qilish',
}
export class ProductionAssignmentError extends Error {
  readonly kind: 'blocked' | 'conflict' | 'forbidden' | 'uncertain'
  readonly snapshot?: ProductionSnapshot
  constructor(kind: ProductionAssignmentError['kind'], message: string, snapshot?: ProductionSnapshot) { super(message); this.name = 'ProductionAssignmentError'; this.kind = kind; this.snapshot = snapshot }
}
function blocked(message: string): never { throw new ProductionAssignmentError('blocked', message) }
function canonicalRow(row: Row | undefined, expected: string): Row | null {
  if (!row) return null
  const projection = row.runtime_projection ? object(row.runtime_projection) : row
  return projection.apparatus_id === expected && isCanonicalApparatusId(expected) && integer(projection.source_revision) && projection.source_revision > 0 && object(projection.lifecycle).state === 'active' &&
    ['print', 'laminate', 'cut', 'package', 'glue'].includes(string(object(projection.execution_profile).operation)) ? projection : null
}
function compatible(source: Row, target: Row): boolean {
  const from = object(source.execution_profile), to = object(target.execution_profile)
  const operation = string(from.operation), level = object(source.capabilities)[operation], targetLevel = object(target.capabilities)[operation]
  return ['print', 'laminate', 'cut', 'package', 'glue'].includes(operation) && from.capability_compatible_reroute === true && to.capability_compatible_reroute === true && to.operation === operation &&
    (operation === 'print' || string(from.technology) !== '' && from.technology === to.technology) && integer(level) && level > 0 && integer(targetLevel) && targetLevel >= level
}
function sourceLane(map: ProductionMapDefinition, apparatus: string): ProductionMapNode[] | null {
  const nodes = map.nodes.filter(node => node.kind === 'apparatus' && effectiveId(node) === apparatus)
  return nodes.length && new Set(nodes.map(laneId)).size === 1 ? nodes : null
}
function validInteraction(value: Row): boolean {
  return ['hidden', 'scan_required'].includes(string(value.start_materials_mode)) && ['not_required', 'scan_required', 'waiting'].includes(string(value.previous_wip_mode)) &&
    ['not_required', 'scan_required', 'waiting'].includes(string(value.opening_wip_mode)) && ['not_required', 'scan_required'].includes(string(value.qolip_mode)) &&
    typeof value.material_scan_required === 'boolean' && typeof value.assigned_materials_display_only === 'boolean' && typeof value.material_intake_allowed === 'boolean' && typeof value.resume_input_required === 'boolean' &&
    (value.start_materials_mode === 'scan_required') === value.material_scan_required
}
export interface ProductionAssignmentPolicy {
  apparatusId: string
  name: string
  stageNodeId: string
  stageTitle: string
  operation: string
  state: string
  statusLabel: string
  control: Row
  actions: ProductionAssignmentAction[]
  targets: { id: string; name: string }[]
  transferTargets: { id: string; name: string }[]
  reason: string
}
export function productionAssignmentPolicies(snapshot: ProductionSnapshot | undefined, orderId: string, session: Session | null, apparatusRows: readonly Row[] = []): ProductionAssignmentPolicy[] {
  if (!snapshot || !orderId || !snapshot.maps.some(saved => saved.map.id === orderId) || !isRecord(snapshot.queue_action_controls) || !isRecord(snapshot.queue_states)) return []
  const order = productionOrderPolicy(snapshot, orderId, session)
  const saved = snapshot.maps.find(value => value.map.id === orderId)!
  let map: ProductionMapDefinition
  try { map = productionMapFromRow(saved.map) } catch { return [] }
  const controls = Object.entries(snapshot.queue_action_controls).filter(([id, entries]) => isCanonicalApparatusId(id) && isRecord(entries?.[orderId]))
  const catalogCounts = new Map<string, number>()
  for (const row of apparatusRows) { const id = factoryMapApparatus(row).id; catalogCounts.set(id, (catalogCounts.get(id) ?? 0) + 1) }
  return controls.map(([apparatusId, entries]) => {
    const control = entries[orderId], interaction = object(control.interaction), nodeId = string(control.stage_node_id), node = map.nodes.find(value => value.id === nodeId)
    const metadata = apparatusRows.filter(row => factoryMapApparatus(row).id === apparatusId)
    const projection = metadata.length === 1 ? canonicalRow(metadata[0], apparatusId) : null
    const rawState = Object.hasOwn(object(snapshot.queue_states[apparatusId]), orderId) ? snapshot.queue_states[apparatusId][orderId] : string(control.state)
    const display = productionQueueDisplayStatus(rawState, control, order.state, order.lifecycle)
    const activeOrder = order.state === 'active' && !order.earlyClose && ['released', 'in_progress'].includes(order.lifecycle) && liveOrderStates.has(order.operational)
    const stageMatches = Boolean(node?.kind === 'apparatus' && (effectiveId(node) === apparatusId || string(node.alternative_group_id) && node.apparatus_id === apparatusId))
    const valid = Boolean(activeOrder && stageMatches && display !== 'unknown' && validInteraction(interaction) && projection && control.state === rawState)
    const result: ProductionAssignmentPolicy = { apparatusId, name: projection ? string(object(projection.display).display_name) || apparatusId : apparatusId, stageNodeId: nodeId,
      stageTitle: string(node?.alternative_group_label) || string(node?.title) || nodeId, operation: string(object(projection?.execution_profile).operation), state: rawState,
      statusLabel: display === 'unknown' ? 'Holat noma’lum' : rawState === 'pending' ? 'Navbatda' : rawState === 'in_progress' ? 'Jarayonda' : rawState === 'paused' ? 'To‘xtatilgan' : rawState === 'print_preflight' ? 'Rang sinovi' : rawState,
      control, actions: [], targets: [], transferTargets: [], reason: !valid ? order.state === 'frozen' ? 'Buyurtma muzlatilgan. Boshlash, topshirish va uskuna almashtirish amallari yopiq.' :
        order.state === 'freeze_requested' ? 'Buyurtmani muzlatish so‘rovi kutilmoqda.' : order.earlyClose ? 'Buyurtmani erta yopish holati boshqarilmoqda.' : 'Bosqich, server ruxsatlari yoki uskuna ma’lumotlari to‘liq va mos olinmadi.' : '' }
    if (!valid) return result
    const allowed = Array.isArray(control.allowed_actions) ? control.allowed_actions : []
    if (productionCanManageQueue(session)) {
      if (allowed.includes('start') && interaction.mode === 'fresh_start' && !string(interaction.blocking_reason_code) &&
        interaction.previous_wip_mode !== 'waiting' && interaction.opening_wip_mode !== 'waiting') result.actions.push('start')
      const activity = object(control.work_activity)
      if (result.operation === 'laminate' && rawState === 'in_progress' && allowed.includes('pause') && interaction.mode === 'in_progress' && activity.state === 'in_progress' && string(activity.worker_role) && string(activity.worker_ref)) result.actions.push('handoff')
      const hold = object(control.print_preflight)
      if (result.operation === 'print' && rawState === 'pending' && control.print_preflight_allowed === true && !control.print_preflight) result.actions.push('hold')
      if (result.operation === 'print' && rawState === 'print_preflight' && ['held', 'running'].includes(string(hold.status)) && hold.order_id === orderId && hold.apparatus === apparatusId && hold.stage_node_id === nodeId && string(hold.hold_id)) {
        if (hold.status === 'running') result.actions.push('preflight_passed')
        result.actions.push('preflight_failed', 'preflight_cancel')
      }
    }
    const lane = sourceLane(map, apparatusId)
    if (productionCanManageOrders(session) && lane && !control.print_preflight) {
      const group = string(lane[0].alternative_group_id)
      for (const row of apparatusRows) {
        const id = factoryMapApparatus(row).id, target = canonicalRow(row, id)
        if (!target || catalogCounts.get(id) !== 1 || id === apparatusId || !compatible(projection!, target)) continue
        const inGroup = !group || map.nodes.some(value => value.kind === 'apparatus' && value.alternative_group_id === group && value.apparatus_id === id)
        const targetName = string(object(target.display).display_name) || id
        if (inGroup) result.targets.push({ id, name: targetName })
        const transferInGroup = !group || map.nodes.some(value => value.kind === 'apparatus' && value.alternative_group_id === group && effectiveId(value) === id)
        if (transferInGroup && !Object.hasOwn(object(snapshot.queue_states[id]), orderId)) result.transferTargets.push({ id, name: targetName })
      }
      if (rawState === 'pending' && ['fresh_start', 'fresh_start_blocked', 'waiting_previous_stage'].includes(string(interaction.mode)) && result.targets.length) result.actions.push('assign')
      if (rawState === 'paused' && interaction.mode === 'paused' && result.transferTargets.length) result.actions.push('transfer')
    }
    if (!lane && productionCanManageOrders(session)) result.reason = 'Bu uskuna buyurtmada bir nechta bosqichda takrorlangan. Native almashtirish amali aniq bosqichni qabul qilmaydi.'
    else if (!result.actions.length && string(interaction.blocking_reason_code)) result.reason = blockingLabels[string(interaction.blocking_reason_code)] || 'Server bu bosqichda ish boshlashga ruxsat bermagan. Joriy holatni yangilang.'
    return result
  })
}

export interface ProductionAssignmentInput {
  targetId?: string
  reason?: string
  materialBarcodes?: string[]
  qolipCodes?: string[]
  batchId?: string
  qr?: string
  printLeftover?: string
  filmLeftover?: string
  totalWaste?: string
}
export interface ProductionAssignmentCommand {
  action: ProductionAssignmentAction
  orderId: string
  apparatusId: string
  stageNodeId: string
  targetId: string
  epoch: string
  scope: string
  rev: number
  fingerprint: string
  sourceRevision: number
  targetRevision: number
  map: ProductionMapDefinition
  policy: ProductionAssignmentPolicy
  body: Row
  input: ProductionAssignmentInput
  replayable: boolean
  actor: { role: string; ref: string }
}
function codes(values: readonly string[] | undefined): string[] {
  const result = values?.map(value => value.trim()).filter(Boolean) ?? []
  if (result.length > 100 || result.some(value => value.length > 2000) || new Set(result.map(value => value.toUpperCase())).size !== result.length) return blocked('Skan kodlari noto‘g‘ri yoki takrorlangan.')
  return result
}
function nonNegative(value: string | undefined, label: string): number {
  const number = value?.trim() ? Number(value.replace(',', '.')) : NaN
  if (!Number.isFinite(number) || number < 0) return blocked(`${label}: nol yoki musbat haqiqiy miqdorni kiriting.`)
  return number
}
function fingerprint(snapshot: ProductionSnapshot, orderId: string, apparatusId: string, targetId: string): string {
  return stable([snapshot.maps.find(saved => saved.map.id === orderId)?.map, snapshot.order_statuses[orderId], snapshot.order_controls[orderId] ?? null,
    snapshot.queue_states[apparatusId]?.[orderId] ?? null, snapshot.queue_action_controls[apparatusId]?.[orderId], targetId ? snapshot.queue_states[targetId]?.[orderId] ?? null : null])
}
export function productionAssignmentCommand(snapshot: ProductionSnapshot, orderId: string, session: Session | null, apparatusRows: readonly Row[], apparatusId: string, action: ProductionAssignmentAction, input: ProductionAssignmentInput = {}, commandKey: string = crypto.randomUUID()): ProductionAssignmentCommand {
  const policy = productionAssignmentPolicies(snapshot, orderId, session, apparatusRows).find(value => value.apparatusId === apparatusId)
  if (!policy?.actions.includes(action) || !string(snapshot.epoch) || typeof snapshot.scope !== 'string' || !integer(snapshot.rev)) return blocked('Server bu bosqichdagi amalni ruxsat qilmagan yoki holat noma’lum.')
  const targetId = string(input.targetId), body: Row = { apparatus: apparatusId, order_id: orderId, include_control: true }
  const interaction = object(policy.control.interaction)
  if (action === 'assign' || action === 'transfer') {
    if (!(action === 'assign' ? policy.targets : policy.transferTargets).some(target => target.id === targetId)) return blocked('Mos uskuna nomzodini ro‘yxatdan tanlang.')
    for (const field of Object.keys(body)) delete body[field]
    Object.assign(body, action === 'assign' ? { map_id: orderId, from_apparatus: apparatusId, to_apparatus: targetId } : { order_id: orderId, from_apparatus: apparatusId, to_apparatus: targetId })
    if (action === 'transfer') {
      const reason = string(input.reason)
      if (!reason || Array.from(reason).length > 2000) return blocked('Ko‘chirish sababini yozing (2000 belgigacha).')
      body.reason = reason; body.idempotency_key = `web-transfer:${commandKey}`
    }
  } else if (action === 'start') {
    body.action = 'start'
    const materials = codes(input.materialBarcodes), qolips = codes(input.qolipCodes), batch = string(input.batchId), qr = string(input.qr)
    if (interaction.material_scan_required === true && !materials.length) return blocked('Server xomashyo shtrixkodlarini talab qilmoqda.')
    if (interaction.qolip_mode === 'scan_required' && !qolips.length) return blocked('Server qolip kodlarini talab qilmoqda.')
    const inputRequired = interaction.previous_wip_mode === 'scan_required' || interaction.opening_wip_mode === 'scan_required'
    if (inputRequired && !batch && !qr) return blocked('Kirish WIP QR kodi yoki partiya identifikatori kerak.')
    if (interaction.opening_wip_mode === 'scan_required' && !qr) return blocked('Boshlang‘ich WIPning asl QR kodi kerak.')
    if (qr.length > 8192 || batch.length > 512) return blocked('WIP kodi uzunligi noto‘g‘ri.')
    if (materials.length) body.material_barcodes = materials
    if (qolips.length) body.qolip_codes = qolips
    if (batch) body.progress_batch_id = batch
    if (qr) body.qr_payload = qr
    const hold = object(policy.control.print_preflight)
    if (hold.status === 'passed') body.print_preflight_hold_id = hold.hold_id
  } else if (action === 'handoff') {
    if (!string(input.batchId)) return blocked('Uskunaga ulangan kirish WIP partiyasi kerak.')
    if (Array.from(string(input.reason)).length > 2000) return blocked('Topshirish izohi 2000 belgidan oshmasligi kerak.')
    Object.assign(body, { action: 'pause', worker_handoff: true, print_transport: 'offline',
      lamination_print_leftover_rolls: nonNegative(input.printLeftover, 'Bosma qoldiq rulonlari'), lamination_film_leftover_rolls: nonNegative(input.filmLeftover, 'Plyonka qoldiq rulonlari'), total_waste: nonNegative(input.totalWaste, 'Umumiy chiqindi, kg') })
    if (string(input.reason)) body.description = string(input.reason)
  } else {
    body.action = action === 'hold' ? 'hold' : action.replace('preflight_', '')
    if (action === 'hold') { body.hold_id = `web-preflight:${commandKey}`; body.idempotency_key = `web-preflight-command:${commandKey}` }
    else body.hold_id = object(policy.control.print_preflight).hold_id
  }
  const map = productionMapFromRow(snapshot.maps.find(saved => saved.map.id === orderId)!.map)
  return { action, orderId, apparatusId, stageNodeId: policy.stageNodeId, targetId, epoch: snapshot.epoch, scope: snapshot.scope, rev: snapshot.rev,
    fingerprint: fingerprint(snapshot, orderId, apparatusId, targetId), sourceRevision: factoryMapApparatus(apparatusRows.find(row => factoryMapApparatus(row).id === apparatusId)!).revision,
    targetRevision: targetId ? factoryMapApparatus(apparatusRows.find(row => factoryMapApparatus(row).id === targetId)!).revision : 0,
    map, policy, body, input: structuredClone(input), replayable: action === 'transfer' || action === 'hold' || action.startsWith('preflight_'),
    actor: { role: string(session?.profile.role), ref: string(session?.profile.ref) } }
}
export interface ProductionAssignmentProof { summary: string[]; sessionId: string; batchId: string }
export interface ProductionAssignmentAttempt {
  plan: ProductionAssignmentCommand
  proof: ProductionAssignmentProof
  phase: 'pending' | 'uncertain'
  dispatched: boolean
  serial: number
  error?: string
}
export type ProductionAssignmentAttemptLease = ProductionOperationLease
/** RAM only. Unresolved writes lock their order; credentials and clients are never retained. */
export class ProductionAssignmentAttemptRegistry {
  private ledger: ProductionOperationLedger
  constructor(ledger = new ProductionOperationLedger()) { this.ledger = ledger }
  activate(scope: string): void { this.ledger.activate(scope) }
  subscribe = (listener: () => void): (() => void) => this.ledger.subscribe(listener)
  getRevision = (): number => this.ledger.getRevision()
  get(scope: string, orderId: string): ProductionAssignmentAttempt | null {
    return this.ledger.get<ProductionAssignmentCommand, ProductionAssignmentProof>(scope, orderId, 'assignment')
  }
  begin(scope: string, plan: ProductionAssignmentCommand, proof: ProductionAssignmentProof, recovery = false): ProductionAssignmentAttemptLease {
    return this.ledger.begin(scope, { channel: 'assignment', orderId: plan.orderId, plan, proof }, recovery)
  }
  dispatched(lease: ProductionAssignmentAttemptLease): boolean { return this.ledger.dispatched(lease) }
  finish(lease: ProductionAssignmentAttemptLease, outcome: { confirmed: true } | { error: string; uncertain: boolean }): void {
    this.ledger.finish(lease, outcome)
  }
  interrupt(lease: ProductionAssignmentAttemptLease): void { this.ledger.interrupt(lease) }
}
export const productionAssignmentAttempts = new ProductionAssignmentAttemptRegistry(productionOperationLedger)
const invalid = (message: string): never => { throw new ApiError(502, 'invalid_response', message) }
function current(signal: AbortSignal, isCurrent: () => boolean) { if (signal.aborted || !isCurrent()) throw new DOMException('Interrupted', 'AbortError') }
/** All validation POSTs below are semantic reads. They never claim or move stock. */
export async function checkProductionAssignmentInputs(client: ApiClient, plan: ProductionAssignmentCommand, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<ProductionAssignmentProof> {
  current(signal, isCurrent)
  const summary: string[] = [], interaction = object(plan.policy.control.interaction)
  const read = async (path: string, body: Row) => { current(signal, isCurrent); const result = object(await client.request(path, 'POST', { body, signal })); current(signal, isCurrent); return result }
  let sessionId = '', batchId = ''
  if (plan.action === 'start' && interaction.material_scan_required === true) {
    const result = object(await client.get('/v1/mobile/admin/raw-material-start-requirements', { order_id: plan.orderId, apparatus: plan.apparatusId, material_barcodes: (plan.body.material_barcodes as string[]).join(',') }, signal))
    current(signal, isCurrent)
    if (typeof result.requires_material !== 'boolean' || typeof result.material_scan_required !== 'boolean' || typeof result.assignments_satisfied !== 'boolean' || typeof result.scan_satisfied !== 'boolean' || !integer(result.required_scan_count) || !integer(result.matched_scan_count) ||
      !Array.isArray(result.eligible_barcodes) || !result.eligible_barcodes.every(value => typeof value === 'string' && Boolean(value.trim())) || result.scan_satisfied && result.matched_scan_count < result.required_scan_count) return invalid('Xomashyo tayyorligi to‘liq va mos shaklda kelmadi.')
    if (!result.material_scan_required || !result.assignments_satisfied || !result.scan_satisfied) return blocked('Server xomashyo biriktirish yoki skanlash talabini tasdiqlamadi.')
    summary.push(`Xomashyo skanlari: ${result.matched_scan_count} / ${result.required_scan_count}`)
  }
  if (plan.action === 'start' && interaction.qolip_mode === 'scan_required') {
    const checked = new Set<string>(); let required: string[] | null = null
    for (const code of plan.body.qolip_codes as string[]) {
      const payload = await read(`${base}/qolip-validate`, { apparatus: plan.apparatusId, order_id: plan.orderId, qolip_code: code }), qolip = object(payload.qolip)
      if (payload.ok !== true || !string(qolip.qolip_code) || !Array.isArray(qolip.required_qolip_codes) || !qolip.required_qolip_codes.every(value => typeof value === 'string' && Boolean(value.trim())) || !integer(qolip.required_qolip_count) || qolip.required_qolip_count !== qolip.required_qolip_codes.length) return invalid('Qolip tekshiruvi to‘liq shaklda kelmadi.')
      const next = (qolip.required_qolip_codes as string[]).map(value => value.trim().toLowerCase()).sort()
      if (new Set(next).size !== next.length || required && JSON.stringify(next) !== JSON.stringify(required)) return invalid('Qoliplar to‘plami tekshiruv davomida o‘zgardi.')
      required = next; checked.add(string(qolip.qolip_code).toLowerCase())
    }
    if (!required?.length || required.length !== checked.size || required.some(code => !checked.has(code))) return blocked('Buyurtma uchun barcha haqiqiy qoliplar skanlanishi kerak.')
    summary.push(`Qolip tayyorligi: ${checked.size} / ${required.length}`)
  }
  if (plan.action === 'start' && (interaction.previous_wip_mode === 'scan_required' || interaction.opening_wip_mode === 'scan_required')) {
    const opening = interaction.opening_wip_mode === 'scan_required'
    const body = opening ? { apparatus: plan.apparatusId, order_id: plan.orderId, batch_id: string(plan.input.batchId), qr_payload: string(plan.input.qr) } :
      { apparatus: plan.apparatusId, order_id: plan.orderId, progress_batch_id: string(plan.input.batchId), qr_payload: string(plan.input.qr), require_active_order: true }
    const result = await read(`${base}/${opening ? 'opening-wip/lookup' : 'progress-qr/lookup'}`, body), batch = object(result.batch)
    if (result.ok !== true || batch.order_id !== plan.orderId || !string(batch.batch_id) || batch.wip_status !== 'waiting' || string(plan.input.batchId) && batch.batch_id !== string(plan.input.batchId) ||
      string(plan.input.qr) && string(batch.qr_payload) !== string(plan.input.qr) || !opening && (result.validated_apparatus !== plan.apparatusId || result.validated_order_id !== plan.orderId || result.active_order_validated !== true)) return invalid('Kirish WIP tanlangan buyurtma va uskunaga tasdiqlanmadi.')
    batchId = string(batch.batch_id); summary.push(opening ? 'Boshlang‘ich WIP QR tasdiqlandi' : 'Oldingi bosqich WIPsi tasdiqlandi')
  }
  if (plan.action === 'handoff' || plan.action === 'transfer') {
    const requestedBatch = string(plan.input.batchId)
    if (!requestedBatch) return blocked('Shu ishning haqiqiy WIP partiyasini kiriting.')
    const report = await read(`${base}/progress-qr/report`, { progress_batch_id: requestedBatch }), batch = object(report.scanned_batch)
    if (report.ok !== true || report.history_scope !== 'batch_lineage' || batch.batch_id !== requestedBatch || batch.order_id !== plan.orderId || !Array.isArray(report.active_sessions)) return invalid('Ishning WIP hisoboti tanlangan partiyaga mos kelmadi.')
    const sessions = report.active_sessions.filter(isRecord).filter(value => value.order_id === plan.orderId && value.apparatus === plan.apparatusId && value.stage_node_id === plan.stageNodeId)
    if (sessions.length !== 1 || !string(sessions[0].session_id)) return blocked('Aynan shu uskuna va bosqichning faol sessiyasi tasdiqlanmadi.')
    const session = sessions[0], activity = object(plan.policy.control.work_activity)
    if (string(activity.worker_role) && (session.worker_role !== activity.worker_role || session.worker_ref !== activity.worker_ref)) return blocked('Ishni bajarayotgan operator o‘zgargan. Holatni yangilang.')
    if (plan.action === 'handoff') {
      const mounted = object(session.payload_json).input_progress_batch_id === requestedBatch
      if (session.status !== 'active' || batch.wip_status !== 'in_use' || (string(batch.used_by_apparatus) || string(batch.current_apparatus)) !== plan.apparatusId ||
        string(batch.used_by_session_id) && batch.used_by_session_id !== session.session_id || !mounted) return blocked('Bu WIP tanlangan ishning uskunaga ulangan kirish ruloni emas.')
    } else if (session.status !== 'paused' || batch.session_id !== session.session_id || batch.apparatus !== plan.apparatusId || batch.status !== 'paused' || batch.action !== 'pause' || batch.wip_status !== 'waiting') return blocked('Ko‘chirish uchun aynan shu to‘xtatilgan sessiyaning hali ishlatilmagan pauza WIPsi kerak.')
    sessionId = string(session.session_id); batchId = requestedBatch
    summary.push(plan.action === 'handoff' ? 'Ulangan kirish WIP va joriy operator tasdiqlandi' : 'To‘xtatilgan sessiya va unga tegishli WIP tasdiqlandi')
  }
  return { summary, sessionId, batchId }
}

function mapReceiptValid(value: unknown, plan: ProductionAssignmentCommand): boolean {
  const saved = object(value), map = object(saved.map)
  if (map.id !== plan.orderId || !Array.isArray(map.nodes) || !Array.isArray(map.edges) || map.nodes.length !== plan.map.nodes.length || stable(map.edges) !== stable(plan.map.edges)) return false
  const lane = sourceLane(plan.map, plan.apparatusId); if (!lane) return false
  const group = string(lane[0].alternative_group_id)
  const changedIds = new Set((group ? plan.map.nodes.filter(node => node.kind === 'apparatus' && node.alternative_group_id === group) : lane).map(node => node.id))
  return plan.map.nodes.every(before => {
    const matches = (map.nodes as unknown[]).filter(isRecord).filter(after => after.id === before.id)
    if (matches.length !== 1) return false
    const after = matches[0]
    if (!changedIds.has(before.id)) return stable(after) === stable(before)
    if (group ? after.alternative_assigned_apparatus_id !== plan.targetId || after.apparatus_id !== before.apparatus_id : after.apparatus_id !== plan.targetId) return false
    const fields = group ? ['alternative_assigned_apparatus_id', 'alternative_assigned_title'] : ['apparatus_id', 'title']
    const strip = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)))
    return stable(strip(after)) === stable(strip(before))
  })
}
function receiptValid(value: unknown, plan: ProductionAssignmentCommand, proof: ProductionAssignmentProof, minimumRevision: number): boolean {
  const result = object(value)
  if (result.ok !== true) return false
  if (plan.action === 'assign') return mapReceiptValid(result.saved, plan)
  if (plan.action === 'transfer') return result.transfer_id === `apparatus-transfer:${plan.body.idempotency_key}` && result.queue_state === 'paused' && result.session_id === proof.sessionId && result.progress_batch_id === proof.batchId && mapReceiptValid(result.saved, plan)
  if (plan.action === 'hold' || plan.action.startsWith('preflight_')) {
    const hold = object(result.hold), expected = plan.action === 'preflight_passed' ? 'passed' : plan.action === 'preflight_failed' ? 'failed' : 'cancelled'
    return hold.hold_id === plan.body.hold_id && hold.order_id === plan.orderId && hold.apparatus === plan.apparatusId && hold.stage_node_id === plan.stageNodeId &&
      (plan.action === 'hold' ? hold.idempotency_key === plan.body.idempotency_key && ['running', 'passed', 'failed', 'cancelled', 'consumed'].includes(string(hold.status)) : hold.status === expected)
  }
  const session = object(result.session), payload = object(session.payload_json), targetState = plan.action === 'start' ? 'in_progress' : 'paused'
  const kind = object(plan.policy.control.interaction).opening_wip_mode === 'scan_required' ? 'opening_wip' : 'progress_batch'
  if (plan.action === 'start' && proof.batchId && (payload.input_progress_batch_id !== proof.batchId || payload.input_wip_source_kind !== kind)) return false
  if (plan.action === 'handoff' && (session.session_id !== proof.sessionId || payload.worker_handoff !== true || payload.roll_removed_from_apparatus !== false ||
    payload.input_progress_batch_id !== proof.batchId || payload.input_wip_source_kind !== 'progress_batch' || payload.total_waste_uom !== 'kg' ||
    ['lamination_print_leftover_rolls', 'lamination_film_leftover_rolls', 'total_waste'].some(field => payload[field] !== plan.body[field]) || payload.description !== string(plan.body.description))) return false
  return result.epoch === plan.epoch && integer(result.rev) && result.rev >= minimumRevision && object(result.states)[plan.orderId] === targetState && session.order_id === plan.orderId && session.apparatus === plan.apparatusId && session.stage_node_id === plan.stageNodeId &&
    string(session.session_id) !== '' && session.status === (plan.action === 'start' ? 'active' : 'paused')
}
export interface ProductionAssignmentResult { snapshot?: ProductionSnapshot; message: string; proof: ProductionAssignmentProof }
function scopedSnapshot(snapshot: ProductionSnapshot, plan: ProductionAssignmentCommand, minimumRevision = plan.rev): boolean {
  return snapshot.epoch === plan.epoch && snapshot.scope === plan.scope && snapshot.rev >= minimumRevision
}
function currentLane(snapshot: ProductionSnapshot, plan: ProductionAssignmentCommand, state: string): Row | null {
  const control = object(snapshot.queue_action_controls[plan.apparatusId]?.[plan.orderId])
  return control.stage_node_id === plan.stageNodeId && control.state === state && snapshot.queue_states[plan.apparatusId]?.[plan.orderId] === state ? control : null
}
/** Explicit observation only. This never replays an unkeyed mutation or claims a missing report receipt. */
export async function readProductionAssignmentOutcome(client: ApiClient, session: Session | null, plan: ProductionAssignmentCommand, proof: ProductionAssignmentProof, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<ProductionAssignmentResult | null> {
  current(signal, isCurrent)
  if (session?.profile.role !== plan.actor.role || string(session?.profile.ref) !== plan.actor.ref || !(['assign', 'transfer'].includes(plan.action) ? productionCanManageOrders(session) : productionCanManageQueue(session))) throw new ProductionAssignmentError('forbidden', 'Avvalgi amal aynan shu sessiya ruxsatlari bilan tekshirilishi kerak.')
  const snapshot = await client.productionSnapshot(signal); current(signal, isCurrent)
  if (!scopedSnapshot(snapshot, plan) || snapshot.rev <= plan.rev) return null
  if (plan.action === 'assign') {
    if (!mapReceiptValid(snapshot.maps.find(value => value.map.id === plan.orderId), plan)) return null
    return { snapshot, proof, message: 'Joriy server xaritasida tanlangan uskuna biriktirishi tasdiqlandi. Amal qayta yuborilmadi.' }
  }
  if (plan.action.startsWith('preflight_')) {
    const hold = object(snapshot.queue_action_controls[plan.apparatusId]?.[plan.orderId]?.print_preflight)
    if (!receiptValid({ ok: true, hold }, plan, proof, snapshot.rev)) return null
    return { snapshot, proof, message: 'Aynan shu rang sinovining natijasi joriy server holatida tasdiqlandi.' }
  }
  if (plan.action !== 'start') return null
  const lane = currentLane(snapshot, plan, 'in_progress'), activity = object(lane?.work_activity)
  if (!lane || activity.state !== 'in_progress' || !plan.actor.role || !plan.actor.ref || activity.worker_role !== plan.actor.role || activity.worker_ref !== plan.actor.ref) return null
  if (proof.batchId) {
    // The normal report is lineage-scoped and cannot prove an opening-WIP input.
    if (object(plan.policy.control.interaction).opening_wip_mode === 'scan_required') return null
    const report = object(await client.request(`${base}/progress-qr/report`, 'POST', { body: { progress_batch_id: proof.batchId }, signal })); current(signal, isCurrent)
    const batch = object(report.scanned_batch)
    if (report.ok !== true || report.history_scope !== 'batch_lineage' || batch.batch_id !== proof.batchId || batch.order_id !== plan.orderId || batch.wip_status !== 'in_use' ||
      (string(batch.used_by_apparatus) || string(batch.current_apparatus)) !== plan.apparatusId || !Array.isArray(report.active_sessions)) return null
    const matches = report.active_sessions.filter(isRecord).filter(value => value.order_id === plan.orderId && value.apparatus === plan.apparatusId && value.stage_node_id === plan.stageNodeId && value.status === 'active' &&
      value.worker_role === plan.actor.role && value.worker_ref === plan.actor.ref && object(value.payload_json).input_progress_batch_id === proof.batchId && object(value.payload_json).input_wip_source_kind === 'progress_batch')
    if (matches.length !== 1 || !string(matches[0].session_id) || batch.used_by_session_id !== matches[0].session_id) return null
  }
  return { snapshot, proof, message: 'Joriy server holatida shu bosqichdagi ish va operator tasdiqlandi. Amal qayta yuborilmadi; alohida material hisob-kitobi bu kuzatuv bilan tasdiqlanmaydi.' }
}
/** No unkeyed write replay. Recovery reuses only native durable hold/transfer identity. */
export async function executeProductionAssignment(client: ApiClient, session: Session | null, plan: ProductionAssignmentCommand, signal: AbortSignal, isCurrent: () => boolean = () => true, recoveryProof?: ProductionAssignmentProof, onDispatch?: () => void): Promise<ProductionAssignmentResult> {
  current(signal, isCurrent)
  const canWrite = ['assign', 'transfer'].includes(plan.action) ? productionCanManageOrders(session) : productionCanManageQueue(session)
  if (!canWrite || string(session?.profile.role) !== plan.actor.role || string(session?.profile.ref) !== plan.actor.ref) throw new ProductionAssignmentError('forbidden', 'Bu amal uchun aynan shu operator va sessiya ruxsati kerak.')
  if (recoveryProof && !plan.replayable) return blocked('Bu amalni ayni buyruq sifatida qayta yuborish native API orqali qo‘llanmagan.')
  const fresh = await client.productionSnapshot(signal); current(signal, isCurrent)
  if (fresh.epoch !== plan.epoch || fresh.scope !== plan.scope || fresh.rev < plan.rev) throw new ProductionAssignmentError('conflict', 'Server yoki sessiya doirasi o‘zgargan. Amal yuborilmadi.', fresh)
  let proof = recoveryProof
  if (!recoveryProof) {
    if (fingerprint(fresh, plan.orderId, plan.apparatusId, plan.targetId) !== plan.fingerprint) throw new ProductionAssignmentError('conflict', 'Buyurtma, bosqich yoki navbat o‘zgargan. Amalni yangilab qayta ko‘rib chiqing.', fresh)
    const rows = [await client.detail('apparatus', { apparatus_id: plan.apparatusId }, signal)]
    if (plan.targetId) rows.push(await client.detail('apparatus', { apparatus_id: plan.targetId }, signal))
    current(signal, isCurrent)
    if (factoryMapApparatus(rows[0]).revision !== plan.sourceRevision || plan.targetId && factoryMapApparatus(rows[1]).revision !== plan.targetRevision ||
      !productionAssignmentPolicies(fresh, plan.orderId, session, rows).find(value => value.apparatusId === plan.apparatusId)?.actions.includes(plan.action)) throw new ProductionAssignmentError('conflict', 'Uskuna sozlamalari yoki server ruxsatlari o‘zgargan. Amal yuborilmadi.', fresh)
    proof = await checkProductionAssignmentInputs(client, plan, signal, isCurrent)
  }
  current(signal, isCurrent)
  const path = plan.action === 'assign' ? `${base}/move` : plan.action === 'transfer' ? `${base}/apparatus-transfer` : plan.action === 'hold' || plan.action.startsWith('preflight_') ? `${base}/print-preflight` : `${base}/queue-action`
  let response: unknown, writeError: unknown
  onDispatch?.(); current(signal, isCurrent)
  try { response = await client.request(path, 'POST', { body: plan.body, signal }) } catch (error) { writeError = error }
  current(signal, isCurrent)
  // Native fallback material stock updates can fail with 400 after the start was committed.
  if (writeError instanceof ApiError && writeError.status >= 400 && writeError.status < 500 && !(plan.action === 'start' && writeError.status === 400)) throw writeError
  const confirmed = !writeError && receiptValid(response, plan, proof!, fresh.rev)
  let readback: ProductionSnapshot | undefined
  try { readback = await client.productionSnapshot(signal) } catch { /* A valid receipt remains a confirmation. */ }
  current(signal, isCurrent)
  if (readback && (readback.epoch !== plan.epoch || readback.scope !== plan.scope || readback.rev < fresh.rev || integer(object(response).rev) && readback.rev < Number(object(response).rev))) readback = undefined
  if (readback && confirmed) {
    if (['assign', 'transfer'].includes(plan.action) && !mapReceiptValid(readback.maps.find(value => value.map.id === plan.orderId), plan)) readback = undefined
    else if (['start', 'handoff'].includes(plan.action) && !currentLane(readback, plan, plan.action === 'start' ? 'in_progress' : 'paused')) readback = undefined
    else if ((plan.action === 'hold' || plan.action.startsWith('preflight_')) && readback.rev <= fresh.rev) readback = undefined
  }
  if (!confirmed) throw new ProductionAssignmentError('uncertain', plan.replayable ? 'Natija tasdiqlanmadi. Bir xil native buyruq identifikatori saqlandi; natijani qayta tekshirish mumkin.' : 'Natija tasdiqlanmadi. Amal avtomatik qayta yuborilmadi; joriy holatni yangilang va tekshiring.', readback)
  const holdLabels: Record<string, string> = { running: 'davom etmoqda', passed: 'o‘tgan', failed: 'o‘tmagan', cancelled: 'bekor qilingan', consumed: 'ish boshlashda qo‘llangan' }
  return { snapshot: readback, proof: proof!, message: plan.action === 'assign' ? 'Buyurtmaning uskunasi serverda almashtirildi.' : plan.action === 'transfer' ? 'To‘xtatilgan ish, sessiya, WIP va material biriktirish holati ko‘chirildi.' : plan.action === 'start' ? 'Ish serverda boshlanganligi tasdiqlandi.' : plan.action === 'handoff' ? 'Ish topshirildi. Kirish WIP ulangan holda saqlandi.' : `Rang sinovi serverda tasdiqlandi: ${holdLabels[string(object(object(response).hold).status)] ?? 'holati o‘zgargan'}.` }
}
