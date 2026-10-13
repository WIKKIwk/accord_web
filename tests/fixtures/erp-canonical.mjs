import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// Synthetic canonical transport fixture; no network, filesystem or production store.
export const fixtureAasxMime = 'application/asset-administration-shell-package';
export const fixtureApparatusOptions = { contract: 'canonical_apparatus_revision', schema_version: 1, vocabulary: {
  execution_operations: ['print', 'laminate', 'cut', 'package', 'glue'],
  process_technologies: ['rotogravure', 'flexographic', 'adhesive_lamination', 'extrusion_lamination', 'slitting', 'bag_making', 'cold_glue'],
  equipment_capabilities: ['print', 'laminate', 'cut', 'package', 'glue', 'tooling', 'virtual_task', 'training'],
} };
const parts = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/aasx/aasx-origin" ContentType="application/asset-administration-shell-package+xml"/>\n  <Override PartName="/aasx/data.xml" ContentType="application/xml"/>\n</Types>\n',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="aasxOrigin" Type="http://admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin"/>\n</Relationships>\n',
  'aasx/aasx-origin': '',
  'aasx/_rels/aasx-origin.rels': '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="aasSpec" Type="http://admin-shell.io/aasx/relationships/aas-spec" Target="data.xml"/>\n</Relationships>\n',
};
const clone = value => structuredClone(value), str = value => typeof value === 'string' ? value.trim() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const draftKeys = ['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'capabilities', 'execution_profile', 'policies', 'capacity', 'placement', 'training', 'lifecycle'];
const technology = { print: ['rotogravure', 'flexographic'], laminate: ['adhesive_lamination', 'extrusion_lamination'], cut: ['slitting'], package: ['bag_making'], glue: ['cold_glue'] };
const canonical = new WeakMap();
export const fixtureBytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }

/** Five native OPC sidecars plus bounded CanonicalPayloadJson. Native full XML semantics remain backend-owned. */
export function fixtureApparatusAasx(revision) {
  const entries = { ...parts, 'aasx/data.xml': `<?xml version="1.0" encoding="UTF-8"?><environment><submodels><submodel><submodelElements><property><idShort>CanonicalPayloadJson</idShort><valueType>xs:string</valueType><value>${escapeXml(JSON.stringify(revision))}</value></property></submodelElements></submodel></submodels></environment>` };
  const local = [], central = []; let position = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name), bytes = Buffer.from(text), crc = crc32(bytes);
    const header = Buffer.alloc(30 + nameBytes.length); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(header, 30);
    const directory = Buffer.alloc(46 + nameBytes.length); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(position, 42); nameBytes.copy(directory, 46);
    local.push(header, bytes); central.push(directory); position += header.length + bytes.length;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(5, 8); end.writeUInt16LE(5, 10); end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(position, 16);
  return new Uint8Array(Buffer.concat([...local, ...central, end]));
}
export function fixtureAasxRevision(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > 16 * 1024 * 1024) throw new Error('aasx_import_invalid');
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== 5 || bytes.readUInt16LE(end + 10) !== 5 || bytes.readUInt16LE(end + 20)) throw new Error('aasx_import_invalid');
  const central = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12), names = new Set(); let cursor = central, xml = '';
  if (central + size !== end) throw new Error('aasx_import_invalid');
  for (let index = 0; index < 5; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50 || bytes.readUInt16LE(cursor + 8) || bytes.readUInt16LE(cursor + 30) || bytes.readUInt16LE(cursor + 32) || bytes.readUInt16LE(cursor + 34)) throw new Error('aasx_import_invalid');
    const method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength); cursor += 46 + nameLength;
    if (cursor > end || names.has(name) || ![...Object.keys(parts), 'aasx/data.xml'].includes(name) || ![0, 8].includes(method) || length > 8 * 1024 * 1024 || local + 30 + nameLength + compressed > central || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== length || bytes.readUInt16LE(local + 26) !== nameLength || bytes.readUInt16LE(local + 28) || bytes.toString('utf8', local + 30, local + 30 + nameLength) !== name) throw new Error('aasx_import_invalid');
    const raw = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + compressed), content = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: 8 * 1024 * 1024 });
    if (content.length !== length || crc32(content) !== crc || name !== 'aasx/data.xml' && content.toString('utf8') !== parts[name]) throw new Error('aasx_import_invalid');
    names.add(name); if (name === 'aasx/data.xml') xml = content.toString('utf8');
  }
  const marker = '<idShort>CanonicalPayloadJson</idShort>', start = xml.indexOf(marker), endProperty = xml.indexOf('</property>', start), valueStart = xml.indexOf('<value>', start) + 7, valueEnd = xml.indexOf('</value>', valueStart);
  if (cursor !== end || /<!DOCTYPE|<!ENTITY/i.test(xml) || start < 0 || xml.indexOf(marker, start + marker.length) >= 0 || endProperty < start || valueStart < start || valueEnd < valueStart || valueEnd > endProperty) throw new Error('aasx_import_invalid');
  const escaped = xml.slice(valueStart, valueEnd);
  if (Buffer.byteLength(escaped) > 512 * 1024 || /&(?!(?:amp|lt|gt|quot|apos);)/.test(escaped) || /[<>]/.test(escaped)) throw new Error('aasx_import_invalid');
  return JSON.parse(escaped.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]));
}
function aasIdentity(id) { const suffix = id.slice('apparatus:'.length); return { shell_id: `urn:mini-rs-erp:aas:apparatus:${suffix}`, submodel_id: `urn:mini-rs-erp:submodel:apparatus:${suffix}`, semantic_id: 'urn:mini-rs-erp:semantic-id:submodel:apparatus:1', idta_release: '26-01', aas_metamodel_version: '3.2.0', aasx_part_5_version: 'IDTA-01005 v3.2', package_format: 'Open Packaging Conventions', media_type: fixtureAasxMime }; }
function draftFor(row, planning) {
  return { display: clone(row.display), equipment_class_id: row.equipment_class_id, physical_asset_id: row.physical_asset_id, hierarchy: clone(row.hierarchy), capabilities: Object.entries(row.capabilities).map(([code, level]) => ({ code, level })), execution_profile: clone(row.execution_profile),
    policies: { queue: planning.discipline, material: clone(canonical.get(row)?.policies.material ?? { mode: 'not_required' }), tooling: clone(canonical.get(row)?.policies.tooling ?? { mode: 'not_required' }) }, capacity: clone(planning.capacity), placement: clone(row.placement), training: clone(row.training), lifecycle: clone(row.lifecycle) };
}
export function refreshFixtureCanonical(row, planning, metadata = {}) {
  const previous = canonical.get(row), revision = { ...draftFor(row, planning), schema_version: 1, apparatus_id: row.apparatus_id,
    revision_metadata: { revision: row.source_revision, committed_at_unix_ms: 1791892800000 + row.source_revision, actor_id: 'principal:qa-admin', command_id: `apparatus-command:fixture:${row.apparatus_id}:${row.source_revision}`, source: 'admin', source_reference: null, ...metadata }, aas_identity: aasIdentity(row.apparatus_id) };
  if (!previous && !Object.keys(metadata).length) revision.revision_metadata.source = 'legacy_migration';
  canonical.set(row, revision); row.source_aasx_sha256 = fixtureBytesHash(fixtureApparatusAasx(revision)); return revision;
}
export function fixtureCanonicalRevision(row) { const result = canonical.get(row); if (!result) throw new Error('Missing synthetic canonical seed'); return clone(result); }
function validDraft(draft) {
  if (!object(draft) || Object.keys(draft).some(key => !draftKeys.includes(key)) || draftKeys.some(key => !Object.hasOwn(draft, key))) return false;
  const reference = value => typeof value === 'string' && value === value.trim() && value.includes(':') && !/\s/.test(value), positive = value => Number.isSafeInteger(value) && value >= 1;
  const profile = draft.execution_profile, training = draft.training, capacity = draft.capacity;
  const groups = list => Array.isArray(list) && list.length > 0 && list.every(value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 256) && new Set(list).size === list.length;
  const material = draft.policies?.material, tooling = draft.policies?.tooling;
  const validMaterial = material?.mode === 'not_required' ? material.item_group_ids === undefined || Array.isArray(material.item_group_ids) && material.item_group_ids.length === 0 || groups(material.item_group_ids) : material?.mode === 'all_required' ? groups(material.item_group_ids) : material?.mode === 'requirement_sets' && Array.isArray(material.sets) && material.sets.length > 0 && new Set(material.sets.map(row => row.requirement_id)).size === material.sets.length && material.sets.every(row => Boolean(str(row.requirement_id)) && groups(row.item_group_ids) && positive(row.minimum_required_count) && row.minimum_required_count <= row.item_group_ids.length);
  const validTooling = tooling?.mode === 'not_required' || tooling?.mode === 'qolip_scan_required' && Boolean(str(tooling.tooling_class_id)) && draft.capabilities?.some(row => row.code === 'tooling');
  const windows = capacity?.availability?.working_windows, validAvailability = capacity?.availability?.mode === 'always' || capacity?.availability?.mode === 'scheduled' && Array.isArray(windows) && windows.length > 0 && new Set(windows.map(row => JSON.stringify(row))).size === windows.length && windows.every(row => positive(row.weekday) && row.weekday <= 7 && Number.isSafeInteger(row.start_minute) && row.start_minute >= 0 && row.start_minute < 1440 && Number.isSafeInteger(row.end_minute) && row.end_minute > row.start_minute && row.end_minute <= 1440);
  return object(draft.display) && Boolean(str(draft.display.display_name)) && typeof draft.display.description === 'string' && Number.isSafeInteger(draft.display.catalog_order) && draft.display.catalog_order >= 0 &&
    reference(draft.equipment_class_id) && reference(draft.physical_asset_id) && object(draft.hierarchy) && ['enterprise_id', 'site_id', 'area_id', 'work_center_id', 'work_unit_id'].every(key => reference(draft.hierarchy[key])) &&
    Array.isArray(draft.capabilities) && draft.capabilities.length > 0 && new Set(draft.capabilities.map(row => row.code)).size === draft.capabilities.length && draft.capabilities.every(row => fixtureApparatusOptions.vocabulary.equipment_capabilities.includes(row.code) && positive(row.level) && row.level <= 100) &&
    object(profile) && technology[profile.operation]?.includes(profile.technology) && draft.capabilities.some(row => row.code === profile.operation) && ['disabled', 'input_bridge'].includes(profile.virtual_tasks) && (profile.virtual_tasks !== 'input_bridge' || draft.capabilities.some(row => row.code === 'virtual_task')) && typeof profile.capability_compatible_reroute === 'boolean' &&
    (profile.technology === 'rotogravure' ? positive(profile.color_station_count) && profile.color_station_count <= 32 : profile.operation === 'print' ? profile.color_station_count === null || positive(profile.color_station_count) && profile.color_station_count <= 32 : profile.color_station_count === null) &&
    [profile.min_web_width_mm, profile.max_web_width_mm].every(value => value === undefined || positive(value) && value <= 100000) && (profile.min_web_width_mm === undefined || profile.max_web_width_mm === undefined || profile.min_web_width_mm <= profile.max_web_width_mm) &&
    object(training) && ['enabled', 'queue_enabled', 'material_tracking_enabled'].every(key => typeof training[key] === 'boolean') && training.enabled === draft.capabilities.some(row => row.code === 'training') && (training.enabled || !training.queue_enabled && !training.material_tracking_enabled) &&
    object(draft.policies) && ['strict_sequence', 'free_pick'].includes(draft.policies.queue) && validMaterial && validTooling && object(capacity) && positive(capacity.capacity_slots) && capacity.capacity_slots <= 64 && positive(capacity.efficiency_percent) && capacity.efficiency_percent <= 200 && Number.isSafeInteger(capacity.setup_minutes) && capacity.setup_minutes >= 0 && capacity.setup_minutes <= 4294967295 && Number.isSafeInteger(capacity.cleanup_minutes) && capacity.cleanup_minutes >= 0 && capacity.cleanup_minutes <= 4294967295 && typeof capacity.finite_capacity === 'boolean' && validAvailability &&
    (draft.placement === null || object(draft.placement) && Boolean(str(draft.placement.factory_map_object_id))) && object(draft.lifecycle) && (draft.lifecycle.state === 'active' ? draft.lifecycle.retirement_reason === null : draft.lifecycle.state === 'retired' && Boolean(str(draft.lifecycle.retirement_reason)));
}
function commit(row, draft, state, profile, key, source = 'admin', sourceReference = null) {
  for (const field of ['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'execution_profile', 'placement', 'training', 'lifecycle']) row[field] = clone(draft[field]);
  row.capabilities = Object.fromEntries(draft.capabilities.map(item => [item.code, item.level])); row.source_revision++;
  state.planning[row.apparatus_id] = { discipline: draft.policies.queue, capacity: clone(draft.capacity) };
  const revision = refreshFixtureCanonical(row, state.planning[row.apparatus_id], { command_id: `apparatus-command:${key}`, actor_id: `principal:${profile.ref}`, source, source_reference: sourceReference });
  revision.policies = clone(draft.policies); canonical.set(row, revision); row.source_aasx_sha256 = fixtureBytesHash(fixtureApparatusAasx(revision));
  state.canonicalCommands.push(key); return { revision: clone(revision), runtime_projection: clone(row), aasx_sha256: row.source_aasx_sha256 };
}
export function canonicalFixtureRoute({ method, path, query, body, headers, state, requires, profile, bump, equal }) {
  const base = '/v1/mobile/admin/apparatus'; if (path !== base && !path.startsWith(`${base}/`)) return undefined;
  const suffix = path.slice(base.length + 1), aasx = suffix.endsWith('/aasx'), id = aasx ? suffix.slice(0, -5) : suffix;
  if (method === 'GET' && path === base) return undefined; // Keep the native bounded resource list/search.
  if (!requires(method === 'GET' && suffix !== 'options' && !aasx ? 'admin.access' : 'production.map.manage', ...(method === 'GET' && suffix !== 'options' && !aasx ? ['production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'] : []))) return error(403, 'forbidden');
  if (suffix === 'options') return method === 'GET' ? response(clone(fixtureApparatusOptions)) : error(405, 'method_not_allowed');
  const row = state.apparatus.find(row => row.apparatus_id === id), key = str(headers['idempotency-key']);
  if (method === 'GET') {
    if (!row) return error(404, 'apparatus_not_found');
    if (!aasx) return response(clone(row));
    return { status: 200, body: fixtureApparatusAasx(fixtureCanonicalRevision(row)), contentType: fixtureAasxMime, headers: { ETag: `"${row.source_revision}-${row.source_aasx_sha256}"` } };
  }
  if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) return error(400, 'idempotency_key_required');
  if (path === base && method === 'POST') {
    if (!validDraft(body) || body.lifecycle.state !== 'active') return error(400, 'apparatus_revision_invalid');
    if (state.canonicalCommands.includes(key) || state.apparatus.some(row => row.physical_asset_id === body.physical_asset_id)) return error(409, 'apparatus_already_exists');
    const created = { apparatus_id: `apparatus:default:${fixtureBytesHash(Buffer.from(`synthetic:apparatus:${state.nextId++}`)).slice(0, 32)}`, source_revision: 0 };
    state.apparatus.push(created); const receipt = commit(created, body, state, profile, key); bump(); return response(receipt);
  }
  if (!row) return error(404, 'apparatus_not_found');
  if (row.lifecycle.state !== 'active') return error(409, 'apparatus_retired');
  const expected = aasx ? Number(headers['if-match']) : body?.expected_revision;
  if (!Number.isSafeInteger(expected) || expected < 1) return error(400, 'expected_revision_invalid');
  if (expected !== row.source_revision || state.canonicalCommands.includes(key)) return error(409, 'apparatus_revision_conflict');
  let draft = Object.fromEntries(draftKeys.map(field => [field, clone(fixtureCanonicalRevision(row)[field])])), importedHash = null;
  if (method === 'PATCH' && !aasx) {
    if (!object(body.patch) || Object.keys(body).some(key => !['expected_revision', 'patch'].includes(key)) || !Object.keys(body.patch).length || Object.keys(body.patch).some(key => !['display', 'equipment_class_id', 'hierarchy', 'capabilities', 'execution_profile', 'policies', 'capacity', 'training', 'placement'].includes(key))) return error(400, 'apparatus_revision_invalid');
    draft = { ...draft, ...clone(body.patch) };
  } else if (method === 'DELETE' && !aasx) {
    if (!str(body?.retirement_reason) || str(body.retirement_reason).length > 256) return error(400, 'apparatus_revision_invalid');
    draft.lifecycle = { state: 'retired', retirement_reason: str(body.retirement_reason) };
  } else if (method === 'POST' && aasx) {
    if (!(body instanceof Uint8Array) || headers['content-type']?.split(';')[0] !== fixtureAasxMime) return error(400, 'aasx_import_invalid');
    try { const imported = fixtureAasxRevision(body); if (imported.apparatus_id !== row.apparatus_id || imported.schema_version !== 1 || !equal(imported.aas_identity, aasIdentity(row.apparatus_id))) return error(409, 'apparatus_identity_conflict'); draft = Object.fromEntries(draftKeys.map(field => [field, clone(imported[field])])); importedHash = fixtureBytesHash(body); }
    catch { return error(400, 'aasx_import_invalid'); }
  } else return error(405, 'method_not_allowed');
  if (draft.physical_asset_id !== row.physical_asset_id) return error(409, 'apparatus_identity_conflict');
  if (!validDraft(draft)) return error(400, 'apparatus_revision_invalid');
  if (draft.placement && state.apparatus.some(other => other !== row && other.placement?.factory_map_object_id === draft.placement.factory_map_object_id)) return error(409, 'apparatus_placement_conflict');
  const receipt = commit(row, draft, state, profile, key, importedHash ? 'aasx_import' : 'admin', importedHash ? `sha256:${importedHash}` : null); bump(); return response(receipt);
}
