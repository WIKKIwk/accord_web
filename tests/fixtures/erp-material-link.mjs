import { apparatusIds } from './erp-seed.mjs';

// Synthetic projection of the native, unkeyed material-link endpoint. Stock
// placements, rather than a warehouse/receipt proof, bind each saved candidate.
export const materialLinkPath = '/v1/mobile/material-link-requests';
const clone = value => structuredClone(value), text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const barcodeKey = value => text(value).toLowerCase(), effective = node => node.alternative_assigned_apparatus_id || node.apparatus_id;
const scenarios = new Set(['available', 'start-ready', 'multi-mover', 'pending', 'expired', 'stale', 'frozen', 'interaction-hidden', 'empty', 'partial-create', 'partial-receipt', 'decision-race', 'decision-read-race']);
const syntheticRefs = new Set(['qa-admin', 'qa-admin-2', 'qa-worker-1', 'qa-worker-2', 'QA-MATERIAL-1', 'QA-MATERIAL-2', 'qa-qolipchi-1']);

export function validMaterialLinkProfile(value) {
  return value === null || object(value) && Object.keys(value).every(key => ['role', 'ref', 'display_name', 'legal_name'].includes(key))
    && ['admin', 'aparatchi', 'material_taminotchi', 'qolipchi'].includes(value.role) && syntheticRefs.has(value.ref)
    && typeof value.display_name === 'string' && value.display_name.startsWith('QA ') && value.display_name.length <= 100
    && (value.legal_name === undefined || value.legal_name === 'QA Synthetic');
}

function locations(state, apparatusId) {
  return state.locations.filter(row => row.active && row.kind === 'state' && row.apparatus?.some(app => app.id === apparatusId));
}
function orderFor(state, id) { return state.orders.find(row => row.map.id === text(id)); }
function activeOrder(order) { return Boolean(order && order.map.id.startsWith('zakaz-') && order.control === 'active' && !order.earlyClose && Object.values(order.stages).some(value => value !== 'completed')); }
function nativeCandidates(state, apparatusId) {
  const destinations = locations(state, apparatusId);
  return state.assets.filter(row => row.kind === 'raw_material' && row.status === 'available' && row.qty > 0 && !row.reserved_order_id && !row.transfer_id
    && row.updated_by_role === 'material_taminotchi' && text(row.updated_by_ref) && destinations.some(location => location.id === row.physical_location?.id)
    && !state.rawAssignments.some(assignment => barcodeKey(assignment.barcode) === barcodeKey(row.identifier)))
    .sort((a, b) => a.asset_ref.localeCompare(b.asset_ref)).map(row => ({ stock_id: row.asset_ref, barcode: row.identifier, item_name: row.item_name, qty: row.qty, uom: row.uom,
      location_id: row.physical_location.id, location_name: row.physical_location.name, placement_version: row.placement_version,
      mover_ref: row.updated_by_ref, mover_display_name: row.updated_by_name }));
}
function eligibleCandidates(state, order, apparatusId) {
  if (!activeOrder(order) || !order.map.nodes.some(node => node.kind === 'apparatus' && effective(node) === apparatusId)) return [];
  // The native handler prepares every candidate as its actual material mover.
  return nativeCandidates(state, apparatusId).filter(candidate => {
    const scope = state.materialLinkFixture.movers[candidate.mover_ref], asset = state.assets.find(row => row.asset_ref === candidate.stock_id);
    return scope?.apparatus.includes(apparatusId) && scope.groups.includes('Xomashyo') && scope.warehouses.includes(asset.custody_warehouse)
      && asset.width_mm >= order.map.width_mm - 10 && asset.width_mm <= order.map.width_mm + 15;
  });
}
function finish(state, request, status, reason, profile, selected = []) {
  if (request.status !== 'pending') return request;
  Object.assign(request, { status, reason, event_sequence: request.event_sequence + 1, decided_at_unix: state.materialLinkFixture.now,
    decided_by_role: profile?.role ?? '', decided_by_name: profile?.display_name ?? '', selected_barcodes: clone(selected) });
  state.rev++; return request;
}
function reconcile(state, request) {
  if (request.status !== 'pending') return request;
  const candidates = nativeCandidates(state, request.apparatus_id), active = activeOrder(orderFor(state, request.order_id));
  // Native reconciliation intentionally does not compare quantity or UOM.
  const stale = !request.candidates.length || request.candidates.some(old => !candidates.some(now => ['stock_id', 'barcode', 'placement_version', 'location_id', 'mover_ref'].every(key => now[key] === old[key])));
  if (!active) finish(state, request, 'stale', 'Order holati o‘zgardi. So‘rov yopildi.');
  else if (stale) finish(state, request, 'stale', 'Rulon boshqa orderga ulangan yoki joyi/holati o‘zgargan. So‘rov yopildi.');
  else if (state.materialLinkFixture.now >= request.expires_at_unix) finish(state, request, 'expired', 'So‘rov muddati tugadi. Zarur bo‘lsa qayta yuboring.');
  return request;
}
function canDecide(profile, request) { return profile.role === 'admin' || profile.role === 'material_taminotchi' && profile.ref === request.mover_ref; }
function canRead(profile, request) { return canDecide(profile, request) || profile.role === 'aparatchi' && profile.ref === request.requester_ref; }
function pendingRequest(state, order, apparatusId, profile, candidates) {
  const scope = state.materialLinkFixture, apparatus = state.apparatus.find(row => row.apparatus_id === apparatusId);
  return { request_id: `material-link-${(++scope.nextRequest).toString(16).padStart(32, '0')}`, status: 'pending', event_sequence: 1,
    order_id: order.map.id, order_number: order.map.order_number, order_title: order.map.title, apparatus_id: apparatusId, apparatus_name: apparatus.display.display_name,
    requester_ref: profile.ref, requester_display_name: profile.display_name, mover_ref: candidates[0].mover_ref, mover_display_name: candidates[0].mover_display_name,
    candidates: clone(candidates), selected_barcodes: [], decided_by_name: '', decided_by_role: '', decided_at_unix: 0, reason: '', requested_at_unix: scope.now, expires_at_unix: scope.now + 1800 };
}
function approve(state, request, profile, selected) {
  // Prepare all rows before one commit, mirroring the native assignment+decision transaction.
  const assignments = selected.map(barcode => {
    const asset = state.assets.find(row => barcodeKey(row.identifier) === barcodeKey(barcode));
    return { order_id: request.order_id, apparatus_id: request.apparatus_id, barcode: asset.identifier, item_code: asset.item_code, item_name: asset.item_name, item_group: 'Xomashyo',
      assigned_at: new Date(state.materialLinkFixture.now * 1000).toISOString(), assigned_by_role: profile.role, assigned_by_ref: profile.ref, assigned_by_display_name: profile.display_name,
      stock_status: asset.status, execution_status: 'ready', stock_qty: asset.qty, stock_uom: asset.uom, stock_warehouse: asset.custody_warehouse, consumed_qty: 0 };
  });
  state.rawAssignments.push(...assignments); return finish(state, request, 'approved', '', profile, selected);
}

export function seedMaterialLinkScenario(state, input = {}) {
  if (!object(input)) return error(400, 'invalid_material_link_fixture');
  if (input.action === 'advance') {
    if (!state.materialLinkFixture || Object.keys(input).some(key => !['action', 'seconds'].includes(key)) || !Number.isSafeInteger(input.seconds) || input.seconds < 0 || input.seconds > 7200) return error(400, 'invalid_material_link_clock');
    state.materialLinkFixture.now += input.seconds; return response({ ok: true, now: state.materialLinkFixture.now });
  }
  if (input.action === 'stock') {
    const allowed = new Set(['qty', 'uom', 'placement_version', 'updated_by_ref', 'updated_by_role', 'reserved_order_id', 'status', 'transfer_id', 'width_mm']);
    const asset = state.assets.find(row => row.kind === 'raw_material' && row.asset_ref === input.stock_id);
    if (!state.materialLinkFixture || !asset || Object.keys(input).some(key => !['action', 'stock_id', 'patch'].includes(key)) || !object(input.patch) || Object.keys(input.patch).some(key => !allowed.has(key))
      || ['qty', 'width_mm', 'placement_version'].some(key => input.patch[key] !== undefined && (!Number.isFinite(input.patch[key]) || input.patch[key] < 0))
      || Object.keys(input.patch).some(key => !['qty', 'width_mm', 'placement_version'].includes(key) && typeof input.patch[key] !== 'string')) return error(400, 'invalid_material_link_stock');
    Object.assign(asset, clone(input.patch)); state.rev++; return response({ ok: true, stock_id: asset.asset_ref });
  }
  const scenario = input.scenario ?? 'available';
  if (Object.keys(input).some(key => key !== 'scenario') || !scenarios.has(scenario)) return error(400, 'invalid_material_link_fixture');
  const order = state.orders[0], node = order.map.nodes.find(row => row.id === 'print'), apparatusId = apparatusIds.print;
  Object.assign(order, { control: scenario === 'frozen' ? 'frozen' : 'active', operational: 'ready' }); delete order.earlyClose; order.stages.print = 'pending';
  const destination = locations(state, apparatusId)[0];
  for (const asset of state.assets.filter(row => row.kind === 'raw_material')) Object.assign(asset, { status: 'available', reserved_order_id: '', transfer_id: '', width_mm: 515,
    physical_location: { id: destination.id, name: destination.name, kind: 'state' }, updated_by_role: 'material_taminotchi', updated_by_ref: 'QA-MATERIAL-1', updated_by_name: 'QA Material mas’uli', placement_version: 4 });
  state.rawAssignments = []; state.materialLinkRequests = [];
  const first = state.assets.find(row => row.asset_ref === 'qa-roll-1'), second = state.assets.find(row => row.asset_ref === 'qa-roll-2');
  if (scenario === 'start-ready') {
    // Native fresh_start requires a satisfied assignment before optional free
    // rolls can be requested. The already-linked roll is never a candidate.
    const assigned = { ...clone(first), asset_ref: 'qa-roll-start-ready', identifier: 'QA-START-READY', qty: 20 };
    state.assets.push(assigned);
    state.rawAssignments.push({ order_id: order.map.id, apparatus_id: apparatusId, barcode: assigned.identifier, item_code: assigned.item_code, item_name: assigned.item_name, item_group: 'Xomashyo',
      assigned_at: '2026-10-13T12:00:00Z', assigned_by_role: 'material_taminotchi', assigned_by_ref: assigned.updated_by_ref, assigned_by_display_name: assigned.updated_by_name,
      stock_status: assigned.status, execution_status: 'ready', stock_qty: assigned.qty, stock_uom: assigned.uom, stock_warehouse: assigned.custody_warehouse, consumed_qty: 0 });
    for (const other of state.orders.filter(row => row !== order)) for (const stage of other.map.nodes.filter(row => row.kind === 'apparatus' && effective(row) === apparatusId)) other.stages[stage.id] = 'completed';
  }
  if (['multi-mover', 'partial-create', 'partial-receipt'].includes(scenario)) Object.assign(second, { updated_by_ref: 'QA-MATERIAL-2', updated_by_name: 'QA Ikkinchi material mas’uli' });
  if (scenario === 'empty') first.status = second.status = 'unavailable';
  state.materialLinkFixture = { scenario, orderId: order.map.id, apparatusId, stageNodeId: node.id, now: 1791892800, nextRequest: 0,
    movers: Object.fromEntries(['QA-MATERIAL-1', 'QA-MATERIAL-2'].map(ref => [ref, { apparatus: [apparatusId], groups: ['Xomashyo'], warehouses: ['QA Xomashyo'] }])),
    failAfterGroups: scenario === 'partial-create' ? 1 : null, corruptCreateReceipt: scenario === 'partial-receipt', decisionRace: ['decision-race', 'decision-read-race'].includes(scenario), detailReads: 0 };
  if (['pending', 'expired', 'stale', 'decision-race', 'decision-read-race'].includes(scenario)) {
    const candidates = eligibleCandidates(state, order, apparatusId), request = pendingRequest(state, order, apparatusId, { ref: 'qa-worker-1', display_name: 'QA Brigadir' }, candidates);
    state.materialLinkRequests.push(request);
    if (scenario === 'expired') state.materialLinkFixture.now += 1800;
    if (scenario === 'stale') first.placement_version++;
  }
  state.rev++;
  return response({ ok: true, scenario, orderId: order.map.id, apparatusId, stockIds: [first.asset_ref, second.asset_ref], barcodes: [first.identifier, second.identifier], requestIds: state.materialLinkRequests.map(row => row.request_id) });
}

export function materialLinkSnapshotControl(state, order, node, baseline) {
  const scope = state.materialLinkFixture;
  if (!scope || order.map.id !== scope.orderId || node.id !== scope.stageNodeId) return baseline;
  const hidden = scope.scenario === 'interaction-hidden' || !activeOrder(order);
  const ready = !hidden && scope.scenario === 'start-ready' && state.rawAssignments.some(row => row.order_id === order.map.id && row.apparatus_id === scope.apparatusId);
  return { ...clone(baseline), state: order.control === 'frozen' ? 'frozen' : order.stages[node.id], stage_node_id: node.id, previous_stage_ready: true,
    allowed_actions: ready ? ['start'] : [], interaction: { ...clone(baseline.interaction ?? {}), mode: ready ? 'fresh_start' : 'fresh_start_blocked',
      start_materials_mode: hidden ? 'hidden' : 'scan_required', material_scan_required: !hidden, assigned_materials_display_only: hidden, material_intake_allowed: false,
      ...(ready ? { blocking_reason_code: '', previous_wip_mode: 'not_required', opening_wip_mode: 'not_required' } : { blocking_reason_code: baseline.interaction?.blocking_reason_code || 'raw_material_assignment_required' }) } };
}

export function materialLinkFixtureRoute({ method, path, query, body, state, profile, requires, config }) {
  if (path !== materialLinkPath) return undefined;
  if (!state.materialLinkFixture) return error(500, 'material_link_unavailable');
  if (!requires('apparatus.queue.manage', 'raw_material.assign', 'admin.access')) return error(403, 'forbidden');
  const scope = state.materialLinkFixture, assigned = apparatus => config.assignedApparatus.includes(apparatus);
  if (method === 'GET' && text(query.request_id)) {
    const request = state.materialLinkRequests.find(row => row.request_id === query.request_id);
    if (!request) return error(404, 'material_link_not_found');
    reconcile(state, request);
    if (!canRead(profile, request)) return error(403, 'forbidden');
    // A competing actual mover commits after the review read, before POST. The
    // response retains that read's pending snapshot to exercise terminal races.
    const payload = { can_decide: canDecide(profile, request), request: clone(request) };
    if (scope.decisionRace && ++scope.detailReads === 2 && request.status === 'pending') {
      approve(state, request, { role: 'material_taminotchi', ref: request.mover_ref, display_name: 'QA Original manager' }, [request.candidates[1].barcode]);
      if (scope.scenario === 'decision-read-race') payload.request = clone(request);
    }
    return response(payload);
  }
  if (method === 'GET') {
    if (profile.role !== 'aparatchi' || !assigned(query.apparatus)) return error(403, 'forbidden');
    const requests = state.materialLinkRequests.filter(row => row.order_id === query.order_id && row.apparatus_id === query.apparatus && row.requester_ref === profile.ref)
      .sort((a, b) => b.requested_at_unix - a.requested_at_unix || b.request_id.localeCompare(a.request_id)).slice(0, 50).map(row => reconcile(state, row));
    const candidates = requires('apparatus.queue.manage') ? eligibleCandidates(state, orderFor(state, query.order_id), query.apparatus) : [];
    return response({ available_count: candidates.length, candidates: clone(candidates), requests: clone(requests) });
  }
  if (method !== 'POST') return error(405, 'method_not_allowed');
  if (!object(body)) return error(400, 'invalid_json');
  if (body.action === 'create') {
    if (profile.role !== 'aparatchi' || !requires('apparatus.queue.manage') || !assigned(body.apparatus) || !text(body.order_id)) return error(403, 'forbidden');
    const order = orderFor(state, body.order_id); if (!activeOrder(order)) return error(400, 'raw_material_order_not_active');
    const selected = Array.isArray(body.barcodes) ? body.barcodes.map(barcodeKey) : [];
    if (!selected.length || selected.some(value => !value) || new Set(selected).size !== selected.length) return error(400, 'material_link_selection_required');
    const candidates = eligibleCandidates(state, order, body.apparatus).filter(row => selected.includes(barcodeKey(row.barcode)));
    if (candidates.length !== selected.length) return error(400, 'material_link_candidates_changed');
    const groups = [...new Set(candidates.map(row => row.mover_ref))].sort(), requests = [];
    for (const mover of groups) {
      if (scope.failAfterGroups !== null && requests.length >= scope.failAfterGroups) return error(500, 'material_link_store_failed');
      let request = state.materialLinkRequests.find(row => row.status === 'pending' && row.order_id === order.map.id && row.apparatus_id === body.apparatus && row.requester_ref === profile.ref && row.mover_ref === mover);
      if (request) reconcile(state, request);
      if (!request || request.status !== 'pending') { request = pendingRequest(state, order, body.apparatus, profile, candidates.filter(row => row.mover_ref === mover)); state.materialLinkRequests.push(request); state.rev++; }
      requests.push(clone(request));
    }
    // Explicit transport-corruption scenario: retain a valid first native ID
    // while rejecting the complete receipt. Persisted rows remain unmodified.
    return response({ requests: scope.corruptCreateReceipt ? requests.map((row, index) => index === 1 ? { ...row, event_sequence: 'malformed-fixture-receipt' } : row) : requests });
  }
  const request = state.materialLinkRequests.find(row => row.request_id === body.request_id); if (!request) return error(404, 'material_link_not_found');
  reconcile(state, request);
  if (body.action === 'cancel') {
    if (profile.role !== 'aparatchi' || profile.ref !== request.requester_ref) return error(403, 'forbidden');
    return response({ request: clone(finish(state, request, 'cancelled', 'Worker so‘rovni bekor qildi', profile)) });
  }
  if (!canDecide(profile, request) || !requires('raw_material.assign')) return error(403, 'forbidden');
  if (!['approve', 'reject'].includes(body.action)) return error(400, 'material_link_action_invalid');
  if (request.status !== 'pending') return response({ request: clone(request) });
  if (body.action === 'reject') return response({ request: clone(finish(state, request, 'cancelled', '', profile)) });
  const selected = Array.isArray(body.barcodes) ? body.barcodes.map(barcodeKey) : [];
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(barcode => !request.candidates.some(row => barcodeKey(row.barcode) === barcode))) return error(400, 'material_link_selection_required');
  const eligible = eligibleCandidates(state, orderFor(state, request.order_id), request.apparatus_id);
  if (profile.role === 'material_taminotchi' && !assigned(request.apparatus_id) || selected.some(barcode => !eligible.some(row => barcodeKey(row.barcode) === barcode))) return response({ request: clone(finish(state, request, 'stale', 'Tanlangan rulonning holati yoki ulash shartlari o‘zgardi. So‘rovni yangilang.')) });
  const barcodes = body.barcodes.map(value => text(value));
  return response({ request: clone(approve(state, request, profile, barcodes)) });
}
