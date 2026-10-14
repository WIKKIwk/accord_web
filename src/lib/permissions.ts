import type { ResourceKind, Session } from './api-types'
import { modules } from './navigation'

type Requirement = string | { any: string[] } | { all: string[] }
const mapRead = { any: ['admin.access', 'production.map.manage', 'apparatus.queue.read'] }
const mapManage = { any: ['admin.access', 'production.map.manage'] }

/** Mirrors handler guards. admin.access never implies unrelated capabilities. */
export function hasCapability(session: Session | null | undefined, code: string): boolean {
  return Boolean(session?.capabilities.includes(code))
}

export function meetsRequirement(session: Session | null | undefined, requirement: Requirement): boolean {
  if (typeof requirement === 'string') return hasCapability(session, requirement)
  if ('any' in requirement) return requirement.any.some(code => hasCapability(session, code))
  return requirement.all.every(code => hasCapability(session, code))
}

export const pageRequirements: Record<string, Requirement> = {
  orders: mapRead, maps: mapRead, 'map-editor': mapManage, calculate: mapManage,
  'production-time': mapRead,
  pending: mapManage, completed: mapRead, closed: mapRead, completion: mapManage,
  wip: mapRead, 'opening-wip': mapRead, 'factory-map': mapRead,
  paddons: { any: ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'] },
  items: 'catalog.item.read', 'item-groups': { any: ['catalog.item_group.read', 'gscale.catalog.read'] },
  apparatus: { any: ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'] }, workers: 'admin.access',
  suppliers: 'party.supplier.read', customers: 'party.customer.read',
  warehouses: { any: ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'gscale.catalog.read'] },
  stock: 'catalog.item.read',
  'raw-materials': { any: ['admin.access', 'catalog.item.read', 'raw_material.assign'] },
  users: { all: ['party.supplier.read', 'party.customer.read'] },
  roles: 'role.capability.read', activity: 'admin.activity.read', materials: mapManage,
  templates: mapManage, locations: { any: ['inventory.movement.manage', 'factory.location.manage'] }, assets: 'inventory.movement.manage',
  settings: 'admin.settings.read', server: 'admin.access',
}

export function canViewPage(session: Session | null | undefined, pageId: string): boolean {
  if (!hasCapability(session, 'admin.access')) return false
  if (pageId === 'home') return true
  if (pageId === 'items' && session?.profile.role === 'material_taminotchi') return hasCapability(session, 'gscale.catalog.read')
  if (pageId === 'stock' && session?.profile.role === 'material_taminotchi') return hasCapability(session, 'raw_material.assign')
  if (pageId === 'stock' && session?.profile.role === 'werka') return hasCapability(session, 'inventory.movement.manage')
  const module = modules.find(module => module.id === pageId)
  if (module) return module.groups.some(group => group.pages.some(page => canViewPage(session, page.id)))
  const requirement = pageRequirements[pageId]
  return requirement ? meetsRequirement(session, requirement) : false
}

const createRequirements: Partial<Record<ResourceKind, Requirement>> = {
  items: 'catalog.item.create', 'item-groups': 'catalog.item_group.manage',
  suppliers: 'party.supplier.manage', customers: 'party.customer.manage',
  warehouses: 'production.map.manage', workers: 'admin.access', users: 'admin.access',
}

export function resourceCanCreate(session: Session | null | undefined, kind: ResourceKind): boolean {
  if (kind === 'items' && session?.profile.role === 'material_taminotchi') return false
  const requirement = createRequirements[kind]
  return Boolean(requirement && meetsRequirement(session, requirement))
}

export function canManageResource(session: Session | null | undefined, kind: ResourceKind): boolean {
  const requirement = createRequirements[kind]
  return kind === 'items' || kind === 'workers' || kind === 'users'
    ? hasCapability(session, 'admin.access')
    : kind === 'roles' ? hasCapability(session, 'role.capability.manage')
    : kind === 'completion' ? meetsRequirement(session, mapManage)
    : Boolean(requirement && meetsRequirement(session, requirement))
}
