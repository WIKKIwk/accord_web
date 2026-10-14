import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { createPaddonFixtureExtension, paddonsPath } from './erp-paddons.mjs';
import { paddonManagementFixtureRoute, paddonManagementPath, seedPaddonManagementScenario } from './erp-paddon-management.mjs';

function setup(scenario = 'off', changes = {}) {
  const api = extensionHarness(paddonManagementFixtureRoute, changes);
  assert.equal(seedPaddonManagementScenario(api.state, { scenario }).status, 200);
  return { ...api, seed: input => seedPaddonManagementScenario(api.state, input) };
}
const read = api => api.request('GET', paddonManagementPath);
const save = (api, enabled) => api.request('PUT', paddonManagementPath, { free_movement_enabled: enabled });

test('settings GET mirrors the four-capability OR without requiring the actual admin role', () => {
  for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']) {
    const api = setup('off', { capabilities: [capability], profile: { role: 'aparatchi' } });
    assert.deepEqual(read(api), { status: 200, body: { ok: true, settings: { free_movement_enabled: false, worker_visibility_enabled: false } } });
  }
  for (const capabilities of [[], ['admin.settings.read'], ['catalog.item.read']]) assert.equal(read(setup('off', { capabilities })).status, 403);
});
test('both PUT values require admin.access AND the actual principal admin role before parsing', () => {
  for (const enabled of [true, false]) {
    for (const changes of [
      { capabilities: ['admin.access'], profile: { role: 'aparatchi' } },
      { capabilities: ['admin.access'], profile: { role: 'tayyorlov_masteri' } },
      { capabilities: ['production.map.manage'], profile: { role: 'admin' } },
      { capabilities: ['admin.settings.manage'], profile: { role: 'admin' } },
    ]) {
      const api = setup('visibility-on', changes), before = structuredClone(api.state);
      assert.equal(save(api, enabled).status, 403);
      assert.equal(api.request('PUT', paddonManagementPath, { worker_visibility_enabled: 'bad' }).status, 403);
      assert.deepEqual(api.state, before);
    }
  }
});
test('native actual actor ref must be nonempty for PUT but is not required for GET', () => {
  for (const ref of ['', ' ', '\u2003\n']) {
    const api = setup('off', { profile: { ref } }), before = structuredClone(api.state);
    assert.equal(save(api, true).body.error, 'paddon_invalid_input'); assert.equal(read(api).status, 200);
    assert.deepEqual(api.state, before);
  }
  const api = setup('off', { profile: { ref: '\u2003qa-admin\u2003' } }); assert.equal(save(api, true).status, 200);
});
test('true and false partial setters preserve each pre-existing worker visibility state', () => {
  for (const visibility of [true, false]) {
    const api = setup(visibility ? 'visibility-on' : 'off'), before = structuredClone(api.state), revision = api.state.rev;
    for (const [index, enabled] of [true, false, false, true].entries()) {
      assert.deepEqual(save(api, enabled), { status: 200, body: { ok: true, settings: { free_movement_enabled: enabled, worker_visibility_enabled: visibility } } });
      assert.equal(api.state.paddonFixture.free_movement_enabled, enabled); assert.equal(api.state.paddonFixture.worker_visibility_enabled, visibility);
      assert.equal(api.state.rev, revision + index + 1);
    }
    for (const key of ['paddons', 'paddonMemberships', 'paddonBatches', 'paddonActiveSelections']) assert.deepEqual(api.state[key], before[key]);
    assert.equal(api.state.paddonFixture.clock, before.paddonFixture.clock);
    assert.equal(api.state.paddonFixture.next_number, before.paddonFixture.next_number);
    assert.equal(api.state.paddonFixture.scenario, before.paddonFixture.scenario);
  }
});
test('visibility and actor/CAS/idempotency/extra fields are rejected by this narrow synthetic slice', () => {
  const api = setup('visibility-on'), before = structuredClone(api.state);
  for (const body of [
    { worker_visibility_enabled: false }, { worker_visibility_enabled: true },
    { free_movement_enabled: true, worker_visibility_enabled: false },
    { free_movement_enabled: true, actor_ref: 'qa-admin' }, { free_movement_enabled: true, actor_role: 'admin' },
    { free_movement_enabled: true, expected_revision: 1 }, { free_movement_enabled: true, idempotency_key: 'qa-key' },
    { free_movement_enabled: true, unexpected: true }, { freeMovementEnabled: true },
  ]) {
    assert.deepEqual(api.request('PUT', paddonManagementPath, body), { status: 400, body: { error: 'invalid_json' } });
    assert.deepEqual(api.state, before);
  }
});
test('missing, null and malformed input follow native parse/service refusals without a mutation', () => {
  const api = setup(), before = structuredClone(api.state);
  for (const body of [{}, { free_movement_enabled: null }, { free_movement_enabled: undefined }]) assert.equal(api.request('PUT', paddonManagementPath, body).body.error, 'paddon_invalid_input');
  for (const body of [null, undefined, [], 'true', { free_movement_enabled: 'true' }, { free_movement_enabled: 1 }, { free_movement_enabled: {} }]) assert.equal(api.request('PUT', paddonManagementPath, body).body.error, 'invalid_json');
  assert.deepEqual(api.state, before);
});
test('GET returns fresh independent boolean fields, a detached response, and no write metadata', () => {
  const api = setup('visibility-on'), before = structuredClone(api.state), first = read(api);
  assert.deepEqual(first.body, { ok: true, settings: { free_movement_enabled: false, worker_visibility_enabled: true } });
  first.body.settings.worker_visibility_enabled = false; first.body.settings.free_movement_enabled = true;
  assert.deepEqual(api.state, before);
  api.state.paddonFixture.free_movement_enabled = true;
  assert.deepEqual(read(api).body.settings, { free_movement_enabled: true, worker_visibility_enabled: true });
  assert.deepEqual(Object.keys(read(api).body), ['ok', 'settings']);
  assert.deepEqual(Object.keys(read(api).body.settings), ['free_movement_enabled', 'worker_visibility_enabled']);
});
test('only exact GET/PUT management-settings paths are exposed, with native unsupported-method precedence', () => {
  const api = setup('off', { capabilities: [] }), before = structuredClone(api.state);
  for (const method of ['POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) assert.deepEqual(api.request(method, paddonManagementPath, { free_movement_enabled: true }), { status: 405, body: { error: 'method_not_allowed' } });
  for (const path of [`${paddonManagementPath}/visibility`, `${paddonManagementPath}/`, `${paddonsPath}/settings`, '/v1/mobile/admin/settings']) assert.equal(api.request('PUT', path, { free_movement_enabled: true }), null);
  assert.deepEqual(api.state, before);
});
test('the setting uses the existing paddon flags and controls locked membership through the existing fixture', () => {
  const api = setup(), detail = () => createPaddonFixtureExtension(api.state).route({ method: 'GET', path: `${paddonsPath}/detail`, query: { code: '00002' }, profile: api.profile, requires: () => true });
  const remove = () => createPaddonFixtureExtension(api.state).route({ method: 'POST', path: `${paddonsPath}/items/remove-batch`, body: { code: '00002', progress_batch_ids: ['qa-paddon-wip-8'] }, profile: api.profile, requires: () => true });
  assert.equal(detail().body.free_movement_enabled, false); assert.equal(detail().body.can_manage_items, false);
  assert.equal(remove().body.error, 'paddon_locked');
  assert.equal(save(api, true).status, 200); assert.equal(detail().body.free_movement_enabled, true); assert.equal(detail().body.can_manage_items, true);
  assert.equal(remove().status, 200);
  assert.equal(save(api, false).status, 200); assert.equal(detail().body.can_manage_items, false);
  assert.equal(api.state.paddonFixture.worker_visibility_enabled, false);
});
test('changing free movement preserves previously seeded worker visibility and visible foreign records', () => {
  const api = setup('visibility-on', { profile: { role: 'aparatchi', ref: 'qa-worker-1' } });
  const visible = () => createPaddonFixtureExtension(api.state).route({ method: 'GET', path: `${paddonsPath}/detail`, query: { code: '00002' }, profile: api.profile, requires: () => true });
  assert.equal(visible().status, 200);
  api.profile.role = 'admin'; assert.equal(save(api, true).status, 200); assert.equal(save(api, false).status, 200);
  api.profile.role = 'aparatchi'; assert.equal(visible().status, 200); assert.equal(read(api).body.settings.worker_visibility_enabled, true);
});
test('scenario controls share existing business seeds and allow only a synthetic free-movement concurrency action', () => {
  for (const [scenario, free, visibility] of [['off', false, false], ['on', true, false], ['visibility-on', false, true], ['empty', false, false]]) {
    const api = setup(scenario);
    assert.deepEqual(read(api).body.settings, { free_movement_enabled: free, worker_visibility_enabled: visibility });
    assert.equal(api.state.paddons.length, scenario === 'empty' ? 0 : 7);
  }
  const api = setup('visibility-on'), before = structuredClone(api.state), revision = api.state.rev;
  assert.equal(api.seed({ action: 'concurrent', free_movement_enabled: true }).status, 200);
  assert.deepEqual(read(api).body.settings, { free_movement_enabled: true, worker_visibility_enabled: true });
  assert.equal(api.state.rev, revision + 1);
  for (const key of ['paddons', 'paddonMemberships', 'paddonBatches', 'paddonActiveSelections']) assert.deepEqual(api.state[key], before[key]);
  const after = structuredClone(api.state);
  for (const input of [null, [], { scenario: 'bad' }, { scenario: 'on', worker_visibility_enabled: true },
    { action: 'concurrent', free_movement_enabled: 'true' }, { action: 'concurrent', free_movement_enabled: true, worker_visibility_enabled: false }, { action: 'unknown' }]) {
    assert.equal(api.seed(input).status, 400); assert.deepEqual(api.state, after);
  }
});
