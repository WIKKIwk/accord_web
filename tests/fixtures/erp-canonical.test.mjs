import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createFixture, createFixtureServer } from './erp-fixture.mjs';
import { apparatusIds, fixtureLogin, fixtureToken } from './erp-seed.mjs';
import { fixtureApparatusAasx, fixtureAasxRevision, fixtureBytesHash, fixtureAasxMime } from './erp-canonical.mjs';

const base = '/v1/mobile/admin/apparatus', auth = { authorization: `Bearer ${fixtureToken}` }, id = apparatusIds.spare, url = `${base}/${encodeURIComponent(id)}`;
async function setup() { const fixture = createFixture(); await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin }); return { fixture, request: (method, path, body, headers = auth) => fixture.dispatch({ method, url: path, body, headers }) }; }
const header = key => ({ ...auth, 'idempotency-key': key });
async function revision(request, apparatus = id) { return fixtureAasxRevision((await request('GET', `${base}/${encodeURIComponent(apparatus)}/aasx`)).body); }
const draft = revision => Object.fromEntries(['display', 'equipment_class_id', 'physical_asset_id', 'hierarchy', 'capabilities', 'execution_profile', 'policies', 'capacity', 'placement', 'training', 'lifecycle'].map(key => [key, structuredClone(revision[key])]));

test('native projection and five-part binary package share actual bytes hash and revision identity', async () => {
  const { request } = await setup(), projection = (await request('GET', url)).body, exported = await request('GET', `${url}/aasx`), current = fixtureAasxRevision(exported.body);
  assert.equal(exported.contentType, fixtureAasxMime); assert.equal(fixtureBytesHash(exported.body), projection.source_aasx_sha256);
  assert.equal(current.apparatus_id, projection.apparatus_id); assert.equal(current.revision_metadata.revision, projection.source_revision);
  assert.deepEqual(current.display, projection.display); assert.equal(current.aas_identity.idta_release, '26-01');
  const options = (await request('GET', `${base}/options`)).body; assert.equal(options.contract, 'canonical_apparatus_revision'); assert.equal(options.schema_version, 1);
  assert.ok(options.vocabulary.process_technologies.includes('adhesive_lamination')); assert.ok(options.vocabulary.equipment_capabilities.includes('training'));
});

test('canonical create returns an opaque server ID and strictly bound command/actor/hash', async () => {
  const { fixture, request } = await setup(), source = draft(await revision(request)); source.physical_asset_id = 'physical-asset:qa:new'; source.placement = null; source.display.display_name = 'QA New canonical';
  const saved = (await request('POST', base, source, header('qa-create-canonical'))).body;
  assert.match(saved.revision.apparatus_id, /^apparatus:default:[a-f0-9]{32}$/); assert.equal(saved.runtime_projection.source_revision, 1);
  assert.equal(saved.revision.revision_metadata.command_id, 'apparatus-command:qa-create-canonical'); assert.equal(saved.revision.revision_metadata.actor_id, 'principal:qa-admin');
  assert.equal(saved.revision.physical_asset_id, source.physical_asset_id); assert.equal(saved.aasx_sha256, saved.runtime_projection.source_aasx_sha256);
  assert.equal((await request('POST', base, source, header('qa-create-canonical'))).status, 409); assert.equal((await request('POST', base, source, header('qa-create-other'))).status, 409);
  assert.equal(fixture.getState().state.apparatus.filter(row => row.physical_asset_id === source.physical_asset_id).length, 1);
});

test('profile patch preserves protected fields and canonical commands never replay duplicate commits', async () => {
  const { request } = await setup(), before = await revision(request), profile = { display: { ...before.display, display_name: 'QA Canonical renamed' }, capabilities: before.capabilities, execution_profile: before.execution_profile, training: before.training };
  const saved = await request('PATCH', url, { expected_revision: 1, patch: profile }, header('qa-profile-patch'));
  assert.equal(saved.status, 200); assert.equal(saved.body.revision.revision_metadata.revision, 2); assert.equal(saved.body.revision.revision_metadata.command_id, 'apparatus-command:qa-profile-patch');
  for (const key of ['equipment_class_id', 'physical_asset_id', 'hierarchy', 'policies', 'capacity', 'placement', 'lifecycle']) assert.deepEqual(saved.body.revision[key], before[key]);
  assert.equal((await request('PATCH', url, { expected_revision: 1, patch: profile }, header('qa-profile-patch'))).body.error, 'apparatus_revision_conflict');
  assert.equal((await request('PATCH', url, { expected_revision: 2, patch: profile }, header('qa-profile-patch'))).status, 409);
  assert.equal((await request('PATCH', url, { expected_revision: 2, patch: { physical_asset_id: 'physical-asset:changed' } }, header('qa-invalid-identity'))).status, 400);
  const projected = (await request('GET', url)).body; assert.equal(fixtureBytesHash((await request('GET', `${url}/aasx`)).body), projected.source_aasx_sha256);
});

test('retirement retains identity and references and has no restore or hard-delete mutation', async () => {
  const { request } = await setup(), before = await revision(request);
  const retired = (await request('DELETE', url, { expected_revision: 1, retirement_reason: 'QA Retired' }, header('qa-retire'))).body;
  assert.equal(retired.revision.apparatus_id, id); assert.equal(retired.revision.lifecycle.state, 'retired'); assert.equal(retired.revision.lifecycle.retirement_reason, 'QA Retired');
  assert.equal(retired.revision.physical_asset_id, before.physical_asset_id); assert.equal((await request('GET', url)).body.apparatus_id, id);
  assert.equal((await request('PATCH', url, { expected_revision: 2, patch: { display: before.display } }, header('qa-retired-patch'))).body.error, 'apparatus_retired');
  assert.equal((await request('DELETE', url, { expected_revision: 2, retirement_reason: 'again' }, header('qa-retired-delete'))).status, 409);
});

test('AASX import preserves immutable identity and records the exact uploaded byte hash', async () => {
  const { request } = await setup(), before = await revision(request); before.display.display_name = 'QA Imported profile';
  const uploaded = fixtureApparatusAasx(before), headers = { ...header('qa-import'), 'if-match': '1', 'content-type': fixtureAasxMime };
  const saved = await request('POST', `${url}/aasx`, uploaded, headers);
  assert.equal(saved.status, 200); assert.equal(saved.body.revision.revision_metadata.source, 'aasx_import');
  assert.equal(saved.body.revision.revision_metadata.source_reference, `sha256:${fixtureBytesHash(uploaded)}`); assert.equal(saved.body.revision.display.display_name, 'QA Imported profile');
  assert.equal(saved.body.runtime_projection.source_revision, 2); assert.notEqual(saved.body.aasx_sha256, fixtureBytesHash(uploaded));
  assert.equal((await request('POST', `${url}/aasx`, uploaded, headers)).status, 409);
  const corrupt = new Uint8Array(uploaded); corrupt[50] ^= 1; assert.throws(() => fixtureAasxRevision(corrupt));
  assert.equal((await request('POST', `${url}/aasx`, corrupt, { ...headers, 'if-match': '2', 'idempotency-key': 'qa-corrupt' })).body.error, 'aasx_import_invalid');
  const wrong = await revision(request); wrong.apparatus_id = apparatusIds.print;
  assert.equal((await request('POST', `${url}/aasx`, fixtureApparatusAasx(wrong), { ...headers, 'if-match': '2', 'idempotency-key': 'qa-wrong-id' })).status, 409);
});

test('admin access permits projection reads but never replaces strict canonical manage capability', async () => {
  const { request } = await setup(); await request('POST', '/__qa/config', { capabilities: ['admin.access'] });
  assert.equal((await request('GET', url)).status, 200); assert.equal((await request('GET', `${base}/options`)).status, 403); assert.equal((await request('GET', `${url}/aasx`)).status, 403);
  for (const [method, path, body] of [['POST', base, {}], ['PATCH', url, {}], ['DELETE', url, {}], ['POST', `${url}/aasx`, new Uint8Array()]]) assert.equal((await request(method, path, body, header('qa-no-permission'))).status, 403);
});

test('lost or malformed canonical response retains one committed revision with original proof; later edits change that proof', async () => {
  const { fixture, request } = await setup(), current = await revision(request), input = { expected_revision: 1, patch: { display: { ...current.display, display_name: 'QA Unknown revision' } } };
  await request('POST', '/__qa/config', { rules: [{ method: 'PATCH', path: `${base}/${id}`, dropResponse: true, once: true }] });
  assert.equal((await request('PATCH', url, input, header('qa-loss'))).dropResponse, true);
  let saved = await revision(request); assert.equal(saved.revision_metadata.command_id, 'apparatus-command:qa-loss'); assert.equal(saved.revision_metadata.revision, 2);
  await request('POST', '/__qa/apparatus', { apparatus_id: id, profilePatch: { display: saved.display } }); saved = await revision(request);
  assert.equal(saved.display.display_name, 'QA Unknown revision'); assert.notEqual(saved.revision_metadata.command_id, 'apparatus-command:qa-loss');
  assert.equal(fixture.getLog().filter(row => row.method === 'PATCH' && row.path === `${base}/${id}`).length, 1);
  await request('POST', '/__qa/config', { rules: [{ method: 'PATCH', path: `${base}/${id}`, responseBody: {}, once: true }] });
  assert.deepEqual((await request('PATCH', url, { expected_revision: 3, patch: { display: saved.display } }, header('qa-malformed'))).body, {});
  assert.equal((await revision(request)).revision_metadata.command_id, 'apparatus-command:qa-malformed');
});

test('planning and placement commits update the same native package hash and revision', async () => {
  const { request } = await setup(), capacity = (await revision(request)).capacity;
  const planned = await request('PUT', '/v1/mobile/admin/production-maps/capacity', { apparatus_id: id, expected_revision: 1, capacity: { ...capacity, efficiency_percent: 110 } }, header('qa-plan-package'));
  assert.equal(planned.status, 200); assert.equal((await revision(request)).revision_metadata.command_id, 'apparatus-command:qa-plan-package');
  const placed = await request('PATCH', url, { expected_revision: 2, patch: { placement: { factory_map_object_id: 'node:18:instance:1' } } }, header('qa-placement-package'));
  assert.equal(placed.status, 200); const current = await revision(request); assert.equal(current.capacity.efficiency_percent, 110); assert.equal(current.placement.factory_map_object_id, 'node:18:instance:1');
  assert.equal(fixtureBytesHash((await request('GET', `${url}/aasx`)).body), (await request('GET', url)).body.source_aasx_sha256);
});

test('HTTP binary export/import uses native MIME/If-Match and sanitized byte-length logs without socket binding', async () => {
  const { fixture, request } = await setup(), current = await revision(request), server = createFixtureServer({ fixture });
  const bytes = fixtureApparatusAasx({ ...current, display: { ...current.display, display_name: 'QA HTTP import' } });
  async function invoke(method, path, body, headers) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]); Object.assign(req, { method, url: path, headers });
    const output = []; const res = { headers: {}, headersSent: false, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; }, end(value) { output.push(Buffer.from(value || '')); } };
    await server.listeners('request')[0](req, res); return { ...res, bytes: Buffer.concat(output) };
  }
  const imported = await invoke('POST', `${url}/aasx`, bytes, { ...header('qa-http-import'), 'content-type': fixtureAasxMime, 'if-match': '1', origin: 'http://127.0.0.1:5186' }); assert.equal(imported.status, 200);
  const exported = await invoke('GET', `${url}/aasx`, undefined, { ...auth, origin: 'http://127.0.0.1:5186' }); assert.equal(exported.headers['Content-Type'], fixtureAasxMime); assert.equal(exported.headers['Content-Length'], exported.bytes.length);
  assert.equal(fixtureAasxRevision(exported.bytes).display.display_name, 'QA HTTP import');
  const logged = fixture.getLog().find(row => row.method === 'POST' && row.path.endsWith('/aasx')); assert.deepEqual(logged.body, { syntheticBinary: true, byteLength: bytes.length });
});
