import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken, apparatusIds } from './erp-seed.mjs';
import { workerGroupsPath } from './erp-worker-groups.mjs';

async function setup(scenario = 'empty') {
  const fixture = createFixture();
  const request = (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: 'Bearer ' + fixtureToken } });
  await request('POST', '/v1/mobile/auth/login', fixtureLogin);
  assert.equal((await request('POST', '/__qa/worker-groups', { scenario })).status, 200);
  return { fixture, request };
}
const input = (patch = {}) => ({ apparatus_id: apparatusIds.print, apparatus: 'QA Flexo 1', group_code: 'QA NEW GROUP', shift: 'tun', start_time: '20:00', end_time: '08:00', work_days_per_week: 5, start_day: 'tuesday', accounting_enabled: true, worker_ids: ['qa-worker-1'], ...patch });

test('mounted native group route updates profile membership without granting apparatus access', async () => {
  const { request } = await setup();
  const before = (await request('GET', '/v1/mobile/admin/workers/profile-detail?id=qa-worker-1')).body;
  const saved = await request('PUT', workerGroupsPath, input());
  assert.equal(saved.status, 200);
  const after = (await request('GET', '/v1/mobile/admin/workers/profile-detail?id=qa-worker-1')).body;
  assert.deepEqual(after.assigned_groups, [saved.body]); assert.deepEqual(after.assigned_apparatus, before.assigned_apparatus);
  const moved = await request('PUT', workerGroupsPath, input({ apparatus_id: apparatusIds.cut, apparatus: 'QA Rezka', group_code: 'QA RENAMED', previous_apparatus_id: apparatusIds.print, previous_group_code: 'QA NEW GROUP' }));
  assert.equal(moved.status, 200); assert.equal((await request('GET', workerGroupsPath)).body.length, 1);
  assert.deepEqual((await request('GET', '/v1/mobile/admin/workers/profile-detail?id=qa-worker-1')).body.assigned_groups, [moved.body]);
  await request('PUT', workerGroupsPath, input({ apparatus_id: apparatusIds.cut, apparatus: 'QA Rezka', group_code: 'QA RENAMED', previous_apparatus_id: apparatusIds.cut, previous_group_code: 'QA RENAMED', worker_ids: [] }));
  assert.deepEqual((await request('GET', '/v1/mobile/admin/workers/profile-detail?id=qa-worker-1')).body.assigned_groups, []);
});
test('mounted group native restrictions deny cross-group duplicates and missing admin access atomically', async () => {
  const { fixture, request } = await setup('groups'); const before = fixture.getState().state.workerGroups;
  assert.equal((await request('PUT', workerGroupsPath, input())).body.error, 'worker is duplicated in worker groups');
  assert.deepEqual(fixture.getState().state.workerGroups, before);
  await request('POST', '/__qa/config', { capabilities: ['production.map.manage'] });
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await request(method, workerGroupsPath, input())).status, 403);
  assert.deepEqual(fixture.getState().state.workerGroups, before);
});
test('applied response loss and server failure retain committed native membership without invented receipt lookup', async () => {
  for (const rule of [{ dropResponse: true }, { status: 408, applyBeforeFailure: true }, { status: 429, applyBeforeFailure: true }, { responseBody: { ok: true } }]) {
    const { fixture, request } = await setup();
    await request('POST', '/__qa/config', { rules: [{ method: 'PUT', path: workerGroupsPath, once: true, ...rule }] });
    await request('PUT', workerGroupsPath, input());
    assert.equal((await request('GET', workerGroupsPath)).body[0].group_code, 'QA NEW GROUP');
    assert.equal((await request('GET', '/v1/mobile/admin/workers/profile-detail?id=qa-worker-1')).body.assigned_groups[0].group_code, 'QA NEW GROUP');
    assert.equal(fixture.getLog().filter(row => row.method === 'PUT').length, 1);
  }
});
test('group fixture controls are opt-in and resets remove memberships without changing unrelated worker catalogs', async () => {
  const fixture = createFixture(), request = (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: 'Bearer ' + fixtureToken } });
  await request('POST', '/v1/mobile/auth/login', fixtureLogin);
  const before = (await request('GET', '/v1/mobile/admin/workers?role=aparatchi')).body;
  await request('POST', '/__qa/worker-groups', { scenario: 'groups' });
  await request('POST', '/__qa/reset', {}); await request('POST', '/v1/mobile/auth/login', fixtureLogin);
  assert.deepEqual((await request('GET', workerGroupsPath)).body, []);
  assert.deepEqual((await request('GET', '/v1/mobile/admin/workers?role=aparatchi')).body, before);
});
