import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { apparatusIds } from './erp-seed.mjs';
import { seedWorkerGroupScenario, workerGroupFixtureRoute, workerGroupProfileGroups, workerGroupsPath } from './erp-worker-groups.mjs';

function setup(scenario = 'empty', changes = {}) { const api = extensionHarness(workerGroupFixtureRoute, changes); assert.equal(seedWorkerGroupScenario(api.state, { scenario }).status, 200); return api; }
function input(patch = {}) { return { apparatus_id: apparatusIds.print, apparatus: 'QA Flexo 1', group_code: 'QA NEW GROUP', shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6, start_day: 'monday', accounting_enabled: false, worker_ids: ['qa-worker-1'], ...patch }; }

test('group native API requires admin.access independently of principal role or map manage', () => {
  const api = setup('empty', { capabilities: ['production.map.manage', 'role.capability.manage'] });
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal(api.request(method, workerGroupsPath, input()).status, 403);
  assert.equal(api.request('GET', '/v1/mobile/admin/workers?role=aparatchi').status, 403);
  const workerAdmin = setup('empty', { profile: { role: 'aparatchi', ref: 'qa-worker-1' }, capabilities: ['admin.access'] }); assert.equal(workerAdmin.request('PUT', workerGroupsPath, input()).status, 200);
});
test('native create and direct duplicate identity upsert return exact group fields without invented receipt proof', () => {
  const api = setup(), saved = api.request('PUT', workerGroupsPath, input({ group_code: '  qa   new group ', shift: '', start_time: '', end_time: '', work_days_per_week: 0, start_day: '' }));
  assert.equal(saved.status, 200); assert.deepEqual(saved.body, { ...input(), workers: [{ id: 'qa-worker-1', name: 'QA Brigadir', phone: '+998900000021', level: 'Brigader' }] });
  assert.deepEqual(Object.keys(saved.body).sort(), [...Object.keys(input()), 'workers'].sort());
  assert.equal(api.request('PUT', workerGroupsPath, input({ accounting_enabled: true })).status, 200);
  assert.equal(api.state.workerGroups.length, 1); assert.equal(api.state.workerGroups[0].accounting_enabled, true);
});
test('canonical apparatus IDs identify and filter groups; historical labels never locate an edit', () => {
  const api = setup('groups');
  assert.equal(api.request('GET', workerGroupsPath + '?apparatus_id=' + encodeURIComponent(apparatusIds.print)).body.length, 1);
  assert.equal(api.request('GET', workerGroupsPath + '?apparatus=QA%20Flexo%201').body.length, 2);
  assert.equal(api.request('GET', workerGroupsPath + '?apparatus_id=QA%20Flexo%201').status, 400);
  const edit = input({ group_code: 'QA RENAMED', previous_apparatus_id: apparatusIds.print, previous_group_code: 'QA PRINT GROUP', previous_apparatus: 'Wrong display name' });
  assert.equal(api.request('PUT', workerGroupsPath, edit).status, 200); assert.equal(api.state.workerGroups.find(group => group.apparatus_id === apparatusIds.print).group_code, 'QA RENAMED');
});
test('native rename/move preserves explicit previous identity and rejects absent/colliding targets atomically', () => {
  const api = setup('groups'), before = structuredClone(api.state.workerGroups);
  assert.equal(api.request('PUT', workerGroupsPath, input({ previous_group_code: 'ABSENT' })).body.error, 'worker group was not found');
  assert.deepEqual(api.state.workerGroups, before);
  assert.equal(api.request('PUT', workerGroupsPath, input({ apparatus_id: apparatusIds.laminate, group_code: 'QA LAMINATION GROUP', previous_apparatus_id: apparatusIds.print, previous_group_code: 'QA PRINT GROUP' })).body.error, 'worker group name already exists');
  assert.deepEqual(api.state.workerGroups, before);
  assert.equal(api.request('PUT', workerGroupsPath, input({ apparatus_id: apparatusIds.cut, apparatus: 'QA Rezka', group_code: 'QA CUT GROUP', previous_apparatus_id: apparatusIds.print, previous_group_code: 'QA PRINT GROUP' })).status, 200);
  assert.ok(!api.state.workerGroups.some(group => group.group_code === 'QA PRINT GROUP')); assert.ok(api.state.workerGroups.some(group => group.group_code === 'QA CUT GROUP'));
});
test('workers cannot occur in any two groups, even on separate apparatus; failed membership is atomic', () => {
  const api = setup('groups'), before = structuredClone(api.state.workerGroups);
  assert.equal(api.request('PUT', workerGroupsPath, input({ apparatus_id: apparatusIds.cut })).body.error, 'worker is duplicated in worker groups');
  assert.equal(api.request('PUT', workerGroupsPath, input({ group_code: 'QA PRINT GROUP', previous_group_code: 'QA PRINT GROUP', worker_ids: ['qa-worker-1', 'qa-worker-2'] })).body.error, 'worker is duplicated in worker groups');
  assert.deepEqual(api.state.workerGroups, before);
});
test('empty membership is valid and removing a member frees it for another group', () => {
  const api = setup('groups');
  assert.equal(api.request('PUT', workerGroupsPath, input({ group_code: 'QA PRINT GROUP', previous_group_code: 'QA PRINT GROUP', worker_ids: [] })).status, 200);
  assert.equal(api.request('PUT', workerGroupsPath, input({ apparatus_id: apparatusIds.cut })).status, 200);
  assert.equal(workerGroupProfileGroups(api.state, 'qa-worker-1')[0].apparatus_id, apparatusIds.cut);
});
test('native exact active worker validation runs before normalization and rejects admin/system users', () => {
  const api = setup();
  for (const id of ['qa-admin', 'qa-qolipchi-1', 'QA-WORKER-1', 'missing']) assert.equal(api.request('PUT', workerGroupsPath, input({ worker_ids: [id] })).body.error, 'worker not found');
  assert.equal(api.request('PUT', workerGroupsPath, input({ worker_ids: [' qa-worker-1 ', 'qa-worker-1', ''] })).status, 200);
  assert.deepEqual(api.state.workerGroups[0].worker_ids, ['qa-worker-1']);
  assert.equal(seedWorkerGroupScenario(api.state, { action: 'deactivate', worker_id: 'qa-worker-1' }).status, 200);
  assert.deepEqual(api.state.workerGroups[0].worker_ids, []); assert.equal(api.request('GET', '/v1/mobile/admin/workers/detail?id=qa-worker-1').status, 404);
  assert.equal(api.request('PUT', workerGroupsPath, input()).body.error, 'worker not found');
});
test('worker directory uses native name/phone/level search, exact role filtering, active exclusion and 500 cap', () => {
  const api = setup('bounded-workers');
  const all = api.request('GET', '/v1/mobile/admin/workers?role=aparatchi&limit=999').body;
  assert.equal(all.length, 500); assert.ok(all.every(worker => Object.keys(worker).sort().join(',') === 'id,level,name,phone'));
  assert.deepEqual(api.request('GET', '/v1/mobile/admin/workers?role=qolipchi&limit=500').body, []);
  assert.equal(api.request('GET', '/v1/mobile/admin/workers?role=aparatchi&q=QA%20Group%20Picker%20504&limit=500').body[0].id, 'qa-group-worker-504');
  assert.equal(api.request('GET', '/v1/mobile/admin/workers?role=aparatchi&q=Brigader&limit=500').body[0].id, 'qa-worker-1');
});
test('native schedules normalize defaults, time and Unicode byte bounds without invented overnight/duration constraints', () => {
  const api = setup(), overnight = api.request('PUT', workerGroupsPath, input({ start_time: '20:0', end_time: '8:0', group_code: '  qa ё ', work_days_per_week: 7, start_day: 'SUNDAY' }));
  assert.equal(overnight.status, 200); assert.equal(overnight.body.start_time, '20:00'); assert.equal(overnight.body.end_time, '08:00'); assert.equal(overnight.body.group_code, 'QA Ё'); assert.equal(overnight.body.start_day, 'sunday');
  for (const patch of [{ start_time: '24:00' }, { end_time: '08:60' }, { work_days_per_week: 8 }, { start_day: 'holiday' }]) assert.equal(api.request('PUT', workerGroupsPath, input(patch)).body.error, 'worker schedule is invalid');
  assert.equal(api.request('PUT', workerGroupsPath, input({ group_code: 'Ё'.repeat(33) })).body.error, 'worker group is invalid');
  assert.equal(api.request('PUT', workerGroupsPath, input({ shift: 'Ё'.repeat(33) })).body.error, 'worker shift is invalid');
});
test('fixture deliberately has no DELETE, CAS or idempotency semantics', () => {
  const api = setup(); assert.equal(api.request('DELETE', workerGroupsPath, input()).status, 405); assert.equal(api.request('POST', workerGroupsPath, input()).status, 405);
  const saved = api.request('PUT', workerGroupsPath, input({ expected_revision: 999, idempotency_key: 'invented' }));
  assert.equal(saved.status, 200); assert.ok(!Object.hasOwn(saved.body, 'expected_revision')); assert.ok(!Object.hasOwn(saved.body, 'idempotency_key'));
  assert.equal(api.request('PUT', workerGroupsPath, input({ expected_revision: 0, accounting_enabled: true, idempotency_key: 'invented' })).body.accounting_enabled, true);
});
test('concurrent fixture control changes a real stored group and preserves native profile membership', () => {
  const api = setup('groups'), changed = seedWorkerGroupScenario(api.state, { action: 'concurrent', apparatus_id: apparatusIds.print, group_code: 'QA PRINT GROUP', patch: { shift: 'QA CONCURRENT', accounting_enabled: true } });
  assert.equal(changed.status, 200); assert.equal(api.request('GET', workerGroupsPath).body.find(group => group.group_code === 'QA PRINT GROUP').shift, 'QA CONCURRENT');
  const profile = workerGroupProfileGroups(api.state, 'qa-worker-1'); assert.equal(profile.length, 1); assert.equal(profile[0].workers[0].name, 'QA Brigadir'); assert.equal(profile[0].accounting_enabled, true);
  assert.deepEqual(workerGroupProfileGroups(api.state, 'qa-admin'), []);
});
test('fixture controls reject arbitrary scenarios/fields and routes leave unrelated native work to existing handlers', () => {
  const api = setup();
  assert.equal(seedWorkerGroupScenario(api.state, { scenario: 'production' }).status, 400); assert.equal(seedWorkerGroupScenario(api.state, { scenario: 'empty', real_credentials: 'NO' }).status, 400);
  assert.equal(api.request('POST', '/v1/mobile/admin/workers', { name: 'QA New' }), null);
  assert.equal(api.request('GET', '/v1/mobile/admin/workers/profile-detail?id=qa-worker-1'), null);
});
