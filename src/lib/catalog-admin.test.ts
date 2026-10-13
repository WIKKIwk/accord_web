import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import { catalogMutation, catalogPermission, cleanCatalogResult, groupParentChoices } from './catalog-admin'

const client = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' })
afterEach(() => vi.unstubAllGlobals())
function response(value: unknown) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('catalog native contracts', () => {
  it('updates product code/name with original identity and no unrelated writable fields', async () => {
    const fetch = response({ code: 'NEW', name: 'New name' })
    await catalogMutation(client, 'items', { code: 'OLD' }, 'edit', { code: ' NEW ', name: ' New name ', uom: 'L', item_group: 'ignore' })
    const [url, options] = fetch.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:5199/v1/mobile/admin/items/detail')
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body)).toEqual({ original_code: 'OLD', code: 'NEW', name: 'New name' })
  })
  it('never removes warehouse products implicitly', async () => {
    const fetch = response({ warehouse: 'Test', deleted_product_count: 0 })
    await catalogMutation(client, 'warehouses', { warehouse: 'Test' }, 'remove', { delete_products: true })
    expect(fetch.mock.calls[0]![1].method).toBe('DELETE')
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ warehouse: 'Test', delete_products: false })
  })
  it('uses encoded party identity and strips unsolicited credentials', async () => {
    const fetch = response({ ref: 'test/with space', phone: '+998', code: 'secret' })
    const result = await catalogMutation(client, 'customers', { ref: 'test/with space' }, 'edit', { phone: ' +998 ' })
    expect(String(fetch.mock.calls[0]![0])).toContain('ref=test%2Fwith+space')
    expect(result).toEqual({ ref: 'test/with space', phone: '+998' })
  })
  it('reveals a generated code only for the explicit regeneration result', async () => {
    response({ ref: 's1', code: 'new-secret', blocked: false })
    expect(await catalogMutation(client, 'suppliers', { ref: 's1' }, 'regenerate', {})).toEqual({ ref: 's1', blocked: false, generated_code: 'new-secret' })
    expect(cleanCatalogResult({ code: 'old-secret', name: 'Party' })).toEqual({ name: 'Party' })
  })
  it('does not invent catalog update or directory permissions', () => {
    expect(catalogPermission('items', 'edit')).toBe('admin.access')
    expect(catalogPermission('items', 'move')).toBe('catalog.item.bulk_move')
    expect(catalogPermission('suppliers', 'assign')).toBe('party.supplier.item.assign')
    expect(catalogPermission('customers', 'regenerate')).toBe('party.customer.code.manage')
  })
  it('does not treat HTTP 200 with a failed bulk move as success', async () => {
    response({ item_group: 'Xomashyo', requested_count: 1, updated_count: 0, failed_count: 1, updated_item_codes: [], failed_item_codes: ['OLD'] })
    await expect(catalogMutation(client, 'items', { code: 'OLD' }, 'move', { item_group: 'Xomashyo' })).rejects.toThrow('ko‘chirilmagan')
  })
  it('accepts only a confirmed successful move of the selected product', async () => {
    response({ item_group: 'Xomashyo', requested_count: 1, updated_count: 1, failed_count: 0, updated_item_codes: ['OLD'], failed_item_codes: [] })
    expect(await catalogMutation(client, 'items', { code: 'OLD' }, 'move', { item_group: 'Xomashyo' })).toMatchObject({ updated_count: 1 })
  })
  it('excludes self and all descendants regardless of tree order', () => {
    const groups = [{ name: 'grandchild', parent_item_group: 'child', is_group: true }, { name: 'other', is_group: true }, { name: 'child', parent_item_group: 'self', is_group: true }, { name: 'self', is_group: true }, { name: 'leaf', is_group: false }]
    expect(groupParentChoices(groups, 'self').map(group => group.name)).toEqual(['other'])
  })
  it('rejects incomplete action inputs before contacting the server', async () => {
    const fetch = response({ ok: true })
    await expect(catalogMutation(client, 'items', { code: 'p1' }, 'edit', { code: ' ', name: 'X' })).rejects.toThrow('kodini')
    await expect(catalogMutation(client, 'suppliers', { ref: 's1' }, 'assign', { item_code: '' })).rejects.toThrow('tanlang')
    expect(fetch).not.toHaveBeenCalled()
  })
})
