import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { apparatusIds, fixtureLogin, fixtureToken } from './erp-seed.mjs';

const path = '/v1/mobile/admin/production-maps/paddons';
async function setup(scenario = 'labels') {
  const fixture = createFixture(), request = (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: `Bearer ${fixtureToken}` } });
  assert.equal((await request('POST', '/v1/mobile/auth/login', fixtureLogin)).status, 200);
  assert.equal((await request('POST', '/__qa/paddon-label', { scenario })).status, 200);
  return { fixture, request };
}
test('mounted QR report and offline preparation retain code identity and make no paddon-state mutation', async () => {
  const { fixture, request } = await setup(), before = fixture.getState().state;
  const report = await request('GET', `${path}/qr/report?code=00001`); assert.equal(report.status, 200); assert.equal(report.body.qr_payload, '00001'); assert.equal(report.body.paddon.total_gross_kg, 12);
  const prepared = await request('POST', `${path}/qr/print`, { code: '00001', print_transport: 'offline', printer: 'godex', print_mode: 'label', print_count: 1 });
  assert.equal(prepared.status, 200); assert.equal(prepared.body.print.status, 'prepared'); assert.equal(prepared.body.print.printer_status, 'client_usb_pending'); assert.equal(prepared.body.print.gross_qty, 1); assert.equal(prepared.body.print.unit, 'dona');
  assert.equal(prepared.body.paddon.total_gross_kg, 12); assert.deepEqual(fixture.getState().state, before);
});
test('repeated stateless offline preparation cannot acquire a print lock or replace an active selection', async () => {
  const { fixture, request } = await setup();
  await request('PUT', `${path}/active`, { apparatus: apparatusIds.cut, code: '00001' }); const before = fixture.getState().state;
  for (let index = 0; index < 2; index++) assert.equal((await request('POST', `${path}/qr/print`, { code: '00001', print_transport: 'offline', print_count: 2 })).status, 200);
  assert.deepEqual(fixture.getState().state, before);
  assert.equal((await request('GET', `${path}/active?apparatus=${encodeURIComponent(apparatusIds.cut)}`)).body.code, '00001');
});
test('report and preparation preserve received frozen weights and enforce native visibility separately', async () => {
  const received = await setup('received'), first = (await received.request('GET', `${path}/qr/report?code=00005`)).body;
  assert.equal(first.paddon.total_gross_kg, 77); assert.equal(first.paddon.total_net_kg, 75);
  assert.equal((await received.request('POST', `${path}/qr/print`, { code: '00005', print_transport: 'offline' })).status, 200);
  assert.deepEqual((await received.request('GET', `${path}/qr/report?code=00005`)).body, first);
  const hidden = await setup('visibility'); await hidden.request('POST', '/__qa/config', { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assignedApparatus: [apparatusIds.cut] });
  assert.equal((await hidden.request('GET', `${path}/qr/report?code=00006`)).status, 404); assert.equal((await hidden.request('POST', `${path}/qr/print`, { code: '00006', print_transport: 'offline' })).status, 404);
  assert.equal((await hidden.request('GET', `${path}/qr/report?code=00007`)).status, 200);
});
test('authenticated preparation has no report capability promotion or server-transport fixture path', async () => {
  const { fixture, request } = await setup(), before = fixture.getState().state;
  await request('POST', '/__qa/config', { capabilities: [] });
  assert.equal((await request('GET', `${path}/qr/report?code=00001`)).status, 403);
  assert.equal((await request('POST', `${path}/qr/print`, { code: '00001', print_transport: 'offline' })).status, 200);
  assert.equal((await request('POST', `${path}/qr/print`, { code: '00001' })).status, 400);
  assert.deepEqual(fixture.getState().state, before);
});
test('ordinary partial free-movement setter preserves worker visibility and changes the existing business guard', async () => {
  const { fixture, request } = await setup(); await request('POST', '/__qa/paddon-management', { scenario: 'visibility-on' });
  const initial = (await request('GET', `${path}/management-settings`)).body.settings; assert.deepEqual(initial, { free_movement_enabled: false, worker_visibility_enabled: true });
  assert.equal((await request('GET', `${path}/detail?code=00002`)).body.can_manage_items, false);
  assert.equal((await request('PUT', `${path}/management-settings`, { free_movement_enabled: true })).status, 200);
  assert.equal((await request('GET', `${path}/detail?code=00002`)).body.can_manage_items, true);
  assert.equal((await request('PUT', `${path}/active`, { apparatus: apparatusIds.cut, code: '00002' })).status, 409);
  assert.deepEqual((await request('GET', `${path}/management-settings`)).body.settings, { free_movement_enabled: true, worker_visibility_enabled: true });
  assert.equal((await request('PUT', `${path}/management-settings`, { free_movement_enabled: false })).status, 200);
  assert.equal((await request('GET', `${path}/detail?code=00002`)).body.can_manage_items, false);
  assert.equal(fixture.getState().state.paddonFixture.worker_visibility_enabled, true);
});
test('settings write refusal and applied lost reply preserve the partial-body and observation contracts', async () => {
  const { fixture, request } = await setup(); await request('POST', '/__qa/config', { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' } });
  assert.equal((await request('GET', `${path}/management-settings`)).status, 200);
  assert.equal((await request('PUT', `${path}/management-settings`, { free_movement_enabled: true })).status, 403);
  await request('POST', '/__qa/config', { profileOverride: null, rules: [{ method: 'PUT', path: `${path}/management-settings`, once: true, dropResponse: true }] });
  assert.equal((await request('PUT', `${path}/management-settings`, { free_movement_enabled: true })).dropResponse, true);
  assert.equal((await request('GET', `${path}/management-settings`)).body.settings.free_movement_enabled, true);
  assert.equal(fixture.getLog().filter(row => row.method === 'PUT' && row.path === `${path}/management-settings`).length, 2);
});
