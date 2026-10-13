import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createFixture, createFixtureServer } from './erp-fixture.mjs';
import { apparatusIds, fixtureCapabilities, fixtureLogin, fixtureToken } from './erp-seed.mjs';

const base = '/v1/mobile/admin';
const auth = { authorization: `Bearer ${fixtureToken}` };
async function setup() {
  const fixture = createFixture();
  const login = await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin });
  assert.equal(login.status, 200);
  const request = (method, url, body, headers = auth) => fixture.dispatch({ method, url, body, headers });
  return { fixture, request };
}
const mapId = 'zakaz-qa-1001';

async function httpRequest(server, { method = 'GET', url = '/__qa/health', origin = 'http://127.0.0.1:5186', body, requestHeaders = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { ...(origin ? { origin } : {}), ...requestHeaders } });
  return new Promise(resolve => {
    const headers = {}, chunks = [];
    const res = { headersSent: false, status: 200,
      setHeader(key, value) { headers[key.toLowerCase()] = value; },
      writeHead(status, values) { this.headersSent = true; this.status = status; for (const [key, value] of Object.entries(values)) headers[key.toLowerCase()] = value; },
      flushHeaders() { this.headersSent = true; },
      write(content, callback) { chunks.push(Buffer.from(content)); callback?.(); return true; },
      end(content) { resolve({ status: this.status, headers, body: content ? JSON.parse(content) : null }); },
      destroy() { resolve({ status: 'lost', responseStatus: this.status, headers, headersSent: this.headersSent, partialBody: Buffer.concat(chunks).toString('utf8') }); },
    };
    server.emit('request', req, res);
  });
}

test('auth uses only synthetic credentials and logs neither phone/code nor bearer values', async () => {
  const fixture = createFixture();
  assert.equal((await fixture.dispatch({ url: '/v1/mobile/me' })).status, 401);
  assert.equal((await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: { ...fixtureLogin, code: 'wrong' } })).status, 401);
  const result = await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin });
  assert.equal(result.body.token, fixtureToken);
  assert.deepEqual(result.body.capabilities, fixtureCapabilities);
  assert.equal((await fixture.dispatch({ url: '/v1/mobile/me', headers: auth })).body.ref, 'qa-admin');
  const logs = JSON.stringify(fixture.getLog());
  assert.ok(!logs.includes(fixtureLogin.phone)); assert.ok(!logs.includes(fixtureLogin.code)); assert.ok(!logs.includes(fixtureToken));
  assert.match(logs, /redacted/);
  await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/logout', headers: auth });
  assert.equal((await fixture.dispatch({ url: '/v1/mobile/me', headers: auth })).status, 401);
});

test('native saved-map and calculation-source responses are deterministic and lossless', async () => {
  const { request } = await setup();
  const saved = (await request('GET', `${base}/production-maps?id=${mapId}`)).body;
  assert.equal(saved.map.id, mapId); assert.equal(saved.program.map_id, mapId);
  assert.ok(saved.map.nodes.some(node => node.kind === 'start')); assert.ok(saved.map.nodes.some(node => node.kind === 'end'));
  assert.ok(saved.map.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  const source = (await request('GET', `${base}/production-maps/order-edit?id=${mapId}`)).body;
  assert.deepEqual(source.map, saved.map); assert.equal(source.template.frame_count, 2); assert.equal(source.revision, 1);
  const snapshot = (await request('GET', `${base}/production-maps/sequence`)).body;
  assert.equal(snapshot.rev, 1); assert.equal(snapshot.epoch, 'qa-local-epoch-1');
  assert.equal(snapshot.stage_states['zakaz-qa-1002'].print, 'in_progress');
  const pendingPrint = snapshot.queue_action_controls[apparatusIds.print][mapId];
  assert.equal(pendingPrint.interaction.mode, 'fresh_start_blocked');
  assert.equal(pendingPrint.interaction.blocking_reason_code, 'waiting_sequence');
  const pendingLaminate = snapshot.queue_action_controls[apparatusIds.laminate][mapId];
  assert.equal(pendingLaminate.interaction.mode, 'waiting_previous_stage');
  assert.equal(pendingLaminate.interaction.blocking_reason_code, 'waiting_previous_stage');
  assert.equal(pendingLaminate.previous_stage, apparatusIds.print);
  assert.equal(pendingLaminate.interaction.previous_wip_mode, 'waiting');
  assert.equal((await request('GET', `${base}/production-maps/order-edit?id=zakaz-qa-1002`)).status, 409);
});

test('native map PUT preserves order metadata, rejects started changes, and permits future changes', async () => {
  const { request } = await setup();
  const saved = (await request('GET', `${base}/production-maps?id=zakaz-qa-1002`)).body;
  const locked = structuredClone(saved.map); locked.nodes.find(node => node.id === 'print').x += 10;
  assert.equal((await request('PUT', `${base}/production-maps`, locked)).body.error, 'production_map_started_stage_locked');
  const future = structuredClone(saved.map); future.nodes.find(node => node.id === 'cut').x += 10;
  // Browser graph adapters emit empty native branches/defaults omitted by serde.
  future.edges = future.edges.map(edge => ({ ...edge, branch: '' }));
  future.nodes = future.nodes.map(node => ({ ...node, alternative_assigned_apparatus_id: '' }));
  const result = await request('PUT', `${base}/production-maps`, future);
  assert.equal(result.status, 200); assert.deepEqual(result.body.map, future);
  const calculation = structuredClone(future); calculation.order_kg = 900;
  assert.equal((await request('PUT', `${base}/production-maps`, calculation)).body.error, 'production_map_opened_order_calculation_locked');
  assert.equal((await request('GET', `${base}/production-maps/sequence`)).body.rev, 2);
});

test('fixture control can simulate a concurrent saved-map change and a newly-started stage', async () => {
  const { request } = await setup();
  await request('POST', '/__qa/order', { id: mapId, nodePatch: { id: 'cut', x: 999 }, stageStates: { print: 'in_progress' } }, {});
  const state = (await request('GET', `${base}/production-maps/sequence`)).body;
  assert.equal(state.maps[0].map.nodes.find(node => node.id === 'cut').x, 999);
  assert.equal(state.queue_states[apparatusIds.print][mapId], 'in_progress');
  assert.equal(state.stage_states[mapId].print, 'in_progress'); assert.equal(state.rev, 2);
});

test('factory placement commits a canonical revision and command identity without duplicate replay', async () => {
  const { request } = await setup(), path = `${base}/apparatus/${encodeURIComponent(apparatusIds.spare)}`;
  const payload = { expected_revision: 1, patch: { placement: { factory_map_object_id: 'node:18:instance:1' } } };
  const headers = { ...auth, 'idempotency-key': 'qa-placement-request-1' };
  const saved = await request('PATCH', path, payload, headers);
  assert.equal(saved.status, 200); assert.equal(saved.body.runtime_projection.source_revision, 2);
  assert.equal(saved.body.revision.revision_metadata.command_id, 'apparatus-command:qa-placement-request-1');
  assert.equal((await request('PATCH', path, payload, headers)).status, 409);
  assert.equal((await request('PATCH', path, { ...payload, patch: { placement: null } }, headers)).status, 409);
  assert.equal((await request('PATCH', path, payload, { ...auth, 'idempotency-key': 'qa-new-key' })).body.error, 'apparatus_revision_conflict');
});

test('catalog CRUD and group partial-200 response match the native result DTO', async () => {
  const { request } = await setup();
  await request('POST', `${base}/items`, { code: 'QA-NEW-1', name: 'QA New film', uom: 'kg', item_group: 'Xomashyo' });
  const renamed = await request('PUT', `${base}/items/detail`, { original_code: 'QA-NEW-1', code: 'QA-NEW-2', name: 'QA Renamed film' });
  assert.equal(renamed.body.code, 'QA-NEW-2');
  await request('POST', '/__qa/config', { partialMoveCodes: ['QA-PE-50'] }, {});
  const partial = await request('POST', `${base}/items/bulk-move-group`, { item_codes: ['QA-PET-12', 'QA-PE-50'], item_group: 'QA Yangi guruh' });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.body, { item_group: 'QA Yangi guruh', requested_count: 2, updated_count: 1, failed_count: 1, updated_item_codes: ['QA-PET-12'], failed_item_codes: ['QA-PE-50'] });
  assert.equal((await request('GET', `${base}/items/detail?code=QA-PE-50`)).body.item_group, 'Xomashyo');
  assert.equal((await request('DELETE', `${base}/items/detail?code=QA-NEW-2`)).body.ok, true);
});

test('supplier/customer state is editable while rotated codes are absent from logs and stored data', async () => {
  const { fixture, request } = await setup();
  const supplier = `${base}/suppliers`;
  await request('PUT', `${supplier}/phone?ref=QA-SUPPLIER-1`, { phone: '+998900000099' });
  await request('PUT', `${supplier}/status?ref=QA-SUPPLIER-1`, { blocked: true });
  await request('POST', `${supplier}/items/add?ref=QA-SUPPLIER-1`, { item_code: 'QA-PE-50' });
  const detail = (await request('GET', `${supplier}/detail?ref=QA-SUPPLIER-1`)).body;
  assert.equal(detail.blocked, true); assert.equal(detail.assigned_items.length, 2);
  const rotated = (await request('POST', `${supplier}/code/regenerate?ref=QA-SUPPLIER-1`)).body;
  assert.equal(rotated.code, 'QA-ROTATED-1');
  assert.deepEqual((await request('DELETE', `${supplier}/remove?ref=QA-SUPPLIER-1`)).body, { ok: true });
  assert.equal((await request('GET', `${supplier}/inactive`)).body.length, 1);
  assert.equal((await request('GET', `${supplier}/list`)).body.length, 0);
  await request('POST', `${supplier}/restore?ref=QA-SUPPLIER-1`);
  assert.equal((await request('GET', `${supplier}/inactive`)).body.length, 0);
  assert.ok(!JSON.stringify(fixture.getLog()).includes('QA-ROTATED-1'));
  assert.ok(!JSON.stringify(fixture.getState()).includes('QA-ROTATED-1'));
  const customer = `${base}/customers`;
  assert.equal((await request('PUT', `${customer}/phone?ref=QA-CUSTOMER-1`, { phone: '900000099' })).body.phone, '+998900000099');
  assert.deepEqual((await request('DELETE', `${customer}/remove?ref=QA-CUSTOMER-1`)).body, { ok: true });
  assert.equal((await request('PUT', `${base}/item-groups`, { name: 'QA Yangi guruh', parent: '' })).body.parent_item_group, 'All Item Groups');
});

test('warehouse empty-only deletion and identity dependency checks remain stateful', async () => {
  const { request } = await setup();
  assert.equal((await request('DELETE', `${base}/warehouses`, { warehouse: 'QA Xomashyo', delete_products: false })).status, 409);
  assert.deepEqual((await request('DELETE', `${base}/warehouses`, { warehouse: 'QA Bo‘sh ombor', delete_products: false })).body, { warehouse: 'QA Bo‘sh ombor', deleted_product_count: 0, deleted_assignment_count: 0 });
  assert.equal((await request('GET', `${base}/workers/delete-check?id=qa-worker-1`)).body.requires_confirmation, true);
  assert.equal((await request('DELETE', `${base}/workers?id=qa-worker-1`)).status, 409);
  assert.equal((await request('DELETE', `${base}/workers?id=qa-worker-1&confirm_connections=true`)).body.ok, true);
  assert.equal((await request('GET', `${base}/workers/detail?id=qa-worker-1`)).body.blocked, true);
  assert.equal((await request('GET', `${base}/warehouses/assignments`)).body.length, 0);
});

test('native role and assignment contracts use actual principal references', async () => {
  const { request } = await setup();
  const role = { id: 'qa-reviewer', label: 'QA Reviewer', capability_codes: ['catalog.item.read'] };
  assert.equal((await request('PUT', `${base}/roles`, role)).body.system, false);
  const assignment = { principal_role: 'aparatchi', principal_ref: 'qa-worker-2', role_id: role.id, assigned_apparatus: [], assigned_item_groups: [] };
  assert.deepEqual((await request('PUT', `${base}/role-assignments`, assignment)).body, assignment);
  assert.equal((await request('PUT', `${base}/roles`, { ...role, id: 'admin' })).status, 409);
  const users = (await request('GET', `${base}/users/list?offset=0&limit=50`)).body;
  assert.equal(users.has_more, false); assert.equal(users.items.find(row => row.id === 'worker:qa-worker-2').entity_ref, 'qa-worker-2');
});

test('permission revocation returns HTTP403 without depending on the browser session cache', async () => {
  const { request } = await setup();
  await request('POST', '/__qa/config', { capabilities: ['admin.access'] }, {});
  assert.equal((await request('GET', `${base}/roles`)).status, 403);
  const map = (await request('GET', `${base}/production-maps?id=${mapId}`)).body.map;
  assert.equal((await request('PUT', `${base}/production-maps`, map)).status, 200);
  await request('POST', '/__qa/config', { capabilities: ['apparatus.queue.read'] }, {});
  assert.equal((await request('PUT', `${base}/production-maps`, map)).status, 403);
});

test('one-shot failures, response loss and delay are configurable without automatic request replay', async () => {
  const { fixture, request } = await setup();
  await request('POST', '/__qa/config', { rules: [{ method: 'GET', path: `${base}/items`, status: 500, error: 'store_failed', once: true }] }, {});
  assert.equal((await request('GET', `${base}/items`)).status, 500);
  assert.equal((await request('GET', `${base}/items`)).status, 200);
  await request('POST', '/__qa/config', { rules: [{ method: 'PUT', path: `${base}/production-maps`, dropResponse: true, once: true, delayMs: 5 }] }, {});
  const map = (await request('GET', `${base}/production-maps?id=${mapId}`)).body.map; map.nodes.find(node => node.id === 'cut').x = 700;
  const result = await request('PUT', `${base}/production-maps`, map);
  assert.equal(result.dropResponse, true);
  assert.equal((await request('GET', `${base}/production-maps?id=${mapId}`)).body.map.nodes.find(node => node.id === 'cut').x, 700);
  assert.equal(fixture.getLog().filter(row => row.method === 'PUT').length, 1);
  assert.equal(fixture.getLog().find(row => row.method === 'PUT').status, 'lost');
});

test('reset clears sessions/logs/mutations and advances the synthetic epoch', async () => {
  const { fixture, request } = await setup();
  await request('POST', '/__qa/order', { id: mapId, nodePatch: { id: 'cut', x: 999 } }, {});
  const reset = await request('POST', '/__qa/reset', {}, {});
  assert.equal(reset.body.epoch, 'qa-local-epoch-2'); assert.equal(fixture.getState().state.rev, 1);
  assert.equal(fixture.getState().state.orders[0].map.nodes.find(node => node.id === 'cut').x, 420);
  assert.deepEqual(fixture.getLog(), []);
  assert.equal((await request('GET', '/v1/mobile/me')).status, 401);
});

test('HTTP handler allows only listed localhost origins and supports native PATCH preflight headers', async () => {
  const server = createFixtureServer();
  const health = await httpRequest(server);
  assert.equal(health.status, 200); assert.equal(health.body.synthetic, true);
  assert.equal(health.headers['access-control-allow-origin'], 'http://127.0.0.1:5186');
  assert.equal((await httpRequest(server, { origin: 'http://localhost:5186' })).status, 200);
  const options = await httpRequest(server, { method: 'OPTIONS', url: `${base}/apparatus/${encodeURIComponent(apparatusIds.spare)}` });
  assert.equal(options.status, 204); assert.match(options.headers['access-control-allow-methods'], /PATCH/); assert.match(options.headers['access-control-allow-headers'], /Idempotency-Key/);
  assert.equal((await httpRequest(server, { origin: 'https://example.org' })).status, 403);
  assert.equal((await httpRequest(server, { origin: 'http://127.0.0.1:5999' })).status, 403);
  assert.throws(() => createFixtureServer({ webPorts: [0] }));
});

test('response-loss HTTP handler flushes status/CORS and an incomplete body before closing', async () => {
  const { fixture, request } = await setup();
  const server = createFixtureServer({ fixture });
  await request('POST', '/__qa/config', { rules: [{ method: 'PUT', path: `${base}/production-maps`, dropResponse: true, once: true }] }, {});
  const map = (await request('GET', `${base}/production-maps?id=${mapId}`)).body.map;
  map.nodes.find(node => node.id === 'cut').x = 701;
  const lost = await httpRequest(server, { method: 'PUT', url: `${base}/production-maps`, body: map, requestHeaders: auth });
  assert.equal(lost.status, 'lost'); assert.equal(lost.responseStatus, 200); assert.equal(lost.headersSent, true);
  assert.equal(lost.headers['access-control-allow-origin'], 'http://127.0.0.1:5186');
  assert.match(lost.headers['content-type'], /application\/json/);
  assert.ok(Number(lost.headers['content-length']) > Buffer.byteLength(lost.partialBody));
  assert.throws(() => JSON.parse(lost.partialBody));
  assert.equal((await request('GET', `${base}/production-maps?id=${mapId}`)).body.map.nodes.find(node => node.id === 'cut').x, 701);
  assert.equal(fixture.getLog().filter(row => row.method === 'PUT').length, 1);
});

test('materials use native ok/material DTOs and normalize micron coefficient and active ordering', async () => {
  const { request } = await setup();
  assert.equal((await request('GET', `${base}/calculate-materials`)).body.ok, true);
  const material = { id: 'qa-pet', name: 'PET QA', active: true, density_g_cm3: 1.5, variants: [{ micron: 12, coefficient: 1.008, actual_gsm: 16.8 }, { micron: 20, coefficient: 1.8 }] };
  const saved = await request('PUT', `${base}/calculate-materials`, material);
  assert.equal(saved.body.ok, true); assert.ok(Math.abs(saved.body.material.variants[1].coefficient - 1.8) < 1e-10);
  const ordered = await request('PUT', `${base}/calculate-materials/sequence`, { material_ids: ['qa-pe', 'qa-pet'] });
  assert.deepEqual(ordered.body.materials.map(row => row.id), ['qa-pe', 'qa-pet']);
});

test('raw stock lookup/candidate/diagnostic and assign/unlink contracts preserve physical identity', async () => {
  const { request } = await setup();
  const path = `${base}/raw-material-assignments`, barcode = 'QA-ROLL-1';
  const stock = (await request('GET', `${base}/raw-material-stock?warehouse=QA%20Xomashyo&limit=500`)).body;
  assert.equal(stock[0].id, 'qa-roll-1');
  const candidates = (await request('GET', `${path}/candidate-orders?barcode=${barcode}`)).body;
  assert.equal(candidates[0].order.map.id, mapId); assert.deepEqual(candidates[0].apparatus_options, [apparatusIds.print]);
  const diagnostic = (await request('GET', `${path}/diagnostics?barcode=${barcode}&order_id=${mapId}&apparatus=${encodeURIComponent(apparatusIds.print)}`)).body;
  assert.equal(diagnostic.compatible, true); assert.equal(diagnostic.apparatus, apparatusIds.print);
  const assignment = (await request('POST', path, { order_id: mapId, barcode, apparatus: apparatusIds.print })).body;
  assert.equal(assignment.execution_status, 'ready'); assert.equal(assignment.stock_warehouse, 'QA Xomashyo');
  assert.equal((await request('GET', `${path}/lookup?barcode=${barcode}`)).body.order.map.id, mapId);
  const removed = (await request('DELETE', path, { order_id: mapId, barcode })).body;
  assert.equal(removed.ok, true); assert.deepEqual(removed.assignment, assignment);
  assert.equal((await request('GET', `${path}/lookup?barcode=${barcode}`)).body.assignment, null);
});

test('order freeze/unfreeze and pause/resume produce native receipts and snapshot readback', async () => {
  const { request } = await setup(), id = 'zakaz-qa-1002';
  const pause = (await request('POST', `${base}/production-maps/queue-action`, { order_id: id, apparatus: apparatusIds.print, action: 'pause', produced_qty: 1250, uom: 'm', print_transport: 'offline', include_control: true })).body;
  assert.equal(pause.states[id], 'paused'); assert.equal(pause.progress_batch.action, 'pause'); assert.equal(pause.progress_batch.apparatus, apparatusIds.print);
  assert.equal((await request('POST', `${base}/production-maps/queue-action`, { order_id: id, apparatus: apparatusIds.print, action: 'resume', include_control: true })).body.states[id], 'in_progress');
  assert.equal((await request('POST', `${base}/production-maps/order-control`, { order_id: id, action: 'freeze' })).body.control.state, 'frozen');
  assert.equal((await request('POST', `${base}/production-maps/order-control`, { order_id: id, action: 'unfreeze' })).body.control.state, 'active');
});

test('sequence command uses native 64-hex version and replays the same idempotent receipt', async () => {
  const { request } = await setup();
  const before = (await request('GET', `${base}/production-maps/sequence`)).body;
  assert.match(before.sequence_versions[apparatusIds.laminate], /^[a-f0-9]{64}$/);
  const command = { apparatus: apparatusIds.laminate, order_id: mapId, after_order_id: 'zakaz-qa-1002', expected_version: before.sequence_versions[apparatusIds.laminate], idempotency_key: 'qa-sequence-1' };
  const result = await request('POST', `${base}/production-maps/sequence`, command);
  assert.deepEqual(result.body.order_ids, ['zakaz-qa-1002', mapId, 'zakaz-qa-1003']);
  assert.deepEqual((await request('POST', `${base}/production-maps/sequence`, command)).body, result.body);
});
