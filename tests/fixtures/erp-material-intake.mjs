import { apparatusIds } from './erp-seed.mjs';
const base = '/v1/mobile/admin', clone = value => structuredClone(value), text = value => typeof value === 'string' ? value.trim() : '';
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const barcodeKey = value => text(value).toUpperCase(), object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const actor = profile => ({ role: profile.role, ref: profile.ref, name: profile.display_name });
const effective = node => node.alternative_assigned_apparatus_id || node.apparatus_id;
function destination(state, apparatusId) { return state.locations.filter(row => row.active && row.kind === 'state' && row.apparatus?.some(app => app.id === apparatusId)).sort((a, b) => a.id.localeCompare(b.id)); }
function atApparatus(state, asset, apparatusId) { return destination(state, apparatusId).some(row => row.id === asset.physical_location.id); }
function stock(state, barcode) { return state.assets.find(row => row.kind === 'raw_material' && barcodeKey(row.identifier) === barcodeKey(barcode)); }
function assignments(state, orderId, apparatusId) { return state.rawAssignments.filter(row => (!orderId || row.order_id === orderId) && (!apparatusId || row.apparatus_id === apparatusId)); }
function enrichment(state, assignment) {
  const asset = stock(state, assignment.barcode), received = asset?.status === 'in_use' && asset.reserved_order_id === assignment.order_id;
  return { ...clone(assignment), execution_status: received ? 'in_use' : asset?.status !== 'available' || asset.reserved_order_id ? 'unavailable' : atApparatus(state, asset, assignment.apparatus_id) ? 'ready' : 'awaiting_delivery',
    stock_status: asset?.status ?? '', stock_qty: asset?.qty ?? 0, stock_warehouse: asset?.custody_warehouse ?? '', stock_uom: asset?.uom ?? '', reserved_order_id: asset?.reserved_order_id ?? '',
    received_qty: received ? asset.qty : 0, consumed_qty: assignment.consumed_qty ?? 0, remaining_qty: received ? asset.qty - (assignment.consumed_qty ?? 0) : 0, roll_width_mm: asset?.width_mm ?? null };
}
export function seedMaterialIntakeScenario(state, { scenario = 'intake' } = {}) {
  if (!['intake', 'paused', 'delivery', 'cut', 'repeated'].includes(scenario)) return error(400, 'invalid_material_intake_fixture');
  const order = state.orders[0], node = order.map.nodes.find(row => row.id === (scenario === 'cut' ? 'cut' : 'print')), activeState = scenario === 'delivery' ? 'pending' : scenario === 'paused' ? 'paused' : 'in_progress';
  Object.assign(order, { control: 'active', operational: activeState === 'pending' ? 'ready' : activeState }); delete order.earlyClose; order.stages[node.id] = activeState;
  if (scenario === 'repeated') { order.map.nodes.push({ ...clone(node), id: 'print-intake-repeat', y: 810 }); order.stages['print-intake-repeat'] = 'pending'; }
  const asset = state.assets.find(row => row.asset_ref === (scenario === 'delivery' ? 'qa-roll-2' : 'qa-roll-1'));
  Object.assign(asset, { status: 'available', reserved_order_id: '', width_mm: 515, source_receipt_id: 'qa-source-receipt:' + asset.asset_ref });
  if (scenario === 'delivery') asset.physical_location = { id: 'qa-location-stock', kind: 'warehouse', name: 'QA Xomashyo' };
  const assignment = { order_id: order.map.id, apparatus_id: effective(node), barcode: asset.identifier, item_code: asset.item_code, item_name: asset.item_name, item_group: 'Xomashyo', assigned_at: '2026-10-13T12:00:00Z', assigned_by_role: 'material_taminotchi', assigned_by_ref: 'QA-MATERIAL-1', assigned_by_display_name: 'QA Material mas’uli', consumed_qty: 0 };
  state.rawAssignments = state.rawAssignments.filter(row => barcodeKey(row.barcode) !== barcodeKey(asset.identifier)); state.rawAssignments.push(assignment);
  const session = { session_id: 'qa-material-intake-session', order_id: order.map.id, apparatus: effective(node), stage_node_id: node.id, status: activeState === 'paused' ? 'paused' : 'active', worker_role: 'aparatchi', worker_ref: 'qa-worker-1', worker_display_name: 'QA Brigadir', started_at_unix: 1791892700, updated_at_unix: 1791892800, payload_json: { stage_node_id: node.id, start_resources: { raw_materials: [] } } };
  if (activeState !== 'pending') state.assignmentSessions.push(session);
  state.materialIntakeFixture = { orderId: order.map.id, apparatusId: effective(node), stageNodeId: node.id, barcode: asset.identifier };
  state.materialDeliveryCommands ??= {};
  const roleId = 'qa-delivery-role';
  if (!state.roles.some(row => row.id === roleId)) state.roles.push({ id: roleId, label: 'QA Delivery', system: false, base_role: null, capability_codes: ['inventory.movement.manage'] });
  if (!state.roleAssignments.some(row => row.principal_ref === 'QA-MATERIAL-1' && row.role_id === roleId)) state.roleAssignments.push({ principal_role: 'material_taminotchi', principal_ref: 'QA-MATERIAL-1', role_id: roleId, assigned_apparatus: [], assigned_item_groups: [] });
  if (!state.warehouseAssignments.some(row => row.principal_ref === 'QA-MATERIAL-1')) state.warehouseAssignments.push({ assignment_kind: 'warehouse', warehouse: asset.custody_warehouse, principal_role: 'material_taminotchi', principal_ref: 'QA-MATERIAL-1', display_name: 'QA Material mas’uli' });
  state.rev++; return response({ ok: true, ...state.materialIntakeFixture, scenario });
}
export function materialIntakeSnapshotControl(state, order, node, baseline) {
  const scope = state.materialIntakeFixture;
  if (!scope || order.map.id !== scope.orderId || node.id !== scope.stageNodeId) return baseline;
  const status = order.stages[node.id], pending = status === 'pending', blocked = order.control !== 'active' || order.earlyClose;
  const session = state.assignmentSessions.find(row => row.order_id === order.map.id && row.apparatus === effective(node) && ['active', 'paused'].includes(row.status));
  return { ...clone(baseline), state: blocked ? 'frozen' : status, stage_node_id: node.id, allowed_actions: blocked ? [] : pending ? ['start'] : ['pause', 'complete'],
    previous_stage_ready: true, complete_requires_full_report: false, complete_requires_rezka_total_waste_only: false,
    interaction: { mode: blocked ? 'frozen' : pending ? 'fresh_start' : status, start_materials_mode: pending ? 'scan_required' : 'hidden', material_scan_required: pending, assigned_materials_display_only: false, material_intake_allowed: !blocked && !pending,
      resume_input_required: false, previous_wip_mode: 'not_required', opening_wip_mode: 'not_required', qolip_mode: 'not_required' },
    ...(session ? { work_activity: { state: status, worker_role: session.worker_role, worker_ref: session.worker_ref, worker_display_name: session.worker_display_name, session_id: session.session_id } } : {}) };
}
function materialContext(state, input) {
  const order = state.orders.find(row => row.map.id === input.order_id), node = order?.map.nodes.find(row => row.kind === 'apparatus' && effective(row) === input.apparatus);
  const assignment = assignments(state, input.order_id, input.apparatus).find(row => barcodeKey(row.barcode) === barcodeKey(input.barcode)), asset = stock(state, input.barcode);
  return { order, node, assignment, asset, state: node ? order.stages[node.id] : '' };
}
function allowed(context) { return context.order?.control === 'active' && !context.order.earlyClose && context.node && ['pending', 'in_progress', 'paused'].includes(context.state); }
function deliverers(state, warehouse) {
  return state.warehouseAssignments.filter(row => row.warehouse === warehouse).filter(row => state.roleAssignments.some(assignment => assignment.principal_role === row.principal_role && assignment.principal_ref === row.principal_ref && state.roles.some(role => role.id === assignment.role_id && role.capability_codes.includes('inventory.movement.manage')))).map(row => ({ role: row.principal_role, ref: row.principal_ref, name: row.display_name })).filter((row, index, all) => all.findIndex(other => other.role === row.role && other.ref === row.ref) === index);
}
export function materialIntakeFixtureRoute({ method, path, query, body, state, profile, requires, config, bump, equal }) {
  if (!state.materialIntakeFixture) return undefined;
  const known = ['/raw-material-assignments', '/raw-material-assignments/lookup', '/raw-material-start-requirements', '/raw-material-intake-candidates', '/raw-material-intake', '/raw-material-start-receipt', '/raw-material-history'];
  const suffix = path.startsWith(base) ? path.slice(base.length) : ''; if (!known.includes(suffix)) return undefined;
  const read = requires('admin.access', 'production.map.manage', 'raw_material.assign', 'apparatus.queue.read', 'apparatus.queue.manage'), manage = requires('apparatus.queue.manage');
  const input = method === 'GET' ? query : body ?? {}, context = materialContext(state, input), assigned = config.assignedApparatus?.includes(input.apparatus);
  if (suffix === '/raw-material-history') {
    if (!requires('admin.access', 'production.map.manage', 'inventory.movement.manage')) return error(403, 'forbidden');
    return response(clone(state.rawHistory.filter(row => (!query.warehouse || row.warehouse === query.warehouse) && (!query.event_type || row.event_type === query.event_type)).slice(0, Math.min(200, Number(query.limit) || 200))));
  }
  if (!read) return error(403, 'forbidden');
  if (suffix === '/raw-material-assignments' && method === 'GET') return response(assignments(state, query.order_id, query.apparatus).map(row => enrichment(state, row)));
  if (suffix === '/raw-material-assignments/lookup' && method === 'GET') {
    const asset = stock(state, query.barcode), assignment = state.rawAssignments.find(row => barcodeKey(row.barcode) === barcodeKey(query.barcode));
    if (!asset) return error(404, 'raw_material_stock_unavailable');
    return response({ barcode: asset.identifier, warehouse: asset.custody_warehouse, item_code: asset.item_code, item_name: asset.item_name, qty: asset.qty, uom: asset.uom, status: asset.status, reserved_order_id: asset.reserved_order_id ?? '', source_receipt_id: asset.source_receipt_id,
      assignment: assignment ? enrichment(state, assignment) : null, order: assignment ? clone(state.orders.find(row => row.map.id === assignment.order_id)?.map) : null, queue_states: {}, logs: [] });
  }
  if (suffix === '/raw-material-start-requirements' && method === 'GET') {
    const all = assignments(state, query.order_id, query.apparatus), staged = all.filter(row => { const asset = stock(state, row.barcode); return asset && atApparatus(state, asset, query.apparatus); }).map(row => row.barcode), scanned = text(query.material_barcodes).split(',').map(barcodeKey), matched = all.filter(row => scanned.includes(barcodeKey(row.barcode))).length;
    return response({ material_scan_required: context.state === 'pending', assignments_satisfied: all.length > 0, scan_satisfied: matched >= all.length && all.length > 0, required_scan_count: all.length || 1, matched_scan_count: matched, staged_barcodes: staged, eligible_barcodes: all.map(row => row.barcode) });
  }
  if (suffix === '/raw-material-intake-candidates' && method === 'GET') {
    if (profile.role === 'aparatchi' && !assigned) return error(403, 'apparatus_not_assigned');
    if (!allowed(context) || !['in_progress', 'paused'].includes(context.state) || context.node.id === 'cut') return response([]);
    return response(assignments(state, query.order_id, query.apparatus).map(row => enrichment(state, row)).filter(row => row.stock_status === 'available' && !row.reserved_order_id && row.stock_qty > 0));
  }
  if (!manage) return error(403, 'forbidden');
  if (!allowed(context)) return error(409, context.order?.control === 'frozen' ? 'order_frozen' : 'queue_action_not_allowed');
  if (!context.assignment || !context.asset) return error(409, 'raw_material_assignment_not_found');
  if (context.asset.status !== 'available' || context.asset.reserved_order_id || context.asset.qty <= 0 || context.asset.transfer_id) return error(409, 'raw_material_stock_unavailable');
  if (suffix === '/raw-material-start-receipt') {
    if (profile.role === 'aparatchi' ? !assigned : !requires('admin.access')) return error(403, 'forbidden');
    const locations = destination(state, input.apparatus), choices = deliverers(state, context.asset.custody_warehouse);
    if (!locations.length) return error(409, 'material_delivery_location_missing');
    if (method === 'GET') return response({ already_at_apparatus: atApparatus(state, context.asset, input.apparatus), deliverers: choices });
    if (method !== 'POST') return error(405, 'method_not_allowed');
    if (!object(body) || Object.keys(body).some(key => !['order_id', 'apparatus', 'barcode', 'delivered_by_role', 'delivered_by_ref', 'idempotency_key'].includes(key)) || !text(body.idempotency_key)) return error(400, 'raw_material_invalid_input');
    const deliverer = choices.find(row => row.role === body.delivered_by_role && row.ref === body.delivered_by_ref);
    if (!deliverer) return error(409, 'material_deliverer_not_allowed');
    const bound = { ...clone(body), actor: actor(profile), asset_ref: context.asset.asset_ref, warehouse: context.asset.custody_warehouse }, prior = state.materialDeliveryCommands[body.idempotency_key];
    if (prior) return equal(prior.body, bound) ? response(clone(prior.receipt)) : error(409, 'inventory_idempotency_conflict');
    context.asset.physical_location = { id: locations[0].id, kind: 'state', name: locations[0].name }; context.asset.placement_version++;
    const event = { event_id: 'qa-delivery:' + state.rev, event_type: 'delivery_received', source_type: 'material_delivery', source_id: body.idempotency_key, correlation_id: body.idempotency_key, order_id: body.order_id, apparatus: body.apparatus, barcode: context.assignment.barcode, warehouse: context.asset.custody_warehouse, item_code: context.asset.item_code, uom: context.asset.uom, qty_delta: 0, actor_role: profile.role, actor_ref: profile.ref, actor_display_name: profile.display_name, occurred_at_unix: 1791892800 + state.rev,
      payload_json: { order_id: body.order_id, apparatus_id: body.apparatus, delivered_by: clone(deliverer), received_by: actor(profile) } };
    state.rawHistory.unshift(event); const receipt = { ok: true, barcode: context.assignment.barcode, apparatus: body.apparatus };
    state.materialDeliveryCommands[body.idempotency_key] = { body: bound, receipt: clone(receipt) }; bump(); return response(receipt);
  }
  if (suffix === '/raw-material-intake' && method === 'POST') {
    if (!assigned) return error(403, 'apparatus_not_assigned');
    if (!['in_progress', 'paused'].includes(context.state) || context.node.id === 'cut') return error(409, 'raw_material_intake_unavailable');
    if (!object(body) || Object.keys(body).some(key => !['order_id', 'apparatus', 'barcode'].includes(key))) return error(400, 'raw_material_invalid_input');
    if (!atApparatus(state, context.asset, input.apparatus)) return error(400, 'raw_material_state_not_ready');
    context.asset.status = 'in_use'; context.asset.reserved_order_id = input.order_id;
    const session = state.assignmentSessions.find(row => row.order_id === input.order_id && row.apparatus === input.apparatus && ['active', 'paused'].includes(row.status));
    if (session) { session.payload_json.start_resources ??= { raw_materials: [] }; session.payload_json.start_resources.raw_materials.push({ barcode: context.asset.identifier, item_code: context.asset.item_code, source_qty: context.asset.qty, source_warehouse: context.asset.custody_warehouse }); }
    bump(); return response(enrichment(state, context.assignment));
  }
  return error(405, 'method_not_allowed');
}
