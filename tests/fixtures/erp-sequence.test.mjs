import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { apparatusIds, fixtureLogin, fixtureToken } from './erp-seed.mjs';
import { sequenceFixtureIds as ids } from './erp-sequence.mjs';

const path = '/v1/mobile/admin/production-maps/sequence', app = apparatusIds.print;
async function setup() {
  const fixture = createFixture();
  const call = (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: `Bearer ${fixtureToken}` } });
  await call('POST', '/__qa/sequence', {}); await call('POST', '/v1/mobile/auth/login', fixtureLogin);
  const snapshot = (await call('GET', path)).body;
  const move = { apparatus: app, order_id: ids.c, before_order_id: ids.a, expected_version: snapshot.sequence_versions[app], idempotency_key: 'native-sequence-key' };
  return { fixture, call, snapshot, move };
}
test('opt-in cohort keeps frozen display rows and hidden canonical members distinct', async () => {
  const { snapshot } = await setup();
  assert.ok(snapshot.visible_order_ids[app].includes(ids.frozen)); assert.ok(snapshot.visible_order_ids[app].includes(ids.rawFrozen)); assert.ok(!snapshot.visible_order_ids[app].includes(ids.hidden));
  assert.deepEqual(snapshot.sequences[app], [ids.running, ids.paused, ids.a, ids.b, ids.c, ids.hidden]);
});
test('move is versioned, preserves hidden membership, and returns a durable exact-key receipt', async () => {
  const { call, move } = await setup(), first = await call('POST', path, move);
  assert.equal(first.status, 200); assert.deepEqual(first.body.order_ids, [ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]);
  assert.equal((await call('GET', path)).body.sequence_versions[app], first.body.version);
  assert.deepEqual((await call('POST', path, move)).body, first.body);
  assert.equal((await call('POST', path, { ...move, before_order_id: ids.b })).body.error, 'queue_reorder_idempotency_conflict');
  assert.equal((await call('POST', path, { ...move, idempotency_key: 'new-key' })).body.error, 'queue_reorder_conflict');
});
test('state/frozen membership affects native version independently of global snapshot revision', async () => {
  const { call, snapshot, move } = await setup();
  await call('POST', '/__qa/order', { id: ids.a, stageStates: { print: 'paused' } });
  assert.notEqual((await call('GET', path)).body.sequence_versions[app], snapshot.sequence_versions[app]);
  assert.equal((await call('POST', path, move)).body.error, 'queue_reorder_conflict');
});
test('running/paused barriers adjust only the moved row; frozen anchors never participate', async () => {
  const { call, move } = await setup(), adjusted = await call('POST', path, { ...move, before_order_id: ids.running });
  assert.equal(adjusted.status, 200); assert.equal(adjusted.body.adjusted, true); assert.equal(adjusted.body.order_ids.indexOf(ids.c), 2);
  const fresh = (await call('GET', path)).body;
  assert.equal((await call('POST', path, { ...move, expected_version: fresh.sequence_versions[app], before_order_id: ids.frozen, idempotency_key: 'frozen-anchor' })).status, 409);
});
test('queue-only capabilities cannot reorder, while production.map.manage can', async () => {
  const { call, move } = await setup();
  await call('POST', '/__qa/config', { capabilities: ['apparatus.queue.read', 'apparatus.queue.manage'] });
  assert.equal((await call('POST', path, move)).status, 403);
  await call('POST', '/__qa/config', { capabilities: ['production.map.manage'] });
  assert.equal((await call('POST', path, move)).status, 200);
});
