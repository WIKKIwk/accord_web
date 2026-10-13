import { ApiClient, ApiError, isRecord } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import { factoryMapApparatus } from './factory-map'
import { isCanonicalApparatusId, productionMapFromRow } from './production-map'
import { productionCanManageQueue, productionOrderPolicy } from './production-controls'
import { productionOperationLedger } from './production-operation-ledger'
import type { ProductionOperation, ProductionOperationLease } from './production-operation-ledger'

const base = '/v1/mobile/admin/production-maps'
export const COMPLETION_API_LIMITATIONS = [
  'Ordinary queue completion has no command key or exact immutable result lookup. Dispatched unknown writes are retained and are never replayed from current queue status alone.',
  'Full atomic laminate completion is restricted to the active session owner and all native physical source revisions. Opening-WIP full-layer return is not supported by this flow.',
  'Keyed laminate recovery first reads its actor-scoped request_id receipt; an explicit retry preserves the exact original body and source revisions.',
  'This web form implements numeric returned-paint reports. The separate native photo-only return report is not exposed here.',
  'Offline label preparation does not perform USB printing. Label failures after a validated business receipt cannot recreate completion or its saved batches.',
] as const
const str = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const obj = (value: unknown): Row => isRecord(value) ? value : {}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
const measureMatches = (value: unknown, expected: unknown): boolean => finite(value) && finite(expected) && rounded(value) === rounded(expected)
function stable(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort) : isRecord(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, sort(entry[key])])) : entry
  return JSON.stringify(sort(value))
}
export class ProductionCompletionError extends Error {
  readonly kind: 'blocked' | 'conflict' | 'forbidden' | 'uncertain'
  readonly snapshot?: ProductionSnapshot
  constructor(kind: ProductionCompletionError['kind'], message: string, snapshot?: ProductionSnapshot) { super(message); this.name = 'ProductionCompletionError'; this.kind = kind; this.snapshot = snapshot }
}
const blocked = (message: string): never => { throw new ProductionCompletionError('blocked', message) }
const invalid = (message: string): never => { throw new ApiError(502, 'invalid_response', message) }
function current(signal: AbortSignal, isCurrent: () => boolean) { if (signal.aborted || !isCurrent()) throw new DOMException('Interrupted', 'AbortError') }

export interface ProductionCompletionPolicy {
  apparatusId: string
  stageNodeId: string
  name: string
  title: string
  operation: 'print' | 'laminate' | 'cut'
  sourceRevision: number
  state: string
  fullReport: boolean
  closingBatchId: string
  cutWasteOnly: boolean
  control: Row
  allowed: boolean
  reason: string
}
export function productionCompletionPolicies(snapshot: ProductionSnapshot | undefined, orderId: string, session: Session | null, rows: readonly Row[] = []): ProductionCompletionPolicy[] {
  if (!snapshot || !snapshot.maps.some(saved => saved.map.id === orderId)) return []
  let map
  try { map = productionMapFromRow(snapshot.maps.find(saved => saved.map.id === orderId)!.map) } catch { return [] }
  const order = productionOrderPolicy(snapshot, orderId, session)
  const live = order.state === 'active' && !order.earlyClose && ['released', 'in_progress'].includes(order.lifecycle) && ['in_progress', 'paused', 'waiting_next_stage', 'partially_completed'].includes(order.operational)
  return Object.entries(snapshot.queue_action_controls ?? {}).flatMap(([apparatusId, entries]) => {
    const control = entries[orderId]
    if (!isCanonicalApparatusId(apparatusId) || !isRecord(control)) return []
    const matches = rows.map(factoryMapApparatus).filter(row => row.id === apparatusId)
    const machine = matches.length === 1 ? matches[0] : undefined, projection = obj(machine?.row.runtime_projection ?? machine?.row)
    const operation = str(obj(projection.execution_profile).operation)
    if (!['print', 'laminate', 'cut'].includes(operation)) return []
    const stageNodeId = str(control.stage_node_id), node = map.nodes.find(value => value.id === stageNodeId), state = str(snapshot.queue_states[apparatusId]?.[orderId])
    const exactStage = node?.kind === 'apparatus' && (str(node.alternative_assigned_apparatus_id) || str(node.apparatus_id)) === apparatusId
    const activity = obj(control.work_activity)
    const valid = live && exactStage && productionCanManageQueue(session) && machine && projection.apparatus_id === apparatusId && integer(projection.source_revision) && projection.source_revision > 0 &&
      obj(projection.lifecycle).state === 'active' && control.state === state && ['in_progress', 'paused'].includes(state) && typeof control.complete_requires_full_report === 'boolean' &&
      typeof control.complete_requires_rezka_total_waste_only === 'boolean' && activity.state === state && str(activity.worker_role) && str(activity.worker_ref)
    const allowed = Boolean(valid && Array.isArray(control.allowed_actions) && control.allowed_actions.includes('complete'))
    return [{ apparatusId, stageNodeId, name: machine?.name || apparatusId, title: str(node?.alternative_group_label || node?.title) || stageNodeId,
      operation: operation as ProductionCompletionPolicy['operation'], sourceRevision: machine?.revision ?? 0, state, fullReport: control.complete_requires_full_report === true,
      closingBatchId: operation === 'print' ? str(control.closing_output_batch_id) : '', cutWasteOnly: control.complete_requires_rezka_total_waste_only === true, control, allowed,
      reason: allowed ? '' : order.state === 'frozen' ? 'Buyurtma muzlatilgan. Tugatish hisoboti yopiq.' : order.state === 'freeze_requested' ? 'Muzlatish so‘rovi kutilmoqda.' : 'Server bu aniq bosqichni tugatishga ruxsat bermagan yoki ma’lumot to‘liq olinmagan.' }]
  })
}
export interface CompletionLayerSource extends Row { source_kind: string; source_id: string; session_id: string; revision: number; source_net_kg: number }
export interface CompletionContext { session: Row | null; sources: CompletionLayerSource[]; cut: { cycleId: string; counts: number[]; saved: Row[]; epoch: string; rev: number } | null }
function validSavedCutInput(input: Row, batchId: string, qr: string): boolean {
  const metrics = ['produced_qty', 'gross_qty', 'finished_goods_kg', 'finished_goods_meter', 'diameter', 'bobina_kg', 'rezka_bosma_waste', 'rezka_lamination_waste', 'rezka_edge_waste', 'total_waste']
  if (Object.keys(input).some(key => ![...metrics, 'issue_note'].includes(key)) || metrics.some(key => input[key] != null && (!finite(input[key]) || Number(input[key]) < 0)) || input.issue_note !== undefined && typeof input.issue_note !== 'string') return false
  if (str(input.issue_note)) return !batchId && !qr && metrics.every(key => input[key] == null)
  const metres = input.finished_goods_meter ?? input.produced_qty, gross = input.gross_qty ?? input.finished_goods_kg, tare = input.bobina_kg, diameter = input.diameter
  return Boolean(batchId && qr && finite(metres) && metres > 0 && finite(gross) && gross > 0 && finite(tare) && tare > 0 && tare < gross && finite(diameter) && diameter > 0 &&
    (input.produced_qty == null || input.finished_goods_meter == null || measureMatches(input.produced_qty, input.finished_goods_meter)) && (input.gross_qty == null || input.finished_goods_kg == null || measureMatches(input.gross_qty, input.finished_goods_kg)))
}
export async function readProductionCompletionContext(client: ApiClient, policy: ProductionCompletionPolicy, orderId: string, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<CompletionContext> {
  current(signal, isCurrent)
  if (!policy.allowed) return blocked('Server ruxsat bergan bosqichni tanlang.')
  if (policy.operation === 'print') return { session: null, sources: [], cut: null }
  if (policy.operation === 'laminate') {
    const result = obj(await client.get(`${base}/laminatsiya-astatka`, { apparatus: policy.apparatusId, order_id: orderId }, signal)); current(signal, isCurrent)
    const session = obj(result.session)
    if (result.ok !== true || !str(session.session_id) || session.order_id !== orderId || session.apparatus !== policy.apparatusId || session.stage_node_id !== policy.stageNodeId ||
      !['active', 'paused', 'roll_detached'].includes(str(session.status)) || !Array.isArray(result.sources)) return invalid('Laminatsiya sessiyasi aniq bosqichga mos olinmadi.')
    const identities = new Set<string>(), sources: CompletionLayerSource[] = []
    for (const raw of result.sources) {
      const source = obj(raw), identity = `${source.source_kind}:${source.source_id}`
      if (!['progress_batch', 'raw_material'].includes(str(source.source_kind)) || !str(source.source_id) || source.session_id !== session.session_id || !integer(source.revision) || !finite(source.source_net_kg) || source.source_net_kg <= 0 || identities.has(identity)) return invalid('Jismoniy qatlamlar to‘liq va takrorlanmagan holda olinmadi.')
      identities.add(identity); sources.push(source as CompletionLayerSource)
    }
    if (policy.fullReport && (!sources.length || obj(session.payload_json).input_wip_source_kind === 'opening_wip')) return blocked('Bu kirish uchun native qatlamlarni atomik yakunlash oqimi mavjud emas. Qatlam manbalari yoki boshlang‘ich WIP holatini tekshiring.')
    return { session, sources, cut: null }
  }
  const result = obj(await client.get(`${base}/rezka-output-report`, { apparatus: policy.apparatusId, order_id: orderId }, signal)); current(signal, isCurrent)
  const report = obj(result.rezka_output_report)
  if (result.ok !== true || result.apparatus !== policy.apparatusId || result.order_id !== orderId || result.session_status !== 'active' || result.order_control !== 'active' || !str(result.epoch) || !integer(result.rev) ||
    !str(report.cycle_id) || !Array.isArray(result.kadr_counts) || !result.kadr_counts.length || result.kadr_counts.length > 128 || !result.kadr_counts.every(value => integer(value) && value > 0) || !Array.isArray(report.frames)) return invalid('Rezka chiqish sikli serverdan to‘liq olinmadi.')
  const indices = new Set<number>()
  for (const raw of report.frames) {
    const slot = obj(raw), frame = obj(slot.input)
    if (!integer(slot.frame_index) || slot.frame_index < 1 || slot.frame_index > result.kadr_counts.length || indices.has(slot.frame_index) || !isRecord(slot.input) ||
      !validSavedCutInput(frame, str(slot.batch_id), str(slot.qr_payload))) return invalid('Saqlangan rezka rulonlari yoki slotlari mos olinmadi.')
    indices.add(slot.frame_index)
  }
  return { session: null, sources: [], cut: { cycleId: str(report.cycle_id), counts: result.kadr_counts as number[], saved: report.frames as Row[], epoch: str(result.epoch), rev: result.rev as number } }
}

export interface CompletionPaintField { usage: 'rasxot' | 'astatka'; category: 'colors' | 'lacquers' | 'solvents'; name: string; label: string; value: string }
export interface CompletionFrameDraft { metres: string; grossKg: string; tareKg: string; diameter: string; issueNote: string }
export interface ProductionCompletionDraft {
  metres: string; grossKg: string; tareKg: string; waste: string; description: string; inputBatchId: string
  paint: CompletionPaintField[]
  layers: Record<string, string>
  frames: CompletionFrameDraft[]
}
export const emptyCompletionFrame = (): CompletionFrameDraft => ({ metres: '', grossKg: '', tareKg: '', diameter: '', issueNote: '' })
export const emptyProductionCompletionDraft = (): ProductionCompletionDraft => ({ metres: '', grossKg: '', tareKg: '', waste: '', description: '', inputBatchId: '', layers: {}, frames: [],
  paint: (['rasxot', 'astatka'] as const).flatMap(usage => Array.from({ length: 3 }, () => ({ usage, category: 'colors' as const, name: '', label: '', value: '' }))) })
function number(value: string, label: string, allowZero = false): number {
  const parsed = value.trim() ? Number(value.replace(',', '.')) : NaN
  if (!Number.isFinite(parsed) || parsed < 0 || !allowZero && parsed === 0 || parsed > 0 && Math.round(parsed * 1000000) === 0) return blocked(`${label}: ${allowZero ? 'nol yoki musbat' : 'noldan katta'} haqiqiy miqdorni kiriting.`)
  return rounded(parsed)
}
function paintReport(fields: readonly CompletionPaintField[]): { items: Row[]; returnInk: number } {
  const groups = new Map<string, Row>(), counts = { rasxot: 0, astatka: 0 }; let ink = 0n
  for (const field of fields) {
    if (![field.name, field.label, field.value].some(value => value.trim())) continue
    const name = str(field.name), label = str(field.label), decimal = str(field.value).replace(',', '.')
    if (!['rasxot', 'astatka'].includes(field.usage) || !['colors', 'lacquers', 'solvents'].includes(field.category) || !name || !label || name.length > 200 || label.length > 200 || !/^\d+(?:\.\d{1,11})?$/.test(decimal) || !Number.isFinite(Number(decimal))) return blocked('Bo‘yoq hisoboti nom, yorliq va manfiy bo‘lmagan aniq o‘nli qiymatlardan iborat bo‘lishi kerak.')
    const key = stable([field.usage, field.category, name.toLowerCase()]), item = groups.get(key) ?? { usage: field.usage, category: field.category, name, values: {} }
    if (Object.hasOwn(obj(item.values), label)) return blocked('Bo‘yoq hisobotida bir xil maydon takrorlangan.')
    obj(item.values)[label] = decimal; groups.set(key, item); counts[field.usage]++
    if (field.usage === 'astatka') { const [whole, fraction = ''] = decimal.split('.'); ink += BigInt(whole) * 100000000000n + BigInt(fraction.padEnd(11, '0')) }
  }
  if (counts.rasxot < 3 || counts.astatka < 3 || groups.size > 128) return blocked('Rasxot va astatka uchun kamida uchtadan haqiqiy qiymat kiriting.')
  const returnInk = Number(ink) / 100000000000
  if (!Number.isFinite(returnInk)) return blocked('Bo‘yoq miqdori native hisobot chegarasidan oshgan.')
  return { items: [...groups.values()], returnInk }
}
export interface ProductionCompletionCommand {
  orderId: string; apparatusId: string; stageNodeId: string; authScope: string; epoch: string; scope: string; rev: number
  actor: { role: string; ref: string }; sourceRevision: number; fingerprint: string; context: CompletionContext; policy: ProductionCompletionPolicy
  path: string; body: Row; draft: ProductionCompletionDraft; keyed: boolean; expectedApproval: boolean; returnInk?: number
}
function fingerprint(snapshot: ProductionSnapshot, orderId: string, apparatusId: string): string {
  return stable([snapshot.maps.find(saved => saved.map.id === orderId)?.map, snapshot.order_statuses[orderId], snapshot.order_controls[orderId] ?? null, snapshot.queue_states[apparatusId]?.[orderId], snapshot.queue_action_controls[apparatusId]?.[orderId]])
}
export function productionCompletionCommand(snapshot: ProductionSnapshot, orderId: string, session: Session | null, rows: readonly Row[], apparatusId: string, authScope: string, context: CompletionContext, draft: ProductionCompletionDraft, key: string = crypto.randomUUID()): ProductionCompletionCommand {
  const policy = productionCompletionPolicies(snapshot, orderId, session, rows).find(value => value.apparatusId === apparatusId)
  if (!policy?.allowed || !str(snapshot.epoch) || typeof snapshot.scope !== 'string' || !integer(snapshot.rev) || !authScope || !str(session?.profile.role) || !str(session?.profile.ref)) return blocked('Serverning aniq bosqich va sessiya ruxsatlari olinmadi.')
  const description = str(draft.description)
  if (Array.from(description).length > 2000) return blocked('Hisobot izohi 2000 belgidan oshmasligi kerak.')
  const body: Row = { apparatus: apparatusId, order_id: orderId, action: 'complete', include_control: true, print_transport: 'offline' }
  if (description) body.description = description
  let returnInk: number | undefined, keyed = false
  if (policy.operation === 'print') {
    const paint = paintReport(draft.paint); body.returned_paint_items = paint.items; returnInk = paint.returnInk
    body.total_waste = number(draft.waste, 'Umumiy chiqindi, kg', true)
    if (policy.closingBatchId) { body.complete_without_output = true; body.progress_batch_id = policy.closingBatchId }
    else { body.finished_goods_meter = number(draft.metres, 'Tayyor rulon uzunligi, m'); body.finished_goods_kg = number(draft.grossKg, 'Tayyor rulon brutto og‘irligi, kg'); body.bobina_kg = number(draft.tareKg, 'Bobina og‘irligi, kg'); if (Number(body.bobina_kg) >= Number(body.finished_goods_kg)) return blocked('Bobina brutto og‘irlikdan kichik bo‘lishi kerak.') }
  } else if (policy.operation === 'laminate') {
    const anchor = obj(context.session)
    if (anchor.order_id !== orderId || anchor.apparatus !== apparatusId || anchor.stage_node_id !== policy.stageNodeId || !str(anchor.session_id)) return blocked('Laminatsiya sessiyasi aniq bosqichga tasdiqlanmagan.')
    if (policy.fullReport && str(anchor.worker_ref) !== str(session?.profile.ref)) return blocked('Atomik laminatsiya hisobotini shu sessiyaning haqiqiy operatori topshiradi. Admin roli sessiya egaligini almashtirmaydi.')
    body.finished_goods_meter = number(draft.metres, 'Tayyor rulon uzunligi, m'); body.finished_goods_kg = number(draft.grossKg, 'Tayyor rulon brutto og‘irligi, kg')
    body.bobina_kg = number(draft.tareKg, 'Bobina og‘irligi, kg', policy.fullReport)
    if (Number(body.bobina_kg) >= Number(body.finished_goods_kg)) return blocked('Bobina brutto og‘irlikdan kichik bo‘lishi kerak.')
    if (policy.fullReport && body.bobina_kg === 0) delete body.bobina_kg
    if (policy.fullReport) {
      if (!context.sources.length || obj(anchor.payload_json).input_wip_source_kind === 'opening_wip' || key.length < 8 || key.length > 120) return blocked('Native atomik qatlam manbalari yoki buyruq identifikatori olinmagan.')
      const layers = context.sources.map(source => { const remaining = number(draft.layers[`${source.source_kind}:${source.source_id}`] ?? '', `${str(source.item_name) || source.source_id} qoldig‘i, kg`, true); if (remaining > source.source_net_kg) return blocked('Qatlam qoldig‘i haqiqiy kirish og‘irligidan katta bo‘lishi mumkin emas.'); return { source_kind: source.source_kind, source_id: source.source_id, expected_revision: source.revision, remaining_net_kg: remaining } })
      Object.assign(body, { session_id: anchor.session_id, request_id: `web:${key}`, full_completion_report_required: true, layer_remainders: layers,
        lamination_print_leftover_rolls: layers.filter(layer => layer.source_kind === 'progress_batch' && layer.remaining_net_kg > 0).length,
        lamination_film_leftover_rolls: layers.filter(layer => layer.source_kind === 'raw_material' && layer.remaining_net_kg > 0).length, total_waste: number(draft.waste, 'Umumiy chiqindi, kg', true), description })
      delete body.include_control; keyed = true
    }
  } else {
    const cut = context.cut
    if (!cut || draft.frames.length !== cut.counts.length || !cut.counts.length) return blocked('Server chiqish siklining har bir sloti uchun hisobot kerak.')
    body.rezka_output_cycle = cut.cycleId
    body.rezka_frames = cut.counts.map((_, index) => {
      const saved = cut.saved.find(slot => slot.frame_index === index + 1)
      if (saved) { if (!isRecord(saved.input) || !validSavedCutInput(saved.input, str(saved.batch_id), str(saved.qr_payload))) return blocked('Saqlangan rezka slotining asl qiymatlari tasdiqlanmagan.'); return structuredClone(saved.input) }
      const frame = draft.frames[index], note = str(frame.issueNote)
      if (note) { if (Array.from(note).length > 2000 || [frame.metres, frame.grossKg, frame.tareKg, frame.diameter].some(value => value.trim())) return blocked('Muammoli slot izoh bilan qayd etiladi; unga ishlab chiqarilgan miqdor yozilmaydi.'); return { issue_note: note } }
      const gross = number(frame.grossKg, `${index + 1}-rulon brutto, kg`), tare = number(frame.tareKg, `${index + 1}-bobina, kg`)
      if (tare >= gross) return blocked('Bobina brutto og‘irlikdan kichik bo‘lishi kerak.')
      return { finished_goods_meter: number(frame.metres, `${index + 1}-rulon, m`), gross_qty: gross, bobina_kg: tare, diameter: number(frame.diameter, `${index + 1}-rulon diametri`) }
    })
    const allIssues = (body.rezka_frames as Row[]).every(frame => Boolean(str(frame.issue_note)))
    if ((policy.fullReport || policy.cutWasteOnly) && (!allIssues || draft.waste.trim())) body.total_waste = number(draft.waste, 'Umumiy chiqindi, kg')
  }
  // Zero paint rows are an ordinary decimal report. Only explicit scalar zeros
  // in queue progress trigger the native completion approval path.
  const expectedApproval = policy.operation === 'print' && !policy.closingBatchId && body.total_waste === 0
  if (expectedApproval && !description) return blocked('Haqiqiy nol ko‘rsatkich uchun izoh kerak. Native API buni tugallangan ishlab chiqarish emas, tasdiqlash so‘rovi sifatida yuboradi.')
  return { orderId, apparatusId, stageNodeId: policy.stageNodeId, authScope, epoch: snapshot.epoch, scope: snapshot.scope, rev: snapshot.rev, actor: { role: str(session?.profile.role), ref: str(session?.profile.ref) },
    sourceRevision: policy.sourceRevision, fingerprint: fingerprint(snapshot, orderId, apparatusId), context: structuredClone(context), policy, path: `${base}/${keyed ? 'laminatsiya-astatka' : 'queue-action'}`, body, draft: structuredClone(draft), keyed, expectedApproval, returnInk }
}

export interface ProductionCompletionProof { sessionId: string; inputBatchId: string; inputKind: string; links: Row[]; summary: string[] }
export function productionCompletionProof(plan: ProductionCompletionCommand): ProductionCompletionProof {
  const payload = obj(plan.context.session?.payload_json)
  const links = Array.isArray(plan.policy.control.rezka_input_lineage) ? plan.policy.control.rezka_input_lineage.filter(isRecord) : []
  const active = links.filter(link => link.status === 'in_use'), mounted = active.length === 1 ? active[0] : null
  return { sessionId: str(plan.context.session?.session_id), inputBatchId: str(payload.input_progress_batch_id) || str(plan.draft.inputBatchId) || str(mounted?.input_batch_id), inputKind: str(payload.input_wip_source_kind) || str(mounted?.source_kind), links: structuredClone(links),
    summary: [plan.policy.closingBatchId ? 'Oldin saqlangan Bosma chiqishi uchun yopish hisobi' : plan.policy.operation === 'cut' ? `${plan.context.cut?.counts.length ?? 0} native chiqish sloti` : 'Haqiqiy rulon uzunligi va og‘irligi',
      plan.keyed ? `${plan.context.sources.length} qatlamning aniq qoldig‘i va revisioni` : plan.expectedApproval ? 'Nol chiqindi sababli native tasdiqlash so‘rovi' : 'Bosqichning native tugatish hisoboti'] }
}
function contextWitness(context: CompletionContext): string {
  const session = obj(context.session), payload = obj(session.payload_json)
  return stable([session.session_id ?? '', session.order_id ?? '', session.apparatus ?? '', session.stage_node_id ?? '', session.status ?? '', session.worker_role ?? '', session.worker_ref ?? '',
    payload.input_progress_batch_id ?? '', payload.input_wip_source_kind ?? '', payload.input_lineage ?? [], context.sources, context.cut ? [context.cut.cycleId, context.cut.counts, context.cut.saved] : null])
}
/** Readiness POSTs are lineage reads only. They never claim inputs or create output. */
export async function checkProductionCompletion(client: ApiClient, plan: ProductionCompletionCommand, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<ProductionCompletionProof> {
  current(signal, isCurrent)
  const context = await readProductionCompletionContext(client, plan.policy, plan.orderId, signal, isCurrent)
  if (contextWitness(context) !== contextWitness(plan.context) || context.cut && context.cut.epoch !== plan.epoch) throw new ProductionCompletionError('conflict', 'Sessiya, qatlamlar yoki rezka chiqish sikli o‘zgargan. Hisobot qayta ko‘rib chiqilishi kerak.')
  const proof = productionCompletionProof(plan)
  if (plan.policy.operation === 'laminate') {
    const session = obj(context.session), activity = obj(plan.policy.control.work_activity)
    if (session.worker_role !== activity.worker_role || session.worker_ref !== activity.worker_ref || (plan.policy.state === 'in_progress' ? session.status !== 'active' : !['paused', 'roll_detached'].includes(str(session.status)))) return blocked('Laminatsiya sessiyasi yoki joriy operator mos kelmadi.')
    if (plan.keyed && session.worker_ref !== plan.actor.ref) return blocked('Atomik laminatsiya hisobotini sessiya egasi topshirishi kerak.')
    if (proof.inputBatchId && !['progress_batch', 'opening_wip'].includes(proof.inputKind)) return invalid('Ulangan kirish WIP manbasi noma’lum.')
    return proof
  }
  if (proof.links.length) {
    const ids = new Set<string>()
    for (const link of proof.links) {
      if (!str(link.input_batch_id) || !['progress_batch', 'opening_wip'].includes(str(link.source_kind)) || link.stage_node_id !== plan.stageNodeId || !['in_use', 'processed'].includes(str(link.status)) || ids.has(str(link.input_batch_id))) return invalid('Rezka kirish lineage bog‘lanishlari mos olinmadi.')
      ids.add(str(link.input_batch_id))
    }
    const active = proof.links.filter(link => link.status === 'in_use')
    if (active.length > 1) return invalid('Bir nechta joriy kirish ruloni ko‘rsatildi.')
    if (active.length) { proof.inputBatchId = str(active[0].input_batch_id); proof.inputKind = str(active[0].source_kind) }
    return proof
  }
  const batchId = plan.policy.closingBatchId || str(plan.draft.inputBatchId)
  if (!batchId) {
    if (plan.policy.operation === 'cut' || str(plan.policy.control.previous_stage)) return blocked('Ulangan kirish WIP partiyasini tasdiqlash uchun uning identifikatori kerak.')
    return proof
  }
  const report = obj(await client.request(`${base}/progress-qr/report`, 'POST', { body: { progress_batch_id: batchId }, signal })); current(signal, isCurrent)
  const batch = obj(report.scanned_batch)
  if (report.ok !== true || report.history_scope !== 'batch_lineage' || batch.batch_id !== batchId || batch.order_id !== plan.orderId || !Array.isArray(report.active_sessions)) return invalid('WIP hisoboti aynan tanlangan buyurtma va partiyaga mos kelmadi.')
  const matches = report.active_sessions.filter(isRecord).filter(value => value.order_id === plan.orderId && value.apparatus === plan.apparatusId && value.stage_node_id === plan.stageNodeId && ['active', 'paused', 'roll_detached'].includes(str(value.status)))
  if (matches.length !== 1 || !str(matches[0].session_id)) return blocked('Shu bosqichning aniq ishlayotgan sessiyasi olinmadi.')
  const session = matches[0], payload = obj(session.payload_json), activity = obj(plan.policy.control.work_activity)
  if (session.worker_role !== activity.worker_role || session.worker_ref !== activity.worker_ref) return blocked('Ishni bajarayotgan operator o‘zgargan.')
  proof.sessionId = str(session.session_id)
  if (plan.policy.closingBatchId) {
    if (batch.session_id !== session.session_id || batch.apparatus !== plan.apparatusId || obj(batch.payload_json).stage_node_id !== plan.stageNodeId) return blocked('Bosma yopish partiyasi boshqa sessiyaga tegishli.')
  } else {
    if (payload.input_progress_batch_id !== batchId || payload.input_wip_source_kind !== 'progress_batch' || batch.wip_status !== 'in_use' || batch.used_by_session_id !== session.session_id ||
      (str(batch.used_by_apparatus) || str(batch.current_apparatus)) !== plan.apparatusId) return blocked('Bu rulon shu bosqichning joriy ulangan kirish WIPsi emas.')
    proof.inputBatchId = batchId; proof.inputKind = 'progress_batch'
  }
  return proof
}

export interface ProductionCompletionResult { kind: 'completed' | 'partial' | 'approval_requested'; message: string; snapshot?: ProductionSnapshot; batches: Row[]; remainders: Row[]; prints: Row[] }
function validSession(session: Row, plan: ProductionCompletionCommand, proof: ProductionCompletionProof): boolean {
  const payload = obj(session.payload_json)
  if (!str(session.session_id) || proof.sessionId && session.session_id !== proof.sessionId || session.order_id !== plan.orderId || session.apparatus !== plan.apparatusId || session.stage_node_id !== plan.stageNodeId || session.status !== 'completed' ||
    session.worker_role !== plan.actor.role || session.worker_ref !== plan.actor.ref) return false
  if (proof.inputBatchId && (payload.input_progress_batch_id !== proof.inputBatchId || payload.input_wip_source_kind !== proof.inputKind)) return false
  if (proof.links.length) {
    if (!Array.isArray(payload.input_lineage)) return false
    const after = payload.input_lineage.filter(isRecord)
    if (proof.links.some(link => !after.some(value => value.input_batch_id === link.input_batch_id && value.source_kind === link.source_kind && value.stage_node_id === link.stage_node_id && value.status === 'processed'))) return false
  }
  if (payload.description !== str(plan.body.description)) return false
  return true
}
function validBatch(batch: Row, plan: ProductionCompletionCommand, sessionId: string, expected: Row): boolean {
  if (!str(batch.batch_id) || !str(batch.qr_payload) || batch.order_id !== plan.orderId || batch.apparatus !== plan.apparatusId || batch.session_id !== sessionId || batch.action !== 'complete' || batch.status !== 'completed' ||
    obj(batch.payload_json).stage_node_id !== plan.stageNodeId || batch.worker_role !== plan.actor.role || batch.worker_ref !== plan.actor.ref || batch.revision !== 1 || batch.wip_status !== 'waiting' || batch.uom !== 'm' ||
    !measureMatches(batch.produced_qty, expected.finished_goods_meter ?? expected.produced_qty)) return false
  for (const field of ['finished_goods_meter', 'finished_goods_kg', 'bobina_kg', 'diameter']) {
    const requested = field === 'finished_goods_kg' ? expected.finished_goods_kg ?? expected.gross_qty : expected[field]
    if (requested !== undefined && requested !== null && requested !== 0 && !measureMatches(batch[field], requested)) return false
    if (field === 'bobina_kg' && plan.keyed && !Object.hasOwn(expected, field) && batch[field] != null && batch[field] !== 0) return false
  }
  return true
}
/** A saved business receipt is independent of its label/printer outcome. */
export function validateProductionCompletionReceipt(response: unknown, plan: ProductionCompletionCommand, proof: ProductionCompletionProof, minimumRevision = plan.rev, immutableRead = false): ProductionCompletionResult | null {
  const result = obj(response)
  if (result.ok !== true || !immutableRead && (result.epoch !== plan.epoch || !integer(result.rev) || result.rev < minimumRevision)) return null
  const prints = Array.isArray(result.prints) ? result.prints.filter(isRecord) : []
  if (result.completion_request !== undefined && result.completion_request !== null) {
    const request = obj(result.completion_request)
    if (plan.keyed || !plan.expectedApproval || !str(request.event_id) || request.order_id !== plan.orderId || request.apparatus !== plan.apparatusId || request.worker_role !== plan.actor.role || request.worker_ref !== plan.actor.ref ||
      request.description !== str(plan.body.description) || request.decision_required !== true || !['completion_request', 'zero_metric_completion_request'].includes(str(request.notice_kind)) ||
      !Array.isArray(request.zero_metric_codes) || stable(request.zero_metric_codes) !== stable(['total_waste']) || result.session !== null || result.progress_event !== null || result.progress_batch !== null || result.print !== null ||
      result.progress_batches !== undefined && (!Array.isArray(result.progress_batches) || result.progress_batches.length !== 0) || ['completed', 'cancelled'].includes(str(obj(result.states)[plan.orderId]))) return null
    return { kind: 'approval_requested', message: 'Tugatish uchun tasdiqlash so‘rovi yuborildi. Ishlab chiqarish natijasi hali tugallangan deb qayd etilmadi.', batches: [], remainders: [], prints: [] }
  }
  if (plan.expectedApproval) return null
  const session = obj(result.session), payload = obj(session.payload_json)
  if (!validSession(session, plan, proof) || !Array.isArray(result.progress_batches)) return null
  const batches = result.progress_batches.filter(isRecord)
  if (batches.length !== result.progress_batches.length || new Set(batches.map(batch => batch.batch_id)).size !== batches.length || new Set(batches.map(batch => batch.qr_payload)).size !== batches.length) return null
  if (!plan.keyed && (batches.length ? stable(result.progress_batch) !== stable(batches[0]) : result.progress_batch !== null)) return null
  const state = str(obj(result.states)[plan.orderId])
  if (!plan.keyed && !['pending', 'completed'].includes(state)) return null
  if (!plan.keyed) {
    const event = obj(result.progress_event)
    if (!str(event.event_id) || event.session_id !== session.session_id || event.order_id !== plan.orderId || event.apparatus !== plan.apparatusId || event.action !== 'complete' || event.worker_role !== plan.actor.role || event.worker_ref !== plan.actor.ref) return null
  }
  let remainders: Row[] = []
  if (plan.keyed) {
    if (result.request_id !== plan.body.request_id || result.action !== 'complete' || !Array.isArray(result.remainders)) return null
    remainders = result.remainders.filter(isRecord)
    const layers = plan.body.layer_remainders as Row[]
    if (remainders.length !== result.remainders.length || remainders.length !== layers.length || new Set(remainders.map(value => value.operation_id)).size !== remainders.length || new Set(remainders.filter(value => str(value.qr_payload)).map(value => value.qr_payload)).size !== remainders.filter(value => str(value.qr_payload)).length || remainders.some(value => str(value.qr_payload) && batches.some(batch => batch.qr_payload === value.qr_payload)) || new Set(remainders.map(value => `${value.source_kind}:${value.source_id}`)).size !== remainders.length ||
      layers.some(layer => !remainders.some(value => value.order_id === plan.orderId && value.apparatus === plan.apparatusId && value.session_id === session.session_id && value.source_kind === layer.source_kind && value.source_id === layer.source_id && measureMatches(value.remaining_net_kg, layer.remaining_net_kg) && str(value.operation_id) && (Number(layer.remaining_net_kg) > 0 ? Boolean(str(value.qr_payload)) : !str(value.qr_payload)) && obj(value.recorded_by).role === plan.actor.role && obj(value.recorded_by).ref === plan.actor.ref))) return null
    for (const field of ['lamination_print_leftover_rolls', 'lamination_film_leftover_rolls', 'total_waste']) if (payload[field] !== plan.body[field]) return null
  }
  if (plan.policy.closingBatchId) {
    if (batches.length || result.progress_batch !== null || payload.complete_without_output !== true || payload.closing_output_batch_id !== plan.policy.closingBatchId || payload.total_waste !== plan.body.total_waste) return null
  } else if (plan.policy.operation === 'cut') {
    const frames = plan.body.rezka_frames as Row[], saved = plan.context.cut!.saved
    const expected = frames.flatMap((frame, index) => saved.some(slot => slot.frame_index === index + 1) || str(frame.issue_note) ? [] : [{ frame, index }])
    if (batches.length !== expected.length || new Set(batches.map(batch => obj(batch.payload_json).rezka_frame_index)).size !== batches.length || expected.some(({ frame, index }) => !batches.some(batch => obj(batch.payload_json).rezka_frame_index === index + 1 && obj(batch.payload_json).rezka_frame_count === plan.context.cut!.counts.length && validBatch(batch, plan, str(session.session_id), frame)))) return null
    const recordedIds = obj(result.progress_event).payload_json
    if (payload.rezka_output_cycle !== obj(result.progress_event).event_id || !Array.isArray(payload.rezka_output_report) || payload.rezka_output_report.length !== 0) return null
    if (saved.some(slot => str(slot.batch_id) && (!Array.isArray(obj(recordedIds).rezka_previously_recorded_batches) || !(obj(recordedIds).rezka_previously_recorded_batches as unknown[]).includes(slot.batch_id)))) return null
    const issues = Array.isArray(payload.rezka_frame_issues) ? payload.rezka_frame_issues.filter(isRecord) : []
    if (frames.some((frame, index) => str(frame.issue_note) && !issues.some(issue => issue.frame_index === index + 1 && issue.issue_note === str(frame.issue_note)))) return null
  } else if (batches.length !== 1 || !validBatch(batches[0], plan, str(session.session_id), plan.body)) return null
  if (plan.policy.operation === 'print') {
    if (!measureMatches(payload.total_waste, plan.body.total_waste) || plan.returnInk !== undefined && (plan.returnInk > 0 || plan.policy.closingBatchId) && !measureMatches(payload.return_ink_kg, plan.returnInk)) return null
  } else if (plan.policy.operation === 'cut' && plan.body.total_waste !== undefined && payload.total_waste !== plan.body.total_waste && obj(result.progress_event).total_waste !== plan.body.total_waste) return null
  if (proof.inputBatchId && batches.some(batch => batch.parent_batch_id !== proof.inputBatchId)) return null
  const partial = state === 'pending'
  return { kind: partial ? 'partial' : 'completed', message: partial ? 'Joriy rulon hisoboti saqlandi. Oldingi bosqichdan qolgan WIP uchun ish yana navbatga qaytishi mumkin.' : 'Bosqichning tugatish hisoboti serverda saqlandi. Buyurtmaning umumiy holati alohida yangilanadi.', batches, remainders, prints }
}

export interface ProductionCompletionSavedDraft { policy: ProductionCompletionPolicy; context: CompletionContext; draft: ProductionCompletionDraft }
function credentialFree(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['token', 'authorization', 'password', 'accesstoken', 'refreshtoken', 'accesscode', 'logincode'].includes(key.replace(/[_-]/g, '').toLowerCase())) return blocked('Qoralamada kirish ma’lumotlari saqlanmaydi.')
    credentialFree(child)
  }
}
export class ProductionCompletionAttemptRegistry {
  private scope = ''
  private revision = 0
  private drafts = new Map<string, ProductionCompletionSavedDraft>()
  private listeners = new Set<() => void>()
  activate(scope: string): void { productionOperationLedger.activate(scope); if (this.scope !== scope) { this.scope = scope; this.drafts.clear(); this.revision++ } }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); const remove = productionOperationLedger.subscribe(listener); return () => { this.listeners.delete(listener); remove() } }
  getRevision = (): number => this.revision + productionOperationLedger.getRevision()
  private publish() { this.revision++; for (const listener of this.listeners) listener() }
  get(scope: string, orderId: string): ProductionOperation<ProductionCompletionCommand, ProductionCompletionProof> | null { return productionOperationLedger.get(scope, orderId, 'completion') }
  private draftKey(orderId: string, policy: ProductionCompletionPolicy): string { return stable([orderId, policy.stageNodeId, policy.apparatusId]) }
  getDraft(scope: string, orderId: string, policy: ProductionCompletionPolicy): ProductionCompletionSavedDraft | null {
    const draft = scope === this.scope ? this.drafts.get(this.draftKey(orderId, policy)) : undefined
    return draft ? structuredClone(draft) : null
  }
  saveDraft(scope: string, orderId: string, value: ProductionCompletionSavedDraft): void {
    if (scope !== this.scope || productionOperationLedger.get(scope, orderId)) return
    credentialFree(value)
    this.drafts.set(this.draftKey(orderId, value.policy), structuredClone(value)); this.publish()
  }
  clearDraft(scope: string, orderId: string, policy: ProductionCompletionPolicy): void { if (scope === this.scope && !productionOperationLedger.get(scope, orderId) && this.drafts.delete(this.draftKey(orderId, policy))) this.publish() }
  begin(scope: string, plan: ProductionCompletionCommand, recovery = false): ProductionOperationLease { return productionOperationLedger.begin(scope, { channel: 'completion', orderId: plan.orderId, plan, proof: productionCompletionProof(plan) }, recovery) }
  dispatched = (lease: ProductionOperationLease): boolean => productionOperationLedger.dispatched(lease)
  finish = (lease: ProductionOperationLease, outcome: { confirmed: true } | { error: string; uncertain: boolean }): void => productionOperationLedger.finish(lease, outcome)
  interrupt = (lease: ProductionOperationLease): void => productionOperationLedger.interrupt(lease)
}
export const productionCompletionAttempts = new ProductionCompletionAttemptRegistry()
export function productionCompletionDraftMatches(saved: ProductionCompletionSavedDraft, policy: ProductionCompletionPolicy, context: CompletionContext): boolean {
  return saved.policy.apparatusId === policy.apparatusId && saved.policy.stageNodeId === policy.stageNodeId && saved.policy.sourceRevision === policy.sourceRevision &&
    saved.policy.fullReport === policy.fullReport && saved.policy.closingBatchId === policy.closingBatchId && contextWitness(saved.context) === contextWitness(context)
}
function assertActor(session: Session | null, plan: ProductionCompletionCommand) {
  if (!productionCanManageQueue(session) || str(session?.profile.role) !== plan.actor.role || str(session?.profile.ref) !== plan.actor.ref) throw new ProductionCompletionError('forbidden', 'Hisobot aynan shu operator va sessiya ruxsatlari bilan bajarilishi kerak.')
  const operation = productionOperationLedger.get<ProductionCompletionCommand>(plan.authScope, plan.orderId)
  if (operation && (operation.channel !== 'completion' || stable(operation.plan) !== stable(plan))) return blocked('Shu buyurtmada boshqa ishlab chiqarish amali bor. Avval uning natijasini aniqlang.')
}
async function snapshotAfter(client: ApiClient, plan: ProductionCompletionCommand, minimumRevision: number, signal: AbortSignal, isCurrent: () => boolean): Promise<ProductionSnapshot | undefined> {
  let snapshot: ProductionSnapshot | undefined
  try { snapshot = await client.productionSnapshot(signal) } catch { /* The validated business receipt remains authoritative. */ }
  current(signal, isCurrent)
  return snapshot && snapshot.epoch === plan.epoch && snapshot.scope === plan.scope && snapshot.rev >= minimumRevision ? snapshot : undefined
}
function observedResult(result: ProductionCompletionResult, plan: ProductionCompletionCommand, snapshot: ProductionSnapshot | undefined): ProductionCompletionResult {
  if (result.kind === 'completed' && snapshot?.queue_states[plan.apparatusId]?.[plan.orderId] === 'pending') return { ...result, kind: 'partial', snapshot, message: 'Hisobot saqlandi. Joriy server navbatida shu bosqich qolgan WIP uchun yana kutilmoqda.' }
  return { ...result, snapshot }
}
async function postCompletion(client: ApiClient, plan: ProductionCompletionCommand, proof: ProductionCompletionProof, minimumRevision: number, signal: AbortSignal, isCurrent: () => boolean, onDispatch?: () => boolean | void): Promise<ProductionCompletionResult> {
  current(signal, isCurrent)
  if (onDispatch?.() === false) return blocked('Hisobotni yuborish bandligi tugagan. Yangi so‘rov yuborilmadi.')
  current(signal, isCurrent)
  let response: unknown, failure: unknown
  try { response = await client.request(plan.path, 'POST', { body: plan.body, signal }) } catch (error) { failure = error }
  current(signal, isCurrent)
  // Fallback material settlement can return 400 after the business commit.
  if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 400) throw failure
  const result = failure ? null : validateProductionCompletionReceipt(response, plan, proof, minimumRevision)
  const responseRevision = integer(obj(response).rev) ? Number(obj(response).rev) : minimumRevision + 1
  const snapshot = await snapshotAfter(client, plan, Math.max(minimumRevision + 1, responseRevision), signal, isCurrent)
  if (!result) throw new ProductionCompletionError('uncertain', plan.keyed ? 'Hisobot javobi tasdiqlanmadi. Aynan shu request_id saqlandi; native saqlangan natijani tiklash mumkin.' : 'Hisobot javobi tasdiqlanmadi. Native amal buyruq kalitini qo‘llamaydi; u avtomatik qayta yuborilmadi. Shu buyurtma uchun yangi hisobot yopiq.', snapshot)
  return observedResult(result, plan, snapshot)
}
export async function executeProductionCompletion(client: ApiClient, session: Session | null, plan: ProductionCompletionCommand, signal: AbortSignal, isCurrent: () => boolean = () => true, onDispatch?: () => boolean | void): Promise<ProductionCompletionResult> {
  current(signal, isCurrent); assertActor(session, plan)
  const fresh = await client.productionSnapshot(signal); current(signal, isCurrent)
  if (fresh.epoch !== plan.epoch || fresh.scope !== plan.scope || fresh.rev < plan.rev || fingerprint(fresh, plan.orderId, plan.apparatusId) !== plan.fingerprint) throw new ProductionCompletionError('conflict', 'Buyurtma, bosqich yoki navbat o‘zgargan. Hisobot yuborilmadi.', fresh)
  const metadata = await client.detail('apparatus', { apparatus_id: plan.apparatusId }, signal); current(signal, isCurrent)
  const policy = productionCompletionPolicies(fresh, plan.orderId, session, [metadata]).find(value => value.apparatusId === plan.apparatusId)
  if (!policy?.allowed || policy.sourceRevision !== plan.sourceRevision || policy.operation !== plan.policy.operation) throw new ProductionCompletionError('conflict', 'Uskuna konfiguratsiyasi yoki server ruxsatlari o‘zgargan.', fresh)
  const proof = await checkProductionCompletion(client, plan, signal, isCurrent)
  const latest = await client.productionSnapshot(signal); current(signal, isCurrent); assertActor(session, plan)
  if (latest.epoch !== plan.epoch || latest.scope !== plan.scope || latest.rev < fresh.rev || fingerprint(latest, plan.orderId, plan.apparatusId) !== plan.fingerprint) throw new ProductionCompletionError('conflict', 'Hisobot tekshiruvi paytida bosqich yoki kirish ma’lumotlari o‘zgargan. So‘rov yuborilmadi.', latest)
  return postCompletion(client, plan, proof, latest.rev, signal, isCurrent, onDispatch)
}
/** Explicit recovery uses the actor-scoped immutable laminate receipt, then the exact original keyed body if requested. */
export async function recoverProductionCompletion(client: ApiClient, session: Session | null, plan: ProductionCompletionCommand, signal: AbortSignal, isCurrent: () => boolean = () => true, retryExact = false, onDispatch?: () => boolean | void): Promise<ProductionCompletionResult | null> {
  current(signal, isCurrent); assertActor(session, plan)
  if (!plan.keyed) return blocked('Native oddiy tugatish amali qayta yuborilmaydi.')
  const payload = obj(await client.get(`${base}/laminatsiya-astatka`, { apparatus: plan.apparatusId, order_id: plan.orderId, request_id: str(plan.body.request_id) }, signal)); current(signal, isCurrent)
  if (payload.ok !== true || !Object.hasOwn(payload, 'request_result')) return invalid('Native atomik hisobot natijasi to‘liq olinmadi.')
  if (payload.request_result !== null) {
    const result = validateProductionCompletionReceipt(payload.request_result, plan, productionCompletionProof(plan), plan.rev, true)
    if (!result) throw new ProductionCompletionError('uncertain', 'Saqlangan request_id boshqa sessiya, qatlam yoki miqdorni qaytardi. Avvalgi hisobot saqlanmoqda.')
    return observedResult(result, plan, await snapshotAfter(client, plan, plan.rev + 1, signal, isCurrent))
  }
  if (!retryExact) return null
  const fresh = await client.productionSnapshot(signal); current(signal, isCurrent); assertActor(session, plan)
  if (fresh.epoch !== plan.epoch || fresh.scope !== plan.scope) throw new ProductionCompletionError('conflict', 'Server doirasi o‘zgargan. Saqlangan hisobot qayta yuborilmadi.', fresh)
  return postCompletion(client, plan, productionCompletionProof(plan), fresh.rev, signal, isCurrent, onDispatch)
}
