import { isRecord, text } from './api'
import type { Page, ProductionSnapshot, Row, SavedMap } from './api-types'
import { factoryMapOrderStatus, factoryMapQueueOrderIds, productionMapStageQueueState, type FactoryMapStatus } from './factory-map'
import { productionMapFromRow } from './production-map'

export const dashboardStatusLabels: Record<string, string> = {
  not_started: 'Boshlanmagan', ready: 'Ishga tayyor', print_preflight: 'Bosma tekshiruvi',
  in_progress: 'Jarayonda', paused: 'To‘xtatilgan', frozen: 'Muzlatilgan',
  waiting_next_stage: 'Keyingi bosqich kutilmoqda', partially_completed: 'Qisman tugallangan',
  completed: 'Tugallangan', completed_with_issue: 'Muammo bilan tugallangan',
  production_completed: 'Ishlab chiqarish tugallangan', closed: 'Yopilgan', cancelled: 'Bekor qilingan',
  pending: 'Navbatda', waiting: 'Kutilmoqda', unknown: 'Holat noma’lum',
}
const running = new Set(['in_progress', 'print_preflight'])
const queued = new Set(['not_started', 'ready', 'waiting_next_stage', 'pending', 'waiting'])
const terminal = new Set(['production_completed', 'closed', 'cancelled'])
const operationStates = new Set(Object.keys(dashboardStatusLabels).filter(value => !terminal.has(value) && value !== 'unknown'))
const key = (value: unknown) => text(value, '').trim().toLowerCase()

export interface DashboardOrder {
  id: string
  saved: SavedMap
  status: string
  statusLabel: string
  known: boolean
  running: boolean
  queued: boolean
  attention: boolean
  attentionReason: string
  completed: boolean
  partial: boolean
  stage: string
  stages: { completed: number; known: number; total: number }
}

/** Lifecycle in_progress is not evidence that an order is currently running. */
export function dashboardOrderStatus(snapshot: ProductionSnapshot, id: string): string {
  const status = snapshot.order_statuses?.[id]
  const lifecycle = key(status?.lifecycle_status)
  if (terminal.has(lifecycle)) return lifecycle
  if (key(snapshot.order_controls?.[id]?.state) === 'frozen') return 'frozen'
  const operational = key(status?.order_status)
  if (operational) return operationStates.has(operational) ? operational : 'unknown'
  const work = key(status?.work_status)
  return operationStates.has(work) ? work : 'unknown'
}

/** Group alternative apparatus once and use graph order, not visual node order. */
export function dashboardStages(snapshot: ProductionSnapshot, saved: SavedMap): Pick<DashboardOrder, 'stage' | 'stages'> {
  try {
    const map = productionMapFromRow(saved.map)
    const remaining = new Map(map.nodes.map(node => [node.id, node]))
    const ordered: typeof map.nodes = []
    while (remaining.size) {
      const next = [...remaining.values()].find(node => !map.edges.some(edge => edge.to === node.id && remaining.has(edge.from)))
      if (!next) { ordered.push(...remaining.values()); break }
      ordered.push(next); remaining.delete(next.id)
    }
    const groups = new Map<string, typeof map.nodes>()
    for (const node of ordered.filter(node => node.kind === 'apparatus')) {
      const group = text(node.alternative_group_id, '')
      const id = group ? `group:${group}` : `node:${node.id}`
      groups.set(id, [...(groups.get(id) ?? []), node])
    }
    const ranks: Record<string, number> = { in_progress: 6, print_preflight: 5, paused: 4, completed: 3, frozen: 2, pending: 1 }
    const stages = [...groups.values()].map(nodes => nodes.map(node => ({ node, state: productionMapStageQueueState(map, node, map.id, snapshot) }))
      .reduce((best, item) => (ranks[item.state ?? ''] ?? 0) > (ranks[best.state ?? ''] ?? 0) ? item : best))
    const completed = stages.filter(stage => stage.state === 'completed').length
    const known = stages.filter(stage => stage.state !== null).length
    const current = stages.filter(stage => ['in_progress', 'print_preflight', 'paused', 'frozen'].includes(stage.state ?? ''))
    const pending = stages.find(stage => stage.state === 'pending')
    const names = current.length ? current : pending ? [pending] : []
    return {
      stage: names.length ? names.map(item => text(item.node.alternative_assigned_title || item.node.title, 'Nomsiz bosqich')).join(' · ') : stages.length && completed === stages.length ? 'Bosqichlar tugallangan' : 'Bosqich holati noma’lum',
      stages: { completed, known, total: stages.length },
    }
  } catch {
    return { stage: 'Bosqich ma’lumoti olinmadi', stages: { completed: 0, known: 0, total: 0 } }
  }
}

export function dashboardOrders(snapshot: ProductionSnapshot | undefined): DashboardOrder[] {
  if (!snapshot) return []
  return snapshot.maps.map(saved => {
    const id = text(saved.map.id, '')
    const status = dashboardOrderStatus(snapshot, id)
    const issueCount = snapshot.order_statuses?.[id]?.completed_with_issue_count
    const freezeRequested = key(snapshot.order_controls?.[id]?.state) === 'freeze_requested' && !terminal.has(status)
    const issue = status === 'completed_with_issue' || typeof issueCount === 'number' && issueCount > 0
    const attentionReason = freezeRequested ? 'Muzlatish so‘rovi kutilmoqda' : status === 'paused' ? 'Ish to‘xtatilgan' : status === 'frozen' ? 'Buyurtma muzlatilgan' : issue ? 'Yakunlangan ishda muammo bor' : ''
    return {
      id, saved, status, statusLabel: dashboardStatusLabels[status], known: status !== 'unknown',
      running: running.has(status), queued: queued.has(status), attention: Boolean(attentionReason), attentionReason,
      completed: ['production_completed', 'closed', 'completed', 'completed_with_issue'].includes(status),
      partial: status === 'partially_completed', ...dashboardStages(snapshot, saved),
    }
  })
}

export function dashboardOrderCounts(orders: readonly DashboardOrder[]) {
  return {
    total: orders.length, unknown: orders.filter(order => !order.known).length,
    running: orders.filter(order => order.running).length, queued: orders.filter(order => order.queued).length,
    attention: orders.filter(order => order.attention).length, partial: orders.filter(order => order.partial).length,
    completed: orders.filter(order => order.completed).length,
  }
}

/** Missing status coverage and server caps are lower bounds, never exact zeros. */
export function dashboardCount(value: number, available: boolean, incomplete = false): string {
  if (!available || incomplete && value === 0) return '—'
  return `${value.toLocaleString('uz-UZ')}${incomplete ? '+' : ''}`
}
export function dashboardPageCount(page: Page | undefined): string {
  return dashboardCount(page?.items.length ?? 0, Boolean(page), Boolean(page?.hasMore || page?.bounded))
}

export interface DashboardQueue {
  apparatusId: string
  label: string
  total: number
  running: number
  waiting: number
  unknown: number
  firstOrderId: string
  firstStatus: FactoryMapStatus
}
export function dashboardQueues(snapshot: ProductionSnapshot | undefined): DashboardQueue[] {
  if (!snapshot || !isRecord(snapshot.visible_order_ids)) return []
  const names = new Map<string, string>()
  for (const saved of snapshot.maps) for (const node of Array.isArray(saved.map.nodes) ? saved.map.nodes.filter(isRecord) : []) {
    const id = text(node.alternative_assigned_apparatus_id || node.apparatus_id, '')
    if (node.kind === 'apparatus' && id && !names.has(id)) names.set(id, text(node.alternative_assigned_title || node.title, id))
  }
  return Object.keys(snapshot.visible_order_ids).flatMap(apparatusId => {
    const orders = factoryMapQueueOrderIds(snapshot, apparatusId).map(id => ({ id, state: factoryMapOrderStatus(snapshot, apparatusId, id) }))
      .filter(order => order.state !== 'completed')
    if (!orders.length) return []
    const active = orders.filter(order => ['in_progress', 'print_preflight', 'print_preflight_passed', 'paused'].includes(order.state))
    const first = active[0] ?? orders[0]
    return [{ apparatusId, label: names.get(apparatusId) ?? apparatusId, total: orders.length, running: active.filter(order => order.state !== 'paused').length,
      waiting: orders.filter(order => ['pending', 'waiting_wip', 'wip_waiting', 'requeued_waiting'].includes(order.state)).length,
      unknown: orders.filter(order => order.state === 'unknown').length, firstOrderId: first.id, firstStatus: first.state }]
  }).sort((a, b) => b.waiting - a.waiting || b.total - a.total || a.label.localeCompare(b.label))
}

export function dashboardWipRows(page: Page | undefined, state: 'waiting' | 'in_use'): Row[] {
  return page?.items.filter(row => {
    const detail = isRecord(row.status_detail) ? row.status_detail : {}
    return key(row.wip_status || detail.wip_status) === state && !(isRecord(row.payload_json) && row.payload_json.origin === 'layer_remainder')
  }) ?? []
}

export function dashboardWipCount(page: Page | undefined, state: 'waiting' | 'in_use'): string {
  const matches = dashboardWipRows(page, state)
  const unknown = page?.items.some(row => {
    const detail = isRecord(row.status_detail) ? row.status_detail : {}
    return !['waiting', 'in_use', 'processed'].includes(key(row.wip_status || detail.wip_status))
  })
  return dashboardCount(matches.length, Boolean(page), Boolean(page?.hasMore || page?.bounded || unknown))
}
