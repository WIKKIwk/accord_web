import { isRecord } from './api'
import type { ProductionSnapshot, Row } from './api-types'
import { isCanonicalApparatusId, productionMapFromRow } from './production-map'
import type { ProductionMapDefinition, ProductionMapNode } from './production-map'
import { productionOrderControlState } from './production-controls'
import type { ProductionControlState } from './production-controls'

export const manufacturingStates = ['pending', 'print_preflight', 'in_progress', 'paused', 'frozen', 'completed'] as const
export type ManufacturingState = typeof manufacturingStates[number]
export const manufacturingStateLabels: Record<ManufacturingState, string> = {
  pending: 'Navbatda', print_preflight: 'Bosma tekshiruvi', in_progress: 'Jarayonda',
  paused: 'To‘xtatilgan', frozen: 'Muzlatilgan', completed: 'Tugallangan',
}
export const manufacturingActionLabels: Record<string, string> = {
  start: 'Ish boshlangan', pause: 'To‘xtatish qaydi', freeze: 'Muzlatish qaydi',
  detach_roll: 'Rulon ajratilgan', resume: 'Ish davom ettirilgan', merge: 'WIP ulangan',
  roll_complete: 'Rulon hisoboti', complete: 'Bosqich hisoboti',
}
const actions = new Set(Object.keys(manufacturingActionLabels))
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const object = (value: unknown): Row => isRecord(value) ? value : {}
const state = (value: unknown): ManufacturingState | null => manufacturingStates.includes(value as ManufacturingState) ? value as ManufacturingState : null
const stageKey = (nodeId: string, apparatus: string) => JSON.stringify([nodeId, apparatus])

/** Native fields are Unix seconds. Zero, numeric strings, and invalid dates are not timestamps. */
export function manufacturingUnix(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000 ? value : null
}

export type ManufacturingEventKind = 'queue' | 'freeze' | 'transfer' | 'closed' | 'session_start' | 'session_update' | 'work_report' | 'batch_marker' | 'last_activity'
export interface ManufacturingEvent {
  id: string
  kind: ManufacturingEventKind
  label: string
  atUnix: number
  apparatus: string
  nodeId: string
  nodeTitle: string
  stageKey: string | null
  actor: string
  fromState: ManufacturingState | null
  toState: ManufacturingState | null
  transition: boolean
  note: string
  issue: boolean
  batchId: string
  sessionId: string
}
export interface ManufacturingInterval {
  startUnix: number
  endUnix: number
  state: ManufacturingState
  startEventId: string
  endEventId: string
}
export interface ManufacturingGap {
  startUnix: number
  endUnix: number
  reason: 'inconsistent' | 'same_second' | 'unattributed' | 'conflict'
}
export interface ManufacturingStage {
  key: string
  nodeId: string
  apparatus: string
  title: string
  currentState: ManufacturingState | null
  lastRecordedState: ManufacturingState | null
  lastActivityAtUnix: number | null
  eventIds: string[]
  intervals: ManufacturingInterval[]
  gaps: ManufacturingGap[]
  recordedSeconds: number | null
  inProgressSeconds: number | null
  pausedSeconds: number | null
}
export interface ManufacturingWindow { startUnix: number; endUnix: number }
export interface ManufacturingTimeline {
  orderId: string
  orderNumber: string
  title: string
  source: 'closed_order' | 'batch_lineage' | 'snapshot_only' | 'unavailable'
  asOfUnix: number | null
  fresh: boolean
  orderControlState?: ProductionControlState | null
  earlyClosed?: boolean
  hasIssue?: boolean
  closedAtUnix: number | null
  window: ManufacturingWindow | null
  observedWindowSeconds: number | null
  events: ManufacturingEvent[]
  stages: ManufacturingStage[]
  coverage: {
    logsReceived: number
    duplicateRecords: number
    discardedRecords: number
    conflictingRecords: number
    unattributedEvents: number
    gapCount: number
    measuredStageCount: number
    lineageComplete: boolean | null
    issues: string[]
  }
}
export interface ManufacturingTimelineInput {
  orderId: string
  closedOrder?: Row | null
  report?: Row | null
  /** Optional native map context. It provides topology, never an atomic snapshot revision. */
  map?: Row | null
  snapshot?: ProductionSnapshot
  /** Fetch observation time; never advance a stale/offline response to Date.now(). */
  asOfUnix: number
  fresh?: boolean
}

/** Union overlapping observations; sibling rolls or parallel stages are not additive wall time. */
export function manufacturingUnionSeconds(intervals: readonly Pick<ManufacturingInterval, 'startUnix' | 'endUnix'>[]): number | null {
  const ranges = intervals.filter(interval => manufacturingUnix(interval.startUnix) !== null && manufacturingUnix(interval.endUnix) !== null && interval.endUnix > interval.startUnix)
    .map(interval => [interval.startUnix, interval.endUnix] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (!ranges.length) return null
  let [start, end] = ranges[0], total = 0
  for (const next of ranges.slice(1)) {
    if (next[0] <= end) end = Math.max(end, next[1])
    else { total += end - start; [start, end] = next }
  }
  return total + end - start
}

function orderedNodes(map: ProductionMapDefinition | null): ProductionMapNode[] {
  if (!map) return []
  const remaining = new Map(map.nodes.map(node => [node.id, node]))
  const nodes: ProductionMapNode[] = []
  while (remaining.size) {
    const next = [...remaining.values()].find(node => !map.edges.some(edge => edge.to === node.id && remaining.has(edge.from)))
    if (!next) { nodes.push(...remaining.values()); break }
    nodes.push(next); remaining.delete(next.id)
  }
  return nodes
}

/**
 * Closed-order logs are retained order history (the list itself is capped at 200).
 * QR report logs are a filtered batch lineage, even when lineage_complete=true.
 * Only consecutive, attributable closed-order transitions establish state spans.
 * Session/batch update times and current queue state never establish productive time.
 */
export function buildManufacturingTimeline(input: ManufacturingTimelineInput): ManufacturingTimeline {
  const orderId = string(input.orderId), asOfUnix = manufacturingUnix(input.asOfUnix)
  const issues = new Set<string>()
  let discardedRecords = 0, duplicateRecords = 0, conflictingRecords = 0
  const closed = object(input.closedOrder), report = object(input.report)
  const acceptedClosed = Boolean(orderId && closed.order_id === orderId && Array.isArray(closed.logs))
  const acceptedReport = Boolean(orderId && report.ok === true && report.history_scope === 'batch_lineage' && object(report.scanned_batch).order_id === orderId)
  if (input.closedOrder && !acceptedClosed) issues.add('Yopilgan buyurtma tarixi tanlangan buyurtmaga mos yoki to‘liq shaklda olinmadi.')
  if (input.report && !acceptedReport) issues.add('Partiya tarixi tanlangan buyurtma va batch_lineage doirasiga mos emas.')
  const saved = input.snapshot?.maps.find(value => value.map.id === orderId)
  const source: ManufacturingTimeline['source'] = acceptedClosed ? 'closed_order' : acceptedReport ? 'batch_lineage' : saved ? 'snapshot_only' : 'unavailable'
  let map: ProductionMapDefinition | null = null
  const explicitMap = input.map ? object(input.map) : null
  if (explicitMap && explicitMap.id !== orderId) issues.add('Xarita tanlangan buyurtmaga mos emas; uning bosqichlari ishlatilmadi.')
  const mapSource = saved?.map ?? (explicitMap?.id === orderId ? explicitMap : null) ?? (acceptedReport && object(report.order).id === orderId ? object(report.order) : null)
  if (mapSource) {
    try { map = productionMapFromRow(mapSource) } catch { issues.add('Bosqich xaritasi o‘qilmadi; faqat aniq identifikatorli tarix ko‘rsatiladi.') }
  }
  const nodes = orderedNodes(map)
  const stages = new Map<string, ManufacturingStage>()
  function ensureStage(nodeId: string, apparatus: string): ManufacturingStage | null {
    if (!nodeId || !isCanonicalApparatusId(apparatus)) return null
    const node = nodes.find(candidate => candidate.id === nodeId)
    if (map && (!node || node.kind !== 'apparatus' || ![node.apparatus_id, node.alternative_assigned_apparatus_id].includes(apparatus))) return null
    const key = stageKey(nodeId, apparatus)
    let stage = stages.get(key)
    if (!stage) {
      stage = { key, nodeId, apparatus, title: string(node?.alternative_assigned_apparatus_id) === apparatus ? string(node?.alternative_assigned_title) || string(node?.title) || nodeId : string(node?.title) || nodeId,
        currentState: null, lastRecordedState: null, lastActivityAtUnix: null, eventIds: [], intervals: [], gaps: [], recordedSeconds: null, inProgressSeconds: null, pausedSeconds: null }
      stages.set(key, stage)
    }
    return stage
  }
  for (const node of nodes) if (node.kind === 'apparatus') ensureStage(node.id, string(node.alternative_assigned_apparatus_id) || string(node.apparatus_id))

  const events: (ManufacturingEvent & { responseIndex: number })[] = []
  const eventIds = new Set<string>()
  function time(value: unknown): number | null {
    const timestamp = manufacturingUnix(value)
    if (timestamp === null || asOfUnix !== null && timestamp > asOfUnix) { discardedRecords += 1; return null }
    return timestamp
  }
  function addEvent(value: Omit<ManufacturingEvent, 'stageKey' | 'nodeTitle'> & { stageKey?: string | null }) {
    if (eventIds.has(value.id)) return
    eventIds.add(value.id)
    const stage = ensureStage(value.nodeId, value.apparatus)
    const node = nodes.find(candidate => candidate.id === value.nodeId)
    const event = { ...value, nodeTitle: stage?.title || (node?.kind === 'task' ? node.title : ''), stageKey: stage?.key ?? null, responseIndex: events.length }
    events.push(event)
    if (stage) stage.eventIds.push(event.id)
  }
  const rawLogs = acceptedClosed ? closed.logs as unknown[] : acceptedReport && Array.isArray(report.logs) ? report.logs : []
  const logById = new Map<string, Row>()
  const conflictKeys = new Set<string>()
  const conflictApparatus = new Set<string>()
  let conflictOrderChronology = false
  const invalidKeys = new Set<string>(), invalidApparatus = new Set<string>()
  let invalidOrderChronology = false
  for (const value of rawLogs) {
    const row = object(value), id = string(row.event_id), timestamp = manufacturingUnix(row.created_at_unix)
    if (!id || row.order_id !== orderId || timestamp === null || asOfUnix !== null && timestamp > asOfUnix) {
      discardedRecords += 1
      // A malformed boundary cannot simply disappear between valid events.
      if (!isRecord(value) || !string(row.order_id)) invalidOrderChronology = true
      else if (row.order_id === orderId) {
        const nodeId = string(row.stage_node_id), apparatus = string(row.apparatus)
        if (nodeId && apparatus) invalidKeys.add(stageKey(nodeId, apparatus))
        else if (apparatus) invalidApparatus.add(apparatus)
        else invalidOrderChronology = true
      }
      continue
    }
    const existing = logById.get(id)
    if (existing) {
      const signature = (entry: Row) => JSON.stringify([entry.order_id, entry.apparatus, entry.stage_node_id, entry.action, entry.from_state, entry.to_state, entry.created_at_unix, entry.transfer ?? null, entry.freeze ?? null])
      if (signature(existing) === signature(row)) duplicateRecords += 1
      else {
        conflictingRecords += 1
        for (const entry of [existing, row]) {
          const nodeId = string(entry.stage_node_id), apparatus = string(entry.apparatus)
          conflictKeys.add(stageKey(nodeId, apparatus))
          if (!apparatus) conflictOrderChronology = true
          else if (!nodeId) conflictApparatus.add(apparatus)
        }
        // Retain each conflicting raw timestamp as an unknown fact. Choosing
        // only the first would hide a boundary inside another stage's span.
        logById.set(`${id}:conflict:${conflictingRecords}`, row)
      }
    } else logById.set(id, row)
  }
  for (const [id, row] of logById) {
    const atUnix = time(row.created_at_unix)
    if (atUnix === null) continue
    const transfer = isRecord(row.transfer), freeze = isRecord(row.freeze)
    const action = string(row.action), fromState = state(row.from_state), toState = state(row.to_state)
    const key = stageKey(string(row.stage_node_id), string(row.apparatus))
    const conflicted = conflictKeys.has(key)
    const transition = !transfer && !freeze && !conflicted && actions.has(action) && fromState !== null && toState !== null
    if (!transfer && !freeze && !transition) issues.add('Ayrim holat almashish yozuvlari noma’lum yoki o‘zaro mos emas; ular davomiylikka qo‘shilmadi.')
    addEvent({ id: `queue:${id}`, kind: transfer ? 'transfer' : freeze ? 'freeze' : 'queue',
      label: transfer ? 'Uskunalar orasida ko‘chirish qaydi' : freeze ? 'Buyurtmani muzlatish qaydi' : manufacturingActionLabels[action] ?? 'Noma’lum holat qaydi',
      atUnix, apparatus: string(row.apparatus), nodeId: string(row.stage_node_id), actor: string(row.actor_display_name) || string(row.actor_ref),
      fromState, toState, transition, note: conflicted ? 'Shu identifikatorli yozuvlar mos kelmadi.' : string(row.issue_note) || string(object(row.transfer).reason) || (freeze ? string(object(row.freeze).status) : ''),
      issue: row.completed_with_issue === true || conflicted, batchId: string(object(row.transfer).progress_batch_id), sessionId: string(object(row.transfer).session_id) || string(object(row.freeze).target_session_id) })
  }

  // These markers describe persisted facts only. No session/batch elapsed totals.
  const sessionById = new Map<string, Row>(), sessionConflicts = new Set<string>()
  for (const value of acceptedReport ? [...(Array.isArray(report.run_sessions) ? report.run_sessions : []), ...(Array.isArray(report.active_sessions) ? report.active_sessions : [])] : []) {
    const row = object(value), id = string(row.session_id)
    if (!id || row.order_id !== orderId) { discardedRecords += 1; continue }
    const existing = sessionById.get(id)
    if (existing) {
      const signature = (entry: Row) => JSON.stringify([entry.apparatus, entry.stage_node_id, entry.status, entry.started_at_unix, entry.updated_at_unix, object(entry.payload_json).stage_work_report])
      if (signature(existing) !== signature(row)) { sessionConflicts.add(id); conflictingRecords += 1 }
      else duplicateRecords += 1
    } else sessionById.set(id, row)
  }
  for (const [sessionId, row] of sessionById) {
    if (sessionConflicts.has(sessionId)) continue
    const payload = object(row.payload_json), apparatus = string(row.apparatus), nodeId = string(row.stage_node_id) || string(payload.stage_node_id)
    const actor = string(row.worker_display_name) || string(row.worker_ref)
    for (const [field, kind, label] of [['started_at_unix', 'session_start', 'Sessiya boshi qayd etilgan'], ['updated_at_unix', 'session_update', 'Sessiya oxirgi saqlanishi']] as const) {
      const atUnix = time(row[field]); if (atUnix === null) continue
      addEvent({ id: `${kind}:${sessionId}`, kind, label, atUnix, apparatus, nodeId, actor, fromState: null, toState: null, transition: false,
        note: kind === 'session_update' ? 'Oxirgi saqlangan vaqt; ishning yakun vaqti yoki holatga kirish vaqti emas.' : '', issue: false, batchId: '', sessionId })
    }
    const workReport = object(payload.stage_work_report)
    if (string(workReport.report_id)) {
      const atUnix = time(workReport.submitted_at_unix)
      if (atUnix !== null && !events.some(event => event.id === `queue:${string(workReport.report_id)}` && event.atUnix === atUnix)) addEvent({ id: `work_report:${sessionId}:${string(workReport.report_id)}`, kind: 'work_report', label: 'Bosqich hisoboti yuborilgan',
        atUnix, apparatus, nodeId, actor: string(workReport.worker_display_name) || actor, fromState: null, toState: null, transition: false, note: 'Hisobot yuborilgan vaqt; uzluksiz ishlab chiqarish o‘lchovi emas.', issue: false, batchId: '', sessionId })
    }
  }
  const batchMarkers: Record<string, string> = {
    wip_in_use_at_unix: 'WIP ishlatish qaydi', wip_processed_at_unix: 'WIP qayta ishlangan qaydi',
    worker_handoff_at_unix: 'Ishni topshirish qaydi', roll_removed_at_unix: 'Rulon olib tashlangan qaydi',
    roll_claimed_after_handoff_at_unix: 'Rulon qabul qilingan qaydi', resumed_at_unix: 'Partiyani davom ettirish qaydi',
  }
  const batches = acceptedClosed ? closed.progress_batches : acceptedReport ? report.progress_batches : []
  const batchById = new Map<string, Row>(), batchConflicts = new Set<string>()
  for (const value of Array.isArray(batches) ? batches : []) {
    const row = object(value), batchId = string(row.batch_id)
    if (!batchId || row.order_id !== orderId) { discardedRecords += 1; continue }
    const existing = batchById.get(batchId)
    if (existing) {
      const signature = (entry: Row) => JSON.stringify([entry.apparatus, entry.session_id, object(entry.payload_json).stage_node_id, ...Object.keys(batchMarkers).map(field => object(entry.payload_json)[field])])
      if (signature(existing) !== signature(row)) { batchConflicts.add(batchId); conflictingRecords += 1 }
      else duplicateRecords += 1
    } else batchById.set(batchId, row)
  }
  for (const [batchId, row] of batchById) {
    if (batchConflicts.has(batchId)) continue
    const payload = object(row.payload_json)
    for (const [field, label] of Object.entries(batchMarkers)) if (payload[field] !== undefined && payload[field] !== null) {
      const atUnix = time(payload[field]); if (atUnix === null) continue
      addEvent({ id: `batch:${batchId}:${field}`, kind: 'batch_marker', label, atUnix, apparatus: string(row.apparatus), nodeId: string(payload.stage_node_id), actor: string(row.worker_display_name) || string(row.worker_ref),
        fromState: null, toState: null, transition: false, note: 'Partiyadagi saqlangan vaqt belgisi; to‘liq WIP holat tarixi emas.', issue: false, batchId, sessionId: string(row.session_id) })
    }
  }
  const closedAtUnix = acceptedClosed ? time(closed.completed_at_unix) : null
  if (closedAtUnix !== null) addEvent({ id: `closed:${orderId}`, kind: 'closed', label: isRecord(closed.early_close) ? 'Buyurtma erta yopilgan' : 'Buyurtma yakuni qayd etilgan',
    atUnix: closedAtUnix, apparatus: '', nodeId: '', actor: string(closed.closed_by_display_name) || string(closed.closed_by_ref), fromState: null, toState: null, transition: false,
    note: string(object(closed.early_close).comment), issue: false, batchId: '', sessionId: '' })

  if (input.snapshot) for (const stage of stages.values()) {
    const control = object(input.snapshot.queue_action_controls?.[stage.apparatus]?.[orderId])
    const matching = control.stage_node_id === stage.nodeId
    const stageState = state(input.snapshot.stage_states?.[orderId]?.[stage.nodeId])
    const queueState = state(input.snapshot.queue_states?.[stage.apparatus]?.[orderId])
    const agreedControl = matching && state(control.state) === queueState && queueState !== null
    stage.currentState = stageState === 'pending' && agreedControl && ['in_progress', 'print_preflight', 'paused'].includes(queueState!) ? queueState : stageState ?? (agreedControl ? queueState : null)
    if (matching && control.last_worked_at_unix !== undefined && control.last_worked_at_unix !== 0) {
      const atUnix = time(control.last_worked_at_unix)
      if (atUnix !== null) {
        stage.lastActivityAtUnix = atUnix
        addEvent({ id: `last_activity:${stage.key}`, kind: 'last_activity', label: 'Oxirgi saqlangan faollik', atUnix, apparatus: stage.apparatus, nodeId: stage.nodeId,
          actor: '', fromState: null, toState: null, transition: false, note: 'Joriy holatga kirish vaqti emas.', issue: false, batchId: '', sessionId: '' })
      }
    }
  }
  // Preserve response order for same-second events; an invented ordering cannot
  // establish elapsed time at either side of an ambiguous timestamp.
  events.sort((a, b) => a.atUnix - b.atUnix || a.responseIndex - b.responseIndex)
  for (const stage of stages.values()) {
    const history = events.filter(event => event.stageKey === stage.key && event.kind === 'queue')
    stage.eventIds = events.filter(event => event.stageKey === stage.key).map(event => event.id)
    stage.lastRecordedState = history.at(-1)?.toState ?? null
    if (source !== 'closed_order') continue
    const timestampCounts = new Map<number, number>()
    for (const event of history) timestampCounts.set(event.atUnix, (timestampCounts.get(event.atUnix) ?? 0) + 1)
    const barriers = events.filter(event => (event.kind === 'queue' && event.stageKey !== stage.key || event.kind === 'freeze' || event.kind === 'transfer') &&
      (!event.apparatus || event.apparatus === stage.apparatus)).map(event => event.atUnix)
    let barrierIndex = 0
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1], next = history[index]
      if (next.atUnix <= previous.atUnix) continue
      while (barrierIndex < barriers.length && barriers[barrierIndex] < previous.atUnix) barrierIndex += 1
      const reason: ManufacturingGap['reason'] | null = conflictOrderChronology || conflictApparatus.has(stage.apparatus) || conflictKeys.has(stage.key) ? 'conflict' : invalidOrderChronology || invalidKeys.has(stage.key) || invalidApparatus.has(stage.apparatus) ? 'inconsistent' :
        (timestampCounts.get(previous.atUnix) ?? 0) > 1 || (timestampCounts.get(next.atUnix) ?? 0) > 1 ? 'same_second' :
        !previous.transition || !next.transition || previous.toState !== next.fromState ? 'inconsistent' :
        barrierIndex < barriers.length && barriers[barrierIndex] <= next.atUnix ? 'unattributed' : null
      if (reason) stage.gaps.push({ startUnix: previous.atUnix, endUnix: next.atUnix, reason })
      else if (previous.toState) stage.intervals.push({ startUnix: previous.atUnix, endUnix: next.atUnix, state: previous.toState, startEventId: previous.id, endEventId: next.id })
    }
    stage.recordedSeconds = manufacturingUnionSeconds(stage.intervals)
    stage.inProgressSeconds = manufacturingUnionSeconds(stage.intervals.filter(interval => interval.state === 'in_progress'))
    stage.pausedSeconds = manufacturingUnionSeconds(stage.intervals.filter(interval => interval.state === 'paused'))
  }
  const stageValues = [...stages.values()]
  const gapCount = stageValues.reduce((total, stage) => total + stage.gaps.length, 0)
  const unattributedEvents = events.filter(event => event.kind !== 'closed' && event.stageKey === null).length
  if (source === 'batch_lineage') issues.add('Bu partiya zanjiri tarixi. Zanjir to‘liq bo‘lsa ham, buyurtmaning barcha holat almashishlari olinmaydi.')
  if (source === 'snapshot_only' || source === 'unavailable') issues.add('Joriy holat tarixiy boshlanish vaqti emas. Vaqt oralig‘ini hisoblash uchun holat almashish tarixi olinmagan.')
  if (unattributedEvents) issues.add('Bosqichsiz yoki mos uskuna identifikatorisiz yozuvlar vaqt hisobiga qo‘shilmadi.')
  if (gapCount) issues.add('Mos kelmagan, bir soniyada qayd etilgan yoki bosqichsiz hodisalar orasidagi vaqt baholanmadi.')
  if (discardedRecords) issues.add('Noto‘g‘ri, kelajakdagi yoki boshqa buyurtmaga tegishli yozuvlar chiqarildi.')
  if (conflictingRecords) issues.add('Takrorlangan identifikatorli yozuvlar o‘zaro mos emas; tegishli vaqt hisoblari chiqarildi.')
  const window = events.length ? { startUnix: events[0].atUnix, endUnix: events.at(-1)!.atUnix } : null
  return { orderId, orderNumber: string(acceptedClosed ? closed.order_number : map?.order_number), title: string(acceptedClosed ? closed.title : map?.title) || orderId,
    source, asOfUnix, fresh: input.fresh !== false, orderControlState: input.snapshot && saved ? productionOrderControlState(input.snapshot, orderId) : null,
    earlyClosed: acceptedClosed && isRecord(closed.early_close), hasIssue: events.some(event => event.issue), closedAtUnix, window, observedWindowSeconds: events.length > 1 && window ? window.endUnix - window.startUnix : null,
    events: events.map(({ responseIndex: _, ...event }) => event), stages: stageValues,
    coverage: { logsReceived: rawLogs.length, duplicateRecords, discardedRecords, conflictingRecords, unattributedEvents, gapCount,
      measuredStageCount: stageValues.filter(stage => stage.recordedSeconds !== null).length, lineageComplete: acceptedReport && typeof report.lineage_complete === 'boolean' ? report.lineage_complete : null, issues: [...issues] } }
}

export function manufacturingDurationLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86_400), hours = Math.floor(seconds % 86_400 / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60
  if (days) return `${days} kun ${hours} soat`
  if (hours) return `${hours} soat ${minutes} daq`
  if (minutes) return `${minutes} daq ${remainder} son`
  return `${remainder} son`
}
export function manufacturingTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
export function manufacturingTimeLabel(unix: number | null, timeZone = manufacturingTimeZone()): string {
  if (manufacturingUnix(unix) === null) return '—'
  try { return new Intl.DateTimeFormat('uz-UZ', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(unix! * 1000)) } catch { return '—' }
}
export function manufacturingEventPosition(unix: number, window: ManufacturingWindow): number {
  if (window.endUnix <= window.startUnix) return .5
  return Math.max(0, Math.min(1, (unix - window.startUnix) / (window.endUnix - window.startUnix)))
}
export function manufacturingNextEventIndex(selectedIndex: number, count: number, direction: number): number {
  if (count < 1) return -1
  if (selectedIndex < 0) return 0
  return Math.max(0, Math.min(count - 1, selectedIndex + direction))
}
export function manufacturingZoomWindow(window: ManufacturingWindow, extent: ManufacturingWindow, factor: number, centerUnix?: number): ManufacturingWindow {
  const total = extent.endUnix - extent.startUnix
  if (total <= 0 || !Number.isFinite(factor) || factor <= 0) return { ...extent }
  const width = Math.min(total, Math.max(Math.min(60, total), Math.round((window.endUnix - window.startUnix) * factor)))
  const center = centerUnix ?? (window.startUnix + window.endUnix) / 2
  const startUnix = Math.max(extent.startUnix, Math.min(extent.endUnix - width, Math.round(center - width / 2)))
  return { startUnix, endUnix: startUnix + width }
}

export interface ManufacturingRanking {
  orderId: string
  orderNumber: string
  title: string
  stageKey: string
  stageTitle: string
  apparatus: string
  inProgressSeconds: number
  gapCount: number
  earlyClosed: boolean
  hasIssue: boolean
}
/** Rankings describe the loaded retained cohort, never the whole factory or all-time productivity. */
export function manufacturingOverview(timelines: readonly ManufacturingTimeline[]) {
  const unique = new Map<string, ManufacturingTimeline>()
  for (const timeline of timelines) if (timeline.source === 'closed_order' && timeline.orderId) {
    const existing = unique.get(timeline.orderId)
    if (!existing || (timeline.asOfUnix ?? 0) > (existing.asOfUnix ?? 0)) unique.set(timeline.orderId, timeline)
  }
  const orders = [...unique.values()]
  const eligibleOrders = orders.filter(timeline => timeline.coverage.measuredStageCount > 0)
  const rankings: ManufacturingRanking[] = orders.flatMap(timeline => timeline.stages.flatMap(stage => stage.inProgressSeconds !== null ? [{ orderId: timeline.orderId, orderNumber: timeline.orderNumber, title: timeline.title,
    stageKey: stage.key, stageTitle: stage.title, apparatus: stage.apparatus, inProgressSeconds: stage.inProgressSeconds, gapCount: stage.gaps.length, earlyClosed: timeline.earlyClosed === true, hasIssue: timeline.hasIssue === true }] : []))
    .sort((a, b) => b.inProgressSeconds - a.inProgressSeconds || a.orderId.localeCompare(b.orderId) || a.stageKey.localeCompare(b.stageKey))
  return { loadedOrders: orders.length, eligibleOrders: eligibleOrders.length, excludedOrders: orders.length - eligibleOrders.length,
    ordersWithGaps: orders.filter(timeline => timeline.coverage.measuredStageCount === 0 || timeline.coverage.gapCount > 0 || timeline.coverage.unattributedEvents > 0 || timeline.coverage.discardedRecords > 0 || timeline.coverage.conflictingRecords > 0).length,
    rankings }
}
