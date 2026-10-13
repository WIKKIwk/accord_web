import { ApiClient, ApiError, isRecord, record, text } from './api'
import type { Row, Session } from './api-types'
import { hasCapability } from './permissions'

export type CatalogKind = 'items' | 'item-groups' | 'customers' | 'suppliers' | 'warehouses'
export type CatalogAction = 'edit' | 'move' | 'remove' | 'restore' | 'block' | 'unblock' | 'assign' | 'unassign' | 'regenerate'
const base = '/v1/mobile/admin'

export function catalogPermission(kind: CatalogKind, action: CatalogAction): string {
  if (kind === 'items') return action === 'move' ? 'catalog.item.bulk_move' : 'admin.access'
  if (kind === 'item-groups') return 'catalog.item_group.manage'
  if (kind === 'warehouses') return action === 'edit' ? 'production.map.manage' : 'admin.access'
  const party = kind === 'suppliers' ? 'supplier' : 'customer'
  return `party.${party}.${action === 'assign' || action === 'unassign' ? 'item.assign' : action === 'regenerate' ? 'code.manage' : 'manage'}`
}

export function catalogAllowed(session: Session | null, kind: CatalogKind, action: CatalogAction): boolean {
  return hasCapability(session, catalogPermission(kind, action))
}

export function cleanCatalogResult(value: unknown): Row {
  const result = { ...record(value) }
  delete result.code
  return result
}

export function groupParentChoices(groups: Row[], selected: string): Row[] {
  const blocked = new Set(selected ? [selected] : [])
  // Handle unordered trees and avoid every descendant as a possible parent.
  let changed = true
  while (changed) {
    changed = false
    for (const group of groups) if (blocked.has(text(group.parent_item_group, '')) && !blocked.has(text(group.name, ''))) {
      blocked.add(text(group.name, '')); changed = true
    }
  }
  return groups.filter(group => group.is_group === true && !blocked.has(text(group.name, '')))
}

function required(value: unknown, message: string): string {
  const result = text(value, '').trim()
  if (!result) throw new Error(message)
  return result
}

/** Only supported native mutations; identity fields come from the selected row. */
export async function catalogMutation(client: ApiClient, kind: CatalogKind, row: Row, action: CatalogAction, input: Row, signal?: AbortSignal): Promise<Row> {
  if (kind === 'items') {
    const code = required(row.code, 'Mahsulot kodi topilmadi.')
    if (action === 'edit') return record(await client.put(`${base}/items/detail`, { original_code: code, code: required(input.code, 'Mahsulot kodini kiriting.'), name: required(input.name, 'Mahsulot nomini kiriting.') }, undefined, signal))
    if (action === 'move') {
      const group = required(input.item_group, 'Guruhni tanlang.')
      const result = record(await client.post(`${base}/items/bulk-move-group`, { item_codes: [code], item_group: group }, signal))
      if (result.requested_count !== 1 || result.updated_count !== 1 || result.failed_count !== 0 || result.item_group !== group || !Array.isArray(result.updated_item_codes) || result.updated_item_codes.length !== 1 || text(result.updated_item_codes[0], '').toLowerCase() !== code.toLowerCase()) throw new ApiError(409, 'item_move_failed', 'Mahsulot guruhga ko‘chirilmagan. Ro‘yxatni yangilab, mahsulot va guruhni tekshiring.')
      return result
    }
    if (action === 'remove') return record(await client.delete(`${base}/items/detail`, { code }, signal))
  }
  if (kind === 'item-groups' && action === 'move') return record(await client.put(`${base}/item-groups`, { name: required(row.name, 'Guruh topilmadi.'), parent: text(input.parent, '').trim() }, undefined, signal))
  if (kind === 'warehouses') {
    const warehouse = required(row.warehouse, 'Ombor topilmadi.')
    if (action === 'edit') return record(await client.post(`${base}/warehouses`, { warehouse, company: text(input.company, '').trim(), parent_warehouse: text(input.parent_warehouse, '').trim(), is_group: input.is_group === true }, signal))
    // Delete is empty-only. Product removal is never implicit.
    if (action === 'remove') return record(await client.request(`${base}/warehouses`, 'DELETE', { body: { warehouse, delete_products: false }, signal }))
  }
  if (kind === 'customers' || kind === 'suppliers') {
    const ref = required(row.ref, 'Foydalanuvchi topilmadi.')
    const endpoint = `${base}/${kind}`
    let result: unknown
    if (action === 'edit') result = await client.put(`${endpoint}/phone`, { phone: text(input.phone, '').trim() }, { ref }, signal)
    else if (action === 'assign') result = await client.request(`${endpoint}/items/add`, 'POST', { query: { ref }, body: { item_code: required(input.item_code, 'Mahsulotni tanlang.') }, signal })
    else if (action === 'unassign') result = await client.delete(`${endpoint}/items/remove`, { ref, item_code: required(input.item_code, 'Mahsulotni tanlang.') }, signal)
    else if (action === 'remove') result = await client.delete(`${endpoint}/remove`, { ref }, signal)
    else if (action === 'restore' && kind === 'suppliers') result = await client.request(`${endpoint}/restore`, 'POST', { query: { ref }, signal })
    else if ((action === 'block' || action === 'unblock') && kind === 'suppliers') result = await client.put(`${endpoint}/status`, { blocked: action === 'block' }, { ref }, signal)
    else if (action === 'regenerate') {
      result = record(await client.request(`${endpoint}/code/regenerate`, 'POST', { query: { ref }, signal }))
      if (!text(record(result).code, '').trim()) throw new ApiError(502, 'invalid_response', 'Yangi kirish kodi olinmadi. Qayta yaratishdan oldin hisobni tekshiring.')
      return { ...cleanCatalogResult(result), generated_code: record(result).code }
    } else throw new Error('Bu amal mavjud emas.')
    return cleanCatalogResult(result)
  }
  throw new Error('Bu amal mavjud emas.')
}

export function assignedItems(row: Row): Row[] {
  return Array.isArray(row.assigned_items) ? row.assigned_items.filter(isRecord) : []
}
