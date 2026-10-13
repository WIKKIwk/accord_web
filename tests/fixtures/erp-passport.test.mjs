import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { fixturePassportMeasures, passportFixtureRoute, seedPassportScenario } from './erp-passport.mjs';
const base = '/v1/mobile/admin/production-maps', qr = 'QA-WIP:qa-wip-1', reportBody = { progress_batch_id: 'qa-wip-1', qr_payload: qr };
function setup(scenario = 'own') { const api = extensionHarness(passportFixtureRoute); seedPassportScenario(api.state, { scenario }); return api; }
function correction(batch, changes = {}) { return { batch_id: batch.batch_id, expected_revision: batch.revision, produced_qty: batch.produced_qty, uom: batch.uom, description: 'QA corrected measurement', reason: 'Measured local correction', ...Object.fromEntries(fixturePassportMeasures.map(key => [key, batch[key] ?? null])), ...changes }; }
const label = { ...reportBody, printer: 'godex', print_mode: 'label', print_count: 2, print_transport: 'offline' };

test('passport report binds exact batch/order/QR and all scoped native lineage projections', () => {
  const api = setup(), report = api.request('POST', base + '/progress-qr/report', reportBody).body;
  assert.equal(report.history_scope, 'batch_lineage'); assert.equal(report.lineage_complete, true); assert.equal(report.is_stale, false); assert.equal(report.order.id, 'zakaz-qa-1003');
  assert.deepEqual(report.current_batch, report.current_batches[0]); assert.deepEqual(report.scanned_batch, report.progress_batches[0]); assert.equal(report.scanned_batch.worker_ref, api.profile.ref);
  assert.equal(api.request('POST', base + '/progress-qr/report', { ...reportBody, qr_payload: 'another-QR' }).status, 404);
  const stale = setup('stale').request('POST', base + '/progress-qr/report', reportBody).body; assert.equal(stale.current_batch, null); assert.deepEqual(stale.current_batches, []); assert.equal(stale.is_stale, true);
});
test('correction preserves all protected fields and immutable resources while audit binds full before/after values', () => {
  const api = setup(), before = structuredClone(api.state.wip[0]), body = correction(before), result = api.request('POST', base + '/progress-qr/correct', body);
  assert.equal(result.status, 200); assert.equal(result.body.batch.revision, 2); assert.equal(result.body.batch.payload_json.gross_qty, 27); assert.deepEqual(result.body.batch.payload_json.start_resources, before.payload_json.start_resources);
  for (const key of Object.keys(before).filter(key => !['revision', 'description', 'payload_json'].includes(key))) assert.deepEqual(result.body.batch[key], before[key]);
  const audit = api.request('POST', base + '/progress-qr/report', reportBody).body.corrections[0]; assert.deepEqual(audit.old_values, before); assert.deepEqual(audit.new_values, result.body.batch);
  assert.equal(audit.actor.ref, api.profile.ref); assert.equal(audit.reason, body.reason); assert.equal(audit.previous_revision, 1); assert.equal(audit.new_revision, 2);
  for (const key of fixturePassportMeasures) assert.equal(result.body.batch.payload_json[key], body[key]);
  assert.equal(api.request('POST', base + '/progress-qr/correct', body).body.error, 'progress_batch_correction_conflict');
});
test('changed finished gross updates gross payload; explicit null clears optional values without touching lineage', () => {
  const api = setup(), body = correction(api.state.wip[0], { produced_qty: 1400, finished_goods_meter: 1400, finished_goods_kg: 30, diameter: null });
  const saved = api.request('POST', base + '/progress-qr/correct', body).body.batch; assert.equal(saved.payload_json.gross_qty, 30); assert.equal(saved.finished_goods_kg, 30); assert.equal(saved.payload_json.diameter, null); assert.equal(Object.hasOwn(saved, 'diameter'), false); assert.equal(saved.payload_json.lineage_fact, 'retain');
});
test('native correction denies foreign ownership including admin, used/layer batches and malformed metrics', () => {
  const foreign = setup('foreign'); assert.equal(foreign.request('POST', base + '/progress-qr/correct', correction(foreign.state.wip[0])).status, 403);
  for (const scenario of ['used', 'layer']) { const api = setup(scenario); assert.equal(api.request('POST', base + '/progress-qr/correct', correction(api.state.wip[0])).body.error, 'progress_batch_correction_locked'); }
  for (const patch of [{ reason: '' }, { produced_qty: 0 }, { diameter: -1 }, { bobina_kg: 100 }, { idempotency_key: 'invented' }]) { const api = setup(); assert.ok(api.request('POST', base + '/progress-qr/correct', correction(api.state.wip[0], patch)).status >= 400); assert.equal(api.state.wip[0].revision, 1); }
});
test('offline saved-label preparation returns exact metadata and never changes business state or claims printing', () => {
  const api = setup(), before = structuredClone(api.state.wip[0]), result = api.request('POST', base + '/progress-qr/reprint', label).body;
  assert.equal(result.print.status, 'prepared'); assert.equal(result.print.printer_status, 'client_usb_pending'); assert.equal(result.print.gross_qty, 27); assert.equal(result.print.qty, 1250); assert.equal(result.print.tare_kg, 1); assert.equal(result.print.print_count, 2); assert.equal(result.print.item_code, before.label_item_code); assert.equal(result.print.apparatus, before.apparatus);
  assert.deepEqual(result.batch, before); assert.deepEqual(api.state.wip[0], before); assert.equal(api.state.passportPrintAttempts[0].physicalPrintConfirmed, false);
  const server = api.request('POST', base + '/progress-qr/reprint', { ...label, print_transport: undefined }).body; assert.equal(server.ok, false); assert.equal(server.print.status, 'failed'); assert.equal(api.state.wip[0].revision, 1);
});
test('opening passport returns only the saved scanned roll and has no progress correction identity', () => {
  const api = setup(), record = { intake: { intake_id: 'qa-opening', order_id: 'zakaz-qa-1001', source_apparatus: 'apparatus:qa:print-1', status: 'confirmed', actor: { display_name: 'QA Owner' } }, batches: [1, 2].map(index => ({ batch_id: 'opening-' + index, order_id: 'zakaz-qa-1001', qr_payload: 'OPENING-QR-' + index, wip_status: 'waiting', label_item_code: 'QA-FILM-1', label_item_name: 'QA Film', finished_goods_kg: 25, finished_goods_meter: 1000, bobina_kg: 1 })) };
  api.state.openingWip.push(record); const read = api.request('POST', base + '/opening-wip/qr-report', { qr_payload: 'OPENING-QR-2' }).body;
  assert.equal(read.record.batches.length, 1); assert.equal(read.record.batches[0].batch_id, 'opening-2'); assert.equal(api.request('POST', base + '/progress-qr/correct', { batch_id: 'opening-2' }).status, 404);
  const print = api.request('POST', base + '/opening-wip/print', { ...label, batch_id: 'opening-2', qr_payload: 'OPENING-QR-2' }).body;
  assert.equal(print.print.status, 'prepared'); assert.equal(print.print.gross_qty, 25); assert.equal(print.print.qty, 1000);
  api.state.openingWip[0].batches[1].wip_status = 'void'; assert.equal(api.request('POST', base + '/opening-wip/qr-report', { qr_payload: 'OPENING-QR-2' }).status, 404);
});
test('native passport capabilities gate reads/prints independently and unsupported paths remain explicit', () => {
  const api = setup(); api.capabilities([]); assert.equal(api.request('POST', base + '/progress-qr/report', reportBody).status, 403);
  api.capabilities(['apparatus.queue.read']); assert.equal(api.request('POST', base + '/progress-qr/reprint', label).status, 200);
  assert.equal(api.request('POST', base + '/opening-wip/print', { qr_payload: 'none' }).status, 403);
  assert.equal(api.request('POST', base + '/opening-wip/correct', {}), undefined);
});
