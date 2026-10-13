import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHarness } from './erp-extension-harness.mjs';
import { completionFixtureRoute, completionSnapshotControl, seedCompletionScenario } from './erp-completion.mjs';
const base = '/v1/mobile/admin/production-maps', order_id = 'zakaz-qa-1001';
function setup(scenario = 'print', changes = {}) { const api = extensionHarness(completionFixtureRoute); seedCompletionScenario(api.state, { scenario, ...changes }); return api; }
const paint = (value = '1') => ['rasxot', 'astatka'].flatMap(usage => [1, 2, 3].map(index => ({ usage, category: 'colors', name: 'QA Paint ' + index, values: { kg: value } })));
const normal = (operation = 'print') => ({ order_id, apparatus: 'apparatus:qa:' + operation + '-1', action: 'complete', include_control: true, print_transport: 'offline', finished_goods_meter: 1000, finished_goods_kg: 30, bobina_kg: 1, total_waste: 2, description: 'QA Measured report', ...(operation === 'print' ? { returned_paint_items: paint() } : {}) });
function laminate(api) { const scope = api.state.completionFixture; return { ...normal('laminate'), include_control: undefined, session_id: scope.sessionId, request_id: 'web:qa-layer-completion', full_completion_report_required: true, layer_remainders: scope.sources.map(source => ({ source_kind: source.source_kind, source_id: source.source_id, expected_revision: source.revision, remaining_net_kg: source.source_kind === 'raw_material' ? 2 : 0 })), lamination_print_leftover_rolls: 0, lamination_film_leftover_rolls: 1 }; }
test('print numeric paint completion records one native saved batch and never repeats unkeyed completion', () => {
  const api = setup(), result = api.request('POST', base + '/queue-action', normal()).body;
  assert.equal(result.ok, true); assert.equal(result.states[order_id], 'completed'); assert.equal(result.session.payload_json.return_ink_kg, 3); assert.equal(result.progress_batches.length, 1); assert.deepEqual(result.progress_batch, result.progress_batches[0]);
  assert.equal(result.progress_batch.revision, 1); assert.equal(result.progress_batch.finished_goods_meter, 1000); assert.equal(result.progress_batch.worker_ref, api.profile.ref); assert.equal(result.print.status, 'prepared'); assert.equal(result.print.printer_status, 'client_usb_pending'); assert.equal(result.print.gross_qty, 30); assert.equal(result.print.qty, 1000);
  assert.equal(api.request('POST', base + '/queue-action', normal()).status, 409);
});
test('zero paint values are ordinary report; scalar zero waste is approval-only with no output or completed session', () => {
  const zeroPaint = setup(); assert.equal(zeroPaint.request('POST', base + '/queue-action', { ...normal(), returned_paint_items: paint('0') }).body.session.payload_json.return_ink_kg, 0);
  const api = setup(), before = api.state.wip.length, result = api.request('POST', base + '/queue-action', { ...normal(), total_waste: 0 }).body;
  assert.deepEqual(result.completion_request.zero_metric_codes, ['total_waste']); assert.equal(result.completion_request.decision_required, true); assert.equal(result.session, null); assert.equal(result.progress_event, null); assert.equal(result.progress_batch, null); assert.deepEqual(result.progress_batches, []); assert.equal(api.state.wip.length, before); assert.equal(result.states[order_id], 'paused');
});
test('closing a saved detached print output preserves its identity and creates no second roll', () => {
  const api = setup('print-closing'), before = api.state.wip.length, body = { ...normal(), complete_without_output: true, progress_batch_id: 'qa-closing-output', total_waste: 0 }; delete body.finished_goods_meter; delete body.finished_goods_kg; delete body.bobina_kg;
  const proof = api.request('POST', base + '/progress-qr/report', { progress_batch_id: body.progress_batch_id }).body;
  assert.equal(proof.active_sessions[0].status, 'roll_detached'); assert.equal(proof.scanned_batch.session_id, proof.active_sessions[0].session_id);
  const result = api.request('POST', base + '/queue-action', body).body; assert.equal(result.progress_batch, null); assert.deepEqual(result.progress_batches, []); assert.equal(api.state.wip.length, before); assert.equal(result.session.payload_json.closing_output_batch_id, 'qa-closing-output'); assert.equal(result.session.payload_json.complete_without_output, true);
});
test('atomic laminate completion binds every physical source revision and immutable actor-scoped request receipt', () => {
  const api = setup('laminate'), body = laminate(api); delete body.include_control; delete body.bobina_kg;
  const result = api.request('POST', base + '/laminatsiya-astatka', body).body; assert.equal(result.action, 'complete'); assert.equal(result.request_id, body.request_id); assert.equal(result.session.status, 'completed'); assert.equal(result.progress_batches.length, 1); assert.equal(result.progress_batches[0].bobina_kg, null);
  assert.equal(Object.hasOwn(result, 'states'), false); assert.equal(Object.hasOwn(result, 'progress_event'), false); assert.equal(Object.hasOwn(result, 'progress_batch'), false);
  assert.equal(result.remainders.length, 2); assert.equal(result.remainders[0].qr_payload, ''); assert.ok(result.remainders[1].qr_payload); assert.equal(new Set(result.remainders.map(row => row.operation_id)).size, 2); assert.equal(result.remainders[1].recorded_by.ref, api.profile.ref);
  assert.deepEqual(api.request('POST', base + '/laminatsiya-astatka', body).body, result);
  const query = base + '/laminatsiya-astatka?order_id=' + order_id + '&apparatus=' + encodeURIComponent(body.apparatus) + '&request_id=' + encodeURIComponent(body.request_id), saved = api.request('GET', query).body.request_result;
  assert.equal(saved.request_id, body.request_id); assert.equal(Object.hasOwn(saved, 'epoch'), false); assert.equal(Object.hasOwn(saved, 'rev'), false);
  api.profile.ref = 'qa-admin-2'; assert.equal(api.request('GET', query).body.request_result, null);
});
test('atomic laminate rejects different owner/source revision and unsupported opening input before any output', () => {
  const foreign = setup('laminate', { owner: 'qa-worker-1' }); assert.equal(foreign.request('POST', base + '/laminatsiya-astatka', laminate(foreign)).status, 403);
  const changed = setup('laminate'), body = laminate(changed); body.layer_remainders[0].expected_revision++; assert.equal(changed.request('POST', base + '/laminatsiya-astatka', body).status, 409);
  const opening = setup('laminate-opening'); assert.equal(opening.request('POST', base + '/laminatsiya-astatka', laminate(opening)).status, 409);
  const zero = setup('laminate'); assert.equal(zero.request('POST', base + '/laminatsiya-astatka', { ...laminate(zero), bobina_kg: 0 }).status, 400);
});
test('partial laminate remains pending and does not fabricate physical layer return', () => {
  const api = setup('laminate-partial'), result = api.request('POST', base + '/queue-action', normal('laminate')).body;
  assert.equal(result.states[order_id], 'pending'); assert.equal(result.progress_batches.length, 1); assert.equal(Object.hasOwn(result, 'remainders'), false); assert.equal(Object.keys(api.state.completionCommands).length, 0);
});
test('cut saved-slot inputs retain exact nulls and skip saved/issue slots without fabricated zero output', () => {
  const api = setup('cut-saved'), scope = api.state.completionFixture, before = api.state.wip.length;
  const get = api.request('GET', base + '/rezka-output-report?order_id=' + order_id + '&apparatus=' + encodeURIComponent(scope.apparatusId)).body; assert.deepEqual(get.kadr_counts, [1, 1]); assert.equal(get.rezka_output_report.frames[0].input.total_waste, null);
  const body = { ...normal('cut'), rezka_output_cycle: scope.cycleId, rezka_frames: [structuredClone(scope.saved[0].input), { issue_note: 'QA Damaged slot' }] }; delete body.finished_goods_meter; delete body.finished_goods_kg; delete body.bobina_kg;
  const result = api.request('POST', base + '/queue-action', body).body;
  assert.deepEqual(result.progress_batches, []); assert.equal(api.state.wip.length, before); assert.equal(result.session.payload_json.rezka_output_cycle, result.progress_event.event_id); assert.deepEqual(result.session.payload_json.rezka_output_report, []); assert.equal(result.session.payload_json.rezka_frame_issues[0].frame_index, 2); assert.deepEqual(result.progress_event.payload_json.rezka_previously_recorded_batches, ['qa-cut-saved-1']);
});
test('cut new outputs use true one-based indices even for equal quantities, preserve parent and process input lineage', () => {
  const api = setup('cut'), scope = api.state.completionFixture, frame = { finished_goods_meter: 100, gross_qty: 10, bobina_kg: 1, diameter: 30 };
  const result = api.request('POST', base + '/queue-action', { ...normal('cut'), rezka_output_cycle: scope.cycleId, rezka_frames: [frame, frame] }).body;
  assert.deepEqual(result.progress_batches.map(batch => batch.payload_json.rezka_frame_index), [1, 2]); assert.equal(new Set(result.progress_batches.map(batch => batch.qr_payload)).size, 2); assert.ok(result.progress_batches.every(batch => batch.parent_batch_id === 'qa-completion-input' && batch.payload_json.rezka_frame_count === 2));
  assert.equal(result.session.payload_json.input_lineage[0].status, 'processed'); assert.equal(api.state.wip.find(batch => batch.batch_id === 'qa-completion-input').wip_status, 'processed');
});
test('completion snapshot controls expose native flags/session and frozen/revoked permission refuses writes', () => {
  const api = setup(), order = api.state.orders[0], node = order.map.nodes.find(row => row.id === 'print'), control = completionSnapshotControl(api.state, order, node, {});
  assert.deepEqual(control.allowed_actions, ['pause', 'complete']); assert.equal(control.complete_requires_full_report, true); assert.equal(control.complete_requires_rezka_total_waste_only, false); assert.equal(control.work_activity.worker_ref, api.profile.ref);
  order.control = 'frozen'; assert.deepEqual(completionSnapshotControl(api.state, order, node, {}).allowed_actions, []); assert.equal(api.request('POST', base + '/queue-action', normal()).body.error, 'order_frozen');
  api.capabilities([]); assert.equal(api.request('POST', base + '/queue-action', normal()).status, 403);
});
