import { describe, expect, it } from 'vitest'
import { canManageResource, canViewPage, hasCapability, resourceCanCreate } from './permissions'
import type { Session } from './api-types'

function session(...capabilities: string[]): Session {
  return { token: 'test', profile: { role: 'admin', display_name: 'Test' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
}

describe('backend capability parity', () => {
  it('does not promote admin access into catalog, party or inventory permissions', () => {
    const admin = session('admin.access')
    expect(canViewPage(admin, 'orders')).toBe(true)
    for (const page of ['customers', 'items', 'roles', 'assets', 'settings']) expect(canViewPage(admin, page)).toBe(false)
    expect(resourceCanCreate(admin, 'items')).toBe(false)
    expect(canManageResource(admin, 'items')).toBe(true)
  })
  it('requires both party directories for the aggregate user endpoint', () => {
    expect(canViewPage(session('admin.access', 'party.customer.read'), 'users')).toBe(false)
    expect(canViewPage(session('admin.access', 'party.customer.read', 'party.supplier.read'), 'users')).toBe(true)
  })
  it('separates read permissions from write permissions', () => {
    const read = session('admin.access', 'catalog.item.read', 'party.customer.read')
    expect(canViewPage(read, 'customers')).toBe(true)
    expect(resourceCanCreate(read, 'customers')).toBe(false)
    expect(hasCapability(read, 'party.customer.item.assign')).toBe(false)
  })
  it('uses the actor-specific catalog branch instead of broad pre-authorization', () => {
    expect(canViewPage(session('admin.access', 'gscale.catalog.read'), 'items')).toBe(false)
    const material = session('admin.access', 'gscale.catalog.read', 'catalog.item.create', 'raw_material.assign')
    material.profile.role = 'material_taminotchi'
    expect(canViewPage(material, 'items')).toBe(true)
    expect(canViewPage(material, 'stock')).toBe(true)
    expect(resourceCanCreate(material, 'items')).toBe(false)
  })
  it('keeps unauthorized direct routes closed while exposing authorized module pages', () => {
    expect(canViewPage(null, 'home')).toBe(false)
    expect(canViewPage(session('admin.access'), 'catalog')).toBe(true)
    expect(canViewPage(session('admin.access'), 'items')).toBe(false)
    expect(canViewPage(session('admin.access', 'party.customer.read'), 'catalog')).toBe(true)
    expect(canViewPage(session('admin.access'), 'unknown')).toBe(false)
  })
})
