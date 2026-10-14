import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { apparatusIds } from './erp-seed.mjs';
import { createPaddonFixtureExtension } from './erp-paddons.mjs';
import { attachPaddonHandoffOutputs, paddonActivePath, paddonHandoffFixtureRoute, paddonNextPath, seedPaddonHandoffScenario } from './erp-paddon-handoff.mjs';

const cut = apparatusIds.cut, secondCut = 'apparatus:qa:handoff-cut-0';
function setup(scenario = 'handoff', changes = {}) {
  const api = extensionHarness(context => paddonHandoffFixtureRoute(context) ?? createPaddonFixtureExtension(context.state).route(context), { assignedApparatus: [cut, secondCut], ...changes });
  assert.equal(seedPaddonHandoffScenario(api.state, { scenario }).status, 200);
  return { ...api, seed: input => seedPaddonHandoffScenario(api.state, input) };
}
const active = (api, apparatus = cut) => api.request('GET', `${paddonActivePath}?apparatus=${encodeURIComponent(apparatus)}`);
const choose = (api, code, apparatus = cut) => api.request('PUT', paddonActivePath, { apparatus, code });
const next = (api, code = '00002', apparatus = cut) => api.request('POST', paddonNextPath, { apparatus, code });
const worker = { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' };
function output(api, id) { return { ...structuredClone(api.state.paddonBatches[0]), batch_id: id, qr_payload: `QA-NEW-OUTPUT:${id}`, finished_goods_kg: 10, bobina_kg: 0.5 }; }

test('GET/PUT active use native three-capability OR; queue.read is denied even on GET', () => {
  const denied = setup('empty', { capabilities: ['apparatus.queue.read'] });
  assert.equal(active(denied).status, 403); assert.equal(choose(denied, '').status, 403);
  for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.manage']) {
    const api = setup('handoff', { capabilities: [capability] }); assert.equal(active(api).status, 200); assert.equal(choose(api, '00003').status, 200);
  }
});
test('admin.access bypasses active assignment only; labels/aliases do not identify canonical scope and non-CUT is rejected', () => {
  const admin = setup('handoff', { capabilities: ['admin.access'], assignedApparatus: [] }); assert.equal(active(admin).status, 200);
  const unassigned = setup('handoff', { capabilities: ['production.map.manage'], assignedApparatus: ['QA Rezka'] }); assert.equal(active(unassigned).body.error, 'apparatus_not_assigned');
  assert.equal(active(admin, 'QA Rezka').body.error, 'canonical_apparatus_id_required'); assert.equal(active(admin, apparatusIds.print).body.error, 'paddon_invalid_input');
  assert.equal(active(admin, 'apparatus:qa:missing').body.error, 'store_failed');
});
test('active scope is actor role/ref plus apparatus, never a global selection or display label', () => {
  const api = setup(); assert.equal(choose(api, '00003').status, 200); assert.equal(active(api).body.code, '00003'); assert.equal(active(api, secondCut).body.code, null);
  api.profile.ref = 'qa-admin-2'; assert.equal(active(api).body.code, null); assert.equal(choose(api, '00001').status, 200);
  api.profile.ref = 'qa-admin'; assert.equal(active(api).body.code, '00003'); api.profile.role = 'tayyorlov_masteri'; assert.equal(active(api).body.code, null);
});
test('GET filters locked/received/invisible selections to explicit null without mutating stored raw scope', () => {
  const api = setup(); choose(api, '00003'); api.seed({ action: 'lock', code: '00003' });
  const before = structuredClone(api.state.paddonActiveSelections); assert.deepEqual(active(api).body, { ok: true, apparatus: cut, code: null }); assert.deepEqual(api.state.paddonActiveSelections, before);
  api.seed({ action: 'unlock', code: '00003' }); api.seed({ action: 'received', code: '00003' }); assert.equal(active(api).body.code, null);
  const operator = setup('selected', { profile: worker }); operator.state.paddonFixture.worker_visibility_enabled = true;
  assert.equal(choose(operator, '00003').status, 200); operator.state.paddonFixture.worker_visibility_enabled = false;
  assert.equal(active(operator).body.code, null); assert.equal(operator.state.paddonActiveSelections.find(row => row.actor_role === worker.role && row.actor_ref === worker.ref).code, '00003');
});
test('PUT clear uses empty string, requires visibility/open/unreceived target, and rejects malformed/unknown body fields atomically', () => {
  const api = setup(); choose(api, '00003');
  assert.deepEqual(choose(api, ''), { status: 200, body: { ok: true, apparatus: cut, code: null } });
  assert.equal(choose(api, '00002').body.error, 'paddon_locked'); assert.equal(choose(api, '00005').body.error, 'paddon_invalid_input'); assert.equal(choose(api, '99999').body.error, 'paddon_not_found');
  assert.equal(choose(api, 'Ё'.repeat(65)).body.error, 'paddon_invalid_input');
  for (const body of [{ apparatus: cut }, { code: '00003' }, { apparatus: cut, code: null }, { apparatus: cut, code: '00003', actor_ref: 'forged' }, { apparatus: cut, code: '00003', expected_revision: 1 }]) assert.equal(api.request('PUT', paddonActivePath, body).body.error, 'invalid_json');
  assert.equal(active(api).body.code, null);
  const operator = setup('handoff', { profile: worker }); assert.equal(choose(operator, '00003').status, 404); assert.equal(choose(operator, '00007').status, 200);
});
test('canonical catalog has native read guard500/name-search independent from active queue.manage guard', () => {
  const api = setup('bounded');
  const all = api.request('GET', '/v1/mobile/admin/apparatus?limit=500').body; assert.equal(all.length, 500);
  assert.ok(!all.some(row => row.apparatus_id === 'apparatus:qa:handoff-cut-504'));
  assert.equal(api.request('GET', '/v1/mobile/admin/apparatus?q=Handoff%20CUT%20504&limit=500').body[0].apparatus_id, 'apparatus:qa:handoff-cut-504');
  api.capabilities(['apparatus.queue.manage']); assert.equal(active(api).status, 200); assert.equal(api.request('GET', '/v1/mobile/admin/apparatus').status, 403);
});
test('successor requires queue.manage, actual aparatchi and assigned active CUT even with admin.access', () => {
  for (const changes of [{ capabilities: ['admin.access'], profile: worker }, { profile: { role: 'admin', ref: 'qa-admin' } }, { profile: worker, assignedApparatus: [] }, { profile: worker, assignedApparatus: [apparatusIds.print] }]) {
    const api = setup('handoff', changes); assert.equal(next(api).status, 403);
  }
  const invalidAssigned = setup('handoff', { profile: worker, assignedApparatus: [cut, 'QA Machine'] }); assert.equal(next(invalidAssigned).body.error, 'canonical_apparatus_id_required');
  const api = setup('handoff', { profile: worker }); assert.equal(next(api).status, 200);
});
test('successor source must be visible and locked; need not be current, unreceived, empty or locked by caller', () => {
  const api = setup('selected', { profile: worker }); assert.equal(active(api).body.code, '00007');
  const source = api.state.paddons.find(row => row.code === '00002'); source.locked_by_ref = 'qa-other-locker'; source.receipt = { total_gross_kg: 77, total_net_kg: 75 };
  const created = next(api); assert.equal(created.status, 200); assert.notEqual(created.body.code, source.code); assert.equal(created.body.paddon.locked_at_unix, null); assert.equal(active(api).body.code, created.body.code);
  assert.equal(next(api, '00007').body.error, 'paddon_invalid_input'); assert.equal(next(api, '00003').body.error, 'paddon_not_found');
});
test('native mapping source+actor+apparatus creates or reuses successor and explicit replay resets active again', () => {
  const api = setup('handoff', { profile: worker }), first = next(api), count = api.state.paddons.length;
  assert.equal(choose(api, '00007').status, 200); assert.equal(active(api).body.code, '00007');
  const repeated = next(api); assert.equal(repeated.body.code, first.body.code); assert.equal(api.state.paddons.length, count); assert.equal(active(api).body.code, first.body.code);
  const otherApparatus = next(api, '00002', secondCut); assert.notEqual(otherApparatus.body.code, first.body.code);
  api.state.paddonFixture.worker_visibility_enabled = true; api.profile.ref = 'qa-worker-2'; const otherActor = next(api); assert.notEqual(otherActor.body.code, first.body.code);
});
test('reused successor may already contain outputs and returns authoritative nonempty weights/count', () => {
  const api = setup('handoff', { profile: worker }), first = next(api), batch = output(api, 'new-successor-output');
  assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: cut, batches: [batch] }), { status: 200, code: first.body.code, attached: [batch.batch_id] });
  const repeated = next(api); assert.equal(repeated.body.code, first.body.code); assert.equal(repeated.body.paddon.item_count, 1); assert.equal(repeated.body.paddon.total_gross_kg, 12); assert.equal(repeated.body.paddon.total_net_kg, 11.5);
});
test('locked or received mapped successor refuses atomically without overwriting active or allocating another paddon', () => {
  for (const action of ['lock', 'received']) {
    const api = setup('handoff', { profile: worker }), first = next(api); api.seed({ action, code: first.body.code }); choose(api, '00007');
    const count = api.state.paddons.length, selections = structuredClone(api.state.paddonActiveSelections), maps = structuredClone(api.state.paddonSuccessors);
    assert.equal(next(api).body.error, 'paddon_locked'); assert.equal(api.state.paddons.length, count); assert.deepEqual(api.state.paddonActiveSelections, selections); assert.deepEqual(api.state.paddonSuccessors, maps);
  }
});
test('native unlock deletes source mappings; relock starts a new cycle while source is never forced to match active', () => {
  const api = setup('handoff', { profile: worker }), first = next(api);
  assert.equal(api.request('POST', '/v1/mobile/admin/production-maps/paddons/unlock', { code: '00002' }).status, 200); assert.equal(api.state.paddonSuccessors.length, 0);
  api.seed({ action: 'lock', code: '00002' }); const later = next(api); assert.notEqual(later.body.code, first.body.code);
});
test('unused mapped successor deletion mirrors native FK NO ACTION store_failed500 and rolls back deletion', () => {
  const api = setup('handoff', { profile: worker }), created = next(api), before = structuredClone(api.state);
  assert.deepEqual(api.request('POST', '/v1/mobile/admin/production-maps/paddons/delete', { code: created.body.code }), { status: 500, body: { error: 'store_failed' } });
  assert.deepEqual(api.state, before);
  assert.equal(api.request('POST', '/v1/mobile/admin/production-maps/paddons/unlock', { code: '00002' }).status, 200);
  const revision = api.state.rev;
  assert.equal(api.request('POST', '/v1/mobile/admin/production-maps/paddons/delete', { code: created.body.code }).status, 200);
  assert.equal(api.state.rev, revision + 1);
});
test('mapped successor delete preserves native permission, input, visibility and history refusals before FK failure', () => {
  for (const refusal of ['permission', 'input', 'visibility', 'lock', 'receipt', 'history', 'timestamp', 'membership']) {
    const api = setup('handoff', { profile: worker }), created = next(api), code = created.body.code, target = api.state.paddons.find(row => row.code === code);
    let status = 409, expected = 'paddon_delete_locked', body = { code };
    if (refusal === 'permission') { api.capabilities(['apparatus.queue.read']); status = 403; expected = 'forbidden'; }
    if (refusal === 'input') { body.expected_revision = 1; status = 400; expected = 'invalid_json'; }
    if (refusal === 'visibility') { api.profile.ref = 'qa-worker-2'; status = 404; expected = 'paddon_not_found'; }
    if (refusal === 'lock') target.locked_at_unix = ++api.state.paddonFixture.clock;
    if (refusal === 'receipt') target.receipt = { total_gross_kg: 1, total_net_kg: 1 };
    if (refusal === 'history') target.history = true;
    if (refusal === 'timestamp') target.updated_at_unix++;
    if (refusal === 'membership') api.state.paddonMemberships.push({ code, batch_id: 'removed-history', removed: true });
    const before = structuredClone(api.state);
    assert.deepEqual(api.request('POST', '/v1/mobile/admin/production-maps/paddons/delete', body), { status, body: { error: expected } });
    assert.deepEqual(api.state, before);
  }
});
test('older synthetic unlock and relock remove stale successor FK constraints before an allowed delete', () => {
  for (const relock of [false, true]) {
    const api = setup('handoff', { profile: worker }), first = next(api), paddons = createPaddonFixtureExtension(api.state);
    assert.equal(paddons.seed({ action: 'unlock', code: '00002' }).status, 200);
    if (relock) assert.equal(paddons.seed({ action: 'lock', code: '00002' }).status, 200);
    assert.equal(api.state.paddonSuccessors.length, 1);
    const revision = api.state.rev;
    assert.equal(api.request('POST', '/v1/mobile/admin/production-maps/paddons/delete', { code: first.body.code }).status, 200);
    assert.equal(api.state.rev, revision + 1); assert.equal(api.state.paddonSuccessors.length, 0);
    assert.ok(!api.state.paddons.some(row => row.code === first.body.code)); assert.equal(active(api).body.code, null);
    if (relock) assert.notEqual(next(api).body.code, first.body.code);
  }
});
test('cycle tags preserve native unlock semantics even when prior fixture owns unlock routing first', () => {
  const api = setup('handoff', { profile: worker }), first = next(api);
  const paddons = createPaddonFixtureExtension(api.state); assert.equal(paddons.seed({ action: 'unlock', code: '00002' }).status, 200); assert.equal(paddons.seed({ action: 'lock', code: '00002' }).status, 200);
  assert.notEqual(next(api).body.code, first.body.code);
});
test('invalid next and exhausted code allocation leave source, mappings and active unchanged', () => {
  const api = setup('handoff', { profile: worker }), before = { paddons: structuredClone(api.state.paddons), maps: structuredClone(api.state.paddonSuccessors), active: structuredClone(api.state.paddonActiveSelections) };
  for (const body of [{ code: '00002', apparatus: cut, expected_revision: 1 }, { code: '00002', apparatus: cut, idempotency_key: 'fake' }, { apparatus: cut }]) assert.equal(api.request('POST', paddonNextPath, body).body.error, 'invalid_json');
  api.state.paddonFixture.next_number = 100000; assert.equal(next(api).body.error, 'paddon_code_exhausted'); assert.deepEqual(api.state.paddons, before.paddons); assert.deepEqual(api.state.paddonSuccessors, before.maps); assert.deepEqual(api.state.paddonActiveSelections, before.active);
});
test('new cut outputs attach to fresh actor+apparatus selection, not a legacy completion body or another actor/app selection', () => {
  const api = setup('selected'), first = output(api, 'new-cut-output');
  assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: cut, batches: [first] }), { status: 200, code: '00003', attached: [first.batch_id] });
  const otherActor = output(api, 'other-actor-output'); assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: { ...api.profile, ref: 'qa-admin-2' }, apparatus: cut, batches: [otherActor] }), { status: 200, code: null, attached: [] });
  const otherApp = output(api, 'other-app-output'); assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: secondCut, batches: [otherApp] }), { status: 200, code: null, attached: [] });
  assert.equal(api.state.paddonMemberships.find(row => row.batch_id === first.batch_id).code, '00003');
});
test('clear/locked/received/invisible selection yields ungrouped fresh outputs with no retroactive backfill on replay', () => {
  for (const condition of ['clear', 'lock', 'received', 'invisible']) {
    const api = setup('selected'), batch = output(api, `ungrouped-${condition}`);
    if (condition === 'clear') choose(api, ''); else if (condition === 'invisible') { api.state.paddonFixture.worker_visibility_enabled = true; api.profile.role = worker.role; api.profile.ref = worker.ref; choose(api, '00003'); api.state.paddonFixture.worker_visibility_enabled = false; } else api.seed({ action: condition, code: '00003' });
    assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: cut, batches: [batch] }), { status: 200, code: null, attached: [] });
    api.profile.role = 'admin'; api.profile.ref = 'qa-admin'; choose(api, '00001');
    assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: cut, batches: [batch] }), { status: 200, code: null, attached: [] });
    assert.ok(!api.state.paddonMemberships.some(row => row.batch_id === batch.batch_id));
  }
});
test('mixed output conflict is atomic over new batches, seen IDs, membership, and target timestamps', () => {
  const api = setup('selected'), valid = output(api, 'new-valid-output'), conflicting = output(api, 'new-conflicting-output');
  api.state.paddonMemberships.push({ code: '00001', batch_id: conflicting.batch_id, removed: false });
  const before = { batches: structuredClone(api.state.paddonBatches), seen: structuredClone(api.state.paddonHandoffOutputBatchIds), members: structuredClone(api.state.paddonMemberships), paddons: structuredClone(api.state.paddons) };
  assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: cut, batches: [valid, conflicting] }), { status: 409, error: 'paddon_item_already_assigned' });
  assert.deepEqual(api.state.paddonBatches, before.batches); assert.deepEqual(api.state.paddonHandoffOutputBatchIds, before.seen); assert.deepEqual(api.state.paddonMemberships, before.members); assert.deepEqual(api.state.paddons, before.paddons);
});
test('non-CUT outputs and previously known batches never gain an active cutting paddon on replay', () => {
  const api = setup('selected'), batch = output(api, 'non-cut-output');
  assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: apparatusIds.print, batches: [batch] }), { status: 200, code: null, attached: [] });
  assert.deepEqual(attachPaddonHandoffOutputs({ state: api.state, profile: api.profile, apparatus: cut, batches: [api.state.paddonBatches[0]] }), { status: 200, code: null, attached: [] });
});
test('retired canonical CUT fails native scope read rather than becoming an empty selection', () => {
  const api = setup('selected'); assert.equal(api.seed({ action: 'retire-apparatus', apparatus: cut }).status, 200);
  assert.equal(active(api).status, 500); assert.equal(active(api).body.error, 'store_failed');
});
test('fixture controls are explicit synthetic changes and expose no print/confirm/preparation/settings route', () => {
  const api = setup();
  for (const input of [null, [], { scenario: 'production' }, { scenario: 'handoff', token: 'NO' }, { action: 'print' }, { action: 'concurrent', apparatus: cut, code: '00003', actor_ref: '' }, { action: 'lock', code: '00003', printer: 'physical' }]) assert.equal(api.seed(input).status, 400);
  for (const path of ['qr/print', 'qr/confirm', 'management-settings', 'commands/receipt']) assert.equal(paddonHandoffFixtureRoute({ state: api.state, method: 'POST', path: '/v1/mobile/admin/production-maps/paddons/' + path }), null);
});
