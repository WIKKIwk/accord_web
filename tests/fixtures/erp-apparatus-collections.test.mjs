import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { createSeed, apparatusIds } from './erp-seed.mjs';
import { apparatusCollectionsPath, apparatusCollectionFixtureRoute, seedApparatusCollectionScenario } from './erp-apparatus-collections.mjs';

const path = apparatusCollectionsPath, detail = id => `${path}/${encodeURIComponent(id)}`;
function setup(scenario = 'empty', changes = {}) {
  const api = extensionHarness(apparatusCollectionFixtureRoute, changes);
  assert.equal(seedApparatusCollectionScenario(api.state, { scenario }).status, 200); return api;
}
function input(patch = {}) { return { name: 'QA New Line', apparatus_ids: [apparatusIds.print], ...patch }; }
function find(api, name) { return api.request('GET', path).body.find(row => row.name === name); }

test('collection reads use all seven native OR capabilities independently of actor role; writes require production.map.manage', () => {
  for (const capability of ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access']) {
    const api = setup('empty', { capabilities: [capability], profile: { role: 'aparatchi', ref: 'qa-worker-1' } });
    assert.equal(api.request('GET', path).status, 200);
    assert.equal(api.request('GET', '/v1/mobile/admin/apparatus?limit=500').status, 200);
    assert.equal(api.request('GET', `/v1/mobile/admin/apparatus/${encodeURIComponent(apparatusIds.print)}`).status, 200);
    assert.equal(api.request('POST', path, input()).status, capability === 'production.map.manage' ? 200 : 403);
    if (capability !== 'production.map.manage') for (const method of ['PUT', 'DELETE', 'GET']) assert.equal(api.request(method, detail('apparatus-collection:' + '0'.repeat(32)), input()).status, 403);
  }
  const denied = setup('empty', { capabilities: ['role.capability.manage', 'factory.location.manage'] });
  for (const method of ['GET', 'POST']) assert.equal(denied.request(method, path, input()).status, 403);
});
test('native POST returns only collection DTO with backend-shaped opaque ID, revision1 and sorted deduplicated canonical members', () => {
  const api = setup(), before = structuredClone(api.state.apparatus);
  const saved = api.request('POST', path, input({ name: '  QA  New Line  ', apparatus_ids: [apparatusIds.print, ` ${apparatusIds.laminate} `, apparatusIds.print] }));
  assert.equal(saved.status, 200); assert.match(saved.body.id, /^apparatus-collection:[0-9a-f]{32}$/);
  assert.deepEqual(saved.body, { id: saved.body.id, name: 'QA  New Line', apparatus_ids: [apparatusIds.print, apparatusIds.laminate].sort(), revision: 1 });
  assert.deepEqual(Object.keys(saved.body).sort(), ['id', 'name', 'apparatus_ids', 'revision'].sort());
  assert.deepEqual(api.state.apparatus, before); assert.deepEqual(api.request('GET', path).body, [saved.body]);
  saved.body.apparatus_ids.length = 0; assert.equal(api.state.apparatusCollections[0].apparatus_ids.length, 2);
});
test('native names trim Unicode whitespace only, count80 Unicode scalars and preserve punctuation/case/internal spacing', () => {
  const api = setup();
  assert.equal(api.request('POST', path, input({ name: '\u0085 😀  Ё / A-1 \u0085' })).body.name, '😀  Ё / A-1');
  assert.equal(api.request('POST', path, input({ name: '😀'.repeat(80) })).status, 200);
  assert.equal(api.request('POST', path, input({ name: '😀'.repeat(81) })).body.error, 'apparatus collection name is too long');
  assert.equal(api.request('POST', path, input({ name: '\uFEFFName\uFEFF' })).body.name, '\uFEFFName\uFEFF');
});
test('fixture whole-string folding matches Rust memory-store contextual sigma; PostgreSQL Unicode uniqueness remains collation-dependent', () => {
  const api = setup();
  assert.equal(api.request('POST', path, input({ name: 'Bosma A' })).status, 200);
  assert.equal(api.request('POST', path, input({ name: ' bosma a ' })).body.error, 'apparatus collection name already exists');
  assert.equal(api.request('POST', path, input({ name: 'Bosma  A' })).status, 200);
  assert.equal(api.request('POST', path, input({ name: 'ΟΣ' })).status, 200);
  assert.equal(api.request('POST', path, input({ name: 'Οσ' })).status, 200);
  assert.equal(api.request('POST', path, input({ name: 'Ος' })).body.error, 'apparatus collection name already exists');
});
test('GET returns every collection sorted by fixture lower-name/id, without fictional pagination or name filtering', () => {
  const api = setup();
  for (const name of ['Zulu', 'alpha', 'Beta']) assert.equal(api.request('POST', path, input({ name })).status, 200);
  assert.deepEqual(api.request('GET', path + '?q=Zulu&offset=1&limit=1').body.map(row => row.name), ['alpha', 'Beta', 'Zulu']);
});
test('native bodies deny all unknown fields and malformed typed values rather than accepting actor/idempotency/receipt fields', () => {
  const api = setup(), before = structuredClone(api.state.apparatusCollections);
  for (const body of [null, [], 'name', input({ actor_role: 'admin' }), input({ idempotency_key: 'fake' }), input({ expected_revision: 1 }), input({ name: 7 }), input({ name: null }), input({ apparatus_ids: null }), input({ apparatus_ids: [7] })]) assert.equal(api.request('POST', path, body).body.error, 'invalid_json');
  assert.deepEqual(api.state.apparatusCollections, before);
  const saved = api.request('POST', path, input()).body;
  for (const body of [{ ...input(), expected_revision: 1, id: saved.id }, { ...input(), expected_revision: 1, previous_name: saved.name }, input(), { ...input(), expected_revision: '1' }, { ...input(), expected_revision: -1 }, { ...input(), expected_revision: 1.5 }]) assert.equal(api.request('PUT', detail(saved.id), body).body.error, 'invalid_json');
  for (const body of [{ expected_revision: 1, name: saved.name }, { expected_revision: 1, apparatus_ids: [] }, {}, { expected_revision: null }]) assert.equal(api.request('DELETE', detail(saved.id), body).body.error, 'invalid_json');
});
test('create/update defaults empty apparatus membership and reports required name and zero revision errors', () => {
  const api = setup();
  assert.equal(api.request('POST', path, {}).body.error, 'apparatus collection name is required');
  assert.equal(api.request('POST', path, { name: ' ' }).body.error, 'apparatus collection name is required');
  const saved = api.request('POST', path, { name: 'Empty Line' }).body;
  assert.deepEqual(saved.apparatus_ids, []);
  for (const method of ['PUT', 'DELETE']) assert.equal(api.request(method, detail(saved.id), { expected_revision: 0, ...(method === 'PUT' ? input() : {}) }).body.error, 'apparatus collection revision is invalid');
  assert.equal(api.request('PUT', detail(saved.id), { expected_revision: 1 }).body.error, 'apparatus collection name is required');
  assert.deepEqual(api.request('PUT', detail(saved.id), { expected_revision: 1, name: 'Still Empty' }).body, { ...saved, name: 'Still Empty', revision: 2 });
});
test('validates raw500 limit before deduplication and permits exactly500 duplicate IDs', () => {
  const api = setup();
  assert.equal(api.request('POST', path, input({ apparatus_ids: Array(501).fill(apparatusIds.print) })).body.error, 'apparatus collection has too many apparatus');
  const saved = api.request('POST', path, input({ apparatus_ids: Array(500).fill(apparatusIds.print) }));
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.apparatus_ids, [apparatusIds.print]);
});
test('canonical IDs and exact active membership are required atomically; names, aliases and inactive IDs cannot locate members', () => {
  const api = setup(), before = structuredClone(api.state.apparatusCollections);
  for (const id of ['QA Flexo 1', 'apparatus:QA:print-1', 'apparatus:qa:missing', 'apparatus:default:', '', '\uFEFF' + apparatusIds.print]) assert.equal(api.request('POST', path, input({ apparatus_ids: [apparatusIds.print, id] })).body.error, 'apparatus id is invalid');
  assert.deepEqual(api.state.apparatusCollections, before);
  assert.equal(seedApparatusCollectionScenario(api.state, { action: 'retire', apparatus_id: apparatusIds.print }).status, 200);
  assert.equal(api.request('POST', path, input()).body.error, 'apparatus id is invalid');
  assert.deepEqual(api.state.apparatusCollections, before);
});
test('PUT preserves collection ID, replaces full membership/name and atomically increments its native revision', () => {
  const api = setup('collections'), original = find(api, 'QA Bosma liniyasi'), apparatusBefore = structuredClone(api.state.apparatus);
  const changed = api.request('PUT', detail(original.id), { expected_revision: 1, name: 'QA Renamed / α', apparatus_ids: [apparatusIds.cut, apparatusIds.laminate, apparatusIds.cut] });
  assert.equal(changed.status, 200); assert.deepEqual(changed.body, { id: original.id, name: 'QA Renamed / α', apparatus_ids: [apparatusIds.cut, apparatusIds.laminate].sort(), revision: 2 });
  assert.deepEqual(api.state.apparatus, apparatusBefore); assert.equal(api.state.apparatusCollections.length, 2);
  const noChange = api.request('PUT', detail(original.id), { expected_revision: 2, name: changed.body.name, apparatus_ids: changed.body.apparatus_ids });
  assert.equal(noChange.body.revision, 3);
});
test('PostgreSQL compare-and-swap ordering makes stale+duplicate revision conflict and missing+duplicate not found', () => {
  const api = setup('collections'), original = find(api, 'QA Bosma liniyasi'), other = find(api, 'QA Aralash liniya'), before = structuredClone(api.state.apparatusCollections);
  const valid = { expected_revision: 1, name: other.name, apparatus_ids: [apparatusIds.print] };
  assert.equal(api.request('PUT', detail(original.id), valid).body.error, 'apparatus collection name already exists');
  // MemoryApparatusCollectionStore checks names first; this fixture follows the PostgreSQL UPDATE predicate.
  assert.equal(api.request('PUT', detail(original.id), { ...valid, expected_revision: 2 }).body.error, 'apparatus collection revision conflict');
  assert.equal(api.request('PUT', detail('apparatus-collection:' + 'f'.repeat(32)), valid).body.error, 'apparatus collection not found');
  assert.deepEqual(api.state.apparatusCollections, before);
  assert.equal(api.request('PUT', detail(original.id), { ...valid, expected_revision: 2, apparatus_ids: ['apparatus:qa:missing'] }).body.error, 'apparatus id is invalid');
});
test('DELETE requires exact current revision and returns precisely204 without a fake success receipt or apparatus side effect', () => {
  const api = setup('collections'), original = find(api, 'QA Bosma liniyasi'), before = structuredClone(api.state.apparatusCollections), apparatusBefore = structuredClone(api.state.apparatus);
  assert.equal(api.request('DELETE', detail(original.id), { expected_revision: 2 }).body.error, 'apparatus collection revision conflict');
  assert.deepEqual(api.state.apparatusCollections, before);
  assert.deepEqual(api.request('DELETE', detail(original.id), { expected_revision: 1 }), { status: 204 });
  assert.deepEqual(api.state.apparatus, apparatusBefore); assert.equal(api.state.apparatusCollections.length, 1);
  assert.equal(api.request('DELETE', detail(original.id), { expected_revision: 1 }).status, 404);
});
test('retired apparatus remain in persisted memberships, may be removed through PUT, and never prevent collection DELETE', () => {
  const api = setup('collections'), original = find(api, 'QA Bosma liniyasi');
  assert.equal(seedApparatusCollectionScenario(api.state, { action: 'retire', apparatus_id: apparatusIds.print }).status, 200);
  assert.deepEqual(find(api, 'QA Bosma liniyasi').apparatus_ids, original.apparatus_ids);
  assert.equal(api.request('PUT', detail(original.id), { expected_revision: 1, ...input({ name: original.name, apparatus_ids: original.apparatus_ids }) }).body.error, 'apparatus id is invalid');
  assert.equal(api.request('PUT', detail(original.id), { expected_revision: 1, name: original.name, apparatus_ids: [apparatusIds.spare] }).status, 200);
  const other = find(api, 'QA Aralash liniya'); assert.ok(other.apparatus_ids.includes(apparatusIds.print));
  assert.deepEqual(api.request('DELETE', detail(other.id), { expected_revision: other.revision }), { status: 204 });
});
test('apparatus can belong to multiple collections; collection writes do not create worker groups or modify permissions', () => {
  const api = setup('collections'), rolesBefore = structuredClone(api.state.roleAssignments), workerGroupsBefore = structuredClone(api.state.workerGroups);
  assert.equal(api.request('POST', path, input()).status, 200);
  assert.equal(api.request('GET', path).body.filter(row => row.apparatus_ids.includes(apparatusIds.print)).length, 3);
  assert.deepEqual(api.state.roleAssignments, rolesBefore); assert.deepEqual(api.state.workerGroups, workerGroupsBefore);
});
test('collection routes expose no single GET, PUT-upsert, receipt, command lookup or idempotency replay', () => {
  const api = setup(), saved = api.request('POST', path, input()).body;
  assert.equal(api.request('PUT', path, { ...input(), expected_revision: 1 }).status, 405);
  assert.equal(api.request('DELETE', path, { expected_revision: 1 }).status, 405);
  assert.equal(api.request('GET', detail(saved.id)).status, 405);
  assert.notEqual(api.request('GET', detail(saved.id) + '/commands/receipt').status, 200);
  assert.equal(api.request('POST', path, input(), { 'idempotency-key': 'same' }).status, 409);
  const different = api.request('POST', path, input({ name: 'Another' }), { 'idempotency-key': 'same' });
  assert.equal(different.status, 200); assert.notEqual(different.body.id, saved.id);
});
test('bounded apparatus scenario keeps a selected exact member beyond500 and searches only native display names', () => {
  const api = setup('bounded-apparatus'), group = api.request('GET', path).body[0], id = 'apparatus:qa:collection-picker-504';
  assert.deepEqual(group.apparatus_ids, [id]);
  const bounded = api.request('GET', '/v1/mobile/admin/apparatus?limit=500').body;
  assert.equal(bounded.length, 500); assert.ok(!bounded.some(row => row.apparatus_id === id));
  const filtered = api.request('GET', '/v1/mobile/admin/apparatus?q=Picker%20504&limit=500').body;
  assert.equal(filtered.length, 1); assert.equal(filtered[0].apparatus_id, id);
  assert.deepEqual(api.request('GET', '/v1/mobile/admin/apparatus?q=apparatus%3Aqa%3Acollection-picker-504').body, []);
  assert.equal(api.request('GET', `/v1/mobile/admin/apparatus/${encodeURIComponent(id)}`).body.apparatus_id, id);
  assert.equal(api.request('PUT', detail(group.id), { ...group, expected_revision: 1 }).body.error, 'invalid_json');
  assert.equal(api.request('PUT', detail(group.id), { name: group.name, apparatus_ids: group.apparatus_ids, expected_revision: 1 }).status, 200);
});
test('empty apparatus scenario permits an empty collection and keeps retired rows in native runtime reads', () => {
  const api = setup('empty-apparatus'), directory = api.request('GET', '/v1/mobile/admin/apparatus?limit=500').body;
  assert.ok(directory.length > 0); assert.ok(directory.every(row => row.lifecycle.state === 'retired'));
  assert.deepEqual(api.request('GET', path).body, []);
  assert.equal(api.request('POST', path, input()).status, 400);
  assert.equal(api.request('POST', path, input({ apparatus_ids: [] })).status, 200);
});
test('opt-in apparatus overrides leave existing canonical routes and unrelated resources to their handlers', () => {
  const api = extensionHarness(apparatusCollectionFixtureRoute);
  assert.equal(api.request('GET', '/v1/mobile/admin/apparatus'), null);
  assert.equal(api.request('GET', `/v1/mobile/admin/apparatus/${encodeURIComponent(apparatusIds.print)}`), null);
  seedApparatusCollectionScenario(api.state, { scenario: 'empty' });
  for (const [method, url] of [['GET', '/v1/mobile/admin/apparatus/options'], ['GET', `/v1/mobile/admin/apparatus/${encodeURIComponent(apparatusIds.print)}/aasx`], ['PUT', `/v1/mobile/admin/apparatus/${encodeURIComponent(apparatusIds.print)}`], ['GET', '/v1/mobile/admin/worker-groups']]) assert.equal(api.request(method, url), null);
});
test('fixture concurrent control uses native atomic revision/name/member validation and retirement retains collection identity', () => {
  const api = setup('collections'), original = find(api, 'QA Bosma liniyasi'), before = structuredClone(api.state.apparatusCollections);
  assert.equal(seedApparatusCollectionScenario(api.state, { action: 'concurrent', id: original.id, patch: { apparatus_ids: ['apparatus:qa:missing'] } }).status, 400);
  assert.deepEqual(api.state.apparatusCollections, before);
  const changed = seedApparatusCollectionScenario(api.state, { action: 'concurrent', id: original.id, patch: { name: 'QA Concurrent', apparatus_ids: [apparatusIds.cut] } });
  assert.equal(changed.status, 200); assert.equal(changed.body.id, original.id); assert.equal(changed.body.revision, 2);
  assert.equal(api.request('PUT', detail(original.id), { ...input(), expected_revision: 1 }).body.error, 'apparatus collection revision conflict');
});
test('fixture controls reject arbitrary scenarios, fields and actions before state changes', () => {
  const api = setup(), before = structuredClone(api.state.apparatusCollections);
  for (const input of [null, [], { scenario: 'production' }, { scenario: 'empty', real_credentials: 'NO' }, { action: 'reset-db' }, { action: 'concurrent', id: 'absent', patch: { revision: 99 } }, { action: 'retire', apparatus_id: apparatusIds.print, delete: true }]) assert.equal(seedApparatusCollectionScenario(api.state, input).status, 400);
  assert.deepEqual(api.state.apparatusCollections, before);
  assert.equal(seedApparatusCollectionScenario(createSeed(), { action: 'concurrent', id: 'absent', patch: {} }).status, 400);
});
