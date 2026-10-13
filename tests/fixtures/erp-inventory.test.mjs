import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { apparatusIds, fixtureLogin, fixtureToken, fixtureSecondLogin, fixtureSecondToken } from './erp-seed.mjs';

const base = '/v1/mobile/admin', inventory = `${base}/inventory`, auth = { authorization: `Bearer ${fixtureToken}` };
async function setup() {
  const fixture = createFixture(); await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin });
  return { fixture, request: (method, url, body, headers = auth) => fixture.dispatch({ method, url, body, headers }) };
}
const selector = { asset_kind: 'raw_material', asset_ref: 'qa-roll-1' };
const selectorTwo = { asset_kind: 'raw_material', asset_ref: 'qa-roll-2' };
const relocation = { ...selector, physical_location_id: 'qa-location-cut', idempotency_key: 'qa-relocate-1' };
const transfer = key => ({ source_warehouse_id: 'QA Xomashyo', destination_warehouse_id: 'QA Tayyor mahsulot', assets: [selectorTwo], idempotency_key: key, note: 'QA Transfer' });

test('relocation and own-warehouse return preserve custody/amount and replay current native assets', async () => {
  const { request } = await setup();
  const moved = (await request('POST', `${inventory}/relocations`, relocation)).body;
  assert.equal(moved.physical_location.id, 'qa-location-cut'); assert.equal(moved.placement_version, 2);
  assert.equal(moved.custody_warehouse_id, 'QA Xomashyo'); assert.equal(moved.qty, 80); assert.equal(Object.hasOwn(moved, 'movement_id'), false);
  assert.deepEqual((await request('POST', `${inventory}/relocations`, relocation)).body, moved);
  assert.equal((await request('POST', `${inventory}/relocations`, { ...relocation, physical_location_id: 'qa-location-print' })).status, 409);
  const returned = (await request('POST', `${inventory}/returns/batch`, { assets: [selector], idempotency_key: 'qa-return-1' })).body;
  assert.equal(returned.length, 1); assert.equal(returned[0].physical_location.id, 'qa-location-stock'); assert.equal(returned[0].placement_version, 3);
  assert.equal(returned[0].custody_warehouse_id, moved.custody_warehouse_id); assert.equal(returned[0].qty, 80);
  assert.deepEqual((await request('POST', `${inventory}/returns/batch`, { assets: [selector], idempotency_key: 'qa-return-1' })).body, returned);
  assert.equal((await request('POST', `${inventory}/returns/batch`, { assets: [selector], idempotency_key: 'new-return' })).status, 409);
});

test('unavailable assets, inactive places and cross-warehouse relocation remain native refusals', async () => {
  const { request } = await setup();
  assert.equal((await request('POST', `${inventory}/relocations`, { ...relocation, physical_location_id: 'qa-location-finished' })).status, 409);
  await request('POST', '/__qa/asset', { kind: 'raw_material', asset_ref: 'qa-roll-1', patch: { status: 'reserved' } }, {});
  assert.equal((await request('POST', `${inventory}/relocations`, relocation)).status, 409);
  assert.equal((await request('POST', `${inventory}/returns/batch`, { assets: [selector], idempotency_key: 'qa-refused' })).status, 409);
  await request('POST', '/__qa/asset', { kind: 'raw_material', asset_ref: 'qa-roll-1', patch: { status: 'available' } }, {});
  await request('PUT', `${base}/factory-locations/qa-factory-cut`, { active: false });
  assert.equal((await request('POST', `${inventory}/relocations`, relocation)).body.error, 'inventory_location_inactive');
});

test('requested/approved transfers reserve assets; cancellation releases them and preserves physical placement', async () => {
  const { fixture, request } = await setup();
  const created = (await request('POST', `${inventory}/transfers`, transfer('qa-transfer-cancel'))).body;
  assert.equal(created.status, 'requested'); assert.equal(created.lines[0].source_physical_location_id, 'qa-location-stock');
  assert.equal(fixture.getState().state.assets[1].status, 'transfer_reserved');
  assert.equal((await request('POST', `${inventory}/transfers`, transfer('qa-transfer-cancel'))).body.id, created.id);
  assert.equal((await request('POST', `${inventory}/transfers`, { ...transfer('qa-transfer-cancel'), destination_warehouse_id: 'QA Bo‘sh ombor' })).status, 409);
  assert.equal((await request('POST', `${inventory}/transfers/${created.id}/approve`, { idempotency_key: 'qa-approve-1' })).body.status, 'approved');
  assert.equal((await request('POST', `${inventory}/transfers/${created.id}/cancel`, { idempotency_key: 'qa-cancel-1' })).body.status, 'cancelled');
  const released = fixture.getState().state.assets[1]; assert.equal(released.status, 'available'); assert.equal(released.transfer_id, ''); assert.equal(released.physical_location.id, 'qa-location-stock'); assert.equal(released.placement_version, 1);
  assert.equal((await request('POST', `${inventory}/transfers/${created.id}/cancel`, { idempotency_key: 'qa-cancel-1' })).body.id, created.id);
  assert.equal((await request('POST', `${inventory}/transfers/${created.id}/receive`, { idempotency_key: 'qa-bad-receive' })).status, 409);
});

test('dispatch/receive retain native transfer identity and change custody only on receiving', async () => {
  const { fixture, request } = await setup();
  const created = (await request('POST', `${inventory}/transfers`, transfer('qa-transfer-receive'))).body;
  for (const action of ['approve', 'dispatch']) assert.equal((await request('POST', `${inventory}/transfers/${created.id}/${action}`, { idempotency_key: `qa-${action}-2` })).status, 200);
  const inTransit = fixture.getState().state.assets[1]; assert.equal(inTransit.status, 'in_transit'); assert.equal(inTransit.custody_warehouse_id, 'QA Xomashyo'); assert.equal(inTransit.physical_location.id, 'qa-location-stock');
  assert.equal((await request('POST', `${inventory}/transfers/${created.id}/cancel`, { idempotency_key: 'qa-too-late' })).status, 409);
  const received = (await request('POST', `${inventory}/transfers/${created.id}/receive`, { idempotency_key: 'qa-receive-2' })).body;
  assert.equal(received.status, 'received'); assert.equal(received.id, created.id);
  const placed = fixture.getState().state.assets[1]; assert.equal(placed.custody_warehouse_id, 'QA Tayyor mahsulot'); assert.equal(placed.physical_location.id, 'qa-location-finished'); assert.equal(placed.status, 'available'); assert.equal(placed.placement_version, 2);
  assert.equal((await request('POST', `${inventory}/transfers`, transfer('qa-transfer-receive'))).body.status, 'received');
  assert.equal((await request('GET', `${inventory}/transfers?direction=incoming&status=received&limit=20`)).body[0].id, created.id);
});

test('internal assigned transfers complete immediately while admin access never substitutes inventory capability', async () => {
  const { fixture, request } = await setup();
  await request('POST', '/__qa/config', { assignedWarehouses: ['QA Xomashyo', 'QA Tayyor mahsulot'] }, {});
  assert.equal((await request('POST', `${inventory}/transfers`, transfer('qa-internal'))).body.status, 'received');
  assert.equal(fixture.getState().state.assets[1].custody_warehouse_id, 'QA Tayyor mahsulot');
  await request('POST', '/__qa/config', { capabilities: ['admin.access', 'factory.location.manage'] }, {});
  assert.equal((await request('GET', `${base}/factory-locations`)).status, 200);
  assert.equal((await request('GET', `${inventory}/locations`)).status, 403); assert.equal((await request('GET', `${inventory}/assets`)).status, 403);
  assert.equal((await request('POST', `${inventory}/relocations`, relocation)).status, 403);
  await request('POST', '/__qa/config', { capabilities: ['admin.access', 'inventory.movement.manage'] }, {});
  assert.equal((await request('GET', `${inventory}/locations`)).status, 200); assert.equal((await request('GET', `${base}/factory-locations`)).status, 403);
});

test('factory create/edit/full membership/retirement preserve IDs and explicit inventory projection references', async () => {
  const { fixture, request } = await setup();
  const created = (await request('POST', `${base}/factory-locations`, { name: 'QA New state', apparatus_ids: [apparatusIds.laminate] })).body;
  assert.match(created.id, /^state_[0-9a-f]{32}$/); assert.equal(created.apparatus[0].id, apparatusIds.laminate); assert.equal(created.apparatus[0].source_revision, 1);
  const edited = (await request('PUT', `${base}/factory-locations/${created.id}`, { name: 'QA Edited state', active: true })).body;
  assert.equal(edited.id, created.id); assert.equal(edited.created_at_unix, created.created_at_unix);
  const bound = (await request('PUT', `${base}/factory-locations/${created.id}/apparatus`, { apparatus_ids: [apparatusIds.print, apparatusIds.cut] })).body;
  assert.deepEqual(bound.apparatus.map(row => row.id), [apparatusIds.print, apparatusIds.cut]);
  const physical = (await request('GET', `${inventory}/locations`)).body.find(row => row.factory_location_id === created.id);
  assert.equal(physical.name, 'QA Edited state');
  await request('POST', `${inventory}/relocations`, { ...selector, physical_location_id: physical.id, idempotency_key: 'qa-new-state-relocate' });
  const retired = (await request('PUT', `${base}/factory-locations/${created.id}`, { active: false })).body;
  assert.equal(retired.active, false); assert.deepEqual(retired.apparatus, bound.apparatus);
  assert.equal(fixture.getState().state.assets[0].physical_location.id, physical.id);
  assert.equal((await request('DELETE', `${base}/factory-locations/${created.id}`)).status, 405);
  assert.equal((await request('POST', `${base}/factory-locations`, { name: 'QA Edited state', apparatus_ids: [] })).status, 409);
});

test('warehouse-scoped native feeds mean owned state assets, never last moved by actor', async () => {
  const { request } = await setup();
  await request('POST', '/__qa/config', { capabilities: ['inventory.movement.manage'], assignedWarehouses: ['QA Xomashyo'] }, {});
  const ownedStates = (await request('GET', `${inventory}/assets?current_user_states_only=true&limit=100`)).body;
  assert.deepEqual(ownedStates.map(row => row.asset_ref), ['qa-roll-1']);
  await request('POST', '/__qa/config', { assignedWarehouses: ['QA Tayyor mahsulot'] }, {});
  assert.deepEqual((await request('GET', `${inventory}/assets`)).body, []);
  assert.equal((await request('POST', `${inventory}/relocations`, relocation)).status, 403);
});

test('applied lost-response relocation is observable by read without invented undo or CAS', async () => {
  const { fixture, request } = await setup();
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${inventory}/relocations`, dropResponse: true, once: true }] }, {});
  assert.equal((await request('POST', `${inventory}/relocations`, relocation)).dropResponse, true);
  const current = (await request('GET', `${inventory}/assets?query=qa-roll-1&asset_kind=raw_material&limit=100`)).body[0];
  assert.equal(current.physical_location.id, 'qa-location-cut'); assert.equal(current.placement_version, 2);
  const writes = fixture.getLog().filter(row => row.method === 'POST' && row.path === `${inventory}/relocations`); assert.equal(writes.length, 1);
  assert.equal(Object.hasOwn(writes[0].body, 'expected_placement_version'), false);
  assert.equal((await request('POST', `${inventory}/undo`, {})).body.error, 'fixture_route_not_implemented');
});

test('two synthetic admin identities have independent tokens and sanitized session transitions', async () => {
  const { fixture, request } = await setup();
  const second = await request('POST', '/v1/mobile/auth/login', fixtureSecondLogin, {});
  assert.equal(second.body.profile.ref, 'qa-admin-2'); assert.equal(second.body.token, fixtureSecondToken);
  await request('POST', '/v1/mobile/auth/logout');
  assert.equal((await request('GET', '/v1/mobile/me')).status, 401);
  assert.equal((await request('GET', '/v1/mobile/me', undefined, { authorization: `Bearer ${fixtureSecondToken}` })).body.ref, 'qa-admin-2');
  const log = JSON.stringify(fixture.getLog()); for (const value of [fixtureLogin.phone, fixtureLogin.code, fixtureToken, fixtureSecondLogin.phone, fixtureSecondLogin.code, fixtureSecondToken]) assert.equal(log.includes(value), false);
});
