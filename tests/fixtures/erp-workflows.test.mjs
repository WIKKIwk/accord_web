import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { apparatusIds, fixtureLogin, fixtureToken } from './erp-seed.mjs';

const base = '/v1/mobile/admin', pm = `${base}/production-maps`, orderId = 'zakaz-qa-1001';
const auth = { authorization: `Bearer ${fixtureToken}` };
async function setup() {
  const fixture = createFixture();
  await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin });
  return { fixture, request: (method, url, body, headers = auth) => fixture.dispatch({ method, url, body, headers }) };
}
const opening = key => ({ idempotency_key: key, order_id: orderId, source_apparatus: apparatusIds.print, source_stage_node_id: 'print', batches: [{ quantity_basis: 'measured', finished_goods_meter: 1000, finished_goods_kg: 40, bobina_kg: 1 }, { quantity_basis: 'estimated', finished_goods_meter: 900, finished_goods_kg: 35, bobina_kg: 1.1 }] });
const capacity = { capacity_slots: 1, setup_minutes: 5, cleanup_minutes: 5, efficiency_percent: 100, finite_capacity: true, availability: { mode: 'always' } };
const start = Date.parse('2030-01-07T08:00:00Z') / 1000;
const schedule = key => ({ order_id: orderId, apparatus_id: apparatusIds.laminate, apparatus: 'QA Laminator', earliest_start_unix: start, latest_end_unix: start + 7200, duration_minutes: 20, priority: 0, source: 'web_apparatus_planning', reason: 'QA Synthetic schedule', idempotency_key: key, capability_requirements: [{ code: 'laminate', min_level: 1 }], candidate_apparatuses: [] });

test('calculation, reusable template update/delete and pending source use native envelopes', async () => {
  const { request } = await setup();
  const pending = (await request('GET', `${base}/pending-orders?id=zakaz-2001`)).body;
  assert.equal(pending.template.order_number, '2001'); assert.equal(pending.completion, null);
  const result = (await request('POST', '/v1/mobile/calculate', pending.template)).body;
  assert.equal(result.ok, true); assert.equal(result.width_mm, 515); assert.equal(result.results[0].total_gsm, 16.8);
  assert.equal((await request('POST', '/v1/mobile/calculate', { ...pending.template, layers: [{ material: 'QA absent', micron: '1' }] })).status, 400);
  const templates = (await request('GET', '/v1/mobile/calculate/orders')).body;
  assert.equal(templates.ok, true); assert.equal(templates.templates[0].source_map_id, orderId);
  const updated = (await request('POST', '/v1/mobile/calculate/orders', { ...templates.templates[0], name: 'QA Route Edited' })).body;
  assert.equal(updated.ok, true); assert.equal(updated.template.id, 'qa-route-template');
  assert.equal((await request('POST', '/v1/mobile/calculate/orders/delete', { id: updated.template.id })).body.ok, true);
  assert.deepEqual((await request('GET', '/v1/mobile/calculate/orders')).body.templates, []);
});

test('pending completion preserves the reserved identity and returns the same saved order on retry', async () => {
  const { fixture, request } = await setup();
  const pending = (await request('GET', `${base}/pending-orders?id=zakaz-2001`)).body;
  const map = (await request('GET', `${pm}?id=${orderId}`)).body.map;
  const body = { pending_order_id: pending.id, map: { ...map, id: pending.id, code: '', order_number: '' }, template: pending.template };
  assert.equal((await request('PUT', `${pm}/with-order`, { ...body, template: { ...body.template, order_number: '9999' } })).status, 409);
  const completed = await request('PUT', `${pm}/with-order`, body);
  assert.equal(completed.body.ok, true); assert.equal(completed.body.saved.map.id, 'zakaz-2001'); assert.equal(completed.body.saved.map.order_number, '2001');
  assert.deepEqual((await request('PUT', `${pm}/with-order`, body)).body, completed.body);
  assert.equal(fixture.getState().state.orders.length, 4);
  assert.deepEqual((await request('GET', `${base}/pending-orders?id=zakaz-2001`)).body.completion.saved, completed.body.saved);
  assert.deepEqual((await request('GET', `${base}/pending-orders`)).body, []);
});

test('opened calculation updates require the original full source and retain graph identity', async () => {
  const { request } = await setup();
  const original = (await request('GET', `${pm}/order-edit?id=${orderId}`)).body;
  const changed = await request('PUT', `${pm}/order-edit?id=${orderId}`, { original, template: { ...original.template, kg: 180, note: 'QA parameter edit' } });
  assert.equal(changed.body.revision, original.revision + 1); assert.equal(changed.body.map.order_kg, 180);
  assert.equal(changed.body.map.id, orderId); assert.equal(changed.body.template.id, original.template.id);
  assert.deepEqual(changed.body.map.nodes, original.map.nodes); assert.deepEqual(changed.body.map.edges, original.map.edges);
  assert.equal((await request('PUT', `${pm}/order-edit?id=${orderId}`, { original, template: original.template })).status, 409);
  assert.equal((await request('GET', `${pm}/order-edit?id=zakaz-qa-1002`)).status, 409);
});

test('opening intake validates rolls and source, replays an exact key, and rejects differing payloads', async () => {
  const { fixture, request } = await setup(), command = opening('qa-opening-1');
  assert.equal((await request('POST', `${pm}/opening-wip`, { ...command, batches: [{ ...command.batches[0], quantity_basis: 'unknown' }] })).status, 400);
  assert.equal((await request('POST', `${pm}/opening-wip`, { ...command, batches: [{ ...command.batches[0], finished_goods_kg: 0 }] })).status, 400);
  assert.equal((await request('POST', `${pm}/opening-wip`, { ...command, source_apparatus: apparatusIds.cut, source_stage_node_id: 'cut' })).status, 409);
  const result = (await request('POST', `${pm}/opening-wip`, command)).body.record;
  assert.equal(result.intake.source_apparatus, apparatusIds.print); assert.equal(result.intake.resume_stage_node_id, 'print');
  assert.equal(result.intake.actor.ref_, 'qa-admin'); assert.equal(result.batches.length, 2);
  assert.deepEqual((await request('POST', `${pm}/opening-wip`, command)).body.record, result);
  assert.equal((await request('POST', `${pm}/opening-wip`, { ...command, note: 'different' })).status, 409);
  assert.equal(fixture.getState().state.openingWip.length, 1);
  assert.equal((await request('GET', `${pm}/opening-wip?order_id=${orderId}&status=all&limit=500`)).body.records.length, 1);
  assert.deepEqual((await request('GET', `${pm}/opening-wip?order_id=zakaz-qa-1002`)).body.records, []);
});

test('opening cancellation guards used rolls and preserves siblings until all rolls are void', async () => {
  const { request } = await setup();
  const record = (await request('POST', `${pm}/opening-wip`, opening('qa-opening-2'))).body.record;
  const [first, second] = record.batches;
  assert.equal((await request('POST', `${pm}/opening-wip/lookup`, { order_id: orderId, apparatus: apparatusIds.laminate, batch_id: first.batch_id, qr_payload: first.qr_payload })).body.batch.batch_id, first.batch_id);
  const cancelled = await request('DELETE', `${pm}/opening-wip?batch_id=${encodeURIComponent(first.batch_id)}`);
  assert.equal(cancelled.body.batch.wip_status, 'void'); assert.equal(cancelled.body.intake.status, 'confirmed');
  await request('POST', '/__qa/opening-wip', { batch_id: second.batch_id, batchPatch: { wip_status: 'in_use', used_by_session_id: 'qa-session' } }, {});
  assert.equal((await request('DELETE', `${pm}/opening-wip?batch_id=${encodeURIComponent(second.batch_id)}`)).status, 409);
  await request('POST', '/__qa/opening-wip', { batch_id: second.batch_id, batchPatch: { wip_status: 'waiting', used_by_session_id: '' } }, {});
  assert.equal((await request('DELETE', `${pm}/opening-wip?batch_id=${encodeURIComponent(second.batch_id)}`)).body.intake.status, 'cancelled');
});

test('progress lookup returns current route rather than historical next apparatus and never mutates WIP', async () => {
  const { fixture, request } = await setup();
  await request('POST', '/__qa/wip', { batch_id: 'qa-wip-1', batchPatch: { next_apparatus: apparatusIds.cut } }, {});
  const before = fixture.getState().state;
  const unscoped = (await request('POST', `${pm}/progress-qr/lookup`, { progress_batch_id: 'qa-wip-1', require_active_order: true })).body;
  assert.equal(unscoped.active_order_validated, true); assert.equal(unscoped.validated_apparatus, '');
  assert.deepEqual(unscoped.input_route.consumer_apparatus_ids, [apparatusIds.laminate]); assert.equal(unscoped.input_route.remapped, true);
  const scoped = (await request('POST', `${pm}/progress-qr/lookup`, { progress_batch_id: 'qa-wip-1', order_id: 'zakaz-qa-1003', apparatus: apparatusIds.laminate, require_active_order: true })).body;
  assert.equal(scoped.validated_apparatus, apparatusIds.laminate); assert.equal(scoped.validated_order_id, 'zakaz-qa-1003');
  assert.deepEqual(fixture.getState().state, before);
  await request('POST', '/__qa/order', { id: 'zakaz-qa-1003', control: 'frozen' }, {});
  assert.equal((await request('POST', `${pm}/progress-qr/lookup`, { progress_batch_id: 'qa-wip-1', require_active_order: true })).status, 409);
});

test('capacity and queue policy projections share canonical revision/hash and commit native receipts without duplicate replay', async () => {
  const { request } = await setup(), apparatus = apparatusIds.laminate;
  const before = (await request('GET', `${base}/apparatus/${encodeURIComponent(apparatus)}`)).body;
  const getCapacity = () => request('GET', `${pm}/capacity`), getPolicies = () => request('GET', `${pm}/queue-policies`);
  assert.equal((await getCapacity()).body.capacity.find(row => row.apparatus_id === apparatus).source_aasx_sha256, before.source_aasx_sha256);
  assert.equal((await getPolicies()).body.policies.find(row => row.apparatus_id === apparatus).source_revision, 1);
  const command = { apparatus_id: apparatus, expected_revision: 1, capacity: { ...capacity, efficiency_percent: 120 } }, headers = { ...auth, 'idempotency-key': 'web-planning:capacity:qa' };
  const saved = (await request('PUT', `${pm}/capacity`, command, headers)).body;
  assert.equal(saved.revision.revision.revision_metadata.revision, 2); assert.equal(saved.revision.revision.revision_metadata.command_id, 'apparatus-command:web-planning:capacity:qa');
  assert.equal(saved.revision.revision.revision_metadata.actor_id, 'principal:qa-admin'); assert.match(saved.revision.aasx_sha256, /^[a-f0-9]{64}$/);
  assert.equal((await request('PUT', `${pm}/capacity`, command, headers)).status, 409);
  assert.equal((await request('PUT', `${pm}/queue-policies`, { apparatus_id: apparatus, expected_revision: 2, discipline: 'free_pick' }, { ...auth, 'idempotency-key': 'web-planning:policy:qa' })).body.revision.runtime_projection.source_revision, 3);
  assert.equal((await getCapacity()).body.capacity.find(row => row.apparatus_id === apparatus).source_revision, 3);
  assert.equal((await getPolicies()).body.policies.find(row => row.apparatus_id === apparatus).discipline, 'free_pick');
});

test('schedule respects downtime and finite capacity, retains idempotent identity and cancels only a returned planned reservation', async () => {
  const { fixture, request } = await setup();
  const down = { id: 'qa-downtime-1', apparatus_id: apparatusIds.laminate, apparatus: 'QA Laminator', starts_at_unix: start, ends_at_unix: start + 1800, reason: 'QA Maintenance', active: true, actor: { role: '', ref: '', display_name: '' }, created_at_unix: start };
  assert.equal((await request('POST', `${pm}/capacity/downtime`, down)).body.downtime.actor.ref, 'qa-admin');
  assert.equal((await request('GET', `${pm}/capacity/downtime`)).status, 405, 'Fixture must not invent a downtime-history GET');
  const first = (await request('POST', `${pm}/schedule`, schedule('web-planning:schedule:qa-1'))).body;
  assert.equal(first.reservation.starts_at_unix, start + 1800); assert.equal(first.reservation.reserved_duration_minutes, 30);
  assert.deepEqual((await request('POST', `${pm}/schedule`, schedule('web-planning:schedule:qa-1'))).body, first);
  const second = (await request('POST', `${pm}/schedule`, schedule('web-planning:schedule:qa-2'))).body.reservation;
  assert.equal(second.starts_at_unix, first.reservation.ends_at_unix);
  assert.equal((await request('POST', `${pm}/schedule`, { ...schedule('web-planning:schedule:qa-3'), latest_end_unix: start + 100 })).status, 409);
  const cancel = await request('POST', `${pm}/schedule/cancel`, { reservation_id: first.reservation.reservation_id, reason: 'QA cancelled' });
  assert.equal(cancel.body.reservation.status, 'cancelled');
  assert.equal((await request('POST', `${pm}/schedule`, schedule('web-planning:schedule:qa-1'))).body.reservation.status, 'cancelled');
  assert.equal((await request('POST', `${pm}/schedule/cancel`, { reservation_id: first.reservation.reservation_id, reason: 'again' })).status, 409);
  assert.equal(fixture.getState().state.reservations.length, 2); assert.deepEqual(fixture.getState().state.sequenceOverrides, {});
});

test('workflow failures retain actual 403/409 and applied-but-lost state for read recovery', async () => {
  const { fixture, request } = await setup();
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${pm}/opening-wip`, dropResponse: true, once: true }] }, {});
  assert.equal((await request('POST', `${pm}/opening-wip`, opening('qa-opening-lost'))).dropResponse, true);
  assert.equal((await request('GET', `${pm}/opening-wip?order_id=${orderId}`)).body.records.length, 1);
  assert.equal(fixture.getLog().filter(row => row.method === 'POST' && row.path === `${pm}/opening-wip`).length, 1);
  await request('POST', '/__qa/config', { capabilities: ['apparatus.queue.read'], rules: [] }, {});
  assert.equal((await request('GET', `${pm}/capacity`)).status, 200);
  assert.equal((await request('POST', `${pm}/schedule`, schedule('qa-restricted'))).status, 403);
  assert.equal((await request('POST', '/v1/mobile/calculate/orders', {})).status, 403);
  assert.equal((await request('DELETE', `${pm}/opening-wip?batch_id=anything`)).status, 403);
});

test('manufacturing history provides canonical transitions and partial lineage without fabricating a full order report', async () => {
  const { fixture, request } = await setup();
  const closed = (await request('GET', `${pm}/closed-orders`)).body;
  assert.equal(closed.ok, true); assert.equal(closed.closed_orders[0].order_id, 'zakaz-4001');
  assert.equal(closed.closed_orders[0].logs[3].action, 'complete'); assert.equal(closed.closed_orders[0].logs[3].to_state, 'pending');
  const map = (await request('GET', `${pm}?id=zakaz-4001`)).body.map;
  assert.equal(map.id, closed.closed_orders[0].order_id); assert.equal(map.nodes.find(row => row.id === 'print').apparatus_id, apparatusIds.print);
  const before = fixture.getState().state;
  const report = (await request('POST', `${pm}/progress-qr/report`, { progress_batch_id: 'qa-wip-1' })).body;
  assert.equal(report.history_scope, 'batch_lineage'); assert.equal(report.lineage_complete, false); assert.equal(report.scanned_batch.order_id, 'zakaz-qa-1003');
  assert.deepEqual(fixture.getState().state, before);
  await request('POST', '/__qa/config', { emptyClosedHistory: true, manufacturingReportMode: 'wrong_identity' }, {});
  assert.deepEqual((await request('GET', `${pm}/closed-orders`)).body.closed_orders, []);
  assert.equal((await request('POST', `${pm}/progress-qr/report`, { progress_batch_id: 'qa-wip-1' })).body.scanned_batch.order_id, 'zakaz-qa-other');
  assert.equal((await request('POST', `${pm}/progress-qr/report`, { progress_batch_id: 'absent' })).status, 404);
});

test('worker detail exposes bounded native activity and exact worker history scope', async () => {
  const { request } = await setup();
  const first = (await request('GET', `${base}/workers/profile-detail?id=qa-worker-1`)).body;
  assert.equal(first.worker.id, 'qa-worker-1'); assert.equal(first.active_sessions[0].worker_ref, 'qa-worker-1');
  assert.equal(first.recent_logs[0].actor_ref, 'qa-worker-1'); assert.deepEqual(first.assigned_apparatus, [apparatusIds.print]);
  assert.equal(first.recent_batches[0].action, 'complete'); assert.equal(first.recent_batches[0].worker_ref, 'qa-worker-1');
  assert.equal(first.recent_batches[0].executor_name, 'QA Brigadir'); assert.ok(Number.isSafeInteger(first.recent_batches[0].completed_at_unix));
  const second = (await request('GET', `${base}/workers/profile-detail?id=qa-worker-2`)).body;
  assert.deepEqual(second.active_sessions, []); assert.deepEqual(second.recent_logs, []);
  assert.equal((await request('GET', `${pm}/progress-qr/history?worker_ref=qa-worker-1&limit=200`)).body.ok, true);
  assert.deepEqual((await request('GET', `${pm}/progress-qr/history?worker_ref=qa-worker-2&limit=200`)).body.batches, []);
  await request('POST', '/__qa/config', { capabilities: ['production.map.manage'] }, {});
  assert.equal((await request('GET', `${base}/workers/profile-detail?id=qa-worker-1`)).status, 403);
});
