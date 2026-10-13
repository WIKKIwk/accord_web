import { fixturePassportReport } from './erp-passport.mjs';
const base = '/v1/mobile/admin/production-maps', clone = value => structuredClone(value), text = value => typeof value === 'string' ? value.trim() : '';
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } }), object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0, nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const effective = node => node.alternative_assigned_apparatus_id || node.apparatus_id, actor = profile => ({ role: profile.role, ref: profile.ref, display_name: profile.display_name });
function nativeBatch(state, order, node, session, id, metrics, profile, parent = '') {
  return { batch_id: id, revision: 1, order_id: order.map.id, apparatus: effective(node), session_id: session.session_id, action: 'complete', status: 'completed', wip_status: 'waiting', produced_qty: metrics.finished_goods_meter ?? metrics.produced_qty, uom: 'm',
    finished_goods_meter: metrics.finished_goods_meter ?? metrics.produced_qty, finished_goods_kg: metrics.finished_goods_kg ?? metrics.gross_qty, bobina_kg: metrics.bobina_kg ?? null, ...(metrics.diameter ? { diameter: metrics.diameter } : {}),
    worker_role: profile.role, worker_ref: profile.ref, worker_display_name: profile.display_name, executor_name: profile.display_name, started_at_unix: session.started_at_unix, completed_at_unix: 1791892800 + state.rev,
    qr_payload: 'QA-COMPLETION:' + id, label_item_code: order.map.product_code, label_item_name: order.map.title, parent_batch_id: parent, next_apparatus: '', current_apparatus: effective(node), current_location: 'QA Recorded stage',
    payload_json: { stage_node_id: node.id, gross_qty: metrics.finished_goods_kg ?? metrics.gross_qty } };
}
export function seedCompletionScenario(state, { scenario = 'print', owner = 'qa-admin', partial = false } = {}) {
  if (!['print', 'print-closing', 'laminate', 'laminate-partial', 'laminate-opening', 'cut', 'cut-saved'].includes(scenario)) return error(400, 'invalid_completion_fixture');
  const operation = scenario.startsWith('print') ? 'print' : scenario.startsWith('laminate') ? 'laminate' : 'cut', order = state.orders[0], node = order.map.nodes.find(row => row.id === operation), paused = scenario === 'print-closing';
  order.control = 'active'; delete order.earlyClose; order.operational = paused ? 'paused' : 'in_progress';
  for (const stage of ['print', 'laminate', 'cut']) { order.stages[stage] = stage === node.id ? paused ? 'paused' : 'in_progress' : ['print', 'laminate', 'cut'].indexOf(stage) < ['print', 'laminate', 'cut'].indexOf(node.id) ? 'completed' : 'pending'; }
  const session = { session_id: 'qa-completion-session:' + scenario, order_id: order.map.id, apparatus: effective(node), stage_node_id: node.id, status: paused ? 'roll_detached' : 'active', worker_role: 'admin', worker_ref: owner, worker_display_name: 'QA Completion Owner',
    started_at_unix: 1791892500, updated_at_unix: 1791892800, payload_json: { stage_node_id: node.id, ...(operation === 'print' ? {} : { input_progress_batch_id: 'qa-completion-input', input_wip_source_kind: scenario === 'laminate-opening' ? 'opening_wip' : 'progress_batch' }) } };
  state.assignmentSessions.push(session);
  const profile = { role: 'admin', ref: owner, display_name: 'QA Completion Owner' }, sources = [], counts = [1, 1], saved = [];
  if (operation !== 'print') {
    const sourceNode = order.map.nodes.find(row => row.id === (operation === 'laminate' ? 'print' : 'laminate'));
    const input = nativeBatch(state, order, sourceNode, { ...session, session_id: 'qa-completion-source-session' }, 'qa-completion-input', { finished_goods_meter: 1000, finished_goods_kg: 10, bobina_kg: 1 }, profile);
    Object.assign(input, { revision: 2, wip_status: 'in_use', used_by_session_id: session.session_id, used_by_apparatus: effective(node), current_apparatus: effective(node) }); state.wip.push(input);
    if (operation === 'laminate') sources.push({ source_kind: 'progress_batch', source_id: input.batch_id, session_id: session.session_id, revision: 2, source_net_kg: 10, item_name: 'QA Printed film' }, { source_kind: 'raw_material', source_id: 'QA-ROLL-1', session_id: session.session_id, revision: 8, source_net_kg: 20, item_name: 'QA Raw film' });
    else session.payload_json.input_lineage = [{ input_batch_id: input.batch_id, source_kind: 'progress_batch', stage_node_id: node.id, status: 'in_use', sequence_no: 1 }];
  }
  let closingBatchId = '';
  if (paused) { const output = nativeBatch(state, order, node, session, 'qa-closing-output', { finished_goods_meter: 800, finished_goods_kg: 20, bobina_kg: 1 }, profile); output.payload_json.detached = true; state.wip.push(output); closingBatchId = output.batch_id; }
  if (scenario === 'cut-saved') {
    const input = { finished_goods_meter: 80, gross_qty: 9, bobina_kg: 1, diameter: 25, total_waste: null }, output = nativeBatch(state, order, node, session, 'qa-cut-saved-1', input, profile, 'qa-completion-input');
    Object.assign(output.payload_json, { rezka_frame_index: 1, rezka_frame_count: counts.length }); state.wip.push(output); saved.push({ frame_index: 1, batch_id: output.batch_id, qr_payload: output.qr_payload, input });
  }
  state.completionFixture = { scenario, orderId: order.map.id, apparatusId: effective(node), stageNodeId: node.id, operation, sessionId: session.session_id, sources, cycleId: 'qa-cut-cycle:' + scenario, counts, saved, closingBatchId, fullReport: scenario !== 'laminate-partial', partial: partial || scenario === 'laminate-partial' };
  state.completionCommands ??= {}; state.completionRequests ??= []; state.rev++;
  return response({ ok: true, ...clone(state.completionFixture) });
}
export function completionSnapshotControl(state, order, node, baseline) {
  const scope = state.completionFixture; if (!scope || scope.orderId !== order.map.id || scope.stageNodeId !== node.id) return baseline;
  const status = order.stages[node.id], session = state.assignmentSessions.find(row => row.session_id === scope.sessionId), active = ['in_progress', 'paused'].includes(status) && order.control === 'active' && !order.earlyClose;
  return { ...clone(baseline), state: order.control === 'frozen' ? 'frozen' : status, stage_node_id: node.id, allowed_actions: active ? ['pause', 'complete'] : [], complete_requires_full_report: scope.fullReport, complete_requires_rezka_total_waste_only: false,
    ...(scope.closingBatchId ? { closing_output_batch_id: scope.closingBatchId } : {}), ...(scope.operation === 'cut' ? { rezka_output_kadr_counts: clone(scope.counts), rezka_input_lineage: clone(session.payload_json.input_lineage) } : {}),
    work_activity: { state: status, worker_role: session.worker_role, worker_ref: session.worker_ref, worker_display_name: session.worker_display_name, session_id: session.session_id },
    interaction: { mode: status, start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: false, material_intake_allowed: false, resume_input_required: false, previous_wip_mode: 'not_required', opening_wip_mode: 'not_required', qolip_mode: 'not_required' } };
}
function paintReport(items) {
  if (!Array.isArray(items) || !items.length || items.length > 128) return null;
  const counts = { rasxot: 0, astatka: 0 }; let returned = 0n; const seen = new Set();
  for (const item of items) {
    const identity = item.usage + ':' + item.category + ':' + text(item.name).toLowerCase();
    if (!['rasxot', 'astatka'].includes(item.usage) || !['colors', 'lacquers', 'solvents'].includes(item.category) || !text(item.name) || !object(item.values) || seen.has(identity)) return null; seen.add(identity);
    for (const [label, raw] of Object.entries(item.values)) {
      if (!text(label) || typeof raw !== 'string' || !/^\d+(?:\.\d{1,11})?$/.test(raw) || !Number.isFinite(Number(raw))) return null;
      counts[item.usage]++; if (item.usage === 'astatka') { const [whole, fraction = ''] = raw.split('.'); returned += BigInt(whole) * 100000000000n + BigInt(fraction.padEnd(11, '0')); }
    }
  }
  return counts.rasxot >= 3 && counts.astatka >= 3 ? Number(returned) / 100000000000 : null;
}
function validOutput(frame, zeroTare = false) { const metres = frame.finished_goods_meter ?? frame.produced_qty, gross = frame.finished_goods_kg ?? frame.gross_qty; return positive(metres) && positive(gross) && (zeroTare && frame.bobina_kg === undefined || positive(frame.bobina_kg) && frame.bobina_kg < gross); }
export function completionFixtureRoute({ method, path, query, body, state, requires, profile, bump, equal, config }) {
  const scope = state.completionFixture; if (!scope) return undefined;
  if (path === base + '/completion-requests' && method === 'GET') {
    if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage')) return error(403, 'forbidden');
    return response({ completion_requests: clone(state.completionRequests) });
  }
  if (path === base + '/progress-qr/report' && method === 'POST') {
    const batch = state.wip.find(row => row.batch_id === body?.progress_batch_id && row.order_id === scope.orderId);
    if (!batch) return undefined;
    if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage')) return error(403, 'forbidden');
    if (body.qr_payload && batch.qr_payload !== body.qr_payload) return error(404, 'progress_batch_not_found');
    return response(fixturePassportReport(state, batch));
  }
  const isQueue = path === base + '/queue-action' && method === 'POST' && body?.action === 'complete', isLaminate = path === base + '/laminatsiya-astatka', isCut = path === base + '/rezka-output-report';
  if (!isQueue && !isLaminate && !isCut) return undefined;
  if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.manage')) return error(403, 'forbidden');
  const input = method === 'GET' ? query : body ?? {}, order = state.orders.find(row => row.map.id === input.order_id), node = order?.map.nodes.find(row => row.id === scope.stageNodeId), session = state.assignmentSessions.find(row => row.session_id === scope.sessionId);
  if (!order || scope.orderId !== input.order_id || scope.apparatusId !== input.apparatus) return error(404, 'map_not_found');
  if (!requires('admin.access') && !config.assignedApparatus?.includes(input.apparatus)) return error(403, 'apparatus_not_assigned');
  if (isLaminate && method === 'GET') {
    const prior = state.completionCommands[input.request_id], visible = prior && prior.actorRef === profile.ref && prior.orderId === input.order_id && prior.apparatusId === input.apparatus ? clone(prior.receipt) : null;
    if (visible) { delete visible.epoch; delete visible.rev; delete visible.prints; }
    return response({ ok: true, session: clone(session), sources: clone(scope.sources), request_result: visible });
  }
  if (isCut && method === 'GET') return response({ ok: true, apparatus: input.apparatus, order_id: input.order_id, session_status: session.status, order_control: order.control, epoch: state.epoch, rev: state.rev, kadr_counts: clone(scope.counts), rezka_output_report: { cycle_id: scope.cycleId, frames: clone(scope.saved) } });
  if (method !== 'POST') return error(405, 'method_not_allowed');
  const keyed = isLaminate && scope.operation === 'laminate' && scope.fullReport, prior = keyed ? state.completionCommands[body.request_id] : null;
  if (prior) return prior.actorRef === profile.ref && equal(prior.body, body) ? response(clone(prior.receipt)) : error(409, 'laminatsiya_astatka_request_conflict');
  if (order.control !== 'active' || order.earlyClose || !['in_progress', 'paused'].includes(order.stages[node.id]) || !['active', 'paused', 'roll_detached'].includes(session.status)) return error(409, order.control === 'frozen' ? 'order_frozen' : 'queue_action_not_allowed');
  if (body.action !== 'complete' || Object.hasOwn(body, 'idempotency_key') || Object.hasOwn(body, 'expected_revision')) return error(400, 'progress_input_invalid');
  if (keyed) {
    if (session.worker_ref !== profile.ref) return error(403, 'laminatsiya_astatka_forbidden');
    if (session.payload_json.input_wip_source_kind === 'opening_wip') return error(409, 'laminatsiya_astatka_source_invalid');
    if (!text(body.request_id) || body.session_id !== session.session_id || body.full_completion_report_required !== true || !Array.isArray(body.layer_remainders) || body.layer_remainders.length !== scope.sources.length || !nonnegative(body.total_waste) || !validOutput(body, true)) return error(400, 'laminatsiya_astatka_metrics_required');
    const keys = new Set();
    for (const layer of body.layer_remainders) {
      const identity = layer.source_kind + ':' + layer.source_id, source = scope.sources.find(row => row.source_kind === layer.source_kind && row.source_id === layer.source_id);
      if (!source || keys.has(identity) || layer.expected_revision !== source.revision || !nonnegative(layer.remaining_net_kg) || layer.remaining_net_kg > source.source_net_kg) return error(409, 'laminatsiya_astatka_source_conflict'); keys.add(identity);
    }
    if (body.lamination_print_leftover_rolls !== body.layer_remainders.filter(row => row.source_kind === 'progress_batch' && row.remaining_net_kg > 0).length || body.lamination_film_leftover_rolls !== body.layer_remainders.filter(row => row.source_kind === 'raw_material' && row.remaining_net_kg > 0).length) return error(400, 'laminatsiya_astatka_metrics_required');
  }
  let returnedInk = null, frames = scope.closingBatchId ? [] : [body];
  if (scope.operation === 'print') {
    returnedInk = paintReport(body.returned_paint_items); if (returnedInk === null || !nonnegative(body.total_waste)) return error(400, 'returned_paint_report_required');
    if (scope.closingBatchId) { if (body.complete_without_output !== true || body.progress_batch_id !== scope.closingBatchId || Object.hasOwn(body, 'finished_goods_meter')) return error(400, 'progress_input_invalid'); }
    else {
      if (!validOutput(body)) return error(400, 'progress_input_invalid');
      if (body.total_waste === 0) {
        if (!text(body.description)) return error(400, 'zero_metric_description_required');
        const request = { event_id: 'qa-completion-approval:' + state.rev, order_id: order.map.id, apparatus: effective(node), worker_role: profile.role, worker_ref: profile.ref, description: body.description, notice_kind: 'zero_metric_completion_request', zero_metric_codes: ['total_waste'], decision_required: true };
        state.completionRequests.push(request); order.stages[node.id] = 'paused'; order.operational = 'paused'; session.status = 'paused'; bump();
        return response({ ok: true, epoch: state.epoch, rev: state.rev, states: { [order.map.id]: 'paused' }, completion_request: clone(request), session: null, progress_event: null, progress_batch: null, progress_batches: [], print: null });
      }
    }
  } else if (scope.operation === 'laminate' && !validOutput(body, keyed)) return error(400, 'progress_input_invalid');
  if (scope.operation === 'cut') {
    if (body.rezka_output_cycle !== scope.cycleId || !Array.isArray(body.rezka_frames) || body.rezka_frames.length !== scope.counts.length) return error(409, 'rezka_output_cycle_conflict');
    frames = body.rezka_frames;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index], saved = scope.saved.find(row => row.frame_index === index + 1);
      if (saved ? !equal(saved.input, frame) : text(frame.issue_note) ? Object.keys(frame).some(key => key !== 'issue_note' && frame[key] !== null) : !validOutput(frame) || !positive(frame.diameter)) return error(400, 'progress_input_invalid');
    }
    if (frames.some(frame => !text(frame.issue_note)) && !positive(body.total_waste) || Object.hasOwn(body, 'total_waste') && !positive(body.total_waste)) return error(400, 'progress_input_invalid');
  }
  const eventId = 'qa-completion-event:' + state.rev, parent = session.payload_json.input_progress_batch_id ?? '';
  const batches = frames.flatMap((frame, index) => text(frame.issue_note) || scope.operation === 'cut' && scope.saved.some(row => row.frame_index === index + 1) ? [] : [nativeBatch(state, order, node, session, 'qa-completion-output:' + state.nextId++ + ':' + index, frame, profile, parent)]);
  // Use the actual unsaved frame index even when two slots have equal quantities.
  if (scope.operation === 'cut') { let outputIndex = 0; frames.forEach((frame, index) => { if (!text(frame.issue_note) && !scope.saved.some(slot => slot.frame_index === index + 1)) Object.assign(batches[outputIndex++].payload_json, { rezka_frame_index: index + 1, rezka_frame_count: scope.counts.length }); }); }
  Object.assign(session, { status: 'completed', worker_role: profile.role, worker_ref: profile.ref, worker_display_name: profile.display_name, updated_at_unix: 1791892800 + state.rev });
  Object.assign(session.payload_json, { description: text(body.description), ...(body.total_waste !== undefined ? { total_waste: body.total_waste } : {}), ...(returnedInk !== null ? { return_ink_kg: returnedInk } : {}),
    ...(scope.closingBatchId ? { complete_without_output: true, closing_output_batch_id: scope.closingBatchId } : {}), ...(keyed ? { lamination_print_leftover_rolls: body.lamination_print_leftover_rolls, lamination_film_leftover_rolls: body.lamination_film_leftover_rolls } : {}) });
  if (scope.operation === 'cut') Object.assign(session.payload_json, { input_lineage: session.payload_json.input_lineage.map(row => ({ ...row, status: 'processed' })), rezka_output_cycle: eventId, rezka_output_report: [], rezka_frame_issues: frames.flatMap((frame, index) => text(frame.issue_note) ? [{ frame_index: index + 1, issue_note: text(frame.issue_note) }] : []) });
  if (parent) { const inputBatch = state.wip.find(row => row.batch_id === parent); if (inputBatch) Object.assign(inputBatch, { wip_status: 'processed', processed_by_session_id: session.session_id, processed_by_apparatus: effective(node) }); }
  state.wip.push(...batches); order.stages[node.id] = scope.partial ? 'pending' : 'completed'; order.operational = scope.partial ? 'waiting_next_stage' : 'partially_completed'; bump();
  const remainders = keyed ? body.layer_remainders.map(layer => ({ operation_id: 'qa-layer-operation:' + state.nextId++, order_id: order.map.id, apparatus: effective(node), session_id: session.session_id, source_kind: layer.source_kind, source_id: layer.source_id, remaining_net_kg: layer.remaining_net_kg, recorded_by: actor(profile), qr_payload: layer.remaining_net_kg > 0 ? 'QA-REMAINDER:' + state.nextId++ : '' })) : [];
  const prints = batches.map(batch => ({ ok: true, status: 'prepared', qr_payload: batch.qr_payload, printer_status: 'client_usb_pending', item_code: batch.label_item_code, item_name: batch.label_item_name,
    apparatus: batch.apparatus, apparatus_display_name: state.apparatus.find(row => row.apparatus_id === batch.apparatus)?.display.display_name ?? batch.apparatus, customer_name: order.map.customer_name,
    executor_name: batch.executor_name, qty: batch.finished_goods_meter, gross_qty: batch.finished_goods_kg, tare_enabled: Number(batch.bobina_kg) > 0, tare_kg: batch.bobina_kg ?? 0,
    unit: 'kg', progress_unit: batch.uom, label_kind: 'progress', printer: text(body.printer) || 'godex', print_mode: text(body.print_mode) || 'label', print_count: Number.isSafeInteger(body.print_count) && body.print_count > 0 ? body.print_count : 1 }));
  const receipt = keyed ? { ok: true, epoch: state.epoch, rev: state.rev, action: 'complete', request_id: body.request_id, session: clone(session), progress_batches: clone(batches), remainders, prints }
    : { ok: true, epoch: state.epoch, rev: state.rev, states: { [order.map.id]: order.stages[node.id] }, session: clone(session), progress_event: { event_id: eventId, session_id: session.session_id, order_id: order.map.id, apparatus: effective(node), action: 'complete', worker_role: profile.role, worker_ref: profile.ref, total_waste: body.total_waste, payload_json: { rezka_previously_recorded_batches: scope.saved.flatMap(slot => slot.batch_id ? [slot.batch_id] : []) } }, progress_batch: clone(batches[0] ?? null), progress_batches: clone(batches), print: prints[0] ?? null, prints };
  if (keyed) state.completionCommands[body.request_id] = { actorRef: profile.ref, orderId: order.map.id, apparatusId: effective(node), body: clone(body), receipt: clone(receipt) };
  return response(receipt);
}
