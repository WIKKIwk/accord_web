import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import {
  APPARATUS_ADMIN_API_LIMITATIONS, ApparatusAdminApi, ApparatusAdminConflict, ApparatusAdminUnknown,
  apparatusAasxMaxBytes, apparatusAasxMime, apparatusAasxRevision, apparatusAdminError,
  apparatusAdminId, apparatusAdminPermissions, apparatusCanonicalAuxParts, apparatusCrc32,
  apparatusCreateDraft, apparatusCreateOperation, apparatusDefaultForm, apparatusHashBytes,
  apparatusImportOperation, apparatusPatchOperation, apparatusProfileForm, apparatusProfileInput,
  apparatusReferences, apparatusRetireOperation, apparatusTechnologies, inspectApparatusAasx,
  parseApparatusCanonicalRevision, parseApparatusDraft, parseApparatusProjection,
} from './apparatus-admin'
import type {
  ApparatusAdminOperation, ApparatusAdminSnapshot, ApparatusCanonicalRevision, ApparatusDraft,
} from './apparatus-admin'

const id = 'apparatus:default:asset-001', otherId = 'apparatus:default:asset-002'
const base = '/v1/mobile/admin/apparatus', encoder = new TextEncoder()
const actor = (capabilities = ['production.map.manage'], role = 'admin'): Session => ({ token: 'fixture-token', profile: { role, ref: 'fixture-admin', display_name: 'Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const service = (session = actor(), config: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) => new ApparatusAdminApi(new ApiClient({ endpoint: 'https://erp.example.test', token: session.token, ...config }), session)
const hierarchy = { enterprise_id: 'enterprise:factory', site_id: 'site:main', area_id: 'area:production', work_center_id: 'work-center:printing', work_unit_id: 'work-unit:001' }
function nativeDraft(overrides: Partial<ApparatusDraft> = {}): ApparatusDraft {
  return {
    display: { display_name: 'Bosma 01', description: '  Saqlanadigan izoh  ', catalog_order: 10 },
    equipment_class_id: 'equipment-class:rotogravure', physical_asset_id: 'physical-asset:001', hierarchy,
    capabilities: [{ code: 'print', level: 3 }, { code: 'tooling', level: 1 }],
    execution_profile: { operation: 'print', technology: 'rotogravure', color_station_count: 7, min_web_width_mm: 200, max_web_width_mm: 1200, virtual_tasks: 'disabled', capability_compatible_reroute: true },
    policies: { queue: 'strict_sequence', material: { mode: 'all_required', item_group_ids: ['FILM', 'INK'] }, tooling: { mode: 'qolip_scan_required', tooling_class_id: 'tooling:printing' } },
    capacity: { capacity_slots: 2, setup_minutes: 15, cleanup_minutes: 10, efficiency_percent: 80, finite_capacity: true, availability: { mode: 'scheduled', working_windows: [{ weekday: 1, start_minute: 480, end_minute: 1020 }, { weekday: 7, start_minute: 0, end_minute: 1440 }] } },
    placement: { factory_map_object_id: 'printing_machine_01' }, training: { enabled: false, queue_enabled: false, material_tracking_enabled: false }, lifecycle: { state: 'active', retirement_reason: null }, ...overrides,
  }
}
function nativeRevision(overrides: Partial<ApparatusCanonicalRevision> = {}): ApparatusCanonicalRevision {
  const apparatusId = overrides.apparatus_id ?? id, suffix = apparatusId.slice('apparatus:'.length)
  return parseApparatusCanonicalRevision({ ...nativeDraft(), schema_version: 1, apparatus_id: apparatusId,
    revision_metadata: { revision: 3, committed_at_unix_ms: 1_792_000_000_000, command_id: 'apparatus-command:fixture-seed', actor_id: 'principal:fixture-admin', source: 'admin', source_reference: null },
    aas_identity: { shell_id: `urn:mini-rs-erp:aas:apparatus:${suffix}`, submodel_id: `urn:mini-rs-erp:submodel:apparatus:${suffix}`, semantic_id: 'urn:mini-rs-erp:semantic-id:submodel:apparatus:1', idta_release: '26-01', aas_metamodel_version: '3.2.0', aasx_part_5_version: 'IDTA-01005 v3.2', package_format: 'Open Packaging Conventions', media_type: apparatusAasxMime }, ...overrides,
  })
}
function draftOf(revision: ApparatusCanonicalRevision): ApparatusDraft {
  return parseApparatusDraft(Object.fromEntries(['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'capabilities', 'execution_profile', 'policies', 'capacity', 'placement', 'training', 'lifecycle'].map(key => [key, revision[key as keyof ApparatusCanonicalRevision]])))
}
const escapedXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
/** Fixture covers native transport/payload; final data.xml semantic validation belongs to native import. */
export function fixtureApparatusAasx(revision: ApparatusCanonicalRevision, options: { deflate?: boolean; parts?: Record<string, string>; xml?: string } = {}): Uint8Array {
  const parts = { ...apparatusCanonicalAuxParts, 'aasx/data.xml': options.xml ?? `<?xml version="1.0" encoding="UTF-8"?><environment><submodels><submodel><submodelElements><property><idShort>CanonicalPayloadJson</idShort><valueType>xs:string</valueType><value>${escapedXml(JSON.stringify(revision))}</value></property></submodelElements></submodel></submodels></environment>`, ...options.parts }
  const local: Uint8Array[] = [], central: Uint8Array[] = []; let position = 0
  for (const [name, text] of Object.entries(parts)) {
    const nameBytes = encoder.encode(name), bytes = encoder.encode(text), data = options.deflate ? new Uint8Array(deflateRawSync(bytes)) : bytes, crc = apparatusCrc32(bytes), method = options.deflate ? 8 : 0
    const header = new Uint8Array(30 + nameBytes.length), view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, method, true); view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, nameBytes.length, true); header.set(nameBytes, 30)
    const directory = new Uint8Array(46 + nameBytes.length), directoryView = new DataView(directory.buffer)
    directoryView.setUint32(0, 0x02014b50, true); directoryView.setUint16(4, 20, true); directoryView.setUint16(6, 20, true); directoryView.setUint16(10, method, true); directoryView.setUint32(16, crc, true); directoryView.setUint32(20, data.length, true); directoryView.setUint32(24, bytes.length, true); directoryView.setUint16(28, nameBytes.length, true); directoryView.setUint32(42, position, true); directory.set(nameBytes, 46)
    local.push(header, data); central.push(directory); position += header.length + data.length
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0), end = new Uint8Array(22), endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, central.length, true); endView.setUint16(10, central.length, true); endView.setUint32(12, directorySize, true); endView.setUint32(16, position, true)
  const result = new Uint8Array(position + directorySize + 22); let offset = 0
  for (const part of [...local, ...central, end]) { result.set(part, offset); offset += part.length }
  return result
}
interface Fixture extends ApparatusAdminSnapshot { bytes: Uint8Array }
async function fixture(revision = nativeRevision()): Promise<Fixture> {
  const bytes = fixtureApparatusAasx(revision), hash = await apparatusHashBytes(bytes), draft = draftOf(revision)
  const projection = parseApparatusProjection({ ...draft, apparatus_id: revision.apparatus_id, source_revision: revision.revision_metadata.revision, source_aasx_sha256: hash, capabilities: Object.fromEntries(draft.capabilities.map(capability => [capability.code, capability.level])) })
  return { revision, projection, bytes }
}
async function committed(operation: ApparatusAdminOperation, changes: Partial<ApparatusCanonicalRevision> = {}): Promise<Fixture> {
  const draft = operation.kind === 'create' ? operation.draft : operation.kind === 'patch' ? { ...draftOf(operation.baseline.revision), ...operation.input } : operation.kind === 'import' ? draftOf(operation.file.revision) : { ...draftOf(operation.baseline.revision), lifecycle: { state: 'retired' as const, retirement_reason: operation.reason } }
  return fixture(nativeRevision({ ...draft, apparatus_id: operation.kind === 'create' ? otherId : operation.baseline.revision.apparatus_id, revision_metadata: { revision: operation.kind === 'create' ? 1 : operation.baseline.projection.source_revision + 1, committed_at_unix_ms: 1_792_000_000_001, command_id: `apparatus-command:${operation.key}`, actor_id: 'principal:fixture-admin', source: operation.kind === 'import' ? 'aasx_import' : 'admin', source_reference: operation.kind === 'import' ? `sha256:${operation.file.sha256}` : null }, ...changes }))
}
function receipt(saved: Fixture): Row { return { revision: saved.revision, runtime_projection: saved.projection, aasx_sha256: saved.projection.source_aasx_sha256 } }
function orders(lifecycle?: string, orderId = 'order:001', apparatusId = id): ProductionSnapshot {
  return { ok: true, epoch: 'fixture', rev: 1, scope: '', maps: lifecycle === undefined ? [] : [{ map: { id: orderId, nodes: [{ id: 'print', kind: 'apparatus', apparatus_id: apparatusId }], edges: [] }, program: {} }], order_statuses: lifecycle === undefined ? {} : { [orderId]: { lifecycle_status: lifecycle, order_status: 'not_started' } }, order_controls: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {} }
}
const options = { contract: 'canonical_apparatus_revision', schema_version: 1, vocabulary: { execution_operations: ['print', 'laminate', 'cut', 'package', 'glue'], process_technologies: ['rotogravure', 'flexographic', 'adhesive_lamination', 'extrusion_lamination', 'slitting', 'bag_making', 'cold_glue'], equipment_capabilities: ['print', 'laminate', 'cut', 'package', 'glue', 'tooling', 'virtual_task', 'training'] } }
type Hook = (url: URL, method: string, body: Row | undefined, request: RequestInit | undefined) => unknown | Promise<unknown>
function mockApi(current: Fixture | (() => Fixture), hook?: Hook, production = orders()) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, request) => {
    const url = new URL(String(input)), method = request?.method ?? 'GET', body = typeof request?.body === 'string' ? JSON.parse(request.body) as Row : undefined
    let value = await hook?.(url, method, body, request)
    if (value instanceof Response) return value
    const data = typeof current === 'function' ? current() : current
    if (value === undefined) {
      if (method !== 'GET') throw new Error(`Unexpected fixture mutation: ${method} ${url.pathname}`)
      if (url.pathname === `${base}/options`) value = options
      else if (url.pathname === base) value = [data.projection]
      else if (url.pathname === `${base}/${encodeURIComponent(data.revision.apparatus_id)}`) value = data.projection
      else if (url.pathname === `${base}/${encodeURIComponent(data.revision.apparatus_id)}/aasx`) return new Response(new Uint8Array(data.bytes).buffer, { headers: { 'Content-Type': apparatusAasxMime, 'Content-Length': String(data.bytes.length), ETag: `"${data.projection.source_revision}-${data.projection.source_aasx_sha256}"` } })
      else if (url.pathname === '/v1/mobile/admin/production-maps/sequence') value = production
      else throw new Error(`Unexpected fixture read: ${url.pathname}`)
    }
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const writes = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.filter(call => call[1]?.method !== 'GET')
const errorResponse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })
const renamed = (current: ApparatusAdminSnapshot) => apparatusPatchOperation(current, { ...apparatusProfileForm(current.revision), name: 'Bosma yangi nom' })
const localFile = (bytes: Uint8Array, name = 'apparatus.aasx') => Object.assign(new Blob([new Uint8Array(bytes).buffer], { type: apparatusAasxMime }), { name })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('canonical directory principal, identity and read contract', () => {
  it('requires the actual manage capability independently of the role label', async () => {
    expect(apparatusAdminPermissions(actor([], 'admin'))).toEqual({ read: false, manage: false })
    expect(apparatusAdminPermissions(actor(['admin.access']))).toEqual({ read: true, manage: false })
    expect(apparatusAdminPermissions(actor(['production.map.manage'], 'aparatchi'))).toEqual({ read: true, manage: true })
    expect(apparatusAdminPermissions(null)).toEqual({ read: false, manage: false })
    const current = await fixture(), fetch = mockApi(current)
    for (const capability of ['apparatus.queue.read', 'catalog.item.read', 'preparation.access', 'raw_material.assign', 'qolip.manage']) {
      const reader = service(actor([capability], 'aparatchi'))
      await expect(reader.projection(id)).resolves.toEqual(current.projection)
      await expect(reader.read(id)).rejects.toMatchObject({ status: 403 })
      await expect(reader.options()).rejects.toMatchObject({ status: 403 })
      await expect(reader.execute(renamed(current))).rejects.toMatchObject({ status: 403 })
    }
    expect(writes(fetch)).toHaveLength(0)
  })

  it('uses opaque canonical identities and ignores conflicting display/legacy identities', () => {
    expect(apparatusAdminId({ runtime_projection: { apparatus_id: id }, apparatus_id: otherId })).toBe(id)
    for (const value of ['Bosma 01', 'apparatus:default:Asset-001', 'apparatus:default:a/', ' apparatus:default:a', null]) expect(apparatusAdminId({ apparatus_id: value })).toBe('')
    expect(apparatusAdminId({ name: 'Bosma 01', id })).toBe('')
  })

  it('reads and binds the binary native package to the matching projection and actual hash', async () => {
    const current = await fixture(), fetch = mockApi(current)
    await expect(service().read(id)).resolves.toEqual({ revision: current.revision, projection: current.projection })
    const binary = fetch.mock.calls.find(call => String(call[0]).endsWith('/aasx'))!
    expect(new Headers(binary[1]?.headers).get('Accept')).toBe(apparatusAasxMime)
    expect(new Headers(binary[1]?.headers).get('Authorization')).toBe('Bearer fixture-token')
    expect(binary[1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' })
    mockApi(current, url => url.pathname === `${base}/${encodeURIComponent(id)}` ? { ...current.projection, source_revision: 4 } : undefined)
    await expect(service().read(id)).rejects.toThrow('turli revisionlardan')
    mockApi(current, url => url.pathname.endsWith('/aasx') ? new Response(new Uint8Array(current.bytes).buffer, { headers: { 'Content-Type': 'application/zip' } }) : undefined)
    await expect(service().read(id)).rejects.toMatchObject({ status: 502 })
    mockApi(current, url => url.pathname === `${base}/${encodeURIComponent(id)}` ? { ...current.projection, apparatus_id: otherId } : undefined)
    await expect(service().read(id)).rejects.toMatchObject({ status: 502 })
  })

  it('validates the native vocabulary and reports the bounded search without inventing pagination', async () => {
    const current = await fixture(), fetch = mockApi(current)
    expect((await service().options()).capabilities).toContain('tooling')
    expect(await service().list('  Bosma  ')).toEqual({ items: [current.projection], bounded: false })
    const query = new URL(String(fetch.mock.calls.at(-1)![0])).searchParams
    expect(query.get('q')).toBe('Bosma'); expect(query.get('limit')).toBe('500'); expect(query.has('offset')).toBe(false)
    mockApi(current, url => url.pathname.endsWith('/options') ? { ...options, vocabulary: { ...options.vocabulary, equipment_capabilities: ['print', 'unknown'] } } : undefined)
    await expect(service().options()).rejects.toMatchObject({ status: 502 })
    mockApi(current, url => url.pathname === base ? [current.projection, current.projection] : undefined)
    await expect(service().list()).rejects.toMatchObject({ status: 502 })
  })

  it('fails closed on oversized binary exports and invalidates an unauthorized binary read', async () => {
    const current = await fixture(), onUnauthorized = vi.fn()
    const fetch = mockApi(current, url => url.pathname.endsWith('/aasx') ? new Response('oversize', { headers: { 'Content-Type': apparatusAasxMime, 'Content-Length': String(apparatusAasxMaxBytes + 1) } }) : undefined)
    await expect(service().read(id)).rejects.toMatchObject({ status: 502 })
    expect(writes(fetch)).toHaveLength(0)
    mockApi(current, url => url.pathname.endsWith('/aasx') || url.pathname === '/v1/mobile/me' ? errorResponse(401, 'unauthorized') : undefined)
    await expect(service(actor(), { onUnauthorized }).read(id)).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('rejects unpinned AAS identity, malformed projections and schema extras', async () => {
    const current = await fixture()
    expect(() => parseApparatusCanonicalRevision({ ...current.revision, aas_identity: { ...current.revision.aas_identity, shell_id: 'urn:other' } })).toThrow('AAS identifikatori')
    expect(() => parseApparatusCanonicalRevision({ ...current.revision, extra: true })).toThrow(ApiError)
    expect(() => parseApparatusCanonicalRevision({ ...current.revision, schema_version: 2 })).toThrow(ApiError)
    expect(() => parseApparatusProjection({ ...current.projection, source_aasx_sha256: 'placeholder' })).toThrow(ApiError)
    expect(() => parseApparatusProjection({ ...current.projection, capabilities: { print: 0 } })).toThrow(ApiError)
  })
})

describe('profile units and native business constraints', () => {
  it('preserves native description whitespace and unrelated canonical configuration', () => {
    const revision = nativeRevision(), form = apparatusProfileForm(revision), input = apparatusProfileInput({ ...form, name: '  Yangi nom  ' }, revision.policies)
    expect(input.display).toEqual({ display_name: 'Yangi nom', description: '  Saqlanadigan izoh  ', catalog_order: 10 })
    expect(Object.keys(input).sort()).toEqual(['capabilities', 'display', 'execution_profile', 'training'])
    expect(apparatusProfileInput(form, revision.policies).execution_profile).toEqual(revision.execution_profile)
  })

  it('uses Unicode character limits for display and rejects controls, invalid widths and noninteger units', () => {
    const form = apparatusProfileForm(nativeRevision())
    expect(apparatusProfileInput({ ...form, name: '😀'.repeat(256) }).display.display_name).toHaveLength(512)
    for (const patch of [{ name: '' }, { name: '😀'.repeat(257) }, { description: 'a'.repeat(2001) }, { description: 'line\nbreak' }, { minWidth: '0' }, { minWidth: '1201', maxWidth: '1200' }, { maxWidth: '100001' }, { minWidth: '1.5' }, { catalogOrder: '4294967296' }, { colorStations: '33' }, { colorStations: 'NaN' }, { levels: { print: '101', tooling: '1' } }]) expect(() => apparatusProfileInput({ ...form, ...patch })).toThrow()
  })

  it('matches operation/technology/capability and tooling, virtual and training dependencies', () => {
    const revision = nativeRevision(), form = apparatusProfileForm(revision)
    expect(apparatusTechnologies('laminate')).toEqual(['adhesive_lamination', 'extrusion_lamination'])
    expect(() => apparatusProfileInput({ ...form, technology: 'slitting' })).toThrow('o‘zaro mos')
    expect(() => apparatusProfileInput({ ...form, levels: { tooling: '1' } })).toThrow('o‘zaro mos')
    expect(() => apparatusProfileInput({ ...form, levels: { print: '3' } }, revision.policies)).toThrow('tooling')
    expect(() => apparatusProfileInput({ ...form, virtualTasks: true })).toThrow('virtual_task')
    expect(() => apparatusProfileInput({ ...form, training: { enabled: true, queue_enabled: true, material_tracking_enabled: false } })).toThrow('training')
    const enabled = apparatusProfileInput({ ...form, virtualTasks: true, levels: { ...form.levels, virtual_task: '2', training: '1' }, training: { enabled: true, queue_enabled: true, material_tracking_enabled: false } })
    expect(enabled.capabilities.map(capability => capability.code)).toEqual(['print', 'tooling', 'virtual_task', 'training'])
    expect(enabled.execution_profile.virtual_tasks).toBe('input_bridge')
    expect(apparatusProfileInput({ ...form, technology: 'flexographic', colorStations: '' }).execution_profile.color_station_count).toBeNull()
    expect(() => apparatusProfileInput({ ...form, colorStations: '' })).toThrow('stansiya')
  })

  it('requires real immutable physical asset and hierarchy on create with native initial defaults', () => {
    const form = { ...apparatusDefaultForm(), name: 'Yangi apparat' }, identity = { equipmentClass: 'equipment-class:new', physicalAsset: 'physical-asset:new', hierarchy }
    const draft = apparatusCreateDraft(form, identity)
    expect(draft.physical_asset_id).toBe(identity.physicalAsset); expect(draft.placement).toBeNull()
    expect(draft.capacity).toMatchObject({ capacity_slots: 1, setup_minutes: 0, cleanup_minutes: 0, efficiency_percent: 100, availability: { mode: 'always' } })
    expect(draft.policies).toEqual({ queue: 'strict_sequence', material: { mode: 'not_required' }, tooling: { mode: 'not_required' } })
    expect(draft).not.toHaveProperty('apparatus_id')
    for (const physicalAsset of ['', 'plain-id', 'physical asset:new', `physical-asset:${'é'.repeat(130)}`]) expect(() => apparatusCreateDraft(form, { ...identity, physicalAsset })).toThrow()
    expect(() => apparatusCreateDraft(form, { ...identity, hierarchy: { ...hierarchy, area_id: '' } })).toThrow()
    expect(() => apparatusCreateOperation({ ...draft, placement: { factory_map_object_id: 'placeholder' } })).toThrow('biriktirilmagan')
  })

  it('keeps retired lifecycle final and requires an actual retirement reason', async () => {
    const current = await fixture(), retired = await fixture(nativeRevision({ lifecycle: { state: 'retired', retirement_reason: 'Eskirgan' } }))
    for (const reason of ['', 'a'.repeat(257), 'bad\nreason']) expect(() => apparatusRetireOperation(current, reason)).toThrow('sababini')
    expect(() => apparatusPatchOperation(retired, apparatusProfileForm(retired.revision))).toThrow('Tiklash')
    expect(() => apparatusRetireOperation(retired, 'takror')).toThrow('Tiklash')
    expect(() => parseApparatusDraft({ ...nativeDraft(), lifecycle: { state: 'active', retirement_reason: 'invalid' } })).toThrow()
  })

  it('classifies actual, alternative, terminal, and unknown order references', () => {
    expect(apparatusReferences(orders('released'), id).activeOrderIds).toEqual(['order:001'])
    expect(apparatusReferences(orders('closed'), id).historicalOrderIds).toEqual(['order:001'])
    expect(apparatusReferences(orders('unrecognized'), id).unknownOrderIds).toEqual(['order:001'])
    expect(apparatusReferences(orders('released', 'order:other', otherId), id).activeOrderIds).toEqual([])
    const alternative = orders('in_progress', 'order:alternative', otherId); (alternative.maps[0].map.nodes as Row[])[0].alternative_assigned_apparatus_id = id
    expect(apparatusReferences(alternative, id).activeOrderIds).toEqual(['order:alternative'])
    const malformed = orders('closed'); malformed.maps[0].map.nodes = [null as unknown as Row]
    expect(apparatusReferences(malformed, id).unknownOrderIds).toEqual(['order:001'])
  })
})

describe('bounded local AASX transport inspection', () => {
  it('reads native stored and deflated ZIP32 parts and all XML escapes', async () => {
    const revision = nativeRevision({ display: { display_name: 'Bosma & < > " \u0027', description: 'izoh & 😀', catalog_order: 0 } })
    await expect(apparatusAasxRevision(fixtureApparatusAasx(revision))).resolves.toEqual(revision)
    await expect(apparatusAasxRevision(fixtureApparatusAasx(revision, { deflate: true }))).resolves.toEqual(revision)
    const file = await inspectApparatusAasx(localFile(fixtureApparatusAasx(revision), 'Mahalliy.AASX'))
    expect(file.name).toBe('Mahalliy.AASX'); expect(file.sha256).toMatch(/^[a-f0-9]{64}$/); expect(file.blob.type).toBe(apparatusAasxMime)
    expect(file.revision).toEqual(revision)
  })

  it('rejects arbitrary files, oversize bytes, CRC damage, extra parts and altered native OPC sidecars', async () => {
    const revision = nativeRevision(), bytes = fixtureApparatusAasx(revision), damaged = bytes.slice(); damaged[31 + '[Content_Types].xml'.length] ^= 1
    await expect(inspectApparatusAasx(localFile(bytes, 'readme.zip'))).rejects.toThrow('.aasx')
    await expect(inspectApparatusAasx(localFile(new Uint8Array()))).rejects.toThrow('.aasx')
    await expect(apparatusAasxRevision(new Uint8Array(apparatusAasxMaxBytes + 1))).rejects.toThrow('16 MiB')
    await expect(apparatusAasxRevision(damaged)).rejects.toThrow('yaxlitligi')
    await expect(apparatusAasxRevision(fixtureApparatusAasx(revision, { parts: { 'extra.txt': 'extra' } }))).rejects.toThrow('ZIP32')
    await expect(apparatusAasxRevision(fixtureApparatusAasx(revision, { parts: { '_rels/.rels': apparatusCanonicalAuxParts['_rels/.rels'].replace('aasxOrigin', 'aasxOtherx') } }))).rejects.toThrow('OPC')
  })

  it('rejects encrypted, multidisk, overlapping, malformed and unsafe payload packages', async () => {
    const revision = nativeRevision(), bytes = fixtureApparatusAasx(revision)
    const encrypted = bytes.slice(); new DataView(encrypted.buffer).setUint16(6, 1, true)
    await expect(apparatusAasxRevision(encrypted)).rejects.toThrow('jadvalga')
    const multidisk = bytes.slice(); new DataView(multidisk.buffer).setUint16(multidisk.length - 18, 1, true)
    await expect(apparatusAasxRevision(multidisk)).rejects.toThrow('ZIP32')
    const overlap = bytes.slice(), view = new DataView(overlap.buffer), central = view.getUint32(overlap.length - 6, true), secondCentral = central + 46 + '[Content_Types].xml'.length; view.setUint32(secondCentral + 42, 0, true)
    await expect(apparatusAasxRevision(overlap)).rejects.toThrow('jadvalga')
    const xml = `<property><idShort>CanonicalPayloadJson</idShort><value>${escapedXml(JSON.stringify(revision))}</value></property>`
    for (const invalidXml of [`<!DOCTYPE environment>${xml}`, `${xml}${xml}`, xml.replace('&quot;', '&#34;'), xml.replace('<value>', '<value><unsafe>'), xml.replace('</property>', '')]) await expect(apparatusAasxRevision(fixtureApparatusAasx(revision, { xml: invalidXml }))).rejects.toThrow()
    await expect(apparatusAasxRevision(bytes.subarray(0, bytes.length - 1))).rejects.toThrow()
  })

  it('only permits import for the actual apparatus while preserving protected native data', async () => {
    const current = await fixture(), changed = nativeRevision({ display: { ...current.revision.display, display_name: 'Imported' } })
    const preview = await inspectApparatusAasx(localFile(fixtureApparatusAasx(changed)))
    expect(apparatusImportOperation(current, preview).kind).toBe('import')
    for (const change of [{ physical_asset_id: 'physical-asset:different' }, { apparatus_id: otherId }, { capacity: { ...current.revision.capacity, capacity_slots: 3 } }, { policies: { ...current.revision.policies, queue: 'free_pick' } }, { placement: null }, { hierarchy: { ...hierarchy, site_id: 'site:different' } }, { lifecycle: { state: 'retired' as const, retirement_reason: 'old' } }]) {
      const candidate = await inspectApparatusAasx(localFile(fixtureApparatusAasx(nativeRevision(change))))
      expect(() => apparatusImportOperation(current, candidate)).toThrow('saqlab qolishi')
    }
  })
})

describe('canonical revision writes and conflict handling', () => {
  it('sends a narrow patch with native expected revision and command header, preserving all planning and placement fields', async () => {
    const current = await fixture(), operation = renamed(current), saved = await committed(operation)
    const fetch = mockApi(current, (_url, method) => method === 'PATCH' ? receipt(saved) : undefined, orders('released'))
    expect(await service().execute(operation)).toEqual({ snapshot: { revision: saved.revision, projection: saved.projection }, recovered: false })
    const write = writes(fetch)[0], body = JSON.parse(String(write[1]?.body))
    expect(body).toEqual({ expected_revision: 3, patch: operation.kind === 'patch' ? operation.input : null })
    expect(new Headers(write[1]?.headers).get('Idempotency-Key')).toBe(operation.key)
    expect(body.patch).not.toHaveProperty('capacity'); expect(body.patch).not.toHaveProperty('placement'); expect(body.patch).not.toHaveProperty('physical_asset_id')
    expect(fetch.mock.calls.some(call => String(call[0]).includes('production-maps'))).toBe(false)
    expect(saved.revision.policies).toEqual(current.revision.policies); expect(saved.revision.capacity).toEqual(current.revision.capacity); expect(saved.revision.placement).toEqual(current.revision.placement)
  })

  it('blocks structural edits and retirement against active or unknown actual order dependencies', async () => {
    const current = await fixture(), operation = apparatusPatchOperation(current, { ...apparatusProfileForm(current.revision), reroute: false })
    for (const lifecycle of ['released', 'in_progress', 'unknown']) {
      const fetch = mockApi(current, undefined, orders(lifecycle))
      await expect(service().execute(operation)).rejects.toBeInstanceOf(ApparatusAdminConflict)
      await expect(service().execute(apparatusRetireOperation(current, 'Eskirgan'))).rejects.toBeInstanceOf(ApparatusAdminConflict)
      expect(writes(fetch)).toHaveLength(0)
    }
  })

  it('blocks stale revision or hash before the canonical mutation', async () => {
    const baseline = await fixture(), current = await fixture(nativeRevision({ revision_metadata: { ...baseline.revision.revision_metadata, revision: 4 } })), operation = renamed(baseline)
    const fetch = mockApi(current)
    await expect(service().execute(operation)).rejects.toMatchObject({ current: { projection: { source_revision: 4 } } })
    expect(writes(fetch)).toHaveLength(0)
    const sameRevision = await fixture(nativeRevision({ display: { ...baseline.revision.display, description: 'Concurrent content' } })), second = mockApi(sameRevision)
    await expect(service().execute(operation)).rejects.toBeInstanceOf(ApparatusAdminConflict)
    expect(writes(second)).toHaveLength(0)
  })

  it('sends native final retirement while retaining identity and history', async () => {
    const current = await fixture(), operation = apparatusRetireOperation(current, '  Eskirgan apparat  '), saved = await committed(operation)
    const fetch = mockApi(current, (_url, method) => method === 'DELETE' ? receipt(saved) : undefined, orders('closed'))
    expect((await service().execute(operation)).snapshot.revision.lifecycle).toEqual({ state: 'retired', retirement_reason: 'Eskirgan apparat' })
    expect(JSON.parse(String(writes(fetch)[0][1]?.body))).toEqual({ expected_revision: 3, retirement_reason: 'Eskirgan apparat' })
    expect(saved.projection.apparatus_id).toBe(id); expect(saved.revision.physical_asset_id).toBe(current.revision.physical_asset_id)
  })

  it('creates with native draft only and accepts only the opaque server-assigned identity', async () => {
    const current = await fixture(), draft = apparatusCreateDraft({ ...apparatusDefaultForm(), name: 'Yangi' }, { equipmentClass: 'equipment-class:new', physicalAsset: 'physical-asset:new', hierarchy }), operation = apparatusCreateOperation(draft), saved = await committed(operation)
    const fetch = mockApi(current, (_url, method) => method === 'POST' ? receipt(saved) : undefined)
    const result = await service().execute(operation)
    expect(result.snapshot.revision.apparatus_id).toBe(otherId); expect(result.snapshot.projection.source_revision).toBe(1)
    expect(JSON.parse(String(writes(fetch)[0][1]?.body))).toEqual(draft)
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('q')).toBe('Yangi')
    const duplicate = apparatusCreateOperation({ ...draft, physical_asset_id: current.revision.physical_asset_id }), duplicateFetch = mockApi(current)
    await expect(service().execute(duplicate)).rejects.toThrow('boshqa apparat')
    expect(writes(duplicateFetch)).toHaveLength(0)
  })

  it('sends exact inspected local AASX bytes with native CAS header and import provenance', async () => {
    const current = await fixture(), candidate = nativeRevision({ display: { ...current.revision.display, display_name: 'AASX nomi' } }), file = await inspectApparatusAasx(localFile(fixtureApparatusAasx(candidate))), operation = apparatusImportOperation(current, file), saved = await committed(operation)
    const fetch = mockApi(current, (url, method) => method === 'POST' && url.pathname.endsWith('/aasx') ? receipt(saved) : undefined)
    await expect(service().execute(operation)).resolves.toMatchObject({ recovered: false })
    const request = writes(fetch)[0][1], headers = new Headers(request?.headers)
    expect(headers.get('If-Match')).toBe('3'); expect(headers.get('Content-Type')).toBe(apparatusAasxMime); expect(headers.get('Idempotency-Key')).toBe(operation.key)
    expect(request?.body).toBeInstanceOf(Blob)
    expect(await (request!.body as Blob).arrayBuffer()).toEqual(await file.blob.arrayBuffer())
    expect(saved.revision.revision_metadata.source_reference).toBe(`sha256:${file.sha256}`)
  })

  it('revalidates the exact import Blob before a write and prevents swapping the preview', async () => {
    const current = await fixture(), file = await inspectApparatusAasx(localFile(current.bytes)), operation = apparatusImportOperation(current, file)
    if (operation.kind !== 'import') throw new Error('test import required')
    const altered = fixtureApparatusAasx(nativeRevision({ display: { ...current.revision.display, display_name: 'Swapped' } })); operation.file = { ...file, blob: localFile(altered) }
    const fetch = mockApi(current)
    await expect(service().execute(operation)).rejects.toThrow('ko‘rib chiqilgan')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requires native import provenance and blocks import when actual route dependencies are unknown', async () => {
    const current = await fixture(), file = await inspectApparatusAasx(localFile(current.bytes)), operation = apparatusImportOperation(current, file), saved = await committed(operation)
    for (const metadata of [{ ...saved.revision.revision_metadata, source: 'admin' }, { ...saved.revision.revision_metadata, source_reference: `sha256:${'a'.repeat(64)}` }]) {
      const invalid = await committed(operation, { revision_metadata: metadata })
      const fetch = mockApi(current, (_url, method) => method === 'POST' ? receipt(invalid) : undefined)
      await expect(service().execute(operation)).rejects.toBeInstanceOf(ApparatusAdminUnknown)
      expect(writes(fetch)).toHaveLength(1)
      mockApi(invalid)
      await expect(service().recover(operation)).rejects.toBeInstanceOf(ApparatusAdminConflict)
    }
    const fetch = mockApi(current, undefined, orders('unknown'))
    await expect(service().execute(operation)).rejects.toBeInstanceOf(ApparatusAdminConflict)
    expect(writes(fetch)).toHaveLength(0)
  })

  it('retains native 403/409 failures without replay or success conversion', async () => {
    const current = await fixture(), operation = renamed(current)
    for (const [status, code] of [[403, 'forbidden'], [409, 'apparatus_revision_conflict'], [409, 'apparatus_already_exists'], [422, 'apparatus_revision_invalid']] as const) {
      const fetch = mockApi(current, (_url, method) => method === 'PATCH' ? errorResponse(status, code) : undefined)
      await expect(service().execute(operation)).rejects.toMatchObject({ status, code })
      expect(writes(fetch)).toHaveLength(1)
    }
  })

  it('requires exact committed identity, actor, command, revision, hash and intended field values', async () => {
    const current = await fixture(), operation = renamed(current), saved = await committed(operation)
    const variants = [
      { ...receipt(saved), aasx_sha256: 'a'.repeat(64) },
      receipt(await committed(operation, { apparatus_id: otherId })),
      receipt(await committed(operation, { revision_metadata: { ...saved.revision.revision_metadata, actor_id: 'principal:someone-else' } })),
      receipt(await committed(operation, { revision_metadata: { ...saved.revision.revision_metadata, command_id: 'apparatus-command:different' } })),
      receipt(await committed(operation, { revision_metadata: { ...saved.revision.revision_metadata, revision: 5 } })),
      receipt(await committed(operation, { capacity: { ...current.revision.capacity, capacity_slots: 9 } })),
      { ok: true, revision: receipt(saved) },
    ]
    for (const value of variants) { const fetch = mockApi(current, (_url, method) => method === 'PATCH' ? value : undefined); await expect(service().execute(operation)).rejects.toBeInstanceOf(ApparatusAdminUnknown); expect(writes(fetch)).toHaveLength(1) }
    const retire = apparatusRetireOperation(current, 'old'), mismatched = await committed(retire, { display: { ...current.revision.display, display_name: 'Unexpected unrelated change' } })
    mockApi(current, (_url, method) => method === 'DELETE' ? receipt(mismatched) : undefined)
    await expect(service().execute(retire)).rejects.toBeInstanceOf(ApparatusAdminUnknown)
  })
})

describe('uncertain and interrupted saves recover only by readback', () => {
  it('recovers a lost response from exact current command proof using only GETs', async () => {
    const baseline = await fixture(), operation = renamed(baseline); let current = baseline
    const fetch = mockApi(() => current, async (_url, method) => { if (method === 'PATCH') { current = await committed(operation); throw new TypeError('network lost after commit') } })
    await expect(service().execute(operation)).rejects.toBeInstanceOf(ApparatusAdminUnknown)
    expect(writes(fetch)).toHaveLength(1)
    const count = fetch.mock.calls.length, result = await service().recover(operation)
    expect(result.recovered).toBe(true); expect(result.snapshot.projection.source_revision).toBe(4)
    expect(fetch.mock.calls.slice(count).every(call => call[1]?.method === 'GET')).toBe(true)
    expect(writes(fetch)).toHaveLength(1)
  })

  it('does not claim a save from another command, unchanged revision or diverged profile', async () => {
    const baseline = await fixture(), operation = renamed(baseline), saved = await committed(operation)
    for (const current of [baseline, await committed(operation, { revision_metadata: { ...saved.revision.revision_metadata, command_id: 'apparatus-command:other' } }), await committed(operation, { display: { ...saved.revision.display, display_name: 'Later edit' } })]) {
      const fetch = mockApi(current)
      await expect(service().recover(operation)).rejects.toBeInstanceOf(ApparatusAdminConflict)
      expect(writes(fetch)).toHaveLength(0)
    }
  })

  it('looks up an uncertain create by immutable asset and command without inferring failure from bounded absence', async () => {
    const baseline = await fixture(), draft = apparatusCreateDraft({ ...apparatusDefaultForm(), name: 'Yangi' }, { equipmentClass: 'equipment-class:new', physicalAsset: 'physical-asset:new', hierarchy }), operation = apparatusCreateOperation(draft), saved = await committed(operation)
    const fetch = mockApi(saved)
    await expect(service().recover(operation)).resolves.toMatchObject({ recovered: true, snapshot: { projection: { apparatus_id: otherId } } })
    expect(writes(fetch)).toHaveLength(0)
    const absence = mockApi(baseline, url => url.pathname === base ? [] : undefined)
    await expect(service().recover(operation)).rejects.toBeInstanceOf(ApparatusAdminUnknown)
    expect(writes(absence)).toHaveLength(0)
    mockApi(await committed(operation, { revision_metadata: { ...saved.revision.revision_metadata, command_id: 'apparatus-command:another' } }))
    await expect(service().recover(operation)).rejects.toBeInstanceOf(ApparatusAdminUnknown)
  })

  it('preserves unknown state when readback is unavailable and treats preflight failures as no attempted write', async () => {
    const current = await fixture(), operation = renamed(current)
    const fetch = mockApi(current, () => errorResponse(503, 'unavailable'))
    await expect(service().execute(operation)).rejects.toBeInstanceOf(ApiError)
    await expect(service().recover(operation)).rejects.toBeInstanceOf(ApparatusAdminUnknown)
    expect(writes(fetch)).toHaveLength(0)
  })

  it('honors aborts before requests and suppresses a late mutation result after a session/record cancellation', async () => {
    const current = await fixture(), operation = renamed(current), controller = new AbortController(); controller.abort()
    const fetch = mockApi(current)
    await expect(service().execute(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(service().recover(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    const running = new AbortController(), saved = await committed(operation)
    const later = mockApi(current, (_url, method) => { if (method === 'PATCH') { running.abort(); return receipt(saved) } })
    await expect(service().execute(operation, running.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes(later)).toHaveLength(1)
    await expect(service().recover(operation)).rejects.toBeInstanceOf(ApparatusAdminConflict)
    expect(writes(later)).toHaveLength(1)
  })

  it('respects unauthorized session invalidation and snapshots principal capability changes', async () => {
    const current = await fixture(), operation = renamed(current), onUnauthorized = vi.fn(), session = actor(), api = service(session, { onUnauthorized })
    session.capabilities.length = 0; session.profile.ref = 'another'
    const saved = await committed(operation), fetch = mockApi(current, (_url, method) => method === 'PATCH' ? receipt(saved) : undefined)
    await expect(api.execute(operation)).resolves.toMatchObject({ recovered: false })
    expect(writes(fetch)).toHaveLength(1)
    mockApi(current, url => url.pathname === `${base}/${encodeURIComponent(id)}` ? errorResponse(401, 'unauthorized') : undefined)
    await expect(api.read(id)).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('documents actual API limitations and uses actionable native business errors', () => {
    expect(APPARATUS_ADMIN_API_LIMITATIONS.join(' ')).toContain('no restore')
    expect(APPARATUS_ADMIN_API_LIMITATIONS.join(' ')).toContain('no order/worker dependency precheck')
    expect(APPARATUS_ADMIN_API_LIMITATIONS.join(' ')).toContain('never an automatic repeated mutation')
    expect(apparatusAdminError(new ApiError(409, 'apparatus_revision_conflict'))).toContain('revisioni o‘zgargan')
    expect(apparatusAdminError(new ApiError(409, 'apparatus_retired'))).toContain('tahrirlanmaydi')
  })
})
