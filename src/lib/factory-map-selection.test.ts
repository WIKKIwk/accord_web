import { describe, expect, it } from 'vitest'
import type { ProductionSnapshot, Row } from './api-types'
import { factoryMapIsolatedObjectId } from './factory-map-selection'
import { factoryStageForObject, factoryStageRoute } from './factory-stage-navigation'

const printId = 'node:1:instance:0', laminateId = 'node:6:instance:6', cutId = 'node:18:instance:0'
const apparatus: Row[] = [
  { apparatus_id: 'apparatus:qa:print', lifecycle: { state: 'active' }, placement: { factory_map_object_id: printId } },
  { apparatus_id: 'apparatus:qa:laminate', lifecycle: { state: 'active' }, placement: { factory_map_object_id: laminateId } },
  { apparatus_id: 'apparatus:qa:cut', lifecycle: { state: 'active' }, placement: { factory_map_object_id: cutId } },
]
const objects = [printId, laminateId, cutId].map(objectId => ({ objectId, label: objectId }))
const snapshot: ProductionSnapshot = {
  ok: true, rev: 1, epoch: 'qa-selection', scope: 'all',
  maps: [{ map: { id: 'order:print-only', nodes: [
    { id: 'start', kind: 'start', title: 'Start', x: 0, y: 0 },
    { id: 'print', kind: 'apparatus', title: 'Print', apparatus_id: 'apparatus:qa:print', x: 0, y: 1 },
    { id: 'end', kind: 'end', title: 'End', x: 0, y: 2 },
  ], edges: [{ from: 'start', to: 'print' }, { from: 'print', to: 'end' }] }, program: {} }],
  order_statuses: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {},
}

describe('direct CAD apparatus selection independently of the viewed order route', () => {
  it('isolates A → B → C → A → B when only A belongs to the retained order route', () => {
    const route = factoryStageRoute(snapshot, 'order:print-only', apparatus, objects, true)
    expect(route.stages.map(stage => stage.objectId)).toEqual([printId])
    for (const objectId of [printId, laminateId, cutId, printId, laminateId]) {
      const step = factoryStageForObject(route.stages, objectId)
      const viewed = route.stages.find(stage => stage.key === step.key)
      expect(factoryMapIsolatedObjectId('apparatus', objectId, viewed)).toBe(objectId)
      if (objectId !== printId) expect(step.key).toBe('')
    }
  })

  it('isolates a physical apparatus with no order or route stage', () => {
    const route = factoryStageRoute(null, '', apparatus, objects, false)
    expect(route.stages).toEqual([])
    expect(factoryMapIsolatedObjectId('apparatus', 'node:18:instance:2')).toBe('node:18:instance:2')
  })

  it('preserves canonical physical aliases across repeated direct selections', () => {
    expect(factoryMapIsolatedObjectId('apparatus', 'node:1:instance:7')).toBe(printId)
    expect(factoryMapIsolatedObjectId('apparatus', 'node:6:instance:14')).toBe(laminateId)
    expect(factoryMapIsolatedObjectId('apparatus', 'node:1:instance:3')).toBe(printId)
  })

  it('explicit overview clears isolation even if a prior selected identity is still present', () => {
    expect(factoryMapIsolatedObjectId('overview', printId, { objectId: printId })).toBe('')
    expect(factoryMapIsolatedObjectId('apparatus', '')).toBe('')
  })

  it('keeps explicit unbound, removed, or rebound route stages from isolating an obsolete apparatus', () => {
    expect(factoryMapIsolatedObjectId('stage', printId, { objectId: printId })).toBe(printId)
    expect(factoryMapIsolatedObjectId('stage', printId, { objectId: '' })).toBe('')
    expect(factoryMapIsolatedObjectId('stage', printId)).toBe('')
    expect(factoryMapIsolatedObjectId('stage', printId, { objectId: laminateId })).toBe('')
    expect(factoryMapIsolatedObjectId('stage', '', { objectId: printId })).toBe('')
  })

  it('keeps a direct selection isolated when its former route stage is removed or rebound', () => {
    expect(factoryMapIsolatedObjectId('apparatus', printId)).toBe(printId)
    expect(factoryMapIsolatedObjectId('apparatus', printId, { objectId: laminateId })).toBe(printId)
  })
})
