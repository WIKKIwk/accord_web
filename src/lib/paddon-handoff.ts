import { ApiClient, ApiError, record, rows } from './api'
import type { Session } from './api-types'
import { isIdentityApparatusId } from './admin-identity'
import { parseApparatusProjection } from './apparatus-admin'
import type { ApparatusProjection } from './apparatus-admin'
import { hasCapability } from './permissions'
import { canReadGroupApparatus } from './worker-groups'
import { PaddonsApi, normalizePaddonCode, paddonError, paddonsPath, parsePaddonList, parsePaddonSummary } from './paddons'
import type { PaddonList, PaddonSnapshot, PaddonSummary } from './paddons'

export const paddonActivePath = `${paddonsPath}/active`
export const paddonNextPath = `${paddonActivePath}/next`
export interface ActivePaddonSelection { apparatus: string; code: string | null }
export interface CutApparatusCatalog { items: ApparatusProjection[]; bounded: boolean }
export type PaddonHandoffOperation =
  | { readonly kind: 'choose' | 'clear'; readonly apparatus: string; readonly code: string; readonly input: { apparatus: string; code: string }; readonly baseline: ActivePaddonSelection }
  | { readonly kind: 'next'; readonly apparatus: string; readonly code: string; readonly input: { apparatus: string; code: string }; readonly baseline: ActivePaddonSelection; readonly source: PaddonSummary }
export interface PaddonHandoffResult { active: ActivePaddonSelection; paddon?: PaddonSummary }
export interface PaddonHandoffObservation {
  active: ActivePaddonSelection; snapshot?: PaddonSnapshot; state: 'matches' | 'different' | 'observed'
}

const nativeTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
function invalid(): never { throw new ApiError(502, 'invalid_response', 'Faol paddon holati to‘liq kelmadi. Serverdagi joriy holatni qayta tekshiring.') }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
function apparatusId(value: string): string {
  if (typeof value !== 'string' || !isIdentityApparatusId(nativeTrim(value))) throw new Error('Kesish apparatini canonical server ID si orqali tanlang.')
  return nativeTrim(value)
}
function actorPresent(session: Session | null | undefined): boolean { return !!session && !!nativeTrim(session.profile.role) && !!nativeTrim(session.profile.ref ?? '') }
function assigned(session: Session, id: string): boolean { return session.assigned_apparatus.some(value => nativeTrim(value) === id) }
export function canUsePaddonHandoff(session: Session | null | undefined): boolean {
  return ['admin.access', 'production.map.manage', 'apparatus.queue.manage'].some(code => hasCapability(session, code))
}
export function canUsePaddonHandoffApparatus(session: Session | null | undefined, id: string): boolean {
  return !!session && canUsePaddonHandoff(session) && actorPresent(session) && isIdentityApparatusId(id) && (hasCapability(session, 'admin.access') || assigned(session, id))
}
export function canCreatePaddonSuccessor(session: Session | null | undefined, id: string): boolean {
  return !!session && hasCapability(session, 'apparatus.queue.manage') && session.profile.role === 'aparatchi' && actorPresent(session) && isIdentityApparatusId(id) && assigned(session, id)
}
/** Canonical apparatus reads have their own native guard; queue.manage does not imply queue.read. */
export function canReadHandoffApparatus(session: Session | null | undefined): boolean { return canReadGroupApparatus(session) }
export function isHandoffCutApparatus(value: unknown): boolean {
  try { const projection = parseApparatusProjection(value); return projection.lifecycle.state === 'active' && projection.execution_profile.operation === 'cut' } catch { return false }
}
export function parseActivePaddonSelection(value: unknown): ActivePaddonSelection {
  const row = record(value)
  if (row.ok !== true || typeof row.apparatus !== 'string' || !isIdentityApparatusId(row.apparatus) || !Object.hasOwn(row, 'code')
    || row.code !== null && (typeof row.code !== 'string' || !row.code || row.code !== nativeTrim(row.code))) return invalid()
  return { apparatus: row.apparatus, code: row.code as string | null }
}
function baseline(value: ActivePaddonSelection): ActivePaddonSelection { return Object.freeze(parseActivePaddonSelection({ ...value, ok: true })) }
function freezeOperation<T extends PaddonHandoffOperation>(operation: T): T { Object.freeze(operation.input); return Object.freeze(operation) }
export function choosePaddonOperation(value: ActivePaddonSelection, selected: string): PaddonHandoffOperation {
  const previous = baseline(value), code = normalizePaddonCode(selected, true), apparatus = previous.apparatus
  return freezeOperation({ kind: 'choose', apparatus, code, input: { apparatus, code }, baseline: previous })
}
export function clearPaddonOperation(value: ActivePaddonSelection): PaddonHandoffOperation {
  const previous = baseline(value), apparatus = previous.apparatus
  return freezeOperation({ kind: 'clear', apparatus, code: '', input: { apparatus, code: '' }, baseline: previous })
}
export function nextPaddonOperation(value: ActivePaddonSelection, sourceValue: PaddonSummary): PaddonHandoffOperation {
  const previous = baseline(value), source = Object.freeze(parsePaddonSummary(sourceValue)), code = normalizePaddonCode(source.code, true), apparatus = previous.apparatus
  if (source.locked_at_unix === null) throw new Error('Keyingi paddon uchun allaqachon qulflangan manba paddonni tanlang.')
  return freezeOperation({ kind: 'next', apparatus, code, input: { apparatus, code }, baseline: previous, source })
}
export class PaddonHandoffConflict extends Error {
  readonly current: ActivePaddonSelection
  constructor(current: ActivePaddonSelection, message: string) { super(message); this.name = 'PaddonHandoffConflict'; this.current = current }
}
export class PaddonHandoffUnknown extends Error {
  readonly operation: PaddonHandoffOperation
  constructor(operation: PaddonHandoffOperation) {
    super('Faol paddon amali natijasi noma’lum. Avvalgi amal shu sessiya xotirasida saqlandi; so‘rov qayta yuborilmaydi. Serverdagi joriy tanlovni tekshiring.')
    this.name = 'PaddonHandoffUnknown'; this.operation = operation
  }
}

/** Server-owned actor/apparatus selection. No local preference, CAS or automatic write replay. */
export class PaddonHandoffApi {
  private readonly client: ApiClient
  private readonly session: Session
  private readonly paddons: PaddonsApi
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session; this.paddons = new PaddonsApi(client, session) }
  private require(): void { if (!canUsePaddonHandoff(this.session)) throw new ApiError(403, 'forbidden') }
  private requireScope(id: string): void {
    this.require()
    if (!actorPresent(this.session)) throw new ApiError(400, 'paddon_invalid_input')
    if (!canUsePaddonHandoffApparatus(this.session, id)) throw new ApiError(400, 'apparatus_not_assigned')
  }
  async apparatus(q = '', signal?: AbortSignal): Promise<CutApparatusCatalog> {
    this.require(); abort(signal)
    if (!canReadHandoffApparatus(this.session)) throw new ApiError(403, 'forbidden')
    const all = rows(await this.client.request('/v1/mobile/admin/apparatus', 'GET', { query: { q: q.trim(), limit: 500 }, signal, expectedStatus: 200 })).map(parseApparatusProjection)
    abort(signal)
    if (all.length > 500 || new Set(all.map(row => row.apparatus_id)).size !== all.length) return invalid()
    return { items: all.filter(row => row.lifecycle.state === 'active' && row.execution_profile.operation === 'cut'), bounded: all.length >= 500 }
  }
  async projection(value: string, signal?: AbortSignal): Promise<ApparatusProjection> {
    this.require(); abort(signal); const id = apparatusId(value)
    if (!canReadHandoffApparatus(this.session)) throw new ApiError(403, 'forbidden')
    const result = parseApparatusProjection(await this.client.request(`/v1/mobile/admin/apparatus/${encodeURIComponent(id)}`, 'GET', { signal, expectedStatus: 200 }))
    abort(signal)
    if (result.apparatus_id !== id) return invalid()
    if (result.lifecycle.state !== 'active' || result.execution_profile.operation !== 'cut') throw new Error('Faol canonical kesish apparatini tanlang.')
    return result
  }
  async active(value: string, signal?: AbortSignal): Promise<ActivePaddonSelection> {
    const id = apparatusId(value); this.requireScope(id); abort(signal)
    const result = parseActivePaddonSelection(await this.client.request(paddonActivePath, 'GET', { query: { apparatus: id }, signal, expectedStatus: 200 }))
    abort(signal); if (result.apparatus !== id) return invalid(); return result
  }
  async selectable(signal?: AbortSignal): Promise<PaddonList> {
    this.require(); abort(signal)
    const result = parsePaddonList(await this.client.request(paddonsPath, 'GET', { query: { limit: 200, selectable_only: true }, signal, expectedStatus: 200 }))
    abort(signal)
    if (result.items.some(row => row.locked_at_unix !== null)) return invalid()
    return result
  }
  async detail(code: string, signal?: AbortSignal): Promise<PaddonSnapshot> { this.require(); return this.paddons.detail(code, signal) }
  async execute(operation: PaddonHandoffOperation, signal?: AbortSignal): Promise<PaddonHandoffResult> {
    const id = apparatusId(operation.apparatus); this.requireScope(id); abort(signal)
    if (!['choose', 'clear', 'next'].includes(operation.kind) || operation.baseline.apparatus !== id) throw new Error('Kesish apparati va avvalgi tanlovni qayta tekshiring.')
    const code = operation.kind === 'clear' ? '' : normalizePaddonCode(operation.code, true)
    if (operation.kind === 'next' && !canCreatePaddonSuccessor(this.session, id)) throw new ApiError(403, 'forbidden')
    await this.projection(id, signal); abort(signal)
    const current = await this.active(id, signal); abort(signal)
    if (current.code !== operation.baseline.code) throw new PaddonHandoffConflict(current, 'Faol paddon boshqa joyda o‘zgargan. Joriy tanlovni ko‘rib, amalni qayta boshlang.')
    if (operation.kind !== 'clear') {
      const selected = await this.detail(code, signal); abort(signal)
      if (operation.kind === 'choose' && (selected.paddon.locked_at_unix !== null || !selected.can_manage_items)) throw new PaddonHandoffConflict(current, 'Tanlangan paddon qulflangan yoki qabul qilingan. Joriy holatni ko‘rib, boshqa paddon tanlang.')
      if (operation.kind === 'next' && (selected.paddon.id !== operation.source.id || selected.paddon.locked_at_unix === null || selected.paddon.locked_at_unix !== operation.source.locked_at_unix)) throw new PaddonHandoffConflict(current, 'Manba paddonning bosish qulfi o‘zgargan. Joriy qulflangan manbani qayta tekshiring.')
      // Next requires a visible locked source; it need not be current, unreceived, owned by the locker, or empty.
    }
    abort(signal)
    try {
      const response = await this.client.request(operation.kind === 'next' ? paddonNextPath : paddonActivePath, operation.kind === 'next' ? 'POST' : 'PUT', { body: { apparatus: id, code }, signal, expectedStatus: 200 }); abort(signal)
      const active = parseActivePaddonSelection(response)
      if (active.apparatus !== id) return invalid()
      if (operation.kind !== 'next') {
        if (active.code !== (operation.kind === 'clear' ? null : code)) return invalid()
        return { active }
      }
      const paddon = parsePaddonSummary(record(response).paddon)
      if (active.code === null || active.code !== paddon.code || paddon.locked_at_unix !== null || paddon.code === operation.source.code || paddon.id === operation.source.id) return invalid()
      // Reused successors can already have outputs; their summary is authoritative.
      return { active, paddon }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || [408, 429].includes(error.status) || error.status >= 500 || error.code === 'invalid_response') throw new PaddonHandoffUnknown(operation)
      throw error
    }
  }
  async observe(operation: PaddonHandoffOperation, signal?: AbortSignal): Promise<PaddonHandoffObservation> {
    const active = await this.active(operation.apparatus, signal), snapshot = active.code !== null ? await this.detail(active.code, signal) : undefined
    abort(signal)
    const state = operation.kind === 'next' ? 'observed' : active.code === (operation.kind === 'clear' ? null : operation.code) ? 'matches' : 'different'
    // No GET proves successor mapping or ownership of the original write.
    return { active, ...(snapshot ? { snapshot } : {}), state }
  }
}

export interface PaddonHandoffIntent { readonly operation: PaddonHandoffOperation; readonly status: 'pending' | 'unknown'; readonly observation?: PaddonHandoffObservation }
export class PaddonHandoffIntentLedger {
  private intent: PaddonHandoffIntent | null = null
  private readonly listeners = new Set<() => void>()
  snapshot = (): PaddonHandoffIntent | null => this.intent
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(intent: PaddonHandoffIntent | null): void { this.intent = intent && Object.freeze(intent); this.listeners.forEach(listener => listener()) }
  begin(operation: PaddonHandoffOperation): void { if (this.intent) throw new Error('Avvalgi faol paddon amali natijasini tekshiring. So‘rov takrorlanmaydi.'); this.publish({ operation, status: 'pending' }) }
  unknown(operation: PaddonHandoffOperation): void { if (this.intent?.operation === operation) this.publish({ operation, status: 'unknown' }) }
  finish(operation: PaddonHandoffOperation): void { if (this.intent?.operation === operation && this.intent.status === 'pending') this.publish(null) }
  observe(operation: PaddonHandoffOperation, observation: PaddonHandoffObservation): void { if (this.intent?.operation === operation && this.intent.status === 'unknown') this.publish({ operation, status: 'unknown', observation }) }
  resolveReviewed(operation: PaddonHandoffOperation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'unknown' || !this.intent.observation) throw new Error('Avval serverdagi joriy tanlovni tekshiring.')
    this.publish(null)
  }
}
const ledgers = new Map<string, PaddonHandoffIntentLedger>()
export function paddonHandoffIntentLedger(scope: string): PaddonHandoffIntentLedger {
  let ledger = ledgers.get(scope); if (!ledger) { ledger = new PaddonHandoffIntentLedger(); ledgers.set(scope, ledger) }; return ledger
}
export function paddonHandoffError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'apparatus_not_assigned') return 'Bu kesish apparati sizga biriktirilmagan.'
  if (error instanceof ApiError && error.code === 'canonical_apparatus_id_required') return 'Kesish apparatini canonical server ID si orqali tanlang.'
  return paddonError(error)
}
