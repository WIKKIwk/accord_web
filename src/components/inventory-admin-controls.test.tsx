import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient, ApiError } from '@/lib/api'
import type { Row, Session } from '@/lib/api-types'
import { inventoryAssetCommand, inventoryAssetKey, inventoryAttempts } from '@/lib/inventory-admin'
import { useSession } from '@/lib/session'
import { InventoryAdminControls, InventoryAdminToolbar, InventoryTransferControls } from './inventory-admin-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const scope = 'inventory-ui-scope', nativeId = 'state_11111111111111111111111111111111', machine = 'apparatus:test:printer-1'
const locations = [{ id: 'warehouse-location', kind: 'warehouse', name: 'Main', active: true, warehouse_id: 'warehouse-main', factory_location_id: '', apparatus: [] }, { id: 'state-projection', kind: 'state', name: 'Shared title', active: true, warehouse_id: '', factory_location_id: nativeId, apparatus: [] }, { id: 'other-location', kind: 'warehouse', name: 'Other', active: true, warehouse_id: 'warehouse-other', factory_location_id: '', apparatus: [] }]
const asset = { kind: 'raw_material' as const, asset_ref: 'ROLL-1', item_code: 'PET', item_name: 'Actual PET', identifier: 'ROLL-1', qty: 25, uom: 'kg', status: 'available', transfer_id: '', placement_version: 1, custody_warehouse_id: 'warehouse-main', custody_warehouse: 'Main', physical_location: { id: locations[0].id, kind: 'warehouse', name: 'Main' } }
const factory = { id: nativeId, name: 'Native printer state', active: true, apparatus: [{ id: machine, name: 'Native printer', active: true, source_revision: 1 }], created_at_unix: 1791885600, updated_at_unix: 1791885600 }
const transfer = { id: 'transfer-native', source_warehouse_id: 'warehouse-main', source_warehouse: 'Main', destination_warehouse_id: 'warehouse-other', destination_warehouse: 'Other', status: 'requested', lines: [{ asset_kind: asset.kind, asset_ref: asset.asset_ref, identifier: asset.identifier, item_code: asset.item_code, item_name: asset.item_name, qty: asset.qty, uom: asset.uom, source_physical_location_id: asset.physical_location.id }] }
function actor(capabilities = ['inventory.movement.manage', 'factory.location.manage', 'catalog.item.read'], currentScope = scope, demo = false) {
  const session: Session = { token: 'local-ui-test', profile: { role: 'admin', display_name: 'Fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: ['Main'] }
  vi.mocked(useSession).mockReturnValue({ session, scope: currentScope, demo, endpoint: 'http://127.0.0.1:5199', client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-ui-test' }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  inventoryAttempts.activate(currentScope)
  return session
}
function cache(current: Row = asset) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  queryClient.setQueryData(['inventory-admin', scope, 'asset', inventoryAssetKey(asset)], current)
  queryClient.setQueryData(['inventory-admin', scope, 'inventory-locations'], locations)
  queryClient.setQueryData(['inventory-admin', scope, 'factory-locations'], [factory, { ...factory, id: 'state_other', name: 'Shared title' }])
  queryClient.setQueryData(['inventory-admin', scope, 'transfer', transfer.id], transfer)
  return queryClient
}
const render = (client: QueryClient, element: React.ReactNode) => renderToStaticMarkup(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
afterEach(() => { inventoryAttempts.activate('reset-ui-test'); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('inventory maintenance entry points and native read guards', () => {
  it('requires exact capabilities even for an admin role and retains separate factory manager access', () => {
    actor(['admin.access'])
    const denied = render(cache(), <><InventoryAdminControls row={asset} /><InventoryAdminToolbar kind="locations" /></>)
    expect(denied).toContain('Inventar holatini o‘qish va ko‘chirish uchun ruxsat berilmagan')
    expect(denied).toContain('Zavod joylarini o‘qish va tahrirlash uchun ruxsat berilmagan')
    expect(denied).not.toContain('Actual PET')
    actor(['factory.location.manage'])
    const factoryOnly = render(cache(), <><InventoryAdminToolbar kind="locations" /><InventoryAdminControls kind="locations" row={locations[1]} /><InventoryAdminControls row={asset} /></>)
    expect(factoryOnly).toContain('Zavod joylarini boshqarish')
    expect(factoryOnly).toContain('Native printer state')
    expect(factoryOnly).toContain('apparat ro‘yxatini o‘qish ruxsati kerak')
    expect(factoryOnly).toContain('Inventar holatini o‘qish va ko‘chirish uchun ruxsat berilmagan')
  })

  it('uses factory_location_id for projection details and never joins shared names or invented prefixes', () => {
    actor()
    const native = render(cache(), <InventoryAdminControls kind="locations" row={locations[1]} />)
    expect(native).toContain('Native printer state')
    expect(native).not.toContain('Shared title')
    expect(native).toContain('Joyni tahrirlash')
    expect(native).toContain('Apparatlarni bog‘lash')
    const missing = render(cache(), <InventoryAdminControls kind="locations" row={{ kind: 'state', id: `state:${nativeId}`, name: factory.name }} />)
    expect(missing).toContain('haqiqiy identifikatori olinmagan')
    expect(missing).not.toContain('Joyni tahrirlash')
  })

  it('shows native quantity and custody while refusing reserved assets, transit and unsupported WIP', () => {
    actor()
    const reserved = render(cache({ ...asset, transfer_id: 'native-reservation', status: 'transfer_reserved' }), <InventoryAdminControls row={asset} />)
    expect(reserved).toContain('25 kg')
    expect(reserved).toContain('Transfer uchun band')
    expect(reserved).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Aktivni ko‘chirish/)
    expect(reserved).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Omborlararo transfer/)
    const unsupported = render(cache(), <InventoryAdminControls row={{ kind: 'wip', asset_ref: asset.asset_ref }} />)
    expect(unsupported).toContain('ko‘chirish API’sidagi')
    expect(unsupported).not.toContain('Aktivni ko‘chirish')
  })

  it('denies stale refreshes instead of enabling writes from retained server data', () => {
    actor()
    const cached = cache()
    cached.getQueryCache().find({ queryKey: ['inventory-admin', scope, 'asset', inventoryAssetKey(asset)] })!.setState({ status: 'error', error: new ApiError(403, 'forbidden') })
    const html = render(cached, <InventoryAdminControls row={asset} />)
    expect(html).toContain('Bu amal uchun ruxsat berilmagan')
    expect(html).toContain('Qayta yuklash')
    expect(html).not.toContain('Actual PET')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Aktivni ko‘chirish/)
  })

  it('keeps old-account cache and native attempts out of a changed authentication scope', () => {
    const session = actor(), queryClient = cache()
    const command = inventoryAssetCommand(asset, locations, session, 'relocate', locations[1].id, '', 'retained-key')
    const lease = inventoryAttempts.begin(scope, 'asset-context', command)
    inventoryAttempts.dispatched(lease); inventoryAttempts.interrupt(lease)
    actor(undefined, 'inventory-other-account')
    const html = render(queryClient, <><InventoryAdminControls row={asset} /><InventoryAdminControls kind="locations" row={locations[1]} /></>)
    expect(html).not.toContain('Actual PET')
    expect(html).not.toContain('Native printer state')
    expect(html).not.toContain('Aynan qayta yuborish')
    expect(html).toContain('data-slot="skeleton"')
  })

  it('makes retained interrupted writes reviewable and blocks a new command after reopening', () => {
    const session = actor(), command = inventoryAssetCommand(asset, locations, session, 'relocate', locations[1].id, 'Retained note', 'retained-key')
    const lease = inventoryAttempts.begin(scope, 'closed-dialog', command)
    inventoryAttempts.dispatched(lease); inventoryAttempts.interrupt(lease)
    const html = render(cache(), <InventoryAdminControls row={asset} />)
    expect(html).toContain('Retained note')
    expect(html).toContain('Server holatini tekshirish')
    expect(html).toContain('Aynan qayta yuborish')
    expect(html).toContain('yangi amal boshlanmaydi')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Aktivni ko‘chirish/)
    expect(inventoryAttempts.get(scope, 'closed-dialog')?.command.id).toBe('retained-key')
  })

  it('offers source-side cancellation before dispatch and no terminal transfer undo', () => {
    actor()
    const queryClient = cache()
    expect(render(queryClient, <InventoryTransferControls row={transfer} />)).toContain('Transferni bekor qilish')
    queryClient.setQueryData(['inventory-admin', scope, 'transfer', transfer.id], { ...transfer, status: 'received' })
    const received = render(queryClient, <InventoryTransferControls row={transfer} />)
    expect(received).toContain('Qabul qilingan')
    expect(received).not.toContain('Transferni bekor qilish')
    expect(received).not.toContain('Ortga qaytarish')
  })

  it('keeps demo controls read-only and avoids requests before valid live identity is available', () => {
    actor(undefined, scope, true)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = render(cache(), <><InventoryAdminToolbar kind="assets" /><InventoryAdminToolbar kind="locations" /><InventoryAdminControls row={asset} /></>)
    expect(html).toContain('Ko‘rish rejimida')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Ombor transferlari/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
