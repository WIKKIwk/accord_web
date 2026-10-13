// Controlled synthetic production scenarios. Native reads never claim input stock.
const pm = '/v1/mobile/admin/production-maps';
const clone = value => structuredClone(value), str = value => typeof value === 'string' ? value.trim() : '';
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const active = order => order && order.control === 'active' && !order.earlyClose;
const effective = node => node.alternative_assigned_apparatus_id || node.apparatus_id;
const scenarios = ['start', 'scans', 'wip-start', 'opening-start', 'handoff', 'paused-transfer', 'preflight', 'unknown'];
const actor = profile => ({ worker_role: profile.role, worker_ref: profile.ref, worker_display_name: profile.display_name });
const time = state => 1791892800 + state.rev;
const interaction = (mode, patch = {}) => ({ mode, start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: false, material_intake_allowed: false, resume_input_required: false, previous_wip_mode: 'not_required', opening_wip_mode: 'not_required', qolip_mode: 'not_required', ...patch });
function mountedSession(state, orderId, apparatus) { return state.assignmentSessions.find(row => row.order_id === orderId && row.apparatus === apparatus && ['active', 'paused'].includes(row.status)); }
function nativeBatch(state, order, apparatus, stage, id, patch = {}) {
  return { batch_id: id, order_id: order.map.id, apparatus, source_stage_node_id: stage, session_id: '', action: 'complete', status: 'completed', wip_status: 'waiting', produced_qty: 1000, uom: 'm', worker_role: 'aparatchi', worker_ref: 'qa-worker-1', worker_display_name: 'QA Brigadir', executor_name: 'QA Brigadir', started_at_unix: time(state) - 300, completed_at_unix: time(state) - 100,
    current_apparatus: apparatus, next_apparatus: '', current_location: 'QA Bosma sexi', qr_payload: `QA-ASSIGNMENT:${id}`, label_item_code: order.map.product_code, label_item_name: order.map.title, used_by_apparatus: '', used_by_session_id: '', processed_by_apparatus: '', processed_by_session_id: '', ...patch };
}
export function seedAssignmentScenario(state, { scenario, order_id, apparatus } = {}) {
  if (!scenarios.includes(scenario)) return error(400, 'invalid_assignment_scenario');
  const order = state.orders.find(row => row.map.id === (order_id || (scenario === 'wip-start' ? 'zakaz-qa-1003' : 'zakaz-qa-1001')));
  const node = order?.map.nodes.find(row => row.kind === 'apparatus' && (apparatus ? effective(row) === apparatus : row.id === (['wip-start', 'opening-start', 'handoff'].includes(scenario) ? 'laminate' : 'print')));
  if (!node) return error(404, 'map_not_found');
  if (scenario === 'opening-start' && !state.openingWip.some(row => row.intake.order_id === order.map.id && row.batches.some(batch => batch.wip_status === 'waiting'))) return error(409, 'opening_wip_fixture_required');
  const id = effective(node), policy = { state: 'pending', stage_node_id: node.id, allowed_actions: ['start'], previous_stage_ready: true, complete_requires_full_report: false, interaction: interaction('fresh_start') };
  order.control = 'active'; order.operational = 'ready'; order.stages[node.id] = 'pending'; delete order.earlyClose;
  if (['wip-start', 'opening-start', 'handoff'].includes(scenario)) { order.stages.print = 'completed'; policy.previous_stage = order.map.nodes.find(row => row.id === 'print').apparatus_id; }
  if (scenario === 'scans') {
    policy.interaction = interaction('fresh_start', { start_materials_mode: 'scan_required', material_scan_required: true, qolip_mode: 'scan_required' });
    state.rawAssignments.push({ id: 'qa-start-material', barcode: 'QA-ROLL-1', order_id: order.map.id, apparatus_id: id, execution_status: 'waiting', consumed_qty: 0 });
  }
  if (scenario === 'wip-start') {
    policy.interaction.previous_wip_mode = 'scan_required';
    const batch = state.wip.find(row => row.batch_id === 'qa-wip-1'); batch.wip_status = 'waiting'; batch.used_by_apparatus = ''; batch.used_by_session_id = '';
  }
  if (scenario === 'opening-start') policy.interaction.opening_wip_mode = 'scan_required';
  if (scenario === 'handoff' || scenario === 'paused-transfer') {
    const paused = scenario === 'paused-transfer', session = { session_id: `qa-assignment-${scenario}`, order_id: order.map.id, apparatus: id, stage_node_id: node.id, status: paused ? 'paused' : 'active', worker_role: 'aparatchi', worker_ref: 'qa-worker-1', worker_display_name: 'QA Brigadir', started_at_unix: time(state) - 100, updated_at_unix: time(state), payload_json: { stage_node_id: node.id, input_progress_batch_id: 'qa-input-roll', input_wip_source_kind: 'progress_batch' } };
    state.assignmentSessions.push(session); order.stages[node.id] = paused ? 'paused' : 'in_progress'; order.operational = paused ? 'paused' : 'in_progress';
    if (paused) state.rawAssignments.push({ id: 'qa-transfer-material', barcode: 'QA-ROLL-1', order_id: order.map.id, apparatus_id: id, execution_status: 'waiting', consumed_qty: 0 });
    policy.state = order.stages[node.id]; policy.allowed_actions = paused ? ['resume'] : ['pause']; policy.interaction = interaction(policy.state);
    state.wip.push(nativeBatch(state, order, paused ? id : policy.previous_stage, paused ? node.id : 'print', paused ? 'qa-paused-roll' : 'qa-input-roll', paused ? { session_id: session.session_id, action: 'pause', status: 'paused', current_apparatus: id } : { wip_status: 'in_use', current_apparatus: id, used_by_apparatus: id, used_by_session_id: session.session_id }));
  }
  if (scenario === 'preflight') { policy.allowed_actions = []; policy.print_preflight_allowed = true; policy.interaction = interaction('fresh_start_blocked', { blocking_reason_code: 'print_preflight_in_progress' }); }
  if (scenario === 'unknown') { policy.state = 'qa_unknown'; policy.allowed_actions = []; policy.interaction.mode = 'qa_unknown'; order.stages[node.id] = 'qa_unknown'; order.operational = 'qa_unknown'; }
  state.assignmentPolicies[order.map.id] ??= {}; state.assignmentPolicies[order.map.id][node.id] = policy; state.rev++;
  return response({ ok: true, scenario, order_id: order.map.id, apparatus: id, stage_node_id: node.id });
}
export function assignmentSnapshotControl(state, order, node, baseline) {
  const policy = state.assignmentPolicies[order.map.id]?.[node.id]; if (!policy) return baseline;
  const id = effective(node), status = order.stages[node.id], control = clone(policy), session = mountedSession(state, order.map.id, id);
  control.state = status; control.stage_node_id = node.id;
  if (status === 'in_progress' || status === 'paused') {
    control.allowed_actions = status === 'in_progress' ? ['pause'] : ['resume']; control.interaction = interaction(status);
    if (session) control.work_activity = { state: status, worker_role: session.worker_role, worker_ref: session.worker_ref, worker_display_name: session.worker_display_name, session_id: session.session_id };
  }
  const hold = state.assignmentHolds.find(row => row.order_id === order.map.id && row.apparatus === id && row.stage_node_id === node.id);
  if (hold) {
    control.print_preflight = clone(hold);
    if (['held', 'running'].includes(hold.status)) { control.state = 'print_preflight'; control.allowed_actions = []; control.interaction = interaction('fresh_start_blocked', { blocking_reason_code: 'print_preflight_in_progress' }); }
    else if (status === 'pending' && hold.status === 'passed') { control.allowed_actions = ['start']; control.interaction = interaction('fresh_start'); }
    else if (status === 'pending') { control.allowed_actions = []; control.interaction = interaction('fresh_start_blocked', { blocking_reason_code: 'print_preflight_in_progress' }); }
  }
  if (order.control !== 'active') { control.state = order.control === 'frozen' ? 'frozen' : control.state; control.allowed_actions = []; control.interaction = interaction(order.control === 'frozen' ? 'frozen' : 'fresh_start_blocked', { blocking_reason_code: 'order_control_blocked' }); }
  return control;
}
export function advanceFixturePreflight(state, { hold_id, status } = {}) {
  const hold = state.assignmentHolds.find(row => row.hold_id === hold_id);
  if (!hold || !['running', 'held'].includes(hold.status) || !['passed', 'failed', 'cancelled'].includes(status)) return error(409, 'print_preflight_transition_invalid');
  hold.status = status; hold.updated_at_unix = time(state); const order = state.orders.find(row => row.map.id === hold.order_id); order.operational = 'ready'; state.rev++;
  return response({ ok: true, hold: clone(hold) });
}
export function assignmentFixtureRoute({ method, path, query, body, state, requires, profile, bump, findOrder, compile, snapshot, equal }) {
  const read = () => requires('admin.access', 'production.map.manage', 'apparatus.queue.manage'), manage = () => requires('admin.access', 'production.map.manage');
  if (path === '/v1/mobile/admin/raw-material-start-requirements' && method === 'GET') {
    if (!read()) return error(403, 'forbidden');
    const assigned = state.rawAssignments.filter(row => row.order_id === query.order_id && row.apparatus_id === query.apparatus).map(row => row.barcode), scanned = str(query.material_barcodes).split(',').filter(Boolean), matched = assigned.filter(value => scanned.includes(value));
    return response({ requires_material: true, material_scan_required: true, assignments_satisfied: assigned.length > 0, scan_satisfied: assigned.length > 0 && matched.length === assigned.length, required_scan_count: assigned.length || 1, matched_scan_count: matched.length, eligible_barcodes: assigned });
  }
  if (path === `${pm}/qolip-validate` && method === 'POST') {
    if (!read()) return error(403, 'forbidden');
    const order = findOrder(body?.order_id);
    if (!active(order) || !order.map.nodes.some(node => node.kind === 'apparatus' && effective(node) === body.apparatus) || str(body.qolip_code).toUpperCase() !== 'QA-QOLIP-1') return error(409, 'qolip_not_assigned');
    return response({ ok: true, qolip: { qolip_code: 'QA-QOLIP-1', required_qolip_codes: ['QA-QOLIP-1'], required_qolip_count: 1 } });
  }
  if (path === `${pm}/queue-action` && method === 'POST' && (body?.action === 'start' || body?.worker_handoff === true)) {
    if (!read()) return error(403, 'forbidden');
    const order = findOrder(body?.order_id), node = order?.map.nodes.find(node => node.kind === 'apparatus' && effective(node) === body.apparatus);
    if (!active(order) || !node) return error(409, 'queue_action_not_allowed');
    const control = snapshot(state).queue_action_controls[body.apparatus]?.[order.map.id];
    if (!control?.allowed_actions.includes(body.action)) return error(409, 'queue_action_not_allowed');
    let session = mountedSession(state, order.map.id, body.apparatus);
    if (body.action === 'start') {
      const requirements = control.interaction;
      if (requirements.material_scan_required && (!Array.isArray(body.material_barcodes) || state.rawAssignments.some(row => row.order_id === order.map.id && row.apparatus_id === body.apparatus && !body.material_barcodes.includes(row.barcode)))) return error(409, 'raw_material_scan_required');
      if (requirements.qolip_mode === 'scan_required' && (!Array.isArray(body.qolip_codes) || !body.qolip_codes.includes('QA-QOLIP-1'))) return error(409, 'qolip_scan_required');
      let batch = state.wip.find(row => row.batch_id === body.progress_batch_id || body.qr_payload && row.qr_payload === body.qr_payload), inputKind = 'progress_batch';
      if (requirements.opening_wip_mode === 'scan_required') { batch = state.openingWip.flatMap(row => row.batches).find(row => row.batch_id === body.progress_batch_id || body.qr_payload && row.qr_payload === body.qr_payload); inputKind = 'opening_wip'; }
      if ((requirements.previous_wip_mode === 'scan_required' || requirements.opening_wip_mode === 'scan_required') && (!batch || batch.order_id !== order.map.id || batch.wip_status !== 'waiting')) return error(409, 'wip_route_invalid');
      const hold = state.assignmentHolds.find(row => row.order_id === order.map.id && row.apparatus === body.apparatus && row.status === 'passed');
      if (hold && body.print_preflight_hold_id !== hold.hold_id) return error(409, 'print_preflight_hold_required');
      session = { session_id: `qa-assignment-run-${state.nextId++}`, order_id: order.map.id, apparatus: body.apparatus, stage_node_id: node.id, status: 'active', ...actor(profile), started_at_unix: time(state), updated_at_unix: time(state), payload_json: { stage_node_id: node.id, ...(batch ? { input_progress_batch_id: batch.batch_id, input_wip_source_kind: inputKind } : {}) } };
      state.assignmentSessions.push(session);
      if (batch) { batch.wip_status = 'in_use'; batch.used_by_apparatus = body.apparatus; batch.used_by_session_id = session.session_id; batch.current_apparatus = body.apparatus; }
      for (const row of state.rawAssignments.filter(row => row.order_id === order.map.id && row.apparatus_id === body.apparatus)) row.execution_status = 'in_use';
      if (hold) hold.status = 'consumed'; order.stages[node.id] = 'in_progress'; order.operational = 'in_progress';
    } else {
      const inputId = session?.payload_json.input_progress_batch_id, batch = state.wip.find(row => row.batch_id === inputId), metrics = ['lamination_print_leftover_rolls', 'lamination_film_leftover_rolls', 'total_waste'];
      if (!session || session.status !== 'active' || !batch || batch.wip_status !== 'in_use' || state.apparatus.find(row => row.apparatus_id === body.apparatus)?.execution_profile.operation !== 'laminate' || metrics.some(field => typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0) || body.print_transport !== 'offline') return error(409, 'worker_handoff_invalid');
      session.status = 'paused'; session.updated_at_unix = time(state); Object.assign(session.payload_json, { worker_handoff: true, roll_removed_from_apparatus: false, input_wip_source_kind: 'progress_batch', total_waste_uom: 'kg', description: str(body.description), ...Object.fromEntries(metrics.map(field => [field, body[field]])) });
      order.stages[node.id] = 'paused'; order.operational = 'paused';
    }
    bump(); return response({ ok: true, epoch: state.epoch, rev: state.rev, states: { [order.map.id]: order.stages[node.id] }, session: clone(session) });
  }
  if (path === `${pm}/move` && method === 'POST' || path === `${pm}/apparatus-transfer` && method === 'POST') {
    if (!manage()) return error(403, 'forbidden');
    const transfer = path.endsWith('/apparatus-transfer'), key = str(body?.idempotency_key), orderId = transfer ? body?.order_id : body?.map_id;
    const previous = key && state.assignmentCommands[key];
    if (previous) return equal(previous.body, body) ? response(clone(previous.receipt)) : error(409, 'apparatus_transfer_idempotency_conflict');
    const order = findOrder(orderId), source = state.apparatus.find(row => row.apparatus_id === body?.from_apparatus), target = state.apparatus.find(row => row.apparatus_id === body?.to_apparatus), nodes = order?.map.nodes.filter(node => node.kind === 'apparatus' && effective(node) === source?.apparatus_id) || [];
    if (!active(order) || nodes.length !== 1 || !source || !target || target.lifecycle.state !== 'active' || source.execution_profile.operation !== target.execution_profile.operation || source.execution_profile.operation !== 'print' && source.execution_profile.technology !== target.execution_profile.technology || source.execution_profile.capability_compatible_reroute !== true || target.execution_profile.capability_compatible_reroute !== true || !(target.capabilities[source.execution_profile.operation] >= source.capabilities[source.execution_profile.operation]) || order.stages[nodes[0].id] !== (transfer ? 'paused' : 'pending')) return error(409, 'apparatus_assignment_not_allowed');
    const session = mountedSession(state, order.map.id, source.apparatus_id), batch = state.wip.find(row => row.order_id === order.map.id && row.session_id === session?.session_id && row.apparatus === source.apparatus_id && row.action === 'pause' && row.status === 'paused' && row.wip_status === 'waiting');
    if (transfer && (!key || !str(body.reason) || !session || !batch || order.map.nodes.some(node => node.kind === 'apparatus' && effective(node) === target.apparatus_id))) return error(409, 'apparatus_transfer_not_allowed');
    nodes[0].apparatus_id = target.apparatus_id; nodes[0].title = target.display.display_name;
    if (transfer) { session.apparatus = target.apparatus_id; batch.apparatus = target.apparatus_id; batch.current_apparatus = target.apparatus_id; for (const row of state.rawAssignments.filter(row => row.order_id === order.map.id && row.apparatus_id === source.apparatus_id)) row.apparatus_id = target.apparatus_id; }
    bump(); const receipt = { ok: true, saved: compile(order.map), ...(transfer ? { transfer_id: `apparatus-transfer:${key}`, queue_state: 'paused', session_id: session.session_id, progress_batch_id: batch.batch_id } : {}) };
    if (key) state.assignmentCommands[key] = { body: clone(body), receipt: clone(receipt) }; return response(receipt);
  }
  if (path === `${pm}/print-preflight` && method === 'POST') {
    if (!read()) return error(403, 'forbidden');
    const order = findOrder(body?.order_id), node = order?.map.nodes.find(row => row.kind === 'apparatus' && effective(row) === body.apparatus), apparatus = state.apparatus.find(row => row.apparatus_id === body.apparatus);
    if (!active(order) || !node || apparatus?.execution_profile.operation !== 'print') return error(409, 'print_preflight_not_allowed');
    let hold = state.assignmentHolds.find(row => row.hold_id === body.hold_id);
    if (body.action === 'hold') {
      if (hold) return hold.order_id === order.map.id && hold.apparatus === body.apparatus && hold.idempotency_key === body.idempotency_key ? response({ ok: true, hold: clone(hold) }) : error(409, 'print_preflight_identity_conflict');
      if (!str(body.hold_id) || !str(body.idempotency_key) || !snapshot(state).queue_action_controls[body.apparatus]?.[order.map.id]?.print_preflight_allowed) return error(409, 'print_preflight_not_allowed');
      hold = { hold_id: body.hold_id, idempotency_key: body.idempotency_key, order_id: order.map.id, apparatus: body.apparatus, stage_node_id: node.id, status: 'running', actor: { role: profile.role, ref: profile.ref, display_name: profile.display_name }, created_at_unix: time(state), updated_at_unix: time(state), previous_queue_state: 'pending', expires_at_unix: 0 }; state.assignmentHolds.push(hold); order.operational = 'print_preflight';
    } else {
      const target = { passed: 'passed', failed: 'failed', cancel: 'cancelled' }[body.action];
      if (!hold || hold.order_id !== order.map.id || hold.apparatus !== body.apparatus || !target || !['running', 'held', target].includes(hold.status)) return error(409, 'print_preflight_transition_invalid');
      if (hold.status === target) return response({ ok: true, hold: clone(hold) }); hold.status = target; hold.updated_at_unix = time(state); order.operational = 'ready';
    }
    bump(); return response({ ok: true, hold: clone(hold) });
  }
  return undefined;
}
