import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken } from './erp-seed.mjs';
const path = '/v1/mobile/admin/production-maps/paddons';
async function setup(scenario = 'paddons') { const fixture = createFixture(), request = (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: 'Bearer ' + fixtureToken } }); await request('POST', '/v1/mobile/auth/login', fixtureLogin); assert.equal((await request('POST', '/__qa/paddons', { scenario })).status, 200); return { fixture, request }; }
test('mounted paddon fixture creates and deletes only unused records with native200 acknowledgement', async () => {
  const { fixture, request } = await setup('empty'), before = fixture.getState().state;
  const created = await request('POST', path + '/create', { location: '  QA Sex  ', note: '  QA Izoh  ' }); assert.equal(created.status, 200); assert.equal(created.body.ok, true); assert.match(created.body.paddon.code, /^\d{5}$/); assert.equal(created.body.paddon.location, 'QA Sex');
  const removed = await request('POST', path + '/delete', { code: created.body.paddon.code }); assert.deepEqual(removed, { status: 200, body: { ok: true } });
  assert.deepEqual(fixture.getState().state.apparatus, before.apparatus); assert.deepEqual(fixture.getState().state.roleAssignments, before.roleAssignments);
});
test('mounted free movement transfers atomically without changing warehouse receipt weights', async () => {
  const { request } = await setup('free-movement'), source = (await request('GET', path + '/detail?code=00002')).body, received = (await request('GET', path + '/detail?code=00005')).body;
  const id = source.items[0].batch_id, moved = await request('POST', path + '/items/add-batch', { code: '00001', progress_batch_ids: [id] }); assert.equal(moved.status, 200); assert.ok(moved.body.items.some(row => row.batch_id === id)); assert.ok(!(await request('GET', path + '/detail?code=00002')).body.items.some(row => row.batch_id === id));
  const receivedAfter = (await request('GET', path + '/detail?code=00005')).body; assert.equal(receivedAfter.paddon.total_gross_kg, received.paddon.total_gross_kg); assert.equal(receivedAfter.paddon.total_net_kg, received.paddon.total_net_kg);
  assert.equal((await request('POST', path + '/unlock', { code: '00005' })).status, 409);
});
test('mounted historical empty deletion and atomic mixed-invalid addition stay native rejections', async () => {
  const { request } = await setup(), before = (await request('GET', path + '/detail?code=00001')).body;
  assert.equal((await request('POST', path + '/delete', { code: '00004' })).status, 409);
  const invalid = await request('POST', path + '/items/add-batch', { code: '00001', progress_batch_ids: ['qa-paddon-wip-2', 'qa-paddon-wip-4'] }); assert.equal(invalid.status, 400); assert.deepEqual((await request('GET', path + '/detail?code=00001')).body.items, before.items);
});
test('mounted applied response loss has no replay or invented receipt lookup', async () => {
  const { fixture, request } = await setup('empty'); await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: path + '/create', once: true, dropResponse: true }] }); const applied = await request('POST', path + '/create', { location: 'QA Sex', note: '' }); assert.equal(applied.dropResponse, true); assert.equal((await request('GET', path + '?limit=200')).body.paddons.length, 1); assert.equal(fixture.getLog().filter(row => row.method === 'POST' && row.path === path + '/create').length, 1);
});
test('reset and capability loss are isolated within the task fixture', async () => { const { request } = await setup(); await request('POST', '/__qa/config', { capabilities: ['apparatus.queue.read'] }); assert.equal((await request('GET', path)).status, 200); assert.equal((await request('POST', path + '/create', { location: '', note: '' })).status, 403); await request('POST', '/__qa/reset', {}); await request('POST', '/v1/mobile/auth/login', fixtureLogin); assert.equal((await request('GET', path)).body.paddons.length, 0); });
