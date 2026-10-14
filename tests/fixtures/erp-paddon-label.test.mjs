import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { apparatusIds } from './erp-seed.mjs';
import { createPaddonFixtureExtension } from './erp-paddons.mjs';
import { paddonLabelFixtureRoute, paddonQrPrintPath, paddonQrReportPath, seedPaddonLabelScenario } from './erp-paddon-label.mjs';

function setup(scenario = 'labels', changes = {}) {
  const api = extensionHarness(context => paddonLabelFixtureRoute(context) ?? createPaddonFixtureExtension(context.state).route(context), { assignedApparatus: [apparatusIds.cut], ...changes });
  assert.equal(seedPaddonLabelScenario(api.state, { scenario }).status, 200);
  return { ...api, seed: input => seedPaddonLabelScenario(api.state, input) };
}
const report = (api, code = '00001') => api.request('GET', `${paddonQrReportPath}?code=${encodeURIComponent(code)}`);
const prepare = (api, code = '00001', options = {}) => api.request('POST', paddonQrPrintPath, { code, print_transport: 'offline', ...options });
const worker = { role: 'aparatchi', ref: 'qa-worker-1', display_name: ' QA Operator ' };

test('QR report uses native four-capability OR and returns the scan projection without available catalog', () => {
  for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']) {
    const api = setup('labels', { capabilities: [capability] }), value = report(api);
    assert.equal(value.status, 200); assert.equal(value.body.paddon.code, '00001'); assert.equal(value.body.qr_payload, '00001'); assert.equal(value.body.items.length, 1);
    assert.equal(value.body.paddon.total_gross_kg, 12); assert.equal(value.body.paddon.total_net_kg, 11.5); assert.equal(value.body.available_items, undefined);
    assert.equal(typeof value.body.free_movement_enabled, 'boolean'); assert.equal(typeof value.body.can_manage_items, 'boolean'); assert.equal(typeof value.body.can_unlock, 'boolean');
  }
  const denied = setup('labels', { capabilities: [] }); assert.equal(report(denied).status, 403);
});
test('offline preparation accepts every authenticated native role independently of report or mutation capabilities', () => {
  for (const role of ['supplier', 'werka', 'customer', 'aparatchi', 'qolipchi', 'boyoqchi', 'material_taminotchi', 'admin', 'tayyorlov_masteri', 'homashyo_rezkachi']) {
    const api = setup('labels', { profile: { role, ref: 'another-actor' }, capabilities: [] }); api.state.paddonFixture.worker_visibility_enabled = true;
    const before = structuredClone(api.state), result = prepare(api);
    assert.equal(report(api).status, 403); assert.equal(result.status, 200); assert.equal(result.body.can_close_after_print, false); assert.deepEqual(api.state, before);
  }
  assert.deepEqual(paddonLabelFixtureRoute({ path: paddonQrPrintPath, method: 'POST' }), { status: 401, body: { error: 'unauthorized' } });
});
test('prepared label metadata follows native defaults and raw five-digit code without using paddon weights for label quantities', () => {
  const api = setup(), result = prepare(api);
  assert.deepEqual(result.body.print, { ok: true, status: 'prepared', qr_payload: '00001', item_code: '00001', item_name: 'Paddon 00001', apparatus: '', apparatus_display_name: '', customer_name: '', executor_name: 'QA Administrator', qty: 1, gross_qty: 1, tare_enabled: false, tare_kg: 0, unit: 'dona', progress_unit: 'dona', label_kind: 'paddon_code', printer: 'godex', print_mode: 'label', printer_status: 'client_usb_pending', print_count: 1 });
  assert.equal(result.body.paddon.total_gross_kg, 12); assert.equal(result.body.paddon.total_net_kg, 11.5); assert.equal(result.body.qr_payload, '00001'); assert.equal(result.body.printed, undefined);
  assert.equal(result.body.available_items, undefined); assert.equal(result.body.receipt, undefined);
});
test('preparation trims native ASCII options, normalizes0→1 and supports native u32 rather than inventing mobile UI100 bound', () => {
  const api = setup();
  assert.deepEqual(prepare(api, ' 00001 ', { printer: ' ZEBRA ', print_mode: ' QR ', print_count: 0 }).body.print, { ...prepare(api).body.print, printer: 'zebra', print_mode: 'qr' });
  assert.equal(prepare(api, '00001', { print_count: 101 }).body.print.print_count, 101);
  assert.equal(prepare(api, '00001', { print_count: 0xffff_ffff }).body.print.print_count, 0xffff_ffff);
  assert.equal(prepare(api, '00001', { printer: 'İ-GODEX' }).body.print.printer, 'İ-godex');
  for (const print_count of [-1, 0.5, null, 0x1_0000_0000]) assert.equal(prepare(api, '00001', { print_count }).body.error, 'invalid_json');
});
test('offline preparation does not lock paddons or alter selection, membership, timestamps or successor mappings even when repeated', () => {
  const api = setup('labels', { profile: worker }); api.seed({ action: 'visibility', enabled: true });
  api.state.paddonActiveSelections.push({ actor_role: worker.role, actor_ref: worker.ref, apparatus: apparatusIds.cut, code: '00001' });
  api.state.paddonSuccessors = [{ source_code: '00002', code: '00001', actor_role: worker.role, actor_ref: worker.ref, apparatus: apparatusIds.cut }];
  const before = structuredClone(api.state), first = prepare(api), repeated = prepare(api);
  assert.equal(first.status, 200); assert.deepEqual(repeated, first); assert.equal(first.body.can_close_after_print, true); assert.equal(first.body.paddon.locked_at_unix, null);
  assert.deepEqual(api.state, before);
});
test('native close-after-print offer metadata requires actual aparatchi role, queue.manage and at least one assigned active CUT', () => {
  for (const changes of [{ profile: { role: 'admin' } }, { profile: worker, capabilities: ['apparatus.queue.read'] }, { profile: worker, assignedApparatus: [] }, { profile: worker, assignedApparatus: [apparatusIds.print] }]) {
    const api = setup('labels', changes); api.seed({ action: 'visibility', enabled: true }); assert.equal(prepare(api).body.can_close_after_print, false);
  }
  const api = setup('labels', { profile: worker }); api.seed({ action: 'visibility', enabled: true }); assert.equal(prepare(api).body.can_close_after_print, true);
  for (const assignedApparatus of [[apparatusIds.cut, 'QA Machine'], [apparatusIds.cut, 'apparatus:qa:missing']]) {
    const invalid = setup('labels', { profile: worker, assignedApparatus }); invalid.seed({ action: 'visibility', enabled: true });
    const before = structuredClone(invalid.state); assert.ok([400, 500].includes(prepare(invalid).status)); assert.deepEqual(invalid.state, before);
  }
});
test('locked and received reprints preserve original state and frozen summary kg; lock avoids assigned lookup', () => {
  const locked = setup('locked', { profile: worker, assignedApparatus: ['QA Invalid Assignment'] }); locked.seed({ action: 'visibility', enabled: true });
  const before = structuredClone(locked.state), result = prepare(locked);
  assert.equal(result.status, 200); assert.notEqual(result.body.paddon.locked_at_unix, null); assert.equal(result.body.can_close_after_print, false); assert.deepEqual(locked.state, before);
  const received = setup('received', { profile: { role: 'werka', ref: 'other-warehouse-keeper' }, capabilities: [] }), prior = structuredClone(received.state), reprint = prepare(received, '00005');
  assert.equal(reprint.status, 200); assert.equal(reprint.body.paddon.total_gross_kg, 77); assert.equal(reprint.body.paddon.total_net_kg, 75); assert.equal(reprint.body.print.qty, 1); assert.deepEqual(received.state, prior);
});
test('native role visibility applies to both report and prepare, including a role with no report capabilities', () => {
  const api = setup('visibility', { profile: worker, capabilities: ['apparatus.queue.read'] });
  assert.equal(report(api, '00006').status, 404); assert.equal(prepare(api, '00006').status, 404); assert.equal(report(api, '00007').status, 200); assert.equal(prepare(api, '00007').status, 200);
  api.capabilities([]); assert.equal(report(api, '00007').status, 403); assert.equal(prepare(api, '00007').status, 200);
  api.seed({ action: 'visibility', enabled: true }); assert.equal(prepare(api, '00006').status, 200);
});
test('opaque legacy identity remains exact; source changes and current choices do not affect an already returned preparation', () => {
  const api = setup(); assert.equal(api.seed({ action: 'identity', code: '00001', id: 'legacy/opaque-paddon:stored' }).status, 200);
  const result = prepare(api), original = structuredClone(result);
  assert.equal(result.body.paddon.id, 'legacy/opaque-paddon:stored'); assert.equal(result.body.qr_payload, '00001');
  api.seed({ action: 'concurrent', code: '00001', patch: { note: 'Concurrent change' } }); api.seed({ action: 'lock', code: '00001' });
  assert.deepEqual(result, original); assert.equal(report(api).body.paddon.note, 'Concurrent change'); assert.notEqual(report(api).body.paddon.locked_at_unix, null);
  const other = prepare(api, '00003'); assert.equal(other.body.qr_payload, '00003'); assert.equal(result.body.qr_payload, '00001');
});
test('unknown kilograms remain unknown in report and preparation while label quantity stays one dona', () => {
  const api = setup('unknown-weight'), value = report(api), result = prepare(api);
  assert.equal(value.body.paddon.total_gross_kg, null); assert.equal(value.body.paddon.total_net_kg, null); assert.equal(result.body.paddon.total_gross_kg, null);
  assert.equal(result.body.print.gross_qty, 1); assert.equal(result.body.print.unit, 'dona');
});
test('invalid/missing/malformed codes and preparation JSON remain known failures without any mutation', () => {
  const api = setup(), before = structuredClone(api.state);
  for (const code of ['', ' ', '99999']) assert.ok([400, 404].includes(prepare(api, code).status));
  for (const body of [null, [], { code: null, print_transport: 'offline' }, { code: '00001', printer: false, print_transport: 'offline' }, { code: '00001', print_mode: null, print_transport: 'offline' }]) assert.equal(api.request('POST', paddonQrPrintPath, body).status, 400);
  assert.equal(api.request('GET', paddonQrReportPath).body.error, 'invalid_query'); assert.equal(report(api, '').body.error, 'paddon_invalid_input'); assert.equal(report(api, '99999').body.error, 'paddon_not_found');
  assert.deepEqual(api.state, before);
});
test('native print request tolerates unknown fields but the fixture never dispatches server transport or printer commands', () => {
  const api = setup(), before = structuredClone(api.state);
  assert.equal(prepare(api, '00001', { extra_native_ignored_field: 'x' }).status, 200);
  for (const print_transport of [undefined, '', 'wifi', 'server', 'usb']) assert.equal(prepare(api, '00001', { print_transport }).body.error, 'offline_preparation_only');
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal(api.request(method, paddonQrPrintPath).status, 405);
  assert.equal(api.request('POST', paddonQrReportPath, {}).status, 405); assert.deepEqual(api.state, before);
  for (const suffix of ['qr/confirm', 'driver/print', 'management-settings', 'active/next']) assert.equal(paddonLabelFixtureRoute({ path: `/v1/mobile/admin/production-maps/paddons/${suffix}`, method: 'POST' }), null);
});
test('explicit fixture controls refuse unrelated or malformed commands and empty report never fabricates a paddon', () => {
  const api = setup('empty'); assert.equal(report(api).status, 404); assert.equal(prepare(api).status, 404);
  for (const input of [null, [], { scenario: 'production' }, { scenario: 'labels', token: 'NO' }, { action: 'confirm' }, { action: 'visibility', enabled: 'true' }, { action: 'identity', code: '00001', id: ' ' }]) assert.equal(api.seed(input).status, 400);
});
