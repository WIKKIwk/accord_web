import { apparatusIds } from './erp-seed.mjs';
import { refreshFixtureCanonical } from './erp-canonical.mjs';

// Pure synthetic projection of apparatus_collections.rs with PostgreSQL CAS ordering.
// Collection commands have revision CAS, no idempotency and no receipt route.
export const apparatusCollectionsPath = '/v1/mobile/admin/apparatus-collections';
const apparatusPath = '/v1/mobile/admin/apparatus';
const clone = value => structuredClone(value), text = value => typeof value === 'string' ? value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const canonical = value => typeof value === 'string' && value.length <= 128 && /^apparatus:[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(value);
const readCapabilities = ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Deterministic name folding follows the Rust memory store, including contextual final sigma.
// PostgreSQL lower(name) uses its database collation; this fixture cannot prove its Unicode uniqueness behavior.
const nameKey = name => name.toLowerCase();
const sortedCollections = state => clone(state.apparatusCollections || []).sort((a, b) => compare(nameKey(a.name), nameKey(b.name)) || compare(a.id, b.id));
const revision = value => Number.isSafeInteger(value) && value >= 1;

function parsedBody(body, kind) {
  const keys = kind === 'create' ? ['name', 'apparatus_ids'] : kind === 'update' ? ['expected_revision', 'name', 'apparatus_ids'] : ['expected_revision'];
  if (!object(body) || Object.keys(body).some(key => !keys.includes(key))
    || kind !== 'delete' && (body.name !== undefined && typeof body.name !== 'string'
      || body.apparatus_ids !== undefined && (!Array.isArray(body.apparatus_ids) || body.apparatus_ids.some(id => typeof id !== 'string')))
    || kind !== 'create' && (!Object.hasOwn(body, 'expected_revision') || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0)) return error(400, 'invalid_json');
  if (kind !== 'create' && body.expected_revision === 0) return error(400, 'apparatus collection revision is invalid');
  if (kind === 'delete') return { expected_revision: body.expected_revision };
  const name = text(body.name), rawIds = body.apparatus_ids ?? [];
  if (!name) return error(400, 'apparatus collection name is required');
  if (Array.from(name).length > 80) return error(400, 'apparatus collection name is too long');
  if (rawIds.length > 500) return error(400, 'apparatus collection has too many apparatus');
  const apparatus_ids = rawIds.map(text);
  if (apparatus_ids.some(id => !canonical(id))) return error(400, 'apparatus id is invalid');
  return { name, apparatus_ids: [...new Set(apparatus_ids)].sort(), ...(kind === 'update' ? { expected_revision: body.expected_revision } : {}) };
}
function command(state, kind, body, id) {
  const input = parsedBody(body, kind); if (input.status) return input;
  const collections = state.apparatusCollections || [];
  if (kind !== 'delete' && input.apparatus_ids.some(member => !state.apparatus.some(row => row.apparatus_id === member && row.lifecycle.state === 'active'))) return error(400, 'apparatus id is invalid');
  const index = kind === 'create' ? -1 : collections.findIndex(row => row.id === text(id));
  if (kind !== 'create' && index < 0) return error(404, 'apparatus collection not found');
  if (kind !== 'create' && collections[index].revision !== input.expected_revision) return error(409, 'apparatus collection revision conflict');
  if (kind !== 'delete' && collections.some(row => row.id !== text(id) && nameKey(row.name) === nameKey(input.name))) return error(409, 'apparatus collection name already exists');
  if (kind === 'delete') {
    state.apparatusCollections = collections.filter((_, position) => position !== index);
    return { status: 204 };
  }
  if (kind === 'update' && (!revision(collections[index].revision + 1))) return error(500, 'apparatus collection store failed');
  const nextCounter = (state.apparatusCollectionCounter || 0) + 1;
  const saved = { id: kind === 'create' ? `apparatus-collection:${nextCounter.toString(16).padStart(32, '0')}` : collections[index].id,
    name: input.name, apparatus_ids: input.apparatus_ids, revision: kind === 'create' ? 1 : collections[index].revision + 1 };
  // Do not mutate membership/name until every native validation and CAS check passes.
  if (kind === 'create') { state.apparatusCollectionCounter = nextCounter; state.apparatusCollections = [...collections, saved]; }
  else state.apparatusCollections = collections.map((row, position) => position === index ? saved : row);
  return response(clone(saved));
}
export function apparatusCollectionFixtureRoute({ method, path, query = {}, body, state, requires, bump }) {
  // Full apparatus reads are opt-in and keep bounded/name-search behavior native.
  if (state.apparatusCollectionFixture && method === 'GET' && (path === apparatusPath || path.startsWith(apparatusPath + '/'))) {
    const id = path.slice(apparatusPath.length + 1);
    if (path !== apparatusPath && (!id || id.includes('/'))) return null;
    if (path !== apparatusPath && id === 'options') return null;
    if (!requires(...readCapabilities)) return error(403, 'forbidden');
    if (path !== apparatusPath) {
      if (!canonical(id)) return error(400, 'apparatus_id_invalid');
      const apparatus = state.apparatus.find(row => row.apparatus_id === id);
      return apparatus ? response(clone(apparatus)) : error(404, 'apparatus_not_found');
    }
    const q = text(query.q).toLowerCase(), requestedLimit = Number(query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(500, Math.trunc(requestedLimit)) : 50;
    return response(clone(state.apparatus.filter(row => !q || row.display.display_name.toLowerCase().includes(q)).slice(0, limit)));
  }
  if (path !== apparatusCollectionsPath && !path.startsWith(apparatusCollectionsPath + '/')) return null;
  if (!requires(...readCapabilities)) return error(403, 'forbidden');
  if (path === apparatusCollectionsPath) {
    if (method === 'GET') return response(sortedCollections(state));
    if (method !== 'POST') return error(405, 'method_not_allowed');
    if (!requires('production.map.manage')) return error(403, 'forbidden');
    const result = command(state, 'create', body); if (result.status === 200) bump?.(); return result;
  }
  // The native single-collection route has no GET or command/receipt lookup.
  if (!requires('production.map.manage')) return error(403, 'forbidden');
  const id = path.slice(apparatusCollectionsPath.length + 1);
  if (!['PUT', 'DELETE'].includes(method)) return error(405, 'method_not_allowed');
  const result = command(state, method === 'PUT' ? 'update' : 'delete', body, id);
  if (result.status === 200 || result.status === 204) bump?.(); return result;
}
function seededCollection(number, name, apparatus_ids) {
  return { id: `apparatus-collection:${number.toString(16).padStart(32, '0')}`, name, apparatus_ids: [...apparatus_ids].sort(), revision: 1 };
}
export function seedApparatusCollectionScenario(state, input = {}) {
  if (!object(input)) return error(400, 'invalid_apparatus_collection_fixture');
  if (input.action === 'concurrent') {
    if (!state.apparatusCollectionFixture || Object.keys(input).some(key => !['action', 'id', 'patch'].includes(key)) || typeof input.id !== 'string'
      || !object(input.patch) || Object.keys(input.patch).some(key => !['name', 'apparatus_ids'].includes(key))) return error(400, 'invalid_apparatus_collection_fixture');
    const original = (state.apparatusCollections || []).find(row => row.id === input.id);
    if (!original) return error(404, 'apparatus_collection_fixture_not_found');
    const result = command(state, 'update', { name: original.name, apparatus_ids: original.apparatus_ids, ...clone(input.patch), expected_revision: original.revision }, original.id);
    if (result.status === 200) state.rev++; return result;
  }
  if (input.action === 'retire') {
    if (!state.apparatusCollectionFixture || Object.keys(input).some(key => !['action', 'apparatus_id'].includes(key)) || !canonical(input.apparatus_id)) return error(400, 'invalid_apparatus_collection_fixture');
    const apparatus = state.apparatus.find(row => row.apparatus_id === input.apparatus_id);
    if (!apparatus) return error(404, 'apparatus_collection_fixture_not_found');
    apparatus.lifecycle = { state: 'retired', retirement_reason: 'Synthetic collection QA retirement' };
    apparatus.source_revision++;
    refreshFixtureCanonical(apparatus, state.planning[apparatus.apparatus_id]);
    state.rev++; return response({ ok: true });
  }
  const scenario = input.scenario ?? 'empty';
  if (Object.keys(input).some(key => key !== 'scenario') || !['empty', 'collections', 'bounded-apparatus', 'empty-apparatus'].includes(scenario)) return error(400, 'invalid_apparatus_collection_fixture');
  state.apparatusCollections = scenario === 'collections'
    ? [seededCollection(1, 'QA Bosma liniyasi', [apparatusIds.print, apparatusIds.spare]), seededCollection(2, 'QA Aralash liniya', [apparatusIds.print, apparatusIds.laminate])] : [];
  state.apparatusCollectionFixture = { scenario };
  if (scenario === 'bounded-apparatus') {
    const source = state.apparatus.find(row => row.apparatus_id === apparatusIds.print), planning = state.planning[source.apparatus_id];
    const additional = Array.from({ length: 505 }, (_, index) => {
      const apparatus_id = `apparatus:qa:collection-picker-${index}`, next = clone(source);
      next.apparatus_id = apparatus_id; next.display = { ...next.display, display_name: `QA Collection Picker ${String(index).padStart(3, '0')}`, catalog_order: 1000 + index };
      next.physical_asset_id = `physical-asset:qa:collection-picker-${index}`; next.hierarchy.work_unit_id = `work-unit:collection-picker-${index}`;
      next.placement = null; state.planning[apparatus_id] = clone(planning); refreshFixtureCanonical(next, state.planning[apparatus_id]); return next;
    });
    state.apparatus.push(...additional);
    state.apparatusCollections = [seededCollection(1, 'QA Bounded liniya', [additional.at(-1).apparatus_id])];
  }
  if (scenario === 'empty-apparatus') state.apparatus.forEach(row => { row.lifecycle = { state: 'retired', retirement_reason: 'Synthetic empty apparatus directory' }; row.source_revision++; refreshFixtureCanonical(row, state.planning[row.apparatus_id]); });
  state.apparatusCollectionCounter = state.apparatusCollections.length;
  state.rev++; return response({ ok: true, scenario });
}
