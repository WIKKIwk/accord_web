import { ApiClient, ApiError, record, rows } from './api'
import type { Session } from './api-types'
import { isIdentityApparatusId } from './admin-identity'
import { hasCapability } from './permissions'
import { parseGroupApparatus } from './worker-groups'
import type { GroupApparatus, GroupCatalog } from './worker-groups'

const base = '/v1/mobile/admin'
export const apparatusCollectionsPath = `${base}/apparatus-collections`
export const collectionApparatusLimit = 500
export const collectionNameLimit = 80
export interface CollectionInput { name: string; apparatus_ids: string[] }
export interface ApparatusCollection extends CollectionInput { id: string; revision: number }
export type CollectionOperation =
  | { readonly kind: 'create'; readonly input: CollectionInput; readonly baseline?: undefined }
  | { readonly kind: 'update' | 'delete'; readonly input: CollectionInput; readonly baseline: ApparatusCollection }
export interface CollectionObservation {
  collections: ApparatusCollection[]
  target?: ApparatusCollection
  state: 'matches' | 'different' | 'missing'
}

function invalid(): never { throw new ApiError(502, 'invalid_response', 'Apparat guruhlari haqida to‘liq ma’lumot kelmadi. Ro‘yxatni yangilang.') }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
const nativeTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
export function canReadCollections(session: Session | null | undefined): boolean {
  return ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'].some(code => hasCapability(session, code))
}
export function canManageCollections(session: Session | null | undefined): boolean { return hasCapability(session, 'production.map.manage') }
/** Native normalization trims the ends only; internal spacing and case remain significant. */
export function normalizeCollectionName(value: string): string {
  if (typeof value !== 'string' || !nativeTrim(value)) throw new Error('Apparat guruhi nomini kiriting.')
  const name = nativeTrim(value)
  if (Array.from(name).length > collectionNameLimit) throw new Error('Apparat guruhi nomi 80 belgidan oshmasin.')
  return name
}
/** A create-observation lookup aid only. PostgreSQL name uniqueness depends on its collation. */
export function collectionNameKey(name: string): string { return name.toLowerCase() }
export function normalizeCollectionInput(input: CollectionInput): CollectionInput {
  const name = normalizeCollectionName(input.name)
  if (!Array.isArray(input.apparatus_ids) || input.apparatus_ids.length > collectionApparatusLimit) throw new Error('Guruhga 500 tagacha apparat tanlang.')
  const apparatus_ids = input.apparatus_ids.map(value => typeof value === 'string' ? nativeTrim(value) : '')
  if (apparatus_ids.some(id => !isIdentityApparatusId(id))) throw new Error('Apparatni server ro‘yxatidan tanlang.')
  return { name, apparatus_ids: [...new Set(apparatus_ids)].sort() }
}
export function parseApparatusCollection(value: unknown): ApparatusCollection {
  const row = record(value)
  if (row.ok === false || typeof row.id !== 'string' || !/^apparatus-collection:[0-9a-f]{32}$/.test(row.id)
    || typeof row.name !== 'string' || row.name !== nativeTrim(row.name) || !row.name || Array.from(row.name).length > collectionNameLimit
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Array.isArray(row.apparatus_ids)
    || row.apparatus_ids.length > collectionApparatusLimit || row.apparatus_ids.some(id => typeof id !== 'string' || !isIdentityApparatusId(id))) return invalid()
  const apparatus_ids = [...row.apparatus_ids] as string[]
  if (new Set(apparatus_ids).size !== apparatus_ids.length || apparatus_ids.some((id, index) => index > 0 && apparatus_ids[index - 1]! >= id)) return invalid()
  // Do not retain unsolicited fields, nested credentials or transport metadata.
  return { id: row.id, name: row.name, apparatus_ids, revision: Number(row.revision) }
}
export function parseApparatusCollections(value: unknown): ApparatusCollection[] {
  const collections = rows(value).map(parseApparatusCollection)
  if (new Set(collections.map(item => item.id)).size !== collections.length) return invalid()
  return collections
}
export function sameCollectionInput(left: CollectionInput, right: CollectionInput): boolean {
  return left.name === right.name && JSON.stringify([...left.apparatus_ids].sort()) === JSON.stringify([...right.apparatus_ids].sort())
}
export function sameApparatusCollection(left: ApparatusCollection, right: ApparatusCollection): boolean {
  return left.id === right.id && left.revision === right.revision && sameCollectionInput(left, right)
}
function freezeInput<T extends CollectionInput>(input: T): T { Object.freeze(input.apparatus_ids); return Object.freeze(input) }
export function createCollectionOperation(input: CollectionInput, baseline?: ApparatusCollection): CollectionOperation {
  const normalized = freezeInput(normalizeCollectionInput(input))
  return baseline
    ? Object.freeze({ kind: 'update', input: normalized, baseline: freezeInput(parseApparatusCollection(baseline)) })
    : Object.freeze({ kind: 'create', input: normalized })
}
export function deleteCollectionOperation(baseline: ApparatusCollection): CollectionOperation {
  const original = freezeInput(parseApparatusCollection(baseline))
  return Object.freeze({ kind: 'delete', input: freezeInput({ name: original.name, apparatus_ids: [...original.apparatus_ids] }), baseline: original })
}
export class CollectionConflict extends Error {
  readonly current: ApparatusCollection[]
  constructor(current: ApparatusCollection[], message: string) { super(message); this.name = 'CollectionConflict'; this.current = current }
}
export class CollectionUnknown extends Error {
  readonly operation: CollectionOperation
  constructor(operation: CollectionOperation) {
    super('Saqlash natijasi noma’lum. Avvalgi tanlov saqlandi; so‘rov qayta yuborilmaydi. Serverdagi joriy ma’lumotni tekshiring.')
    this.name = 'CollectionUnknown'; this.operation = operation
  }
}

/** Native collection commands have revision CAS, but no idempotency or write receipt lookup. */
export class ApparatusCollectionsApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  private requireRead(): void { if (!canReadCollections(this.session)) throw new ApiError(403, 'forbidden') }
  private requireManage(): void { this.requireRead(); if (!canManageCollections(this.session)) throw new ApiError(403, 'forbidden') }
  async list(signal?: AbortSignal): Promise<ApparatusCollection[]> {
    this.requireRead(); abort(signal)
    const collections = parseApparatusCollections(await this.client.request(apparatusCollectionsPath, 'GET', { signal, expectedStatus: 200 }))
    abort(signal); return collections
  }
  async apparatus(q = '', signal?: AbortSignal): Promise<GroupCatalog<GroupApparatus>> {
    this.requireRead(); abort(signal)
    const items = rows(await this.client.request(`${base}/apparatus`, 'GET', { query: { q: q.trim(), limit: collectionApparatusLimit }, signal, expectedStatus: 200 })).map(parseGroupApparatus)
    abort(signal)
    if (items.length > collectionApparatusLimit || new Set(items.map(item => item.id)).size !== items.length) return invalid()
    return { items: items.filter(item => item.active), bounded: items.length >= collectionApparatusLimit }
  }
  async execute(operation: CollectionOperation, signal?: AbortSignal): Promise<ApparatusCollection | null> {
    this.requireManage(); abort(signal)
    const input = normalizeCollectionInput(operation.input), baseline = operation.baseline && parseApparatusCollection(operation.baseline)
    if (!['create', 'update', 'delete'].includes(operation.kind) || (operation.kind === 'create') === Boolean(baseline)) throw new Error('Apparat guruhini ro‘yxatdan qayta tanlang.')
    if (baseline && operation.kind === 'update' && baseline.revision === Number.MAX_SAFE_INTEGER) throw new Error('Guruh versiyasini xavfsiz o‘qib bo‘lmadi. Ro‘yxatni yangilang.')
    const current = await this.list(signal); abort(signal)
    const previous = baseline && current.find(item => item.id === baseline.id)
    if (baseline && (!previous || !sameApparatusCollection(previous, baseline))) throw new CollectionConflict(current, 'Apparat guruhi boshqa joyda o‘zgargan yoki topilmadi. Joriy nusxani ko‘rib, tahrirni qayta boshlang.')
    if (operation.kind !== 'delete') {
      // Exact duplicates are safe to flag locally; native uniqueness is final for all case/collation comparisons.
      if (current.some(item => item.id !== baseline?.id && item.name === input.name)) throw new CollectionConflict(current, 'Bu nomdagi apparat guruhi mavjud. Boshqa nom tanlang.')
      // Search and bounded catalogs never prove membership: every selected ID gets an exact read.
      for (let offset = 0; offset < input.apparatus_ids.length; offset += 10) {
        await Promise.all(input.apparatus_ids.slice(offset, offset + 10).map(async id => {
          const apparatus = parseGroupApparatus(await this.client.request(`${base}/apparatus/${encodeURIComponent(id)}`, 'GET', { signal, expectedStatus: 200 }))
          if (apparatus.id !== id) return invalid()
          if (!apparatus.active) throw new Error('Tanlangan apparat faol emas. Tanlovni yangilang yoki uni guruhdan olib tashlang.')
        }))
        abort(signal)
      }
    }
    const path = baseline ? `${apparatusCollectionsPath}/${encodeURIComponent(baseline.id)}` : apparatusCollectionsPath
    const body = operation.kind === 'delete' ? { expected_revision: baseline!.revision } : { ...input, ...(baseline ? { expected_revision: baseline.revision } : {}) }
    abort(signal)
    // Only this block covers a dispatched write; preflight failures are safe known failures.
    try {
      const result = await this.client.request(path, operation.kind === 'create' ? 'POST' : operation.kind === 'update' ? 'PUT' : 'DELETE', { body, signal, expectedStatus: operation.kind === 'delete' ? 204 : 200 })
      abort(signal)
      if (operation.kind === 'delete') { if (result !== undefined) return invalid(); return null }
      const saved = parseApparatusCollection(result)
      if (!sameCollectionInput(saved, input) || saved.revision !== (baseline ? baseline.revision + 1 : 1)
        || (baseline ? saved.id !== baseline.id : current.some(item => item.id === saved.id))) return invalid()
      return saved
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || [408, 429].includes(error.status) || error.status >= 500 || error.code === 'invalid_response') throw new CollectionUnknown(operation)
      throw error
    }
  }
  async observe(operation: CollectionOperation, signal?: AbortSignal): Promise<CollectionObservation> {
    const collections = await this.list(signal); abort(signal)
    const target = operation.baseline ? collections.find(item => item.id === operation.baseline!.id)
      : collections.find(item => item.name === operation.input.name) ?? collections.find(item => collectionNameKey(item.name) === collectionNameKey(operation.input.name))
    const matches = target && (operation.kind === 'delete' ? sameApparatusCollection(target, operation.baseline) : sameCollectionInput(target, operation.input))
    return { collections, ...(target ? { target } : {}), state: target ? matches ? 'matches' : 'different' : 'missing' }
  }
}

export interface CollectionIntent { readonly operation: CollectionOperation; readonly status: 'pending' | 'unknown'; readonly observation?: CollectionObservation }
/** RAM only, scoped by session. Matching reads show current state, never who committed a write. */
export class CollectionIntentLedger {
  private intent: CollectionIntent | null = null
  private readonly listeners = new Set<() => void>()
  snapshot = (): CollectionIntent | null => this.intent
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(intent: CollectionIntent | null): void { this.intent = intent && Object.freeze(intent); this.listeners.forEach(listener => listener()) }
  begin(operation: CollectionOperation): void {
    if (this.intent) throw new Error('Avvalgi saqlash natijasini tekshiring. So‘rov takrorlanmaydi.')
    this.publish({ operation, status: 'pending' })
  }
  unknown(operation: CollectionOperation): void { if (this.intent?.operation === operation) this.publish({ operation, status: 'unknown' }) }
  finish(operation: CollectionOperation): void { if (this.intent?.operation === operation && this.intent.status === 'pending') this.publish(null) }
  observe(operation: CollectionOperation, observation: CollectionObservation): void {
    if (this.intent?.operation === operation && this.intent.status === 'unknown') this.publish({ operation, status: 'unknown', observation })
  }
  resolveReviewed(operation: CollectionOperation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'unknown' || !this.intent.observation) throw new Error('Avval serverdagi joriy ma’lumotni tekshiring.')
    this.publish(null)
  }
}
const ledgers = new Map<string, CollectionIntentLedger>()
export function collectionIntentLedger(scope: string): CollectionIntentLedger {
  let ledger = ledgers.get(scope)
  if (!ledger) { ledger = new CollectionIntentLedger(); ledgers.set(scope, ledger) }
  return ledger
}
export function collectionError(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      'apparatus collection name is required': 'Apparat guruhi nomini kiriting.',
      'apparatus collection name is too long': 'Apparat guruhi nomi 80 belgidan oshmasin.',
      'apparatus collection has too many apparatus': 'Guruhga 500 tagacha apparat tanlang.',
      'apparatus id is invalid': 'Tanlangan apparat topilmadi yoki faol emas. Tanlovni yangilang.',
      'apparatus collection name already exists': 'Bu nomdagi apparat guruhi mavjud. Boshqa nom tanlang.',
      'apparatus collection not found': 'Apparat guruhi topilmadi. Ro‘yxatni yangilang.',
      'apparatus collection revision is invalid': 'Guruh versiyasini tekshiring. Ro‘yxatni yangilang.',
      'apparatus collection revision conflict': 'Apparat guruhi boshqa joyda o‘zgargan. Joriy nusxani ko‘rib, tahrirni qayta boshlang.',
      'apparatus collection store failed': 'Apparat guruhini saqlashda server xatosi yuz berdi.',
    }
    return messages[error.code] || error.message
  }
  return error instanceof Error ? error.message : 'Amal bajarilmadi.'
}
