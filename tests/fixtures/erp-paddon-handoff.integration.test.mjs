import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { apparatusIds, fixtureLogin, fixtureToken } from './erp-seed.mjs';

const base = '/v1/mobile/admin/production-maps', path = `${base}/paddons`, cut = apparatusIds.cut;
const active = `${path}/active?apparatus=${encodeURIComponent(cut)}`;
async function setup(scenario = 'handoff', config = {}) {
  const fixture = createFixture(), request = (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: `Bearer ${fixtureToken}` } });
  assert.equal((await request('POST', '/__qa/paddon-handoff', { scenario })).status, 200);
  if (Object.keys(config).length) assert.equal((await request('POST', '/__qa/config', config)).status, 200);
  assert.equal((await request('POST', '/v1/mobile/auth/login', fixtureLogin)).status, 200);
  return { fixture, request };
}
async function complete(request, fixture, { saved = false, owner = 'qa-admin' } = {}) {
  assert.equal((await request('POST', '/__qa/completion', { scenario: saved ? 'cut-saved' : 'cut', owner })).status, 200);
  const scope = fixture.getState().state.completionFixture;
  const frame = { finished_goods_meter: 100, gross_qty: 10, bobina_kg: 1, diameter: 30 };
  const body = { order_id: 'zakaz-qa-1001', apparatus: cut, action: 'complete', include_control: true, print_transport: 'offline', total_waste: 2, description: 'QA Synthetic cutting report', rezka_output_cycle: scope.cycleId,
    rezka_frames: saved ? [structuredClone(scope.saved[0].input), { issue_note: 'QA Synthetic damaged slot' }] : [frame, frame] };
  return { body, result: await request('POST', `${base}/queue-action`, body) };
}
test('mounted actor-scoped active PUT uses native null clear and preserves unrelated assignments', async () => {
  const { fixture, request } = await setup('selected'), before = fixture.getState().state;
  assert.equal((await request('GET', active)).body.code, '00003');
  assert.deepEqual(await request('PUT', `${path}/active`, { apparatus: cut, code: '' }), { status: 200, body: { ok: true, apparatus: cut, code: null } });
  assert.equal((await request('GET', active)).body.code, null);
  assert.equal((await request('PUT', `${path}/active`, { apparatus: cut, code: '00001' })).status, 200);
  await request('POST', '/__qa/config', { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assignedApparatus: [cut] });
  assert.equal((await request('GET', active)).body.code, '00007');
  assert.equal((await request('PUT', `${path}/active`, { apparatus: cut, code: '' })).status, 200);
  await request('POST', '/__qa/config', { profileOverride: null });
  assert.equal((await request('GET', active)).body.code, '00001');
  assert.deepEqual(fixture.getState().state.roleAssignments, before.roleAssignments);
  assert.deepEqual(fixture.getState().state.apparatus, before.apparatus);
});
test('mounted active GET filters locked or received selections without erasing the persisted preference', async () => {
  const { fixture, request } = await setup('selected');
  await request('POST', '/__qa/paddon-handoff', { action: 'lock', code: '00003' });
  assert.equal((await request('GET', active)).body.code, null);
  assert.equal(fixture.getState().state.paddonActiveSelections.find(row => row.actor_ref === 'qa-admin').code, '00003');
  await request('POST', '/__qa/paddon-handoff', { action: 'unlock', code: '00003' });
  assert.equal((await request('GET', active)).body.code, '00003');
  await request('POST', '/__qa/paddon-handoff', { action: 'received', code: '00003' });
  assert.equal((await request('GET', active)).body.code, null);
  assert.equal((await request('PUT', `${path}/active`, { apparatus: cut, code: '00003' })).status, 400);
});
test('mounted cutting output attaches only freshly saved batches using the current server selection', async () => {
  const { fixture, request } = await setup('selected');
  await request('PUT', `${path}/active`, { apparatus: cut, code: '00001' });
  const old = (await request('GET', `${path}/detail?code=00001`)).body.items.map(row => row.batch_id);
  const { result } = await complete(request, fixture);
  assert.equal(result.status, 200);
  const fresh = result.body.progress_batches.map(row => row.batch_id); assert.equal(fresh.length, 2);
  const current = (await request('GET', `${path}/detail?code=00001`)).body.items.map(row => row.batch_id);
  assert.deepEqual(new Set(current), new Set([...old, ...fresh]));
  assert.equal((await request('GET', `${path}/detail?code=00003`)).body.items.length, 0);
  assert.ok(!Object.hasOwn(result.body.session.payload_json, 'output_paddon_code'));
});
test('cleared and now-locked server selections allow new output to remain unassigned', async () => {
  for (const action of ['clear', 'lock']) {
    const { fixture, request } = await setup('selected');
    if (action === 'clear') await request('PUT', `${path}/active`, { apparatus: cut, code: '' });
    else await request('POST', '/__qa/paddon-handoff', { action: 'lock', code: '00003' });
    const { result } = await complete(request, fixture); assert.equal(result.status, 200);
    const ids = result.body.progress_batches.map(row => row.batch_id); assert.equal(ids.length, 2);
    assert.ok(fixture.getState().state.paddonBatches.some(row => ids.includes(row.batch_id)));
    assert.ok(!fixture.getState().state.paddonMemberships.some(row => ids.includes(row.batch_id)));
  }
});
test('operator handoff selects its successor for subsequent cut output and leaves the locked source intact', async () => {
  const { fixture, request } = await setup('selected', { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assignedApparatus: [cut] });
  const source = (await request('GET', `${path}/detail?code=00002`)).body;
  const next = await request('POST', `${path}/active/next`, { apparatus: cut, code: '00002' }); assert.equal(next.status, 200);
  assert.equal((await request('GET', active)).body.code, next.body.code);
  const { result } = await complete(request, fixture, { owner: 'qa-worker-1' }); assert.equal(result.status, 200);
  assert.deepEqual((await request('GET', `${path}/detail?code=${next.body.code}`)).body.items.map(row => row.batch_id), result.body.progress_batches.map(row => row.batch_id));
  assert.deepEqual((await request('GET', `${path}/detail?code=00002`)).body, source);
  const adminPreference = fixture.getState().state.paddonActiveSelections.find(row => row.actor_ref === 'qa-admin'); assert.equal(adminPreference.code, '00003');
});
test('saved and issue slots create no new membership; selecting a paddon never backfills earlier batches', async () => {
  const { fixture, request } = await setup('selected');
  const { result } = await complete(request, fixture, { saved: true }); assert.equal(result.status, 200); assert.deepEqual(result.body.progress_batches, []);
  assert.equal((await request('GET', `${path}/detail?code=00003`)).body.items.length, 0);
  assert.ok(!fixture.getState().state.paddonMemberships.some(row => row.batch_id === 'qa-cut-saved-1'));
  await request('PUT', `${path}/active`, { apparatus: cut, code: '00001' });
  assert.ok(!fixture.getState().state.paddonMemberships.some(row => row.batch_id === 'qa-cut-saved-1'));
});
test('repeated next reuses and reselects, so read-only lost-response recovery must not replay it', async () => {
  const { fixture, request } = await setup('handoff', { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assignedApparatus: [cut] });
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${path}/active/next`, once: true, dropResponse: true }] });
  const first = await request('POST', `${path}/active/next`, { apparatus: cut, code: '00002' }); assert.equal(first.dropResponse, true);
  const observed = (await request('GET', active)).body.code; assert.ok(observed); assert.equal(fixture.getState().state.paddonSuccessors.length, 1);
  await request('PUT', `${path}/active`, { apparatus: cut, code: '00007' });
  const second = await request('POST', `${path}/active/next`, { apparatus: cut, code: '00002' });
  assert.equal(second.body.code, observed); assert.equal((await request('GET', active)).body.code, observed); assert.equal(fixture.getState().state.paddonSuccessors.length, 1);
});
test('mapped unused successor deletion retains native FK500 until source unlock removes its mapping', async () => {
  const { fixture, request } = await setup('handoff', { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assignedApparatus: [cut] });
  const next = await request('POST', `${path}/active/next`, { apparatus: cut, code: '00002' }); assert.equal(next.status, 200);
  const before = fixture.getState().state;
  assert.deepEqual(await request('POST', `${path}/delete`, { code: next.body.code }), { status: 500, body: { error: 'store_failed' } });
  assert.deepEqual(fixture.getState().state, before);
  assert.equal((await request('POST', `${path}/unlock`, { code: '00002' })).status, 200);
  assert.equal((await request('POST', `${path}/delete`, { code: next.body.code })).status, 200);
});
test('active and next native permission refusals do not promote a queue-read or admin actor', async () => {
  const { request } = await setup('handoff', { capabilities: ['apparatus.queue.read'] });
  assert.equal((await request('GET', active)).status, 403); assert.equal((await request('PUT', `${path}/active`, { apparatus: cut, code: '' })).status, 403);
  await request('POST', '/__qa/config', { capabilities: ['admin.access', 'apparatus.queue.manage'] });
  assert.equal((await request('POST', `${path}/active/next`, { apparatus: cut, code: '00002' })).status, 403);
});
