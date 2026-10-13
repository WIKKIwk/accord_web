import { ApiClient, ApiError, isRecord } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { factoryMapApparatus, factoryMapQueueOrderIds, factoryMapStatuses, productionQueueDisplayStatus } from './factory-map'
import { hasCapability } from './permissions'

const base = '/v1/mobile/admin/production-maps'
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const object = (value: unknown): Row => isRecord(value) ? value : {}
const states = new Set(['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'frozen', 'waiting_next_stage', 'partially_completed', 'completed', 'completed_with_issue'])
const terminal = new Set(['production_completed', 'closed', 'cancelled'])
const versionPattern = /^[a-f0-9]{64}$/
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export type ProductionOrderAction = 'freeze' | 'cancel_freeze' | 'unfreeze' | 'close_early'
export type ProductionQueueAction = 'pause' | 'resume'
export type ProductionControlState = 'active' | 'freeze_requested' | 'frozen' | 'unknown'
export const productionActionLabels: Record<ProductionOrderAction | ProductionQueueAction | 'move_up' | 'move_down', string> = {
  freeze: 'Muzlatish', cancel_freeze: 'Muzlatish so‘rovini bekor qilish', unfreeze: 'Muzlatishni olib tashlash',
  close_early: 'Erta yopish', pause: 'To‘xtatish va hisobot', resume: 'Davom ettirish', move_up: 'Navbatda oldinga', move_down: 'Navbatda orqaga',
}

export function productionControlOrderId(row: Row): string {
  const map = isRecord(row.map) ? row.map : row
  const id = string(map.id)
  return id && (row.id === undefined || row.id === null || row.id === '' || row.id === map.id) ? id : ''
}
export function productionCanManageOrders(session: Session | null): boolean {
  return hasCapability(session, 'admin.access') || hasCapability(session, 'production.map.manage')
}
export function productionCanManageQueue(session: Session | null): boolean {
  return productionCanManageOrders(session) || hasCapability(session, 'apparatus.queue.manage')
}

export function productionOrderControlState(snapshot: ProductionSnapshot, orderId: string): ProductionControlState {
  if (!isRecord(snapshot.order_controls)) return 'unknown'
  if (!Object.hasOwn(snapshot.order_controls, orderId)) return 'active' // Native snapshot publishes sparse overrides.
  const control = snapshot.order_controls[orderId]
  if (!isRecord(control) || control.order_id !== undefined && control.order_id !== orderId) return 'unknown'
  if (control.early_close !== undefined && control.early_close !== null && !isRecord(control.early_close)) return 'unknown'
  const state = string(control.state)
  if (state === 'freeze_requested' && (!isRecord(control.freeze_request) || control.freeze_request.status !== 'pending' || !string(control.freeze_request.request_id) || !string(control.freeze_request.target_apparatus))) return 'unknown'
  return state === 'active' || state === 'freeze_requested' || state === 'frozen' ? state : 'unknown'
}

export interface ProductionOrderPolicy {
  state: ProductionControlState
  lifecycle: string
  operational: string
  actions: ProductionOrderAction[]
  earlyClose: Row | null
  reason: string
}
export function productionOrderPolicy(snapshot: ProductionSnapshot | undefined, orderId: string, session: Session | null): ProductionOrderPolicy {
  const unknown: ProductionOrderPolicy = { state: 'unknown', lifecycle: '', operational: '', actions: [], earlyClose: null, reason: 'Buyurtmaning joriy boshqaruv holati olinmadi.' }
  if (!snapshot || !orderId || !snapshot.maps.some(saved => saved.map.id === orderId)) return unknown
  const detail = object(snapshot.order_statuses?.[orderId])
  const lifecycle = string(detail.lifecycle_status), operational = string(detail.order_status)
  const state = productionOrderControlState(snapshot, orderId)
  const control = object(snapshot.order_controls?.[orderId])
  const earlyClose = isRecord(control.early_close) ? control.early_close : null
  const result = { state, lifecycle, operational, earlyClose, actions: [] as ProductionOrderAction[], reason: '' }
  if (!productionCanManageOrders(session)) return { ...result, reason: 'Buyurtmani boshqarish uchun ruxsat yo‘q.' }
  if (terminal.has(lifecycle)) return { ...result, reason: 'Tugallangan, yopilgan yoki bekor qilingan buyurtma boshqarilmaydi.' }
  if (!['released', 'in_progress'].includes(lifecycle) || !states.has(operational) || state === 'unknown') return { ...result, reason: unknown.reason }
  if (earlyClose) return { ...result, reason: earlyClose.closed_at_unix ? 'Buyurtma erta yopilgan.' : 'Erta yopish so‘rovi kutilmoqda.' }
  if (['completed', 'completed_with_issue'].includes(operational)) return { ...result, reason: 'Ishlab chiqarish tugallangan.' }
  if (state === 'freeze_requested') result.actions.push('cancel_freeze')
  if (state === 'frozen') result.actions.push('unfreeze')
  if (state === 'active' && ['in_progress', 'print_preflight', 'paused', 'waiting_next_stage', 'partially_completed'].includes(operational)) result.actions.push('freeze')
  result.actions.push('close_early')
  return result
}

export interface ProductionQueuePolicy {
  apparatusId: string
  name: string
  operation: string
  apparatusRevision: number
  rawState: string
  statusLabel: string
  control: Row | null
  stageNodeId: string
  pause: boolean
  resume: boolean
  reason: string
  orderIds: string[]
  position: number
  version: string
  sequenceRevision: number | undefined
  moveUp: boolean
  moveDown: boolean
  frameCount: number
}
export function productionQueuePolicies(snapshot: ProductionSnapshot | undefined, orderId: string, session: Session | null, apparatusRows: readonly Row[] = []): ProductionQueuePolicy[] {
  if (!snapshot || !orderId || !snapshot.maps.some(saved => saved.map.id === orderId)) return []
  const order = productionOrderPolicy(snapshot, orderId, session)
  const keys = new Set([...Object.keys(snapshot.queue_action_controls ?? {}), ...Object.keys(snapshot.queue_states ?? {})])
  return [...keys].filter(id => string(id).startsWith('apparatus:') && (snapshot.queue_action_controls[id]?.[orderId] || snapshot.queue_states[id]?.[orderId])).map(apparatusId => {
    const matches = apparatusRows.map(factoryMapApparatus).filter(item => item.id === apparatusId)
    const apparatus = matches.length === 1 ? matches[0] : undefined
    const projection = apparatus ? object(apparatus.row.runtime_projection || apparatus.row) : {}
    const operation = string(object(projection.execution_profile).operation)
    const control = isRecord(snapshot.queue_action_controls[apparatusId]?.[orderId]) ? snapshot.queue_action_controls[apparatusId][orderId] : null
    const rawState = string(snapshot.queue_states[apparatusId]?.[orderId])
    const status = productionQueueDisplayStatus(rawState || undefined, control ?? undefined, order.state, order.lifecycle)
    const valid = Boolean(control && rawState && status !== 'unknown' && order.state === 'active' && !order.earlyClose && states.has(order.operational) && !['completed', 'completed_with_issue'].includes(order.operational) && !terminal.has(order.lifecycle) && ['released', 'in_progress'].includes(order.lifecycle))
    const allowed = valid && Array.isArray(control!.allowed_actions) ? control!.allowed_actions : []
    const interaction = object(control?.interaction)
    const activeRolls = Array.isArray(control?.rezka_active_partial_rolls) ? control.rezka_active_partial_rolls : []
    const outputCounts = Array.isArray(control?.rezka_output_kadr_counts) ? control.rezka_output_kadr_counts : []
    const frameCount = activeRolls.length || outputCounts.length
    // Native Aparatchi pause without handoff flags becomes DetachRoll. This
    // admin pause/report UI must never promise one action and execute another.
    const pauseActorAllowed = string(session?.profile.role).toLowerCase() !== 'aparatchi'
    const canPause = productionCanManageQueue(session) && pauseActorAllowed && valid && allowed.includes('pause') && rawState === 'in_progress' && Boolean(operation && apparatus?.revision) && (operation !== 'cut' || frameCount > 0 && frameCount <= 128)
    const canResume = productionCanManageQueue(session) && valid && allowed.includes('resume') && typeof interaction.resume_input_required === 'boolean'
    const orderIds = factoryMapQueueOrderIds(snapshot, apparatusId)
    const position = orderIds.indexOf(orderId)
    const version = string(object(snapshot.sequence_versions)[apparatusId])
    const revision = object(snapshot.sequence_revisions)[apparatusId]
    const canMove = productionCanManageOrders(session) && valid && rawState === 'pending' && versionPattern.test(version) && integer(revision) && position >= 0
    const nodes = snapshot.maps.flatMap(saved => Array.isArray(saved.map.nodes) ? saved.map.nodes.filter(isRecord) : [])
    const title = nodes.find(node => node.kind === 'apparatus' && (node.alternative_assigned_apparatus_id || node.apparatus_id) === apparatusId)
    const name = apparatus?.name || string(title?.alternative_assigned_title || title?.title) || apparatusId
    return { apparatusId, name, operation, apparatusRevision: apparatus?.revision ?? 0, rawState,
      statusLabel: factoryMapStatuses[status].label,
      control, stageNodeId: string(control?.stage_node_id), pause: canPause, resume: canResume,
      reason: !valid ? 'Serverning amal ruxsatlari to‘liq yoki mos kelgan holda olinmadi.' : allowed.includes('pause') && !pauseActorAllowed ? 'Bu rol uchun to‘xtatish mobil operator oqimida bajariladi.' : allowed.includes('pause') && !canPause ? 'To‘xtatish hisoboti uchun uskuna ma’lumotlari olinmadi.' : '',
      orderIds, position, version, sequenceRevision: integer(revision) ? revision : undefined, moveUp: canMove && position > 0, moveDown: canMove && position < orderIds.length - 1, frameCount }
  })
}

export interface PauseReport { quantity?: string; uom?: string; description?: string; frames?: { metres: string; grossKg: string; diameter: string; tareKg: string }[] }
export interface ResumeReport { qr?: string; batchId?: string; materialBarcodes?: string[]; qolipCodes?: string[] }
function positive(value: unknown, label: string): number {
  const number = typeof value === 'string' && value.trim() ? Number(value.replace(',', '.')) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(number) || number <= 0) throw new ProductionControlError('blocked', `${label}: noldan katta son kiriting.`)
  return number
}
function codes(values: readonly string[] | undefined): string[] {
  const result = values?.map(value => value.trim()).filter(Boolean) ?? []
  if (result.some(value => value.length > 1000) || result.length > 100 || new Set(result).size !== result.length) throw new ProductionControlError('blocked', 'Skan kodlari takrorlangan yoki noto‘g‘ri.')
  return result
}

export interface ProductionCommand {
  kind: 'order' | 'queue' | 'reorder'
  action: ProductionOrderAction | ProductionQueueAction | 'move_up' | 'move_down'
  orderId: string
  apparatusId: string
  apparatusRevision: number
  epoch: string
  snapshotScope: string
  snapshotRevision: number
  fingerprint: string
  body: Row
}
function orderFingerprint(snapshot: ProductionSnapshot, id: string): string {
  return JSON.stringify([snapshot.order_statuses[id], snapshot.order_controls[id] ?? null])
}
function queueFingerprint(snapshot: ProductionSnapshot, id: string, apparatus: string): string {
  return JSON.stringify([snapshot.order_statuses[id]?.lifecycle_status, snapshot.order_controls[id] ?? null, snapshot.queue_states[apparatus]?.[id], snapshot.queue_action_controls[apparatus]?.[id]])
}
function command(snapshot: ProductionSnapshot, kind: ProductionCommand['kind'], action: ProductionCommand['action'], orderId: string, apparatusId: string, body: Row): ProductionCommand {
  if (!string(snapshot.epoch) || !integer(snapshot.rev)) throw new ProductionControlError('blocked', 'Server holati to‘liq olinmadi.')
  return { kind, action, orderId, apparatusId, apparatusRevision: 0, epoch: snapshot.epoch, snapshotScope: snapshot.scope, snapshotRevision: snapshot.rev,
    fingerprint: apparatusId ? queueFingerprint(snapshot, orderId, apparatusId) : orderFingerprint(snapshot, orderId), body }
}
export function productionOrderCommand(snapshot: ProductionSnapshot, id: string, session: Session | null, action: ProductionOrderAction, comment = ''): ProductionCommand {
  if (!productionOrderPolicy(snapshot, id, session).actions.includes(action)) throw new ProductionControlError('blocked', 'Buyurtmaning hozirgi holatida bu amal mumkin emas.')
  const body: Row = { order_id: id, action }
  if (action === 'close_early') {
    const reason = comment.trim()
    if (!reason || Array.from(reason).length > 2000) throw new ProductionControlError('blocked', 'Erta yopish sababini yozing (2000 belgigacha).')
    body.comment = reason
  }
  return command(snapshot, 'order', action, id, '', body)
}
export function productionQueueCommand(snapshot: ProductionSnapshot, id: string, session: Session | null, apparatusRows: readonly Row[], apparatusId: string, action: ProductionQueueAction, input: PauseReport & ResumeReport): ProductionCommand {
  const policy = productionQueuePolicies(snapshot, id, session, apparatusRows).find(item => item.apparatusId === apparatusId)
  if (!policy || !policy[action]) throw new ProductionControlError('blocked', 'Server bu apparatdagi amalni ruxsat qilmagan yoki holat noma’lum.')
  const body: Row = { apparatus: apparatusId, order_id: id, action, include_control: true }
  if (action === 'pause') {
    if (Array.from(input.description?.trim() ?? '').length > 2000) throw new ProductionControlError('blocked', 'Izoh 2000 belgidan oshmasligi kerak.')
    if (input.description?.trim()) body.description = input.description.trim()
    body.print_transport = 'offline' // Save native WIP; no unsolicited hardware print.
    if (policy.operation === 'cut') {
      if (input.frames?.length !== policy.frameCount) throw new ProductionControlError('blocked', 'Har bir chiqish ruloni uchun hisobot kiriting.')
      body.rezka_frames = input.frames.map((frame, index) => {
        const gross = positive(frame.grossKg, `${index + 1}-rulon og‘irligi`)
        const result: Row = { finished_goods_meter: positive(frame.metres, `${index + 1}-rulon uzunligi`), gross_qty: gross, diameter: positive(frame.diameter, `${index + 1}-rulon diametri`) }
        if (frame.tareKg.trim()) {
          const tare = positive(frame.tareKg, `${index + 1}-rulon bobinasi`)
          if (tare >= gross) throw new ProductionControlError('blocked', 'Bobina og‘irligi rulonning brutto og‘irligidan kichik bo‘lishi kerak.')
          result.bobina_kg = tare
        }
        return result
      })
      const report = object(policy.control?.rezka_output_report)
      if (string(report.cycle_id)) body.rezka_output_cycle = string(report.cycle_id)
    } else {
      body.produced_qty = positive(input.quantity, 'Ishlab chiqarilgan miqdor')
      const uom = input.uom?.trim()
      if (!uom || uom.length > 20) throw new ProductionControlError('blocked', 'Hisobot o‘lchov birligini kiriting.')
      body.uom = uom
    }
  } else {
    const interaction = object(policy.control?.interaction)
    const qr = input.qr?.trim() ?? '', batch = input.batchId?.trim() ?? ''
    if (interaction.resume_input_required === true && !qr && !batch) throw new ProductionControlError('blocked', 'Davom ettirish uchun kirish WIP rulonining QR yoki partiya IDsi kerak.')
    const materials = codes(input.materialBarcodes), qolips = codes(input.qolipCodes)
    if (interaction.material_scan_required === true && !materials.length) throw new ProductionControlError('blocked', 'Server talab qilgan xomashyo kodlarini kiriting.')
    if (interaction.qolip_mode === 'scan_required' && !qolips.length) throw new ProductionControlError('blocked', 'Server talab qilgan qolip kodlarini kiriting.')
    if (qr) body.qr_payload = qr
    if (batch) body.progress_batch_id = batch
    if (materials.length) body.material_barcodes = materials
    if (qolips.length) body.qolip_codes = qolips
  }
  return { ...command(snapshot, 'queue', action, id, apparatusId, body), apparatusRevision: policy.apparatusRevision }
}
export function productionReorderCommand(snapshot: ProductionSnapshot, id: string, session: Session | null, apparatusId: string, direction: 'move_up' | 'move_down', key: string = crypto.randomUUID()): ProductionCommand {
  const policy = productionQueuePolicies(snapshot, id, session).find(item => item.apparatusId === apparatusId)
  if (!policy || !(direction === 'move_up' ? policy.moveUp : policy.moveDown)) throw new ProductionControlError('blocked', 'Buyurtmani bu navbat o‘rniga surish mumkin emas.')
  if (!key.trim() || key.length > 200) throw new ProductionControlError('blocked', 'Navbat buyrug‘i identifikatori noto‘g‘ri.')
  const anchor = policy.orderIds[policy.position + (direction === 'move_up' ? -1 : 1)]
  return command(snapshot, 'reorder', direction, id, apparatusId, { apparatus: apparatusId, order_id: id,
    ...(direction === 'move_up' ? { before_order_id: anchor } : { after_order_id: anchor }), expected_version: policy.version, idempotency_key: key })
}

export class ProductionControlError extends Error {
  readonly kind: 'blocked' | 'conflict' | 'forbidden' | 'uncertain'
  readonly snapshot?: ProductionSnapshot
  constructor(kind: ProductionControlError['kind'], message: string, snapshot?: ProductionSnapshot) {
    super(message); this.name = 'ProductionControlError'; this.kind = kind; this.snapshot = snapshot
  }
}
export interface ProductionCommandResult { snapshot?: ProductionSnapshot; reconciled: boolean; adjusted: boolean; message: string }
const checkCurrent = (signal: AbortSignal, isCurrent: () => boolean) => { if (signal.aborted || !isCurrent()) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }

function responseValid(value: unknown, plan: ProductionCommand): boolean {
  if (!isRecord(value) || value.ok !== true) return false
  if (plan.kind === 'order') {
    const control = object(value.control), state = string(control.state)
    if (control.order_id !== plan.orderId || productionOrderControlState({ order_controls: { [plan.orderId]: control } } as ProductionSnapshot, plan.orderId) === 'unknown') return false
    if (plan.action === 'freeze') return ['freeze_requested', 'frozen'].includes(state) && !control.early_close
    if (plan.action === 'close_early') return ['freeze_requested', 'frozen'].includes(state) && object(control.early_close).comment === plan.body.comment
    return state === 'active' && !control.early_close
  }
  if (plan.kind === 'reorder') return Array.isArray(value.order_ids) && value.order_ids.every(id => typeof id === 'string' && id.trim() && id === id.trim()) && new Set(value.order_ids).size === value.order_ids.length && value.order_ids.includes(plan.orderId) && typeof value.version === 'string' && versionPattern.test(value.version) && typeof value.adjusted === 'boolean' && value.epoch === plan.epoch && (value.revision === null || integer(value.revision))
  const target = plan.action === 'pause' ? 'paused' : 'in_progress'
  if (value.epoch !== plan.epoch || !integer(value.rev) || value.rev < plan.snapshotRevision || object(value.states)[plan.orderId] !== target) return false
  if (plan.action === 'pause') {
    const output = Array.isArray(value.progress_batches) && value.progress_batches.length ? value.progress_batches : [value.progress_batch]
    const expected = Array.isArray(plan.body.rezka_frames) ? plan.body.rezka_frames.map(frame => object(frame).finished_goods_meter) : [plan.body.produced_qty]
    return output.length === expected.length && output.every((batch, index) => isRecord(batch) && batch.order_id === plan.orderId && batch.apparatus === plan.apparatusId && batch.action === 'pause' && string(batch.batch_id) && batch.produced_qty === expected[index])
  }
  return isRecord(value.order_status)
}
function observedResult(snapshot: ProductionSnapshot, plan: ProductionCommand): boolean {
  if (snapshot.epoch !== plan.epoch || snapshot.scope !== plan.snapshotScope || snapshot.rev <= plan.snapshotRevision || !snapshot.maps.some(saved => saved.map.id === plan.orderId)) return false
  const control = object(snapshot.order_controls[plan.orderId]), state = productionOrderControlState(snapshot, plan.orderId)
  if (plan.kind === 'order') {
    if (plan.action === 'freeze') return ['freeze_requested', 'frozen'].includes(state) && !control.early_close
    if (plan.action === 'close_early') return ['freeze_requested', 'frozen'].includes(state) && object(control.early_close).comment === plan.body.comment
    return state === 'active' && !control.early_close
  }
  if (plan.kind === 'queue') return snapshot.queue_states[plan.apparatusId]?.[plan.orderId] === (plan.action === 'pause' ? 'paused' : 'in_progress') && string(snapshot.queue_action_controls[plan.apparatusId]?.[plan.orderId]?.stage_node_id) === string(JSON.parse(plan.fingerprint)[3]?.stage_node_id)
  return false // A position does not prove this idempotent command's receipt.
}

/** Native order/queue writes have no revision/idempotency parameter; never invent or replay one. */
export async function executeProductionCommand(client: ApiClient, session: Session | null, plan: ProductionCommand, signal: AbortSignal, isCurrent: () => boolean = () => true, recoverReorder = false, onDispatch?: () => void): Promise<ProductionCommandResult> {
  checkCurrent(signal, isCurrent)
  if (recoverReorder && plan.kind !== 'reorder') throw new ProductionControlError('blocked', 'Bu amal uchun native qayta yuborish identifikatori yo‘q. Avvalgi buyruq saqlanmoqda.')
  if (!(plan.kind === 'queue' ? productionCanManageQueue(session) : productionCanManageOrders(session))) throw new ProductionControlError('forbidden', 'Bu amal uchun ruxsat yo‘q.')
  const fresh = await client.productionSnapshot(signal)
  checkCurrent(signal, isCurrent)
  if (fresh.epoch !== plan.epoch || fresh.scope !== plan.snapshotScope || fresh.rev < plan.snapshotRevision) throw new ProductionControlError('conflict', 'Server holati o‘zgargan. Yangilang va amalni qayta tasdiqlang.', fresh)
  if (plan.kind === 'order') {
    if (!productionOrderPolicy(fresh, plan.orderId, session).actions.includes(plan.action as ProductionOrderAction) || orderFingerprint(fresh, plan.orderId) !== plan.fingerprint) throw new ProductionControlError('conflict', 'Buyurtma holati o‘zgargan. Amal yuborilmadi.', fresh)
  } else if (plan.kind === 'queue') {
    if (queueFingerprint(fresh, plan.orderId, plan.apparatusId) !== plan.fingerprint) throw new ProductionControlError('conflict', 'Apparat yoki bosqich holati o‘zgargan. Amal yuborilmadi.', fresh)
    const metadata = plan.action === 'pause' ? [await client.detail('apparatus', { apparatus_id: plan.apparatusId }, signal)] : []
    checkCurrent(signal, isCurrent)
    const policy = productionQueuePolicies(fresh, plan.orderId, session, metadata).find(item => item.apparatusId === plan.apparatusId)
    if (!policy || !(plan.action === 'pause' ? policy.pause && policy.apparatusRevision === plan.apparatusRevision : policy.resume)) throw new ProductionControlError('conflict', 'Server amal ruxsatlari yoki uskuna ma’lumotlari o‘zgargan. Amal yuborilmadi.', fresh)
  } else if (!recoverReorder) {
    const policy = productionQueuePolicies(fresh, plan.orderId, session).find(item => item.apparatusId === plan.apparatusId)
    if (!policy || policy.version !== plan.body.expected_version || !(plan.action === 'move_up' ? policy.moveUp : policy.moveDown)) throw new ProductionControlError('conflict', 'Navbat o‘zgargan. Amal yuborilmadi; yangi o‘rinni qayta tasdiqlang.', fresh)
  }
  checkCurrent(signal, isCurrent)
  const path = plan.kind === 'order' ? `${base}/order-control` : plan.kind === 'queue' ? `${base}/queue-action` : `${base}/sequence`
  let response: unknown, writeError: unknown
  onDispatch?.(); checkCurrent(signal, isCurrent)
  try { response = await client.request(path, 'POST', { body: plan.body, signal }) }
  catch (error) { writeError = error }
  checkCurrent(signal, isCurrent)
  const definitive = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500
  if (definitive(writeError)) throw writeError
  if (plan.kind === 'reorder' && (writeError || !responseValid(response, plan))) {
    // The service stores the exact command receipt; retry this body/key only.
    onDispatch?.(); checkCurrent(signal, isCurrent)
    try { response = await client.request(path, 'POST', { body: plan.body, signal }); writeError = undefined }
    catch (error) { writeError = error }
    checkCurrent(signal, isCurrent)
    if (definitive(writeError)) throw writeError
  }
  const confirmed = !writeError && responseValid(response, plan)
  let readback: ProductionSnapshot | undefined
  try { readback = await client.productionSnapshot(signal) }
  catch { /* The validated command receipt still confirms a committed operation. */ }
  checkCurrent(signal, isCurrent)
  if (readback && (readback.epoch !== plan.epoch || readback.scope !== plan.snapshotScope || readback.rev < fresh.rev)) readback = undefined
  if (confirmed && readback && plan.kind === 'queue' && readback.rev < Number(object(response).rev)) readback = undefined
  if (confirmed && readback && plan.kind === 'reorder' && integer(object(response).revision)) {
    const revision = object(readback.sequence_revisions)[plan.apparatusId]
    if (!integer(revision) || revision < Number(object(response).revision)) readback = undefined
  }
  if (!confirmed) {
    const observed = readback && observedResult(readback, plan)
    throw new ProductionControlError('uncertain', plan.kind === 'reorder' ? 'Navbat buyrug‘i natijasi tasdiqlanmadi. Bir xil buyruq identifikatori saqlandi; natijani qayta tekshirish mumkin.' :
      `${observed ? 'Joriy server holati kutilgan holatga mos. ' : ''}Avvalgi amalning aniq natijasi yoki hisoboti tasdiqlanmadi. Buyruq saqlanmoqda va avtomatik qayta yuborilmaydi.`, readback)
  }
  return { snapshot: readback, reconciled: false, adjusted: object(response).adjusted === true,
    message: plan.action === 'close_early' ? 'Erta yopish so‘rovi qabul qilindi. Yakuniy holat serverdan olinadi.' : plan.action === 'unfreeze' ? 'Muzlatish olib tashlandi. Ishni apparat navbatida davom ettirish mumkin.' : plan.action === 'pause' ? 'Ish to‘xtatildi va WIP hisoboti saqlandi.' : 'Amal serverda tasdiqlandi.' }
}
