import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken } from './erp-seed.mjs';

const base = '/v1/mobile/admin', auth = { authorization: `Bearer ${fixtureToken}` };
async function setup() {
  const fixture = createFixture(); await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin });
  return { fixture, request: (method, url, body) => fixture.dispatch({ method, url, body, headers: auth }) };
}

test('worker and system create return native generated identities and flat bound receipts', async () => {
  const { request } = await setup();
  const worker = await request('POST', `${base}/workers`, { name: ' QA New worker ', phone: '', level: 'master' });
  assert.equal(worker.status, 200); assert.match(worker.body.id, /^worker_[a-f0-9]{24}$/);
  assert.deepEqual(Object.keys(worker.body).sort(), ['id', 'level', 'name', 'phone']);
  assert.equal(worker.body.name, 'QA New worker'); assert.equal(worker.body.level, 'Master'); assert.equal(worker.body.phone, '');
  const user = await request('POST', `${base}/system-users`, { role: 'boyoqchi', name: ' QA New painter ', phone: '+998900000080' });
  assert.equal(user.status, 200); assert.match(user.body.id, /^boyoqchi_[a-f0-9]{24}$/);
  assert.deepEqual(Object.keys(user.body).sort(), ['id', 'name', 'phone', 'role']);
  assert.equal(user.body.name, 'QA New painter'); assert.equal(user.body.phone, '+998900000080');
  assert.equal((await request('POST', `${base}/workers`, { name: 'QA Invalid', level: 'unknown' })).status, 400);
  assert.equal((await request('POST', `${base}/system-users`, { role: 'admin', name: 'QA Invalid', phone: '1' })).status, 400);
  assert.equal((await request('POST', `${base}/system-users`, { role: 'boyoqchi', name: 'QA Duplicate', phone: '+998900000080' })).status, 409);
  assert.equal((await request('GET', `${base}/system-users?role=boyoqchi&limit=500`)).body.some(row => row.id === user.body.id), true);
});

test('finished group ancestry requires a customer and generates the actual product code', async () => {
  const { fixture, request } = await setup();
  const input = { code: 'IGNORED-REQUEST-CODE', name: ' QA Finished child ', uom: 'kg', item_group: 'QA Tayyor paketlar' };
  assert.equal((await request('POST', `${base}/items`, input)).body.error, 'finished_goods_customer_required');
  assert.equal((await request('POST', `${base}/items`, { ...input, customer_ref: 'QA-MISSING' })).status, 404);
  const created = (await request('POST', `${base}/items`, { ...input, customer_ref: 'QA-CUSTOMER-1' })).body;
  assert.match(created.code, /^[A-F0-9]{24}$/); assert.notEqual(created.code, input.code);
  assert.deepEqual(Object.keys(created).sort(), ['code', 'item_group', 'name', 'uom']); assert.equal(created.name, 'QA Finished child');
  assert.equal(fixture.getState().state.customers[0].assigned_item_codes.includes(created.code), true);
  const exact = (await request('POST', `${base}/items`, { code: 'QA-EXACT-CREATE', name: 'QA Exact', uom: 'kg', item_group: 'Xomashyo' })).body;
  assert.equal(exact.code, 'QA-EXACT-CREATE'); assert.equal(exact.item_group, 'Xomashyo');
});

test('group, warehouse and party create receipts contain native defaults and bound fields', async () => {
  const { fixture, request } = await setup();
  const group = (await request('POST', `${base}/item-groups`, { name: ' QA Create group ', parent: '', is_group: false })).body;
  assert.deepEqual(group, { name: 'QA Create group', item_group_name: 'QA Create group', parent_item_group: 'All Item Groups', is_group: false });
  const warehouse = (await request('POST', `${base}/warehouses`, { warehouse: ' QA Create warehouse ', company: ' QA Synthetic ', parent_warehouse: '', is_group: false })).body;
  assert.deepEqual(warehouse, { warehouse: 'QA Create warehouse', company: 'QA Synthetic', parent_warehouse: '', is_group: false });
  const customer = (await request('POST', `${base}/customers`, { name: 'QA Create customer', phone: '900000081' })).body;
  assert.equal(customer.phone, '+998900000081'); assert.deepEqual(Object.keys(customer).sort(), ['name', 'phone', 'ref']);
  const supplier = (await request('POST', `${base}/suppliers`, { name: 'QA Create supplier', phone: '+998900000082' })).body;
  assert.equal(supplier.blocked, false); assert.equal(supplier.removed, false); assert.equal(supplier.assigned_item_count, 0); assert.deepEqual(supplier.assigned_item_codes, []);
  assert.equal(supplier.code, 'QA-CREATED-SUPPLIER-CODE');
  assert.equal(fixture.getState().state.suppliers.some(row => Object.hasOwn(row, 'code')), false);
  assert.equal(JSON.stringify(fixture.getLog()).includes('+998900000082'), false);
});

test('HTTP200 response override is applied after the real write and never invents a successful native refusal', async () => {
  const { fixture, request } = await setup();
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${base}/workers`, responseBody: {}, once: true }] });
  const result = await request('POST', `${base}/workers`, { name: 'QA Unknown receipt', level: 'Master', phone: '' });
  assert.equal(result.status, 200); assert.deepEqual(result.body, {}); assert.equal(result.responseOverridden, true);
  assert.equal(fixture.getState().state.workers.filter(row => row.name === 'QA Unknown receipt').length, 1);
  assert.equal(fixture.getLog().find(row => row.path === `${base}/workers`).responseOverridden, true);
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${base}/workers`, responseBody: {} }] });
  assert.equal((await request('POST', `${base}/workers`, { name: 'QA Invalid', level: 'unknown' })).status, 400);
  assert.equal((await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${base}/workers`, responseBody: 'not-json-object' }] })).status, 400);
});
