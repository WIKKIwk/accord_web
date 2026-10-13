import { ApiClient, ApiError, isRecord, record, rows, text } from './api'
import type { CalculateOrderTemplate, CalculatorInput, Row, Session } from './api-types'
import { calculationInput, calculationSignature, draftNumber, newOrderDraft } from './order-draft'
import type { OrderDraft } from './order-draft'
import { hasCapability } from './permissions'

const admin = '/v1/mobile/admin'
const templatePath = '/v1/mobile/calculate/orders'
export type CalculatorMode = { kind: 'new' } | { kind: 'order' | 'pending'; id: string } | { kind: 'template'; id: string; edit: boolean }
export interface OpenedCalculation { original: Row; map: Row; template: CalculateOrderTemplate; revision: number; fingerprint: string }
export interface PendingCalculation { original: Row; id: string; template: CalculateOrderTemplate; completion: Row | null; fingerprint: string }
export type CalculatorSource = { kind: 'order'; order: OpenedCalculation; template: CalculateOrderTemplate } | { kind: 'pending'; pending: PendingCalculation; template: CalculateOrderTemplate } | { kind: 'template'; template: CalculateOrderTemplate; templates: CalculateOrderTemplate[] }
export type CalculatorOperation =
  | { kind: 'order'; baseline: OpenedCalculation; template: CalculateOrderTemplate }
  | { kind: 'template-save'; original: CalculateOrderTemplate | null; before: CalculateOrderTemplate[]; template: CalculateOrderTemplate }
  | { kind: 'template-delete'; template: CalculateOrderTemplate }
  | { kind: 'pending-release'; pending: PendingCalculation; template: CalculateOrderTemplate }
  | { kind: 'template-open'; template: CalculateOrderTemplate }
  | { kind: 'automatic-open'; template: CalculateOrderTemplate }
export type CalculatorSaveResult = { kind: 'template'; template: CalculateOrderTemplate; recovered?: boolean } | { kind: 'order'; order: OpenedCalculation; recovered?: boolean } | { kind: 'deleted'; id: string; recovered?: boolean } | { kind: 'opened'; saved: Row; template: CalculateOrderTemplate | null; recovered?: boolean }

function invalid(): never { throw new ApiError(502, 'invalid_response', 'Buyurtma ma’lumotlari to‘liq kelmadi. Ro‘yxatni yangilang.') }
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value }
export function calculatorFingerprint(value: unknown): string { return JSON.stringify(canonical(value)) }
export function calculatorMode(params: URLSearchParams): CalculatorMode {
  const active = ['orderId', 'templateId', 'pendingId'].filter(key => params.has(key))
  if (!active.length) return { kind: 'new' }
  if (active.length !== 1) throw new Error('Bir vaqtning o‘zida bitta buyurtma yoki shablonni tanlang.')
  const id = params.get(active[0])?.trim() ?? ''
  if (!id) throw new Error('Buyurtma yoki shablon tanlovi bo‘sh.')
  return active[0] === 'orderId' ? { kind: 'order', id } : active[0] === 'pendingId' ? { kind: 'pending', id } : { kind: 'template', id, edit: params.get('edit') === '1' }
}
export function calculatorCanManage(session: Session | null | undefined): boolean { return hasCapability(session, 'admin.access') || hasCapability(session, 'production.map.manage') }
export function parseCalculatorTemplate(value: unknown): CalculateOrderTemplate {
  const row = record(value)
  if (typeof row.name !== 'string' || typeof row.product !== 'string' || typeof row.frame_product_size_mm !== 'number' || !Number.isFinite(row.frame_product_size_mm) || row.frame_product_size_mm <= 0
    || typeof row.frame_count !== 'number' || !Number.isFinite(row.frame_count) || row.frame_count <= 0 || typeof row.edge_allowance_mm !== 'number' || !Number.isFinite(row.edge_allowance_mm) || row.edge_allowance_mm < 0
    || typeof row.waste_percent !== 'number' || !Number.isFinite(row.waste_percent) || row.waste_percent < 0 || row.waste_percent >= 100) return invalid()
  if (row.layers !== undefined && !Array.isArray(row.layers)) return invalid()
  let layers = Array.isArray(row.layers) && row.layers.length ? rows(row, 'layers') : ['first', 'second', 'third'].flatMap(key => {
    const material = text(row[`${key}_layer_material`], ''), micron = text(row[`${key}_layer_micron`], '')
    return material || micron ? [{ material, micron }] : []
  })
  if (!layers.length || layers.some(layer => typeof layer.material !== 'string' || !layer.material.trim() || typeof layer.micron !== 'string' || !layer.micron.trim())) return invalid()
  layers = layers.map(layer => ({ ...layer }))
  if (row.production_options !== undefined && row.production_options !== null) {
    const options = record(row.production_options)
    if (!['metal', 'flexo'].includes(text(options.print_method, '')) || typeof options.cold_glue !== 'boolean') return invalid()
  }
  if (row.kg !== undefined && (typeof row.kg !== 'number' || !Number.isFinite(row.kg) || row.kg < 0)) return invalid()
  if (row.roll_count != null && (!Number.isSafeInteger(row.roll_count) || Number(row.roll_count) <= 0)) return invalid()
  if (row.print_val_size_mm != null && (typeof row.print_val_size_mm !== 'number' || !Number.isFinite(row.print_val_size_mm) || row.print_val_size_mm <= 0)) return invalid()
  return { ...structuredClone(row), kg: row.kg ?? 0, layers } as unknown as CalculateOrderTemplate
}
export function parseOpenedCalculation(value: unknown, id: string): OpenedCalculation {
  const original = structuredClone(record(value)), map = record(original.map), template = parseCalculatorTemplate(original.template)
  if (map.id !== id || typeof map.order_number !== 'string' || !map.order_number.trim() || !Number.isSafeInteger(original.revision) || Number(original.revision) < 0) return invalid()
  rows(map, 'nodes'); rows(map, 'edges')
  return { original, map, template, revision: Number(original.revision), fingerprint: calculatorFingerprint(original) }
}
export function parsePendingCalculation(value: unknown, id: string): PendingCalculation {
  const original = structuredClone(record(value)), template = parseCalculatorTemplate(original.template)
  if (original.id !== id || typeof template.order_number !== 'string' || !/^\d{4}$/.test(template.order_number) || id !== `zakaz-${template.order_number}` || !text(template.id, '').trim() || !text(template.code, '').trim()) return invalid()
  const completion = original.completion == null ? null : record(original.completion)
  return { original, id, template, completion, fingerprint: calculatorFingerprint(original) }
}
export function draftFromCalculatorTemplate(template: CalculateOrderTemplate, preserveQuantity: boolean): OrderDraft {
  const defaults = newOrderDraft(), options = isRecord(template.production_options) ? template.production_options : null
  const imageId = text(template.image_id, '')
  return { ...defaults, customer_ref: text(template.customer_ref, ''), customer: text(template.customer, ''), item_code: text(template.item_code, ''), product: template.product,
    status: text(template.status, '').toLowerCase() === 'paket' ? 'Paket' : 'Rulon', print_method: options?.print_method === 'flexo' || text(template.status, '').toLowerCase() === 'flexo' ? 'flexo' : 'metal',
    kg: preserveQuantity && Number(template.kg) > 0 ? String(template.kg) : '', frame_product_size_mm: String(template.frame_product_size_mm), frame_count: String(template.frame_count), edge_allowance_mm: String(template.edge_allowance_mm), waste_percent: String(template.waste_percent),
    roll_count: template.roll_count == null ? '' : String(template.roll_count), by_val: typeof template.print_val_size_mm === 'number', print_val_size_mm: template.print_val_size_mm == null ? '' : String(template.print_val_size_mm), note: text(template.note, ''),
    layers: template.layers.map((layer, index) => ({ key: `loaded-${index}`, material_id: text(layer.material_id, ''), material: layer.material, micron: layer.micron })),
    image: imageId ? Object.fromEntries(['image_id', 'image_name', 'image_mime', 'image_size_bytes', 'image_url'].map(key => [key, template[key]])) : null }
}
export function managedCalculationInput(draft: OrderDraft, source?: CalculatorSource): CalculatorInput {
  const input = calculationInput(draft)
  if (source) {
    const edge = draftNumber(draft.edge_allowance_mm)
    if (!Number.isFinite(edge) || edge < 0) throw new Error('Chet qo‘shimchasi uchun 0 yoki musbat son kiriting.')
    input.edge_allowance_mm = edge
  }
  return input
}
export function managedCalculationSignature(draft: OrderDraft, source?: CalculatorSource): string {
  return source ? JSON.stringify([calculationSignature(draft), draft.edge_allowance_mm]) : calculationSignature(draft)
}
/** Reusable saves have no order quantity/number; opened edits keep their native identity. */
export function managedCalculatorTemplate(draft: OrderDraft, result: Row | null, source?: CalculatorSource, reusable = false, name?: string): CalculateOrderTemplate {
  const input = managedCalculationInput(reusable ? { ...draft, kg: '1' } : draft, source)
  const original = source?.template
  const template: CalculateOrderTemplate = { ...(original ?? {}), ...input, name: name?.trim() || draft.product.trim(), product: draft.product.trim(), customer_ref: draft.customer_ref, item_code: draft.item_code,
    id: '', code: '', order_number: '', source_map_id: '', kg: reusable ? 0 : input.kg, roll_count: input.roll_count ?? null, width_mm: typeof result?.width_mm === 'number' ? result.width_mm : 0,
    print_val_size_mm: draft.by_val ? draftNumber(draft.print_val_size_mm) : null,
    production_options: { ...(original?.production_options ?? { cold_glue: false }), print_method: draft.print_method },
    image_id: text(draft.image?.image_id, ''), image_name: text(draft.image?.image_name, ''), image_mime: text(draft.image?.image_mime, ''), image_size_bytes: Number(draft.image?.image_size_bytes) || 0, image_url: '' }
  if (source?.kind === 'order') {
    template.name = name?.trim() || source.template.name
    template.id = source.template.id; template.code = text(source.order.map.code, ''); template.order_number = text(source.order.map.order_number, ''); template.source_map_id = text(source.order.map.id, '')
    template.status = source.template.status
    if (source.template.production_options == null) delete template.production_options
    else template.production_options = structuredClone(source.template.production_options)
  } else if (source?.kind === 'pending' && !reusable) {
    template.id = source.template.id; template.code = source.template.code; template.order_number = source.template.order_number
  } else if (reusable && source?.kind === 'template') template.source_map_id = text(source.template.source_map_id, '')
  return template
}
export function validateOpenedCalculationChange(source: OpenedCalculation, template: CalculateOrderTemplate): void {
  if (text(source.template.status, '').toLowerCase() !== text(template.status, '').toLowerCase() || calculatorFingerprint(source.template.production_options ?? null) !== calculatorFingerprint(template.production_options ?? null)) throw new Error('Buyurtma turi va ishlab chiqarish sozlamalarini avvalgidek qoldiring.')
  if ((source.template.layers.length > 1) !== (template.layers.length > 1)) throw new Error('Mavjud xarita uchun bir qatlamli yoki ko‘p qatlamli tuzilishni saqlang.')
  if (!Number.isSafeInteger(template.frame_count) || template.frame_count < 1 || template.frame_count > 1024 || !Number.isSafeInteger(template.roll_count) || Number(template.roll_count) <= 0) throw new Error('Kadr soni 1–1024 oralig‘ida butun son va rang soni musbat butun son bo‘lishi kerak.')
  if (source.template.item_code !== template.item_code && rows(source.map, 'nodes').some(node => text(node.item_code, '').trim())) throw new Error('Xarita bosqichlari avvalgi mahsulotga bog‘langan. Mahsulotni avvalgidek qoldiring.')
}
const inputKeys = ['name', 'product', 'customer_ref', 'customer', 'item_code', 'status', 'kg', 'frame_product_size_mm', 'frame_count', 'edge_allowance_mm', 'waste_percent', 'roll_count', 'print_val_size_mm', 'note', 'color', 'image_id', 'source_map_id']
export function calculatorTemplateMatches(actual: CalculateOrderTemplate, intended: CalculateOrderTemplate): boolean {
  const same = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(Number.MIN_VALUE, Math.abs(a), Math.abs(b)) : (a ?? '') === (b ?? '')
  return inputKeys.every(key => same(actual[key], intended[key])) && calculatorFingerprint(actual.production_options ?? null) === calculatorFingerprint(intended.production_options ?? null)
    && calculatorFingerprint(actual.layers.map(layer => [text(layer.material_id, ''), layer.material.trim(), layer.micron.trim()])) === calculatorFingerprint(intended.layers.map(layer => [text(layer.material_id, ''), layer.material.trim(), layer.micron.trim()]))
}
export function calculatorRouteCompatible(routeTemplate: CalculateOrderTemplate, template: CalculateOrderTemplate): boolean {
  const type = (value: unknown) => text(value, '').trim().toLowerCase() === 'paket' ? 'paket' : 'rulon'
  const options = (value: CalculateOrderTemplate) => value.production_options ?? { print_method: text(value.status, '').toLowerCase() === 'flexo' ? 'flexo' : 'metal', cold_glue: false }
  return type(routeTemplate.status) === type(template.status) && (routeTemplate.layers.length > 1) === (template.layers.length > 1) && calculatorFingerprint(options(routeTemplate)) === calculatorFingerprint(options(template))
}
export function cloneCalculatorRoute(source: Row, template: CalculateOrderTemplate, result: Row, id: string): Row {
  const nodes = rows(source, 'nodes'), edges = rows(source, 'edges')
  if (!nodes.length || text(source.product_code, '') !== text(template.item_code, '') && nodes.some(node => text(node.item_code, '').trim())) throw new Error('Xarita boshqa mahsulotga bog‘langan. Mos xarita shablonini tanlang.')
  if (!Number.isFinite(result.width_mm) || Number(result.width_mm) <= 0) throw new Error('Hisoblash natijasini yangilang.')
  return { ...structuredClone(source), id, code: '', order_number: '', title: template.product, product_code: template.item_code, customer_name: template.customer, image_id: template.image_id,
    order_kg: template.kg, width_mm: result.width_mm, print_val_size_mm: template.print_val_size_mm ?? null, roll_count: template.roll_count ?? null,
    base_length: Array.isArray(result.results) && isRecord(result.results[0]) ? result.results[0].rounded_length : null,
    nodes: nodes.map(node => ({ ...structuredClone(node), alternative_assigned_title: '', alternative_assigned_apparatus_id: '' })), edges: structuredClone(edges) }
}
export class CalculatorSourceConflict extends Error {
  constructor() { super('Ma’lumotlar o‘zgargan. Joriy nusxani qayta ochib tahrirlang.'); this.name = 'CalculatorSourceConflict' }
}
export class CalculatorSaveUnknown extends Error {
  readonly operation: CalculatorOperation
  constructor(operation: CalculatorOperation) { super('Saqlash natijasi tasdiqlanmadi. Qayta saqlashdan oldin serverdagi holatni tekshiring.'); this.name = 'CalculatorSaveUnknown'; this.operation = operation }
}

export interface CalculatorRetainedState {
  source: CalculatorSource | null
  draft: OrderDraft | null
  selectedMaterials: Record<string, Row>
  calculated: { result: Row; signature: string } | null
  map: Row | null
  mapSignature: string
  localImage: string
  uncertain: boolean
  operation: CalculatorOperation | null
  error: unknown
  purpose: { dialog: 'template' | 'delete' | 'order' | 'route'; name: string; routeId: string } | null
}
const emptyRetained = (): CalculatorRetainedState => ({ source: null, draft: null, selectedMaterials: {}, calculated: null, map: null, mapSignature: '', localImage: '', uncertain: false, operation: null, error: null, purpose: null })
/** Session-scoped RAM. Navigation preserves drafts and sent writes; another identity cannot retrieve or update them. */
export class CalculatorMemory {
  private scope: string | null = null
  private entries = new Map<string, CalculatorRetainedState>()
  private listeners = new Map<string, Set<() => void>>()
  activate(scope: string): void {
    if (scope === this.scope) return
    for (const entry of this.entries.values()) this.releaseImage(entry.localImage)
    this.entries.clear(); this.listeners.clear(); this.scope = scope
  }
  private releaseImage(image: string): void { if (image.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(image) }
  read(scope: string, key: string): CalculatorRetainedState | null {
    if (scope !== this.scope) return null
    let entry = this.entries.get(key)
    if (!entry) { entry = emptyRetained(); this.entries.set(key, entry) }
    return entry
  }
  patch(scope: string, key: string, patch: Partial<CalculatorRetainedState>): boolean {
    const before = this.read(scope, key)
    if (!before) return false
    if (patch.localImage !== undefined && before.localImage !== patch.localImage) this.releaseImage(before.localImage)
    this.entries.set(key, { ...before, ...patch })
    for (const listener of this.listeners.get(key) ?? []) listener()
    return true
  }
  subscribe(scope: string, key: string, listener: () => void): () => void {
    if (scope !== this.scope) return () => {}
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener); this.listeners.set(key, listeners)
    return () => { listeners.delete(listener) }
  }
  markSent(scope: string, key: string, operation: CalculatorOperation): void {
    const retained = this.read(scope, key)
    if (!retained) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
    if (retained.operation) throw new CalculatorSaveUnknown(retained.operation)
    this.patch(scope, key, { operation, error: new CalculatorSaveUnknown(operation) })
  }
  resetDraft(scope: string, key: string): void { this.patch(scope, key, { draft: null, selectedMaterials: {}, calculated: null, map: null, mapSignature: '', localImage: '', uncertain: false }) }
}
export const calculatorMemory = new CalculatorMemory()
export function calculatorMemoryKey(mode: CalculatorMode): string { return mode.kind === 'new' ? 'new' : `${mode.kind}:${mode.id}:${mode.kind === 'template' && mode.edit ? 'edit' : 'use'}` }
export function calculatorManagementError(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Bu amal uchun ruxsat yetarli emas.'
  if (error instanceof ApiError && [400, 404, 409, 422].includes(error.status) && /\s/.test(error.code) && !/[<>]/.test(error.code)) return error.code
  return error instanceof Error ? error.message : 'Amal bajarilmadi. Qayta urinib ko‘ring.'
}
function canRecover(error: unknown): boolean { return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 }
function openedResult(value: unknown, reservedId?: string): CalculatorSaveResult {
  const response = record(value), saved = record(response.saved), map = record(saved.map)
  if (response.ok !== true || !text(map.id, '').trim() || !text(map.order_number, '').trim() || (reservedId ? map.id !== reservedId || map.order_number !== reservedId.slice('zakaz-'.length) : map.id !== `zakaz-${map.order_number}`)) return invalid()
  rows(map, 'nodes'); rows(map, 'edges'); record(saved.program)
  const template = response.template == null ? null : parseCalculatorTemplate(response.template)
  if (reservedId && (!template || template.order_number !== map.order_number)) return invalid()
  return { kind: 'opened', saved, template }
}
export class CalculatorManagementApi {
  private readonly client: ApiClient
  private readonly session: Session
  private readonly onWrite: (operation: CalculatorOperation) => void
  constructor(client: ApiClient, session: Session, onWrite: (operation: CalculatorOperation) => void = () => {}) { this.client = client; this.session = session; this.onWrite = onWrite }
  private require(): void { if (!calculatorCanManage(this.session)) throw new ApiError(403, 'forbidden') }
  async templates(signal?: AbortSignal): Promise<CalculateOrderTemplate[]> {
    this.require(); const response = record(await this.client.request(templatePath, 'GET', { signal }))
    if (response.ok !== true) return invalid()
    return rows(response, 'templates').map(parseCalculatorTemplate)
  }
  async order(id: string, signal?: AbortSignal): Promise<OpenedCalculation> { this.require(); return parseOpenedCalculation(await this.client.request(`${admin}/production-maps/order-edit`, 'GET', { query: { id }, signal }), id) }
  async pending(id: string, signal?: AbortSignal): Promise<PendingCalculation> { this.require(); return parsePendingCalculation(await this.client.request(`${admin}/pending-orders`, 'GET', { query: { id }, signal }), id) }
  async load(mode: Exclude<CalculatorMode, { kind: 'new' }>, signal?: AbortSignal): Promise<CalculatorSource> {
    if (mode.kind === 'order') { const order = await this.order(mode.id, signal); return { kind: 'order', order, template: order.template } }
    if (mode.kind === 'pending') { const pending = await this.pending(mode.id, signal); return { kind: 'pending', pending, template: pending.template } }
    const templates = await this.templates(signal), template = templates.find(template => template.id === mode.id)
    if (!template) throw new ApiError(404, 'template_not_found', 'Shablon topilmadi. Ro‘yxatni yangilang.')
    return { kind: 'template', template, templates }
  }
  async automaticOpen(template: CalculateOrderTemplate, signal?: AbortSignal): Promise<Row> {
    this.require()
    if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
    this.onWrite({ kind: 'automatic-open', template })
    return this.client.autoOpenOrder(template, signal)
  }
  private async recoverError(error: unknown, operation: CalculatorOperation, signal?: AbortSignal): Promise<CalculatorSaveResult> {
    if (signal?.aborted || error instanceof Error && error.name === 'AbortError' || !canRecover(error) || error instanceof CalculatorSaveUnknown) throw error
    try { return await this.recover(operation, signal) }
    catch (error) { if (signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error; throw new CalculatorSaveUnknown(operation) }
  }
  async recover(operation: CalculatorOperation, signal?: AbortSignal): Promise<CalculatorSaveResult> {
    this.require()
    if (operation.kind === 'order') {
      const order = await this.order(text(operation.baseline.map.id, ''), signal)
      if (order.revision <= operation.baseline.revision || !calculatorTemplateMatches(order.template, operation.template)) throw new CalculatorSaveUnknown(operation)
      return { kind: 'order', order, recovered: true }
    }
    if (operation.kind === 'pending-release') {
      const pending = await this.pending(operation.pending.id, signal)
      if (!pending.completion) throw new CalculatorSaveUnknown(operation)
      return { ...openedResult({ ok: true, ...pending.completion }, pending.id), recovered: true }
    }
    if (operation.kind === 'template-open' || operation.kind === 'automatic-open') throw new CalculatorSaveUnknown(operation)
    const templates = await this.templates(signal)
    if (operation.kind === 'template-delete') {
      if (templates.some(template => template.id === operation.template.id)) throw new CalculatorSaveUnknown(operation)
      return { kind: 'deleted', id: text(operation.template.id, ''), recovered: true }
    }
    const matches = templates.filter(template => (operation.original ? template.id === operation.original.id : !operation.before.some(before => before.id === template.id)) && calculatorTemplateMatches(template, operation.template))
    if (matches.length !== 1) throw new CalculatorSaveUnknown(operation)
    return { kind: 'template', template: matches[0], recovered: true }
  }
  async saveOrder(baseline: OpenedCalculation, template: CalculateOrderTemplate, signal?: AbortSignal): Promise<CalculatorSaveResult> {
    this.require(); validateOpenedCalculationChange(baseline, template)
    const id = text(baseline.map.id, ''), current = await this.order(id, signal)
    if (current.fingerprint !== baseline.fingerprint) throw new CalculatorSourceConflict()
    const operation: CalculatorOperation = { kind: 'order', baseline, template }
    try {
      this.onWrite(operation)
      const order = parseOpenedCalculation(await this.client.request(`${admin}/production-maps/order-edit`, 'PUT', { query: { id }, body: { original: baseline.original, template }, signal }), id)
      if (order.revision <= baseline.revision || !calculatorTemplateMatches(order.template, template)) return invalid()
      return { kind: 'order', order }
    } catch (error) { return this.recoverError(error, operation, signal) }
  }
  async saveTemplate(template: CalculateOrderTemplate, original: CalculateOrderTemplate | null, signal?: AbortSignal): Promise<CalculatorSaveResult> {
    this.require()
    const before = await this.templates(signal)
    if (original && calculatorFingerprint(before.find(template => template.id === original.id)) !== calculatorFingerprint(original)) throw new CalculatorSourceConflict()
    const input = { ...template, id: original?.id ?? '', code: original?.code ?? '', kg: 0, order_number: '' }
    const operation: CalculatorOperation = { kind: 'template-save', original, before, template: input }
    try {
      this.onWrite(operation)
      const response = record(await this.client.request(templatePath, 'POST', { body: input, signal })), saved = parseCalculatorTemplate(response.template)
      if (response.ok !== true || !text(saved.id, '').trim() || original && saved.id !== original.id || !calculatorTemplateMatches(saved, input)) return invalid()
      return { kind: 'template', template: saved }
    } catch (error) { return this.recoverError(error, operation, signal) }
  }
  async deleteTemplate(template: CalculateOrderTemplate, confirmed: boolean, signal?: AbortSignal): Promise<CalculatorSaveResult> {
    this.require(); if (!confirmed || !text(template.id, '').trim()) throw new Error('Shablonni o‘chirishni tasdiqlang.')
    const current = (await this.templates(signal)).find(candidate => candidate.id === template.id)
    if (!current || calculatorFingerprint(current) !== calculatorFingerprint(template)) throw new CalculatorSourceConflict()
    const operation: CalculatorOperation = { kind: 'template-delete', template }
    try {
      this.onWrite(operation)
      const response = record(await this.client.request(`${templatePath}/delete`, 'POST', { body: { id: template.id }, signal }))
      if (response.ok !== true) return invalid()
      return { kind: 'deleted', id: text(template.id, '') }
    } catch (error) { return this.recoverError(error, operation, signal) }
  }
  async openWithRoute(routeTemplate: CalculateOrderTemplate, template: CalculateOrderTemplate, result: Row, pending?: PendingCalculation, signal?: AbortSignal): Promise<CalculatorSaveResult> {
    this.require()
    const templates = await this.templates(signal)
    if (calculatorFingerprint(templates.find(candidate => candidate.id === routeTemplate.id)) !== calculatorFingerprint(routeTemplate)) throw new CalculatorSourceConflict()
    if (!calculatorRouteCompatible(routeTemplate, template)) throw new Error('Mahsulot turi, bosma usuli va qatlamlar tuzilishiga mos xarita shablonini tanlang.')
    if (pending) {
      const current = await this.pending(pending.id, signal)
      if (current.completion) return openedResult({ ok: true, ...current.completion }, pending.id)
      if (current.fingerprint !== pending.fingerprint) throw new CalculatorSourceConflict()
    }
    const sourceId = text(routeTemplate.source_map_id, '').trim()
    if (!sourceId) throw new Error('Bu shablonga xarita ulanmagan.')
    const source = record(await this.client.request(`${admin}/production-maps`, 'GET', { query: { id: sourceId }, signal })), sourceMap = record(source.map)
    if (sourceMap.id !== sourceId) return invalid()
    const input = { ...template, id: pending ? pending.template.id : '', code: pending ? pending.template.code : '', order_number: pending ? pending.template.order_number : '', source_map_id: pending ? '' : sourceId }
    const map = cloneCalculatorRoute(sourceMap, input, result, pending?.id ?? `zakaz-draft-${crypto.randomUUID()}`)
    const operation: CalculatorOperation = pending ? { kind: 'pending-release', pending, template: input } : { kind: 'template-open', template: input }
    try {
      this.onWrite(operation)
      return openedResult(await this.client.request(`${admin}/production-maps/with-order`, 'PUT', { body: { ...(pending ? { pending_order_id: pending.id } : {}), map, template: input }, signal }), pending?.id)
    } catch (error) { return this.recoverError(error, operation, signal) }
  }
}
