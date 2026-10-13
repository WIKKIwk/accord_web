import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { hasCapability, meetsRequirement } from './permissions'
import { isCanonicalApparatusId, productionMapFromRow } from './production-map'
import { productionOrderPolicy } from './production-controls'
import { ProductionOperationLedger, productionOperationLedger } from './production-operation-ledger'
import type { ProductionOperation, ProductionOperationLease } from './production-operation-ledger'

export const MATERIAL_LINK_PATH = '/v1/mobile/material-link-requests'
export const MATERIAL_LINK_API_LIMITATIONS = [
  'The worker list contains the latest 50 requests for one order, apparatus and requester. There is no manager inbox, cursor or full history endpoint.',
  'Create has no client key or expected revision. It groups selected rolls by their actual mover and commits each group independently. Unknown creation is never replayed or confirmed from similar read observations.',
  'Decisions use the native request ID and terminal state. Approval, selected assignments and the decision are one transaction; a repeated decision returns the saved outcome and original decider.',
  'Request GET reconciles pending requests to stale or expired. Candidate stock ID, location, placement version and mover are native bindings; no warehouse or receipt ID is emitted.',
  'Fresh client reads are not an atomic precondition. No stage selector is accepted; worker creation follows the synchronized native start-material interaction.',
] as const
const str = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const code = (value: string) => value.trim().replace(/[A-Z]/g, letter => letter.toLowerCase())
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const stable = (value: unknown): string => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))])) : value ?? null)
const same = (left: unknown, right: unknown) => stable(left) === stable(right)
const ids = (values: readonly string[]) => [...values].map(code).sort()
const invalid = (message = 'Homashyo ulash so‘rovining javobi to‘liq yoki tanlangan manbaga mos emas.'): never => { throw new ApiError(502, 'invalid_response', message) }
export class MaterialLinkError extends Error {
  readonly kind: 'blocked' | 'conflict' | 'forbidden' | 'uncertain'
  constructor(kind: MaterialLinkError['kind'], message: string) { super(message); this.name = 'MaterialLinkError'; this.kind = kind }
}
const blocked = (message: string): never => { throw new MaterialLinkError('blocked', message) }
function current(signal: AbortSignal, isCurrent: () => boolean) { if (signal.aborted || !isCurrent()) throw new DOMException('Interrupted', 'AbortError') }
export const isMaterialLinkRequestId = (value: unknown): value is string => typeof value === 'string' && /^material-link-[a-f0-9]{32}$/.test(value)
export type MaterialLinkStatus = 'pending' | 'approved' | 'cancelled' | 'stale' | 'expired'
export const materialLinkStatusLabels: Record<MaterialLinkStatus, string> = { pending: 'Tasdiq kutilmoqda', approved: 'Tasdiqlangan', cancelled: 'Bekor qilingan', stale: 'Holat o‘zgargan — so‘rov yopilgan', expired: 'So‘rov muddati tugagan' }
export interface MaterialLinkCandidate {
  stock_id: string; barcode: string; item_name: string; qty: number; uom: string
  location_id: string; location_name: string; placement_version: number; mover_ref: string; mover_display_name: string
}
export interface MaterialLinkRequest {
  request_id: string; status: MaterialLinkStatus; event_sequence: number; order_id: string; order_number: string; order_title: string
  apparatus_id: string; apparatus_name: string; requester_ref: string; requester_display_name: string; mover_ref: string; mover_display_name: string
  candidates: MaterialLinkCandidate[]; selected_barcodes: string[]; decided_by_name: string; decided_by_role: string; decided_at_unix: number; reason: string
  requested_at_unix: number; expires_at_unix: number
}
export interface MaterialLinkOverview { available_count: number; candidates: MaterialLinkCandidate[]; requests: MaterialLinkRequest[] }
export interface MaterialLinkDetail { can_decide: boolean; request: MaterialLinkRequest }
export function materialLinkPermissions(session: Session | null) {
  const read = meetsRequirement(session, { any: ['apparatus.queue.manage', 'raw_material.assign', 'admin.access'] }) && ['admin', 'aparatchi', 'material_taminotchi'].includes(str(session?.profile.role)) && Boolean(str(session?.profile.ref))
  return { read, worker: read && session?.profile.role === 'aparatchi' && Boolean(str(session.profile.ref)), create: hasCapability(session, 'apparatus.queue.manage') && session?.profile.role === 'aparatchi' && Boolean(str(session.profile.ref)), decide: hasCapability(session, 'raw_material.assign') && ['admin', 'material_taminotchi'].includes(str(session?.profile.role)) && Boolean(str(session?.profile.ref)) }
}
function nativeReader(session: Session | null, request: MaterialLinkRequest): boolean {
  return session?.profile.role === 'admin' || session?.profile.role === 'material_taminotchi' && session.profile.ref === request.mover_ref || session?.profile.role === 'aparatchi' && session.profile.ref === request.requester_ref
}
function nativeDecider(session: Session | null, request: MaterialLinkRequest): boolean { return session?.profile.role === 'admin' || session?.profile.role === 'material_taminotchi' && session.profile.ref === request.mover_ref }
export function materialLinkCanAct(session: Session | null, detail: MaterialLinkDetail, action: 'approve' | 'reject' | 'cancel'): boolean {
  const permission = materialLinkPermissions(session), request = detail.request
  const apparatusScope = action !== 'approve' || session?.profile.role !== 'material_taminotchi' || session.assigned_apparatus.includes(request.apparatus_id)
  return request.status === 'pending' && permission.read && apparatusScope && (action === 'cancel' ? session?.profile.role === 'aparatchi' && session.profile.ref === request.requester_ref : permission.decide && detail.can_decide && nativeDecider(session, request))
}
export function parseMaterialLinkCandidate(value: unknown): MaterialLinkCandidate {
  const row = record(value), fields = ['stock_id', 'barcode', 'item_name', 'uom', 'location_id', 'location_name', 'mover_ref', 'mover_display_name'] as const
  if (fields.some(key => typeof row[key] !== 'string') || ['stock_id', 'barcode', 'uom', 'location_id', 'mover_ref'].some(key => !str(row[key])) || typeof row.qty !== 'number' || !Number.isFinite(row.qty) || row.qty <= 0 || !integer(row.placement_version) || row.placement_version < 1) return invalid()
  return Object.fromEntries([...fields, 'qty', 'placement_version'].map(key => [key, row[key]])) as unknown as MaterialLinkCandidate
}
function candidates(value: unknown): MaterialLinkCandidate[] {
  const result = rows(value).map(parseMaterialLinkCandidate)
  if (new Set(result.map(value => code(value.barcode))).size !== result.length || new Set(result.map(value => value.stock_id)).size !== result.length) return invalid()
  return result
}
export function parseMaterialLinkRequest(value: unknown): MaterialLinkRequest {
  const row = record(value), fields = ['order_id', 'order_number', 'order_title', 'apparatus_id', 'apparatus_name', 'requester_ref', 'requester_display_name', 'mover_ref', 'mover_display_name', 'decided_by_name', 'decided_by_role', 'reason'] as const
  if (!isMaterialLinkRequestId(row.request_id) || !Object.hasOwn(materialLinkStatusLabels, str(row.status)) || fields.some(key => typeof row[key] !== 'string') || ['order_id', 'requester_ref', 'mover_ref'].some(key => !str(row[key])) || !isCanonicalApparatusId(str(row.apparatus_id)) || !integer(row.event_sequence) || row.event_sequence < 1 || !integer(row.requested_at_unix) || row.requested_at_unix <= 0 || !integer(row.expires_at_unix) || row.expires_at_unix <= row.requested_at_unix || !integer(row.decided_at_unix)) return invalid()
  const rolls = candidates(row.candidates), selected = row.selected_barcodes
  if (!rolls.length || rolls.some(value => value.mover_ref !== row.mover_ref) || !Array.isArray(selected) || selected.some(value => typeof value !== 'string' || !str(value)) || new Set(selected.map(code)).size !== selected.length || selected.some(value => !rolls.some(roll => code(roll.barcode) === code(value)))) return invalid()
  if (row.status === 'pending' ? selected.length !== 0 || row.decided_at_unix !== 0 || row.decided_by_role !== '' || row.decided_by_name !== '' : row.event_sequence < 2 || row.decided_at_unix <= 0) return invalid()
  if (row.status === 'approved' ? !selected.length || !['admin', 'material_taminotchi'].includes(str(row.decided_by_role)) : selected.length !== 0) return invalid()
  if (row.status === 'cancelled' && !['admin', 'material_taminotchi', 'aparatchi'].includes(str(row.decided_by_role))) return invalid()
  if (['stale', 'expired'].includes(str(row.status)) && (row.decided_by_role !== '' || row.decided_by_name !== '')) return invalid()
  return { ...Object.fromEntries(fields.map(key => [key, row[key]])), request_id: row.request_id, status: row.status, event_sequence: row.event_sequence, candidates: rolls, selected_barcodes: [...selected], requested_at_unix: row.requested_at_unix, expires_at_unix: row.expires_at_unix, decided_at_unix: row.decided_at_unix } as MaterialLinkRequest
}
function requests(value: unknown): MaterialLinkRequest[] {
  const result = rows(value).map(parseMaterialLinkRequest)
  if (new Set(result.map(value => value.request_id)).size !== result.length) return invalid()
  return result
}
export function parseMaterialLinkOverview(value: unknown, session: Session | null, orderId: string, apparatusId: string): MaterialLinkOverview {
  const row = record(value), available = candidates(row.candidates), saved = requests(row.requests)
  if (!integer(row.available_count) || row.available_count !== available.length || saved.length > 50 || saved.some(value => value.order_id !== orderId || value.apparatus_id !== apparatusId || value.requester_ref !== session?.profile.ref)) return invalid()
  return { available_count: row.available_count, candidates: available, requests: saved }
}
function workerRead(session: Session | null, orderId: string, apparatusId: string): void {
  if (!materialLinkPermissions(session).worker || !str(orderId) || !isCanonicalApparatusId(apparatusId) || !session?.assigned_apparatus.includes(apparatusId)) throw new MaterialLinkError('forbidden', 'So‘rov ro‘yxati faqat shu apparatga biriktirilgan haqiqiy operator uchun ochiq.')
}
export async function readMaterialLinkOverview(client: ApiClient, session: Session | null, orderId: string, apparatusId: string, signal?: AbortSignal): Promise<MaterialLinkOverview> {
  workerRead(session, orderId, apparatusId)
  return parseMaterialLinkOverview(await client.get(MATERIAL_LINK_PATH, { order_id: orderId, apparatus: apparatusId }, signal), session, orderId, apparatusId)
}
export async function readMaterialLinkRequest(client: ApiClient, session: Session | null, requestId: string, signal?: AbortSignal, expectedOrderId?: string): Promise<MaterialLinkDetail> {
  if (!materialLinkPermissions(session).read || !isMaterialLinkRequestId(requestId)) throw new MaterialLinkError('forbidden', 'Haqiqiy native so‘rov identifikatori va uni o‘qish ruxsati kerak.')
  const row = record(await client.get(MATERIAL_LINK_PATH, { request_id: requestId }, signal)), request = parseMaterialLinkRequest(row.request)
  if (request.request_id !== requestId || expectedOrderId && request.order_id !== expectedOrderId || !nativeReader(session, request) || typeof row.can_decide !== 'boolean' || row.can_decide !== nativeDecider(session, request)) return invalid('So‘rov identifikatori, buyurtma yoki serverdagi qaror ruxsati mos kelmadi.')
  return { can_decide: row.can_decide, request }
}
export interface MaterialLinkApparatusChoice { apparatusId: string; label: string; stageNodeId: string; create: boolean; reason: string }
function contextFingerprint(snapshot: ProductionSnapshot, orderId: string, apparatusId: string): string { return stable([snapshot.maps.find(value => value.map.id === orderId)?.map, snapshot.order_statuses[orderId], snapshot.order_controls[orderId], snapshot.stage_states[orderId], snapshot.queue_states[apparatusId]?.[orderId], snapshot.queue_action_controls[apparatusId]?.[orderId]]) }
export function materialLinkApparatusChoices(snapshot: ProductionSnapshot | undefined, orderId: string, session: Session | null): MaterialLinkApparatusChoice[] {
  if (!materialLinkPermissions(session).worker) return []
  const saved = snapshot?.maps.find(value => value.map.id === orderId), order = productionOrderPolicy(snapshot, orderId, session)
  let nodes: ReturnType<typeof productionMapFromRow>['nodes'] = []
  try { if (saved) nodes = productionMapFromRow(saved.map).nodes } catch { /* Invalid graph disables creation; saved requests remain readable. */ }
  return [...new Set(session?.assigned_apparatus ?? [])].filter(isCanonicalApparatusId).map(apparatusId => {
    const control = snapshot?.queue_action_controls[apparatusId]?.[orderId], interaction = isRecord(control?.interaction) ? control.interaction : {}
    const matches = nodes.filter(node => node.kind === 'apparatus' && (str(node.alternative_assigned_apparatus_id) || str(node.apparatus_id)) === apparatusId)
    const stageNodeId = str(control?.stage_node_id), stage = matches.find(node => node.id === stageNodeId)
    const lanes = new Set(matches.map(node => str(node.alternative_group_id) ? `group:${node.alternative_group_id}` : `node:${node.id}`))
    const bound = Boolean(snapshot && stage && lanes.size === 1 && ['pending', 'print_preflight', 'in_progress', 'paused'].includes(str(control?.state)) && control?.state === snapshot.queue_states[apparatusId]?.[orderId] && interaction.start_materials_mode === 'scan_required' && interaction.material_scan_required === true && interaction.assigned_materials_display_only === false)
    const active = order.state === 'active' && !order.earlyClose && ['released', 'in_progress'].includes(order.lifecycle) && ['not_started', 'ready', 'print_preflight', 'in_progress', 'paused', 'waiting_next_stage', 'partially_completed'].includes(order.operational)
    const create = Boolean(orderId.startsWith('zakaz-') && materialLinkPermissions(session).create && active && bound)
    return { apparatusId, label: str(session?.assigned_apparatus_labels[session.assigned_apparatus.indexOf(apparatusId)]) || str(stage?.title) || apparatusId, stageNodeId, create, reason: !materialLinkPermissions(session).create ? 'Yangi so‘rov uchun apparatus.queue.manage ruxsati kerak.' : !active || !orderId.startsWith('zakaz-') ? 'Yangi so‘rov uchun faol native buyurtma kerak.' : !bound ? 'Joriy canonical bosqichning material tanlash ruxsati olinmadi yoki apparat bir nechta bosqichda takrorlangan.' : '' }
  })
}
interface LinkPlanBase { authScope: string; orderId: string; apparatusId: string; actor: { role: string; ref: string }; body: Row }
export interface MaterialLinkCreatePlan extends LinkPlanBase {
  action: 'create'; selected: MaterialLinkCandidate[]; baselineRequestIds: string[]; epoch: string; snapshotScope: string; revision: number; fingerprint: string; stageNodeId: string
}
export interface MaterialLinkDecisionPlan extends LinkPlanBase { action: 'approve' | 'reject' | 'cancel'; baseline: MaterialLinkRequest }
export type MaterialLinkPlan = MaterialLinkCreatePlan | MaterialLinkDecisionPlan
export interface MaterialLinkProof { action: MaterialLinkPlan['action']; requestId?: string; stockIds: string[]; locationVersions: { stockId: string; locationId: string; version: number; moverRef: string; qty: number; uom: string }[] }
export function materialLinkProof(plan: MaterialLinkPlan): MaterialLinkProof {
  const rolls = plan.action === 'create' ? plan.selected : plan.baseline.candidates
  return { action: plan.action, ...(plan.action === 'create' ? {} : { requestId: plan.baseline.request_id }), stockIds: rolls.map(value => value.stock_id).sort(), locationVersions: rolls.map(value => ({ stockId: value.stock_id, locationId: value.location_id, version: value.placement_version, moverRef: value.mover_ref, qty: value.qty, uom: value.uom })).sort((left, right) => left.stockId.localeCompare(right.stockId)) }
}
function selection(available: readonly MaterialLinkCandidate[], barcodes: readonly string[]): MaterialLinkCandidate[] {
  if (!barcodes.length || barcodes.some(value => !str(value)) || new Set(ids(barcodes)).size !== barcodes.length) return blocked('Kerakli rulonlarni alohida tanlang. Bo‘sh yoki takroriy tanlov yuborilmaydi.')
  return barcodes.map(barcode => { const found = available.filter(value => code(value.barcode) === code(barcode)); if (found.length !== 1) return blocked('Tanlangan rulon haqiqiy server nomzodida mavjud emas.'); return structuredClone(found[0]) }).sort((left, right) => left.stock_id.localeCompare(right.stock_id))
}
function actor(session: Session | null, authScope: string) { if (!str(authScope) || !str(session?.profile.role) || !str(session?.profile.ref)) return blocked('Haqiqiy sessiya va operator identifikatori kerak.'); return { role: session!.profile.role, ref: session!.profile.ref! } }
export function materialLinkCreatePlan(snapshot: ProductionSnapshot, session: Session | null, authScope: string, orderId: string, apparatusId: string, overview: MaterialLinkOverview, barcodes: readonly string[]): MaterialLinkCreatePlan {
  workerRead(session, orderId, apparatusId)
  const context = materialLinkApparatusChoices(snapshot, orderId, session).find(value => value.apparatusId === apparatusId)
  const native = parseMaterialLinkOverview(overview, session, orderId, apparatusId)
  if (!context?.create || !str(snapshot.epoch) || typeof snapshot.scope !== 'string' || !integer(snapshot.rev)) return blocked(context?.reason || 'Serverdagi material tanlash bosqichi aniqlanmagan.')
  if (native.requests.some(value => value.status === 'pending')) return blocked('Avvalgi so‘rov bo‘yicha tasdiq kutilmoqda. Yangi so‘rov yuborilmaydi.')
  const selected = selection(native.candidates, barcodes)
  return { action: 'create', authScope, orderId, apparatusId, actor: actor(session, authScope), selected, baselineRequestIds: native.requests.map(value => value.request_id).sort(), epoch: snapshot.epoch, snapshotScope: snapshot.scope, revision: snapshot.rev, fingerprint: contextFingerprint(snapshot, orderId, apparatusId), stageNodeId: context.stageNodeId, body: { action: 'create', order_id: orderId, apparatus: apparatusId, barcodes: selected.map(value => value.barcode) } }
}
export function materialLinkDecisionPlan(session: Session | null, authScope: string, detail: MaterialLinkDetail, action: MaterialLinkDecisionPlan['action'], barcodes: readonly string[] = []): MaterialLinkDecisionPlan {
  const baseline = parseMaterialLinkRequest(detail.request)
  if (!materialLinkCanAct(session, { ...detail, request: baseline }, action)) throw new MaterialLinkError('forbidden', 'Bu so‘rov va qaror uchun haqiqiy rol, server ruxsati yoki raw_material.assign doirasi yetarli emas.')
  const selected = action === 'approve' ? selection(baseline.candidates, barcodes) : []
  if (action !== 'approve' && barcodes.length) return blocked('Rad etish yoki bekor qilishda rulonlar ulanmaydi.')
  return { action, authScope, orderId: baseline.order_id, apparatusId: baseline.apparatus_id, actor: actor(session, authScope), baseline: structuredClone(baseline), body: { request_id: baseline.request_id, action, barcodes: selected.map(value => value.barcode) } }
}
function immutableRequest(request: MaterialLinkRequest): Row { const { status: _status, event_sequence: _sequence, selected_barcodes: _selected, decided_by_name: _name, decided_by_role: _role, decided_at_unix: _at, reason: _reason, ...immutable } = request; return immutable }
export interface MaterialLinkResult { requests: MaterialLinkRequest[]; observed: boolean; message: string; confirmed: boolean }
function decisionResult(request: MaterialLinkRequest, observed: boolean): MaterialLinkResult { return { requests: [request], observed, confirmed: request.status !== 'pending', message: `Serverdagi so‘rov holati: ${materialLinkStatusLabels[request.status]}. Qaror vaqti va xodimi saqlangan qayddan olinadi.` } }
function assertOwned(session: Session | null, plan: MaterialLinkPlan, signal: AbortSignal, isCurrent: () => boolean) {
  current(signal, isCurrent)
  if (!materialLinkPermissions(session).read || session?.profile.role !== plan.actor.role || session?.profile.ref !== plan.actor.ref) throw new MaterialLinkError('forbidden', 'Avvalgi so‘rov aynan shu sessiya va rol doirasida tekshirilishi kerak.')
  const held = productionOperationLedger.get<MaterialLinkPlan, MaterialLinkProof>(plan.authScope, plan.orderId, 'material-link')
  if (!held || held.phase !== 'pending' || !same(held.plan, plan) || !same(held.proof, materialLinkProof(plan))) return blocked('Avval buyurtmaning umumiy ishlab chiqarish amalini band qiling. Yangi so‘rov yuborilmadi.')
  return held
}
function createGroups(plan: MaterialLinkCreatePlan): Map<string, MaterialLinkCandidate[]> {
  const groups = new Map<string, MaterialLinkCandidate[]>()
  for (const value of plan.selected) groups.set(value.mover_ref, [...groups.get(value.mover_ref) ?? [], value])
  return groups
}
function sameRolls(left: readonly MaterialLinkCandidate[], right: readonly MaterialLinkCandidate[]): boolean { return same([...left].sort((a, b) => a.stock_id.localeCompare(b.stock_id)), [...right].sort((a, b) => a.stock_id.localeCompare(b.stock_id))) }
function matchingCreation(plan: MaterialLinkCreatePlan, request: MaterialLinkRequest): boolean { return request.order_id === plan.orderId && request.apparatus_id === plan.apparatusId && request.requester_ref === plan.actor.ref && sameRolls(request.candidates, createGroups(plan).get(request.mover_ref) ?? []) }
export async function readMaterialLinkOutcome(client: ApiClient, session: Session | null, plan: MaterialLinkPlan, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<MaterialLinkResult> {
  const owner = assertOwned(session, plan, signal, isCurrent)
  if (plan.action === 'create') {
    const overview = await readMaterialLinkOverview(client, session, plan.orderId, plan.apparatusId, signal); current(signal, isCurrent)
    if (assertOwned(session, plan, signal, isCurrent).serial !== owner.serial) return blocked('Avvalgi natijani o‘qish bandligi tugagan. Kechikkan javob yangi oqimga qo‘llanmaydi.')
    const matches = overview.requests.filter(value => !plan.baselineRequestIds.includes(value.request_id) && matchingCreation(plan, value))
    materialLinkAttempts.observe(plan.authScope, plan.orderId, matches)
    return { requests: matches, observed: true, confirmed: false, message: `Server ro‘yxatida mos ${matches.length} ta so‘rov kuzatildi. Ro‘yxat oxirgi 50 ta qayd bilan cheklangan; bu identifikatorsiz yuborish natijasini isbotlamaydi. Avvalgi yuborish saqlanmoqda.` }
  }
  const detail = await readMaterialLinkRequest(client, session, plan.baseline.request_id, signal, plan.orderId); current(signal, isCurrent)
  if (assertOwned(session, plan, signal, isCurrent).serial !== owner.serial) return blocked('Avvalgi natijani o‘qish bandligi tugagan.')
  if (!same(immutableRequest(detail.request), immutableRequest(plan.baseline)) || detail.request.event_sequence < plan.baseline.event_sequence) return invalid()
  return decisionResult(detail.request, true)
}
export async function executeMaterialLink(client: ApiClient, session: Session | null, plan: MaterialLinkPlan, lease: ProductionOperationLease, signal: AbortSignal, isCurrent: () => boolean = () => true, recovery = false): Promise<MaterialLinkResult> {
  assertOwned(session, plan, signal, isCurrent)
  const held = productionOperationLedger.get(plan.authScope, plan.orderId, 'material-link')
  if (lease.scope !== plan.authScope || lease.orderId !== plan.orderId || lease.channel !== 'material-link' || held?.serial !== lease.serial || recovery && !lease.wasUncertain || !recovery && held.dispatched) return blocked('Avvalgi yuborish yangi so‘rov sifatida takrorlanmaydi. Avval uning server holatini tekshiring.')
  if (recovery && plan.action === 'create') return blocked('Yangi so‘rov yaratishning native kaliti yo‘q. Avvalgi yaratish qayta yuborilmaydi.')
  if (plan.action === 'create') {
    const snapshot = await client.productionSnapshot(signal); current(signal, isCurrent)
    const context = materialLinkApparatusChoices(snapshot, plan.orderId, session).find(value => value.apparatusId === plan.apparatusId)
    if (!context?.create || context.stageNodeId !== plan.stageNodeId || snapshot.epoch !== plan.epoch || snapshot.scope !== plan.snapshotScope || snapshot.rev < plan.revision || contextFingerprint(snapshot, plan.orderId, plan.apparatusId) !== plan.fingerprint) throw new MaterialLinkError('conflict', 'Buyurtma, canonical bosqich yoki material so‘rovi ruxsati o‘zgargan.')
    const overview = await readMaterialLinkOverview(client, session, plan.orderId, plan.apparatusId, signal); current(signal, isCurrent)
    if (overview.requests.some(value => value.status === 'pending') || !sameRolls(selection(overview.candidates, plan.selected.map(value => value.barcode)), plan.selected)) throw new MaterialLinkError('conflict', 'Avvalgi so‘rov, rulon miqdori, joyi, placement versiyasi yoki haqiqiy ko‘chirgan xodim o‘zgargan.')
    if (!same(plan.body, { action: 'create', order_id: plan.orderId, apparatus: plan.apparatusId, barcodes: plan.selected.map(value => value.barcode) })) return blocked('Saqlangan tanlov native yuborish tanasiga mos kelmadi.')
  } else {
    const detail = await readMaterialLinkRequest(client, session, plan.baseline.request_id, signal, plan.orderId); current(signal, isCurrent)
    if (!same(immutableRequest(detail.request), immutableRequest(plan.baseline)) || detail.request.event_sequence < plan.baseline.event_sequence) return invalid()
    if (detail.request.status !== 'pending') return decisionResult(detail.request, true)
    if (!materialLinkCanAct(session, detail, plan.action) || detail.request.event_sequence !== plan.baseline.event_sequence) throw new MaterialLinkError('forbidden', 'So‘rovning qaror ruxsati yoki joriy native holati o‘zgargan.')
    const barcodes = plan.body.barcodes
    if (!Array.isArray(barcodes) || barcodes.some(value => typeof value !== 'string')) return blocked('Saqlangan rulon tanlovi noto‘g‘ri.')
    const selected = plan.action === 'approve' ? selection(detail.request.candidates, barcodes) : []
    if (!same(plan.body, { request_id: plan.baseline.request_id, action: plan.action, barcodes: selected.map(value => value.barcode) })) return blocked('Saqlangan qaror native so‘rovga mos kelmadi.')
  }
  current(signal, isCurrent)
  if (!productionOperationLedger.dispatched(lease)) return blocked('Amal bandligi tugagan. Homashyo so‘rovi yuborilmadi.')
  try {
    const payload = record(await client.post(MATERIAL_LINK_PATH, plan.body, signal)); current(signal, isCurrent)
    if (assertOwned(session, plan, signal, isCurrent).serial !== lease.serial) return blocked('Yuborilgan so‘rov bandligi tugagan. Kechikkan javob yangi oqimni ochmaydi.')
    if (plan.action === 'create') {
      // Preserve valid returned native IDs even if a later group or receipt is malformed.
      const observed: MaterialLinkRequest[] = []
      if (Array.isArray(payload.requests)) for (const value of payload.requests) { try { const request = parseMaterialLinkRequest(value); if (matchingCreation(plan, request)) observed.push(request) } catch { /* The complete receipt remains invalid. */ } }
      materialLinkAttempts.observe(plan.authScope, plan.orderId, observed)
      const saved = requests(payload.requests), groups = createGroups(plan)
      if (saved.length !== groups.size || new Set(saved.map(value => value.mover_ref)).size !== groups.size || saved.some(value => !matchingCreation(plan, value) || plan.baselineRequestIds.includes(value.request_id))) return invalid()
      return { requests: saved, observed: false, confirmed: true, message: `Server ${saved.length} ta homashyo ulash so‘rovining haqiqiy identifikatori va holatini qaytardi.` }
    }
    const saved = parseMaterialLinkRequest(payload.request)
    if (!same(immutableRequest(saved), immutableRequest(plan.baseline)) || saved.event_sequence <= plan.baseline.event_sequence || saved.status === 'pending') return invalid()
    return decisionResult(saved, false)
  } catch (caught) {
    const reason = caught instanceof ApiError ? caught.status === 403 ? 'Server ushbu rolning amalini rad etdi. ' : caught.status === 409 ? 'Serverdagi material yoki qaror holati o‘zgargan. ' : '' : ''
    throw new MaterialLinkError('uncertain', `${reason}Yuborilgan so‘rov natijasi aniqlanmagan. Aynan avvalgi tanlov saqlangan; yangi yuborish qulflangan.`)
  }
}
export interface MaterialLinkDraft { apparatusId: string; barcodes: string[]; requestId: string }
const emptyDraft = (): MaterialLinkDraft => ({ apparatusId: '', barcodes: [], requestId: '' })
export class MaterialLinkAttemptRegistry {
  private ledger: ProductionOperationLedger; private scope = ''; private revision = 0; private drafts = new Map<string, MaterialLinkDraft>(); private observations = new Map<string, MaterialLinkRequest[]>(); private requestOrders = new Map<string, string>(); private listeners = new Set<() => void>()
  constructor(ledger = new ProductionOperationLedger()) { this.ledger = ledger }
  activate(scope: string) { this.ledger.activate(scope); if (scope !== this.scope) { this.scope = scope; this.drafts.clear(); this.observations.clear(); this.requestOrders.clear(); this.revision++ } }
  subscribe = (callback: () => void) => { this.listeners.add(callback); const remove = this.ledger.subscribe(callback); return () => { this.listeners.delete(callback); remove() } }
  getRevision = () => this.revision + this.ledger.getRevision()
  private publish() { this.revision++; for (const listener of this.listeners) listener() }
  draft(scope: string, key: string) { return scope === this.scope ? structuredClone(this.drafts.get(key) ?? emptyDraft()) : emptyDraft() }
  saveDraft(scope: string, key: string, draft: MaterialLinkDraft, orderId = key) { if (scope !== this.scope || this.ledger.get(scope, orderId)) return blocked('Avvalgi ishlab chiqarish amali hal qilinmaguncha tanlov o‘zgartirilmaydi.'); this.drafts.set(key, structuredClone(draft)); this.publish() }
  get(scope: string, orderId: string): ProductionOperation<MaterialLinkPlan, MaterialLinkProof> | null { return this.ledger.get(scope, orderId, 'material-link') }
  observed(scope: string, orderId: string) { return scope === this.scope ? structuredClone(this.observations.get(orderId) ?? []) : [] }
  orderForRequest(scope: string, requestId: string) { return scope === this.scope ? this.requestOrders.get(requestId) : undefined }
  observe(scope: string, orderId: string, values: MaterialLinkRequest[]) {
    const held = this.get(scope, orderId)
    if (scope !== this.scope || held?.plan.action !== 'create') return
    const prior = this.observations.get(orderId) ?? [], next = new Map(prior.map(value => [value.request_id, value]))
    for (const input of values) { const value = parseMaterialLinkRequest(input); if (!matchingCreation(held.plan, value)) continue; const old = next.get(value.request_id); if (!old || value.event_sequence >= old.event_sequence) next.set(value.request_id, value) }
    this.observations.set(orderId, [...next.values()]); this.publish()
  }
  begin(scope: string, plan: MaterialLinkPlan, recovery = false) {
    if (scope !== plan.authScope) return blocked('Sessiya doirasi o‘zgargan.')
    const lease = this.ledger.begin(scope, { channel: 'material-link', orderId: plan.orderId, plan, proof: materialLinkProof(plan) }, recovery)
    if (!recovery) this.observations.delete(plan.orderId)
    if (plan.action !== 'create') this.requestOrders.set(plan.baseline.request_id, plan.orderId)
    return lease
  }
  finish(lease: ProductionOperationLease, outcome: { confirmed: true } | { error: string; uncertain: boolean }) { this.ledger.finish(lease, outcome) }
  interrupt(lease: ProductionOperationLease) { this.ledger.interrupt(lease) }
}
export const materialLinkAttempts = new MaterialLinkAttemptRegistry(productionOperationLedger)
