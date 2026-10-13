import type { ProductionSnapshot, Row } from './api-types'
import type { ProductionMapDefinition, ProductionMapNode } from './production-map'
import { factoryModelObjectAliases } from './factory-map-model'

const record = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()) : []
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const key = (value: unknown) => text(value).toLowerCase()

export const factoryMapFreshnessMs = 30_000
export const factoryMapPollMs = 15_000

export interface FactoryApparatus {
  id: string
  name: string
  objectId: string
  active: boolean
  revision: number
  row: Row
}

/** Preserve the same physical identities as Mobile V2, including known coincident copies. */
export function canonicalFactoryMapObjectId(value: string): string {
  const id = value.trim()
  const modelObject = factoryModelObjectAliases.get(id)
  if (modelObject) return modelObject
  if (/^(node:7|node:20):instance:[0-7]$/.test(id)) return id.replace(/:instance:\d+$/, '')
  return id.replace(/^node:33(?=:instance:\d+$|$)/, 'node:39')
}

export function factoryMapApparatus(row: Row): FactoryApparatus {
  const projection = Object.keys(record(row.runtime_projection)).length ? record(row.runtime_projection) : row
  return {
    id: text(projection.apparatus_id),
    name: text(record(projection.display).display_name),
    objectId: canonicalFactoryMapObjectId(text(record(projection.placement).factory_map_object_id)),
    active: (text(record(projection.lifecycle).state) || (projection.active === false ? 'retired' : 'active')) === 'active',
    revision: typeof projection.source_revision === 'number' && Number.isSafeInteger(projection.source_revision) ? projection.source_revision : 0,
    row,
  }
}

export function factoryMapObjectOwners(apparatus: readonly Row[], objectId: string): FactoryApparatus[] {
  const target = canonicalFactoryMapObjectId(objectId)
  return target ? apparatus.map(factoryMapApparatus).filter(item => item.objectId === target) : []
}

export function resolveFactoryMapApparatus(apparatus: readonly Row[], objectId: string): FactoryApparatus | null {
  const owners = factoryMapObjectOwners(apparatus, objectId)
  return owners.length === 1 ? owners[0] : null
}

export function unboundFactoryMapApparatus(apparatus: readonly Row[]): FactoryApparatus[] {
  return apparatus.map(factoryMapApparatus).filter(item => item.active && !item.objectId)
}

export function hasLegacyFactoryMapBinding(apparatus: readonly Row[], objectId: string): boolean {
  if (resolveFactoryMapApparatus(apparatus, objectId)) return false
  const base = /^(.*):instance:\d+$/.exec(objectId.trim())?.[1]
  return Boolean(base && apparatus.map(factoryMapApparatus).some(item => item.objectId === canonicalFactoryMapObjectId(base)))
}

export function validateFactoryMapPlacement(currentRow: Row, observedRow: Row, apparatus: readonly Row[], targetObjectId: string): FactoryApparatus {
  const current = factoryMapApparatus(currentRow)
  const observed = factoryMapApparatus(observedRow)
  const target = canonicalFactoryMapObjectId(targetObjectId)
  if (!current.id || current.id !== observed.id || current.revision < 1) throw new Error('Aparatning joriy revisioni topilmadi. Ma’lumotni yangilang.')
  if (current.objectId !== observed.objectId && current.objectId !== target) throw new Error('Aparat bog‘lanishi boshqa joyda o‘zgartirilgan. Ma’lumotni yangilang.')
  if (target && !current.active) throw new Error('Faol bo‘lmagan aparatni xaritaga ulab bo‘lmaydi.')
  if (target && apparatus.map(factoryMapApparatus).some(item => item.id !== current.id && item.objectId === target)) throw new Error('Bu obyektga boshqa aparat ulangan.')
  return current
}

export const factoryMapStatuses = {
  print_preflight: { label: 'Bosma tayyorlash', color: '#7e86a8' },
  print_preflight_passed: { label: 'Bosmaga tayyor', color: '#568326' },
  in_progress: { label: 'Ishlamoqda', color: '#278263' },
  paused: { label: 'To‘xtatilgan', color: '#b37b22' },
  frozen: { label: 'Muzlatilgan', color: '#c62828' },
  wip_ready: { label: 'WIP tayyor', color: '#278263' },
  wip_waiting: { label: 'WIP tayyorligi kutilmoqda', color: '#b37b22' },
  wip_produced: { label: 'WIP ishlab chiqarilgan', color: '#81618b' },
  wip_available: { label: 'WIP mavjud', color: '#81618b' },
  wip_received: { label: 'WIP qabul qilingan', color: '#81618b' },
  waiting_wip: { label: 'WIP kutilmoqda', color: '#597ba3' },
  requeued_ready: { label: 'Davom ettirishga tayyor', color: '#278263' },
  requeued_waiting: { label: 'Davom ettirish kutilmoqda', color: '#b37b22' },
  pending: { label: 'Navbatda', color: '#597ba3' },
  completed: { label: 'Yakunlangan', color: '#77827d' },
  idle: { label: 'Bo‘sh', color: '#77827d' },
  unknown: { label: 'Holat noma’lum', color: '#8b8984' },
} as const
export type FactoryMapStatus = keyof typeof factoryMapStatuses
const queueStates = new Set(['pending', 'print_preflight', 'in_progress', 'paused', 'frozen', 'completed'])
const currentWork = new Set<FactoryMapStatus>(['in_progress', 'print_preflight', 'print_preflight_passed', 'paused'])
const ready = new Set<FactoryMapStatus>(['wip_ready', 'requeued_ready'])
const actionModes: Record<string, string[]> = {
  start: ['fresh_start'], resume: ['requeued_ready', 'paused'], pause: ['in_progress', 'freeze_requested'],
  detach_roll: ['in_progress', 'freeze_requested'], merge: ['in_progress'], roll_complete: ['in_progress'],
  complete: ['in_progress'], freeze: ['in_progress', 'freeze_requested'],
}
const stateModes: Record<string, string[]> = {
  pending: ['fresh_start', 'fresh_start_blocked', 'requeued_waiting', 'requeued_ready', 'waiting_previous_stage'],
  print_preflight: ['fresh_start', 'fresh_start_blocked', 'freeze_requested'],
  in_progress: ['in_progress', 'freeze_requested'], paused: ['paused', 'freeze_requested'], frozen: ['frozen'], completed: ['completed'],
}

const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
function validRezkaControl(control: Row, allowed: string[]): boolean {
  const lineage = rows(control.rezka_input_lineage)
  const batchIds = new Set<string>()
  const sequenceNos = new Set<number>()
  let activeBatch = ''
  if ('rezka_input_lineage' in control) {
    if (!Array.isArray(control.rezka_input_lineage)) return false
    for (const link of lineage) {
      const batch = text(link.input_batch_id)
      if (!batch || !positiveInt(link.sequence_no) || !['in_use', 'processed'].includes(key(link.status)) ||
          !['progress_batch', 'opening_wip'].includes(key(link.source_kind)) || batchIds.has(batch) || sequenceNos.has(link.sequence_no)) return false
      batchIds.add(batch)
      sequenceNos.add(link.sequence_no)
      if (link.status === 'in_use') { if (activeBatch) return false; activeBatch = batch }
    }
    if (allowed.includes('merge') && !activeBatch) return false
  }
  if ('rezka_active_partial_rolls' in control) {
    if (!Array.isArray(control.rezka_active_partial_rolls)) return false
    const slots = new Set<number>()
    for (const roll of rows(control.rezka_active_partial_rolls)) {
      const sources = strings(roll.source_input_batch_ids)
      if (!positiveInt(roll.slot_index) || !positiveInt(roll.generation) || !positiveInt(roll.contained_kadr_count) ||
          roll.status !== 'active' || !Array.isArray(roll.source_input_batch_ids) || sources.length !== roll.source_input_batch_ids.length ||
          new Set(sources).size !== sources.length || slots.has(roll.slot_index) || sources.some(id => !batchIds.has(id)) ||
          (activeBatch ? !sources.includes(activeBatch) : sources.length > 0)) return false
      slots.add(roll.slot_index)
    }
  }
  if ('rezka_output_kadr_counts' in control && (!Array.isArray(control.rezka_output_kadr_counts) || !control.rezka_output_kadr_counts.every(positiveInt))) return false
  if (control.rezka_output_report !== undefined && control.rezka_output_report !== null) {
    const report = record(control.rezka_output_report)
    if (!text(report.cycle_id) || !Array.isArray(report.frames)) return false
    const frames = new Set<number>()
    const batches = new Set<string>()
    for (const slot of rows(report.frames)) {
      const input = record(slot.input)
      const note = input.issue_note
      const batch = text(slot.batch_id)
      const qr = text(slot.qr_payload)
      if (!positiveInt(slot.frame_index) || frames.has(slot.frame_index) || !slot.input || typeof slot.input !== 'object' || Array.isArray(slot.input) ||
          (note !== undefined && note !== null && typeof note !== 'string') ||
          (text(note) ? Boolean(batch || qr) : !batch || !qr || batches.has(batch)) ||
          slot.frame_index > (Array.isArray(control.rezka_output_kadr_counts) ? control.rezka_output_kadr_counts.length : 0)) return false
      frames.add(slot.frame_index)
      if (batch) batches.add(batch)
    }
  }
  return true
}

/** Never label malformed or contradictory server action contracts as work ready to start. */
function consistentControl(control: Row, queueState: string, orderControl: string): boolean {
  const interaction = record(control.interaction)
  const mode = text(interaction.mode)
  const state = key(control.state)
  const allowed = strings(control.allowed_actions)
  if (typeof control.state !== 'string' || !Array.isArray(control.allowed_actions) || allowed.length !== control.allowed_actions.length ||
      typeof control.previous_stage_ready !== 'boolean' || typeof control.complete_requires_full_report !== 'boolean' ||
      !stateModes[state]?.includes(mode) || (queueState && state !== queueState)) return false
  if (!['hidden', 'scan_required'].includes(text(interaction.start_materials_mode)) ||
      !['not_required', 'scan_required', 'waiting'].includes(text(interaction.previous_wip_mode)) ||
      (interaction.opening_wip_mode !== undefined && !['not_required', 'scan_required', 'waiting'].includes(text(interaction.opening_wip_mode))) ||
      !['not_required', 'scan_required'].includes(text(interaction.qolip_mode)) ||
      ['material_scan_required', 'assigned_materials_display_only', 'material_intake_allowed'].some(field => typeof interaction[field] !== 'boolean')) return false
  if ((interaction.start_materials_mode === 'scan_required') !== interaction.material_scan_required) return false
  const previousWip = text(interaction.previous_wip_mode)
  const openingWip = text(interaction.opening_wip_mode) || 'not_required'
  if (previousWip !== 'not_required' && !text(control.previous_stage)) return false
  if (openingWip !== 'not_required' && previousWip !== 'not_required' && !(openingWip === 'scan_required' && previousWip === 'scan_required')) return false
  if (allowed.some(action => !(action === 'complete' && mode === 'paused' && text(control.closing_output_batch_id)) && !actionModes[action]?.includes(mode))) return false
  if (!validRezkaControl(control, allowed)) return false
  if (text(control.closing_output_batch_id) && (state !== 'paused' || mode !== 'paused' || !allowed.includes('complete'))) return false
  const expected = mode === 'fresh_start' ? ['start'] : mode === 'requeued_ready' ? ['resume'] :
    mode === 'freeze_requested' ? state === 'in_progress' ? ['pause'] : state === 'print_preflight' ? ['freeze'] : [] :
    ['fresh_start_blocked', 'requeued_waiting', 'frozen', 'completed', 'waiting_previous_stage'].includes(mode) ? [] : null
  if (expected && (new Set(allowed).size !== expected.length || expected.some(action => !allowed.includes(action)))) return false
  if (mode === 'in_progress' && !allowed.includes('pause')) return false
  if (['fresh_start_blocked', 'requeued_waiting', 'waiting_previous_stage'].includes(mode) && !text(interaction.blocking_reason_code)) return false
  if ('print_preflight' in control) {
    const preflight = record(control.print_preflight)
    if (['hold_id', 'idempotency_key', 'order_id', 'apparatus'].some(field => !text(preflight[field])) ||
        !['held', 'running', 'passed', 'failed', 'cancelled', 'consumed'].includes(key(preflight.status))) return false
    if (['held', 'running'].includes(key(preflight.status)) && (state !== 'print_preflight' ||
      !(mode === 'freeze_requested' && allowed.length === 1 && allowed.includes('freeze')) && (mode !== 'fresh_start_blocked' || allowed.length > 0))) return false
  }
  if (mode === 'freeze_requested') {
    const request = record(control.freeze_request)
    if (!text(request.request_id) || key(request.status) !== 'pending' || !text(request.target_apparatus) ||
        (state !== 'print_preflight' && !text(request.target_session_id))) return false
  }
  if (orderControl === 'frozen') return mode === 'frozen' && allowed.length === 0
  if (mode === 'frozen' || state === 'frozen') return false
  return orderControl === 'freeze_requested' ? mode === 'freeze_requested' : mode !== 'freeze_requested'
}

export function productionQueueDisplayStatus(queueState: string | undefined, control?: Row, orderControl = 'active', lifecycle = ''): FactoryMapStatus {
  if (['production_completed', 'closed', 'cancelled'].includes(lifecycle)) return 'completed'
  if (orderControl === 'frozen') return 'frozen'
  const raw = key(queueState) || key(control?.state) || 'pending'
  if (control && !consistentControl(control, key(queueState), orderControl)) return 'unknown'
  const interaction = record(control?.interaction)
  const mode = text(interaction.mode)
  if (mode === 'requeued_ready' || mode === 'requeued_waiting') return mode
  if (raw === 'pending' && Object.keys(interaction).length) {
    if (interaction.previous_wip_mode === 'scan_required' || interaction.opening_wip_mode === 'scan_required') return strings(control?.allowed_actions).includes('start') ? 'wip_ready' : 'wip_waiting'
    if (interaction.previous_wip_mode === 'waiting' || interaction.opening_wip_mode === 'waiting') return 'waiting_wip'
  }
  if (raw === 'print_preflight' && record(control?.print_preflight).status === 'passed') return 'print_preflight_passed'
  return queueStates.has(raw) ? raw as FactoryMapStatus : 'unknown'
}

function orderControl(snapshot: ProductionSnapshot, orderId: string): string {
  return text(record(snapshot.order_controls[orderId]).state) || 'active'
}
function queueControl(snapshot: ProductionSnapshot, apparatusId: string, orderId: string): Row | undefined {
  return snapshot.queue_action_controls[apparatusId]?.[orderId]
}
export function factoryMapOrderStatus(snapshot: ProductionSnapshot | null, apparatusId: string, orderId: string): FactoryMapStatus {
  if (!snapshot) return 'unknown'
  if (!snapshot.queue_states[apparatusId]?.[orderId] && !queueControl(snapshot, apparatusId, orderId) && !['production_completed', 'closed', 'cancelled'].includes(text(snapshot.order_statuses[orderId]?.lifecycle_status)) && orderControl(snapshot, orderId) !== 'frozen') return 'unknown'
  return productionQueueDisplayStatus(snapshot.queue_states[apparatusId]?.[orderId], queueControl(snapshot, apparatusId, orderId), orderControl(snapshot, orderId), text(snapshot.order_statuses[orderId]?.lifecycle_status))
}

export function factoryMapQueueOrderIds(snapshot: ProductionSnapshot | null, apparatusId: string): string[] {
  if (!snapshot) return []
  const visible = [...new Set(strings(record(snapshot.visible_order_ids)[apparatusId]))]
  const visibleSet = new Set(visible)
  return [...new Set([...(snapshot.sequences[apparatusId] || []).map(id => id.trim()).filter(id => visibleSet.has(id)), ...visible.reverse()])]
}
export interface FactoryMachineStatus { state: FactoryMapStatus; orderId: string }
export function factoryMapMachineStatus(snapshot: ProductionSnapshot | null, apparatusId: string): FactoryMachineStatus {
  if (!snapshot) return { state: 'unknown', orderId: '' }
  if (!snapshot.visible_order_ids || typeof snapshot.visible_order_ids !== 'object' || Array.isArray(snapshot.visible_order_ids)) return { state: 'unknown', orderId: '' }
  const candidates = factoryMapQueueOrderIds(snapshot, apparatusId).map(orderId => ({ state: factoryMapOrderStatus(snapshot, apparatusId, orderId), orderId }))
    .filter(item => !['frozen', 'completed'].includes(item.state) && (orderControl(snapshot, item.orderId) !== 'freeze_requested' || currentWork.has(item.state)))
  for (const state of ['in_progress', 'print_preflight', 'print_preflight_passed', 'paused']) {
    const candidate = candidates.find(item => item.state === state)
    if (candidate) return candidate
  }
  return candidates.find(item => ready.has(item.state)) || candidates[0] || { state: 'idle', orderId: '' }
}

/** A repeated machine occurrence must not inherit another stage's queue status. */
export function productionMapStageQueueState(map: ProductionMapDefinition, node: ProductionMapNode, orderId: string, snapshot: ProductionSnapshot): string | null {
  if (node.kind !== 'apparatus') return null
  const stageRaw = key(snapshot.stage_states[orderId]?.[node.id])
  const stage = queueStates.has(stageRaw) ? stageRaw : null
  const apparatus = !text(node.alternative_group_id) && text(node.alternative_assigned_apparatus_id) ? text(node.alternative_assigned_apparatus_id) : text(node.apparatus_id)
  const control = queueControl(snapshot, apparatus, orderId)
  const occurrence = text(control?.stage_node_id)
  const group = text(node.alternative_group_id)
  const matches = occurrence === node.id || Boolean(group && map.nodes.some(candidate => candidate.id === occurrence && text(candidate.alternative_group_id) === group))
  const unique = map.nodes.filter(candidate => candidate.kind === 'apparatus' && text(candidate.apparatus_id) === apparatus).length === 1
  const queueRaw = occurrence ? matches ? key(snapshot.queue_states[apparatus]?.[orderId]) || key(control?.state) : '' : unique ? key(snapshot.queue_states[apparatus]?.[orderId]) || key(control?.state) : ''
  const queue = queueStates.has(queueRaw) ? queueRaw : null
  return stage === 'pending' && ['in_progress', 'print_preflight', 'paused'].includes(queue || '') ? queue : stage || queue
}

export function productionMapLiveStageNode(map: ProductionMapDefinition, node: ProductionMapNode, orderId: string, snapshot: ProductionSnapshot): ProductionMapNode {
  const group = text(node.alternative_group_id)
  if (node.kind !== 'apparatus' || !group) return node
  const ranks: Record<string, number> = { in_progress: 6, print_preflight: 5, paused: 4, completed: 3, frozen: 2, pending: 1 }
  const rank = (candidate: ProductionMapNode) => ranks[productionMapStageQueueState(map, candidate, orderId, snapshot) || ''] || 0
  return map.nodes.filter(candidate => candidate.kind === 'apparatus' && text(candidate.alternative_group_id) === group).reduce((selected, candidate) => rank(candidate) > rank(selected) ? candidate : selected, node)
}

export interface FactoryStageWipFacts { produced?: number; waitingInput?: number; inUseInput?: number; processedInput?: number }
export function productionMapStageDisplayStatus(map: ProductionMapDefinition, node: ProductionMapNode, queueState: string | null, control?: Row, orderState = 'active', wip: FactoryStageWipFacts = {}): FactoryMapStatus {
  if (queueState === 'completed') return 'completed'
  if (orderState === 'frozen') return 'frozen'
  const controlNode = text(control?.stage_node_id)
  const group = text(node.alternative_group_id)
  if (controlNode && controlNode !== node.id && !(group && map.nodes.some(candidate => candidate.kind === 'apparatus' && candidate.id === controlNode && text(candidate.alternative_group_id) === group)) ||
      !controlNode && map.nodes.filter(candidate => candidate.kind === 'apparatus' && text(candidate.apparatus_id) === text(node.apparatus_id)).length > 1) control = undefined
  const status = queueState === null && !control ? 'unknown' : productionQueueDisplayStatus(queueState || undefined, control, orderState)
  if (['pending', 'unknown', 'waiting_wip'].includes(status)) {
    if ((wip.produced || 0) > 0) return 'wip_produced'
    if ((wip.inUseInput || 0) + (wip.processedInput || 0) > 0) return 'wip_received'
    if ((wip.waitingInput || 0) > 0) return 'wip_available'
  }
  return status
}

export interface FactoryConnection { from: string; to: string }
export function plannedFactoryMapConnections(map: Row | undefined, objectByApparatus: ReadonlyMap<string, string>): FactoryConnection[] {
  if (!map) return []
  const nodes = rows(map.nodes)
  const edges = rows(map.edges)
  const lookup = new Map(nodes.map(node => [text(node.id), node]))
  const machine = (node: Row | undefined) => text(node?.alternative_assigned_apparatus_id) || text(node?.apparatus_id)
  const objectFor = (id: string) => objectByApparatus.get(machine(lookup.get(id)))
  const connections = new Map<string, FactoryConnection>()
  for (const node of nodes) {
    const from = objectFor(text(node.id))
    if (!from) continue
    const visited = new Set([text(node.id)])
    const pending = [text(node.id)]
    while (pending.length) {
      const current = pending.pop()
      for (const edge of edges.filter(edge => edge.from === current)) {
        const id = text(edge.to)
        if (!id || visited.has(id)) continue
        visited.add(id)
        const to = objectFor(id)
        if (to) {
          if (to !== from) connections.set(JSON.stringify([from, to]), { from, to })
        } else if (lookup.has(id) && !machine(lookup.get(id))) pending.push(id)
      }
    }
  }
  return [...connections.values()]
}

function uniqueObjectMap(apparatus: readonly Row[]): Map<string, string> {
  const candidates = apparatus.map(factoryMapApparatus).filter(item => item.id && item.objectId)
  const counts = new Map<string, number>()
  for (const item of candidates) counts.set(item.objectId, (counts.get(item.objectId) || 0) + 1)
  return new Map(candidates.filter(item => counts.get(item.objectId) === 1).map(item => [item.id, item.objectId]))
}
export interface FactoryLiveMachine extends FactoryMachineStatus {
  objectId: string
  apparatusId: string
  name: string
  statusLabel: string
  statusColor: string
  orderLabel: string
  orderNumber: string
}
export interface FactoryLivePayload {
  fresh: boolean
  validUntil: number
  machines: FactoryLiveMachine[]
  unknownLabel: string
  routeLabel: string
  connections: FactoryConnection[]
}

export interface FactoryMapListObject { objectId: string; label: string; aliases?: readonly string[] }
export type FactoryMapListFilter = 'all' | 'working' | 'attention' | 'unbound'

interface FactoryMapFocusState { focusedObjectId: string; resetRevision: number }
/** The native renderer handles camera reset before focus clearing; clear first. */
export function factoryMapRendererCommands<T extends FactoryMapFocusState>(state: T, previous: FactoryMapFocusState | undefined, refocus = false): T[] {
  if (previous?.focusedObjectId && (!state.focusedObjectId && state.resetRevision !== previous.resetRevision || refocus && state.focusedObjectId === previous.focusedObjectId)) {
    return [{ ...state, focusedObjectId: '', resetRevision: previous.resetRevision }, state]
  }
  return [state]
}

/** Search visible names, persisted CAD aliases, and current order metadata. */
export function filterFactoryMapObjects<T extends FactoryMapListObject>(objects: readonly T[], apparatus: readonly Row[], machines: readonly FactoryLiveMachine[], search: string, filter: FactoryMapListFilter = 'all'): T[] {
  const needle = search.trim().toLocaleLowerCase('uz')
  return objects.filter(object => {
    const owners = factoryMapObjectOwners(apparatus, object.objectId)
    const machine = machines.find(item => item.objectId === canonicalFactoryMapObjectId(object.objectId))
    const matchesFilter = filter === 'all' || filter === 'unbound' && owners.length === 0 || filter === 'working' && ['in_progress', 'print_preflight', 'print_preflight_passed'].includes(machine?.state ?? '') || filter === 'attention' && (owners.length > 1 || owners.length > 0 && ['paused', 'frozen', 'unknown'].includes(machine?.state ?? 'unknown'))
    return matchesFilter && [object.label, object.objectId, ...(object.aliases ?? []), ...owners.map(item => item.name), machine?.orderLabel, machine?.statusLabel].filter(Boolean).join(' ').toLocaleLowerCase('uz').includes(needle)
  })
}

/** The canvas offers the same physical objects as the accessible apparatus list. */
export function factoryMapKeyboardObject<T extends FactoryMapListObject>(objects: readonly T[], selectedObjectId: string, key: string): T | undefined {
  if (!objects.length) return undefined
  const index = objects.findIndex(object => canonicalFactoryMapObjectId(object.objectId) === canonicalFactoryMapObjectId(selectedObjectId))
  if (key === 'Home') return objects[0]
  if (key === 'End') return objects[objects.length - 1]
  if (key === 'Enter' || key === ' ') return objects[Math.max(index, 0)]
  if (key === 'ArrowRight' || key === 'ArrowDown') return objects[(index + 1) % objects.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return objects[index < 0 ? objects.length - 1 : (index + objects.length - 1) % objects.length]
  return undefined
}
export function factoryLivePayload(snapshot: ProductionSnapshot | null, apparatus: readonly Row[], receivedAt: number, focusedObjectId = '', failed = false, now = Date.now()): FactoryLivePayload {
  const fresh = Boolean(snapshot && !failed && receivedAt > 0 && now >= receivedAt && now - receivedAt < factoryMapFreshnessMs)
  const objects = uniqueObjectMap(apparatus)
  const orderMaps = new Map((snapshot?.maps || []).map(saved => [text(saved.map.id), saved.map]))
  let focusedOrder = ''
  const machines = apparatus.map(factoryMapApparatus).flatMap(item => {
    const objectId = objects.get(item.id)
    if (!objectId) return []
    const machine = factoryMapMachineStatus(snapshot, item.id)
    const state: FactoryMapStatus = fresh ? machine.state : 'unknown'
    if (objectId === canonicalFactoryMapObjectId(focusedObjectId)) focusedOrder = machine.orderId
    const order = orderMaps.get(machine.orderId)
    const orderNumber = text(order?.order_number)
    return [{ objectId, apparatusId: item.id, name: item.name, state, statusLabel: factoryMapStatuses[state].label, statusColor: factoryMapStatuses[state].color, orderId: machine.orderId, orderLabel: order ? [orderNumber ? `#${orderNumber}` : text(order.id), text(order.title)].filter(Boolean).join(' · ') : machine.orderId, orderNumber }]
  })
  return { fresh, validUntil: fresh ? receivedAt + factoryMapFreshnessMs : 0, machines, unknownLabel: factoryMapStatuses.unknown.label, routeLabel: 'Buyurtmaning rejalashtirilgan yo‘li', connections: plannedFactoryMapConnections(orderMaps.get(focusedOrder), objects) }
}

export interface FactoryStockSnapshot { locations: Row[]; rolls: Map<string, string[]>; receivedAt: number }
export interface FactoryStockPile { stateId: string; name: string; objectIds: string[]; rollIds: string[]; count: number }
export interface FactoryStockPayload { fresh: boolean; validUntil: number; piles: FactoryStockPile[]; rollLabel: string; unknownLabel: string; noSpaceLabel: string }

/** Qty measures weight/length. Each available physical asset row contributes exactly one roll. */
export function stateRollInventory(assets: readonly Row[], locations: readonly Row[], items: readonly Row[], groups: readonly Row[]): Map<string, string[]> {
  const tree = new Map<string, Row>()
  for (const group of groups) { tree.set(key(group.name), group); tree.set(key(group.item_group_name), group) }
  const isRoll = (value: unknown): boolean => {
    let current = key(value)
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      if (current === 'rulon') return true
      const group = tree.get(current)
      if (!group) return false
      if (key(group.name) === 'rulon' || key(group.item_group_name) === 'rulon') return true
      current = key(group.parent_item_group)
    }
    return false
  }
  const catalog = new Map(items.map(item => [key(item.code), item]))
  const stateIds = new Set(locations.filter(location => location.kind === 'state' && location.active !== false).map(location => text(location.id)))
  const rolls = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const asset of assets) {
    const placement = record(asset.physical_location)
    const stateId = text(placement.id)
    if (asset.kind !== 'raw_material' || key(asset.status) !== 'available' || text(asset.transfer_id) ||
        typeof asset.qty !== 'number' || !Number.isFinite(asset.qty) || asset.qty <= 0 || placement.kind !== 'state' || !stateIds.has(stateId)) continue
    const item = catalog.get(key(asset.item_code))
    if (!item) throw new Error('Rulon mahsuloti katalogda topilmadi. Rulonlar soni noma’lum.')
    if (!isRoll(item.item_group)) continue
    const id = text(asset.asset_ref)
    if (!id || seen.has(key(id))) throw new Error('Fizik rulon identifikatori takrorlangan. Rulonlar soni noma’lum.')
    seen.add(key(id))
    rolls.set(stateId, [...(rolls.get(stateId) || []), id])
  }
  for (const ids of rolls.values()) ids.sort()
  return rolls
}

export function factoryStockPayload(snapshot: FactoryStockSnapshot | null, apparatus: readonly Row[], failed = false, now = Date.now()): FactoryStockPayload {
  const fresh = Boolean(snapshot && !failed && snapshot.receivedAt > 0 && now >= snapshot.receivedAt && now - snapshot.receivedAt < factoryMapFreshnessMs)
  const objects = uniqueObjectMap(apparatus)
  const piles = (snapshot?.locations || []).filter(location => location.kind === 'state' && location.active !== false)
    .toSorted((left, right) => text(left.id).localeCompare(text(right.id))).flatMap(location => {
      const objectIds = [...new Set(rows(location.apparatus).map(item => objects.get(text(item.id))).filter((id): id is string => Boolean(id)))].sort()
      if (!objectIds.length) return []
      const stateId = text(location.id)
      const rollIds = snapshot?.rolls.get(stateId) || []
      return [{ stateId, name: text(location.name), objectIds, rollIds, count: rollIds.length }]
    })
  return { fresh, validUntil: fresh && snapshot ? snapshot.receivedAt + factoryMapFreshnessMs : 0, piles, rollLabel: 'rulon', unknownLabel: 'Rulonlar soni noma’lum', noSpaceLabel: 'Xaritada joy yetarli emas' }
}
