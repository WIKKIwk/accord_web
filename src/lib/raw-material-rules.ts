import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { Row, Session } from './api-types'
import { hasCapability, meetsRequirement } from './permissions'
import { isCanonicalApparatusId } from './production-map'

const base = '/v1/mobile/admin', path = `${base}/raw-material-rules`, hashPattern = /^[a-f0-9]{64}$/
export const RAW_MATERIAL_RULE_API_LIMITATIONS = [
  'GET returns canonical material projections; PUT patches one existing apparatus with native expected_revision and Idempotency-Key. It never replaces a collection.',
  'There is no rule DELETE, history or command-receipt lookup. Removing a requirement sets material mode to not_required; apparatus identity and tooling remain intact.',
  'Canonical command keys do not return a prior receipt on replay. Once committed, the old expected_revision conflicts. Interrupted writes are reconciled through fresh revision and policy facts.',
  'Apparatus revision CAS is native and atomic. ERP item-group reads are separate; there is no group-catalog revision precondition.',
] as const
export type MaterialRuleMode = 'not_required' | 'all_required' | 'requirement_sets'
export interface MaterialRequirementSet { requirement_id: string; item_group_ids: string[]; minimum_required_count: number }
export type MaterialRulePolicy = { mode: 'not_required'; item_group_ids?: string[] } | { mode: 'all_required'; item_group_ids: string[] } | { mode: 'requirement_sets'; sets: MaterialRequirementSet[] }
export type MaterialRuleTooling = { mode: 'not_required' } | { mode: 'qolip_scan_required'; tooling_class_id: string }
export interface MaterialRuleProjection { apparatus_id: string; source_revision: number; source_aasx_sha256: string; policy: MaterialRulePolicy; tooling: MaterialRuleTooling }
export interface MaterialRuleSnapshot { rule: MaterialRuleProjection; apparatus: Row; name: string; operation: string; active: boolean }
export interface MaterialRuleDraft { mode: MaterialRuleMode; groupIds: string[]; sets: { id: string; groupIds: string[]; minimum: string }[] }
export interface MaterialRuleCommand { key: string; baseline: MaterialRuleSnapshot; body: { apparatus_id: string; expected_revision: number; material: MaterialRulePolicy; tooling: MaterialRuleTooling } }
export interface MaterialRuleResult { rule: MaterialRuleProjection; snapshot: MaterialRuleSnapshot; observed: boolean }
const str = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const stable = (value: unknown): string => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))])) : value ?? null)
const same = (left: unknown, right: unknown) => stable(left) === stable(right)
const withoutSource = (value: Row) => Object.fromEntries(Object.entries(value).filter(([key]) => !['source_revision', 'source_aasx_sha256'].includes(key)))
function invalid(message = 'Canonical xomashyo qoidasi to‘liq va mos holda olinmadi.'): never { throw new ApiError(502, 'invalid_response', message) }
function reference(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || Array.from(value).length > 256 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) return invalid()
  return value
}
const ordinal = (a: string, b: string) => { const x = Array.from(a), y = Array.from(b); for (let i = 0; i < Math.min(x.length, y.length); i++) { const diff = x[i].codePointAt(0)! - y[i].codePointAt(0)!; if (diff) return diff } return x.length - y.length }
function references(value: unknown, empty = false): string[] {
  if (!Array.isArray(value)) return invalid()
  const result = value.map(reference)
  if ((!empty && !result.length) || result.some((entry, index) => index > 0 && ordinal(result[index - 1], entry) >= 0)) return invalid()
  return result
}
function revision(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid(); return value }
function source(value: Row) {
  if (typeof value.apparatus_id !== 'string' || value.apparatus_id !== value.apparatus_id.trim() || !isCanonicalApparatusId(value.apparatus_id) || typeof value.source_aasx_sha256 !== 'string' || !hashPattern.test(value.source_aasx_sha256)) return invalid()
  return { apparatus_id: str(value.apparatus_id), source_revision: revision(value.source_revision), source_aasx_sha256: value.source_aasx_sha256 }
}
export function rawMaterialRulePermissions(session: Session | null | undefined) {
  return { manage: hasCapability(session, 'raw_material.rule.manage'), apparatus: meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'] }), groups: meetsRequirement(session, { any: ['catalog.item_group.read', 'gscale.catalog.read'] }) }
}
export function parseMaterialRulePolicy(value: unknown): MaterialRulePolicy {
  const policy = record(value), mode = policy.mode
  if (Object.keys(policy).some(key => !(mode === 'requirement_sets' ? ['mode', 'sets'] : ['mode', 'item_group_ids']).includes(key))) return invalid()
  if (mode === 'not_required') { const ids = policy.item_group_ids === undefined ? [] : references(policy.item_group_ids, true); return ids.length ? { mode, item_group_ids: ids } : { mode } }
  if (mode === 'all_required') return { mode, item_group_ids: references(policy.item_group_ids) }
  if (mode !== 'requirement_sets' || !Array.isArray(policy.sets) || !policy.sets.length) return invalid()
  const sets = policy.sets.map(value => {
    const set = record(value), ids = references(set.item_group_ids), minimum = set.minimum_required_count
    if (Object.keys(set).some(key => !['requirement_id', 'item_group_ids', 'minimum_required_count'].includes(key)) || !Number.isSafeInteger(minimum) || Number(minimum) < 1 || Number(minimum) > Math.min(65535, ids.length)) return invalid()
    return { requirement_id: reference(set.requirement_id), item_group_ids: ids, minimum_required_count: Number(minimum) }
  })
  if (sets.some((set, index) => index > 0 && ordinal(sets[index - 1].requirement_id, set.requirement_id) >= 0)) return invalid()
  return { mode, sets }
}
function parseTooling(value: unknown): MaterialRuleTooling {
  const tooling = record(value)
  if (tooling.mode === 'not_required' && Object.keys(tooling).length === 1) return { mode: 'not_required' }
  if (tooling.mode === 'qolip_scan_required' && Object.keys(tooling).every(key => ['mode', 'tooling_class_id'].includes(key))) return { mode: 'qolip_scan_required', tooling_class_id: reference(tooling.tooling_class_id) }
  return invalid()
}
export function parseMaterialRuleProjection(value: unknown): MaterialRuleProjection { const row = record(value); return { ...source(row), policy: parseMaterialRulePolicy(row.policy), tooling: parseTooling(row.tooling) } }
const operationTechnologies: Record<string, readonly string[]> = { print: ['rotogravure', 'flexographic'], laminate: ['adhesive_lamination', 'extrusion_lamination'], cut: ['slitting'], package: ['bag_making'], glue: ['cold_glue'] }
function compatibleExecution(profile: Row, capabilities: Row): boolean {
  const operation = str(profile.operation), technology = str(profile.technology), colors = profile.color_station_count
  const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
  const widths = [profile.min_web_width_mm, profile.max_web_width_mm]
  return Boolean(operationTechnologies[operation]?.includes(technology) && Number(capabilities[operation]) > 0
    && Object.entries(capabilities).every(([code, level]) => ['print', 'laminate', 'cut', 'package', 'glue', 'tooling', 'virtual_task', 'training'].includes(code) && integer(level, 100))
    && (technology === 'rotogravure' ? integer(colors, 32) : technology === 'flexographic' ? colors === null || integer(colors, 32) : colors === null)
    && widths.every(value => value === undefined || integer(value, 100_000))
    && (widths[0] === undefined || widths[1] === undefined || Number(widths[0]) <= Number(widths[1]))
    && (profile.virtual_tasks === 'disabled' || profile.virtual_tasks === 'input_bridge' && Number(capabilities.virtual_task) > 0)
    && typeof profile.capability_compatible_reroute === 'boolean')
}
function parseSnapshot(rule: MaterialRuleProjection, value: unknown): MaterialRuleSnapshot {
  const row = record(value), apparatus = isRecord(row.runtime_projection) ? row.runtime_projection : row, identity = source(apparatus), lifecycle = record(apparatus.lifecycle), display = record(apparatus.display), execution = record(apparatus.execution_profile), capabilities = record(apparatus.capabilities)
  if (!same(identity, { apparatus_id: rule.apparatus_id, source_revision: rule.source_revision, source_aasx_sha256: rule.source_aasx_sha256 }) || !str(display.display_name) || !['active', 'retired'].includes(str(lifecycle.state)) || !compatibleExecution(execution, capabilities) || rule.tooling.mode === 'qolip_scan_required' && !(Number(capabilities.tooling) > 0)) return invalid('Qoidalar va apparat holati turli yoki noto‘g‘ri canonical revisionlardan kelgan. Yangilang.')
  return { rule, apparatus: structuredClone(apparatus), name: str(display.display_name), operation: str(execution.operation), active: lifecycle.state === 'active' }
}
export async function rawMaterialRules(client: ApiClient, signal?: AbortSignal): Promise<MaterialRuleProjection[]> {
  const result = rows(await client.get(path, undefined, signal)).map(parseMaterialRuleProjection)
  if (new Set(result.map(row => row.apparatus_id)).size !== result.length) return invalid()
  return result
}
export async function rawMaterialRuleSnapshot(client: ApiClient, id: string, signal?: AbortSignal): Promise<MaterialRuleSnapshot> {
  if (!isCanonicalApparatusId(id)) throw new Error('Canonical apparatni tanlang.')
  const [rules, apparatus] = await Promise.all([rawMaterialRules(client, signal), client.get(`${base}/apparatus/${encodeURIComponent(id)}`, undefined, signal)])
  const rule = rules.find(row => row.apparatus_id === id)
  if (!rule) throw new ApiError(409, 'raw_material_rule_missing', 'Tanlangan apparatning canonical qoidasi joriy ro‘yxatda tasdiqlanmadi.')
  return parseSnapshot(rule, apparatus)
}
/** Mobile offers direct children of Homashyo; names are native reference IDs, not titles joined to apparatus. */
export function rawMaterialGroupOptions(value: readonly Row[]): string[] {
  const result = value.filter(row => str(row.parent_item_group).toLowerCase() === 'homashyo').map(row => reference(str(row.item_group_name) || str(row.name)))
  return [...new Set(result)].sort(ordinal)
}
/** Validate inside the query boundary so malformed catalog references become recoverable query errors. */
export async function rawMaterialRuleGroups(client: ApiClient, signal?: AbortSignal): Promise<string[]> {
  return rawMaterialGroupOptions((await client.listSnapshot('item-groups', {}, signal)).items)
}
export function materialPolicyGroups(policy: MaterialRulePolicy): string[] { return [...new Set(policy.mode === 'requirement_sets' ? policy.sets.flatMap(set => set.item_group_ids) : policy.item_group_ids ?? [])].sort(ordinal) }
export function materialRuleDraft(rule: MaterialRuleProjection): MaterialRuleDraft {
  return { mode: rule.policy.mode, groupIds: materialPolicyGroups(rule.policy), sets: rule.policy.mode === 'requirement_sets' ? rule.policy.sets.map(set => ({ id: set.requirement_id, groupIds: [...set.item_group_ids], minimum: String(set.minimum_required_count) })) : [] }
}
export function materialRuleCommand(snapshot: MaterialRuleSnapshot, draft: MaterialRuleDraft, session: Session | null, groupOptions: readonly string[] = [], key: string = `web-material-policy:${crypto.randomUUID()}`): MaterialRuleCommand {
  if (!rawMaterialRulePermissions(session).manage) throw new ApiError(403, 'forbidden')
  if (!snapshot.active) throw new Error('Foydalanishdan chiqarilgan apparat qoidasi o‘zgartirilmaydi.')
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw new Error('Canonical amal identifikatori noto‘g‘ri.')
  const permitted = new Set([...groupOptions, ...materialPolicyGroups(snapshot.rule.policy)])
  const ids = (values: string[]) => {
    const result = values.map(value => reference(value.trim())).sort(ordinal)
    if (new Set(result).size !== result.length || result.some(value => !permitted.has(value))) throw new Error('Yangi guruhlarni faqat serverdagi Homashyo ro‘yxatidan tanlang.')
    return result
  }
  let material: MaterialRulePolicy
  try {
    const input = draft.mode === 'requirement_sets' ? { mode: draft.mode, sets: draft.sets.map(set => ({ requirement_id: set.id.trim(), item_group_ids: ids(set.groupIds), minimum_required_count: set.minimum.trim() ? Number(set.minimum) : NaN })).sort((a, b) => ordinal(a.requirement_id, b.requirement_id)) } : { mode: draft.mode, item_group_ids: ids(draft.groupIds) }
    material = parseMaterialRulePolicy(input)
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'invalid_response') throw new Error(draft.mode === 'requirement_sets' ? 'Har bir talabga yagona identifikator (1–256 belgi), material guruhlari va guruhlar sonidan oshmaydigan musbat butun minimum kiriting.' : 'Material talabi uchun kamida bitta mos guruhni tanlang; guruhlar takrorlanmasin.')
    throw caught
  }
  if (same(material, snapshot.rule.policy)) throw new Error('Qoidaga o‘zgarish kiritilmagan.')
  return { key, baseline: structuredClone(snapshot), body: { apparatus_id: snapshot.rule.apparatus_id, expected_revision: snapshot.rule.source_revision, material, tooling: structuredClone(snapshot.rule.tooling) } }
}
export function parseMaterialRuleReceipt(value: unknown, command: MaterialRuleCommand, session: Session | null): MaterialRuleResult {
  const committed = record(value), canonical = record(committed.revision), metadata = record(canonical.revision_metadata), runtime = record(committed.runtime_projection), policies = record(canonical.policies), hash = committed.aasx_sha256
  const actor = str(session?.profile.ref) || str(session?.profile.phone)
  const capabilityRows = Array.isArray(canonical.capabilities) ? canonical.capabilities.map(record) : []
  const profileFields = ['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'execution_profile', 'placement', 'training', 'lifecycle']
  if (canonical.schema_version !== 1 || canonical.apparatus_id !== command.body.apparatus_id || metadata.revision !== command.body.expected_revision + 1 || metadata.command_id !== `apparatus-command:${command.key}` || metadata.source !== 'admin' || !Number.isSafeInteger(metadata.committed_at_unix_ms) || Number(metadata.committed_at_unix_ms) < 1 || !str(metadata.actor_id).startsWith('principal:') || str(metadata.actor_id).length <= 'principal:'.length || actor && metadata.actor_id !== `principal:${actor}` || typeof hash !== 'string' || !hashPattern.test(hash) || hash === command.baseline.rule.source_aasx_sha256 || runtime.source_revision !== metadata.revision || runtime.source_aasx_sha256 !== hash || !['strict_sequence', 'free_pick'].includes(str(policies.queue)) || !same(withoutSource(runtime), withoutSource(command.baseline.apparatus)) || profileFields.some(key => !same(canonical[key], runtime[key])) || !capabilityRows.length || new Set(capabilityRows.map(row => row.code)).size !== capabilityRows.length || !same(Object.fromEntries(capabilityRows.map(row => [String(row.code), row.level])), runtime.capabilities)) return invalid('Server tanlangan apparatning canonical amal, revision va saqlangan profilini tasdiqlamadi.')
  const rule = parseMaterialRuleProjection({ apparatus_id: canonical.apparatus_id, source_revision: metadata.revision, source_aasx_sha256: hash, policy: policies.material, tooling: policies.tooling })
  if (!same(rule.policy, command.body.material) || !same(rule.tooling, command.body.tooling)) return invalid('Saqlangan material yoki saqlab qolinishi kerak bo‘lgan tooling siyosati mos kelmadi.')
  const snapshot = parseSnapshot(rule, runtime)
  return { rule, snapshot, observed: false }
}
export type MaterialRuleReconciliation = { state: 'confirmed' | 'superseded' | 'unchanged'; current: MaterialRuleSnapshot }
export async function reconcileMaterialRuleCommand(client: ApiClient, command: MaterialRuleCommand, signal?: AbortSignal): Promise<MaterialRuleReconciliation> {
  const current = await rawMaterialRuleSnapshot(client, command.body.apparatus_id, signal), revision = current.rule.source_revision
  if (revision < command.body.expected_revision || revision === command.body.expected_revision && !same(current.rule, command.baseline.rule)) return invalid('Joriy revision saqlangan nusxaga zid. Amal holati aniqlanmadi.')
  if (revision === command.body.expected_revision) return { state: 'unchanged', current }
  // Native CAS makes a late request using the old revision unable to overwrite this observed revision.
  return { state: same(current.rule.policy, command.body.material) && same(current.rule.tooling, command.body.tooling) ? 'confirmed' : 'superseded', current }
}
export class MaterialRuleMutationError extends Error {
  readonly uncertain: boolean
  constructor(message: string, uncertain: boolean) { super(message); this.name = 'MaterialRuleMutationError'; this.uncertain = uncertain }
}
export async function saveMaterialRuleCommand(client: ApiClient, session: Session | null, command: MaterialRuleCommand, signal?: AbortSignal, onDispatch?: () => void): Promise<MaterialRuleResult> {
  if (!rawMaterialRulePermissions(session).manage) throw new ApiError(403, 'forbidden')
  let sent = false, received = false
  try {
    const current = await rawMaterialRuleSnapshot(client, command.body.apparatus_id, signal)
    if (!same(current.rule, command.baseline.rule) || !same(current.apparatus, command.baseline.apparatus) || !current.active) throw new ApiError(409, 'apparatus_revision_conflict', 'Apparat yoki qoidaning revision’i o‘zgargan. Joriy nusxani qayta ko‘rib chiqing.')
    const options = rawMaterialRulePermissions(session).groups ? await rawMaterialRuleGroups(client, signal) : []
    const checked = materialRuleCommand(current, materialRuleDraft({ ...current.rule, policy: command.body.material }), session, options, command.key)
    if (!same(checked.body, command.body)) throw new Error('Saqlangan so‘rov joriy canonical tanlovga mos emas.')
    if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
    sent = true; onDispatch?.()
    const response = await client.request(path, 'PUT', { body: command.body, headers: { 'Idempotency-Key': command.key }, signal })
    received = true
    return parseMaterialRuleReceipt(response, command, session)
  } catch (error) {
    const unknown = sent && (received || !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response')
    const codes: Record<string, string> = { apparatus_revision_conflict: 'Apparat revision’i o‘zgargan. Joriy nusxani yuklab, qoidani qayta ko‘rib chiqing.', apparatus_retired: 'Apparat foydalanishdan chiqarilgan; qoidasi o‘zgartirilmaydi.', apparatus_revision_invalid: 'Material talablari canonical apparat qoidalariga mos kelmadi.', apparatus_already_exists: 'Bu canonical amal identifikatori oldin ishlatilgan. Avvalgi natijani tekshiring.' }
    throw new MaterialRuleMutationError(unknown ? 'Saqlash natijasi aniqlanmagan. Avvalgi so‘rov saqlanmoqda; yangi amal boshlamang.' : error instanceof ApiError ? codes[error.code] ?? error.message : error instanceof Error ? error.message : 'Qoidani saqlash bajarilmadi.', unknown)
  }
}

export interface MaterialRuleEditor { snapshot: MaterialRuleSnapshot; draft: MaterialRuleDraft; phase: 'editing' | 'pending' | 'uncertain' | 'confirmed' | 'conflict'; command?: MaterialRuleCommand; result?: MaterialRuleResult; error?: string; serial: number; dispatched: boolean }
export interface MaterialRuleLease { scope: string; generation: number; id: string; serial: number; wasUncertain: boolean }
/** No credentials or storage: drafts and sent CAS requests survive local dialog/page closure. */
export class MaterialRuleDraftRegistry {
  private scope = ''; private generation = 0; private serial = 0; private revision = 0; private selected = ''
  private entries = new Map<string, MaterialRuleEditor>(); private listeners = new Set<() => void>()
  activate(scope: string) { if (scope !== this.scope) { this.scope = scope; this.generation++; this.entries.clear(); this.selected = ''; this.revision++ } }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  getRevision = () => this.revision
  private publish() { this.revision++; for (const callback of this.listeners) callback() }
  selection(scope: string): string { return scope === this.scope ? this.selected : '' }
  choose(scope: string, id: string) { if (scope !== this.scope || !isCanonicalApparatusId(id) || [...this.entries.values()].some(row => ['pending', 'uncertain'].includes(row.phase))) throw new Error('Avvalgi amal hal qilinmaguncha boshqa apparat tanlanmaydi.'); this.selected = id; this.publish() }
  get(scope: string): MaterialRuleEditor | null { if (scope !== this.scope) return null; const pending = [...this.entries.values()].find(row => ['pending', 'uncertain'].includes(row.phase)), value = pending ?? this.entries.get(this.selected); return value ? structuredClone(value) : null }
  select(scope: string, snapshot: MaterialRuleSnapshot) {
    if (scope !== this.scope) throw new Error('Sessiya o‘zgargan.')
    if ([...this.entries.values()].some(row => ['pending', 'uncertain'].includes(row.phase))) throw new Error('Avvalgi amal aniqlanmaguncha boshqa qoidani saqlash ochilmaydi.')
    this.selected = snapshot.rule.apparatus_id
    if (!this.entries.has(this.selected)) this.entries.set(this.selected, { snapshot: structuredClone(snapshot), draft: materialRuleDraft(snapshot.rule), phase: 'editing', serial: ++this.serial, dispatched: false })
    this.publish()
  }
  edit(scope: string, draft: MaterialRuleDraft) { const value = this.entries.get(this.selected); if (scope !== this.scope || !value || ['pending', 'uncertain', 'confirmed', 'conflict'].includes(value.phase)) throw new Error('Joriy qoidani tahrirlash qulflangan.'); value.draft = structuredClone(draft); value.error = undefined; this.publish() }
  rebase(scope: string, snapshot: MaterialRuleSnapshot) {
    const old = this.entries.get(snapshot.rule.apparatus_id)
    if (scope !== this.scope || old && ['pending', 'uncertain'].includes(old.phase)) throw new Error('Avvalgi amal tekshirilmaguncha draft almashtirilmaydi.')
    this.selected = snapshot.rule.apparatus_id
    this.entries.set(this.selected, { snapshot: structuredClone(snapshot), draft: materialRuleDraft(snapshot.rule), phase: 'editing', serial: ++this.serial, dispatched: false }); this.publish()
  }
  begin(scope: string, command: MaterialRuleCommand, recovery = false): MaterialRuleLease {
    const id = command.body.apparatus_id, value = this.entries.get(id), unresolved = [...this.entries.values()].find(row => ['pending', 'uncertain'].includes(row.phase))
    if (scope !== this.scope || !value || recovery && (value.phase !== 'uncertain' || !same(value.command, command)) || unresolved && (!recovery || unresolved.phase === 'pending' || !same(unresolved.command, command)) || ['confirmed', 'conflict'].includes(value.phase) || !same(command.baseline, value.snapshot)) throw new Error('Avvalgi canonical amal hal qilinmaguncha yangi so‘rov yuborilmaydi.')
    const wasUncertain = value.phase === 'uncertain', serial = ++this.serial
    value.phase = 'pending'; value.serial = serial; value.command = structuredClone(command); value.error = undefined; value.dispatched = wasUncertain; this.publish()
    return { scope, generation: this.generation, id, serial, wasUncertain }
  }
  private current(lease: MaterialRuleLease) { const value = this.entries.get(lease.id); return lease.scope === this.scope && lease.generation === this.generation && value?.serial === lease.serial ? value : undefined }
  dispatched(lease: MaterialRuleLease) { const value = this.current(lease); if (value) { value.dispatched = true; this.publish() } }
  finish(lease: MaterialRuleLease, outcome: { result: MaterialRuleResult } | { error: string; uncertain: boolean } | { superseded: MaterialRuleSnapshot }) {
    const value = this.current(lease); if (!value || value.phase !== 'pending') return
    if ('result' in outcome) { value.phase = 'confirmed'; value.result = structuredClone(outcome.result); value.error = undefined }
    else if ('superseded' in outcome) { value.phase = 'conflict'; value.result = { rule: outcome.superseded.rule, snapshot: structuredClone(outcome.superseded), observed: true }; value.error = 'Joriy canonical revision boshqa qiymatlarni saqlagan. Avvalgi revision sharti endi o‘tmaydi; joriy qoidani yuklab qayta ko‘rib chiqing.' }
    else { value.phase = outcome.uncertain || lease.wasUncertain ? 'uncertain' : 'editing'; value.error = outcome.error }
    this.publish()
  }
  interrupt(lease: MaterialRuleLease) { const value = this.current(lease); if (value?.phase === 'pending') { value.phase = value.dispatched || lease.wasUncertain ? 'uncertain' : 'editing'; value.serial = ++this.serial; value.error = value.phase === 'uncertain' ? 'So‘rov yuborilgach oyna yopilgan. So‘rov va oldingi revision saqlanmoqda.' : 'So‘rov yuborilmasdan to‘xtatildi; draft saqlangan.'; this.publish() } }
}
export const materialRuleDrafts = new MaterialRuleDraftRegistry()
