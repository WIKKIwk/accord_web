import { afterEach, describe, expect, it, vi } from 'vitest'
import { resourceDefinitions, valueAt } from './api'
import type { ResourceKind, Row } from './api-types'
import { demoProductionSnapshot, getDemoPage } from './demo'
import { allPages, moduleForPage, modules, pageById } from './navigation'
import { cellLabel, completionDecisionRequired, dateLabel, statusFilterLabel, views } from './presentation'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('nested MES and warehouse navigation', () => {
  it('uses a small set of unique modules and preserves parent lookup for every page', () => {
    expect(modules.map(module => module.id)).toEqual(['production', 'warehouse', 'catalog', 'management'])
    const ids = allPages.map(page => page.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const module of modules) {
      expect(pageById(module.id)?.title).toBe(module.title)
      for (const page of module.groups.flatMap(group => group.pages)) {
        expect(pageById(page.id)).toBe(page)
        expect(moduleForPage(page.id)).toBe(module)
      }
    }
    expect(pageById('unknown')).toBeUndefined()
    expect(moduleForPage('unknown')).toBeUndefined()
  })

  it('maps every resource page to an API contract and a usable view', () => {
    for (const page of allPages) {
      if (!page.resource) continue
      expect(resourceDefinitions[page.resource], page.id).toBeDefined()
      expect(views[page.resource]?.columns.length, page.id).toBeGreaterThan(0)
    }
    expect(pageById('raw-materials')?.resource).toBe('raw-materials')
    expect(pageById('stock')?.resource).toBe('stock')
  })
})

describe('isolated preview datasets', () => {
  it('never fetches, reads browser session storage or returns shared mutable rows', () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected server access') })
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('sessionStorage', storage)
    vi.stubGlobal('localStorage', storage)
    for (const kind of Object.keys(resourceDefinitions) as ResourceKind[]) getDemoPage(kind)
    const original = getDemoPage('orders').items[0]!
    const first = getDemoPage('orders').items[0]!
    first.title = 'Changed outside preview'
    const map = first.map as Row
    ;(map.nodes as Row[])[0]!.title = 'Changed nested node'
    expect(getDemoPage('orders').items[0]).toEqual(original)
    expect(demoProductionSnapshot.maps[0]!.map.title).toBe(original.title)
    expect(fetch).not.toHaveBeenCalled()
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('filters and paginates preview data without changing the underlying dataset', () => {
    const all = getDemoPage('orders', { limit: 500 })
    const first = getDemoPage('orders', { offset: 0, limit: 2 })
    const second = getDemoPage('orders', { offset: 2, limit: 2 })
    expect(first.items).toEqual(all.items.slice(0, 2))
    expect(second.items).toEqual(all.items.slice(2, 4))
    expect(first.hasMore).toBe(all.items.length > 2)
    expect(getDemoPage('orders', { q: 'unmatched preview query' }).items).toEqual([])
    expect(getDemoPage('orders', { limit: 500 })).toEqual(all)
  })

  it.each(Object.keys(resourceDefinitions) as ResourceKind[])('provides the real primary view field for %s', kind => {
    const first = getDemoPage(kind).items[0]
    expect(first, kind).toBeDefined()
    expect(valueAt(first!, views[kind].columns[0]!.key), `${kind}.${views[kind].columns[0]!.key}`).not.toBeUndefined()
  })

  it('preserves real role, user and apparatus field paths rather than hiding wire mismatches', () => {
    const role = getDemoPage('roles').items[0]!
    const user = getDemoPage('users').items[0]!
    const apparatus = getDemoPage('apparatus').items[0]!
    expect(typeof role.label).toBe('string')
    expect(Array.isArray(role.capability_codes)).toBe(true)
    expect(typeof user.name).toBe('string')
    expect(typeof user.principal_role).toBe('string')
    expect(typeof user.role_label).toBe('string')
    expect(typeof valueAt(apparatus, 'display.display_name')).toBe('string')
    expect(typeof valueAt(apparatus, 'execution_profile.operation')).toBe('string')
    expect(typeof valueAt(apparatus, 'lifecycle.state')).toBe('string')
  })

  it('uses native WIP statuses and retains processed batches in the all-state view', () => {
    const all = getDemoPage('wip', { status: 'all' }).items
    expect(all.some(row => row.wip_status === 'processed')).toBe(true)
    expect(all.every(row => ['waiting', 'in_use', 'processed'].includes(String(row.wip_status)))).toBe(true)
    const waiting = getDemoPage('wip', { status: 'waiting' }).items
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.every(row => row.wip_status === 'waiting')).toBe(true)
    expect(waiting.length).toBeLessThan(all.length)
    expect(getDemoPage('opening-wip').items.every(row => ['waiting', 'in_use', 'processed', 'void'].includes(String(row.wip_status)))).toBe(true)
  })

  it('provides canonical finished products assigned to each customer', () => {
    for (const customer of getDemoPage('customers').items) {
      const assigned = customer.assigned_items as Row[]
      expect(assigned.length).toBeGreaterThan(0)
      for (const item of assigned) {
        expect(item.item_group).toBe('Tayyor mahsulot')
        expect((item.customers as Row[]).some(row => row.ref === customer.ref)).toBe(true)
        expect((item.customer_names as string[]).includes(String(customer.name))).toBe(true)
      }
    }
  })

  it('uses valid lifecycle and operational status values in the production snapshot', () => {
    for (const status of Object.values(demoProductionSnapshot.order_statuses)) {
      expect(['released', 'in_progress', 'production_completed', 'closed', 'cancelled']).toContain(status.lifecycle_status)
      expect(['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'frozen', 'waiting_next_stage', 'partially_completed', 'completed', 'completed_with_issue']).toContain(status.order_status)
    }
  })
})

describe('human-readable contract presentation', () => {
  it('formats backend unix seconds and uses contextual labels for booleans', () => {
    expect(dateLabel(0)).toBe('—')
    expect(dateLabel('invalid')).toBe('—')
    const row = { created_at_unix: 1791790200, system: true, is_group: false }
    expect(cellLabel({ key: 'created_at_unix', label: 'Vaqt', date: true }, row)).toBe(dateLabel(row.created_at_unix))
    expect(cellLabel({ key: 'system', label: 'Turi', trueLabel: 'Tizim roli', falseLabel: 'Maxsus rol' }, row)).toBe('Tizim roli')
    expect(cellLabel({ key: 'is_group', label: 'Turi', trueLabel: 'Guruh', falseLabel: 'Ombor' }, row)).toBe('Ombor')
  })

  it('permits decisions only for an actionable completion request', () => {
    expect(completionDecisionRequired({ event_id: 'request-1', decision_required: true })).toBe(true)
    expect(completionDecisionRequired({ event_id: 'notice-1', decision_required: false })).toBe(false)
    expect(completionDecisionRequired({ decision_required: true })).toBe(false)
    expect(completionDecisionRequired({ event_id: 'request-1' })).toBe(false)
    const column = views.completion.columns.find(column => column.key === 'decision_required')!
    expect(statusFilterLabel(column, 'false')).toBe('Axborot uchun')
    expect(statusFilterLabel(column, 'true')).toBe('Qaror kutilmoqda')
  })

  it('describes inventory assets and dispatch history without claiming an admin audit log', () => {
    expect(moduleForPage('assets')?.id).toBe('warehouse')
    expect(pageById('assets')?.title).toBe('Inventar joylashuvi')
    expect(pageById('completed')?.title).toBe('Tugallangan ishlar')
    expect(views.activity.columns.find(column => column.key === 'supplier_name')?.label).toBe('Ta’minotchi')
    expect(views.activity.columns.some(column => column.key === 'uom')).toBe(true)
    expect(views.maps.columns.find(column => column.key === 'nodes.length')?.label).toBe('Xarita tugunlari')
  })
})
