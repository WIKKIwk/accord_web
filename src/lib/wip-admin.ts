import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { hasCapability, meetsRequirement } from './permissions'
import { apparatusOption, isCanonicalApparatusId, normalizeMapBranch } from './production-map'
import { productionOrderControlState } from './production-controls'

const base = '/v1/mobile/admin/production-maps'
export const WIP_API_LIMITATIONS = [
  'GET wip-batches has no batch move or undo method. Production-maps/move moves an order queue; inventory relocations do not accept WIP assets.',
  'Opening intake has no create-preview endpoint. Source choices use the current native map topology, stage/status snapshot and canonical apparatus profiles; POST remains authoritative.',
  'Opening records are capped at 500 intakes with no pagination or key lookup. A missing row in that snapshot cannot prove a write was absent.',
  'Opening cancellation has no revision precondition. Fresh reads guard the selected batch; the backend transaction enforces usage and lineage locks.',
  'Label printing is a separate hardware workflow and is not performed by registration or read-only route validation.',
] as const

const str = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const obj = (value: unknown): Row => isRecord(value) ? value : {}
const statusSet = new Set(['pending', 'print_preflight', 'in_progress', 'paused', 'completed'])
const operationalSet = new Set(['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'waiting_next_stage', 'partially_completed'])

function invalid(message = 'WIP javobi to‘liq yoki mos kelgan holda olinmadi.'): never { throw new ApiError(502, 'invalid_response', message) }
function required(value: unknown): string { const result = str(value); if (!result) return invalid(); return result }
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(); return value }
function optionalNumber(value: unknown): number | null { return value === undefined || value === null ? null : finite(value) }
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid()
  const result = value.map(required)
  if (new Set(result).size !== result.length) return invalid()
  return result
}

export function wipPermissions(session: Session | null | undefined) {
  const manage = meetsRequirement(session, { any: ['admin.access', 'production.map.manage'] })
  return {
    read: meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'apparatus.queue.read'] }),
    preview: meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'apparatus.queue.manage'] }),
    create: manage,
    cancel: hasCapability(session, 'admin.access') && session?.profile.role === 'admin',
  }
}

export interface OpeningWipBatch extends Row {
  batch_id: string
  intake_id: string
  order_id: string
  sequence_no: number
  qr_payload: string
  quantity_basis: string
  wip_status: string
  finished_goods_meter: number | null
  finished_goods_kg: number | null
  bobina_kg: number | null
  diameter: number | null
}
export interface OpeningWipIntake extends Row {
  intake_id: string
  idempotency_key: string
  order_id: string
  entry_apparatus: string
  source_apparatus: string
  source_operation: string
  resume_stage_node_id: string
  resume_apparatus: string
  current_location: string
  status: string
}
export interface OpeningWipRecord { intake: OpeningWipIntake; batches: OpeningWipBatch[] }
export interface OpeningWipDetail { intake: OpeningWipIntake; batch: OpeningWipBatch }
export interface OpeningWipSource {
  orderId: string
  nodeId: string
  apparatusId: string
  label: string
  operation: string
  revision: number
  next: { nodeId: string; apparatusId: string; label: string }[]
}
export interface OpeningWipRollDraft { basis: 'measured' | 'estimated'; metres: string; kg: string; bobinaKg: string; diameter: string }
export interface OpeningWipCreateBody extends Row {
  idempotency_key: string
  order_id: string
  source_apparatus: string
  source_stage_node_id: string
  note?: string
  batches: Row[]
}
export interface OpeningWipCommand {
  body: OpeningWipCreateBody
  sourceOperation: string
  fingerprint: string
  epoch: string
  scope: string
}

export function wipOrderId(row: Row): string { return str(isRecord(row.map) ? row.map.id : row.order_id ?? row.id) }
export function wipBatchId(row: Row): string { return str(isRecord(row.batch) ? row.batch.batch_id : row.batch_id) }
export function isOpeningWipRow(row: Row): boolean { return isRecord(row.intake) || Boolean(str(row.intake_id)) }

export function parseOpeningWipBatch(value: unknown): OpeningWipBatch {
  const batch = record(value)
  const sequence = finite(batch.sequence_no)
  if (!Number.isSafeInteger(sequence) || sequence < 1) return invalid()
  for (const key of ['quantity', 'finished_goods_meter', 'finished_goods_kg', 'bobina_kg', 'diameter']) optionalNumber(batch[key])
  for (const key of ['used_by_session_id', 'used_by_apparatus', 'processed_by_session_id', 'processed_by_apparatus']) if (batch[key] !== undefined && typeof batch[key] !== 'string') return invalid()
  return {
    ...batch, batch_id: required(batch.batch_id), intake_id: required(batch.intake_id), order_id: required(batch.order_id), sequence_no: sequence,
    qr_payload: required(batch.qr_payload), quantity_basis: required(batch.quantity_basis), wip_status: required(batch.wip_status),
    finished_goods_meter: optionalNumber(batch.finished_goods_meter), finished_goods_kg: optionalNumber(batch.finished_goods_kg), bobina_kg: optionalNumber(batch.bobina_kg), diameter: optionalNumber(batch.diameter),
  }
}
export function parseOpeningWipIntake(value: unknown): OpeningWipIntake {
  const intake = record(value)
  for (const key of ['source_apparatus', 'resume_apparatus', 'current_location']) if (intake[key] !== undefined && typeof intake[key] !== 'string') return invalid()
  return { ...intake, intake_id: required(intake.intake_id), idempotency_key: required(intake.idempotency_key), order_id: required(intake.order_id),
    entry_apparatus: required(intake.entry_apparatus), source_apparatus: str(intake.source_apparatus), source_operation: required(intake.source_operation),
    resume_stage_node_id: required(intake.resume_stage_node_id), resume_apparatus: str(intake.resume_apparatus), current_location: str(intake.current_location), status: required(intake.status) }
}
export function parseOpeningWipRecord(value: unknown): OpeningWipRecord {
  const result = record(value), intake = parseOpeningWipIntake(result.intake), batches = rows(result.batches).map(parseOpeningWipBatch)
  if (!batches.length || new Set(batches.map(batch => batch.batch_id)).size !== batches.length || new Set(batches.map(batch => batch.sequence_no)).size !== batches.length || batches.some(batch => batch.order_id !== intake.order_id || batch.intake_id !== intake.intake_id)) return invalid()
  return { intake, batches }
}

export async function openingWipRecords(client: ApiClient, orderId = '', signal?: AbortSignal): Promise<OpeningWipRecord[]> {
  const records = rows(await client.get(`${base}/opening-wip`, { order_id: orderId.trim(), status: 'all', limit: 500 }, signal), 'records').map(parseOpeningWipRecord)
  if ((orderId && records.some(value => value.intake.order_id !== orderId.trim())) || new Set(records.map(value => value.intake.intake_id)).size !== records.length) return invalid()
  return records
}
export async function openingWipDetail(client: ApiClient, row: Row, signal?: AbortSignal): Promise<OpeningWipDetail> {
  const orderId = required(row.order_id ?? obj(row.intake).order_id), batchId = required(wipBatchId(row))
  const records = await openingWipRecords(client, orderId, signal)
  const matches = records.flatMap(value => value.batches.filter(batch => batch.batch_id === batchId).map(batch => ({ intake: value.intake, batch })))
  if (matches.length !== 1) throw new ApiError(409, 'opening_wip_snapshot_missing', 'Tanlangan rulon cheklangan server ro‘yxatida tasdiqlanmadi. Ma’lumotni yangilang.')
  return matches[0]
}

export function openingWipOrderIssue(snapshot: ProductionSnapshot | undefined, orderId: string): string {
  if (!snapshot || !snapshot.maps.some(value => value.map.id === orderId)) return 'Buyurtma serverning joriy holatida olinmagan.'
  const status = obj(snapshot.order_statuses[orderId])
  if (['production_completed', 'closed', 'cancelled'].includes(str(status.lifecycle_status)) || ['completed', 'completed_with_issue'].includes(str(status.order_status))) return 'Tugallangan yoki yopilgan buyurtmaga WIP kiritilmaydi.'
  if (!['released', 'in_progress'].includes(str(status.lifecycle_status)) || !operationalSet.has(str(status.order_status))) return 'Buyurtmaning holati noma’lum. Yangilang.'
  if (productionOrderControlState(snapshot, orderId) !== 'active') return 'Muzlatilgan yoki muzlatish kutilayotgan buyurtmaga WIP kiritilmaydi.'
  if (obj(snapshot.order_controls[orderId]).early_close) return 'Buyurtma erta yopilgan yoki yopish kutilmoqda.'
  return ''
}

/** Ports the native branch-aware, occurrence-specific physical-stage traversal. */
function physicalRoute(map: Row) {
  const nodes = Array.isArray(map.nodes) ? map.nodes.filter(isRecord) : []
  const edges = Array.isArray(map.edges) ? map.edges.filter(isRecord) : []
  const byId = new Map(nodes.map(node => [str(node.id), node]))
  const peers = (left: string, right: string): boolean => {
    if (left === right) return true
    const a = byId.get(left), b = byId.get(right)
    return Boolean(a && b && a.kind === 'apparatus' && b.kind === 'apparatus' && str(a.alternative_group_id) && a.alternative_group_id === b.alternative_group_id && isCanonicalApparatusId(str(a.apparatus_id)) && isCanonicalApparatusId(str(b.apparatus_id)))
  }
  const successors = (id: string): string[] => {
    const node = byId.get(id)
    if (!node) return []
    return edges.filter(edge => (str(edge.from) === id || peers(str(edge.from), id)) && !peers(str(edge.to), id) && (node.kind !== 'condition' || ['true', 'false'].includes(normalizeMapBranch(str(edge.branch))))).map(edge => str(edge.to))
  }
  const start = nodes.filter(node => node.kind === 'start')
  if (start.length !== 1 || byId.size !== nodes.length || edges.some(edge => !byId.has(str(edge.from)) || !byId.has(str(edge.to)))) return { stages: [] as Row[], next: (_id: string) => [] as Row[] }
  const seen = new Set<string>(), stageNodes = new Set<string>(), queue = [str(start[0].id)]
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (!node) continue
    if (node.kind === 'apparatus') for (const candidate of nodes.filter(value => value.kind === 'apparatus' && (value.id === id || str(node.alternative_group_id) && value.alternative_group_id === node.alternative_group_id))) stageNodes.add(str(candidate.id))
    queue.push(...successors(id))
  }
  const stages = nodes.filter(node => stageNodes.has(str(node.id)))
  const next = (id: string): Row[] => {
    const found: Row[] = [], seenNext = new Set<string>(), nextQueue = successors(id)
    for (let index = 0; index < nextQueue.length; index++) {
      const nextId = nextQueue[index]
      if (seenNext.has(nextId)) continue
      seenNext.add(nextId)
      const node = byId.get(nextId)
      if (!node || ['start', 'end'].includes(str(node.kind))) continue
      if (stageNodes.has(nextId)) { found.push(node); continue }
      nextQueue.push(...successors(nextId))
    }
    return found
  }
  return { stages, next }
}

export function openingWipSources(snapshot: ProductionSnapshot | undefined, orderId: string, apparatusRows: readonly Row[]): OpeningWipSource[] {
  if (openingWipOrderIssue(snapshot, orderId)) return []
  const saved = snapshot!.maps.find(value => value.map.id === orderId)!
  const route = physicalRoute(saved.map)
  const stageStates = obj(snapshot!.stage_states[orderId])
  if (!route.stages.length || route.stages.every(node => stageStates[str(node.id)] === 'completed')) return []
  const options = apparatusRows.map(apparatusOption)
  const identity = (node: Row) => str(node.alternative_group_id) ? str(node.apparatus_id) : str(node.alternative_assigned_apparatus_id) || str(node.apparatus_id)
  const sources: OpeningWipSource[] = []
  for (const node of route.stages) {
    const id = identity(node)
    const matches = options.filter(option => option.id === id)
    const apparatus = matches.length === 1 ? matches[0] : undefined
    const revision = apparatus ? obj(apparatus.row.runtime_projection ?? apparatus.row).source_revision : undefined
    if (!apparatus?.active || !isCanonicalApparatusId(id) || !['print', 'laminate', 'cut', 'package', 'glue'].includes(apparatus.operation) || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || !statusSet.has(str(stageStates[str(node.id)]))) continue
    const next = route.next(str(node.id)).map(target => ({ nodeId: str(target.id), apparatusId: identity(target), label: str(target.title) || identity(target) }))
    if (!next.length || next.some(target => !isCanonicalApparatusId(target.apparatusId))) continue
    sources.push({ orderId, nodeId: str(node.id), apparatusId: id, label: apparatus.name || str(node.title) || id, operation: apparatus.operation, revision, next })
  }
  return sources
}

export function openingWipDestinations(snapshot: ProductionSnapshot | undefined, detail: OpeningWipDetail): { nodeId: string; apparatusId: string; label: string }[] {
  if (openingWipOrderIssue(snapshot, detail.intake.order_id) || detail.intake.status !== 'confirmed' || detail.batch.wip_status !== 'waiting') return []
  const map = snapshot!.maps.find(value => value.map.id === detail.intake.order_id)!.map
  const route = physicalRoute(map)
  const source = route.stages.find(node => node.id === detail.intake.resume_stage_node_id)
  const identity = (node: Row) => str(node.alternative_group_id) ? str(node.apparatus_id) : str(node.alternative_assigned_apparatus_id) || str(node.apparatus_id)
  if (!source) return []
  const targets = detail.intake.source_apparatus
    ? identity(source) === detail.intake.source_apparatus ? route.next(str(source.id)) : []
    : identity(source) === detail.intake.resume_apparatus ? [source] : []
  return targets.map(node => ({ nodeId: str(node.id), apparatusId: identity(node), label: str(node.title) || identity(node) })).filter(value => isCanonicalApparatusId(value.apparatusId))
}

export function openingWipFingerprint(snapshot: ProductionSnapshot, orderId: string, source: OpeningWipSource): string {
  const saved = snapshot.maps.find(value => value.map.id === orderId)
  return JSON.stringify([saved?.map, snapshot.order_statuses[orderId], snapshot.order_controls[orderId] ?? null, snapshot.stage_states[orderId], source])
}
function positiveInput(value: string, label: string): number {
  const parsed = /^\+?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value.trim().replace(',', '.')) : NaN
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label}: noldan katta son kiriting.`)
  return parsed
}
export function openingWipCreateCommand(snapshot: ProductionSnapshot, apparatusRows: readonly Row[], session: Session | null, orderId: string, sourceNodeId: string, rolls: readonly OpeningWipRollDraft[], note = '', key: string = crypto.randomUUID()): OpeningWipCommand {
  if (!wipPermissions(session).create) throw new ApiError(403, 'forbidden')
  const issue = openingWipOrderIssue(snapshot, orderId)
  if (issue) throw new Error(issue)
  const source = openingWipSources(snapshot, orderId, apparatusRows).find(value => value.nodeId === sourceNodeId)
  if (!source) throw new Error('Server xaritasidan mos chiqish bosqichini tanlang.')
  if (!rolls.length || rolls.length > 500 || !key.trim() || key.length > 200) throw new Error('1–500 rulon va amal identifikatori talab qilinadi.')
  if (Array.from(note.trim()).length > 2000) throw new Error('Izoh 2000 belgidan oshmasligi kerak.')
  const batches = rolls.map((roll, index) => {
    if (!['measured', 'estimated'].includes(roll.basis)) throw new Error('Miqdor asosini tanlang: o‘lchangan yoki taxminiy.')
    if (source.operation !== 'cut' && roll.diameter.trim()) throw new Error('Diametr faqat Rezka chiqishi uchun kiritiladi.')
    return { quantity_basis: roll.basis, finished_goods_meter: positiveInput(roll.metres, `${index + 1}-rulon uzunligi`), finished_goods_kg: positiveInput(roll.kg, `${index + 1}-rulon og‘irligi`), bobina_kg: positiveInput(roll.bobinaKg, `${index + 1}-rulon bobinasi`), ...(source.operation === 'cut' ? { diameter: positiveInput(roll.diameter, `${index + 1}-rulon diametri`) } : {}) }
  })
  const body: OpeningWipCreateBody = { idempotency_key: key.trim(), order_id: orderId, source_apparatus: source.apparatusId, source_stage_node_id: source.nodeId, ...(note.trim() ? { note: note.trim() } : {}), batches }
  return { body, sourceOperation: source.operation, fingerprint: openingWipFingerprint(snapshot, orderId, source), epoch: snapshot.epoch, scope: snapshot.scope }
}

export function openingWipCancelIssue(detail: OpeningWipDetail, session: Session | null): string {
  if (!wipPermissions(session).cancel) return 'Bekor qilish uchun haqiqiy admin hisobi va admin.access ruxsati kerak.'
  if (detail.intake.status !== 'confirmed' || detail.batch.wip_status !== 'waiting' || ['used_by_session_id', 'used_by_apparatus', 'processed_by_session_id', 'processed_by_apparatus'].some(key => Boolean(str(detail.batch[key])))) return 'Faqat foydalanilmagan kutayotgan rulon bekor qilinadi.'
  return ''
}

function sameOpeningIdentity(left: OpeningWipDetail, right: OpeningWipDetail): boolean {
  return left.intake.intake_id === right.intake.intake_id && left.intake.order_id === right.intake.order_id
    && ['entry_apparatus', 'source_apparatus', 'source_operation', 'current_location', 'resume_apparatus', 'resume_stage_node_id', 'idempotency_key'].every(key => left.intake[key] === right.intake[key])
    && left.batch.batch_id === right.batch.batch_id && left.batch.qr_payload === right.batch.qr_payload && left.batch.order_id === right.batch.order_id && left.batch.intake_id === right.batch.intake_id && left.batch.sequence_no === right.batch.sequence_no
    && ['quantity_basis', 'quantity', 'uom', 'finished_goods_meter', 'finished_goods_kg', 'bobina_kg', 'diameter'].every(key => (left.batch[key] ?? null) === (right.batch[key] ?? null))
}
export function openingWipMatchesCommand(result: OpeningWipRecord, command: OpeningWipCommand): boolean {
  const body = command.body, intake = result.intake
  if (intake.idempotency_key !== body.idempotency_key || intake.order_id !== body.order_id || intake.source_apparatus !== body.source_apparatus || intake.entry_apparatus !== body.source_apparatus || intake.source_operation !== command.sourceOperation || intake.resume_stage_node_id !== body.source_stage_node_id || intake.current_location || intake.resume_apparatus || result.batches.length !== body.batches.length || str(intake.note) !== str(body.note)) return false
  return result.batches.every(batch => {
    const input = body.batches[batch.sequence_no - 1]
    return input && ['quantity_basis', 'finished_goods_meter', 'finished_goods_kg', 'bobina_kg', 'diameter'].every(key => (batch[key] ?? null) === (input[key] ?? null)) && batch.quantity === input.finished_goods_meter && batch.uom === 'm'
  })
}

export class WipMutationError extends Error {
  readonly uncertain: boolean
  constructor(message: string, uncertain: boolean) { super(message); this.name = 'WipMutationError'; this.uncertain = uncertain }
}

export interface OpeningWipAttempt {
  context: string
  command: OpeningWipCommand
  phase: 'pending' | 'uncertain' | 'blocked' | 'confirmed'
  dispatched: boolean
  serial: number
  result?: OpeningWipRecord
  error?: string
}
export interface OpeningWipAttemptLease {
  scope: string
  generation: number
  context: string
  serial: number
  key: string
  wasUncertain: boolean
}

/** RAM only: no client, session, token, storage or credentials are retained. */
export class OpeningWipAttemptRegistry {
  private scope = ''
  private generation = 0
  private revision = 0
  private serial = 0
  private entries = new Map<string, OpeningWipAttempt>()
  private listeners = new Set<() => void>()

  // Called by the session-keyed entry point; render already follows the identity change.
  activate(scope: string): void {
    if (this.scope === scope) return
    this.scope = scope
    this.generation++
    this.entries.clear()
    this.revision++
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getRevision = (): number => this.revision
  private publish() { this.revision++; for (const listener of this.listeners) listener() }
  get(scope: string, context: string, orderId = ''): OpeningWipAttempt | null {
    if (scope !== this.scope) return null
    const exact = this.entries.get(context)
    const unresolved = [...this.entries.values()].find(value => ['pending', 'uncertain'].includes(value.phase) && (!orderId || value.command.body.order_id === orderId))
    const entry = exact && ['pending', 'uncertain'].includes(exact.phase) ? exact : unresolved ?? exact
    return entry ? structuredClone(entry) : null
  }
  begin(scope: string, context: string, command: OpeningWipCommand, recovery = false): OpeningWipAttemptLease {
    if (scope !== this.scope) throw new Error('Sessiya o‘zgargan. Qabul oynasini qayta oching.')
    const unresolved = [...this.entries.values()].find(value => ['pending', 'uncertain'].includes(value.phase) && (value.context === context || value.command.body.order_id === command.body.order_id))
    if (unresolved && (!recovery || unresolved.phase === 'pending' || JSON.stringify(unresolved.command.body) !== JSON.stringify(command.body))) throw new Error('Avvalgi qabul natijasi aniqlanmagan. Yangi qabuldan oldin aynan avvalgi so‘rovni tiklang.')
    const targetContext = unresolved?.context ?? context
    const existing = this.entries.get(targetContext)
    if (existing?.phase === 'confirmed') throw new Error('Bu qabul tasdiqlangan. Yangi qabulni alohida boshlang.')
    const serial = ++this.serial
    this.entries.set(targetContext, { context: targetContext, command: structuredClone(command), phase: 'pending', dispatched: unresolved?.dispatched ?? false, serial })
    this.publish()
    return { scope, generation: this.generation, context: targetContext, serial, key: command.body.idempotency_key, wasUncertain: unresolved?.phase === 'uncertain' }
  }
  private current(lease: OpeningWipAttemptLease): OpeningWipAttempt | undefined {
    const entry = this.entries.get(lease.context)
    return lease.scope === this.scope && lease.generation === this.generation && entry?.serial === lease.serial && entry.command.body.idempotency_key === lease.key ? entry : undefined
  }
  dispatched(lease: OpeningWipAttemptLease): void {
    const entry = this.current(lease)
    if (!entry) return
    entry.dispatched = true
    this.publish()
  }
  finish(lease: OpeningWipAttemptLease, outcome: { result: OpeningWipRecord } | { error: string; uncertain: boolean } | { missing: true }): void {
    const entry = this.current(lease)
    if (!entry) return
    if ('result' in outcome) {
      if (!openingWipMatchesCommand(outcome.result, entry.command)) { entry.phase = 'uncertain'; entry.error = 'Server boshqa qabul yoki miqdorni qaytardi. Avvalgi so‘rov saqlanmoqda.' }
      else { entry.phase = 'confirmed'; entry.result = structuredClone(outcome.result); entry.error = undefined }
    }
    else if ('missing' in outcome) { entry.phase = 'uncertain'; entry.error = 'Qabul cheklangan ro‘yxatda tasdiqlanmadi. Avvalgi so‘rov saqlanmoqda.' }
    else { entry.phase = outcome.uncertain || lease.wasUncertain ? 'uncertain' : 'blocked'; entry.error = outcome.error }
    this.publish()
  }
  interrupt(lease: OpeningWipAttemptLease): void {
    const entry = this.current(lease)
    if (!entry || entry.phase !== 'pending') return
    entry.phase = entry.dispatched || lease.wasUncertain ? 'uncertain' : 'blocked'
    entry.error = entry.phase === 'uncertain' ? 'So‘rov yuborilgach oyna yopilgan. Yangi qabuldan oldin server holatini tekshiring.' : 'So‘rov yuborilmasdan to‘xtatildi. Saqlangan qabulni qayta ko‘rib chiqing.'
    entry.serial = ++this.serial // Late completion cannot overwrite a reopened workflow.
    this.publish()
  }
  clear(scope: string, context: string): void {
    if (scope !== this.scope) return
    const entry = this.entries.get(context)
    if (entry && ['pending', 'uncertain'].includes(entry.phase)) throw new Error('Avvalgi qabul holati tekshirilmaguncha yangi qabul boshlanmaydi.')
    if (this.entries.delete(context)) this.publish()
  }
}
export const openingWipAttempts = new OpeningWipAttemptRegistry()

function mutationError(error: unknown, started: boolean): WipMutationError {
  const uncertain = started && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response')
  return new WipMutationError(uncertain ? 'Amal natijasi aniqlanmagan. Server holatini tekshiring; yangi qabul yaratmang.' : error instanceof Error ? error.message : 'Amal bajarilmadi.', uncertain)
}
function assertCurrent(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
function validateCreateBody(command: OpeningWipCommand) {
  const body = command.body
  if (!str(body.idempotency_key) || body.idempotency_key.length > 200 || !str(body.order_id) || !str(body.source_stage_node_id) || !isCanonicalApparatusId(body.source_apparatus) || !Array.isArray(body.batches) || !body.batches.length || body.batches.length > 500 || !str(command.fingerprint) || !str(command.epoch) || !str(command.scope)) throw new Error('Qabulning identifikatori yoki rulon ma’lumotlari noto‘g‘ri.')
  if (Object.keys(body).some(key => !['idempotency_key', 'order_id', 'source_apparatus', 'source_stage_node_id', 'note', 'batches'].includes(key))) throw new Error('Qabulda qo‘llab-quvvatlanmagan maydon bor.')
  for (const batch of body.batches) {
    if (!['measured', 'estimated'].includes(str(batch.quantity_basis)) || Object.keys(batch).some(key => !['quantity_basis', 'finished_goods_meter', 'finished_goods_kg', 'bobina_kg', 'diameter'].includes(key)) || ['finished_goods_meter', 'finished_goods_kg', 'bobina_kg', ...(command.sourceOperation === 'cut' ? ['diameter'] : [])].some(key => typeof batch[key] !== 'number' || !Number.isFinite(batch[key]) || Number(batch[key]) <= 0) || (command.sourceOperation !== 'cut' && batch.diameter !== undefined)) throw new Error('Rulon o‘lchovlari yoki miqdor asosi noto‘g‘ri.')
  }
}

export async function reconcileOpeningWipCreate(client: ApiClient, command: OpeningWipCommand, signal?: AbortSignal): Promise<OpeningWipRecord | null> {
  const records = await openingWipRecords(client, command.body.order_id, signal)
  const matches = records.filter(value => value.intake.idempotency_key === command.body.idempotency_key)
  if (matches.length > 1 || matches.some(value => !openingWipMatchesCommand(value, command))) return invalid('Shu amal identifikatori boshqa qabulga tegishli. Yangi qabul yaratmang.')
  return matches[0] ?? null
}
export async function createOpeningWip(client: ApiClient, session: Session | null, command: OpeningWipCommand, signal?: AbortSignal, onDispatch?: () => void): Promise<OpeningWipRecord> {
  if (!wipPermissions(session).create) throw new ApiError(403, 'forbidden')
  validateCreateBody(command)
  let started = false
  try {
    // Existing same-key intake is safe to recover even after production advances.
    const existing = await reconcileOpeningWipCreate(client, command, signal)
    if (existing) return existing
    const [snapshot, apparatus] = await Promise.all([client.productionSnapshot(signal), client.listSnapshot('apparatus', { limit: 500 }, signal)])
    const source = openingWipSources(snapshot, command.body.order_id, apparatus.items).find(value => value.nodeId === command.body.source_stage_node_id && value.apparatusId === command.body.source_apparatus)
    if (!source || source.operation !== command.sourceOperation || snapshot.epoch !== command.epoch || snapshot.scope !== command.scope || openingWipFingerprint(snapshot, command.body.order_id, source) !== command.fingerprint) throw new ApiError(409, 'opening_wip_source_changed', 'Buyurtma, chiqish bosqichi yoki apparat o‘zgargan. Ma’lumotni yangilab, qabulni qayta ko‘rib chiqing.')
    assertCurrent(signal)
    started = true
    onDispatch?.()
    const result = parseOpeningWipRecord(record(await client.post(`${base}/opening-wip`, command.body, signal)).record)
    if (!openingWipMatchesCommand(result, command) || result.intake.status !== 'confirmed' || result.batches.some(batch => batch.wip_status !== 'waiting')) return invalid('Server tanlangan bosqich, miqdor va rulonlarni tasdiqlamadi.')
    const confirmed = await reconcileOpeningWipCreate(client, command, signal)
    if (!confirmed || confirmed.intake.intake_id !== result.intake.intake_id || result.batches.some(batch => !confirmed.batches.some(current => current.batch_id === batch.batch_id))) return invalid('Yaratilgan qabul joriy server holatida tasdiqlanmadi.')
    return confirmed
  } catch (error) { throw mutationError(error, started) }
}
export async function cancelOpeningWip(client: ApiClient, session: Session | null, selected: OpeningWipDetail, signal?: AbortSignal): Promise<OpeningWipDetail> {
  const initialIssue = openingWipCancelIssue(selected, session)
  if (initialIssue) throw new Error(initialIssue)
  let started = false
  try {
    const current = await openingWipDetail(client, { order_id: selected.intake.order_id, batch_id: selected.batch.batch_id }, signal)
    if (!sameOpeningIdentity(selected, current) || selected.batch.updated_at_unix !== current.batch.updated_at_unix || selected.intake.updated_at_unix !== current.intake.updated_at_unix) throw new ApiError(409, 'opening_wip_batch_changed', 'Tanlangan rulon yoki qabul o‘zgargan. Joriy holatni yangilang.')
    const issue = openingWipCancelIssue(current, session)
    if (issue) throw new Error(issue)
    assertCurrent(signal)
    started = true
    const result = record(await client.delete(`${base}/opening-wip`, { batch_id: current.batch.batch_id }, signal))
    const removed = { intake: parseOpeningWipIntake(result.intake), batch: parseOpeningWipBatch(result.batch) }
    if (result.ok !== true || !sameOpeningIdentity(current, removed) || removed.batch.wip_status !== 'void' || !['confirmed', 'cancelled'].includes(removed.intake.status)) return invalid('Server tanlangan rulon bekor qilinganini tasdiqlamadi.')
    const confirmed = await openingWipDetail(client, { order_id: current.intake.order_id, batch_id: current.batch.batch_id }, signal)
    if (!sameOpeningIdentity(current, confirmed) || confirmed.batch.wip_status !== 'void') return invalid('Bekor qilish joriy server holatida tasdiqlanmadi.')
    return confirmed
  } catch (error) { throw mutationError(error, started) }
}
export async function reconcileOpeningWipCancel(client: ApiClient, selected: OpeningWipDetail, signal?: AbortSignal): Promise<{ confirmed: boolean; detail: OpeningWipDetail }> {
  const detail = await openingWipDetail(client, { order_id: selected.intake.order_id, batch_id: selected.batch.batch_id }, signal)
  if (!sameOpeningIdentity(selected, detail)) return invalid('Rulon identifikatori yoki miqdori o‘zgargan. Holatni tekshiring.')
  return { confirmed: detail.batch.wip_status === 'void', detail }
}

export interface WipRoutePreview { batch: Row; route: Row | null; routeError: string; activeOrderValidated: boolean }
export async function wipBatchDetail(client: ApiClient, row: Row, signal?: AbortSignal): Promise<Row> {
  const orderId = required(row.order_id), batchId = required(wipBatchId(row))
  const batches = rows(await client.get(`${base}/wip-batches`, { order_id: orderId, status: 'all', limit: 500 }, signal), 'batches')
  const matches = batches.filter(batch => batch.batch_id === batchId)
  if (matches.length !== 1 || matches[0].order_id !== orderId) throw new ApiError(409, 'wip_snapshot_missing', 'Tanlangan WIP ruloni joriy ro‘yxatda tasdiqlanmadi. Yangilang.')
  required(matches[0].wip_status)
  return matches[0]
}
export async function wipRoutePreview(client: ApiClient, row: Row, apparatusId = '', signal?: AbortSignal): Promise<WipRoutePreview> {
  const batchId = required(wipBatchId(row)), orderId = required(row.order_id)
  if (apparatusId && !isCanonicalApparatusId(apparatusId)) throw new Error('Canonical kirish apparatini tanlang.')
  const result = record(await client.post(`${base}/progress-qr/lookup`, { progress_batch_id: batchId, ...(str(row.qr_payload) ? { qr_payload: str(row.qr_payload) } : {}), ...(apparatusId ? { apparatus: apparatusId, order_id: orderId } : {}), require_active_order: true }, signal))
  const batch = record(result.batch)
  if (result.ok !== true || batch.batch_id !== batchId || batch.order_id !== orderId || typeof result.active_order_validated !== 'boolean' || result.active_order_validated !== true || (apparatusId && (result.validated_apparatus !== apparatusId || result.validated_order_id !== orderId))) return invalid('Server tanlangan rulon va kirish apparatini tasdiqlamadi.')
  const route = result.input_route === null || result.input_route === undefined ? null : record(result.input_route)
  const routeError = str(result.input_route_error)
  if (route) {
    required(route.source_stage_node_id); required(route.stage_node_id); required(route.map_fingerprint)
    const ids = stringArray(route.consumer_apparatus_ids)
    if (!ids.length || ids.some(id => !isCanonicalApparatusId(id)) || (apparatusId && !ids.includes(apparatusId))) return invalid()
    if (typeof route.remapped !== 'boolean' || routeError) return invalid()
  }
  return { batch, route, routeError, activeOrderValidated: true }
}
export async function openingWipIntakePreview(client: ApiClient, detail: OpeningWipDetail, apparatusId: string, signal?: AbortSignal): Promise<OpeningWipBatch> {
  if (!isCanonicalApparatusId(apparatusId)) throw new Error('Canonical kirish apparatini tanlang.')
  const result = record(await client.post(`${base}/opening-wip/lookup`, { apparatus: apparatusId, order_id: detail.intake.order_id, batch_id: detail.batch.batch_id, qr_payload: detail.batch.qr_payload }, signal))
  const batch = parseOpeningWipBatch(result.batch)
  if (result.ok !== true || !sameOpeningIdentity(detail, { intake: detail.intake, batch }) || batch.wip_status !== 'waiting') return invalid('Server tanlangan kirish rulonini tasdiqlamadi.')
  return batch
}
