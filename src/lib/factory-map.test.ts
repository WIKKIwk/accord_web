import { describe, expect, it } from 'vitest'
import type { ProductionSnapshot, Row } from './api-types'
import type { ProductionMapDefinition, ProductionMapNode } from './production-map'
import {
  canonicalFactoryMapObjectId, factoryLivePayload, factoryMapApparatus, factoryMapMachineStatus,
  factoryMapObjectOwners, factoryMapQueueOrderIds, factoryStockPayload, plannedFactoryMapConnections,
  productionMapLiveStageNode, productionMapStageDisplayStatus, productionMapStageQueueState, productionQueueDisplayStatus,
  resolveFactoryMapApparatus, stateRollInventory, unboundFactoryMapApparatus, validateFactoryMapPlacement,
} from './factory-map'

const apparatus = (id = 'apparatus:first', object = 'node:7', patch: Row = {}): Row => ({
  apparatus_id: id, source_revision: 3, display: { display_name: id }, lifecycle: { state: 'active' },
  placement: object ? { factory_map_object_id: object } : null, ...patch,
})
const interaction = (mode = 'in_progress', patch: Row = {}): Row => ({
  mode, start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: true,
  material_intake_allowed: false, previous_wip_mode: 'not_required', qolip_mode: 'not_required', ...patch,
})
const control = (state = 'in_progress', mode = state, patch: Row = {}): Row => ({
  state, allowed_actions: ['pause'], interaction: interaction(mode), previous_stage_ready: true,
  complete_requires_full_report: false, ...patch,
})
const snapshot = (patch: Row = {}): ProductionSnapshot => ({
  ok: true, rev: 10, epoch: 'epoch', scope: '', maps: [], order_statuses: {}, order_customers: {},
  sequences: { 'apparatus:first': ['order:first'] }, visible_order_ids: { 'apparatus:first': ['order:first'] },
  queue_states: { 'apparatus:first': { 'order:first': 'in_progress' } }, stage_states: {},
  queue_action_controls: { 'apparatus:first': { 'order:first': control() } }, order_controls: {}, ...patch,
})
const node = (id: string, apparatusId = 'apparatus:first', patch: Row = {}): ProductionMapNode => ({
  id, kind: 'apparatus', title: id, x: 0, y: 0, apparatus_id: apparatusId, ...patch,
})
const map = (nodes: ProductionMapNode[], edges: ProductionMapDefinition['edges'] = []): ProductionMapDefinition => ({
  id: 'order:first', product_code: 'film', title: 'Film', nodes, edges,
})

describe('native physical bindings', () => {
  it('canonicalizes only the verified mobile attachment and coincident-instance aliases', () => {
    expect(canonicalFactoryMapObjectId(' node:33 ')).toBe('node:39')
    expect(canonicalFactoryMapObjectId('node:33:instance:2')).toBe('node:39:instance:2')
    expect(canonicalFactoryMapObjectId('node:7:instance:7')).toBe('node:7')
    expect(canonicalFactoryMapObjectId('node:20:instance:0')).toBe('node:20')
    expect(canonicalFactoryMapObjectId('node:20:instance:8')).toBe('node:20:instance:8')
    expect(canonicalFactoryMapObjectId('node:33:custom')).toBe('node:33:custom')
  })

  it('reads a canonical runtime projection and native lifecycle fallback', () => {
    expect(factoryMapApparatus({ runtime_projection: apparatus() })).toMatchObject({
      id: 'apparatus:first', name: 'apparatus:first', objectId: 'node:7', active: true, revision: 3,
    })
    expect(factoryMapApparatus(apparatus('apparatus:first', '', { lifecycle: {}, active: false })).active).toBe(false)
    expect(factoryMapApparatus(apparatus('apparatus:first', '', { lifecycle: {} })).active).toBe(true)
  })

  it.each([
    ['node:6:instance:0', 'node:6:instance:6'],
    ['node:4:instance:14', 'node:6:instance:6'],
    ['node:6:instance:15', 'node:6:instance:7'],
    ['node:4:instance:3', 'node:6:instance:7'],
    ['node:1:instance:7', 'node:1:instance:0'],
    ['node:3:instance:6', 'node:3:instance:0'],
    ['node:18:instance:24', 'node:18:instance:3'],
    ['node:18:instance:25', 'node:18:instance:0'],
    ['node:18:instance:27', 'node:18:instance:2'],
    ['node:18:instance:26', 'node:18:instance:1'],
    ['node:19:instance:15', 'node:19:instance:1'],
    ['node:19:instance:14', 'node:19:instance:0'],
    ['equipment:rezka:5', 'equipment:rezka:5'],
  ])('uses verified adapted-model alias %s as %s', (legacy, root) => {
    expect(canonicalFactoryMapObjectId(legacy)).toBe(root)
  })

  it('resolves existing legacy placements when the adapted model emits its root identity', () => {
    const existing = apparatus('apparatus:laminatsiya', 'node:6:instance:0')
    expect(resolveFactoryMapApparatus([existing], 'node:6:instance:6')).toMatchObject({ id: 'apparatus:laminatsiya', objectId: 'node:6:instance:6' })
    expect(resolveFactoryMapApparatus([existing], 'node:4:instance:2')?.id).toBe('apparatus:laminatsiya')
    expect(resolveFactoryMapApparatus([existing], 'node:6:instance:7')).toBeNull()
  })

  it('publishes live status on the adapted root for an existing legacy-alias binding', () => {
    const payload = factoryLivePayload(snapshot(), [apparatus('apparatus:first', 'node:4:instance:0')], 1000, 'node:6:instance:6', false, 1001)
    expect(payload.machines[0]).toMatchObject({ objectId: 'node:6:instance:6', state: 'in_progress', orderId: 'order:first' })
  })

  it('refuses a new apparatus binding to a root or alias already owned through another alias', () => {
    const existing = apparatus('apparatus:laminatsiya', 'node:4:instance:0')
    const candidate = apparatus('apparatus:new', '')
    expect(() => validateFactoryMapPlacement(candidate, candidate, [candidate, existing], 'node:6:instance:6')).toThrow('boshqa aparat')
    expect(() => validateFactoryMapPlacement(candidate, candidate, [candidate, existing], 'node:4:instance:14')).toThrow('boshqa aparat')
    expect(validateFactoryMapPlacement(candidate, candidate, [candidate, existing], 'node:6:instance:7').objectId).toBe('')
  })

  it('treats two existing legacy placements in one adapted physical object as ambiguous', () => {
    const machines = [apparatus('apparatus:first', 'node:6:instance:0'), apparatus('apparatus:second', 'node:4:instance:14')]
    expect(factoryMapObjectOwners(machines, 'node:6:instance:6')).toHaveLength(2)
    expect(resolveFactoryMapApparatus(machines, 'node:6:instance:6')).toBeNull()
    expect(factoryLivePayload(snapshot(), machines, 1000, '', false, 1001).machines).toEqual([])
  })

  it('does not choose an arbitrary owner for duplicate canonical identities', () => {
    const machines = [apparatus('apparatus:first', 'node:33'), apparatus('apparatus:second', 'node:39')]
    expect(factoryMapObjectOwners(machines, 'node:39')).toHaveLength(2)
    expect(resolveFactoryMapApparatus(machines, 'node:33')).toBeNull()
    expect(factoryLivePayload(snapshot(), machines, 1000, '', false, 1001).machines).toEqual([])
  })

  it('offers only active apparatus without an existing physical binding', () => {
    const machines = [apparatus(), apparatus('apparatus:second', ''), apparatus('apparatus:retired', '', { lifecycle: { state: 'retired' } })]
    expect(unboundFactoryMapApparatus(machines).map(item => item.id)).toEqual(['apparatus:second'])
  })

  it('rejects a concurrent move and duplicate target, but accepts an already applied target', () => {
    const observed = apparatus('apparatus:first', '')
    const moved = apparatus('apparatus:first', 'node:20', { source_revision: 4 })
    expect(() => validateFactoryMapPlacement(moved, observed, [moved], 'node:7')).toThrow('o‘zgartirilgan')
    expect(validateFactoryMapPlacement(moved, observed, [moved], 'node:20').objectId).toBe('node:20')
    expect(() => validateFactoryMapPlacement(observed, observed, [observed, apparatus('apparatus:second', 'node:7')], 'node:7')).toThrow('boshqa aparat')
    expect(() => validateFactoryMapPlacement({ ...observed, source_revision: 0 }, observed, [], 'node:7')).toThrow('revisioni')
  })
})

describe('mobile queue status parity', () => {
  it('shows passed print preflight and rejects contradictory controls', () => {
    const preflight = { hold_id: 'hold', idempotency_key: 'key', order_id: 'order:first', apparatus: 'apparatus:first', status: 'passed' }
    expect(productionQueueDisplayStatus('print_preflight', control('print_preflight', 'fresh_start', { allowed_actions: ['start'], print_preflight: preflight }))).toBe('print_preflight_passed')
    expect(productionQueueDisplayStatus('pending', control())).toBe('unknown')
    expect(productionQueueDisplayStatus('in_progress', control('in_progress', 'in_progress', { allowed_actions: ['invented_action'] }))).toBe('unknown')
    expect(productionQueueDisplayStatus('pending', { state: 'pending', allowed_actions: ['start'], interaction: { mode: 'fresh_start' } })).toBe('unknown')
  })

  it('uses server start/resume permission and WIP modes without inventing readiness', () => {
    const wip = { previous_wip_mode: 'scan_required' }
    expect(productionQueueDisplayStatus('pending', control('pending', 'fresh_start', { previous_stage: 'upstream', allowed_actions: ['start'], interaction: interaction('fresh_start', wip) }))).toBe('wip_ready')
    expect(productionQueueDisplayStatus('pending', control('pending', 'fresh_start_blocked', { previous_stage: 'upstream', allowed_actions: [], interaction: interaction('fresh_start_blocked', { ...wip, blocking_reason_code: 'sequence_blocked' }) }))).toBe('wip_waiting')
    expect(productionQueueDisplayStatus('pending', control('pending', 'waiting_previous_stage', { previous_stage: 'upstream', allowed_actions: [], interaction: interaction('waiting_previous_stage', { previous_wip_mode: 'waiting', blocking_reason_code: 'wip_missing' }) }))).toBe('waiting_wip')
    expect(productionQueueDisplayStatus('pending', control('pending', 'requeued_ready', { allowed_actions: ['resume'], interaction: interaction('requeued_ready') }))).toBe('requeued_ready')
  })

  it('keeps lifecycle completion and order freeze authoritative', () => {
    expect(productionQueueDisplayStatus('in_progress', control(), 'frozen')).toBe('frozen')
    expect(productionQueueDisplayStatus('in_progress', control(), 'frozen', 'production_completed')).toBe('completed')
    expect(productionQueueDisplayStatus('pending', undefined, 'active', 'closed')).toBe('completed')
  })

  it('rejects ambiguous Rezka lineage instead of advertising valid live work', () => {
    const lineage = { input_batch_id: 'batch', sequence_no: 1, status: 'in_use', source_kind: 'progress_batch' }
    expect(productionQueueDisplayStatus('in_progress', control('in_progress', 'in_progress', { allowed_actions: ['pause', 'merge'], rezka_input_lineage: [lineage] }))).toBe('in_progress')
    expect(productionQueueDisplayStatus('in_progress', control('in_progress', 'in_progress', { allowed_actions: ['pause', 'merge'], rezka_input_lineage: [lineage, { ...lineage, sequence_no: 2 }] }))).toBe('unknown')
    expect(productionQueueDisplayStatus('in_progress', control('in_progress', 'in_progress', { rezka_output_kadr_counts: [0] }))).toBe('unknown')
  })

  it('uses only visible queue membership and appends new orders oldest first', () => {
    const live = snapshot({
      sequences: { 'apparatus:first': ['retired-order', 'order:first'] },
      visible_order_ids: { 'apparatus:first': ['newest', 'middle', 'order:first'] },
    })
    expect(factoryMapQueueOrderIds(live, 'apparatus:first')).toEqual(['order:first', 'middle', 'newest'])
    expect(factoryMapMachineStatus(snapshot({ visible_order_ids: {} }), 'apparatus:first')).toEqual({ state: 'idle', orderId: '' })
  })

  it('prioritizes current work, then a ready free-pick order', () => {
    const queued = snapshot({
      sequences: { 'apparatus:first': ['waiting', 'ready', 'running'] },
      visible_order_ids: { 'apparatus:first': ['running', 'ready', 'waiting'] },
      queue_states: { 'apparatus:first': { waiting: 'pending', ready: 'pending', running: 'in_progress' } },
      queue_action_controls: { 'apparatus:first': {
        waiting: control('pending', 'fresh_start_blocked', { allowed_actions: [], interaction: interaction('fresh_start_blocked', { blocking_reason_code: 'wait' }) }),
        ready: control('pending', 'requeued_ready', { allowed_actions: ['resume'], interaction: interaction('requeued_ready') }),
        running: control(),
      } },
    })
    expect(factoryMapMachineStatus(queued, 'apparatus:first')).toEqual({ state: 'in_progress', orderId: 'running' })
    const withoutRunning = { ...queued, visible_order_ids: { 'apparatus:first': ['ready', 'waiting'] } }
    expect(factoryMapMachineStatus(withoutRunning, 'apparatus:first')).toEqual({ state: 'requeued_ready', orderId: 'ready' })
  })

  it('does not advertise a freeze-requested pending order as next work', () => {
    const freezing = snapshot({ order_controls: { 'order:first': { state: 'freeze_requested' } } })
    expect(factoryMapMachineStatus(freezing, 'apparatus:first')).toEqual({ state: 'idle', orderId: '' })
    const valid = control('in_progress', 'freeze_requested', {
      interaction: interaction('freeze_requested'),
      freeze_request: { request_id: 'freeze', status: 'pending', target_apparatus: 'apparatus:first', target_session_id: 'session' },
    })
    expect(factoryMapMachineStatus({ ...freezing, queue_action_controls: { 'apparatus:first': { 'order:first': valid } } }, 'apparatus:first')).toEqual({ state: 'in_progress', orderId: 'order:first' })
  })

  it('turns statuses unknown exactly at expiry and after a failed refresh', () => {
    const machine = [apparatus()]
    expect(factoryLivePayload(snapshot(), machine, 1000, '', false, 30_999).machines[0].state).toBe('in_progress')
    expect(factoryLivePayload(snapshot(), machine, 1000, '', false, 31_000)).toMatchObject({ fresh: false, validUntil: 0, machines: [{ state: 'unknown' }] })
    expect(factoryLivePayload(snapshot(), machine, 1000, '', true, 1001).machines[0].state).toBe('unknown')
    expect(factoryLivePayload(null, machine, 1000, '', false, 1001).machines[0].state).toBe('unknown')
  })
})

describe('physical stage occurrence and planned routes', () => {
  it('does not borrow a repeated machine active state across both occurrences', () => {
    const first = node('first')
    const second = node('second')
    const definition = map([first, second])
    const live = snapshot({
      stage_states: { 'order:first': { first: 'completed', second: 'pending' } },
      queue_action_controls: { 'apparatus:first': { 'order:first': control('in_progress', 'in_progress', { stage_node_id: 'second' }) } },
    })
    expect(productionMapStageQueueState(definition, first, 'order:first', live)).toBe('completed')
    expect(productionMapStageQueueState(definition, second, 'order:first', live)).toBe('in_progress')
    expect(productionMapStageQueueState(definition, second, 'order:first', snapshot({ stage_states: {} }))).toBeNull()
  })

  it('selects the actually active peer of an alternative group', () => {
    const first = node('first', 'apparatus:first', { alternative_group_id: 'group' })
    const second = node('second', 'apparatus:second', { alternative_group_id: 'group' })
    const live = snapshot({
      stage_states: { 'order:first': { first: 'pending', second: 'in_progress' } },
      queue_states: { 'apparatus:first': { 'order:first': 'pending' } },
      queue_action_controls: {},
    })
    expect(productionMapLiveStageNode(map([first, second]), first, 'order:first', live).id).toBe('second')
  })

  it('shows physical WIP evidence without marking earlier completed stages frozen', () => {
    const first = node('first')
    const second = node('second')
    const definition = map([first, second])
    expect(productionMapStageDisplayStatus(definition, first, 'completed', undefined, 'frozen', { produced: 1 })).toBe('completed')
    expect(productionMapStageDisplayStatus(definition, second, 'pending', control('pending', 'requeued_ready', { allowed_actions: ['resume'], interaction: interaction('requeued_ready'), stage_node_id: 'first' }), 'active', { waitingInput: 2 })).toBe('wip_available')
    expect(productionMapStageDisplayStatus(definition, second, 'pending', undefined, 'active', { inUseInput: 1 })).toBe('wip_received')
    expect(productionMapStageDisplayStatus(definition, second, 'pending', undefined, 'active', { produced: 1, inUseInput: 1 })).toBe('wip_produced')
  })

  it('traverses intermediate nodes, honors assigned alternatives, and never crosses an unmapped machine', () => {
    const definition: Row = {
      nodes: [node('first'), { id: 'task', kind: 'task' }, node('second', 'apparatus:other', { alternative_assigned_apparatus_id: 'apparatus:assigned' }), node('unbound', 'apparatus:unbound'), node('end', 'apparatus:end')],
      edges: [{ from: 'first', to: 'task' }, { from: 'task', to: 'first' }, { from: 'task', to: 'second' }, { from: 'second', to: 'unbound' }, { from: 'unbound', to: 'end' }],
    }
    const objects = new Map([['apparatus:first', 'node:7'], ['apparatus:assigned', 'node:20'], ['apparatus:end', 'node:39']])
    expect(plannedFactoryMapConnections(definition, objects)).toEqual([{ from: 'node:7', to: 'node:20' }])
  })

  it('shows the focused current order route and human order metadata', () => {
    const definition = map([node('first'), node('second', 'apparatus:second')], [{ from: 'first', to: 'second' }])
    definition.order_number = '23'
    const live = snapshot({ maps: [{ map: definition, program: {} }] })
    const result = factoryLivePayload(live, [apparatus(), apparatus('apparatus:second', 'node:20')], 1000, 'node:7:instance:2', false, 1001)
    expect(result.machines[0]).toMatchObject({ orderLabel: '#23 · Film', orderNumber: '23' })
    expect(result.connections).toEqual([{ from: 'node:7', to: 'node:20' }])
  })
})

describe('native state physical roll counts', () => {
  const locations = [{ id: 'state-1', name: 'Extruder yonida', kind: 'state', active: true, apparatus: [{ id: 'apparatus:first' }, { id: 'apparatus:second' }] }]
  const items = [{ code: 'film', item_group: 'Film' }, { code: 'box', item_group: 'Quti' }]
  const groups = [{ name: 'Film', item_group_name: 'Film', parent_item_group: 'Rulon' }]
  const asset = (id: string, patch: Row = {}): Row => ({ kind: 'raw_material', asset_ref: id, item_code: 'film', status: 'available', qty: 200, physical_location: { kind: 'state', id: 'state-1' }, ...patch })

  it('counts physical rolls, not their weight, and excludes consumed/transfer/warehouse/non-roll rows', () => {
    const rolls = stateRollInventory([
      asset('r-2'), asset('r-1', { qty: 0.5 }), asset('zero', { qty: 0 }), asset('consumed', { status: 'consumed' }),
      asset('moving', { transfer_id: 'transfer' }), asset('warehouse', { physical_location: { kind: 'warehouse', id: 'state-1' } }),
      asset('box', { item_code: 'box' }), asset('wip', { kind: 'wip' }),
    ], locations, items, groups)
    expect(rolls.get('state-1')).toEqual(['r-1', 'r-2'])
    const payload = factoryStockPayload({ locations, rolls, receivedAt: 1000 }, [apparatus(), apparatus('apparatus:second', 'node:20')], false, 1001)
    expect(payload.piles).toEqual([{ stateId: 'state-1', name: 'Extruder yonida', objectIds: ['node:20', 'node:7'], rollIds: ['r-1', 'r-2'], count: 2 }])
    expect(payload.fresh).toBe(true)
    expect(factoryStockPayload({ locations, rolls, receivedAt: 1000 }, [apparatus()], false, 31_000).fresh).toBe(false)
  })

  it('rejects unknown item metadata or ambiguous duplicate physical rolls', () => {
    expect(() => stateRollInventory([asset('roll', { item_code: 'unknown' })], locations, items, groups)).toThrow('katalogda')
    expect(() => stateRollInventory([asset('roll'), asset('ROLL')], locations, items, groups)).toThrow('takrorlangan')
  })

  it('excludes inactive states and safely stops circular catalog ancestry', () => {
    expect(stateRollInventory([asset('roll')], [{ ...locations[0], active: false }], items, groups).size).toBe(0)
    expect(stateRollInventory([asset('roll')], locations, items, [{ name: 'Film', parent_item_group: 'Cycle' }, { name: 'Cycle', parent_item_group: 'Film' }]).size).toBe(0)
  })
})
