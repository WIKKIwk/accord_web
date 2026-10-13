import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Session } from './api-types'
import {
  MaterialCatalogApi, MaterialCatalogConflict, MaterialSaveUnknown, coefficientToGsm, gsmToCoefficient,
  materialCatalogFingerprint, materialCatalogSnapshot, materialFormFrom, materialInputFromForm,
  materialMatchesInput, materialNameKey, materialOperationMatches, normalizeMaterialInput,
  parseCatalogMaterial, parseMaterialDecimal, validateMaterialName, validateMaterialSequence,
} from './material-catalog'
import type { CatalogMaterial, MaterialInput, MaterialPendingOperation } from './material-catalog'
import { MutationScope } from './mutation-scope'

const actor = (capabilities = ['admin.access']): Session => ({ token: 'test-token', profile: { role: 'admin', ref: 'admin', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const api = (capabilities?: string[]) => new MaterialCatalogApi(new ApiClient({ endpoint: 'https://erp.example.test', token: 'test-token' }), actor(capabilities))
const materialA: CatalogMaterial = { id: 'material-a', name: 'BOPP', active: true, density_g_cm3: 0.9, sort_order: 0, variants: [{ micron: 20, coefficient: gsmToCoefficient(18) }] }
const materialB: CatalogMaterial = { id: 'material-b', name: 'PET', active: true, density_g_cm3: 1.4, sort_order: 1, variants: [{ micron: 12, coefficient: gsmToCoefficient(16.8), actual_gsm: 16.8 }] }
const hidden: CatalogMaterial = { id: 'material-hidden', name: 'PE oq', active: false, density_g_cm3: 0.92, sort_order: 2, variants: [] }
const envelope = (materials: CatalogMaterial[]) => ({ ok: true, materials })
const before = () => materialCatalogSnapshot(envelope([materialA, materialB, hidden]))
const edited = (): CatalogMaterial => ({ ...materialA, name: 'BOPP yangi', density_g_cm3: 0.95, variants: [{ micron: 20, coefficient: gsmToCoefficient(19) }] })
const editedInput = () => normalizeMaterialInput(edited())
type ResponseFixture = unknown | Error
function respond(...fixtures: ResponseFixture[]) {
  let index = 0
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    const item = fixtures[Math.min(index++, fixtures.length - 1)]
    if (item instanceof Error) throw item
    const result = item && typeof item === 'object' && 'status' in item && 'payload' in item ? item as { status: number; payload: unknown } : { status: 200, payload: item }
    return new Response(JSON.stringify(result.payload), { status: result.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function url(fetch: ReturnType<typeof respond>, index = 0) { return new URL(String(fetch.mock.calls[index][0])) }
function body(fetch: ReturnType<typeof respond>, index = 0) { return JSON.parse(String(fetch.mock.calls[index][1]?.body)) }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('material/micron normalization and numeric policy', () => {
  it('validates decimal commas, finite values, and positive u32 micron values', () => {
    expect(parseMaterialDecimal(' 0,905 ', 'Zichlik')).toBe(0.905)
    expect(parseMaterialDecimal('.95', 'Zichlik')).toBe(0.95)
    expect(parseMaterialDecimal('', 'Zichlik', true)).toBe(0)
    for (const input of ['NaN', 'Infinity', '1e10', '0x10', '-0.5', '1,2,3']) expect(() => parseMaterialDecimal(input, 'Zichlik')).toThrow()
    for (const micron of [0, -1, 1.5, Number.NaN, 4_294_967_296]) expect(() => normalizeMaterialInput({ ...materialA, variants: [{ micron, coefficient: 1 }] })).toThrow('Mikron')
    for (const density of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => normalizeMaterialInput({ ...materialA, density_g_cm3: density })).toThrow('Zichlik')
  })

  it('allows density-only materials and removing every micron when a positive density remains', () => {
    expect(materialInputFromForm({ id: materialA.id, name: 'BOPP', density: '0,905', active: true, variants: [] })).toEqual({ id: materialA.id, name: 'BOPP', density_g_cm3: 0.905, active: true, variants: [] })
    expect(() => materialInputFromForm({ id: materialA.id, name: 'BOPP', density: '', active: true, variants: [] })).toThrow('kamida bitta mikron')
  })

  it('derives coefficients from density and honors a GSM override using the native formula', () => {
    const result = normalizeMaterialInput({ ...materialA, density_g_cm3: 0.905, variants: [
      { micron: 30, coefficient: 99 }, { micron: 20, coefficient: 99, actual_gsm: 19, first_layer_coefficient: 88 },
    ] })
    expect(result.variants).toEqual([{ micron: 20, coefficient: gsmToCoefficient(19), actual_gsm: 19 }, { micron: 30, coefficient: gsmToCoefficient(30 * 0.905) }])
    expect(result.variants.every(variant => !('first_layer_coefficient' in variant))).toBe(true)
    expect(result).not.toHaveProperty('sort_order')
  })

  it('edits a coefficient through an equivalent GSM override rather than an ignored independent value', () => {
    const form = { id: materialA.id, name: materialA.name, active: true, density: '0.9', variants: [{ key: '1', micron: '20', mode: 'coefficient' as const, value: '1,2' }] }
    const result = materialInputFromForm(form)
    expect(result.variants[0].actual_gsm).toBe(coefficientToGsm(1.2))
    expect(result.variants[0].coefficient).toBeCloseTo(1.2)
    expect(() => materialInputFromForm({ ...form, variants: [{ ...form.variants[0], value: '0' }] })).toThrow('GSM')
  })

  it('supports legacy coefficient-only values when density and GSM are absent', () => {
    const input = normalizeMaterialInput({ ...materialA, density_g_cm3: 0, variants: [{ micron: 20, coefficient: 1.2 }] })
    expect(input.variants[0].coefficient).toBeCloseTo(1.2)
    expect(input.variants[0]).not.toHaveProperty('actual_gsm')
    expect(() => normalizeMaterialInput({ ...input, variants: [{ micron: 20, coefficient: 0 }] })).toThrow('haqiqiy GSM')
    const form = materialFormFrom({ ...materialA, density_g_cm3: 0, variants: [{ micron: 20, coefficient: 1.2 }] })
    expect(form.variants[0]).toMatchObject({ mode: 'coefficient', value: '1.2' })
  })

  it('rejects duplicate/missing micron values and invalid GSM overrides', () => {
    expect(() => normalizeMaterialInput({ ...materialA, variants: [materialA.variants[0], materialA.variants[0]] })).toThrow('takrorlanmasligi')
    for (const actual_gsm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => normalizeMaterialInput({ ...materialA, variants: [{ micron: 20, coefficient: 1, actual_gsm }] })).toThrow('GSM')
    expect(() => materialInputFromForm({ id: '', name: 'PE', density: '0.92', active: true, variants: [{ key: '1', micron: '', mode: 'gsm', value: '18' }] })).toThrow('Mikron')
    expect(materialInputFromForm({ id: '', name: 'PE', density: '0.92', active: true, variants: [{ key: '1', micron: '', mode: 'density', value: '' }] }).variants).toEqual([])
  })

  it('matches backend name uniqueness across spaces/punctuation/case and includes hidden materials', () => {
    expect(materialNameKey(' PE - OQ ')).toBe('peoq')
    expect(() => validateMaterialName(before().materials, { ...materialA, id: '', name: ' PE_OQ ' })).toThrow('mavjud')
    expect(() => validateMaterialName(before().materials, materialA)).not.toThrow()
    expect(() => normalizeMaterialInput({ ...materialA, name: ' ' })).toThrow('nomi')
    expect(() => normalizeMaterialInput({ ...materialA, name: 'a'.repeat(121) })).toThrow('120')
  })

  it('decodes the complete catalog strictly rather than dropping unrelated malformed entries', () => {
    expect(() => materialCatalogSnapshot({ materials: [materialA] })).toThrow(ApiError)
    expect(() => materialCatalogSnapshot(envelope([materialA, { ...materialB, variants: 'broken' } as unknown as CatalogMaterial]))).toThrow(ApiError)
    expect(() => materialCatalogSnapshot(envelope([materialA, materialA]))).toThrow(ApiError)
    expect(() => parseCatalogMaterial({ ...materialA, active: 'true' })).toThrow(ApiError)
    expect(() => parseCatalogMaterial({ ...materialA, sort_order: -1 })).toThrow(ApiError)
    expect(() => parseCatalogMaterial({ ...materialA, density_g_cm3: 0, variants: [] })).toThrow(ApiError)
  })

  it('fingerprints catalog order, active flags, rank, GSM, density, and legacy coefficients', () => {
    const base = before().fingerprint
    expect(materialCatalogFingerprint([materialB, materialA, hidden])).not.toBe(base)
    expect(materialCatalogFingerprint([{ ...materialA, active: false }, materialB, hidden])).not.toBe(base)
    expect(materialCatalogFingerprint([{ ...materialA, sort_order: 99 }, materialB, hidden])).not.toBe(base)
    expect(materialCatalogFingerprint([edited(), materialB, hidden])).not.toBe(base)
    expect(materialCatalogFingerprint([{ ...materialA, variants: [{ ...materialA.variants[0], first_layer_coefficient: 1 }] }, materialB, hidden])).not.toBe(base)
  })
})

describe('native catalog authority and singular upsert contracts', () => {
  it('allows read with production.map.manage while every mutation requires admin.access', async () => {
    const fetch = respond(envelope(before().materials)), readonly = api(['production.map.manage'])
    expect((await readonly.read()).materials).toEqual(before().materials)
    await expect(readonly.save(before(), editedInput())).rejects.toMatchObject({ status: 403 })
    await expect(readonly.reorder(before(), [materialB.id, materialA.id])).rejects.toMatchObject({ status: 403 })
    await expect(api(['catalog.item.read']).read()).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends one exact upsert DTO, preserves unrelated entries, and verifies the resulting whole catalog', async () => {
    const after = [edited(), materialB, hidden]
    const fetch = respond(envelope(before().materials), { ok: true, material: edited() }, envelope(after))
    const result = await api().save(before(), { ...edited(), sort_order: 99 } as MaterialInput)
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET'])
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/admin/calculate-materials')
    expect(body(fetch, 1)).toEqual(editedInput())
    expect(body(fetch, 1)).not.toHaveProperty('materials')
    expect(body(fetch, 1)).not.toHaveProperty('sort_order')
    expect(result.snapshot.materials.filter(material => material.id !== materialA.id)).toEqual([materialB, hidden])
    expect(result.material).toEqual(edited())
    expect(result.recovered).toBe(false)
    expect(result.changedDuringSave).toBe(false)
  })

  it('creates with an empty ID and trusts the server-assigned identity', async () => {
    const draft = normalizeMaterialInput({ ...materialA, id: '', name: 'CPP' })
    const created = { ...draft, id: 'material-server-assigned', sort_order: 3 }
    const fetch = respond(envelope(before().materials), { ok: true, material: created }, envelope([...before().materials, created]))
    const result = await api().save(before(), draft)
    expect(body(fetch, 1).id).toBe('')
    expect(result.material?.id).toBe('material-server-assigned')
  })

  it('hides/restores through the active flag and never calls an invented delete endpoint', async () => {
    const inactive = { ...materialA, active: false, sort_order: 2 }
    const after = [{ ...materialB, sort_order: 0 }, { ...hidden, sort_order: 1 }, inactive]
    const fetch = respond(envelope(before().materials), { ok: true, material: inactive }, envelope(after))
    expect((await api().save(before(), inactive)).material?.active).toBe(false)
    expect(body(fetch, 1)).toMatchObject({ id: materialA.id, active: false })
    expect(fetch.mock.calls.every(call => call[1]?.method !== 'DELETE')).toBe(true)
  })

  it('blocks stale baselines, duplicate hidden names, and missing selected IDs before any PUT', async () => {
    const changed = materialCatalogSnapshot(envelope([materialA, { ...materialB, name: 'PET yangi' }, hidden]))
    const fetch = respond(envelope(changed.materials))
    await expect(api().save(before(), editedInput())).rejects.toMatchObject({ name: 'MaterialCatalogConflict', current: changed })
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(api().save(before(), { ...materialA, id: '', name: 'PE-OQ' })).rejects.toThrow('mavjud')
    await expect(api().save(before(), { ...materialA, id: 'missing' })).rejects.toThrow('topilmadi')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('treats no-op edits as already confirmed without sending a write', async () => {
    const fetch = respond(envelope(before().materials))
    const result = await api().save(before(), normalizeMaterialInput(materialA))
    expect(result.material).toEqual(materialA)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not mistake tiny but different densities or coefficients for a matching save', () => {
    const tiny = normalizeMaterialInput({ ...materialA, density_g_cm3: 1e-12 })
    expect(materialMatchesInput({ ...tiny, density_g_cm3: 0 }, tiny)).toBe(false)
    expect(materialMatchesInput({ ...tiny, variants: [{ ...tiny.variants[0], coefficient: 0 }] }, tiny)).toBe(false)
  })

  it('does not overwrite a concurrent change to an unrelated entry and returns its refreshed value', async () => {
    const otherChanged = { ...materialB, name: 'PET boshqa' }
    const fetch = respond(envelope(before().materials), { ok: true, material: edited() }, envelope([edited(), otherChanged, hidden]))
    const result = await api().save(before(), editedInput())
    expect(result.changedDuringSave).toBe(true)
    expect(result.snapshot.materials[1]).toEqual(otherChanged)
    expect(body(fetch, 1)).not.toHaveProperty('materials')
    expect(JSON.stringify(body(fetch, 1))).not.toContain(otherChanged.id)
  })
})

describe('active-only sequence contracts', () => {
  it('requires all active material IDs exactly once and keeps hidden IDs out of the body', () => {
    expect(() => validateMaterialSequence(before().materials, [materialB.id, materialA.id])).not.toThrow()
    for (const ids of [[materialA.id], [materialA.id, materialA.id], [materialA.id, hidden.id], [materialA.id, 'unknown'], [materialA.id, materialB.id, hidden.id]]) expect(() => validateMaterialSequence(before().materials, ids)).toThrow('barcha faol')
  })

  it('uses the native sequence PUT and preserves hidden rows and every entry’s content', async () => {
    const reordered = [{ ...materialB, sort_order: 0 }, { ...materialA, sort_order: 1 }, hidden]
    const fetch = respond(envelope(before().materials), envelope(reordered))
    const result = await api().reorder(before(), [materialB.id, materialA.id])
    expect(url(fetch, 1).pathname).toBe('/v1/mobile/admin/calculate-materials/sequence')
    expect(fetch.mock.calls[1][1]?.method).toBe('PUT')
    expect(body(fetch, 1)).toEqual({ material_ids: [materialB.id, materialA.id] })
    expect(result.snapshot.materials).toEqual(reordered)
  })

  it('refuses stale reorder baselines without making an atomic/CAS claim', async () => {
    const fetch = respond(envelope([{ ...materialA, density_g_cm3: 0.91 }, materialB, hidden]))
    await expect(api().reorder(before(), [materialB.id, materialA.id])).rejects.toBeInstanceOf(MaterialCatalogConflict)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.method).toBe('GET')
  })

  it('does not confirm a sequence response that changed or dropped hidden entries', () => {
    const operation: MaterialPendingOperation = { kind: 'sequence', ids: [materialB.id, materialA.id], baseline: before() }
    expect(materialOperationMatches(operation, materialCatalogSnapshot(envelope([materialB, materialA, hidden])))).toBe(true)
    expect(materialOperationMatches(operation, materialCatalogSnapshot(envelope([materialB, materialA])))).toBe(false)
    expect(materialOperationMatches(operation, materialCatalogSnapshot(envelope([materialB, materialA, { ...hidden, name: 'changed' }])))).toBe(false)
  })
})

describe('uncertain write recovery and scoped cancellation', () => {
  it('recovers a save after a server error by reading the applied value, without a second PUT', async () => {
    const fetch = respond(envelope(before().materials), { status: 500, payload: { error: 'calculate materials store failed' } }, envelope([edited(), materialB, hidden]))
    const result = await api().save(before(), editedInput())
    expect(result.recovered).toBe(true)
    expect(result.material).toEqual(edited())
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET'])
  })

  it('recovers when the acknowledgement succeeded but the first confirmation read lost its connection', async () => {
    const fetch = respond(envelope(before().materials), { ok: true, material: edited() }, new TypeError('Connection lost'), envelope([edited(), materialB, hidden]))
    expect((await api().save(before(), editedInput())).recovered).toBe(true)
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET', 'GET'])
  })

  it('keeps a failed read-back unresolved and permits explicit read-only recovery later', async () => {
    const draft = normalizeMaterialInput({ ...materialA, id: '', name: 'CPP' })
    const fetch = respond(envelope(before().materials), new TypeError('Lost after write'), envelope(before().materials))
    const service = api()
    let failure: unknown
    try { await service.save(before(), draft) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(MaterialSaveUnknown)
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1)
    const created = { ...draft, id: 'material-created' }
    const recoveryFetch = respond(envelope([...before().materials, created]))
    const result = await service.recover((failure as MaterialSaveUnknown).operation)
    expect(result.recovered).toBe(true)
    expect(result.material).toEqual(created)
    expect(recoveryFetch.mock.calls[0][1]?.method).toBe('GET')
  })

  it('does not falsely claim confirmation when the same selected entry changed again during save', async () => {
    const otherTarget = { ...edited(), name: 'Someone else changed it' }
    const fetch = respond(envelope(before().materials), { ok: true, material: edited() }, envelope([otherTarget, materialB, hidden]))
    await expect(api().save(before(), editedInput())).rejects.toMatchObject({ name: 'MaterialSaveUnknown' })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1)
  })

  it('leaves rejected 400/403 writes rejected rather than hiding them behind recovery', async () => {
    const fetch = respond(envelope(before().materials), { status: 403, payload: { error: 'forbidden' } })
    await expect(api().save(before(), editedInput())).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('recovers an uncertain sequence using a GET and checks both active and hidden content', async () => {
    const after = [{ ...materialB, sort_order: 0 }, { ...materialA, sort_order: 1 }, hidden]
    const fetch = respond(envelope(before().materials), new TypeError('Lost acknowledgement'), envelope(after))
    const result = await api().reorder(before(), [materialB.id, materialA.id])
    expect(result.recovered).toBe(true)
    expect(result.snapshot.materials).toEqual(after)
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET'])
  })

  it('rejects a misidentified acknowledgement and only accepts matching state from read recovery', async () => {
    const fetch = respond(envelope(before().materials), { ok: true, material: { ...edited(), id: materialB.id } }, envelope([edited(), materialB, hidden]))
    expect((await api().save(before(), editedInput())).recovered).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(materialMatchesInput(materialB, editedInput())).toBe(false)
  })

  it('cancels before PUT when the session or selected item changes during the precheck', async () => {
    let complete!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise<Response>(resolve => { complete = resolve }))
    vi.stubGlobal('fetch', fetch)
    const mutations = new MutationScope(), lease = mutations.begin()
    const pending = api().save(before(), editedInput(), lease.controller.signal)
    mutations.cancelAll(); complete(new Response(JSON.stringify(envelope(before().materials)), { status: 200 }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mutations.isCurrent(lease)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.method).toBe('GET')
  })
})
