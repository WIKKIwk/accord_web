import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken } from './erp-seed.mjs';

const pm = '/v1/mobile/admin/production-maps';
async function setup() { const fixture = createFixture(); await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin }); return { fixture, request: (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: `Bearer ${fixtureToken}` } }) }; }

test('opt-in closed DEMO cohort adds eight native histories without altering the original/default snapshot', async () => {
  const { request } = await setup(), original = (await request('GET', `${pm}/closed-orders`)).body.closed_orders;
  assert.equal(original.length, 1); assert.equal(original[0].order_id, 'zakaz-4001');
  const active = (await request('GET', `${pm}/sequence`)).body;
  await request('POST', '/__qa/config', { manufacturingDemoCohort: true });
  const rows = (await request('GET', `${pm}/closed-orders`)).body.closed_orders; assert.equal(rows.length, 9); assert.deepEqual(rows[0], original[0]);
  const durations = [], ids = new Set();
  for (const row of rows.slice(1)) {
    assert.match(row.title, /^QA DEMO /); assert.equal(row.logs.length, 8);
    const map = (await request('GET', `${pm}?id=${row.order_id}`)).body.map; assert.equal(map.id, row.order_id); assert.equal(map.order_number, row.order_number);
    const nodes = Object.fromEntries(map.nodes.filter(node => node.kind === 'apparatus').map(node => [node.id, node.apparatus_id]));
    for (const event of row.logs) { assert.equal(event.order_id, row.order_id); assert.equal(event.apparatus, nodes[event.stage_node_id]); assert.equal(ids.has(event.event_id), false); ids.add(event.event_id); assert.ok(event.created_at_unix <= row.completed_at_unix); }
    for (let index = 1; index < row.logs.length; index++) assert.ok(row.logs[index].created_at_unix > row.logs[index - 1].created_at_unix);
    const print = row.logs.filter(event => event.stage_node_id === 'print'); durations.push(print[1].created_at_unix - print[0].created_at_unix + print[3].created_at_unix - print[2].created_at_unix);
  }
  assert.equal(new Set(durations).size, 8); assert.ok(durations.every(value => value > 0)); assert.deepEqual((await request('GET', `${pm}/sequence`)).body, active);
  await request('POST', '/__qa/config', { manufacturingDemoCohort: false }); assert.deepEqual((await request('GET', `${pm}/closed-orders`)).body.closed_orders, original);
});

test('stage-less legacy DEMO record is separate from positive ranking data and the toggle is typed', async () => {
  const { request } = await setup();
  assert.equal((await request('POST', '/__qa/config', { manufacturingDemoCohort: 'true' })).status, 400);
  await request('POST', '/__qa/config', { manufacturingDemoCohort: true, manufacturingDemoInvalidRecord: true });
  const rows = (await request('GET', `${pm}/closed-orders`)).body.closed_orders; assert.equal(rows.length, 10);
  const invalid = rows.find(row => row.order_id === 'zakaz-4099'); assert.ok(invalid); assert.ok(invalid.logs.every(event => event.stage_node_id === ''));
  assert.equal((await request('GET', `${pm}?id=zakaz-4099`)).status, 200);
  await request('POST', '/__qa/config', { emptyClosedHistory: true }); assert.deepEqual((await request('GET', `${pm}/closed-orders`)).body.closed_orders, []);
});
