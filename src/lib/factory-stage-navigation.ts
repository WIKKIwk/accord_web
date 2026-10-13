import { isRecord } from './api'
import type { ProductionSnapshot, Row } from './api-types'
import { canonicalFactoryMapObjectId, factoryMapApparatus, factoryMapStatuses, productionMapStageDisplayStatus, productionMapStageQueueState } from './factory-map'
import type { FactoryMapListObject, FactoryMapStatus } from './factory-map'
import { productionOrderControlState } from './production-controls'
import { productionMapFromRow } from './production-map'
import type { ProductionMapDefinition, ProductionMapNode } from './production-map'

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const canonicalApparatus = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^apparatus:[a-z0-9._-]+:[a-z0-9._-]+$/.test(value)
const executionStates = new Set(['in_progress', 'print_preflight', 'paused', 'completed'])

export interface FactoryRouteStage {
  key: string
  index: number
  nodeId: string
  nodeIds: string[]
  title: string
  operation: string
  apparatusId: string
  apparatusName: string
  objectId: string
  candidateApparatusIds: string[]
  candidateNames: string[]
  state: FactoryMapStatus
  statusLabel: string
  activeExecution: boolean
  alternative: boolean
  branch: boolean
  issue: string
}
export interface FactoryStageRoute {
  orderId: string
  orderLabel: string
  map: ProductionMapDefinition | null
  stages: FactoryRouteStage[]
  issue: string
  fresh: boolean
}
export interface FactoryStageObjectSelection { key: string; issue: string }

/** The graph supplies order; parallel condition paths remain labelled branches. */
function orderedRouteNodes(map: ProductionMapDefinition): { nodes: ProductionMapNode[]; branchNodes: Set<string>; issue: string } {
  const empty = (issue: string) => ({ nodes: [], branchNodes: new Set<string>(), issue })
  const ids = map.nodes.map(node => text(node.id)), lookup = new Map(map.nodes.map(node => [node.id, node]))
  if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length || map.edges.some(edge => !lookup.has(edge.from) || !lookup.has(edge.to) || edge.from === edge.to)) return empty('Buyurtma yo‘lining tugunlari yoki bog‘lanishlari to‘liq emas.')
  const starts = map.nodes.filter(node => node.kind === 'start')
  if (starts.length !== 1) return empty('Buyurtmaning boshlanish bosqichi aniq emas.')
  const outgoing = new Map<string, typeof map.edges>()
  for (const node of map.nodes) outgoing.set(node.id, [])
  for (const edge of map.edges) outgoing.get(edge.from)!.push(edge)
  const reachable = new Set<string>(), branchNodes = new Set<string>(), pending: { id: string; branch: boolean }[] = [{ id: starts[0].id, branch: false }]
  while (pending.length) {
    const next = pending.shift()!
    if (next.branch) branchNodes.add(next.id)
    if (reachable.has(next.id)) continue
    reachable.add(next.id)
    const node = lookup.get(next.id)!, edges = outgoing.get(next.id)!
    for (const edge of edges) pending.push({ id: edge.to, branch: next.branch || node.kind === 'condition' || Boolean(text(edge.branch)) })
  }
  if (map.nodes.some(node => node.kind === 'apparatus' && !reachable.has(node.id))) return empty('Buyurtma yo‘lida uzilgan apparat bosqichi bor.')
  const counts = new Map<string, number>()
  for (const id of reachable) counts.set(id, map.edges.filter(edge => edge.to === id && reachable.has(edge.from)).length)
  const ready = map.nodes.filter(node => reachable.has(node.id) && counts.get(node.id) === 0), ordered: ProductionMapNode[] = []
  while (ready.length) {
    const node = ready.shift()!; ordered.push(node)
    for (const edge of outgoing.get(node.id)!) {
      if (!reachable.has(edge.to)) continue
      counts.set(edge.to, counts.get(edge.to)! - 1)
      if (counts.get(edge.to) === 0) ready.push(lookup.get(edge.to)!)
    }
  }
  if (ordered.length !== reachable.size) return empty('Buyurtma yo‘lida aylana bor. Bosqich tartibi tasdiqlanmadi.')
  return { nodes: ordered.filter(node => node.kind === 'apparatus'), branchNodes, issue: '' }
}

function actualGroupNode(nodes: ProductionMapNode[], snapshot: ProductionSnapshot, orderId: string): { node: ProductionMapNode | null; apparatusId: string; issue: string } {
  const assigned = [...new Set(nodes.map(node => text(node.alternative_assigned_apparatus_id)).filter(Boolean))]
  if (assigned.length > 1 || assigned.some(id => !canonicalApparatus(id)) || assigned.length && nodes.length > 1 && !nodes.some(node => node.apparatus_id === assigned[0])) return { node: null, apparatusId: '', issue: 'Muqobil apparat biriktirishlari o‘zaro mos emas.' }
  if (assigned.length) {
    const node = nodes.find(node => node.apparatus_id === assigned[0]) ?? nodes[0]
    return { node, apparatusId: assigned[0], issue: '' }
  }
  if (nodes.length === 1) return canonicalApparatus(nodes[0].apparatus_id) ? { node: nodes[0], apparatusId: nodes[0].apparatus_id!, issue: '' } : { node: null, apparatusId: '', issue: 'Bosqichda canonical apparat identifikatori yo‘q.' }
  const executing = nodes.filter(node => {
    const raw = text(snapshot.stage_states[orderId]?.[node.id])
    const control = snapshot.queue_action_controls[text(node.apparatus_id)]?.[orderId]
    return executionStates.has(raw) || isRecord(control) && control.stage_node_id === node.id && executionStates.has(text(control.state))
  })
  const identities = [...new Set(executing.map(node => text(node.apparatus_id)))]
  if (identities.length === 1 && canonicalApparatus(identities[0])) return { node: executing[0], apparatusId: identities[0], issue: '' }
  if (identities.length > 1) return { node: null, apparatusId: '', issue: 'Muqobil bosqichda bir nechta apparatning ish holati bor. Tanlov tasdiqlanmadi.' }
  // A pending group is not an assignment to its first candidate.
  return { node: null, apparatusId: '', issue: 'Bu bosqich uchun muqobil apparat hali tanlanmagan.' }
}

export function factoryStageRoute(snapshot: ProductionSnapshot | null, orderId: string, apparatusRows: readonly Row[], modelObjects: readonly FactoryMapListObject[], fresh: boolean): FactoryStageRoute {
  const empty: FactoryStageRoute = { orderId, orderLabel: orderId, map: null, stages: [], issue: '', fresh }
  if (!snapshot || !orderId) return { ...empty, issue: orderId ? 'Buyurtma yo‘li hali yuklanmagan.' : 'Buyurtmani tanlab uning haqiqiy bosqichlarini ko‘ring.' }
  const saved = snapshot.maps.filter(saved => saved.map.id === orderId)
  if (saved.length !== 1) return { ...empty, issue: 'Tanlangan buyurtma joriy xaritalarda topilmadi.' }
  let map: ProductionMapDefinition
  try { map = productionMapFromRow(saved[0]) } catch { return { ...empty, issue: 'Buyurtma xaritasi to‘liq kelmadi.' } }
  const orderLabel = [text(map.order_number || map.code) ? `№ ${text(map.order_number || map.code)}` : orderId, text(map.title)].filter(Boolean).join(' · ')
  const ordered = orderedRouteNodes(map)
  if (ordered.issue) return { ...empty, map, orderLabel, issue: ordered.issue }
  const catalog = apparatusRows.map(factoryMapApparatus), objects = new Set(modelObjects.map(object => canonicalFactoryMapObjectId(object.objectId)))
  const groups = new Map<string, ProductionMapNode[]>()
  for (const node of ordered.nodes) { const key = text(node.alternative_group_id) ? `group:${text(node.alternative_group_id)}` : `node:${node.id}`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(node) }
  const controlState = productionOrderControlState(snapshot, orderId), lifecycle = text(snapshot.order_statuses[orderId]?.lifecycle_status), orderStatus = text(snapshot.order_statuses[orderId]?.order_status)
  const knownOrder = ['released', 'in_progress', 'production_completed', 'closed', 'cancelled'].includes(lifecycle) && ['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'frozen', 'waiting_next_stage', 'partially_completed', 'completed', 'completed_with_issue'].includes(orderStatus)
  const terminal = ['production_completed', 'closed', 'cancelled'].includes(lifecycle)
  const stages = [...groups].map(([key, nodes], index): FactoryRouteStage => {
    const actual = actualGroupNode(nodes, snapshot, orderId), apparatusMatches = catalog.filter(item => item.id === actual.apparatusId), apparatus = apparatusMatches.length === 1 ? apparatusMatches[0] : undefined
    const objectId = apparatus?.objectId ?? '', owners = objectId ? catalog.filter(item => item.objectId === objectId) : []
    const candidateApparatusIds = [...new Set(nodes.map(node => text(node.apparatus_id)).filter(canonicalApparatus))]
    let issue = actual.issue
    if (!issue && !apparatus) issue = apparatusMatches.length > 1 ? 'Apparat identifikatori bir nechta yozuvda takrorlangan.' : 'Bosqich apparati ERP ro‘yxatida topilmadi.'
    if (!issue && !objectId) issue = 'Bu bosqichning apparati hali 3D modelga biriktirilmagan.'
    if (!issue && (owners.length !== 1 || !objects.has(objectId))) issue = owners.length !== 1 ? '3D obyektga bir nechta apparat biriktirilgan.' : 'Biriktirilgan 3D obyekt bu modelda topilmadi.'
    const node = actual.node, raw = node ? productionMapStageQueueState(map, node, orderId, snapshot) : null
    const control = actual.apparatusId ? snapshot.queue_action_controls[actual.apparatusId]?.[orderId] : undefined
    const state: FactoryMapStatus = fresh && knownOrder && node && controlState !== 'unknown' && !actual.issue ? productionMapStageDisplayStatus(map, node, raw, control, controlState) : 'unknown'
    const exactExecuting = Boolean(node && (snapshot.stage_states[orderId]?.[node.id] === 'in_progress' || nodes.some(member => member.id === control?.stage_node_id) && control?.state === 'in_progress'))
    return { key, index, nodeId: node?.id ?? '', nodeIds: nodes.map(node => node.id), title: text(nodes[0].alternative_group_label) || text(node?.title) || text(nodes[0].title) || `Bosqich ${index + 1}`, operation: text(apparatus && (isRecord(apparatus.row.runtime_projection) ? isRecord(apparatus.row.runtime_projection.execution_profile) ? apparatus.row.runtime_projection.execution_profile.operation : '' : isRecord(apparatus.row.execution_profile) ? apparatus.row.execution_profile.operation : '')), apparatusId: actual.apparatusId, apparatusName: apparatus?.name ?? '', objectId: !issue ? objectId : '', candidateApparatusIds, candidateNames: candidateApparatusIds.map(id => catalog.find(item => item.id === id)?.name || id), state, statusLabel: factoryMapStatuses[state].label, activeExecution: fresh && !terminal && apparatus?.active === true && controlState !== 'frozen' && controlState !== 'unknown' && state === 'in_progress' && exactExecuting, alternative: nodes.length > 1 || Boolean(text(nodes[0].alternative_group_id)), branch: nodes.some(node => ordered.branchNodes.has(node.id)), issue }
  })
  return { orderId, orderLabel, map, stages, issue: stages.length ? '' : 'Buyurtma yo‘lida apparat bosqichlari yo‘q.', fresh }
}

/** Physical taps cannot fabricate which repeated occurrence is being viewed. */
export function factoryStageForObject(stages: readonly FactoryRouteStage[], objectId: string, viewedKey = ''): FactoryStageObjectSelection {
  const id = canonicalFactoryMapObjectId(objectId)
  if (!id) return { key: '', issue: '3D obyekt tanlanmagan.' }
  const matches = stages.filter(stage => stage.objectId === id)
  const viewed = matches.find(stage => stage.key === viewedKey)
  if (viewed) return { key: viewed.key, issue: '' }
  if (matches.length === 1) return { key: matches[0].key, issue: '' }
  const active = matches.filter(stage => stage.activeExecution)
  if (active.length === 1) return { key: active[0].key, issue: '' }
  return { key: '', issue: matches.length ? 'Apparat bu buyurtmada bir nechta bosqichda qatnashadi. Kerakli bosqichni pastdan tanlang.' : 'Bu apparat tanlangan buyurtmaning tasdiqlangan yo‘liga kirmaydi.' }
}

export function factoryStageOrderChoices(snapshot: ProductionSnapshot | null): { id: string; label: string }[] {
  const counts = new Map<string, number>()
  for (const saved of snapshot?.maps ?? []) { const id = text(saved.map.id); if (id) counts.set(id, (counts.get(id) ?? 0) + 1) }
  return (snapshot?.maps ?? []).filter(saved => counts.get(text(saved.map.id)) === 1).map(saved => ({ id: text(saved.map.id), label: [text(saved.map.order_number || saved.map.code) ? `№ ${text(saved.map.order_number || saved.map.code)}` : text(saved.map.id), text(saved.map.title)].filter(Boolean).join(' · ') }))
}
