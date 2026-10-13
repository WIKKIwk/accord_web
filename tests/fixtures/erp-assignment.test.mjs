import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken, apparatusIds } from './erp-seed.mjs';

const pm = '/v1/mobile/admin/production-maps', auth = { authorization: `Bearer ${fixtureToken}` }, orderId = 'zakaz-qa-1001';
async function setup(scenario) { const fixture = createFixture(); await fixture.dispatch({ method: 'POST', url: '/v1/mobile/auth/login', body: fixtureLogin }); const request = (method, url, body) => fixture.dispatch({ method, url, body, headers: auth }); if (scenario) await request('POST', '/__qa/assignment', { scenario }); return { fixture, request }; }
const start = (order_id = orderId, apparatus = apparatusIds.print) => ({ apparatus, order_id, action: 'start', include_control: true });
const move = { map_id: orderId, from_apparatus: apparatusIds.print, to_apparatus: apparatusIds.spare };
const hold = { apparatus: apparatusIds.print, order_id: orderId, action: 'hold', hold_id: 'qa-preflight-hold', idempotency_key: 'qa-preflight-command', include_control: true };
const report = id => ({ progress_batch_id: id });

test('baseline pending stages stay blocked; controlled native readiness permits a single unkeyed start', async () => {
  const { request } = await setup();
  assert.deepEqual((await request('GET', `${pm}/sequence`)).body.queue_action_controls[apparatusIds.print][orderId].allowed_actions, []);
  assert.equal((await request('POST', `${pm}/queue-action`, start())).status, 409);
  await request('POST', '/__qa/assignment', { scenario: 'start' });
  const before = (await request('GET', `${pm}/sequence`)).body; assert.equal(before.scope, ''); assert.equal(before.order_statuses[orderId].lifecycle_status, 'released'); assert.equal(before.order_statuses[orderId].order_status, 'ready');
  const result = (await request('POST', `${pm}/queue-action`, start())).body;
  assert.equal(result.ok, true); assert.equal(result.epoch, before.epoch); assert.ok(result.rev > before.rev); assert.equal(result.states[orderId], 'in_progress');
  assert.equal(result.session.order_id, orderId); assert.equal(result.session.apparatus, apparatusIds.print); assert.equal(result.session.stage_node_id, 'print'); assert.equal(result.session.status, 'active');
  const after = (await request('GET', `${pm}/sequence`)).body; assert.equal(after.queue_action_controls[apparatusIds.print][orderId].work_activity.worker_ref, 'qa-admin');
  assert.equal((await request('POST', `${pm}/queue-action`, start())).status, 409, 'Unkeyed start must not replay');
});

test('material and tooling validation are semantic reads; required scans are enforced on final start', async () => {
  const { fixture, request } = await setup('scans'), before = fixture.getState().state.rawAssignments;
  const ready = (await request('GET', `/v1/mobile/admin/raw-material-start-requirements?order_id=${orderId}&apparatus=${apparatusIds.print}&material_barcodes=QA-ROLL-1`)).body;
  assert.equal(ready.assignments_satisfied, true); assert.equal(ready.scan_satisfied, true); assert.equal(ready.matched_scan_count, 1); assert.deepEqual(ready.eligible_barcodes, ['QA-ROLL-1']);
  const tooling = (await request('POST', `${pm}/qolip-validate`, { apparatus: apparatusIds.print, order_id: orderId, qolip_code: 'QA-QOLIP-1' })).body;
  assert.equal(tooling.qolip.required_qolip_count, 1); assert.deepEqual(fixture.getState().state.rawAssignments, before);
  assert.equal((await request('POST', `${pm}/queue-action`, start())).status, 409);
  assert.equal((await request('POST', `${pm}/queue-action`, { ...start(), material_barcodes: ['QA-ROLL-1'], qolip_codes: ['QA-QOLIP-1'] })).status, 200);
  assert.equal(fixture.getState().state.rawAssignments[0].execution_status, 'in_use');
});

test('previous WIP start pins actual input identity and report session for later observation', async () => {
  const { request } = await setup('wip-start'), id = 'zakaz-qa-1003';
  const lookup = await request('POST', `${pm}/progress-qr/lookup`, { apparatus: apparatusIds.laminate, order_id: id, progress_batch_id: 'qa-wip-1', require_active_order: true }); assert.equal(lookup.body.validated_apparatus, apparatusIds.laminate);
  const started = (await request('POST', `${pm}/queue-action`, { ...start(id, apparatusIds.laminate), progress_batch_id: 'qa-wip-1' })).body;
  assert.deepEqual(started.session.payload_json, { stage_node_id: 'laminate', input_progress_batch_id: 'qa-wip-1', input_wip_source_kind: 'progress_batch' });
  const lineage = (await request('POST', `${pm}/progress-qr/report`, report('qa-wip-1'))).body;
  assert.equal(lineage.scanned_batch.wip_status, 'in_use'); assert.equal(lineage.scanned_batch.used_by_session_id, started.session.session_id); assert.equal(lineage.active_sessions[0].worker_ref, 'qa-admin');
  assert.equal(lineage.history_scope, 'batch_lineage');
});

test('opening WIP start preserves the distinct input source contract and never detaches the roll', async () => {
  const { request } = await setup();
  const intake = (await request('POST', `${pm}/opening-wip`, { idempotency_key: 'qa-opening-start-input', order_id: orderId, source_apparatus: apparatusIds.print, source_stage_node_id: 'print', batches: [{ quantity_basis: 'measured', finished_goods_meter: 1000, finished_goods_kg: 40, bobina_kg: 1 }] })).body.record;
  await request('POST', '/__qa/assignment', { scenario: 'opening-start' }); const batch = intake.batches[0];
  assert.equal((await request('POST', `${pm}/opening-wip/lookup`, { apparatus: apparatusIds.laminate, order_id: orderId, batch_id: batch.batch_id, qr_payload: batch.qr_payload })).status, 200);
  const started = (await request('POST', `${pm}/queue-action`, { ...start(orderId, apparatusIds.laminate), progress_batch_id: batch.batch_id, qr_payload: batch.qr_payload })).body;
  assert.equal(started.session.payload_json.input_wip_source_kind, 'opening_wip'); assert.equal(started.session.payload_json.input_progress_batch_id, batch.batch_id);
  assert.equal((await request('GET', `${pm}/opening-wip?status=all`)).body.records[0].batches[0].wip_status, 'in_use');
});

test('lamination handoff returns exact report metrics while the original input roll remains mounted', async () => {
  const { fixture, request } = await setup('handoff'), input = { ...start(orderId, apparatusIds.laminate), action: 'pause', worker_handoff: true, print_transport: 'offline', lamination_print_leftover_rolls: 0, lamination_film_leftover_rolls: 2, total_waste: 0, description: 'QA Shift handoff' };
  const before = (await request('POST', `${pm}/progress-qr/report`, report('qa-input-roll'))).body; assert.equal(before.active_sessions[0].payload_json.input_progress_batch_id, 'qa-input-roll');
  const paused = (await request('POST', `${pm}/queue-action`, input)).body; assert.equal(paused.session.session_id, 'qa-assignment-handoff'); assert.equal(paused.session.status, 'paused');
  for (const field of ['lamination_print_leftover_rolls', 'lamination_film_leftover_rolls', 'total_waste']) assert.equal(paused.session.payload_json[field], input[field]);
  assert.equal(paused.session.payload_json.description, input.description); assert.equal(paused.session.payload_json.total_waste_uom, 'kg'); assert.equal(paused.session.payload_json.worker_handoff, true); assert.equal(paused.session.payload_json.roll_removed_from_apparatus, false);
  assert.equal(fixture.getState().state.wip.find(row => row.batch_id === 'qa-input-roll').wip_status, 'in_use'); assert.equal(paused.session.payload_json.input_wip_source_kind, 'progress_batch');
  assert.equal((await request('POST', `${pm}/queue-action`, input)).status, 409);
});

test('native pending assignment preserves every graph edge/node identity and has no durable replay key', async () => {
  const { request } = await setup('start'), before = (await request('GET', `${pm}/sequence`)).body.maps[0].map;
  const saved = (await request('POST', `${pm}/move`, move)).body.saved.map;
  assert.deepEqual(saved.edges, before.edges); assert.deepEqual(saved.nodes.map(row => row.id), before.nodes.map(row => row.id)); assert.equal(saved.nodes.find(row => row.id === 'print').apparatus_id, apparatusIds.spare);
  for (const node of before.nodes.filter(row => row.id !== 'print')) assert.deepEqual(saved.nodes.find(row => row.id === node.id), node);
  assert.equal((await request('POST', `${pm}/move`, move)).status, 409);
});

test('paused transfer preserves session/output identity and replays only its exact native key', async () => {
  const { fixture, request } = await setup('paused-transfer'), input = { order_id: orderId, from_apparatus: apparatusIds.print, to_apparatus: apparatusIds.spare, reason: 'QA Motor stopped', idempotency_key: 'qa-paused-transfer' };
  const before = (await request('POST', `${pm}/progress-qr/report`, report('qa-paused-roll'))).body; assert.equal(before.scanned_batch.session_id, before.active_sessions[0].session_id);
  const saved = (await request('POST', `${pm}/apparatus-transfer`, input)).body; assert.equal(saved.transfer_id, 'apparatus-transfer:qa-paused-transfer'); assert.equal(saved.queue_state, 'paused'); assert.equal(saved.progress_batch_id, 'qa-paused-roll'); assert.equal(saved.session_id, 'qa-assignment-paused-transfer');
  assert.equal(fixture.getState().state.assignmentSessions[0].apparatus, apparatusIds.spare); assert.equal(fixture.getState().state.wip.find(row => row.batch_id === 'qa-paused-roll').apparatus, apparatusIds.spare);
  assert.equal(fixture.getState().state.rawAssignments[0].apparatus_id, apparatusIds.spare);
  assert.deepEqual((await request('POST', `${pm}/apparatus-transfer`, input)).body, saved); assert.equal((await request('POST', `${pm}/apparatus-transfer`, { ...input, reason: 'changed' })).status, 409);
});

test('preflight uses an exact durable hold identity and returns the actual later terminal status', async () => {
  const { fixture, request } = await setup('preflight');
  const running = (await request('POST', `${pm}/print-preflight`, hold)).body.hold; assert.equal(running.status, 'running'); assert.equal(running.hold_id, hold.hold_id); assert.equal(running.idempotency_key, hold.idempotency_key);
  const current = (await request('GET', `${pm}/sequence`)).body; assert.equal(current.queue_states[apparatusIds.print][orderId], 'print_preflight'); assert.equal(current.queue_action_controls[apparatusIds.print][orderId].interaction.mode, 'fresh_start_blocked');
  const passed = (await request('POST', `${pm}/print-preflight`, { ...hold, action: 'passed' })).body.hold; assert.equal(passed.status, 'passed');
  assert.equal((await request('POST', `${pm}/print-preflight`, hold)).body.hold.status, 'passed'); assert.equal(fixture.getState().state.assignmentHolds.length, 1);
  assert.equal((await request('POST', `${pm}/queue-action`, start())).status, 409);
  assert.equal((await request('POST', `${pm}/queue-action`, { ...start(), print_preflight_hold_id: hold.hold_id })).status, 200); assert.equal(fixture.getState().state.assignmentHolds[0].status, 'consumed');
});

test('unknown state, frozen order and revoked permission remain explicit native refusals', async () => {
  const { request } = await setup('unknown'); assert.equal((await request('POST', `${pm}/queue-action`, start())).status, 409); assert.equal((await request('POST', `${pm}/move`, move)).status, 409);
  await request('POST', '/__qa/assignment', { scenario: 'start' }); await request('POST', '/__qa/order', { id: orderId, control: 'frozen' }); assert.equal((await request('POST', `${pm}/queue-action`, start())).status, 409);
  await request('POST', '/__qa/config', { capabilities: ['catalog.item.read'] }); assert.equal((await request('POST', `${pm}/queue-action`, start())).status, 403); assert.equal((await request('POST', `${pm}/move`, move)).status, 403);
});

test('applied loss and malformed success expose saved state without implicit unkeyed replay', async () => {
  const { fixture, request } = await setup('start');
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${pm}/move`, responseBody: {}, once: true }] });
  assert.deepEqual((await request('POST', `${pm}/move`, move)).body, {}); assert.equal((await request('GET', `${pm}/sequence`)).body.maps[0].map.nodes.find(row => row.id === 'print').apparatus_id, apparatusIds.spare);
  assert.equal(fixture.getLog().filter(row => row.method === 'POST' && row.path.endsWith('/move')).length, 1);
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: `${pm}/queue-action`, dropResponse: true, once: true }] });
  assert.equal((await request('POST', `${pm}/queue-action`, start(orderId, apparatusIds.spare))).dropResponse, true);
  assert.equal((await request('GET', `${pm}/sequence`)).body.queue_action_controls[apparatusIds.spare][orderId].work_activity.worker_ref, 'qa-admin');
  assert.equal(fixture.getLog().filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')).length, 1);
});
