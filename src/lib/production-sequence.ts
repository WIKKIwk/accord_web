import { ApiClient, ApiError, isRecord } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { factoryMapQueueOrderIds } from './factory-map'
import { productionCanManageOrders, productionOrderControlState } from './production-controls'

const path = '/v1/mobile/admin/production-maps/sequence'
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const obj = (value: unknown): Row => isRecord(value) ? value : {}
const versionPattern = /^[a-f0-9]{64}$/
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const idsValid = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string' && Boolean(id.trim()) && id === id.trim()) && new Set(value).size === value.length
const activeStates = new Set(['in_progress', 'print_preflight', 'paused'])
const knownStates = new Set(['pending', ...activeStates, 'frozen', 'completed'])
const labels: Record<string, string> = { pending: 'Navbatda', in_progress: 'Ishlamoqda', print_preflight: 'Sinov bosmasi', paused: 'To‘xtatilgan', frozen: 'Muzlatilgan', completed: 'Tugallangan' }
const actor = (session: Session | null) => ({ role: str(session?.profile.role), ref: str(session?.profile.ref) })

export interface SequenceQueueRow {
  id: string
  label: string
  product: string
  customer: string
  state: string
  statusLabel: string
  active: boolean
  frozen: boolean
  locked: boolean
  reason: string
}
export interface SequenceQueue {
  apparatusId: string
  rows: SequenceQueueRow[]
  /** Complete editable canonical membership, including currently hidden orders. */
  canonicalIds: string[]
  version: string
  revision?: number
  valid: boolean
  canReorder: boolean
  reason: string
}

/** Display membership and sequence membership differ in the native snapshot. */
export function productionSequenceQueue(snapshot: ProductionSnapshot | undefined, apparatusId: string, session: Session | null): SequenceQueue {
  const empty: SequenceQueue = { apparatusId, rows: [], canonicalIds: [], version: '', valid: false, canReorder: false, reason: 'Apparat navbati hali olinmadi.' }
  if (!snapshot || !/^apparatus:[^\s]+$/.test(apparatusId)) return empty
  const visible = obj(snapshot.visible_order_ids)[apparatusId]
  const canonical = snapshot.sequences[apparatusId] ?? []
  const version = str(obj(snapshot.sequence_versions)[apparatusId])
  const revision = obj(snapshot.sequence_revisions)[apparatusId]
  if (!idsValid(visible) || !idsValid(canonical)) return { ...empty, reason: 'Serverning navbat a’zolari to‘liq yoki yagona holda olinmadi.' }
  const frozen = (id: string) => productionOrderControlState(snapshot, id) === 'frozen' || snapshot.queue_states[apparatusId]?.[id] === 'frozen'
  const canonicalIds = canonical.filter(id => !frozen(id))
  const rows = factoryMapQueueOrderIds(snapshot, apparatusId).map(id => {
    const matches = snapshot.maps.filter(saved => saved.map.id === id)
    const map = matches.length === 1 ? matches[0].map : {}
    const controlState = productionOrderControlState(snapshot, id)
    const state = str(snapshot.queue_states[apparatusId]?.[id])
    const lifecycle = str(snapshot.order_statuses[id]?.lifecycle_status)
    const preflightLocked = ['held', 'running', 'passed'].includes(str(obj(snapshot.queue_action_controls[apparatusId]?.[id]?.print_preflight).status))
    const isFrozen = frozen(id), active = activeStates.has(state) || preflightLocked
    const unknown = matches.length !== 1 || controlState === 'unknown' || !knownStates.has(state)
    const terminal = ['production_completed', 'closed', 'cancelled'].includes(lifecycle) || state === 'completed'
    const reason = unknown ? 'Buyurtmaning joriy navbat holati noma’lum.' : isFrozen ? 'Muzlatilgan buyurtma surilmaydi.' : active ? 'Ishdagi, sinov bosmasidagi yoki to‘xtatilgan buyurtma surilmaydi.' : terminal ? 'Tugallangan buyurtma surilmaydi.' : !canonicalIds.includes(id) ? 'Buyurtma serverning tahrirlanadigan navbatida yo‘q.' : ''
    return { id, label: str(map.order_number || map.code) || id, product: str(map.title || map.product || map.name), customer: str(snapshot.order_customers[id]), state, statusLabel: isFrozen ? labels.frozen : labels[state] || 'Noma’lum', active, frozen: isFrozen, locked: Boolean(reason), reason }
  })
  const malformed = rows.some(row => !knownStates.has(row.state) || productionOrderControlState(snapshot, row.id) === 'unknown' || snapshot.maps.filter(saved => saved.map.id === row.id).length !== 1 || !row.frozen && !canonicalIds.includes(row.id))
  const valid = versionPattern.test(version) && !malformed
  const reason = !valid ? 'Navbat versiyasi yoki buyurtma holatlari to‘liq olinmadi. Ma’lumotlarni yangilang.' : !productionCanManageOrders(session) ? 'Navbatni o‘zgartirish uchun buyurtmalarni boshqarish ruxsati kerak.' : ''
  return { apparatusId, rows, canonicalIds, version, revision: integer(revision) ? revision : undefined, valid, canReorder: valid && productionCanManageOrders(session), reason }
}

export interface SequenceMovePlan {
  apparatusId: string
  orderId: string
  orderLabel: string
  actor: { role: string; ref: string }
  epoch: string
  snapshotScope: string
  snapshotRevision: number
  fromPosition: number
  toPosition: number
  clamped: boolean
  displayIds: string[]
  canonicalIds: string[]
  body: { apparatus: string; order_id: string; expected_version: string; idempotency_key: string; before_order_id?: string; after_order_id?: string }
}
export class SequenceMoveError extends Error {
  readonly kind: 'blocked' | 'conflict' | 'forbidden' | 'uncertain'
  readonly snapshot?: ProductionSnapshot
  readonly definitive: boolean
  constructor(kind: SequenceMoveError['kind'], message: string, snapshot?: ProductionSnapshot, definitive = false) {
    super(message); this.name = 'SequenceMoveError'; this.kind = kind; this.snapshot = snapshot; this.definitive = definitive
  }
}

/** Destination is the final visible index (the dnd-kit sortable convention). */
export function productionSequenceMove(snapshot: ProductionSnapshot, apparatusId: string, orderId: string, destination: number, session: Session | null, key: string = crypto.randomUUID()): SequenceMovePlan | null {
  const queue = productionSequenceQueue(snapshot, apparatusId, session)
  if (!queue.canReorder) throw new SequenceMoveError('blocked', queue.reason)
  const from = queue.rows.findIndex(row => row.id === orderId), moved = queue.rows[from]
  if (!moved || moved.locked || !integer(destination) || destination >= queue.rows.length) throw new SequenceMoveError('blocked', moved?.reason || 'Buyurtma yoki yangi navbat o‘rni noto‘g‘ri.')
  if (from === destination) return null
  if (!key.trim() || key.length > 200) throw new SequenceMoveError('blocked', 'Navbat buyrug‘i identifikatori noto‘g‘ri.')
  const lastActive = queue.rows.reduce((last, row, index) => index !== from && row.active ? index : last, -1)
  const to = Math.min(queue.rows.length - 1, Math.max(destination, lastActive + 1))
  if (from === to) return null
  const displayIds = queue.rows.map(row => row.id)
  displayIds.splice(from, 1); displayIds.splice(to, 0, orderId)
  const eligible = new Set(queue.rows.filter(row => !row.frozen).map(row => row.id))
  const nextEditable = displayIds.filter(id => eligible.has(id))
  if (JSON.stringify(nextEditable) === JSON.stringify(queue.rows.filter(row => !row.frozen).map(row => row.id))) return null
  const index = nextEditable.indexOf(orderId)
  const before = nextEditable[index + 1], after = before ? undefined : nextEditable[index - 1]
  return { apparatusId, orderId, orderLabel: moved.label, actor: actor(session), epoch: snapshot.epoch, snapshotScope: snapshot.scope, snapshotRevision: snapshot.rev, fromPosition: from + 1, toPosition: to + 1, clamped: to !== destination, displayIds, canonicalIds: queue.canonicalIds,
    body: { apparatus: apparatusId, order_id: orderId, expected_version: queue.version, idempotency_key: key, ...(before ? { before_order_id: before } : after ? { after_order_id: after } : {}) } }
}

export interface SequenceMoveReceipt { ok: true; order_ids: string[]; version: string; adjusted: boolean; epoch: string; revision?: number | null }
function requestedCanonicalIds(plan: SequenceMovePlan): string[] {
  const ids = plan.canonicalIds.filter(id => id !== plan.orderId)
  const target = plan.body.before_order_id ? ids.indexOf(plan.body.before_order_id) : plan.body.after_order_id ? ids.indexOf(plan.body.after_order_id) + 1 : ids.length
  ids.splice(target, 0, plan.orderId)
  return ids
}
export function productionSequenceReceipt(value: unknown, plan: SequenceMovePlan): value is SequenceMoveReceipt {
  if (!isRecord(value) || value.ok !== true || !idsValid(value.order_ids) || !versionPattern.test(str(value.version)) || typeof value.adjusted !== 'boolean' || !str(value.epoch) || !(value.revision === undefined || value.revision === null || integer(value.revision))) return false
  // The service only moves this order. Validate complete membership and the
  // relative order of every other member; never accept a truncated receipt.
  if (!value.order_ids.includes(plan.orderId) || JSON.stringify(value.order_ids.filter(id => id !== plan.orderId)) !== JSON.stringify(plan.canonicalIds.filter(id => id !== plan.orderId))) return false
  return value.adjusted || JSON.stringify(value.order_ids) === JSON.stringify(requestedCanonicalIds(plan))
}
const current = (signal: AbortSignal, isCurrent: () => boolean) => { if (signal.aborted || !isCurrent()) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
const definitive = (error: unknown): error is ApiError => error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)

/** One native move, with bounded retries of the same body/key only. */
export async function executeProductionSequenceMove(client: ApiClient, session: Session | null, plan: SequenceMovePlan, signal: AbortSignal, isCurrent: () => boolean = () => true, recovery = false, onDispatch?: () => void): Promise<{ receipt: SequenceMoveReceipt; snapshot?: ProductionSnapshot }> {
  current(signal, isCurrent)
  if (!productionCanManageOrders(session) || JSON.stringify(actor(session)) !== JSON.stringify(plan.actor)) throw new SequenceMoveError('forbidden', 'Avvalgi navbat buyrug‘i aynan shu hisob va ruxsatlar bilan tekshiriladi.')
  let fresh: ProductionSnapshot | undefined
  if (!recovery) {
    fresh = await client.productionSnapshot(signal); current(signal, isCurrent)
    const queue = productionSequenceQueue(fresh, plan.apparatusId, session)
    const row = queue.rows.find(row => row.id === plan.orderId)
    const anchor = plan.body.before_order_id || plan.body.after_order_id
    if (fresh.scope !== plan.snapshotScope || !queue.canReorder || row?.locked !== false || queue.version !== plan.body.expected_version || JSON.stringify(queue.canonicalIds) !== JSON.stringify(plan.canonicalIds) || anchor && !queue.rows.some(row => row.id === anchor && !row.frozen)) {
      throw new SequenceMoveError('conflict', 'Navbat yoki buyurtma holati o‘zgargan. Amal yuborilmadi; yangi o‘rinni qayta tanlang.', fresh, true)
    }
  }
  // Native receipts are durable across server restarts. Recovery deliberately
  // does not rebase the original body, key, version or epoch before sending.
  let receipt: SequenceMoveReceipt | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    current(signal, isCurrent); onDispatch?.(); current(signal, isCurrent)
    try {
      const value = await client.request(path, 'POST', { body: plan.body, signal })
      current(signal, isCurrent)
      if (productionSequenceReceipt(value, plan)) { receipt = value; break }
    } catch (error) {
      current(signal, isCurrent)
      if (definitive(error)) {
        if (error.status === 409) {
          try { fresh = await client.productionSnapshot(signal) } catch { /* Keep original intent if refresh fails. */ }
          current(signal, isCurrent)
        }
        throw new SequenceMoveError(error.status === 403 || error.status === 401 ? 'forbidden' : error.status === 409 ? 'conflict' : 'blocked', error.message, fresh, true)
      }
    }
  }
  if (!receipt) throw new SequenceMoveError('uncertain', 'Navbat buyrug‘i yuborildi, ammo server tasdig‘i olinmadi. Asl buyruq va identifikator shu sessiyada saqlanmoqda; natijani qayta tekshiring.')
  let readback: ProductionSnapshot | undefined
  try { readback = await client.productionSnapshot(signal) } catch { /* A validated receipt confirms the write independently of readback. */ }
  current(signal, isCurrent)
  if (readback && (readback.scope !== plan.snapshotScope || fresh && readback.epoch === fresh.epoch && readback.rev < fresh.rev || readback.epoch === receipt.epoch && integer(receipt.revision) && integer(obj(readback.sequence_revisions)[plan.apparatusId]) && Number(obj(readback.sequence_revisions)[plan.apparatusId]) < receipt.revision)) readback = undefined
  return { receipt, snapshot: readback }
}
