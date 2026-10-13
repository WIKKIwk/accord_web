import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { apparatusIds } from './erp-seed.mjs';
import { materialIntakeFixtureRoute, materialIntakeSnapshotControl, seedMaterialIntakeScenario } from './erp-material-intake.mjs';
const base = '/v1/mobile/admin', order_id = 'zakaz-qa-1001', apparatus = apparatusIds.print;
function setup(scenario = 'intake', changes = {}) { const api = extensionHarness(materialIntakeFixtureRoute, { assignedApparatus: [apparatus], ...changes }); seedMaterialIntakeScenario(api.state, { scenario }); return api; }
const input = barcode => ({ order_id, apparatus, barcode });
const delivery = { ...input('QA-ROLL-2'), delivered_by_role: 'material_taminotchi', delivered_by_ref: 'QA-MATERIAL-1', idempotency_key: 'qa-material-delivery' };
const query = (path, barcode = '') => base + path + '?order_id=' + order_id + '&apparatus=' + encodeURIComponent(apparatus) + '&barcode=' + barcode;

test('intake candidates and native control are exact active-assignment projections without claiming stock', () => {
  const api = setup(), before = structuredClone(api.state.assets), candidates = api.request('GET', query('/raw-material-intake-candidates')).body;
  assert.equal(candidates.length, 1); assert.equal(candidates[0].execution_status, 'ready'); assert.equal(candidates[0].stock_qty, 80); assert.equal(candidates[0].roll_width_mm, 515);
  assert.deepEqual(api.state.assets, before); const order = api.state.orders[0], node = order.map.nodes.find(row => row.id === 'print'), control = materialIntakeSnapshotControl(api.state, order, node, {});
  assert.equal(control.interaction.material_intake_allowed, true); assert.equal(control.work_activity.worker_ref, 'qa-worker-1');
});
test('unkeyed intake binds actual assigned apparatus, custody and amounts and never returns a session receipt', () => {
  const api = setup(), before = structuredClone(api.state.assets[0]), saved = api.request('POST', base + '/raw-material-intake', input('qa-roll-1'));
  assert.equal(saved.status, 200); assert.equal(saved.body.stock_status, 'in_use'); assert.equal(saved.body.execution_status, 'in_use'); assert.equal(saved.body.received_qty, 80); assert.equal(saved.body.consumed_qty, 0); assert.equal(saved.body.remaining_qty, 80); assert.equal(saved.body.reserved_order_id, order_id);
  assert.equal(Object.hasOwn(saved.body, 'session'), false); assert.equal(Object.hasOwn(saved.body, 'ok'), false); assert.equal(api.state.assets[0].custody_warehouse, before.custody_warehouse); assert.deepEqual(api.state.assets[0].physical_location, before.physical_location);
  assert.equal(api.state.assignmentSessions[0].payload_json.start_resources.raw_materials[0].barcode, 'QA-ROLL-1');
  const lookup = api.request('GET', query('/raw-material-assignments/lookup', 'QA-ROLL-1')).body; assert.equal(lookup.source_receipt_id, before.source_receipt_id); assert.equal(lookup.assignment.stock_status, 'in_use'); assert.equal(api.request('POST', base + '/raw-material-intake', input('QA-ROLL-1')).status, 409);
});
test('delivery resolves real custody/place/deliverer and emits one exact durable audit event on retry', () => {
  const api = setup('delivery'), before = structuredClone(api.state.assets[1]), preview = api.request('GET', query('/raw-material-start-receipt', 'QA-ROLL-2')).body;
  assert.equal(preview.already_at_apparatus, false); assert.deepEqual(preview.deliverers, [{ role: 'material_taminotchi', ref: 'QA-MATERIAL-1', name: 'QA Material mas’uli' }]);
  const result = api.request('POST', base + '/raw-material-start-receipt', delivery); assert.deepEqual(result.body, { ok: true, barcode: 'QA-ROLL-2', apparatus }); assert.equal(api.state.assets[1].custody_warehouse, before.custody_warehouse); assert.equal(api.state.assets[1].qty, before.qty);
  assert.equal(api.state.assets[1].physical_location.id, 'qa-location-print'); assert.equal(api.request('GET', query('/raw-material-start-receipt', 'QA-ROLL-2')).body.already_at_apparatus, true);
  assert.deepEqual(api.request('POST', base + '/raw-material-start-receipt', delivery).body, result.body); assert.equal(api.state.rawHistory.length, 1);
  const event = api.request('GET', base + '/raw-material-history?warehouse=QA%20Xomashyo&event_type=delivery_received&limit=200').body[0];
  assert.equal(event.source_id, delivery.idempotency_key); assert.equal(event.correlation_id, delivery.idempotency_key); assert.equal(event.actor_ref, api.profile.ref); assert.equal(event.payload_json.delivered_by.ref, 'QA-MATERIAL-1'); assert.equal(event.payload_json.received_by.ref, api.profile.ref); assert.equal(event.qty_delta, 0);
  const ready = api.request('GET', query('/raw-material-start-requirements')).body; assert.deepEqual(ready.staged_barcodes, ['QA-ROLL-2']);
});
test('native permissions do not substitute admin for queue.manage or assigned-apparatus intake scope', () => {
  const noScope = setup('intake', { assignedApparatus: [] }); assert.equal(noScope.request('POST', base + '/raw-material-intake', input('QA-ROLL-1')).status, 403);
  const noCap = setup('intake', { capabilities: ['admin.access'] }); assert.equal(noCap.request('POST', base + '/raw-material-intake', input('QA-ROLL-1')).status, 403); assert.equal(noCap.request('GET', query('/raw-material-start-receipt', 'QA-ROLL-1')).status, 403);
  const aparatchi = setup('delivery', { profile: { role: 'aparatchi', ref: 'qa-worker-2' }, assignedApparatus: [] }); assert.equal(aparatchi.request('GET', query('/raw-material-start-receipt', 'QA-ROLL-2')).status, 403);
});
test('frozen, unavailable, wrong identity and invented replay/CAS fields remain native refusals', () => {
  for (const patch of [{ barcode: 'ABSENT' }, { expected_revision: 1 }, { idempotency_key: 'invented' }, { stage_node_id: 'print' }]) { const api = setup(); assert.ok(api.request('POST', base + '/raw-material-intake', { ...input('QA-ROLL-1'), ...patch }).status >= 400); assert.equal(api.state.assets[0].status, 'available'); }
  const frozen = setup(); frozen.state.orders[0].control = 'frozen'; assert.equal(frozen.request('POST', base + '/raw-material-intake', input('QA-ROLL-1')).body.error, 'order_frozen');
  const reserved = setup('delivery'); reserved.state.assets[1].status = 'reserved'; assert.equal(reserved.request('POST', base + '/raw-material-start-receipt', delivery).body.error, 'raw_material_stock_unavailable');
  const wrong = setup('delivery'); assert.equal(wrong.request('POST', base + '/raw-material-start-receipt', { ...delivery, delivered_by_ref: 'title-only' }).body.error, 'material_deliverer_not_allowed');
});
test('delivery replay is actor/deliverer/material scoped and does not undo a later intake', () => {
  const api = setup('delivery'); assert.equal(api.request('POST', base + '/raw-material-start-receipt', delivery).status, 200);
  api.profile.ref = 'qa-admin-2'; assert.equal(api.request('POST', base + '/raw-material-start-receipt', delivery).body.error, 'inventory_idempotency_conflict'); assert.equal(api.state.rawHistory.length, 1);
  api.profile.ref = 'qa-admin'; api.state.orders[0].stages.print = 'in_progress'; api.state.orders[0].operational = 'in_progress'; assert.equal(api.request('POST', base + '/raw-material-intake', input('QA-ROLL-2')).status, 200);
  assert.equal(api.request('POST', base + '/raw-material-start-receipt', delivery).body.error, 'raw_material_stock_unavailable'); assert.equal(api.state.assets[1].status, 'in_use');
});
