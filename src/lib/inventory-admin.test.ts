import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import type { Row, Session } from './api-types'
import {
  INVENTORY_API_LIMITATIONS, InventoryAttemptRegistry, executeInventoryCommand, factoryApparatusChoices,
  factoryLocationCommand, factoryLocationId, factoryLocations, inventoryAssetCommand, inventoryAssetDetail,
  inventoryAssetKey, inventoryAvailable, inventoryLocations, inventoryPermissions, inventoryRelocationChoices,
  inventoryTransferActions, inventoryTransferCommand, inventoryTransfersPage, parseFactoryLocation,
  parseInventoryAsset, parseInventoryLocation, parseInventoryTransfer, reconcileInventoryCommand,
} from './inventory-admin'
import type { FactoryLocation, InventoryAsset, InventoryLocation, InventoryTransfer } from './inventory-admin'

const base = '/v1/mobile/admin', machine = 'apparatus:test:printer-1', cutter = 'apparatus:test:cutter-1'
const client = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-inventory-test' })
const actor = (capabilities = ['inventory.movement.manage', 'factory.location.manage', 'catalog.item.read'], warehouses = ['Main'], role = 'admin'): Session => ({ token: 'local-test', profile: { role, display_name: 'Local actor' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: warehouses })
const locations: InventoryLocation[] = [
  { id: 'warehouse-main-location', kind: 'warehouse', name: 'Main', active: true, warehouse_id: 'warehouse-main', factory_location_id: '', apparatus: [] },
  { id: 'warehouse-other-location', kind: 'warehouse', name: 'Other', active: true, warehouse_id: 'warehouse-other', factory_location_id: '', apparatus: [] },
  { id: 'state-projection-1', kind: 'state', name: 'Printer state', active: true, warehouse_id: '', factory_location_id: 'state_11111111111111111111111111111111', apparatus: [] },
  { id: 'transit-location', kind: 'transit', name: 'Transit', active: true, warehouse_id: '', factory_location_id: '', apparatus: [] },
]
const asset: InventoryAsset = { kind: 'raw_material', asset_ref: 'ROLL-1', custody_warehouse_id: 'warehouse-main', custody_warehouse: 'Main', item_code: 'PET', item_name: 'PET film', identifier: 'ROLL-1', qty: 25, uom: 'kg', status: 'available', transfer_id: '', placement_version: 1, physical_location: { id: locations[0].id, kind: 'warehouse', name: 'Main' } }
const catalog: Row[] = [machine, cutter].map((apparatus_id, index) => ({ apparatus_id, source_revision: index + 1, display: { display_name: index ? 'Cutter' : 'Printer' }, lifecycle: { state: 'active' } }))
const members = (ids: string[]) => ids.map(id => ({ id, name: id === machine ? 'Printer' : 'Cutter', source_revision: id === machine ? 1 : 2, equipment_class_id: '', physical_asset_id: '', active: true }))
const factory: FactoryLocation = { id: locations[2].factory_location_id, name: 'Printer state', active: true, apparatus: members([machine]), created_at_unix: 1791885600, updated_at_unix: 1791885600 }
const transfer: InventoryTransfer = { id: 'transfer-native-1', source_warehouse_id: 'warehouse-main', source_warehouse: 'Main', destination_warehouse_id: 'warehouse-other', destination_warehouse: 'Other', status: 'requested', note: 'Local note', lines: [{ asset_kind: asset.kind, asset_ref: asset.asset_ref, item_code: asset.item_code, item_name: asset.item_name, identifier: asset.identifier, qty: asset.qty, uom: asset.uom, source_physical_location_id: asset.physical_location.id }], created_at_unix: 1791885600 }
const command = (action: 'relocate' | 'return' | 'transfer-create' = 'relocate', current = asset) => inventoryAssetCommand(current, locations, actor(), action, action === 'transfer-create' ? locations[1].id : locations[2].id, 'Local note', 'retained-native-key')
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
interface ServerOptions { assets?: InventoryAsset[]; locations?: InventoryLocation[]; factories?: FactoryLocation[]; transfers?: InventoryTransfer[]; catalog?: Row[]; writeStatus?: number; writeResponse?: unknown; persist?: boolean; loseFirst?: boolean; failReadback?: boolean; internalTransfer?: boolean; onWrite?: () => void }
/** Local-only native DTO fixture. Failed writes return before changing the state. */
function server(options: ServerOptions = {}) {
  let assets = structuredClone(options.assets ?? [asset]), places = structuredClone(options.locations ?? locations), factories = structuredClone(options.factories ?? [factory]), transfers = structuredClone(options.transfers ?? [])
  let writes = 0, failReads = options.failReadback ?? false
  const idempotency = new Map<string, unknown>()
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, get = init.method === 'GET'
    if (get && failReads && writes) return response({ error: 'local_read_unavailable' }, 503)
    if (path === `${base}/apparatus` && get) return response(options.catalog ?? catalog)
    if (path === `${base}/inventory/locations` && get) return response(places)
    if (path === `${base}/factory-locations` && get) return response(factories)
    if (path === `${base}/inventory/assets` && get) {
      const kind = url.searchParams.get('asset_kind'), query = url.searchParams.get('query')?.toLowerCase() ?? '', states = url.searchParams.get('current_user_states_only') === 'true'
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit')) || 100
      return response(assets.filter(row => (!kind || row.kind === kind) && row.asset_ref.toLowerCase().includes(query) && (!states || row.physical_location.kind === 'state')).slice(offset, offset + limit))
    }
    if (path === `${base}/inventory/transfers` && get) {
      const status = url.searchParams.get('status'), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit')) || 100
      return response(transfers.filter(row => !status || row.status === status).slice(offset, offset + limit))
    }
    writes++
    if (options.writeStatus) return response({ error: 'local_native_refusal' }, options.writeStatus)
    const body = JSON.parse(String(init.body)) as Row
    let result: unknown
    if (idempotency.has(String(body.idempotency_key))) result = idempotency.get(String(body.idempotency_key))
    else if (path.endsWith('/inventory/relocations') || path.endsWith('/inventory/returns/batch')) {
      const returning = path.endsWith('/returns/batch'), selected = returning ? (body.assets as Row[])[0] : body
      const old = assets.find(row => row.kind === selected.asset_kind && row.asset_ref === selected.asset_ref)!
      const place = places.find(row => returning ? row.kind === 'warehouse' && row.warehouse_id === old.custody_warehouse_id : row.id === body.physical_location_id)!
      const moved = { ...old, placement_version: old.placement_version + 1, physical_location: { id: place.id, kind: place.kind, name: place.name } }
      if (options.persist !== false) assets = assets.map(row => inventoryAssetKey(row) === inventoryAssetKey(old) ? moved : row)
      result = returning ? [moved] : moved
    } else if (path === `${base}/inventory/transfers`) {
      const current = assets[0], next = { ...transfer, note: String(body.note ?? ''), status: options.internalTransfer ? 'received' : 'requested' }
      if (options.persist !== false) {
        transfers = [next, ...transfers]
        assets = [{ ...current, status: options.internalTransfer ? 'available' : 'transfer_reserved', transfer_id: options.internalTransfer ? '' : next.id, ...(options.internalTransfer ? { custody_warehouse_id: 'warehouse-other', custody_warehouse: 'Other', placement_version: current.placement_version + 1, physical_location: { id: places[1].id, kind: 'warehouse', name: 'Other' } } : {}) }]
      }
      result = next
    } else if (path.includes('/inventory/transfers/')) {
      const action = path.split('/').at(-1)!, id = decodeURIComponent(path.split('/').at(-2)!)
      const old = transfers.find(row => row.id === id)!, next = { ...old, status: ({ approve: 'approved', reject: 'rejected', dispatch: 'in_transit', receive: 'received', cancel: 'cancelled' } as Record<string, string>)[action] }
      if (options.persist !== false) transfers = transfers.map(row => row.id === id ? next : row)
      result = next
    } else if (path === `${base}/factory-locations`) {
      const next = { id: 'state_22222222222222222222222222222222', name: body.name, active: true, apparatus: members(body.apparatus_ids as string[]), created_at_unix: 1791885601, updated_at_unix: 1791885601 }
      if (options.persist !== false) factories.push(next as FactoryLocation)
      result = next
    } else if (path.includes('/factory-locations/')) {
      const binding = path.endsWith('/apparatus'), id = decodeURIComponent(path.split('/').at(binding ? -2 : -1)!)
      const old = factories.find(row => row.id === id)!, next = { ...old, ...(binding ? { apparatus: members(body.apparatus_ids as string[]) } : body), updated_at_unix: old.updated_at_unix + 1 }
      if (options.persist !== false) factories = factories.map(row => row.id === id ? next : row)
      result = next
    } else throw new Error(`Unexpected local request ${path}`)
    if (body.idempotency_key && options.persist !== false) idempotency.set(String(body.idempotency_key), result)
    options.onWrite?.()
    if (options.loseFirst && writes === 1) throw new TypeError('Local response lost after persistence')
    return response(Object.hasOwn(options, 'writeResponse') ? options.writeResponse : result)
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, allowReads: () => { failReads = false }, state: () => ({ assets, places, factories, transfers }), writes: () => writes }
}
const writes = (fetch: ReturnType<typeof server>['fetch']) => fetch.mock.calls.filter(([, init]) => init.method !== 'GET')
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('native inventory identity, location and permission policy', () => {
  it('requires the exact native read/write capabilities and warehouse scope', () => {
    expect(inventoryPermissions(actor(['admin.access'])).inventory).toBe(false)
    expect(inventoryPermissions(actor(['inventory.movement.manage'])).factory).toBe(false)
    expect(inventoryPermissions(actor(['factory.location.manage'])).inventory).toBe(false)
    expect(() => inventoryAssetCommand(asset, locations, actor(['inventory.movement.manage'], ['Other']), 'relocate', locations[2].id)).toThrow('ruxsat')
    expect(command().body.asset_ref).toBe('ROLL-1')
    expect(inventoryAssetCommand(asset, locations, actor(['inventory.movement.manage', 'admin.access'], []), 'relocate', locations[2].id).asset?.kind).toBe('raw_material')
  })

  it('separates asset kinds sharing a reference and never accepts WIP or a title as identity', () => {
    expect(inventoryAssetKey(asset)).not.toBe(inventoryAssetKey({ ...asset, kind: 'finished_goods' }))
    expect(inventoryAssetKey({ kind: 'wip', asset_ref: 'ROLL-1' })).toBe('')
    expect(inventoryAssetKey({ kind: 'qolip', name: 'ROLL-1' })).toBe('')
    expect(() => parseInventoryAsset({ ...asset, kind: 'wip' })).toThrow()
    expect(factoryLocationId({ id: 'state:invented', kind: 'state', name: factory.name })).toBe('')
    expect(factoryLocationId({ ...locations[2], id: 'projection-with-different-id' })).toBe(factory.id)
    expect(factoryLocationId({ ...locations[0], factory_location_id: factory.id })).toBe('')
  })

  it('permits active states and the own custody warehouse, and blocks busy/transit/zero stock', () => {
    expect(inventoryRelocationChoices(asset, locations).map(row => row.id)).toEqual([locations[2].id])
    const stateAsset = { ...asset, physical_location: { id: locations[2].id, kind: 'state', name: locations[2].name } }
    expect(inventoryAssetCommand(stateAsset, locations, actor(), 'return', '', '', 'return-key').destination?.id).toBe(locations[0].id)
    expect(() => inventoryAssetCommand(asset, locations, actor(), 'return')).toThrow()
    expect(() => inventoryAssetCommand(stateAsset, locations, actor(), 'transfer-create', locations[1].id)).toThrow()
    expect(() => inventoryAssetCommand(asset, locations, actor(), 'relocate', locations[1].id)).toThrow()
    for (const current of [{ ...asset, qty: 0 }, { ...asset, transfer_id: 'live-transfer' }, { ...asset, status: 'future' }, { ...asset, physical_location: { ...asset.physical_location, kind: 'transit' } }]) expect(inventoryAvailable(current)).toBe(false)
    expect(() => inventoryAssetCommand(asset, locations.map(row => ({ ...row, active: false })), actor(), 'relocate', locations[2].id)).toThrow()
  })

  it('finds an exact scoped kind/ref in substring search and keeps state filters out of mutation readback', async () => {
    const local = server({ assets: [{ ...asset, asset_ref: 'PREFIX-ROLL-1' }, { ...asset, kind: 'finished_goods' }, asset] })
    expect(await inventoryAssetDetail(client, asset)).toMatchObject({ asset_ref: asset.asset_ref, kind: asset.kind })
    const url = new URL(String(local.fetch.mock.calls[0][0]))
    expect(url.searchParams.get('asset_kind')).toBe('raw_material')
    expect(url.searchParams.get('current_user_states_only')).toBe('false')
    await expect(inventoryAssetDetail(client, asset, undefined, true)).rejects.toThrow('tasdiqlanmadi')
    expect(INVENTORY_API_LIMITATIONS.join(' ')).toContain('does not mean assets last moved')
  })

  it('refuses incomplete DTOs and ambiguous scoped feeds rather than treating them as empty', async () => {
    server({ assets: [asset, asset] }); await expect(inventoryAssetDetail(client, asset)).rejects.toThrow()
    server({ locations: [locations[0], locations[0]] }); await expect(inventoryLocations(client)).rejects.toThrow()
    expect(() => parseInventoryAsset({ ...asset, placement_version: 0 })).toThrow()
    expect(() => parseInventoryLocation({ ...locations[0], active: 'true' })).toThrow()
    expect(() => parseInventoryTransfer({ ...transfer, lines: [] })).toThrow()
    expect(() => parseFactoryLocation({ ...factory, apparatus: [{ ...factory.apparatus[0], id: 'Printer' }] })).toThrow()
  })
})

describe('inventory mutations and native outcome confirmation', () => {
  it('sends minimal relocation and return DTOs and confirms the actual fresh destination', async () => {
    let local = server()
    const moved = await executeInventoryCommand(client, actor(), command())
    expect(moved.physical_location).toMatchObject({ id: locations[2].id })
    expect(JSON.parse(String(writes(local.fetch)[0][1].body))).toEqual({ asset_kind: 'raw_material', asset_ref: 'ROLL-1', physical_location_id: locations[2].id, idempotency_key: 'retained-native-key', note: 'Local note' })
    const stateAsset = { ...asset, physical_location: { id: locations[2].id, kind: 'state', name: locations[2].name } }
    local = server({ assets: [stateAsset] })
    const returned = await executeInventoryCommand(client, actor(), command('return', stateAsset))
    expect(returned.physical_location).toMatchObject({ id: locations[0].id })
    expect(JSON.parse(String(writes(local.fetch)[0][1].body))).toEqual({ assets: [{ asset_kind: 'raw_material', asset_ref: 'ROLL-1' }], idempotency_key: 'retained-native-key', note: 'Local note' })
    expect(writes(local.fetch)[0][0].pathname).toBe(`${base}/inventory/returns/batch`)
  })

  it('accepts version 1 after a first native placement insert without inventing a CAS field', async () => {
    const first = { ...asset, physical_location: { id: locations[2].id, kind: 'state', name: locations[2].name } }
    const fetch = vi.fn(async (_input: URL, init: RequestInit) => response(init.method === 'GET' && String(_input).includes('/locations') ? locations : init.method === 'GET' ? [fetch.mock.calls.some(([, request]) => request.method === 'POST') ? first : asset] : first))
    vi.stubGlobal('fetch', fetch)
    expect((await executeInventoryCommand(client, actor(), command())).placement_version).toBe(1)
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init.method === 'POST')![1].body))).not.toHaveProperty('expected_placement_version')
  })

  it('blocks changed placement, quantity, retired destinations and forged wire paths before POST', async () => {
    for (const changed of [{ ...asset, placement_version: 2 }, { ...asset, qty: 24 }, { ...asset, status: 'transfer_reserved', transfer_id: 'other' }]) {
      const local = server({ assets: [changed] })
      await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: false })
      expect(writes(local.fetch)).toHaveLength(0)
    }
    const retired = server({ locations: locations.map(row => row.kind === 'state' ? { ...row, active: false } : row) })
    await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: false })
    expect(writes(retired.fetch)).toHaveLength(0)
    const local = server()
    for (const forged of [{ ...command(), path: `${base}/inventory/undo` }, { ...command(), body: { ...command().body, expected_placement_version: 1 } }]) await expect(executeInventoryCommand(client, actor(), forged)).rejects.toMatchObject({ uncertain: false })
    expect(writes(local.fetch)).toHaveLength(0)
  })

  it('preserves stock after native 403/409 rejection and distinguishes it from an unknown commit', async () => {
    for (const code of [403, 409]) {
      const local = server({ writeStatus: code })
      await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: false })
      expect(local.state().assets).toEqual([asset])
      expect(writes(local.fetch)).toHaveLength(1)
    }
    server({ writeStatus: 503 })
    await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: true })
  })

  it('explains native destination dependency refusals without inventing a successful transfer', async () => {
    const local = server()
    const get = local.fetch.getMockImplementation()!
    local.fetch.mockImplementation((input, init) => init.method === 'POST' ? Promise.resolve(response({ error: 'inventory_destination_warehouse_unassigned' }, 409)) : get(input, init))
    await expect(executeInventoryCommand(client, actor(), command('transfer-create'))).rejects.toThrow('foydalanuvchi biriktirilmagan')
    expect(local.state().assets).toEqual([asset])
    expect(local.state().transfers).toEqual([])
  })

  it('does not report HTTP 200 with wrong identity/status/destination or absent readback as success', async () => {
    const target = { ...asset, placement_version: 2, physical_location: { id: locations[2].id, kind: 'state', name: locations[2].name } }
    for (const writeResponse of [{ ok: true }, { ...target, kind: 'finished_goods' }, { ...target, status: 'future' }, { ...target, physical_location: asset.physical_location }]) {
      server({ writeResponse }); await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: true })
    }
    server({ persist: false }); await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: true })
    server({ failReadback: true }); await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: true })
  })

  it('recovers a lost relocation through current state without repeating the write', async () => {
    const local = server({ loseFirst: true }), retained = command()
    await expect(executeInventoryCommand(client, actor(), retained)).rejects.toMatchObject({ uncertain: true })
    expect((await executeInventoryCommand(client, actor(), retained, undefined, undefined, true)).physical_location).toMatchObject({ id: locations[2].id })
    expect(writes(local.fetch)).toHaveLength(1)
  })

  it('keeps a committed write uncertain after scoped readback becomes denied or missing', async () => {
    for (const missing of [true, false]) {
      let dispatched = false
      const target = { ...asset, placement_version: 2, physical_location: { id: locations[2].id, kind: 'state', name: locations[2].name } }
      const fetch = vi.fn(async (input: URL, init: RequestInit) => {
        if (init.method === 'POST') { dispatched = true; return response(target) }
        if (input.pathname.endsWith('/locations')) return response(locations)
        if (dispatched) return missing ? response([]) : response({ error: 'forbidden' }, 403)
        return response([asset])
      })
      vi.stubGlobal('fetch', fetch)
      await expect(executeInventoryCommand(client, actor(), command())).rejects.toMatchObject({ uncertain: true })
      expect(writes(fetch)).toHaveLength(1)
    }
  })

  it('retains a post-dispatch interruption and makes no request when already aborted', async () => {
    const before = new AbortController(); before.abort(); const local = server()
    await expect(executeInventoryCommand(client, actor(), command(), before.signal)).rejects.toMatchObject({ uncertain: false })
    expect(writes(local.fetch)).toHaveLength(0)
    const during = new AbortController()
    server({ loseFirst: true, onWrite: () => during.abort() })
    await expect(executeInventoryCommand(client, actor(), command(), during.signal)).rejects.toMatchObject({ uncertain: true })
  })
})

describe('native transfers and cancellation boundaries', () => {
  it('requires source/destination warehouse authority for each real lifecycle state', () => {
    expect(inventoryTransferActions(transfer, actor())).toEqual(['cancel'])
    expect(inventoryTransferActions(transfer, actor(['inventory.movement.manage'], ['Other']))).toEqual(['approve', 'reject'])
    expect(inventoryTransferActions({ ...transfer, status: 'approved' }, actor())).toEqual(['dispatch', 'cancel'])
    expect(inventoryTransferActions({ ...transfer, status: 'in_transit' }, actor(['inventory.movement.manage'], ['Other']))).toEqual(['receive'])
    for (const state of ['received', 'rejected', 'cancelled', 'future']) expect(inventoryTransferActions({ ...transfer, status: state }, actor(['inventory.movement.manage', 'admin.access']))).toEqual([])
    expect(inventoryTransferActions(transfer, actor(['admin.access']))).toEqual([])
    expect(() => inventoryTransferCommand({ ...transfer, status: 'in_transit' }, actor(), 'cancel')).toThrow()
  })

  it('uses native transfer IDs and accepts immediate internal receipt without a fake movement ID', async () => {
    const local = server({ internalTransfer: true })
    const result = await executeInventoryCommand(client, actor(), command('transfer-create'))
    expect(result).toMatchObject({ id: 'transfer-native-1', status: 'received' })
    const body = JSON.parse(String(writes(local.fetch)[0][1].body))
    expect(body).toEqual({ source_warehouse_id: 'warehouse-main', destination_warehouse_id: 'warehouse-other', assets: [{ asset_kind: 'raw_material', asset_ref: 'ROLL-1' }], idempotency_key: 'retained-native-key', note: 'Local note' })
    expect(body).not.toHaveProperty('movement_id')
  })

  it('requires the exact same-key response for lost requested or internal transfers', async () => {
    for (const internalTransfer of [false, true]) {
      const local = server({ internalTransfer, loseFirst: true }), retained = command('transfer-create')
      await expect(executeInventoryCommand(client, actor(), retained)).rejects.toMatchObject({ uncertain: true })
      expect((await reconcileInventoryCommand(client, retained)).state).toBe('replayable')
      const result = await executeInventoryCommand(client, actor(), retained, undefined, undefined, true)
      expect(result.id).toBe('transfer-native-1')
      expect(writes(local.fetch)).toHaveLength(2)
      expect(writes(local.fetch).map(([, init]) => JSON.parse(String(init.body)).idempotency_key)).toEqual(['retained-native-key', 'retained-native-key'])
      expect(local.state().transfers).toHaveLength(1)
    }
  })

  it('retains a validated response ID before failed readback and then recovers without another POST', async () => {
    const local = server({ failReadback: true }), registry = new InventoryAttemptRegistry(), retained = command('transfer-create')
    registry.activate('scope'); const lease = registry.begin('scope', 'asset', retained)
    await expect(executeInventoryCommand(client, actor(), retained, undefined, () => registry.dispatched(lease), false, result => registry.receipt(lease, result))).rejects.toMatchObject({ uncertain: true })
    registry.finish(lease, { error: 'readback lost', uncertain: true }); local.allowReads()
    const recovered = registry.get('scope', 'asset')!.command
    expect(recovered.returnedTransferId).toBe('transfer-native-1')
    expect((await executeInventoryCommand(client, actor(), recovered, undefined, undefined, true)).id).toBe('transfer-native-1')
    expect(writes(local.fetch)).toHaveLength(1)
  })

  it('confirms cancellation only for its native transfer and fresh permitted state', async () => {
    const local = server({ transfers: [transfer] }), cancel = inventoryTransferCommand(transfer, actor(), 'cancel', '', 'cancel-key')
    expect(await executeInventoryCommand(client, actor(), cancel)).toMatchObject({ id: transfer.id, status: 'cancelled' })
    expect(writes(local.fetch)[0][0].pathname).toBe(`${base}/inventory/transfers/${transfer.id}/cancel`)
    const changed = server({ transfers: [{ ...transfer, status: 'in_transit' }] })
    await expect(executeInventoryCommand(client, actor(), cancel)).rejects.toMatchObject({ uncertain: false })
    expect(writes(changed.fetch)).toHaveLength(0)
    server({ transfers: [transfer], writeResponse: { ...transfer, id: 'wrong-transfer', status: 'cancelled' } })
    await expect(executeInventoryCommand(client, actor(), cancel)).rejects.toMatchObject({ uncertain: true })
  })

  it('pages transfer feeds with a real lookahead and fails missing records during recovery', async () => {
    const local = server({ transfers: Array.from({ length: 21 }, (_, index) => ({ ...transfer, id: `transfer-${index}` })) })
    expect(await inventoryTransfersPage(client, { limit: 20 })).toMatchObject({ items: expect.any(Array), hasMore: true })
    expect(new URL(String(local.fetch.mock.calls[0][0])).searchParams.get('limit')).toBe('21')
    server({ transfers: [] })
    await expect(reconcileInventoryCommand(client, inventoryTransferCommand(transfer, actor(), 'cancel'))).rejects.toThrow('tasdiqlanmadi')
  })
})

describe('native factory maintenance preserves dependency identities', () => {
  it('creates a unique native ID and replaces membership using canonical active projections', async () => {
    const local = server({ factories: [] })
    const create = factoryLocationCommand(actor(), 'factory-create', null, { name: ' New state ', apparatus_ids: [machine] }, catalog, 'local-create-key')
    expect(await executeInventoryCommand(client, actor(), create)).toMatchObject({ id: 'state_22222222222222222222222222222222', name: 'New state', active: true })
    expect(JSON.parse(String(writes(local.fetch)[0][1].body))).toEqual({ apparatus_ids: [machine], name: 'New state' })
    const bindingServer = server(), replace = factoryLocationCommand(actor(), 'factory-apparatus', factory, { apparatus_ids: [cutter] }, catalog)
    expect(await executeInventoryCommand(client, actor(), replace)).toMatchObject({ id: factory.id, name: factory.name, apparatus: members([cutter]) })
    expect(writes(bindingServer.fetch)[0][0].pathname).toBe(`${base}/factory-locations/${factory.id}/apparatus`)
    expect(factoryApparatusChoices(catalog.map(row => ({ ...row, source_revision: undefined })))).toEqual([])
    expect(() => factoryLocationCommand(actor(), 'factory-create', null, { name: 'State', apparatus_ids: ['Printer'] }, catalog)).toThrow()
  })

  it('renames/retires in place and preserves membership, created time and referenced placement', async () => {
    const stateAsset = { ...asset, physical_location: { id: locations[2].id, kind: 'state', name: locations[2].name } }, local = server({ assets: [stateAsset] })
    const edit = factoryLocationCommand(actor(), 'factory-edit', factory, { name: 'Renamed state', active: false })
    const result = await executeInventoryCommand(client, actor(), edit)
    expect(result).toMatchObject({ id: factory.id, name: 'Renamed state', active: false, apparatus: factory.apparatus, created_at_unix: factory.created_at_unix })
    expect(local.state().assets).toEqual([stateAsset])
    expect(JSON.parse(String(writes(local.fetch)[0][1].body))).toEqual({ name: 'Renamed state', active: false })
    expect(writes(local.fetch)[0][1].method).toBe('PUT')
  })

  it('blocks stale locations, duplicate names, changed source revisions and native 409 without mutation', async () => {
    const edit = factoryLocationCommand(actor(), 'factory-edit', factory, { name: 'New name' })
    let local = server({ factories: [{ ...factory, updated_at_unix: factory.updated_at_unix + 1 }] })
    await expect(executeInventoryCommand(client, actor(), edit)).rejects.toMatchObject({ uncertain: false }); expect(writes(local.fetch)).toHaveLength(0)
    local = server()
    const duplicate = factoryLocationCommand(actor(), 'factory-create', null, { name: 'PRINTER STATE', apparatus_ids: [] })
    await expect(executeInventoryCommand(client, actor(), duplicate)).rejects.toMatchObject({ uncertain: false }); expect(writes(local.fetch)).toHaveLength(0)
    local = server({ catalog: catalog.map(row => ({ ...row, source_revision: 3 })) })
    const binding = factoryLocationCommand(actor(), 'factory-apparatus', factory, { apparatus_ids: [cutter] }, catalog)
    await expect(executeInventoryCommand(client, actor(), binding)).rejects.toMatchObject({ uncertain: false }); expect(writes(local.fetch)).toHaveLength(0)
    local = server({ writeStatus: 409 })
    await expect(executeInventoryCommand(client, actor(), edit)).rejects.toMatchObject({ uncertain: false }); expect(local.state().factories).toEqual([factory])
  })

  it('refuses false success that alters untouched dependencies or returns a guessed factory ID', async () => {
    const edit = factoryLocationCommand(actor(), 'factory-edit', factory, { active: false })
    for (const result of [{ ...factory, id: 'wrong-id', active: false }, { ...factory, active: false, apparatus: [] }, { ...factory, active: false, created_at_unix: 1 }]) {
      server({ writeResponse: result }); await expect(executeInventoryCommand(client, actor(), edit)).rejects.toMatchObject({ uncertain: true })
    }
    const membership = factoryLocationCommand(actor(), 'factory-apparatus', factory, { apparatus_ids: [cutter] }, catalog)
    server({ writeResponse: { ...factory, name: 'Unrequested rename', apparatus: members([cutter]) } })
    await expect(executeInventoryCommand(client, actor(), membership)).rejects.toMatchObject({ uncertain: true })
  })

  it('recovers a lost unique factory create through actual name/ID readback, without invented idempotency', async () => {
    const local = server({ factories: [], loseFirst: true }), retained = factoryLocationCommand(actor(), 'factory-create', null, { name: 'New state', apparatus_ids: [] })
    await expect(executeInventoryCommand(client, actor(), retained)).rejects.toMatchObject({ uncertain: true })
    expect(await executeInventoryCommand(client, actor(), retained, undefined, undefined, true)).toMatchObject({ id: 'state_22222222222222222222222222222222' })
    expect(writes(local.fetch)).toHaveLength(1)
    expect(await factoryLocations(client)).toHaveLength(1)
    expect(writes(local.fetch)[0][1].body).not.toContain('idempotency_key')
  })
})

describe('interrupted native operation registry', () => {
  it('blocks duplicates across asset/transfer surfaces and preserves exact payload/key after closure', () => {
    const registry = new InventoryAttemptRegistry(), retained = command()
    registry.activate('session-one'); const lease = registry.begin('session-one', 'asset-detail', retained)
    registry.dispatched(lease); registry.interrupt(lease)
    const restored = registry.get('session-one', 'transfer-page', retained.subjects)!
    expect(restored.phase).toBe('uncertain'); expect(restored.command).toEqual(retained)
    expect(() => registry.clear('session-one', restored.context)).toThrow()
    expect(() => registry.begin('session-one', 'other-context', { ...retained, id: 'new-key' })).toThrow()
    const recovery = registry.begin('session-one', 'other-context', restored.command, true)
    registry.finish(lease, { result: { fake: 'late-old-response' } })
    expect(registry.get('session-one', 'asset-detail')?.phase).toBe('pending')
    registry.finish(recovery, { error: 'read failed or changed baseline', uncertain: false })
    expect(registry.get('session-one', 'asset-detail')?.phase).toBe('uncertain')
  })

  it('only resolves uncertainty with confirmation and invalidates old-account callbacks without retaining credentials', () => {
    const registry = new InventoryAttemptRegistry(), retained = command()
    registry.activate('session-one'); const lease = registry.begin('session-one', 'asset', retained)
    registry.dispatched(lease); registry.finish(lease, { error: 'lost response', uncertain: true })
    const recovery = registry.begin('session-one', 'asset', retained, true)
    registry.finish(recovery, { result: { ...asset, physical_location: locations[2] } })
    expect(registry.get('session-one', 'asset')?.phase).toBe('confirmed')
    expect(() => registry.begin('session-one', 'asset', retained)).toThrow()
    registry.clear('session-one', 'asset')
    const replacement = registry.begin('session-one', 'asset', retained)
    registry.activate('session-two'); registry.finish(replacement, { result: asset })
    expect(registry.get('session-two', 'asset')).toBeNull()
    expect(registry.get('session-one', 'asset')).toBeNull()
  })

  it('separates equal refs of different kinds and permits restarting a pre-dispatch cancellation', () => {
    const registry = new InventoryAttemptRegistry(), retained = command()
    registry.activate('session'); const first = registry.begin('session', 'raw', retained)
    const finished = command('relocate', { ...asset, kind: 'finished_goods' })
    expect(() => registry.begin('session', 'finished', finished)).not.toThrow()
    registry.interrupt(first)
    expect(registry.get('session', 'raw')?.phase).toBe('blocked')
    expect(() => registry.begin('session', 'raw', retained)).not.toThrow()
  })
})
