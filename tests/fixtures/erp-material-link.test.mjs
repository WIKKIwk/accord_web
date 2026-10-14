import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { createFixture } from './erp-fixture.mjs';
import { apparatusIds, fixtureCapabilities, fixtureLogin, fixtureSecondLogin, fixtureToken, fixtureSecondToken } from './erp-seed.mjs';
import { materialLinkFixtureRoute, materialLinkSnapshotControl, materialLinkPath, seedMaterialLinkScenario, validMaterialLinkProfile } from './erp-material-link.mjs';

const order_id = 'zakaz-qa-1001', apparatus = apparatusIds.print;
const worker = { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Brigadir' }, mover = { role: 'material_taminotchi', ref: 'QA-MATERIAL-1', display_name: 'QA Material mas’uli' };
const overview = materialLinkPath + '?order_id=' + order_id + '&apparatus=' + encodeURIComponent(apparatus);
const detail = request => materialLinkPath + '?request_id=' + request.request_id;
const create = (barcodes = ['QA-ROLL-1']) => ({ action: 'create', order_id, apparatus, barcodes });
const decision = (request, action = 'approve', barcodes = ['QA-ROLL-1']) => ({ request_id: request.request_id, action, barcodes });
function setup(scenario = 'available', changes = {}) {
  const api = extensionHarness(materialLinkFixtureRoute, { profile: worker, assignedApparatus: [apparatus], capabilities: fixtureCapabilities, ...changes });
  assert.equal(seedMaterialLinkScenario(api.state, { scenario }).status, 200); return api;
}
function make(api, barcodes) { return api.request('POST', materialLinkPath, create(barcodes)).body.requests[0]; }
function actor(api, profile) { Object.assign(api.profile, profile); }

test('material link profile override accepts only explicit synthetic identities and actual exact role names', () => {
  assert.equal(validMaterialLinkProfile(null), true);
  for (const profile of [worker, mover, { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator' }]) assert.equal(validMaterialLinkProfile(profile), true);
  for (const profile of [{ ...worker, role: 'operator' }, { ...mover, role: 'material_provider' }, { ...worker, ref: 'real-user' }, { ...worker, display_name: 'Someone' }, { ...worker, token: 'forbidden' }, { ...worker, legal_name: 'Real company' }, {}]) assert.equal(validMaterialLinkProfile(profile), false);
});

test('material link setup validates all scenario and clock fields before mutating the fixture', () => {
  const api = setup(), before = structuredClone(api.state);
  for (const input of [{ scenario: 'invented' }, { scenario: 'available', requester_ref: 'override' }, { action: 'advance', seconds: -1 }, { action: 'advance', seconds: 1, extra: true }, { action: 'stock', stock_id: 'qa-roll-1', patch: { warehouse: 'invented' } }]) assert.equal(seedMaterialLinkScenario(api.state, input).status, 400);
  assert.deepEqual(api.state, before);
});

test('native candidates contain actual stock placement/mover snapshot fields, without receipt or warehouse proof', () => {
  const api = setup(), before = structuredClone(api.state.assets), result = api.request('GET', overview).body;
  assert.equal(result.available_count, 2); assert.deepEqual(result.requests, []);
  assert.deepEqual(Object.keys(result.candidates[0]).sort(), ['stock_id', 'barcode', 'item_name', 'qty', 'uom', 'location_id', 'location_name', 'placement_version', 'mover_ref', 'mover_display_name'].sort());
  assert.equal(result.candidates[0].stock_id, 'qa-roll-1'); assert.equal(result.candidates[0].location_id, 'qa-location-print'); assert.equal(result.candidates[0].placement_version, 4); assert.equal(result.candidates[0].mover_ref, mover.ref);
  assert.deepEqual(api.state.assets, before);
});

test('native candidates exclude assignments, transit, unavailable stock, other locations and nonmaterial movers', () => {
  for (const patch of [{ qty: 0 }, { reserved_order_id: 'other-order' }, { transfer_id: 'qa-transit' }, { status: 'in_use' }, { physical_location: { id: 'qa-location-stock' } }, { updated_by_role: 'admin' }, { updated_by_ref: '' }]) {
    const api = setup(); Object.assign(api.state.assets[0], patch); assert.deepEqual(api.request('GET', overview).body.candidates.map(row => row.stock_id), ['qa-roll-2']);
  }
  const api = setup(); api.state.rawAssignments.push({ barcode: 'qa-roll-1' }); assert.equal(api.request('GET', overview).body.available_count, 1);
});

test('eligible candidates are prepared in actual mover apparatus/group/warehouse/width scope', () => {
  for (const [key, value] of [['apparatus', []], ['groups', []], ['warehouses', []]]) {
    const api = setup(); api.state.materialLinkFixture.movers[mover.ref][key] = value; assert.equal(api.request('GET', overview).body.available_count, 0);
  }
  const api = setup(); api.state.assets[0].width_mm = 800; assert.deepEqual(api.request('GET', overview).body.candidates.map(row => row.stock_id), ['qa-roll-2']);
});

test('list is actual aparatchi and actual apparatus scoped; an admin capability does not create a manager inbox', () => {
  for (const profile of [{ role: 'admin', ref: 'qa-admin' }, mover, { ...worker, role: 'qolipchi' }]) { const api = setup('available', { profile }); assert.equal(api.request('GET', overview).status, 403); }
  assert.equal(setup('available', { assignedApparatus: [] }).request('GET', overview).status, 403);
  const api = setup('pending'); actor(api, { ...worker, ref: 'qa-worker-2' }); assert.equal(api.request('GET', overview).body.requests.length, 0);
  api.capabilities(['admin.access']); assert.equal(api.request('GET', overview).body.available_count, 0);
});

test('list retains terminal order reads, limits latest50 and never exposes another order/apparatus/requester', () => {
  const api = setup('pending'), original = cloneRequest(api.state.materialLinkRequests[0]);
  api.state.materialLinkRequests = Array.from({ length: 55 }, (_, index) => ({ ...cloneRequest(original), request_id: 'material-link-' + (index + 1).toString(16).padStart(32, '0'), requested_at_unix: original.requested_at_unix + index }));
  api.state.materialLinkRequests.push({ ...cloneRequest(original), request_id: 'material-link-' + 'a'.repeat(32), order_id: 'zakaz-other' }, { ...cloneRequest(original), request_id: 'material-link-' + 'b'.repeat(32), apparatus_id: apparatusIds.cut }, { ...cloneRequest(original), request_id: 'material-link-' + 'c'.repeat(32), requester_ref: 'qa-worker-2' });
  api.state.orders[0].control = 'frozen'; const result = api.request('GET', overview).body;
  assert.equal(result.requests.length, 50); assert.equal(result.available_count, 0); assert.equal(result.requests[0].requested_at_unix, original.requested_at_unix + 54);
  assert.ok(result.requests.every(row => row.status === 'stale' && row.order_id === order_id && row.apparatus_id === apparatus && row.requester_ref === worker.ref));
});
function cloneRequest(request) { return structuredClone(request); }

test('native create requires actual worker role, assigned machine, active order and queue manage specifically', () => {
  for (const changes of [{ profile: { role: 'admin', ref: 'qa-admin' } }, { profile: mover }, { assignedApparatus: [] }, { capabilities: ['admin.access'] }]) assert.equal(setup('available', changes).request('POST', materialLinkPath, create()).status, 403);
  const api = setup('frozen'); assert.equal(api.request('POST', materialLinkPath, create()).body.error, 'raw_material_order_not_active'); assert.equal(api.state.materialLinkRequests.length, 0);
});

test('create validates whole selection before any mover group commits', () => {
  for (const barcodes of [[], [''], ['QA-ROLL-1', 'qa-roll-1'], ['QA-ROLL-1', 'missing']]) {
    const api = setup('multi-mover'); assert.equal(api.request('POST', materialLinkPath, create(barcodes)).status, 400); assert.equal(api.state.materialLinkRequests.length, 0);
  }
});

test('create is unkeyed and groups only selected actual movers with native IDs and 1800s expiry', () => {
  const api = setup('multi-mover'), result = api.request('POST', materialLinkPath, { ...create([' qa-roll-2 ', 'QA-ROLL-1']), expected_revision: -1, idempotency_key: 'ignored-by-native' }, { 'if-match': '-1', 'idempotency-key': 'ignored' });
  assert.equal(result.status, 200); assert.equal(result.body.requests.length, 2);
  for (const request of result.body.requests) { assert.match(request.request_id, /^material-link-[a-f0-9]{32}$/); assert.equal(request.expires_at_unix - request.requested_at_unix, 1800); assert.equal(request.requester_ref, worker.ref); assert.equal(request.candidates.length, 1); assert.equal(request.candidates[0].mover_ref, request.mover_ref); }
  assert.equal(api.state.rawAssignments.length, 0);
});

test('pending duplicate returns its original mover-group row despite a different later selection', () => {
  const api = setup(), first = make(api, ['QA-ROLL-1']), repeat = make(api, ['QA-ROLL-2']);
  assert.deepEqual(repeat, first); assert.equal(api.state.materialLinkRequests.length, 1); assert.deepEqual(repeat.candidates.map(row => row.barcode), ['QA-ROLL-1']);
});

test('unkeyed group failure preserves earlier commits and has no fabricated transaction rollback', () => {
  const api = setup('partial-create'), result = api.request('POST', materialLinkPath, create(['QA-ROLL-1', 'QA-ROLL-2']));
  assert.equal(result.status, 500); assert.equal(result.body.error, 'material_link_store_failed'); assert.equal(api.state.materialLinkRequests.length, 1); assert.equal(api.state.materialLinkRequests[0].mover_ref, 'QA-MATERIAL-1');
  assert.equal(api.request('GET', overview).body.requests.length, 1); assert.equal(api.state.rawAssignments.length, 0);
});

test('explicit partial receipt corruption keeps its first actual ID and both committed native rows', () => {
  const api = setup('partial-receipt'), result = api.request('POST', materialLinkPath, create(['QA-ROLL-1', 'QA-ROLL-2']));
  assert.equal(result.body.requests[0].event_sequence, 1); assert.equal(typeof result.body.requests[1].event_sequence, 'string'); assert.equal(api.state.materialLinkRequests.length, 2);
  assert.ok(api.state.materialLinkRequests.every(row => row.event_sequence === 1)); assert.equal(api.request('GET', overview).body.requests.length, 2);
});

test('request GET reconciles expiry exactly at 1800 seconds and persists one terminal revision', () => {
  const api = setup(), request = make(api); seedMaterialLinkScenario(api.state, { action: 'advance', seconds: 1799 });
  assert.equal(api.request('GET', detail(request)).body.request.status, 'pending'); seedMaterialLinkScenario(api.state, { action: 'advance', seconds: 1 });
  const expired = api.request('GET', detail(request)).body.request; assert.equal(expired.status, 'expired'); assert.equal(expired.event_sequence, 2); assert.equal(expired.decided_by_role, ''); assert.equal(expired.decided_at_unix, expired.expires_at_unix);
  const revision = api.state.rev; assert.deepEqual(api.request('GET', detail(request)).body.request, expired); assert.equal(api.state.rev, revision);
});

test('native stale proof includes stock ID/barcode/location/placement/mover and excludes quantity or UOM CAS', () => {
  const api = setup(), request = make(api); Object.assign(api.state.assets[0], { qty: 79, uom: 'metr' }); assert.equal(api.request('GET', detail(request)).body.request.status, 'pending');
  for (const patch of [{ asset_ref: 'different-stock' }, { identifier: 'different-barcode' }, { physical_location: { id: 'qa-location-stock' } }, { placement_version: 5 }, { updated_by_ref: 'QA-MATERIAL-2' }]) {
    const changed = setup(), saved = make(changed); Object.assign(changed.state.assets[0], patch); assert.equal(changed.request('GET', detail(saved)).body.request.status, 'stale');
  }
});

test('native reconciliation prioritizes inactive order and stale placement before expiry', () => {
  const api = setup('pending'); api.state.orders[0].control = 'frozen'; api.state.materialLinkFixture.now += 1800;
  const saved = api.request('GET', detail(api.state.materialLinkRequests[0])).body.request; assert.equal(saved.status, 'stale'); assert.match(saved.reason, /Order holati/);
  assert.equal(setup('stale').request('GET', overview).body.requests[0].status, 'stale');
});

test('request-ID GET allows only actual admin, exact saved mover or exact requester', () => {
  const api = setup('pending'), request = api.state.materialLinkRequests[0];
  for (const profile of [{ role: 'admin', ref: 'qa-admin' }, mover, worker]) { actor(api, profile); const result = api.request('GET', detail(request)); assert.equal(result.status, 200); assert.equal(result.body.can_decide, profile.role !== 'aparatchi'); }
  for (const profile of [{ ...mover, ref: 'QA-MATERIAL-2' }, { ...worker, ref: 'qa-worker-2' }, { role: 'qolipchi', ref: 'qa-qolipchi-1' }]) { actor(api, profile); assert.equal(api.request('GET', detail(request)).status, 403); }
});

test('decision requires raw_material.assign even with admin.access and only saved mover may decide', () => {
  const api = setup('pending'), request = api.state.materialLinkRequests[0]; actor(api, { role: 'admin', ref: 'qa-admin' }); api.capabilities(['admin.access']);
  assert.equal(api.request('POST', materialLinkPath, decision(request)).status, 403); api.capabilities(fixtureCapabilities); actor(api, { ...mover, ref: 'QA-MATERIAL-2' });
  assert.equal(api.request('POST', materialLinkPath, decision(request)).status, 403); assert.equal(request.status, 'pending'); assert.equal(api.state.rawAssignments.length, 0);
});

test('approval validates every selected roll before atomic assignments and terminal decision', () => {
  const api = setup('pending'), request = api.state.materialLinkRequests[0]; actor(api, mover);
  assert.equal(api.request('POST', materialLinkPath, decision(request, 'approve', ['QA-ROLL-1', 'not-in-request'])).status, 400); assert.equal(api.state.rawAssignments.length, 0); assert.equal(request.status, 'pending');
  const saved = api.request('POST', materialLinkPath, decision(request, 'approve', ['QA-ROLL-2'])).body.request;
  assert.equal(saved.status, 'approved'); assert.deepEqual(saved.selected_barcodes, ['QA-ROLL-2']); assert.equal(saved.decided_by_role, mover.role); assert.equal(saved.decided_by_name, mover.display_name);
  assert.deepEqual(api.state.rawAssignments.map(row => row.barcode), ['QA-ROLL-2']); assert.equal(api.state.rawAssignments[0].assigned_by_ref, mover.ref); assert.equal(api.state.assets[1].status, 'available');
});

test('approval by actual mover outside assigned apparatus invalidates without assignments; rejection is still scoped', () => {
  const api = setup('pending', { assignedApparatus: [] }), request = api.state.materialLinkRequests[0]; actor(api, mover);
  const saved = api.request('POST', materialLinkPath, decision(request)).body.request; assert.equal(saved.status, 'stale'); assert.equal(api.state.rawAssignments.length, 0);
  const rejected = setup('pending', { assignedApparatus: [] }); actor(rejected, mover); assert.equal(rejected.request('POST', materialLinkPath, decision(rejected.state.materialLinkRequests[0], 'reject', [])).body.request.status, 'cancelled');
});

test('native repeated terminal decisions preserve original selection, decider/time and assignments', () => {
  const api = setup('pending'), request = api.state.materialLinkRequests[0]; actor(api, mover); const original = api.request('POST', materialLinkPath, decision(request, 'approve', ['QA-ROLL-2'])).body.request;
  actor(api, { role: 'admin', ref: 'qa-admin', display_name: 'QA Later manager' }); seedMaterialLinkScenario(api.state, { action: 'advance', seconds: 20 });
  for (const action of ['approve', 'reject']) assert.deepEqual(api.request('POST', materialLinkPath, decision(request, action, ['QA-ROLL-1'])).body.request, original);
  assert.equal(api.state.rawAssignments.length, 1); assert.equal(original.decided_by_name, mover.display_name); assert.equal(original.selected_barcodes[0], 'QA-ROLL-2');
});

test('competing decision after a pending read returns its immutable saved outcome on POST', () => {
  const api = setup('decision-race'), request = api.state.materialLinkRequests[0]; actor(api, { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator' });
  assert.equal(api.request('GET', detail(request)).body.request.status, 'pending'); assert.equal(api.request('GET', detail(request)).body.request.status, 'pending');
  const result = api.request('POST', materialLinkPath, decision(request)).body.request; assert.equal(result.status, 'approved'); assert.deepEqual(result.selected_barcodes, ['QA-ROLL-2']); assert.equal(result.decided_by_name, 'QA Original manager'); assert.equal(api.state.rawAssignments.length, 1);
});

test('competing terminal outcome on the fresh read is available before any decision POST', () => {
  const api = setup('decision-read-race'), request = api.state.materialLinkRequests[0]; actor(api, { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator' });
  assert.equal(api.request('GET', detail(request)).body.request.status, 'pending'); const result = api.request('GET', detail(request)).body.request;
  assert.equal(result.status, 'approved'); assert.deepEqual(result.selected_barcodes, ['QA-ROLL-2']); assert.equal(result.decided_by_name, 'QA Original manager'); assert.equal(api.state.rawAssignments.length, 1);
});

test('rejection and requester cancellation preserve native cancelled status with distinct saved actors/reasons', () => {
  const rejected = setup('pending'), request = rejected.state.materialLinkRequests[0]; actor(rejected, mover);
  const declined = rejected.request('POST', materialLinkPath, decision(request, 'reject', [])).body.request; assert.equal(declined.status, 'cancelled'); assert.equal(declined.reason, ''); assert.equal(declined.decided_by_role, 'material_taminotchi');
  const cancelled = setup('pending'), pending = cancelled.state.materialLinkRequests[0]; actor(cancelled, { ...worker, ref: 'qa-worker-2' }); assert.equal(cancelled.request('POST', materialLinkPath, decision(pending, 'cancel', [])).status, 403);
  actor(cancelled, worker); const saved = cancelled.request('POST', materialLinkPath, decision(pending, 'cancel', [])).body.request; assert.equal(saved.status, 'cancelled'); assert.match(saved.reason, /Worker/); assert.equal(saved.decided_by_role, 'aparatchi'); assert.equal(cancelled.state.rawAssignments.length, 0);
});

test('snapshot interaction exposes actual scan-required stage and fails closed for hidden/frozen contexts', () => {
  for (const scenario of ['available', 'interaction-hidden', 'frozen']) { const api = setup(scenario), order = api.state.orders[0], node = order.map.nodes.find(row => row.id === 'print'), control = materialLinkSnapshotControl(api.state, order, node, { interaction: {} });
    assert.equal(control.interaction.start_materials_mode, scenario === 'available' ? 'scan_required' : 'hidden'); assert.equal(control.interaction.material_scan_required, scenario === 'available'); assert.equal(control.interaction.assigned_materials_display_only, scenario !== 'available'); }
  const api = setup(); assert.deepEqual(materialLinkSnapshotControl(api.state, api.state.orders[1], api.state.orders[1].map.nodes[2], { unrelated: true }), { unrelated: true });
  const order = api.state.orders[0], node = order.map.nodes.find(row => row.id === 'print');
  const blocked = materialLinkSnapshotControl(api.state, order, node, { interaction: { blocking_reason_code: 'waiting_sequence' } });
  assert.equal(blocked.interaction.mode, 'fresh_start_blocked'); assert.equal(blocked.interaction.blocking_reason_code, 'waiting_sequence'); assert.deepEqual(blocked.allowed_actions, []);
});

test('start-ready lock scenario has a real satisfied assignment, free candidates and no inherited queue blocker', () => {
  const api = setup('start-ready'), order = api.state.orders[0], node = order.map.nodes.find(row => row.id === 'print');
  const control = materialLinkSnapshotControl(api.state, order, node, { interaction: { mode: 'fresh_start_blocked', blocking_reason_code: 'waiting_sequence', previous_wip_mode: 'waiting', opening_wip_mode: 'waiting', qolip_mode: 'not_required', resume_input_required: false } });
  assert.equal(api.state.rawAssignments.length, 1); assert.equal(api.state.rawAssignments[0].barcode, 'QA-START-READY'); assert.equal(control.interaction.mode, 'fresh_start'); assert.deepEqual(control.allowed_actions, ['start']);
  assert.equal(control.interaction.blocking_reason_code, ''); assert.equal(control.interaction.previous_wip_mode, 'not_required'); assert.equal(control.interaction.opening_wip_mode, 'not_required');
  assert.equal(control.interaction.start_materials_mode, 'scan_required'); assert.equal(control.interaction.material_scan_required, true); assert.equal(control.interaction.assigned_materials_display_only, false);
  assert.deepEqual(api.request('GET', overview).body.candidates.map(row => row.barcode), ['QA-ROLL-1', 'QA-ROLL-2']);
  const before = structuredClone(api.state.rawAssignments); make(api); assert.deepEqual(api.state.rawAssignments, before); assert.equal(api.state.materialLinkRequests.length, 1);
});

test('main fixture opt-in primary profile leaves default and second session identity intact and resets cleanly', async () => {
  const fixture = createFixture(), dispatch = (method, url, body, token = fixtureToken) => fixture.dispatch({ method, url, body, headers: { authorization: 'Bearer ' + token } });
  assert.equal((await dispatch('GET', '/__qa/health')).body.fixtureVersion, 11);
  let login = await dispatch('POST', '/v1/mobile/auth/login', fixtureLogin); assert.equal(login.body.profile.role, 'admin'); assert.equal(login.body.profile.ref, 'qa-admin');
  assert.equal((await dispatch('POST', '/__qa/config', { profileOverride: worker, assignedApparatus: [apparatus] })).status, 200);
  login = await dispatch('POST', '/v1/mobile/auth/login', fixtureLogin); assert.deepEqual(login.body.profile, { ...worker, legal_name: 'QA Synthetic' }); assert.deepEqual(login.body.assigned_apparatus, [apparatus]);
  assert.equal((await dispatch('GET', '/v1/mobile/me')).body.role, 'aparatchi'); const second = await dispatch('POST', '/v1/mobile/auth/login', fixtureSecondLogin); assert.equal(second.body.profile.role, 'admin'); assert.equal(second.body.profile.ref, 'qa-admin-2'); assert.equal((await dispatch('GET', '/v1/mobile/me', undefined, fixtureSecondToken)).body.role, 'admin');
  assert.equal((await dispatch('POST', '/__qa/config', { profileOverride: { ...worker, role: 'operator' } })).status, 400); assert.equal((await dispatch('POST', '/__qa/material-link', { scenario: 'unknown' })).status, 400);
  await dispatch('POST', '/__qa/reset', {}); login = await dispatch('POST', '/v1/mobile/auth/login', fixtureLogin); assert.equal(login.body.profile.role, 'admin'); assert.deepEqual(login.body.assigned_apparatus, []); assert.equal(fixture.getState().state.materialLinkFixture, undefined);
  const logs = JSON.stringify(fixture.getLog()); for (const secret of [fixtureLogin.phone, fixtureLogin.code, fixtureToken, fixtureSecondLogin.phone, fixtureSecondLogin.code, fixtureSecondToken]) assert.ok(!logs.includes(secret));
});

test('main fixture native route logs actual create body with no idempotency or revision header', async () => {
  const fixture = createFixture(); await fixture.dispatch({ method: 'POST', url: '/__qa/config', body: { profileOverride: worker, assignedApparatus: [apparatus] } }); await fixture.dispatch({ method: 'POST', url: '/__qa/material-link', body: { scenario: 'available' } });
  await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin }); const headers = { authorization: 'Bearer ' + fixtureToken };
  const result = await fixture.dispatch({ method: 'POST', url: materialLinkPath, body: create(), headers }); assert.equal(result.status, 200); assert.equal(result.body.requests.length, 1);
  const log = fixture.getLog().at(-1); assert.deepEqual(log.body, create()); assert.equal(log.idempotencyKeyPresent, false); assert.equal(log.expectedRevisionHeader, null);
  const snapshot = await fixture.dispatch({ url: '/v1/mobile/admin/production-maps/sequence', headers }); assert.equal(snapshot.body.queue_action_controls[apparatus][order_id].interaction.start_materials_mode, 'scan_required');
});
