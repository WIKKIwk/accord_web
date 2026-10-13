import { describe, expect, it } from 'vitest'
import type { ProductionSnapshot, Row } from './api-types'
import { factoryStageForObject, factoryStageOrderChoices, factoryStageRoute } from './factory-stage-navigation'
// @ts-expect-error The shipped browser renderer is native JavaScript, outside src.
import { createFactoryStageView } from '../../public/factory-map/factory-map-stage-view.js'

const orderId = 'order:stage-1', firstId = 'apparatus:default:print-1', secondId = 'apparatus:default:cut-1', thirdId = 'apparatus:default:print-2'
const node = (id: string, apparatusId: string, patch: Row = {}) => ({ id, kind: 'apparatus', title: id, x: 0, y: 0, apparatus_id: apparatusId, ...patch })
const start = { id: 'start', kind: 'start', title: 'Boshlash', x: 0, y: 0 }, end = { id: 'end', kind: 'end', title: 'Tugash', x: 0, y: 0 }
const map = (nodes = [node('cut', secondId), node('print', firstId)], edges = [{ from: 'start', to: 'cut' }, { from: 'cut', to: 'print' }, { from: 'print', to: 'end' }]) => ({ id: orderId, title: 'Film', order_number: 'Q-15', product_code: 'film', nodes: [end, ...nodes.reverse(), start], edges })
const apparatus = (id: string, objectId: string, operation: string, name: string): Row => ({ apparatus_id: id, source_revision: 2, display: { display_name: name }, lifecycle: { state: 'active' }, execution_profile: { operation }, placement: { factory_map_object_id: objectId } })
const catalog = [apparatus(firstId, 'node:1:instance:0', 'print', 'Bosma A'), apparatus(secondId, 'node:20', 'cut', 'Rezka A'), apparatus(thirdId, 'node:3:instance:0', 'print', 'Bosma B')]
const objects = [{ objectId: 'node:1:instance:0', label: 'Bosma A' }, { objectId: 'node:20', label: 'Rezka' }, { objectId: 'node:3:instance:0', label: 'Bosma B' }]
const snapshot = (definition = map(), patch: Row = {}): ProductionSnapshot => ({ ok: true, rev: 1, epoch: 'epoch', scope: 'all', maps: [{ map: definition, program: {} }], order_statuses: { [orderId]: { lifecycle_status: 'in_progress', order_status: 'in_progress', work_status: 'in_progress', flow_status: 'in_progress' } }, order_customers: {}, sequences: {}, queue_states: {}, stage_states: { [orderId]: { cut: 'completed', print: 'in_progress' } }, queue_action_controls: {}, order_controls: {}, ...patch })

describe('actual order route stage navigation', () => {
  it('derives graph order even when source nodes are shuffled and process order is unusual', () => {
    const route = factoryStageRoute(snapshot(), orderId, catalog, objects, true)
    expect(route.stages.map(stage => stage.nodeId)).toEqual(['cut', 'print'])
    expect(route.stages.map(stage => stage.operation)).toEqual(['cut', 'print'])
    expect(route.stages.map(stage => stage.objectId)).toEqual(['node:20', 'node:1:instance:0'])
    expect(route.stages.map(stage => stage.activeExecution)).toEqual([false, true])
    expect(route.orderLabel).toBe('№ Q-15 · Film')
  })

  it('preserves repeated apparatus occurrences and exact per-stage state', () => {
    const definition = map([node('first-print', firstId), node('second-print', firstId)], [{ from: 'start', to: 'first-print' }, { from: 'first-print', to: 'second-print' }, { from: 'second-print', to: 'end' }])
    const state = snapshot(definition, { stage_states: { [orderId]: { 'first-print': 'completed', 'second-print': 'in_progress' } } })
    const route = factoryStageRoute(state, orderId, catalog, objects, true)
    expect(route.stages.map(stage => stage.key)).toEqual(['node:first-print', 'node:second-print'])
    expect(route.stages.map(stage => stage.state)).toEqual(['completed', 'in_progress'])
    expect(factoryStageForObject(route.stages, 'node:1:instance:3').key).toBe('node:second-print')
    expect(factoryStageForObject(route.stages, 'node:1:instance:0', 'node:first-print').key).toBe('node:first-print')
    const pending = factoryStageRoute(snapshot(definition, { stage_states: { [orderId]: { 'first-print': 'pending', 'second-print': 'pending' } } }), orderId, catalog, objects, true)
    expect(factoryStageForObject(pending.stages, 'node:1:instance:0')).toMatchObject({ key: '', issue: expect.stringContaining('bir nechta') })
  })

  it('does not borrow the queue head state for an unidentified repeated occurrence', () => {
    const definition = map([node('first-print', firstId), node('second-print', firstId)], [{ from: 'start', to: 'first-print' }, { from: 'first-print', to: 'second-print' }, { from: 'second-print', to: 'end' }])
    const state = snapshot(definition, { stage_states: {}, queue_states: { [firstId]: { [orderId]: 'in_progress' } } })
    const route = factoryStageRoute(state, orderId, catalog, objects, true)
    expect(route.stages.every(stage => stage.state === 'unknown' && !stage.activeExecution)).toBe(true)
  })

  it('groups actual alternatives without assigning the first pending candidate', () => {
    const definition = map([node('a', firstId, { alternative_group_id: 'bosma', alternative_group_label: 'Bosma tanlovi' }), node('b', thirdId, { alternative_group_id: 'bosma', alternative_group_label: 'Bosma tanlovi' })], [{ from: 'start', to: 'a' }, { from: 'start', to: 'b' }, { from: 'a', to: 'end' }, { from: 'b', to: 'end' }])
    const route = factoryStageRoute(snapshot(definition, { stage_states: { [orderId]: { a: 'pending', b: 'pending' } } }), orderId, catalog, objects, true)
    expect(route.stages).toHaveLength(1)
    expect(route.stages[0]).toMatchObject({ key: 'group:bosma', apparatusId: '', objectId: '', state: 'unknown', alternative: true, activeExecution: false })
    expect(route.stages[0].candidateNames).toEqual(['Bosma A', 'Bosma B'])
    const assigned = structuredClone(definition)
    for (const member of assigned.nodes) if (member.kind === 'apparatus') Object.assign(member, { alternative_assigned_apparatus_id: thirdId })
    const selected = factoryStageRoute(snapshot(assigned, { stage_states: { [orderId]: { a: 'pending', b: 'in_progress' } } }), orderId, catalog, objects, true)
    expect(selected.stages[0]).toMatchObject({ nodeId: 'b', apparatusId: thirdId, apparatusName: 'Bosma B', objectId: 'node:3:instance:0', activeExecution: true })
  })

  it('resolves an executing alternative from native stage evidence and rejects conflicting evidence', () => {
    const definition = map([node('a', firstId, { alternative_group_id: 'group' }), node('b', thirdId, { alternative_group_id: 'group' })], [{ from: 'start', to: 'a' }, { from: 'start', to: 'b' }, { from: 'a', to: 'end' }, { from: 'b', to: 'end' }])
    const chosen = factoryStageRoute(snapshot(definition, { stage_states: { [orderId]: { a: 'pending', b: 'paused' } } }), orderId, catalog, objects, true)
    expect(chosen.stages[0]).toMatchObject({ apparatusId: thirdId, state: 'paused', activeExecution: false })
    const conflict = factoryStageRoute(snapshot(definition, { stage_states: { [orderId]: { a: 'in_progress', b: 'in_progress' } } }), orderId, catalog, objects, true)
    expect(conflict.stages[0]).toMatchObject({ apparatusId: '', objectId: '', state: 'unknown' })
    expect(conflict.stages[0].issue).toContain('bir nechta')
  })

  it('retains condition branches without claiming a runtime branch choice', () => {
    const condition = { id: 'condition', kind: 'condition', title: 'Shart', x: 0, y: 0 }
    const definition = { ...map(), nodes: [start, condition, node('cut', secondId), node('print', firstId), end], edges: [{ from: 'start', to: 'condition' }, { from: 'condition', to: 'print', branch: 'true' }, { from: 'condition', to: 'cut', branch: 'false' }, { from: 'print', to: 'end' }, { from: 'cut', to: 'end' }] }
    const route = factoryStageRoute(snapshot(definition), orderId, catalog, objects, true)
    expect(route.stages).toHaveLength(2)
    expect(route.stages.every(stage => stage.branch)).toBe(true)
  })

  it('fails closed for cycles, dangling edges, duplicate nodes, disconnected stages and missing maps', () => {
    const definitions = [map(undefined, [{ from: 'start', to: 'cut' }, { from: 'cut', to: 'print' }, { from: 'print', to: 'cut' }]), map(undefined, [{ from: 'start', to: 'missing' }]), map([node('cut', secondId), node('cut', firstId)]), map(undefined, [{ from: 'start', to: 'print' }, { from: 'print', to: 'end' }])]
    for (const definition of definitions) { const route = factoryStageRoute(snapshot(definition), orderId, catalog, objects, true); expect(route.stages).toEqual([]); expect(route.issue).not.toBe('') }
    expect(factoryStageRoute(snapshot(), 'order:missing', catalog, objects, true).stages).toEqual([])
    expect(factoryStageRoute(null, orderId, catalog, objects, false).stages).toEqual([])
  })

  it('never isolates a nonexistent, unbound or multiply owned model object', () => {
    const unbound = catalog.map(item => item.apparatus_id === firstId ? { ...item, placement: null } : item)
    expect(factoryStageRoute(snapshot(), orderId, unbound, objects, true).stages[1].objectId).toBe('')
    const conflict = [...catalog, apparatus('apparatus:default:other', 'node:1:instance:0', 'print', 'Other')]
    const route = factoryStageRoute(snapshot(), orderId, conflict, objects, true)
    expect(route.stages[1].objectId).toBe('')
    expect(route.stages[1].issue).toContain('bir nechta')
    expect(factoryStageRoute(snapshot(), orderId, catalog, objects.slice(1), true).stages[1].objectId).toBe('')
  })

  it('keeps stale/unknown, frozen, terminal and retired stages out of confirmed motion', () => {
    const stale = factoryStageRoute(snapshot(), orderId, catalog, objects, false)
    expect(stale.stages.every(stage => stage.state === 'unknown' && !stage.activeExecution)).toBe(true)
    const frozen = factoryStageRoute(snapshot(map(), { order_controls: { [orderId]: { state: 'frozen' } } }), orderId, catalog, objects, true)
    expect(frozen.stages.every(stage => !stage.activeExecution)).toBe(true)
    const terminal = factoryStageRoute(snapshot(map(), { order_statuses: { [orderId]: { lifecycle_status: 'closed', order_status: 'completed' } } }), orderId, catalog, objects, true)
    expect(terminal.stages.every(stage => !stage.activeExecution)).toBe(true)
    const retired = catalog.map(item => item.apparatus_id === firstId ? { ...item, lifecycle: { state: 'retired' } } : item)
    expect(factoryStageRoute(snapshot(), orderId, retired, objects, true).stages[1].activeExecution).toBe(false)
    for (const orderStatuses of [{}, { [orderId]: { lifecycle_status: 'unknown', order_status: 'in_progress' } }, { [orderId]: { lifecycle_status: 'in_progress', order_status: 'unknown' } }]) {
      const unknown = factoryStageRoute(snapshot(map(), { order_statuses: orderStatuses }), orderId, catalog, objects, true)
      expect(unknown.stages.every(stage => stage.state === 'unknown' && !stage.activeExecution)).toBe(true)
    }
  })

  it('takes choices only from identified current maps, keeping identities across matching titles', () => {
    const value = snapshot(); value.maps.push({ map: { ...map(), id: 'order:stage-2' }, program: {} })
    expect(factoryStageOrderChoices(value).map(choice => choice.id)).toEqual([orderId, 'order:stage-2'])
    value.maps.push(value.maps[0])
    expect(factoryStageOrderChoices(value).map(choice => choice.id)).toEqual(['order:stage-2'])
  })
})

interface VisibleNode { visible: boolean; userData: Record<string, unknown>; parent: VisibleNode | null; children: VisibleNode[]; isInstancedMesh?: boolean; count?: number; material?: unknown; traverse: (visit: (object: VisibleNode) => void) => void }
function tree(children: VisibleNode[] = [], patch: Partial<VisibleNode> = {}): VisibleNode {
  const node: VisibleNode = { visible: true, userData: {}, parent: null, children, traverse(visit) { visit(this); for (const child of this.children) child.traverse(visit) }, ...patch }
  for (const child of children) child.parent = node
  return node
}
describe('same-scene apparatus isolation and overview restoration', () => {
  it('keeps every original CAD material unchanged through isolation and overview restoration', () => {
    class Color {
      r: number; g: number; b: number
      constructor(r: number, g = r, b = r) { this.r = r; this.g = g; this.b = b }
      clone() { return new Color(this.r, this.g, this.b) }
      copy(value: Color) { this.r = value.r; this.g = value.g; this.b = value.b; return this }
      multiplyScalar(value: number) { this.r *= value; this.g *= value; this.b *= value; return this }
    }
    const texture = {}, surface = { isMeshBasicMaterial: true, color: new Color(.9, .85, .8), opacity: .26, map: texture, vertexColors: true }, contours = { isMeshBasicMaterial: true, color: new Color(.008) }, lit = { color: new Color(.9) }
    const first = tree([tree([], { material: [surface, contours, lit] }), tree([], { material: surface })]), second = tree([], { material: surface }), root = tree([first, second])
    const target = (id: string) => ({ object: id === 'first' ? first : second, instanceId: null })
    const view = createFactoryStageView(root, target)
    view.setObject('first')
    expect([surface.color.r, surface.color.g, surface.color.b]).toEqual([.9, .85, .8])
    expect(contours.color.r).toBe(.008); expect(lit.color.r).toBe(.9)
    expect(surface.opacity).toBe(.26); expect(surface.map).toBe(texture); expect(surface.vertexColors).toBe(true)
    view.setObject('first'); expect(surface.color.r).toBe(.9)
    view.setObject('second'); expect(surface.color.r).toBe(.9)
    view.restore(); expect([surface.color.r, surface.color.g, surface.color.b]).toEqual([.9, .85, .8])
    createFactoryStageView(root, target).setObject('first'); expect(surface.color.r).toBe(.9)
  })
  it('shows only the actual apparatus subtree and restores every original visibility bit', () => {
    const part = tree(), first = tree([part]), second = tree([tree()]), hidden = tree([], { visible: false }), ground = tree()
    const root = tree([first, second, hidden, ground]), targets = { first: { object: first, instanceId: null }, second: { object: second, instanceId: null } }
    const view = createFactoryStageView(root, (id: keyof typeof targets) => targets[id])
    expect(view.setObject('first')).toMatchObject({ isolated: 'first' })
    expect(first.visible && part.visible).toBe(true)
    expect(second.visible || ground.visible || hidden.visible).toBe(false)
    view.setObject('second')
    expect(first.visible).toBe(false); expect(second.visible).toBe(true)
    expect(view.setObject('second').changed).toBe(false)
    view.setObject('')
    expect(root.children.map(child => child.visible)).toEqual([true, true, false, true])
  })

  it('exposes exact originals rather than a shared static batch containing unrelated machines', () => {
    const batch = tree(), original = tree([], { visible: false, userData: { factoryMapRenderProxy: batch } }), machine = tree([original]), other = tree(), root = tree([machine, other, batch])
    const view = createFactoryStageView(root, () => ({ object: machine, instanceId: null }))
    view.setObject('machine')
    expect(machine.visible && original.visible).toBe(true)
    expect(batch.visible || other.visible).toBe(false)
    view.restore()
    expect(original.visible).toBe(false); expect(batch.visible).toBe(true)
  })

  it('reuses the deduplicated instanced apparatus proxy and never invents an unresolved target', () => {
    const proxy = tree([], { isInstancedMesh: true, count: 1 }), original = tree([], { isInstancedMesh: true, count: 8, visible: false, userData: { factoryMapRenderProxy: proxy } }), other = tree(), root = tree([original, proxy, other])
    const view = createFactoryStageView(root, (id: string) => id === 'rezka' ? { object: original, instanceId: null } : null)
    view.setObject('rezka')
    expect(proxy.visible).toBe(true); expect(original.visible || other.visible).toBe(false)
    expect(view.setObject('unknown').isolated).toBe('')
    expect(root.children.map(child => child.visible)).toEqual([false, true, true])
  })
})
