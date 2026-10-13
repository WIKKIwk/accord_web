import { ApiClient, ApiError, record, rows } from './api'
import type { Row, Session } from './api-types'
import { hasCapability } from './permissions'

const path = '/v1/mobile/admin/calculate-materials'
const maxU32 = 4_294_967_295
export interface MaterialVariant {
  micron: number
  coefficient: number
  actual_gsm?: number
  first_layer_coefficient?: number
}
export interface CatalogMaterial {
  id: string
  name: string
  active: boolean
  density_g_cm3: number
  variants: MaterialVariant[]
  sort_order?: number
}
export type MaterialInput = Omit<CatalogMaterial, 'sort_order'>
export interface MaterialCatalogSnapshot { materials: CatalogMaterial[]; fingerprint: string }
export interface MaterialVariantForm { key: string; micron: string; mode: 'density' | 'gsm' | 'coefficient'; value: string }
export interface MaterialForm { id: string; name: string; active: boolean; density: string; variants: MaterialVariantForm[] }
export type MaterialPendingOperation = { kind: 'upsert'; input: MaterialInput; baseline: MaterialCatalogSnapshot } | { kind: 'sequence'; ids: string[]; baseline: MaterialCatalogSnapshot }
export interface MaterialSaveResult { snapshot: MaterialCatalogSnapshot; material?: CatalogMaterial; recovered: boolean; changedDuringSave: boolean }

function invalidResponse(): never { throw new ApiError(502, 'invalid_response', 'Materiallar haqidagi javob to‘liq kelmadi. Ro‘yxatni yangilang.') }
function finite(value: unknown, allowZero = true): value is number { return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) }
function unsigned(value: unknown, allowZero = false): value is number { return finite(value, allowZero) && Number.isInteger(value) && value <= maxU32 }
export function materialNameKey(name: string): string { return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '') }
export function gsmToCoefficient(gsm: number): number { return gsm * (60_000 / 1_000_000) }
export function coefficientToGsm(coefficient: number): number { return coefficient * (1_000_000 / 60_000) }
export function effectiveMaterialGsm(density: number, variant: MaterialVariant): number | undefined {
  return variant.actual_gsm ?? (density > 0 ? variant.micron * density : variant.coefficient > 0 ? coefficientToGsm(variant.coefficient) : undefined)
}
export function parseCatalogMaterial(value: unknown): CatalogMaterial {
  const material = record(value)
  if (typeof material.id !== 'string' || !material.id.trim() || typeof material.name !== 'string' || !material.name.trim()
    || typeof material.active !== 'boolean' || !finite(material.density_g_cm3)) return invalidResponse()
  if (material.sort_order !== undefined && material.sort_order !== null && !unsigned(material.sort_order, true)) return invalidResponse()
  const variants = rows(material, 'variants').map(row => {
    if (!unsigned(row.micron) || !finite(row.coefficient)) return invalidResponse()
    if (row.actual_gsm !== undefined && row.actual_gsm !== null && !finite(row.actual_gsm, false)) return invalidResponse()
    if (row.first_layer_coefficient !== undefined && row.first_layer_coefficient !== null && !finite(row.first_layer_coefficient)) return invalidResponse()
    return { micron: row.micron, coefficient: row.coefficient,
      ...(typeof row.actual_gsm === 'number' ? { actual_gsm: row.actual_gsm } : {}),
      ...(typeof row.first_layer_coefficient === 'number' ? { first_layer_coefficient: row.first_layer_coefficient } : {}) }
  })
  if (new Set(variants.map(variant => variant.micron)).size !== variants.length) return invalidResponse()
  if (!variants.length && material.density_g_cm3 <= 0 || variants.some(variant => !finite(effectiveMaterialGsm(material.density_g_cm3 as number, variant), false))) return invalidResponse()
  return { id: material.id, name: material.name, active: material.active, density_g_cm3: material.density_g_cm3,
    variants, ...(typeof material.sort_order === 'number' ? { sort_order: material.sort_order } : {}) }
}
function materialContent(material: CatalogMaterial | MaterialInput): Row {
  return { id: material.id, name: material.name, active: material.active, density_g_cm3: material.density_g_cm3,
    variants: [...material.variants].sort((a, b) => a.micron - b.micron).map(variant => ({ micron: variant.micron, coefficient: variant.coefficient,
      actual_gsm: variant.actual_gsm ?? null, first_layer_coefficient: variant.first_layer_coefficient ?? null })) }
}
export function materialCatalogFingerprint(materials: CatalogMaterial[]): string {
  return JSON.stringify(materials.map(material => ({ ...materialContent(material), sort_order: material.sort_order ?? null })))
}
export function materialCatalogSnapshot(value: unknown): MaterialCatalogSnapshot {
  const payload = record(value)
  if (payload.ok !== true) return invalidResponse()
  const materials = rows(payload, 'materials').map(parseCatalogMaterial)
  if (new Set(materials.map(material => material.id)).size !== materials.length) return invalidResponse()
  return { materials, fingerprint: materialCatalogFingerprint(materials) }
}
export function normalizeMaterialInput(input: MaterialInput): MaterialInput {
  const name = input.name.trim(), id = input.id.trim()
  if (!name || Array.from(name).length > 120) throw new Error('Material nomi 1 dan 120 tagacha belgi bo‘lishi kerak.')
  if (typeof input.active !== 'boolean' || !finite(input.density_g_cm3)) throw new Error('Zichlik noldan kichik bo‘lmagan chekli son bo‘lishi kerak.')
  if (!Array.isArray(input.variants)) throw new Error('Mikronlar ro‘yxati noto‘g‘ri.')
  const variants = input.variants.map(variant => {
    if (!unsigned(variant.micron)) throw new Error('Mikron musbat butun son bo‘lishi kerak.')
    if (!finite(variant.coefficient)) throw new Error('Koeffitsiyent noldan kichik bo‘lmagan chekli son bo‘lishi kerak.')
    if (variant.actual_gsm !== undefined && !finite(variant.actual_gsm, false)) throw new Error('Haqiqiy GSM musbat chekli son bo‘lishi kerak.')
    const gsm = effectiveMaterialGsm(input.density_g_cm3, variant)
    if (!finite(gsm, false) || !finite(gsmToCoefficient(gsm), false)) throw new Error('Zichlik yoki har bir mikron uchun haqiqiy GSM kerak.')
    // Native normalization derives this value and clears first_layer_coefficient.
    return { micron: variant.micron, coefficient: gsmToCoefficient(gsm), ...(variant.actual_gsm !== undefined ? { actual_gsm: variant.actual_gsm } : {}) }
  }).sort((a, b) => a.micron - b.micron)
  if (new Set(variants.map(variant => variant.micron)).size !== variants.length) throw new Error('Bir materialda mikronlar takrorlanmasligi kerak.')
  if (!variants.length && input.density_g_cm3 <= 0) throw new Error('Zichlik yoki kamida bitta mikron kerak.')
  return { id, name, active: input.active, density_g_cm3: input.density_g_cm3, variants }
}
export function materialFormFrom(material?: CatalogMaterial): MaterialForm {
  return { id: material?.id ?? '', name: material?.name ?? '', active: material?.active ?? true,
    density: material && material.density_g_cm3 > 0 ? String(material.density_g_cm3) : '',
    variants: (material?.variants ?? []).map((variant, index) => ({ key: `existing-${index}`, micron: String(variant.micron),
      mode: variant.actual_gsm !== undefined ? 'gsm' : (material?.density_g_cm3 ?? 0) > 0 ? 'density' : 'coefficient',
      value: variant.actual_gsm !== undefined ? String(variant.actual_gsm) : (material?.density_g_cm3 ?? 0) > 0 ? '' : String(variant.coefficient) })) }
}
export function parseMaterialDecimal(value: string, label: string, allowEmpty = false): number {
  const trimmed = value.trim()
  if (!trimmed && allowEmpty) return 0
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(trimmed)) throw new Error(`${label}: to‘g‘ri son kiriting.`)
  const number = Number(trimmed.replace(',', '.'))
  if (!Number.isFinite(number)) throw new Error(`${label}: to‘g‘ri son kiriting.`)
  return number
}
export function materialInputFromForm(form: MaterialForm): MaterialInput {
  const density = parseMaterialDecimal(form.density, 'Zichlik', true)
  const variants: MaterialVariant[] = form.variants.flatMap(variant => {
    if (!variant.micron.trim() && !variant.value.trim()) return []
    if (!/^\d+$/.test(variant.micron.trim())) throw new Error('Mikron musbat butun son bo‘lishi kerak.')
    const micron = Number(variant.micron.trim())
    let actualGsm: number | undefined
    if (variant.mode !== 'density') {
      const value = parseMaterialDecimal(variant.value, variant.mode === 'gsm' ? 'Haqiqiy GSM' : 'Koeffitsiyent')
      actualGsm = variant.mode === 'gsm' ? value : coefficientToGsm(value)
    }
    const gsm = actualGsm ?? micron * density
    return [{ micron, coefficient: gsmToCoefficient(gsm), ...(actualGsm !== undefined ? { actual_gsm: actualGsm } : {}) }]
  })
  return normalizeMaterialInput({ id: form.id, name: form.name, active: form.active, density_g_cm3: density, variants })
}
export function validateMaterialName(materials: CatalogMaterial[], input: MaterialInput): void {
  if (materials.some(material => material.id !== input.id && materialNameKey(material.name) === materialNameKey(input.name))) throw new Error('Bu nomdagi material allaqachon mavjud. Boshqa nom kiriting.')
}
export function validateMaterialSequence(materials: CatalogMaterial[], ids: string[]): void {
  const active = materials.filter(material => material.active)
  if (ids.length !== active.length || new Set(ids).size !== ids.length || ids.some(id => !active.some(material => material.id === id))) throw new Error('Tartibda barcha faol materiallar bir martadan qatnashishi kerak.')
}
function closeNumber(a: number, b: number): boolean { return Math.abs(a - b) <= 1e-10 * Math.max(Number.MIN_VALUE, Math.abs(a), Math.abs(b)) }
export function materialMatchesInput(material: CatalogMaterial, input: MaterialInput): boolean {
  if (input.id && material.id !== input.id || material.name !== input.name || material.active !== input.active || !closeNumber(material.density_g_cm3, input.density_g_cm3) || material.variants.length !== input.variants.length) return false
  return input.variants.every(expected => {
    const actual = material.variants.find(variant => variant.micron === expected.micron)
    return actual && closeNumber(actual.coefficient, expected.coefficient) && (expected.actual_gsm === undefined ? actual.actual_gsm === undefined : actual.actual_gsm !== undefined && closeNumber(actual.actual_gsm, expected.actual_gsm)) && actual.first_layer_coefficient === undefined
  })
}
function operationMaterial(operation: MaterialPendingOperation, snapshot: MaterialCatalogSnapshot): CatalogMaterial | undefined {
  if (operation.kind !== 'upsert') return undefined
  return snapshot.materials.find(material => (operation.input.id ? material.id === operation.input.id : !operation.baseline.materials.some(original => original.id === material.id)) && materialMatchesInput(material, operation.input))
}
export function materialOperationMatches(operation: MaterialPendingOperation, snapshot: MaterialCatalogSnapshot): boolean {
  if (operation.kind === 'upsert') return Boolean(operationMaterial(operation, snapshot))
  const activeIds = snapshot.materials.filter(material => material.active).map(material => material.id)
  const hiddenIds = snapshot.materials.filter(material => !material.active).map(material => material.id)
  const expectedHidden = operation.baseline.materials.filter(material => !material.active).map(material => material.id)
  return JSON.stringify(activeIds) === JSON.stringify(operation.ids) && JSON.stringify(hiddenIds) === JSON.stringify(expectedHidden)
    && snapshot.materials.length === operation.baseline.materials.length
    && operation.baseline.materials.every(before => snapshot.materials.some(after => after.id === before.id && JSON.stringify(materialContent(after)) === JSON.stringify(materialContent(before))))
}
function changedElsewhere(operation: MaterialPendingOperation, snapshot: MaterialCatalogSnapshot): boolean {
  if (operation.kind !== 'upsert') return false
  const saved = operationMaterial(operation, snapshot)
  const before = operation.baseline.materials.filter(material => material.id !== operation.input.id)
  const after = snapshot.materials.filter(material => material.id !== saved?.id)
  return before.length !== after.length || before.some(material => !after.some(candidate => candidate.id === material.id && JSON.stringify(materialContent(candidate)) === JSON.stringify(materialContent(material))))
}
export class MaterialCatalogConflict extends Error {
  readonly current: MaterialCatalogSnapshot
  constructor(current: MaterialCatalogSnapshot) {
    super('Materiallar ro‘yxati o‘zgargan. Joriy nusxani yuklab, o‘zgarishlarni qayta ko‘rib chiqing.')
    this.name = 'MaterialCatalogConflict'; this.current = current
  }
}
export class MaterialSaveUnknown extends Error {
  readonly operation: MaterialPendingOperation
  readonly current?: MaterialCatalogSnapshot
  constructor(operation: MaterialPendingOperation, current?: MaterialCatalogSnapshot) {
    super('Saqlash natijasi tasdiqlanmadi. Qayta saqlashdan oldin serverdagi holatni tekshiring.')
    this.name = 'MaterialSaveUnknown'; this.operation = operation; this.current = current
  }
}
export function materialCatalogError(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Materiallarni boshqarish uchun ruxsat yetarli emas.'
  if (error instanceof ApiError && error.status === 409) return 'Materiallar o‘zgargan. Joriy ro‘yxatni qayta yuklang.'
  return error instanceof Error ? error.message : 'Materiallar saqlanmadi. Qayta urinib ko‘ring.'
}
function uncertain(error: unknown): boolean { return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 }

/** Native PUT is one-material upsert. Prechecks detect stale reads; they are not CAS. */
export class MaterialCatalogApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  private requireWrite(): void { if (!hasCapability(this.session, 'admin.access')) throw new ApiError(403, 'forbidden') }
  async read(signal?: AbortSignal): Promise<MaterialCatalogSnapshot> {
    if (!hasCapability(this.session, 'admin.access') && !hasCapability(this.session, 'production.map.manage')) throw new ApiError(403, 'forbidden')
    return materialCatalogSnapshot(await this.client.request(path, 'GET', { signal }))
  }
  private async fresh(baseline: MaterialCatalogSnapshot, signal?: AbortSignal): Promise<MaterialCatalogSnapshot> {
    const current = await this.read(signal)
    if (current.fingerprint !== baseline.fingerprint) throw new MaterialCatalogConflict(current)
    return current
  }
  async recover(operation: MaterialPendingOperation, signal?: AbortSignal): Promise<MaterialSaveResult> {
    const current = await this.read(signal)
    if (!materialOperationMatches(operation, current)) throw new MaterialSaveUnknown(operation, current)
    return { snapshot: current, material: operationMaterial(operation, current), recovered: true, changedDuringSave: changedElsewhere(operation, current) }
  }
  private async recoverUncertain(error: unknown, operation: MaterialPendingOperation, signal?: AbortSignal): Promise<MaterialSaveResult> {
    if (signal?.aborted || error instanceof Error && error.name === 'AbortError' || error instanceof MaterialSaveUnknown || !uncertain(error)) throw error
    try { return await this.recover(operation, signal) }
    catch (recoveryError) {
      if (signal?.aborted || recoveryError instanceof Error && recoveryError.name === 'AbortError' || recoveryError instanceof MaterialSaveUnknown) throw recoveryError
      throw new MaterialSaveUnknown(operation)
    }
  }
  async save(baseline: MaterialCatalogSnapshot, draft: MaterialInput, signal?: AbortSignal): Promise<MaterialSaveResult> {
    this.requireWrite()
    const input = normalizeMaterialInput(draft)
    if (input.id && !baseline.materials.some(material => material.id === input.id)) throw new Error('Material topilmadi. Joriy ro‘yxatni yangilang.')
    validateMaterialName(baseline.materials, input)
    const current = await this.fresh(baseline, signal)
    const existing = current.materials.find(material => material.id === input.id)
    if (existing && materialMatchesInput(existing, input)) return { snapshot: current, material: existing, recovered: false, changedDuringSave: false }
    const operation: MaterialPendingOperation = { kind: 'upsert', input, baseline: current }
    try {
      const response = record(await this.client.request(path, 'PUT', { body: input, signal }))
      if (response.ok !== true) return invalidResponse()
      const material = parseCatalogMaterial(response.material)
      if (!materialMatchesInput(material, input) || !input.id && current.materials.some(original => original.id === material.id)) return invalidResponse()
      const snapshot = await this.read(signal)
      if (!materialOperationMatches(operation, snapshot)) throw new MaterialSaveUnknown(operation, snapshot)
      return { snapshot, material: operationMaterial(operation, snapshot), recovered: false, changedDuringSave: changedElsewhere(operation, snapshot) }
    } catch (error) { return this.recoverUncertain(error, operation, signal) }
  }
  async reorder(baseline: MaterialCatalogSnapshot, ids: string[], signal?: AbortSignal): Promise<MaterialSaveResult> {
    this.requireWrite(); validateMaterialSequence(baseline.materials, ids)
    const current = await this.fresh(baseline, signal)
    const operation: MaterialPendingOperation = { kind: 'sequence', ids: [...ids], baseline: current }
    if (JSON.stringify(current.materials.filter(material => material.active).map(material => material.id)) === JSON.stringify(ids)) return { snapshot: current, recovered: false, changedDuringSave: false }
    try {
      const snapshot = materialCatalogSnapshot(await this.client.request(`${path}/sequence`, 'PUT', { body: { material_ids: [...ids] }, signal }))
      if (!materialOperationMatches(operation, snapshot)) return invalidResponse()
      return { snapshot, recovered: false, changedDuringSave: false }
    } catch (error) { return this.recoverUncertain(error, operation, signal) }
  }
}
