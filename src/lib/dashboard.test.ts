import { describe, expect, it } from 'vitest'
import type { Page, ProductionSnapshot, Row, SavedMap } from './api-types'
import { dashboardCount, dashboardOrderCounts, dashboardOrders, dashboardOrderStatus, dashboardPageCount, dashboardQueues, dashboardStages, dashboardWipCount, dashboardWipRows } from './dashboard'

function saved(id = 'order-1', nodes: Row[] = [], edges: Row[] = []): SavedMap {
  return { map: { id, title: 'Film', product_code: 'film', nodes, edges }, program: {} }
}
function snapshot(patch: Partial<ProductionSnapshot> = {}): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'one', scope: 'admin', maps: [saved()], order_statuses: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {}, ...patch }
}
const node = (id: string, patch: Row = {}): Row => ({ id, kind: 'apparatus', title: id, apparatus_id: `apparatus-${id}`, x: 0, y: 0, ...patch })

describe('dashboard authoritative order metrics', () => {
  it('does not turn lifecycle activity or a missing status into live work or a zero', () => {
    const live = snapshot({ maps: [saved('known'), saved('missing'), saved('lifecycle-only')], order_statuses: {
      known: { lifecycle_status: 'in_progress', order_status: 'ready', work_status: 'waiting' },
      'lifecycle-only': { lifecycle_status: 'in_progress' },
    } })
    const counts = dashboardOrderCounts(dashboardOrders(live))
    expect(counts).toMatchObject({ total: 3, running: 0, queued: 1, unknown: 2 })
    expect(dashboardCount(counts.running, true, counts.unknown > 0)).toBe('—')
    expect(dashboardCount(counts.queued, true, counts.unknown > 0)).toBe('1+')
    expect(dashboardCount(0, true)).toBe('0')
    expect(dashboardCount(0, false)).toBe('—')
  })

  it('keeps partial work separate from queued and completed work', () => {
    const live = snapshot({ maps: [saved('partial'), saved('waiting'), saved('preflight')], order_statuses: {
      partial: { lifecycle_status: 'in_progress', order_status: 'partially_completed', work_status: 'partially_completed' },
      waiting: { lifecycle_status: 'in_progress', order_status: 'waiting_next_stage', work_status: 'waiting' },
      preflight: { lifecycle_status: 'released', order_status: 'print_preflight', work_status: 'print_preflight' },
    } })
    expect(dashboardOrderCounts(dashboardOrders(live))).toMatchObject({ running: 1, queued: 1, partial: 1, completed: 0, unknown: 0 })
  })

  it('honors terminal lifecycle and order freezes without counting cancellations as completion', () => {
    const live = snapshot({ maps: [saved('done'), saved('cancelled'), saved('frozen')], order_statuses: {
      done: { lifecycle_status: 'closed', order_status: 'in_progress' },
      cancelled: { lifecycle_status: 'cancelled', order_status: 'completed' },
      frozen: { lifecycle_status: 'in_progress', order_status: 'ready' },
    }, order_controls: { done: { state: 'frozen' }, frozen: { state: 'frozen' } } })
    expect(dashboardOrderStatus(live, 'done')).toBe('closed')
    expect(dashboardOrderStatus(live, 'cancelled')).toBe('cancelled')
    expect(dashboardOrderCounts(dashboardOrders(live))).toMatchObject({ completed: 1, attention: 1, running: 0, queued: 0 })
  })

  it('surfaces completion issues and freeze requests while keeping active work visible', () => {
    const live = snapshot({ maps: [saved('issue'), saved('freezing')], order_statuses: {
      issue: { lifecycle_status: 'production_completed', order_status: 'completed_with_issue', completed_with_issue_count: 2 },
      freezing: { lifecycle_status: 'in_progress', order_status: 'in_progress' },
    }, order_controls: { freezing: { state: 'freeze_requested' } } })
    const orders = dashboardOrders(live)
    expect(orders[0]).toMatchObject({ attention: true, completed: true, attentionReason: 'Yakunlangan ishda muammo bor' })
    expect(orders[1]).toMatchObject({ attention: true, running: true, attentionReason: 'Muzlatish so‘rovi kutilmoqda' })
  })

  it('keeps unrecognized operational statuses unknown even if another field looks active', () => {
    expect(dashboardOrderStatus(snapshot({ order_statuses: { 'order-1': { order_status: 'future_state', work_status: 'in_progress' } } }), 'order-1')).toBe('unknown')
  })
})

describe('dashboard physical stage progress', () => {
  it('follows graph order across non-apparatus nodes and keeps missing stage coverage visible', () => {
    const definition = saved('order-1', [node('later'), { id: 'task', kind: 'task', title: 'Task' }, node('first'), node('last')], [{ from: 'first', to: 'task' }, { from: 'task', to: 'later' }, { from: 'later', to: 'last' }])
    const live = snapshot({ maps: [definition], stage_states: { 'order-1': { first: 'pending', later: 'pending' } } })
    expect(dashboardStages(live, definition)).toEqual({ stage: 'first', stages: { completed: 0, known: 2, total: 3 } })
  })

  it('counts alternatives once and displays every concurrently active operation', () => {
    const definition = saved('order-1', [node('alternative-a', { alternative_group_id: 'print' }), node('alternative-b', { alternative_group_id: 'print' }), node('parallel')])
    const live = snapshot({ stage_states: { 'order-1': { 'alternative-a': 'pending', 'alternative-b': 'in_progress', parallel: 'in_progress' } } })
    expect(dashboardStages(live, definition)).toEqual({ stage: 'alternative-b · parallel', stages: { completed: 0, known: 2, total: 2 } })
    live.stage_states['order-1'] = { 'alternative-a': 'pending', 'alternative-b': 'completed', parallel: 'completed' }
    expect(dashboardStages(live, definition)).toEqual({ stage: 'Bosqichlar tugallangan', stages: { completed: 2, known: 2, total: 2 } })
  })

  it('does not borrow a repeated physical machine status for an unidentified occurrence', () => {
    const definition = saved('order-1', [node('first', { apparatus_id: 'machine' }), node('again', { apparatus_id: 'machine' })])
    const live = snapshot({ queue_states: { machine: { 'order-1': 'in_progress' } }, stage_states: { 'order-1': { first: 'completed', again: 'pending' } } })
    expect(dashboardStages(live, definition)).toEqual({ stage: 'again', stages: { completed: 1, known: 2, total: 2 } })
  })
})

describe('dashboard queues and bounded batch counts', () => {
  it('uses visible membership and keeps missing queue states unknown', () => {
    const definition = saved('order-1', [node('print', { apparatus_id: 'machine', title: 'Bosma' })])
    const live = snapshot({ maps: [definition], visible_order_ids: { machine: ['order-2', 'order-1'] }, sequences: { machine: ['retired', 'order-1'] }, queue_states: { machine: { 'order-1': 'in_progress' } } })
    expect(dashboardQueues(live)).toEqual([{ apparatusId: 'machine', label: 'Bosma', total: 2, running: 1, waiting: 0, unknown: 1, firstOrderId: 'order-1', firstStatus: 'in_progress' }])
    expect(dashboardQueues(snapshot())).toEqual([])
  })

  it('marks capped lists as lower bounds and preserves an exact empty list', () => {
    expect(dashboardPageCount(undefined)).toBe('—')
    expect(dashboardPageCount({ items: [], hasMore: false })).toBe('0')
    expect(dashboardPageCount({ items: [{}, {}], hasMore: false, bounded: true })).toBe('2+')
  })

  it('counts WIP batches without summing incompatible units or returned material', () => {
    const page: Page = { items: [
      { batch_id: 'a', produced_qty: 10000, uom: 'm', wip_status: 'waiting' },
      { batch_id: 'b', produced_qty: 200, uom: 'kg', status_detail: { wip_status: 'waiting' } },
      { batch_id: 'c', produced_qty: 50, wip_status: 'in_use' },
      { batch_id: 'returned-material', wip_status: 'waiting', payload_json: { origin: 'layer_remainder' } },
    ], hasMore: false }
    expect(dashboardWipRows(page, 'waiting').map(row => row.batch_id)).toEqual(['a', 'b'])
    expect(dashboardWipCount(page, 'waiting')).toBe('2')
    expect(dashboardWipCount({ ...page, bounded: true }, 'waiting')).toBe('2+')
    expect(dashboardWipCount({ items: [{ batch_id: 'unknown' }], hasMore: false }, 'waiting')).toBe('—')
  })
})
