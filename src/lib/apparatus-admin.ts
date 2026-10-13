import { ApiClient, ApiError, isRecord, record, rows } from './api'
import type { Row, Session } from './api-types'
import { hasCapability, meetsRequirement } from './permissions'
import { isPlanningApparatusId } from './apparatus-planning'

const base = '/v1/mobile/admin/apparatus'
const hashPattern = /^[a-f0-9]{64}$/
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u
const encoder = new TextEncoder()
export const apparatusCapabilityCodes = ['print', 'laminate', 'cut', 'package', 'glue', 'tooling', 'virtual_task', 'training'] as const
export type ApparatusCapabilityCode = typeof apparatusCapabilityCodes[number]
export const apparatusOperationLabels = { print: 'Bosma', laminate: 'Laminatsiya', cut: 'Kesish', package: 'Qadoqlash', glue: 'Yelimlash' } as const
export type ApparatusOperation = keyof typeof apparatusOperationLabels
export const apparatusTechnologyLabels = { rotogravure: 'Metall bosma', flexographic: 'Flexo bosma', adhesive_lamination: 'Yelimli laminatsiya', extrusion_lamination: 'Ekstruder laminatsiya', slitting: 'Rulonni kesish', bag_making: 'Paket tayyorlash', cold_glue: 'Sovuq yelim' } as const
export type ApparatusTechnology = keyof typeof apparatusTechnologyLabels
const technologies: Record<ApparatusOperation, ApparatusTechnology[]> = { print: ['rotogravure', 'flexographic'], laminate: ['adhesive_lamination', 'extrusion_lamination'], cut: ['slitting'], package: ['bag_making'], glue: ['cold_glue'] }
export const apparatusAasxMime = 'application/asset-administration-shell-package'
export const apparatusAasxMaxBytes = 16 * 1024 * 1024
const maxPartBytes = 8 * 1024 * 1024
const canonicalParts = ['[Content_Types].xml', '_rels/.rels', 'aasx/aasx-origin', 'aasx/_rels/aasx-origin.rels', 'aasx/data.xml']
/** Exact native OPC sidecars; XML semantics of data.xml are validated by the server. */
export const apparatusCanonicalAuxParts: Readonly<Record<string, string>> = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/aasx/aasx-origin" ContentType="application/asset-administration-shell-package+xml"/>\n  <Override PartName="/aasx/data.xml" ContentType="application/xml"/>\n</Types>\n',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="aasxOrigin" Type="http://admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin"/>\n</Relationships>\n',
  'aasx/aasx-origin': '',
  'aasx/_rels/aasx-origin.rels': '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="aasSpec" Type="http://admin-shell.io/aasx/relationships/aas-spec" Target="data.xml"/>\n</Relationships>\n',
}
export const APPARATUS_ADMIN_API_LIMITATIONS = [
  'Retirement creates a final retired revision; the API has no restore or hard-delete workflow.',
  'The native retirement handler has no order/worker dependency precheck. Web blocks retirement and structural profile changes when current order references are active or unknown; worker assignment dependencies have no dedicated apparatus endpoint.',
  'Create returns a server-generated apparatus identity. Its lookup by immutable physical asset is a bounded name-search snapshot of at most 500 records; absence cannot prove an uncertain create failed.',
  'AASX imports replace a complete canonical draft. This directory imports only packages that preserve identity, hierarchy, placement, lifecycle and planning/material/tooling policies; broader changes use the separate supported controls.',
  'Canonical mutation keys are command identifiers, not a replay endpoint. Uncertain writes use readback and never an automatic repeated mutation.',
] as const

export interface ApparatusDisplay { display_name: string; description: string; catalog_order: number }
export interface ApparatusCapability { code: ApparatusCapabilityCode; level: number }
export interface ApparatusExecution { operation: ApparatusOperation; technology: ApparatusTechnology; color_station_count: number | null; min_web_width_mm?: number; max_web_width_mm?: number; virtual_tasks: 'disabled' | 'input_bridge'; capability_compatible_reroute: boolean }
export interface ApparatusTraining { enabled: boolean; queue_enabled: boolean; material_tracking_enabled: boolean }
export interface ApparatusDraft {
  display: ApparatusDisplay; equipment_class_id: string; physical_asset_id: string; hierarchy: Record<'enterprise_id' | 'site_id' | 'area_id' | 'work_center_id' | 'work_unit_id', string>
  capabilities: ApparatusCapability[]; execution_profile: ApparatusExecution; policies: Row; capacity: Row
  placement: { factory_map_object_id: string } | null; training: ApparatusTraining; lifecycle: { state: 'active' | 'retired'; retirement_reason: string | null }
}
export interface ApparatusCanonicalRevision extends ApparatusDraft { schema_version: number; apparatus_id: string; revision_metadata: Row & { revision: number; command_id: string; actor_id: string }; aas_identity: Row }
export interface ApparatusProjection extends Omit<ApparatusDraft, 'capabilities' | 'policies' | 'capacity'> { apparatus_id: string; source_revision: number; source_aasx_sha256: string; capabilities: Partial<Record<ApparatusCapabilityCode, number>> }
export interface ApparatusAdminSnapshot { projection: ApparatusProjection; revision: ApparatusCanonicalRevision }
export interface ApparatusAdminOptions { operations: ApparatusOperation[]; technologies: ApparatusTechnology[]; capabilities: ApparatusCapabilityCode[] }
export interface ApparatusProfileInput { display: ApparatusDisplay; capabilities: ApparatusCapability[]; execution_profile: ApparatusExecution; training: ApparatusTraining }
export interface ApparatusProfileForm { name: string; description: string; catalogOrder: string; operation: ApparatusOperation; technology: ApparatusTechnology; colorStations: string; minWidth: string; maxWidth: string; virtualTasks: boolean; reroute: boolean; levels: Partial<Record<ApparatusCapabilityCode, string>>; training: ApparatusTraining }
export interface ApparatusReferences { activeOrderIds: string[]; unknownOrderIds: string[]; historicalOrderIds: string[] }
export interface ApparatusAasxPreview { blob: Blob; name: string; size: number; sha256: string; revision: ApparatusCanonicalRevision }
export type ApparatusAdminOperation =
  | { kind: 'create'; key: string; draft: ApparatusDraft }
  | { kind: 'patch'; key: string; baseline: ApparatusAdminSnapshot; input: ApparatusProfileInput }
  | { kind: 'retire'; key: string; baseline: ApparatusAdminSnapshot; reason: string }
  | { kind: 'import'; key: string; baseline: ApparatusAdminSnapshot; file: ApparatusAasxPreview }
export interface ApparatusAdminResult { snapshot: ApparatusAdminSnapshot; recovered: boolean }
export class ApparatusAdminConflict extends Error {
  readonly current?: ApparatusAdminSnapshot
  constructor(message: string, current?: ApparatusAdminSnapshot) { super(message); this.name = 'ApparatusAdminConflict'; this.current = current }
}
export class ApparatusAdminUnknown extends Error {
  readonly operation: ApparatusAdminOperation
  constructor(operation: ApparatusAdminOperation, message = 'Serverdagi saqlash natijasi tasdiqlanmadi. Yangi so‘rovdan oldin joriy revisionni tekshiring.') { super(message); this.name = 'ApparatusAdminUnknown'; this.operation = operation }
}

function invalid(message = 'Canonical apparat javobi to‘liq yoki mos holda kelmadi.'): never { throw new ApiError(502, 'invalid_response', message) }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(); return value }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value }
function string(value: unknown, empty = false): string { if (typeof value !== 'string' || value !== value.trim() || !empty && !value || controlCharacters.test(value)) return invalid(); return value }
function referenceText(value: unknown): string { const result = string(value); if (Array.from(result).length > 256) return invalid(); return result }
function reference(value: unknown, label = 'Identifikator'): string { const result = string(value); if (encoder.encode(result).length > 256 || /\s/u.test(result) || !result.includes(':')) throw new Error(`${label}: bo‘shliqsiz, ikki nuqtali canonical identifikator kiriting.`); return result }
function exactKeys(row: Row, allowed: readonly string[], required: readonly string[] = allowed): void { if (Object.keys(row).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(row, key))) return invalid() }
function stable(value: unknown): string { return JSON.stringify(value, (_key, next) => isRecord(next) ? Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right))) : next) }
function draftOf(value: ApparatusDraft): ApparatusDraft { return structuredClone({ display: value.display, equipment_class_id: value.equipment_class_id, physical_asset_id: value.physical_asset_id, hierarchy: value.hierarchy, capabilities: value.capabilities, execution_profile: value.execution_profile, policies: value.policies, capacity: value.capacity, placement: value.placement, training: value.training, lifecycle: value.lifecycle }) }
function key(kind: string): string { return `web-apparatus:${kind}:${crypto.randomUUID()}` }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
function uncertain(error: unknown): boolean { return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response' }

export function apparatusAdminPermissions(session: Session | null | undefined) {
  const authenticated = Boolean(session?.token && session.profile.role)
  return { read: authenticated && meetsRequirement(session, { any: ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'] }), manage: authenticated && hasCapability(session, 'production.map.manage') }
}
export function apparatusAdminId(row: Row): string { const value = isRecord(row.runtime_projection) ? row.runtime_projection.apparatus_id : row.apparatus_id; return isPlanningApparatusId(value) ? value : '' }
export function apparatusTechnologies(operation: ApparatusOperation): ApparatusTechnology[] { return [...technologies[operation]] }
function parseDisplay(value: unknown): ApparatusDisplay {
  const row = record(value); exactKeys(row, ['display_name', 'description', 'catalog_order'])
  const name = string(row.display_name), description = row.description
  if (typeof description !== 'string' || controlCharacters.test(description)) return invalid()
  if (Array.from(name).length > 256 || Array.from(description).length > 2000) return invalid()
  return { display_name: name, description, catalog_order: integer(row.catalog_order, 0, 4_294_967_295) }
}
function parseCapabilities(value: unknown): ApparatusCapability[] {
  const result = rows(value).map(row => { exactKeys(row, ['code', 'level']); const code = string(row.code) as ApparatusCapabilityCode; if (!apparatusCapabilityCodes.includes(code)) return invalid(); return { code, level: integer(row.level, 1, 100) } }).sort((a, b) => apparatusCapabilityCodes.indexOf(a.code) - apparatusCapabilityCodes.indexOf(b.code))
  if (!result.length || new Set(result.map(value => value.code)).size !== result.length) return invalid()
  return result
}
function parseExecution(value: unknown, capabilities: ApparatusCapability[]): ApparatusExecution {
  const row = record(value); exactKeys(row, ['operation', 'technology', 'color_station_count', 'min_web_width_mm', 'max_web_width_mm', 'virtual_tasks', 'capability_compatible_reroute'], ['operation', 'technology', 'color_station_count', 'virtual_tasks', 'capability_compatible_reroute'])
  const operation = string(row.operation) as ApparatusOperation, technology = string(row.technology) as ApparatusTechnology
  if (!Object.hasOwn(apparatusOperationLabels, operation) || !technologies[operation].includes(technology) || !capabilities.some(capability => capability.code === operation)) throw new Error('Operatsiya, texnologiya va asosiy imkoniyat o‘zaro mos bo‘lishi kerak.')
  const color = row.color_station_count === null ? null : integer(row.color_station_count, 1, 32)
  if (technology === 'rotogravure' && color === null || !['rotogravure', 'flexographic'].includes(technology) && color !== null) throw new Error('Rang stansiyalari faqat bosma uchun; metall bosmada 1–32 stansiya talab qilinadi.')
  const virtual = string(row.virtual_tasks)
  if (!['disabled', 'input_bridge'].includes(virtual) || virtual === 'input_bridge' && !capabilities.some(capability => capability.code === 'virtual_task')) throw new Error('Virtual ish uchun virtual_task imkoniyati kerak.')
  const minimum = row.min_web_width_mm == null ? undefined : integer(row.min_web_width_mm, 1, 100_000), maximum = row.max_web_width_mm == null ? undefined : integer(row.max_web_width_mm, 1, 100_000)
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error('Eng kam eni eng katta enidan oshmasligi kerak.')
  return { operation, technology, color_station_count: color, ...(minimum === undefined ? {} : { min_web_width_mm: minimum }), ...(maximum === undefined ? {} : { max_web_width_mm: maximum }), virtual_tasks: virtual as ApparatusExecution['virtual_tasks'], capability_compatible_reroute: boolean(row.capability_compatible_reroute) }
}
function parseTraining(value: unknown, capabilities: ApparatusCapability[]): ApparatusTraining {
  const row = record(value); exactKeys(row, ['enabled', 'queue_enabled', 'material_tracking_enabled'])
  const result = { enabled: boolean(row.enabled), queue_enabled: boolean(row.queue_enabled), material_tracking_enabled: boolean(row.material_tracking_enabled) }
  if (result.enabled !== capabilities.some(capability => capability.code === 'training') || !result.enabled && (result.queue_enabled || result.material_tracking_enabled)) throw new Error('O‘quv profili va training imkoniyati mos bo‘lishi kerak.')
  return result
}
function referenceList(value: unknown): string[] { if (!Array.isArray(value)) return invalid(); const result = value.map(item => { const text = string(item); if (Array.from(text).length > 256) return invalid(); return text }).sort(); if (!result.length || new Set(result).size !== result.length) return invalid(); return result }
function parsePolicies(value: unknown, capabilities: ApparatusCapability[]): Row {
  const row = record(value); exactKeys(row, ['queue', 'material', 'tooling'])
  if (!['strict_sequence', 'free_pick'].includes(string(row.queue))) return invalid()
  const material = record(row.material), tooling = record(row.tooling)
  let normalized: Row
  if (material.mode === 'not_required') { exactKeys(material, ['mode', 'item_group_ids'], ['mode']); normalized = material.item_group_ids === undefined || Array.isArray(material.item_group_ids) && !material.item_group_ids.length ? { mode: 'not_required' } : { mode: 'not_required', item_group_ids: referenceList(material.item_group_ids) } }
  else if (material.mode === 'all_required') { exactKeys(material, ['mode', 'item_group_ids']); normalized = { mode: 'all_required', item_group_ids: referenceList(material.item_group_ids) } }
  else if (material.mode === 'requirement_sets') {
    exactKeys(material, ['mode', 'sets']); const sets = rows(material.sets).map(set => { exactKeys(set, ['requirement_id', 'item_group_ids', 'minimum_required_count']); const groups = referenceList(set.item_group_ids); return { requirement_id: referenceText(set.requirement_id), item_group_ids: groups, minimum_required_count: integer(set.minimum_required_count, 1, Math.min(65_535, groups.length)) } }).sort((a, b) => a.requirement_id.localeCompare(b.requirement_id))
    if (!sets.length || new Set(sets.map(set => set.requirement_id)).size !== sets.length) return invalid(); normalized = { mode: 'requirement_sets', sets }
  } else return invalid()
  if (tooling.mode === 'not_required') exactKeys(tooling, ['mode'])
  else if (tooling.mode === 'qolip_scan_required') { exactKeys(tooling, ['mode', 'tooling_class_id']); referenceText(tooling.tooling_class_id); if (!capabilities.some(capability => capability.code === 'tooling')) throw new Error('Qolip skani qoidasi tooling imkoniyatiga bog‘liq. Uni olib tashlab bo‘lmaydi.') }
  else return invalid()
  return { queue: row.queue, material: normalized, tooling: structuredClone(tooling) }
}
function parseCapacity(value: unknown): Row {
  const row = record(value); exactKeys(row, ['capacity_slots', 'setup_minutes', 'cleanup_minutes', 'efficiency_percent', 'finite_capacity', 'availability'])
  const availability = record(row.availability); let normalized: Row
  if (availability.mode === 'always') { exactKeys(availability, ['mode']); normalized = { mode: 'always' } }
  else if (availability.mode === 'scheduled') {
    exactKeys(availability, ['mode', 'working_windows']); const windows = rows(availability.working_windows).map(window => { exactKeys(window, ['weekday', 'start_minute', 'end_minute']); const start = integer(window.start_minute, 0, 1439); return { weekday: integer(window.weekday, 1, 7), start_minute: start, end_minute: integer(window.end_minute, start + 1, 1440) } }).sort((a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute || a.end_minute - b.end_minute)
    if (!windows.length || new Set(windows.map(window => stable(window))).size !== windows.length) return invalid(); normalized = { mode: 'scheduled', working_windows: windows }
  } else return invalid()
  return { capacity_slots: integer(row.capacity_slots, 1, 64), setup_minutes: integer(row.setup_minutes, 0, 4_294_967_295), cleanup_minutes: integer(row.cleanup_minutes, 0, 4_294_967_295), efficiency_percent: integer(row.efficiency_percent, 1, 200), finite_capacity: boolean(row.finite_capacity), availability: normalized }
}
export function parseApparatusDraft(value: unknown): ApparatusDraft {
  const row = record(value); exactKeys(row, ['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'capabilities', 'execution_profile', 'policies', 'capacity', 'placement', 'training', 'lifecycle'])
  const capabilities = parseCapabilities(row.capabilities), hierarchy = record(row.hierarchy), lifecycle = record(row.lifecycle)
  const hierarchyKeys = ['enterprise_id', 'site_id', 'area_id', 'work_center_id', 'work_unit_id'] as const; exactKeys(hierarchy, hierarchyKeys)
  exactKeys(lifecycle, ['state', 'retirement_reason']); if (!['active', 'retired'].includes(string(lifecycle.state)) || lifecycle.state === 'active' && lifecycle.retirement_reason !== null || lifecycle.state === 'retired' && !string(lifecycle.retirement_reason)) return invalid()
  let placement: ApparatusDraft['placement'] = null
  if (row.placement !== null) { const value = record(row.placement); exactKeys(value, ['factory_map_object_id']); placement = { factory_map_object_id: referenceText(value.factory_map_object_id) } }
  return { display: parseDisplay(row.display), equipment_class_id: reference(row.equipment_class_id, 'Uskuna klassi'), physical_asset_id: reference(row.physical_asset_id, 'Jismoniy aktiv'), hierarchy: Object.fromEntries(hierarchyKeys.map(key => [key, reference(hierarchy[key], 'Ierarxiya')])) as ApparatusDraft['hierarchy'], capabilities, execution_profile: parseExecution(row.execution_profile, capabilities), policies: parsePolicies(row.policies, capabilities), capacity: parseCapacity(row.capacity), placement, training: parseTraining(row.training, capabilities), lifecycle: { state: lifecycle.state as 'active' | 'retired', retirement_reason: lifecycle.retirement_reason === null ? null : referenceText(lifecycle.retirement_reason) } }
}
export function parseApparatusCanonicalRevision(value: unknown): ApparatusCanonicalRevision {
  const row = record(value), draftFields = ['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'capabilities', 'execution_profile', 'policies', 'capacity', 'placement', 'training', 'lifecycle']
  exactKeys(row, [...draftFields, 'schema_version', 'apparatus_id', 'revision_metadata', 'aas_identity'])
  const id = string(row.apparatus_id); if (!isPlanningApparatusId(id) || row.schema_version !== 1) return invalid()
  const metadata = record(row.revision_metadata), aas = record(row.aas_identity)
  exactKeys(metadata, ['revision', 'committed_at_unix_ms', 'actor_id', 'command_id', 'source', 'source_reference'])
  if (!['admin', 'aasx_import', 'legacy_migration'].includes(string(metadata.source))) return invalid()
  if (metadata.source_reference !== null) referenceText(metadata.source_reference)
  integer(metadata.committed_at_unix_ms, 1); referenceText(metadata.actor_id); referenceText(metadata.command_id)
  const suffix = id.slice('apparatus:'.length), expectedAas = { shell_id: `urn:mini-rs-erp:aas:apparatus:${suffix}`, submodel_id: `urn:mini-rs-erp:submodel:apparatus:${suffix}`, semantic_id: 'urn:mini-rs-erp:semantic-id:submodel:apparatus:1', idta_release: '26-01', aas_metamodel_version: '3.2.0', aasx_part_5_version: 'IDTA-01005 v3.2', package_format: 'Open Packaging Conventions', media_type: apparatusAasxMime }
  if (stable(aas) !== stable(expectedAas)) return invalid('AAS identifikatori canonical apparat profili bilan mos emas.')
  return { ...parseApparatusDraft(Object.fromEntries(draftFields.map(key => [key, row[key]]))), schema_version: 1, apparatus_id: id, revision_metadata: { ...metadata, revision: integer(metadata.revision, 1), command_id: string(metadata.command_id), actor_id: string(metadata.actor_id) }, aas_identity: structuredClone(aas) }
}
export function parseApparatusProjection(value: unknown): ApparatusProjection {
  const row = record(value), source = isRecord(row.runtime_projection) ? row.runtime_projection : row
  const id = string(source.apparatus_id), hash = string(source.source_aasx_sha256); if (!isPlanningApparatusId(id) || !hashPattern.test(hash)) return invalid()
  const capabilityRows = Object.entries(record(source.capabilities)).map(([code, level]) => ({ code, level })), capabilities = parseCapabilities(capabilityRows)
  const draft = parseApparatusDraft({ display: source.display, equipment_class_id: source.equipment_class_id, physical_asset_id: source.physical_asset_id, hierarchy: source.hierarchy, capabilities, execution_profile: source.execution_profile, policies: { queue: 'strict_sequence', material: { mode: 'not_required' }, tooling: { mode: 'not_required' } }, capacity: { capacity_slots: 1, setup_minutes: 0, cleanup_minutes: 0, efficiency_percent: 100, finite_capacity: true, availability: { mode: 'always' } }, placement: source.placement, training: source.training, lifecycle: source.lifecycle })
  const { policies: _policies, capacity: _capacity, capabilities: _capabilities, ...projection } = draft
  return { ...projection, apparatus_id: id, source_revision: integer(source.source_revision, 1), source_aasx_sha256: hash, capabilities: Object.fromEntries(capabilities.map(capability => [capability.code, capability.level])) }
}
export function apparatusProfileForm(revision: ApparatusDraft): ApparatusProfileForm {
  const profile = revision.execution_profile
  return { name: revision.display.display_name, description: revision.display.description, catalogOrder: String(revision.display.catalog_order), operation: profile.operation, technology: profile.technology, colorStations: profile.color_station_count === null ? '' : String(profile.color_station_count), minWidth: profile.min_web_width_mm === undefined ? '' : String(profile.min_web_width_mm), maxWidth: profile.max_web_width_mm === undefined ? '' : String(profile.max_web_width_mm), virtualTasks: profile.virtual_tasks === 'input_bridge', reroute: profile.capability_compatible_reroute, levels: Object.fromEntries(revision.capabilities.map(capability => [capability.code, String(capability.level)])), training: { ...revision.training } }
}
function formInteger(value: string, label: string, min: number, max: number): number { if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label}: ${min}–${max} oralig‘ida butun son kiriting.`); return Number(value) }
export function apparatusProfileInput(form: ApparatusProfileForm, policies?: Row): ApparatusProfileInput {
  const display = parseDisplay({ display_name: form.name.trim(), description: form.description, catalog_order: formInteger(form.catalogOrder, 'Ro‘yxat tartibi', 0, 4_294_967_295) })
  const capabilities = parseCapabilities(apparatusCapabilityCodes.filter(code => form.levels[code] !== undefined).map(code => ({ code, level: formInteger(form.levels[code]!, `${code} darajasi`, 1, 100) })))
  const profile = parseExecution({ operation: form.operation, technology: form.technology, color_station_count: form.colorStations.trim() ? formInteger(form.colorStations, 'Rang stansiyalari', 1, 32) : null, ...(form.minWidth.trim() ? { min_web_width_mm: formInteger(form.minWidth, 'Eng kam eni, mm', 1, 100_000) } : {}), ...(form.maxWidth.trim() ? { max_web_width_mm: formInteger(form.maxWidth, 'Eng katta eni, mm', 1, 100_000) } : {}), virtual_tasks: form.virtualTasks ? 'input_bridge' : 'disabled', capability_compatible_reroute: form.reroute }, capabilities)
  if (policies) parsePolicies(policies, capabilities)
  return { display, capabilities, execution_profile: profile, training: parseTraining(form.training, capabilities) }
}
export function apparatusCreateDraft(form: ApparatusProfileForm, identity: { equipmentClass: string; physicalAsset: string; hierarchy: ApparatusDraft['hierarchy'] }): ApparatusDraft {
  const input = apparatusProfileInput(form)
  return parseApparatusDraft({ ...input, equipment_class_id: identity.equipmentClass.trim(), physical_asset_id: identity.physicalAsset.trim(), hierarchy: Object.fromEntries(Object.entries(identity.hierarchy).map(([key, value]) => [key, value.trim()])), policies: { queue: 'strict_sequence', material: { mode: 'not_required' }, tooling: { mode: 'not_required' } }, capacity: { capacity_slots: 1, setup_minutes: 0, cleanup_minutes: 0, efficiency_percent: 100, finite_capacity: true, availability: { mode: 'always' } }, placement: null, lifecycle: { state: 'active', retirement_reason: null } })
}
export function apparatusDefaultForm(): ApparatusProfileForm { return { name: '', description: '', catalogOrder: '10000', operation: 'print', technology: 'rotogravure', colorStations: '7', minWidth: '', maxWidth: '', virtualTasks: false, reroute: true, levels: { print: '1' }, training: { enabled: false, queue_enabled: false, material_tracking_enabled: false } } }
function assertMutable(snapshot: ApparatusAdminSnapshot): void { if (snapshot.revision.lifecycle.state !== 'active') throw new Error('Foydalanishdan chiqarilgan apparat tahrirlanmaydi. Tiklash amali mavjud emas.') }
export function apparatusPatchOperation(snapshot: ApparatusAdminSnapshot, form: ApparatusProfileForm): ApparatusAdminOperation { assertMutable(snapshot); return { kind: 'patch', key: key('patch'), baseline: structuredClone(snapshot), input: apparatusProfileInput(form, snapshot.revision.policies) } }
export function apparatusCreateOperation(draft: ApparatusDraft): ApparatusAdminOperation { const parsed = parseApparatusDraft(draft); if (parsed.lifecycle.state !== 'active' || parsed.placement !== null) throw new Error('Yangi apparat faol va hali 3D xaritaga biriktirilmagan holda yaratiladi.'); return { kind: 'create', key: key('create'), draft: parsed } }
export function apparatusRetireOperation(snapshot: ApparatusAdminSnapshot, reason: string): ApparatusAdminOperation { assertMutable(snapshot); const value = reason.trim(); if (!value || Array.from(value).length > 256 || controlCharacters.test(value)) throw new Error('Foydalanishdan chiqarish sababini kiriting (1–256 belgi).'); return { kind: 'retire', key: key('retire'), baseline: structuredClone(snapshot), reason: value } }
function protectedFields(revision: ApparatusDraft): unknown { return [revision.equipment_class_id, revision.physical_asset_id, revision.hierarchy, revision.policies, revision.capacity, revision.placement, revision.lifecycle] }
export function apparatusImportOperation(snapshot: ApparatusAdminSnapshot, file: ApparatusAasxPreview): ApparatusAdminOperation {
  assertMutable(snapshot)
  if (file.revision.apparatus_id !== snapshot.revision.apparatus_id || stable(protectedFields(file.revision)) !== stable(protectedFields(snapshot.revision)) || stable(file.revision.aas_identity) !== stable(snapshot.revision.aas_identity)) throw new Error('AASX identifikator, joylashuv yoki rejalashtirish/qolip/xomashyo qoidalarini o‘zgartiradi. Bu import oynasi ularni saqlab qolishi kerak.')
  return { kind: 'import', key: key('import'), baseline: structuredClone(snapshot), file }
}
export function apparatusReferences(snapshot: Awaited<ReturnType<ApiClient['productionSnapshot']>>, apparatusId: string): ApparatusReferences {
  const result: ApparatusReferences = { activeOrderIds: [], unknownOrderIds: [], historicalOrderIds: [] }
  for (const saved of snapshot.maps) {
    const id = typeof saved.map.id === 'string' ? saved.map.id : '', nodes = saved.map.nodes
    if (!id || !Array.isArray(nodes) || nodes.some(node => !isRecord(node))) { result.unknownOrderIds.push(id || 'noma’lum'); continue }
    if (!nodes.some(node => node.kind === 'apparatus' && (node.apparatus_id === apparatusId || node.alternative_assigned_apparatus_id === apparatusId))) continue
    const lifecycle = snapshot.order_statuses[id]?.lifecycle_status
    if (lifecycle === 'released' || lifecycle === 'in_progress') result.activeOrderIds.push(id)
    else if (['production_completed', 'closed', 'cancelled'].includes(String(lifecycle))) result.historicalOrderIds.push(id)
    else result.unknownOrderIds.push(id)
  }
  return result
}

export function apparatusCrc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) } return (crc ^ 0xffffffff) >>> 0 }
export async function apparatusHashBytes(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
async function inflate(bytes: Uint8Array, expected: number): Promise<Uint8Array> {
  const reader = new Blob([new Uint8Array(bytes).buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), output = new Uint8Array(expected)
  let offset = 0
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (offset + value.length > expected) throw new Error('AASX qismi belgilangan hajmdan oshdi.'); output.set(value, offset); offset += value.length } if (offset !== expected) throw new Error('AASX qismi hajmi mos emas.'); return output }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
/** Bounded ZIP32 reader for the exact five-part native OPC profile; never extracts to disk. */
export async function apparatusAasxRevision(bytes: Uint8Array): Promise<ApparatusCanonicalRevision> {
  if (bytes.length < 22 || bytes.length > apparatusAasxMaxBytes) throw new Error('AASX fayli bo‘sh yoki 16 MiB chegarasidan katta.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder('utf-8', { fatal: true })
  const read = (offset: number, size: 2 | 4): number => { if (offset < 0 || offset + size > bytes.length) throw new Error('AASX ZIP chegaralari noto‘g‘ri.'); return size === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true) }
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) if (read(offset, 4) === 0x06054b50 && offset + 22 + read(offset + 20, 2) === bytes.length) { eocd = offset; break }
  if (eocd < 0 || read(eocd + 4, 2) || read(eocd + 6, 2) || read(eocd + 8, 2) !== 5 || read(eocd + 10, 2) !== 5 || read(eocd + 20, 2)) throw new Error('Canonical AASX ZIP32 to‘plami talab qilinadi.')
  const centralSize = read(eocd + 12, 4), central = read(eocd + 16, 4)
  if (central + centralSize !== eocd) throw new Error('AASX markaziy jadvali noto‘g‘ri.')
  const parts = new Map<string, Uint8Array>(), ranges: [number, number][] = []
  let offset = central
  for (let entry = 0; entry < 5; entry++) {
    if (read(offset, 4) !== 0x02014b50 || read(offset + 8, 2) || read(offset + 30, 2) || read(offset + 32, 2) || read(offset + 34, 2)) throw new Error('AASX ZIP metadata profili qo‘llanmaydi.')
    const method = read(offset + 10, 2), crc = read(offset + 16, 4), compressed = read(offset + 20, 4), size = read(offset + 24, 4), nameSize = read(offset + 28, 2), local = read(offset + 42, 4), next = offset + 46 + nameSize
    if (![0, 8].includes(method) || size > maxPartBytes || next > eocd) throw new Error('AASX siqilishi yoki qism hajmi qo‘llanmaydi.')
    const name = decoder.decode(bytes.subarray(offset + 46, next))
    if (Object.hasOwn(apparatusCanonicalAuxParts, name) && size !== encoder.encode(apparatusCanonicalAuxParts[name]).length) throw new Error('AASX OPC qismi o‘zgartirilgan.')
    if (!canonicalParts.includes(name) || parts.has(name) || local >= central || read(local, 4) !== 0x04034b50 || read(local + 6, 2) || read(local + 8, 2) !== method || read(local + 14, 4) !== crc || read(local + 18, 4) !== compressed || read(local + 22, 4) !== size || read(local + 26, 2) !== nameSize || read(local + 28, 2)) throw new Error('AASX qismi canonical jadvalga mos emas.')
    const dataStart = local + 30 + nameSize, dataEnd = dataStart + compressed
    if (dataEnd > central || decoder.decode(bytes.subarray(local + 30, dataStart)) !== name || ranges.some(([start, end]) => local < end && dataEnd > start)) throw new Error('AASX qism chegaralari mos emas.')
    const content = method === 0 ? bytes.slice(dataStart, dataEnd) : await inflate(bytes.subarray(dataStart, dataEnd), size)
    if (content.length !== size || apparatusCrc32(content) !== crc) throw new Error('AASX qismi yaxlitligi tasdiqlanmadi.')
    if (Object.hasOwn(apparatusCanonicalAuxParts, name) && decoder.decode(content) !== apparatusCanonicalAuxParts[name]) throw new Error('AASX OPC bog‘lanishlari o‘zgartirilgan.')
    ranges.push([local, dataEnd]); parts.set(name, content); offset = next
  }
  if (offset !== eocd || parts.size !== 5 || parts.get('aasx/aasx-origin')!.length) throw new Error('AASX to‘plami to‘liq emas.')
  const xml = decoder.decode(parts.get('aasx/data.xml')!), marker = '<idShort>CanonicalPayloadJson</idShort>', first = xml.indexOf(marker), propertyEnd = xml.indexOf('</property>', first), valueStart = xml.indexOf('<value>', first) + 7, valueEnd = xml.indexOf('</value>', valueStart)
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || first < 0 || xml.indexOf(marker, first + marker.length) >= 0 || propertyEnd < first || valueStart < first || valueEnd < valueStart || valueEnd > propertyEnd) throw new Error('AASX canonical payload qismi noto‘g‘ri.')
  const escaped = xml.slice(valueStart, valueEnd)
  if (encoder.encode(escaped).length > 512 * 1024 || /&(?!(?:amp|lt|gt|quot|apos);)/.test(escaped) || /[<>]/.test(escaped)) throw new Error('AASX payload matni noto‘g‘ri yoki juda katta.')
  const payload = escaped.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!)
  return parseApparatusCanonicalRevision(JSON.parse(payload))
}
export async function inspectApparatusAasx(file: Blob & { name?: string }): Promise<ApparatusAasxPreview> {
  const name = file.name?.trim() ?? ''
  if (!/\.aasx$/i.test(name) || controlCharacters.test(name) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > apparatusAasxMaxBytes) throw new Error('16 MiB gacha bo‘lgan .aasx faylini tanlang.')
  const bytes = new Uint8Array(await file.arrayBuffer()), revision = await apparatusAasxRevision(bytes)
  return { name, size: bytes.length, blob: new Blob([bytes.buffer], { type: apparatusAasxMime }), sha256: await apparatusHashBytes(bytes), revision }
}
function projectionMatches(projection: ApparatusProjection, revision: ApparatusCanonicalRevision): boolean {
  const capabilities = Object.fromEntries(revision.capabilities.map(capability => [capability.code, capability.level]))
  return projection.apparatus_id === revision.apparatus_id && projection.source_revision === revision.revision_metadata.revision && stable(projection.capabilities) === stable(capabilities) && ['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'execution_profile', 'placement', 'training', 'lifecycle'].every(field => stable(projection[field as keyof ApparatusProjection]) === stable(revision[field as keyof ApparatusCanonicalRevision]))
}
function profileFrom(revision: ApparatusDraft): ApparatusProfileInput { return { display: revision.display, capabilities: revision.capabilities, execution_profile: revision.execution_profile, training: revision.training } }
function operationMatches(current: ApparatusAdminSnapshot, operation: ApparatusAdminOperation): boolean {
  if (operation.kind === 'create') return stable(draftOf(current.revision)) === stable(operation.draft)
  if (current.revision.apparatus_id !== operation.baseline.revision.apparatus_id || current.revision.physical_asset_id !== operation.baseline.revision.physical_asset_id) return false
  if (operation.kind === 'retire') return current.revision.lifecycle.state === 'retired' && current.revision.lifecycle.retirement_reason === operation.reason && stable({ ...draftOf(current.revision), lifecycle: undefined }) === stable({ ...draftOf(operation.baseline.revision), lifecycle: undefined })
  if (stable(protectedFields(current.revision)) !== stable(protectedFields(operation.baseline.revision))) return false
  return stable(profileFrom(current.revision)) === stable(operation.kind === 'patch' ? operation.input : profileFrom(operation.file.revision))
}
function receipt(value: unknown, operation: ApparatusAdminOperation, session: Session): ApparatusAdminSnapshot {
  const committed = record(value), revision = parseApparatusCanonicalRevision(committed.revision), projection = parseApparatusProjection(committed.runtime_projection), hash = string(committed.aasx_sha256)
  if (!hashPattern.test(hash) || projection.source_aasx_sha256 !== hash || !projectionMatches(projection, revision) || revision.revision_metadata.command_id !== `apparatus-command:${operation.key}` || session.profile.ref && revision.revision_metadata.actor_id !== `principal:${session.profile.ref}` || revision.revision_metadata.revision !== (operation.kind === 'create' ? 1 : operation.baseline.projection.source_revision + 1) || operation.kind === 'import' && (revision.revision_metadata.source !== 'aasx_import' || revision.revision_metadata.source_reference !== `sha256:${operation.file.sha256}`)) return invalid('Saqlangan revision, hash yoki foydalanuvchi mos kelmadi.')
  const snapshot = { revision, projection }
  if (!operationMatches(snapshot, operation)) return invalid('Server tasdiqlagan apparat qiymatlari yuborilgan o‘zgarishga mos emas.')
  return snapshot
}

export class ApparatusAdminApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = structuredClone(session) }
  private authorize(manage = false): void { const allowed = apparatusAdminPermissions(this.session); if (!(manage ? allowed.manage : allowed.read)) throw new ApiError(403, 'forbidden') }
  async options(signal?: AbortSignal): Promise<ApparatusAdminOptions> {
    this.authorize(true); const value = record(await this.client.get(`${base}/options`, undefined, signal)), vocabulary = record(value.vocabulary)
    if (value.contract !== 'canonical_apparatus_revision' || value.schema_version !== 1) return invalid()
    const values = <T extends string>(raw: unknown, allowed: readonly T[]): T[] => { if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string' || !allowed.includes(item as T)) || new Set(raw).size !== raw.length || !raw.length) return invalid(); return raw as T[] }
    return { operations: values(vocabulary.execution_operations, Object.keys(apparatusOperationLabels) as ApparatusOperation[]), technologies: values(vocabulary.process_technologies, Object.keys(apparatusTechnologyLabels) as ApparatusTechnology[]), capabilities: values(vocabulary.equipment_capabilities, apparatusCapabilityCodes) }
  }
  async projection(id: string, signal?: AbortSignal): Promise<ApparatusProjection> { this.authorize(); if (!isPlanningApparatusId(id)) throw new Error('Canonical apparatni tanlang.'); const value = parseApparatusProjection(await this.client.get(`${base}/${encodeURIComponent(id)}`, undefined, signal)); if (value.apparatus_id !== id) return invalid(); return value }
  async list(query = '', signal?: AbortSignal): Promise<{ items: ApparatusProjection[]; bounded: boolean }> {
    this.authorize(); const items = rows(await this.client.get(base, { q: query.trim(), limit: 500 }, signal)).map(parseApparatusProjection); if (new Set(items.map(item => item.apparatus_id)).size !== items.length || new Set(items.map(item => item.physical_asset_id)).size !== items.length) return invalid(); return { items, bounded: items.length >= 500 }
  }
  private async package(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    this.authorize(true); const controller = new AbortController(), cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel()
    const timeout = setTimeout(cancel, 20_000)
    try {
      const response = await fetch(`${this.client.endpoint}${base}/${encodeURIComponent(id)}/aasx`, { method: 'GET', headers: { Accept: apparatusAasxMime, Authorization: `Bearer ${this.session.token}` }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal })
      abort(signal)
      if (!response.ok) {
        if (response.status === 401) await this.client.me(signal).catch(() => {})
        let code = `http_${response.status}`; try { const body: unknown = await response.json(); if (isRecord(body) && typeof body.error === 'string') code = body.error } catch { /* HTTP status remains authoritative. */ }
        throw new ApiError(response.status, code)
      }
      if (response.headers.get('Content-Type')?.split(';')[0] !== apparatusAasxMime || Number(response.headers.get('Content-Length') || 0) > apparatusAasxMaxBytes) return invalid('Canonical AASX eksporti kutilgan formatda emas.')
      const reader = response.body?.getReader(); if (!reader) return invalid()
      const chunks: Uint8Array[] = []; let size = 0
      try { while (true) { const { done, value } = await reader.read(); abort(signal); if (done) break; size += value.length; if (size > apparatusAasxMaxBytes) return invalid('AASX eksporti 16 MiB chegarasidan katta.'); chunks.push(value) } } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length } return bytes
    } catch (error) { abort(signal); if (error instanceof ApiError) throw error; throw new ApiError(0, controller.signal.aborted ? 'timeout' : 'network') }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel) }
  }
  async read(id: string, signal?: AbortSignal): Promise<ApparatusAdminSnapshot> {
    this.authorize(true); const [projection, bytes] = await Promise.all([this.projection(id, signal), this.package(id, signal)]); abort(signal)
    const [revision, hash] = await Promise.all([apparatusAasxRevision(bytes), apparatusHashBytes(bytes)]); abort(signal)
    if (hash !== projection.source_aasx_sha256 || !projectionMatches(projection, revision)) return invalid('Apparat va AASX turli revisionlardan kelgan. Joriy nusxani qayta yuklang.')
    return { projection, revision }
  }
  async references(id: string, signal?: AbortSignal): Promise<ApparatusReferences> { this.authorize(true); return apparatusReferences(await this.client.productionSnapshot(signal), id) }
  async execute(operation: ApparatusAdminOperation, signal?: AbortSignal): Promise<ApparatusAdminResult> {
    this.authorize(true); abort(signal)
    if (operation.kind === 'import') {
      const bytes = new Uint8Array(await operation.file.blob.arrayBuffer())
      const [revision, hash] = await Promise.all([apparatusAasxRevision(bytes), apparatusHashBytes(bytes)]); abort(signal)
      if (bytes.length !== operation.file.size || hash !== operation.file.sha256 || stable(revision) !== stable(operation.file.revision)) throw new Error('Import fayli ko‘rib chiqilgan nusxaga mos emas. Faylni qayta tanlang.')
      apparatusImportOperation(operation.baseline, operation.file)
    }
    if (operation.kind === 'create') {
      const catalog = await this.list(operation.draft.display.display_name, signal)
      if (catalog.items.some(item => item.physical_asset_id === operation.draft.physical_asset_id)) throw new Error('Jismoniy aktiv identifikatori boshqa apparatga tegishli.')
    } else {
      const current = await this.read(operation.baseline.revision.apparatus_id, signal); assertMutable(current)
      if (current.projection.source_revision !== operation.baseline.projection.source_revision || current.projection.source_aasx_sha256 !== operation.baseline.projection.source_aasx_sha256) throw new ApparatusAdminConflict('Apparat boshqa joyda o‘zgargan. Joriy nusxani yuklab qayta ko‘rib chiqing.', current)
      const structural = operation.kind === 'retire' || operation.kind === 'import' || stable({ ...operation.input, display: undefined }) !== stable({ ...profileFrom(current.revision), display: undefined })
      if (structural) { const references = await this.references(current.revision.apparatus_id, signal); if (references.activeOrderIds.length || references.unknownOrderIds.length) throw new ApparatusAdminConflict('Apparat faol yoki holati noma’lum buyurtmalarda ishlatilmoqda. Faqat nomi, izohi va ro‘yxat tartibini tahrirlash mumkin.', current) }
    }
    abort(signal)
    try {
      const headers = { 'Idempotency-Key': operation.key }, id = operation.kind === 'create' ? '' : operation.baseline.revision.apparatus_id
      const result = operation.kind === 'create' ? await this.client.request(base, 'POST', { headers, body: operation.draft, signal }) : operation.kind === 'patch' ? await this.client.request(`${base}/${encodeURIComponent(id)}`, 'PATCH', { headers, body: { expected_revision: operation.baseline.projection.source_revision, patch: operation.input }, signal }) : operation.kind === 'retire' ? await this.client.request(`${base}/${encodeURIComponent(id)}`, 'DELETE', { headers, body: { expected_revision: operation.baseline.projection.source_revision, retirement_reason: operation.reason }, signal }) : await this.client.request(`${base}/${encodeURIComponent(id)}/aasx`, 'POST', { headers: { ...headers, 'If-Match': String(operation.baseline.projection.source_revision), 'Content-Type': apparatusAasxMime }, rawBody: operation.file.blob, signal })
      return { snapshot: receipt(result, operation, this.session), recovered: false }
    } catch (error) { abort(signal); if (uncertain(error)) throw new ApparatusAdminUnknown(operation); throw error }
  }
  async recover(operation: ApparatusAdminOperation, signal?: AbortSignal): Promise<ApparatusAdminResult> {
    this.authorize(true); abort(signal)
    try {
      let id: string
      if (operation.kind === 'create') { const catalog = await this.list(operation.draft.display.display_name, signal), matches = catalog.items.filter(item => item.physical_asset_id === operation.draft.physical_asset_id); if (matches.length !== 1) throw new ApparatusAdminUnknown(operation, 'Yangi apparat bounded ro‘yxatda tasdiqlanmadi. Bu avvalgi so‘rov saqlanmaganini isbotlamaydi; yaratish takrorlanmaydi.'); id = matches[0].apparatus_id }
      else id = operation.baseline.revision.apparatus_id
      const current = await this.read(id, signal), expected = operation.kind === 'create' ? 0 : operation.baseline.projection.source_revision
      const commandProof = current.revision.revision_metadata.command_id === `apparatus-command:${operation.key}` && (!this.session.profile.ref || current.revision.revision_metadata.actor_id === `principal:${this.session.profile.ref}`) && (operation.kind !== 'import' || current.revision.revision_metadata.source === 'aasx_import' && current.revision.revision_metadata.source_reference === `sha256:${operation.file.sha256}`)
      if (current.projection.source_revision > expected && operationMatches(current, operation) && commandProof) return { snapshot: current, recovered: true }
      if (operation.kind === 'create') throw new ApparatusAdminUnknown(operation, 'Jismoniy aktiv topildi, lekin yaratilgan profil tasdiqlanmadi. Yaratish takrorlanmaydi.')
      throw new ApparatusAdminConflict('Yuborilgan qiymatlar joriy revisionda tasdiqlanmadi. Joriy nusxani yuklab qayta ko‘rib chiqing.', current)
    } catch (error) { abort(signal); if (error instanceof ApparatusAdminConflict || error instanceof ApparatusAdminUnknown) throw error; throw new ApparatusAdminUnknown(operation, `${apparatusAdminError(error)} Oldingi saqlash natijasi noma’lum.`) }
  }
}
export function apparatusAdminError(error: unknown): string {
  if (error instanceof ApiError) { const messages: Record<string, string> = { apparatus_revision_conflict: 'Apparat revisioni o‘zgargan. Joriy nusxani qayta yuklang.', apparatus_retired: 'Apparat foydalanishdan chiqarilgan va tahrirlanmaydi.', apparatus_identity_conflict: 'Apparat yoki jismoniy aktiv identifikatori mos emas.', apparatus_already_exists: 'Canonical apparat, jismoniy aktiv yoki buyruq identifikatori allaqachon mavjud.', apparatus_revision_invalid: 'Apparat profili va bog‘liq qoidalar canonical talablarga mos emas.', aasx_import_invalid: 'AASX to‘plami canonical profil va yaxlitlik tekshiruvidan o‘tmadi.', aasx_package_too_large: 'AASX fayli 16 MiB chegarasidan katta.', expected_revision_invalid: 'AASX uchun amaldagi revision talab qilinadi.' }; return messages[error.code] ?? error.message }
  return error instanceof Error ? error.message : 'Apparat amali bajarilmadi.'
}
