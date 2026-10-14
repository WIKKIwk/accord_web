import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { createPaddonFixtureExtension, paddonsPath } from './erp-paddons.mjs';

function setup(scenario = 'paddons', changes = {}, options = {}) {
  let extension;
  const api = extensionHarness(context => extension.route(context), changes);
  extension = createPaddonFixtureExtension(api.state, { scenario, ...options });
  return { ...api, seed: extension.seed };
}
const detail = (api, code = '00001') => api.request('GET', `${paddonsPath}/detail?code=${encodeURIComponent(code)}`);
const write = (api, kind, code = '00001', ids = []) => api.request('POST', `${paddonsPath}/${kind === 'add' ? 'items/add-batch' : kind === 'remove' ? 'items/remove-batch' : kind}`, { code, ...(kind === 'add' || kind === 'remove' ? { progress_batch_ids: ids } : {}) });

test('native read/write capability OR is independent of role label; queue.read does not authorize a mutation', () => {
  for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']) {
    const api = setup('empty', { capabilities: [capability], profile: { role: 'tayyorlov_masteri', ref: 'qa-user' } });
    assert.equal(api.request('GET', paddonsPath).status, 200);
    assert.equal(api.request('POST', paddonsPath + '/create', {}).status, capability === 'apparatus.queue.read' ? 403 : 200);
    if (capability === 'apparatus.queue.read') for (const kind of ['delete', 'unlock', 'add', 'remove']) assert.equal(write(api, kind).status, 403);
  }
  const denied = setup('empty', { capabilities: ['role.capability.manage'] });
  assert.equal(apiForbidden(denied), true);
  function apiForbidden(api) { return api.request('GET', paddonsPath).status === 403 && api.request('POST', paddonsPath + '/create', {}).status === 403; }
});
test('list defaults50, clamps1–200, exposes no count/pagination and detail can locate a code outside the bound', () => {
  const api = setup('bounded');
  assert.equal(api.request('GET', paddonsPath).body.paddons.length, 50);
  assert.equal(api.request('GET', paddonsPath + '?limit=0').body.paddons.length, 1);
  for (const limit of [200, 201, 1000]) assert.equal(api.request('GET', paddonsPath + '?limit=' + limit).body.paddons.length, 200);
  const list = api.request('GET', paddonsPath + '?limit=200').body;
  assert.deepEqual(Object.keys(list).sort(), ['ok', 'paddons']); assert.ok(!list.paddons.some(row => row.code === '00205'));
  assert.equal(detail(api, '00205').body.paddon.code, '00205');
  assert.equal(detail(api).body.available_items.length, 500);
  assert.equal(api.request('GET', paddonsPath + '?limit=-1').status, 400);
});
test('aparatchi visibility scopes every native read/write to creator regardless of admin.access unless worker visibility is enabled', () => {
  const api = setup('visibility', { profile: { role: 'aparatchi', ref: 'qa-worker-1' }, capabilities: ['admin.access'] });
  assert.deepEqual(api.request('GET', paddonsPath + '?limit=200').body.paddons.map(row => row.code), ['00007']);
  assert.equal(detail(api, '00006').body.error, 'paddon_not_found');
  for (const kind of ['delete', 'unlock', 'add', 'remove']) assert.equal(write(api, kind, '00006', ['qa-paddon-wip-2']).status, 404);
  const shared = setup('visibility', { profile: { role: 'aparatchi', ref: 'qa-worker-1' }, capabilities: ['apparatus.queue.read'] }, { workerVisibilityEnabled: true });
  assert.equal(shared.request('GET', paddonsPath).body.paddons.length, 2); assert.equal(detail(shared, '00006').status, 200);
});
test('normal detail returns in-use and stock-marked available rows but add rejects them; missing/null markers remain absent', () => {
  const api = setup(), available = detail(api).body.available_items;
  assert.equal(available.find(row => row.batch_id === 'qa-paddon-wip-4').wip_status, 'in_use');
  assert.equal(available.find(row => row.batch_id === 'qa-paddon-wip-5').payload_json.finished_goods_stock_id, 'qa-stock-received');
  assert.ok(!available.some(row => row.batch_id === 'qa-paddon-wip-6'));
  for (const id of ['qa-paddon-wip-4', 'qa-paddon-wip-5', 'qa-paddon-wip-6']) assert.equal(write(api, 'add', '00001', [id]).body.error, 'progress_batch_not_accepted');
  assert.equal(api.seed({ action: 'batch', batch_id: 'qa-paddon-wip-2', patch: { finished_goods_stock_id: null, received_warehouse: null } }).status, 200);
  assert.equal(write(api, 'add', '00001', ['qa-paddon-wip-2']).status, 200);
});
test('create trims native Unicode whitespace, permits empty values, enforces UTF-8 bytes160/500 and ignores unrecognized fields natively', () => {
  const api = setup('empty');
  const created = api.request('POST', paddonsPath + '/create', { location: '\u0085 QA Cut \u0085', note: '', actor_ref: 'forged', expected_revision: 9 });
  assert.equal(created.status, 200); assert.equal(created.body.ok, true); assert.equal(created.body.paddon.code, '00001');
  assert.equal(created.body.paddon.location, 'QA Cut'); assert.equal(created.body.paddon.created_by_ref, 'qa-admin');
  assert.equal(created.body.paddon.locked_at_unix, null); assert.equal(created.body.paddon.item_count, 0); assert.equal(created.body.paddon.total_gross_kg, 0);
  assert.equal(api.request('POST', paddonsPath + '/create', { location: 'Ё'.repeat(80), note: '😀'.repeat(125) }).status, 200);
  assert.equal(api.request('POST', paddonsPath + '/create', { location: 'Ё'.repeat(81) }).body.error, 'paddon_invalid_input');
  assert.equal(api.request('POST', paddonsPath + '/create', { note: '😀'.repeat(126) }).body.error, 'paddon_invalid_input');
  for (const body of [[], null, { location: null }, { note: 7 }]) assert.equal(api.request('POST', paddonsPath + '/create', body).body.error, 'invalid_json');
});
test('create has no native idempotency or client code allocation; repeated explicit creates return new codes', () => {
  const api = setup('empty');
  const first = api.request('POST', paddonsPath + '/create', { location: 'Same', note: 'Same', code: '99999' }, { 'idempotency-key': 'ignored' }).body.paddon;
  const second = api.request('POST', paddonsPath + '/create', { location: 'Same', note: 'Same' }, { 'idempotency-key': 'ignored' }).body.paddon;
  assert.equal(first.code, '00001'); assert.equal(second.code, '00002'); assert.notEqual(first.id, second.id);
  api.state.paddonFixture.next_number = 100000;
  assert.equal(api.request('POST', paddonsPath + '/create', {}).body.error, 'paddon_code_exhausted'); assert.equal(api.state.paddons.length, 2);
});
test('native batch IDs trim and deduplicate before500 distinct bound; rejects blank IDs without partial membership', () => {
  const api = setup(), before = structuredClone(api.state.paddonMemberships);
  for (const ids of [[], [''], ['qa-paddon-wip-2', ' '], Array.from({ length: 501 }, (_, index) => `wip-${index}`)]) assert.equal(write(api, 'add', '00001', ids).body.error, 'paddon_invalid_input');
  assert.deepEqual(api.state.paddonMemberships, before);
  const saved = write(api, 'add', '00001', Array(501).fill(' qa-paddon-wip-2 '));
  assert.equal(saved.status, 200); assert.equal(saved.body.items.filter(row => row.batch_id === 'qa-paddon-wip-2').length, 1);
});
test('add-batch atomically validates every selected roll and returns the full authoritative snapshot', () => {
  const api = setup(), memberships = structuredClone(api.state.paddonMemberships), paddons = structuredClone(api.state.paddons);
  const invalid = write(api, 'add', '00001', ['qa-paddon-wip-2', 'zz-missing']);
  assert.equal(invalid.body.error, 'progress_batch_not_found'); assert.equal(invalid.status, 404);
  assert.deepEqual(api.state.paddonMemberships, memberships); assert.deepEqual(api.state.paddons, paddons);
  const saved = write(api, 'add', '00001', [' qa-paddon-wip-2 ', 'qa-paddon-wip-2']);
  assert.equal(saved.status, 200); assert.equal(saved.body.items.length, 2); assert.equal(saved.body.paddon.item_count, 2);
  assert.equal(saved.body.paddon.total_gross_kg, 32); assert.equal(saved.body.paddon.total_net_kg, 31.5);
  assert.deepEqual(Object.keys(saved.body).sort(), ['ok', 'paddon', 'items', 'available_items', 'free_movement_enabled', 'can_manage_items', 'can_unlock'].sort());
});
test('normal add does not transfer an assigned roll and same-target add is native no-op even after it became in-use', () => {
  const api = setup(), before = structuredClone(api.state.paddonMemberships);
  assert.equal(write(api, 'add', '00001', ['qa-paddon-wip-8']).body.error, 'paddon_item_already_assigned');
  assert.deepEqual(api.state.paddonMemberships, before);
  api.seed({ action: 'batch', batch_id: 'qa-paddon-wip-1', patch: { wip_status: 'in_use' } });
  const paddon = structuredClone(api.state.paddons.find(row => row.code === '00001'));
  assert.equal(write(api, 'add', '00001', ['qa-paddon-wip-1']).status, 200);
  assert.deepEqual(api.state.paddons.find(row => row.code === '00001'), paddon);
});
test('normal remove permits an in-use assigned roll but mixed unassigned IDs roll back the whole request', () => {
  const api = setup(); api.seed({ action: 'batch', batch_id: 'qa-paddon-wip-1', patch: { wip_status: 'in_use' } });
  const before = structuredClone(api.state.paddonMemberships);
  assert.equal(write(api, 'remove', '00001', ['qa-paddon-wip-1', 'qa-paddon-wip-2']).body.error, 'paddon_item_not_assigned');
  assert.deepEqual(api.state.paddonMemberships, before);
  const removed = write(api, 'remove', '00001', ['qa-paddon-wip-1']);
  assert.equal(removed.status, 200); assert.deepEqual(removed.body.items, []); assert.equal(removed.body.paddon.item_count, 0);
  assert.equal(api.state.paddonMemberships.find(row => row.code === '00001' && row.batch_id === 'qa-paddon-wip-1').removed, true);
  assert.equal(write(api, 'delete', '00001').body.error, 'paddon_delete_locked');
});
test('locked normal-mode pallets reject all membership changes and expose false business-management flag', () => {
  const api = setup(), current = detail(api, '00002').body;
  assert.notEqual(current.paddon.locked_at_unix, null); assert.equal(current.can_manage_items, false); assert.deepEqual(current.available_items, []);
  assert.equal(write(api, 'add', '00002', ['qa-paddon-wip-2']).body.error, 'paddon_locked');
  assert.equal(write(api, 'remove', '00002', ['qa-paddon-wip-8']).body.error, 'paddon_locked');
});
test('free movement permits locked target/source transfer and removes old membership while preserving history and lock', () => {
  const api = setup('free-movement'), current = detail(api, '00002').body;
  assert.equal(current.can_manage_items, true); assert.notEqual(current.paddon.locked_at_unix, null);
  assert.ok(detail(api).body.available_items.some(row => row.batch_id === 'qa-paddon-wip-8'));
  assert.equal(write(api, 'add', '00001', ['qa-paddon-wip-8']).status, 200);
  assert.equal(detail(api, '00002').body.items.length, 0); assert.notEqual(detail(api, '00002').body.paddon.locked_at_unix, null);
  assert.equal(api.state.paddonMemberships.filter(row => row.batch_id === 'qa-paddon-wip-8' && !row.removed).length, 1);
  assert.equal(write(api, 'add', '00002', ['qa-paddon-wip-2']).status, 200);
  assert.equal(write(api, 'remove', '00002', ['qa-paddon-wip-2']).status, 200);
});
test('free-mode add/remove require waiting rolls without stock/receipt markers; received source/target stays protected', () => {
  const api = setup('free-movement');
  assert.equal(write(api, 'add', '00001', ['qa-paddon-wip-9']).body.error, 'paddon_already_received');
  assert.equal(write(api, 'add', '00005', ['qa-paddon-wip-2']).body.error, 'paddon_already_received');
  assert.equal(write(api, 'remove', '00005', ['qa-paddon-wip-9']).body.error, 'paddon_already_received');
  assert.ok(!detail(api).body.available_items.some(row => ['qa-paddon-wip-4', 'qa-paddon-wip-5', 'qa-paddon-wip-9'].includes(row.batch_id)));
  api.seed({ action: 'batch', batch_id: 'qa-paddon-wip-1', patch: { received_warehouse: 'QA Warehouse' } });
  assert.equal(write(api, 'remove', '00001', ['qa-paddon-wip-1']).body.error, 'progress_batch_not_accepted');
  api.seed({ action: 'batch', batch_id: 'qa-paddon-wip-1', patch: { received_warehouse: '', wip_status: 'in_use' } });
  assert.equal(write(api, 'remove', '00001', ['qa-paddon-wip-1']).body.error, 'progress_batch_not_accepted');
});
test('mixed-invalid free transfer rolls back source and target membership/history/timestamps together', () => {
  const api = setup('free-movement'), before = { paddons: structuredClone(api.state.paddons), memberships: structuredClone(api.state.paddonMemberships) };
  assert.equal(write(api, 'add', '00001', ['qa-paddon-wip-8', 'zz-missing']).status, 404);
  assert.deepEqual(api.state.paddons, before.paddons); assert.deepEqual(api.state.paddonMemberships, before.memberships);
});
test('deleting a never-used empty active selection returns200 oktrue and clears FK-style selection, without deleting rolls', () => {
  const api = setup(), batches = structuredClone(api.state.paddonBatches);
  api.state.paddonActiveSelections.push({ actor_ref: 'qa-worker-1', code: '00003' });
  assert.deepEqual(write(api, 'delete', '00003'), { status: 200, body: { ok: true } });
  assert.equal(api.state.paddonActiveSelections[0].code, null); assert.deepEqual(api.state.paddonBatches, batches);
  assert.equal(detail(api, '00003').status, 404);
});
test('native deletion rejects current membership, lock, receipt, removed membership and timestamp/history use', () => {
  const api = setup();
  for (const code of ['00001', '00002', '00004', '00005']) assert.equal(write(api, 'delete', code).body.error, 'paddon_delete_locked');
  api.seed({ action: 'concurrent', code: '00003', patch: { note: 'Used metadata' } });
  assert.equal(write(api, 'delete', '00003').body.error, 'paddon_delete_locked');
  assert.equal(write(api, 'delete', '99999').body.error, 'paddon_not_found');
});
test('unlock is role/locker/free-mode sensitive, returns full snapshot, and blocks received paddons', () => {
  const api = setup(); assert.equal(detail(api, '00002').body.can_unlock, true);
  const unlocked = write(api, 'unlock', '00002'); assert.equal(unlocked.status, 200); assert.equal(unlocked.body.paddon.locked_at_unix, null);
  assert.equal(unlocked.body.can_unlock, false); assert.equal(unlocked.body.can_manage_items, true);
  assert.equal(write(api, 'unlock', '00005').body.error, 'paddon_already_received');
  const nonAdmin = setup('paddons', { profile: { role: 'tayyorlov_masteri', ref: 'qa-admin' }, capabilities: ['production.map.manage'] });
  assert.equal(detail(nonAdmin, '00002').body.can_unlock, false); assert.equal(write(nonAdmin, 'unlock', '00002').body.error, 'paddon_unlock_forbidden');
  const worker = setup('paddons', { profile: { role: 'aparatchi', ref: 'qa-worker-1' }, capabilities: ['apparatus.queue.manage'] });
  worker.seed({ action: 'lock', code: '00007' }); assert.equal(detail(worker, '00007').body.can_unlock, true); assert.equal(write(worker, 'unlock', '00007').status, 200);
  const free = setup('free-movement', { profile: { role: 'tayyorlov_masteri', ref: 'qa-user' }, capabilities: ['production.map.manage'] });
  assert.equal(detail(free, '00002').body.can_unlock, true); assert.equal(write(free, 'unlock', '00002').status, 200);
});
test('summary weights use measured kg/core and waiting-only totals, preserve unknowns, and retain frozen receipt totals', () => {
  const api = setup(), first = detail(api).body.paddon;
  assert.equal(first.total_gross_kg, 12); assert.equal(first.total_net_kg, 11.5);
  assert.equal(write(api, 'add', '00001', ['qa-paddon-wip-3']).body.paddon.total_gross_kg, null);
  assert.equal(detail(api).body.paddon.total_net_kg, null);
  api.seed({ action: 'batch', batch_id: 'qa-paddon-wip-3', patch: { wip_status: 'in_use' } });
  assert.equal(detail(api).body.paddon.total_gross_kg, 12); assert.equal(detail(api).body.paddon.item_count, 2);
  const frozen = detail(api, '00005').body; assert.equal(frozen.paddon.total_gross_kg, 77); assert.equal(frozen.paddon.total_net_kg, 75);
  api.seed({ action: 'batch', batch_id: 'qa-paddon-wip-9', patch: { finished_goods_kg: 1000, bobina_kg: 10, wip_status: 'processed' } });
  assert.equal(detail(api, '00005').body.paddon.total_gross_kg, 77); assert.equal(detail(api, '00005').body.paddon.total_net_kg, 75);
  assert.equal(frozen.can_manage_items, false); assert.equal(frozen.can_unlock, false);
});
test('native delete/unlock deny unknown fields; create/batch requests ignore unknown fields and maintain native typed defaults', () => {
  const api = setup();
  for (const kind of ['delete', 'unlock']) {
    assert.equal(api.request('POST', `${paddonsPath}/${kind}`, { code: '00003', expected_revision: 1 }).body.error, 'invalid_json');
    assert.equal(api.request('POST', `${paddonsPath}/${kind}`, {}).body.error, 'invalid_json');
    assert.equal(api.request('POST', `${paddonsPath}/${kind}`, { code: ' ' }).body.error, 'paddon_invalid_input');
  }
  assert.equal(api.request('POST', paddonsPath + '/items/add-batch', { code: '00001', progress_batch_ids: ['qa-paddon-wip-2'], actor_ref: 'ignored', expected_revision: 9 }).status, 200);
  assert.equal(api.request('POST', paddonsPath + '/items/add-batch', { code: '00001' }).body.error, 'paddon_invalid_input');
  assert.equal(api.request('POST', paddonsPath + '/items/add-batch', { code: '00001', progress_batch_ids: [1] }).body.error, 'invalid_json');
});
test('slice routes use GET/POST only and leave printing/confirm/successor/settings/single-row handlers untouched', () => {
  const api = setup();
  assert.equal(api.request('POST', paddonsPath, {}).status, 405); assert.equal(api.request('DELETE', paddonsPath + '/delete', { code: '00003' }).status, 405);
  for (const suffix of ['qr/print', 'qr/confirm', 'qr/report', 'active/next', 'management-settings', 'items/add', 'items/remove', 'commands/receipt']) assert.equal(api.request('POST', paddonsPath + '/' + suffix, {}), null);
});
test('small synthetic controls reject arbitrary actions/patches without mutating unrelated fixture state', () => {
  const api = setup(), before = structuredClone(api.state.paddons), workerGroups = structuredClone(api.state.workerGroups);
  for (const input of [null, [], { scenario: 'production' }, { scenario: 'empty', token: 'NO' }, { action: 'reset-db' }, { action: 'concurrent', code: '00003', patch: { receipt: {} } }, { action: 'batch', batch_id: 'qa-paddon-wip-2', patch: { actor_ref: 'forged' } }, { action: 'batch', batch_id: 'qa-paddon-wip-2', patch: { finished_goods_stock_id: 1 } }]) assert.equal(api.seed(input).status, 400);
  assert.deepEqual(api.state.paddons, before); assert.deepEqual(api.state.workerGroups, workerGroups);
  assert.equal(api.seed({ action: 'remove-paddon', code: '00003' }).status, 200); assert.equal(detail(api, '00003').status, 404);
});
