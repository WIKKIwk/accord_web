import { createHash } from 'node:crypto';
import { refreshFixtureCanonical, fixtureCanonicalRevision } from './erp-canonical.mjs';
import { fixtureManufacturingDemoCohort } from './erp-manufacturing-demo.mjs';
import { workerGroupProfileGroups } from './erp-worker-groups.mjs';

// Synthetic native DTOs only. This module has no listener, filesystem or network.
const base = '/v1/mobile/admin', pm = `${base}/production-maps`;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const response = body => ({ status: 200, body });
const error = (status, code) => ({ status, body: { error: code } });
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const str = value => typeof value === 'string' ? value.trim() : '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = state => 1791892800 + state.rev;
const source = row => ({ apparatus_id: row.apparatus_id, source_revision: row.source_revision, source_aasx_sha256: row.source_aasx_sha256 });
const filter = (rows, query, statusKey = 'wip_status') => rows.filter(row => (!query.order_id || row.order_id === query.order_id) && (!query.status || query.status === 'all' || row[statusKey] === query.status)).slice(0, Math.min(500, Number(query.limit) || 500));
const active = order => order && order.control === 'active' && !order.earlyClose && Object.values(order.stages).some(stage => stage !== 'completed');
function stages(order) { return order?.map.nodes.filter(node => node.kind === 'apparatus') || []; }
function nextStage(order, node) { const nodes = stages(order); return nodes[nodes.indexOf(node) + 1]; }
function validCapacity(input) {
  if (!object(input) || !integer(input.capacity_slots, 1, 64) || !integer(input.setup_minutes, 0, 4294967295) || !integer(input.cleanup_minutes, 0, 4294967295) || !integer(input.efficiency_percent, 1, 200) || typeof input.finite_capacity !== 'boolean' || !object(input.availability)) return false;
  if (input.availability.mode === 'always') return true;
  const windows = input.availability.working_windows;
  return input.availability.mode === 'scheduled' && Array.isArray(windows) && windows.length > 0 && windows.every(window => integer(window.weekday, 1, 7) && integer(window.start_minute, 0, 1439) && integer(window.end_minute, 1, 1440) && window.start_minute < window.end_minute) && new Set(windows.map(window => JSON.stringify(window))).size === windows.length;
}
export function updateFixtureApparatusHash(row, planning, metadata) { refreshFixtureCanonical(row, planning, metadata); }

export function workflowRoute({ method, path, query, body, headers, state, config, requires, compile, bump, findOrder, profile, equal }) {
  const manage = () => requires('admin.access', 'production.map.manage');
  const read = () => requires('admin.access', 'production.map.manage', 'apparatus.queue.read');
  if (path === `${base}/workers/profile-detail` && method === 'GET') {
    if (!requires('admin.access')) return error(403, 'forbidden');
    const worker = state.workers.find(row => row.id === query.id);
    if (!worker) return error(404, 'worker_not_found');
    const activeSessions = worker.id === 'qa-worker-1' ? [{ session_id: 'qa-worker-session-1', apparatus: 'apparatus:qa:print-1', order_id: 'zakaz-qa-1002', status: 'active', worker_role: 'aparatchi', worker_ref: worker.id, worker_display_name: worker.name, started_at_unix: 1791892800, updated_at_unix: 1791892900, payload_json: { stage_node_id: 'print' } }] : [];
    const logs = worker.id === 'qa-worker-1' ? [{ event_id: 'qa-worker-log-1', apparatus: 'apparatus:qa:print-1', order_id: 'zakaz-qa-1002', action: 'start', from_state: 'pending', to_state: 'in_progress', actor_role: 'aparatchi', actor_ref: worker.id, actor_display_name: worker.name, created_at_unix: 1791892800, completed_with_issue: false }] : [];
    return response({ worker: { ...clone(worker), avatar_url: '', code: 'QA-PROFILE-ONLY' }, assigned_apparatus: state.roleAssignments.filter(row => row.principal_ref === worker.id).flatMap(row => row.assigned_apparatus), assigned_groups: workerGroupProfileGroups(state, worker.id), active_sessions: activeSessions, recent_batches: worker.id === 'qa-worker-1' ? clone(state.wip.slice(0, 50)) : [], recent_logs: logs });
  }
  if (path === `${pm}/progress-qr/history` && method === 'GET' && query.worker_ref) {
    if (!read() || profile.role !== 'admin') return error(403, 'forbidden');
    return response({ ok: true, batches: query.worker_ref === 'qa-worker-1' ? clone(state.wip.slice(0, Math.min(200, Number(query.limit) || 200))) : [] });
  }
  if (path === `${pm}/closed-orders` && method === 'GET') return read() ? response({ ok: true, closed_orders: config.emptyClosedHistory ? [] : clone([...state.closedOrders, ...(config.manufacturingDemoCohort ? fixtureManufacturingDemoCohort(state, { invalid: config.manufacturingDemoInvalidRecord }) : [])]) }) : error(403, 'forbidden');
  if (path === pm && method === 'GET' && state.historicalMaps[query.id]) return read() ? response(compile(state.historicalMaps[query.id])) : error(403, 'forbidden');
  if (path === `${pm}/progress-qr/report` && method === 'POST') {
    if (!read()) return error(403, 'forbidden');
    const batch = state.wip.find(row => row.batch_id === body?.progress_batch_id);
    if (!batch) return error(404, 'progress_batch_not_found');
    const order = findOrder(batch.order_id), wrong = config.manufacturingReportMode === 'wrong_identity';
    const sessions = state.assignmentSessions.filter(row => row.order_id === batch.order_id);
    return response({ ok: true, history_scope: 'batch_lineage', lineage_complete: config.manufacturingReportMode === 'complete', scanned_batch: { ...clone(batch), ...(wrong ? { order_id: 'zakaz-qa-other' } : {}) }, order: { ...clone(order.map), ...(wrong ? { id: 'zakaz-qa-other' } : {}) }, logs: clone(state.timeLogs.filter(row => row.order_id === batch.order_id)), run_sessions: clone(sessions), active_sessions: clone(sessions.filter(row => ['active', 'paused'].includes(row.status))), progress_batches: [clone(batch)] });
  }
  if (path === '/v1/mobile/calculate' && method === 'POST') {
    if (!manage()) return error(403, 'forbidden');
    if (!positive(body?.kg) || !positive(body.frame_product_size_mm) || !integer(body.frame_count, 1) || !integer(body.edge_allowance_mm, 0) || !Array.isArray(body.layers) || !body.layers.length) return error(400, 'invalid_calculation');
    const layers = body.layers.map(layer => {
      const material = state.materials.find(row => row.id === layer.material_id || row.name === layer.material);
      const variant = material?.variants.find(row => row.micron === Number(layer.micron));
      return variant ? { ...layer, coefficient: variant.coefficient, gsm: variant.actual_gsm ?? variant.coefficient / 0.06 } : null;
    });
    if (layers.some(layer => !layer)) return error(400, 'calculation_material_not_found');
    const width = body.frame_product_size_mm * body.frame_count + body.edge_allowance_mm, gsm = layers.reduce((sum, row) => sum + row.gsm, 0);
    const length = body.kg * 1_000_000 / (width * gsm), waste = length * body.waste_percent / 100;
    return response({ ok: true, kg: body.kg, frame_product_size_mm: body.frame_product_size_mm, frame_count: body.frame_count, edge_allowance_mm: body.edge_allowance_mm, width_mm: width, min_mold_size_mm: width, rubber_size_mm: width, waste_percent: body.waste_percent, layers,
      results: [{ film_gsm: gsm, adhesive_gsm: 0, total_gsm: gsm, coeff_sum: layers.reduce((sum, row) => sum + row.coefficient, 0), base_length: length, waste_length: waste, rounded_length: Math.ceil((length + waste) / 100) * 100 }] });
  }
  if (path === '/v1/mobile/calculate/orders') {
    if (!manage()) return error(403, 'forbidden');
    if (method === 'GET') return response({ ok: true, templates: clone(state.templates) });
    if (method === 'POST') {
      if (!object(body) || !str(body.name) || !str(body.product) || !Array.isArray(body.layers) || !body.layers.length) return error(400, 'invalid_template');
      let template = state.templates.find(row => row.id === body.id);
      const id = template?.id || str(body.id) || `qa-template-${state.nextId++}`;
      if (template) Object.assign(template, clone(body), { id });
      else { template = { ...clone(body), id }; state.templates.push(template); }
      bump(); return response({ ok: true, template: clone(template) });
    }
    return error(405, 'method_not_allowed');
  }
  if (path === '/v1/mobile/calculate/orders/delete' && method === 'POST') {
    if (!manage()) return error(403, 'forbidden');
    const index = state.templates.findIndex(row => row.id === body?.id);
    if (index < 0) return error(404, 'template_not_found');
    state.templates.splice(index, 1); bump(); return response({ ok: true });
  }
  if (path === `${base}/pending-orders` && method === 'GET') {
    if (!manage()) return error(403, 'forbidden');
    const row = state.pendingOrders.find(row => row.id === query.id);
    return query.id ? row ? response(clone(row)) : error(404, 'pending_order_not_found') : response(clone(state.pendingOrders.filter(row => !row.completion)));
  }
  if (path === `${pm}/with-order` && method === 'PUT') {
    if (!manage()) return error(403, 'forbidden');
    const pending = body?.pending_order_id ? state.pendingOrders.find(row => row.id === body.pending_order_id) : null;
    if (body?.pending_order_id && !pending) return error(404, 'pending_order_not_found');
    if (pending?.completion) return response({ ok: true, ...clone(pending.completion) });
    if (!object(body?.map) || !object(body.template) || !Array.isArray(body.map.nodes) || !Array.isArray(body.map.edges)) return error(400, 'invalid_production_map');
    if (pending && (body.map.id !== pending.id || body.template.id !== pending.template.id || body.template.code !== pending.template.code || body.template.order_number !== pending.template.order_number)) return error(409, 'pending_order_identity_conflict');
    const number = pending?.template.order_number || String(3000 + state.nextId++), id = `zakaz-${number}`;
    const map = { ...clone(body.map), id, code: number, order_number: number }, template = { ...clone(body.template), id: pending?.template.id || `qa-order-template-${number}`, code: number, order_number: number, source_map_id: id };
    state.orders.push({ map, template, calculationRevision: 1, stages: Object.fromEntries(stages({ map }).map(node => [node.id, 'pending'])), control: 'active' });
    const result = { saved: compile(map), template };
    if (pending) pending.completion = clone(result);
    bump(); return response({ ok: true, ...result });
  }
  if (path === `${pm}/wip-batches` && method === 'GET') return read() ? response({ batches: clone(filter(state.wip, query)) }) : error(403, 'forbidden');
  if (path === `${pm}/opening-wip`) {
    if (!(method === 'GET' ? read() : manage())) return error(403, 'forbidden');
    if (method === 'GET') {
      const records = state.openingWip.filter(record => (!query.order_id || record.intake.order_id === query.order_id) && (!query.status || query.status === 'all' || record.intake.status === query.status)).slice(0, Math.min(500, Number(query.limit) || 500));
      return response({ records: clone(records) });
    }
    if (method === 'POST') {
      const key = str(body?.idempotency_key), prior = state.openingWip.find(row => row.intake.idempotency_key === key);
      if (prior) return equal(state.openingCommands[key], body) ? response({ record: clone(prior) }) : error(409, 'opening_wip_idempotency_conflict');
      const order = findOrder(body?.order_id), node = stages(order).find(node => node.id === body?.source_stage_node_id && node.apparatus_id === body.source_apparatus), apparatus = state.apparatus.find(row => row.apparatus_id === body?.source_apparatus);
      if (!active(order) || !node || !nextStage(order, node) || apparatus?.lifecycle.state !== 'active') return error(409, 'opening_wip_source_changed');
      const operation = apparatus.execution_profile.operation;
      if (!key || key.length > 200 || !Array.isArray(body.batches) || !body.batches.length || body.batches.length > 500 || body.batches.some(row => !['measured', 'estimated'].includes(row.quantity_basis) || !['finished_goods_meter', 'finished_goods_kg', 'bobina_kg', ...(operation === 'cut' ? ['diameter'] : [])].every(field => positive(row[field])) || operation !== 'cut' && row.diameter !== undefined)) return error(400, 'invalid_opening_wip');
      const id = `qa-opening-${state.nextId++}`, created = now(state);
      const intake = { intake_id: id, idempotency_key: key, order_id: order.map.id, entry_apparatus: apparatus.apparatus_id, source_apparatus: apparatus.apparatus_id, source_operation: operation, resume_stage_node_id: node.id, resume_apparatus: '', current_location: '', history_status: 'unavailable_before_cutover', status: 'confirmed', note: str(body.note), actor: { role: profile.role, ref_: profile.ref, display_name: profile.display_name }, created_at_unix: created, updated_at_unix: created };
      const batches = body.batches.map((row, index) => ({ ...clone(row), batch_id: `${id}:batch:${index + 1}`, intake_id: id, order_id: order.map.id, sequence_no: index + 1, qr_payload: `QA-OPENING:${id}:${index + 1}`, quantity: row.finished_goods_meter, uom: 'm', wip_status: 'waiting', used_by_session_id: '', used_by_apparatus: '', processed_by_session_id: '', processed_by_apparatus: '', label_item_code: order.map.product_code, label_item_name: order.map.title, created_at_unix: created, updated_at_unix: created }));
      const record = { intake, batches }; state.openingWip.push(record); state.openingCommands[key] = clone(body); bump(); return response({ record: clone(record) });
    }
    if (method === 'DELETE') {
      if (!requires('admin.access') || profile.role !== 'admin') return error(403, 'forbidden');
      const record = state.openingWip.find(record => record.batches.some(batch => batch.batch_id === query.batch_id)), batch = record?.batches.find(batch => batch.batch_id === query.batch_id);
      if (!batch) return error(404, 'opening_wip_not_found');
      if (batch.wip_status !== 'waiting' || ['used_by_session_id', 'used_by_apparatus', 'processed_by_session_id', 'processed_by_apparatus', 'lineage_linked'].some(key => batch[key])) return error(409, 'opening_wip_batch_used');
      batch.wip_status = 'void'; batch.updated_at_unix = now(state); record.intake.updated_at_unix = now(state);
      if (record.batches.every(row => row.wip_status === 'void')) record.intake.status = 'cancelled';
      bump(); return response({ ok: true, intake: clone(record.intake), batch: clone(batch) });
    }
    return error(405, 'method_not_allowed');
  }
  if (path === `${pm}/opening-wip/lookup` && method === 'POST') {
    if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.manage')) return error(403, 'forbidden');
    const record = state.openingWip.find(row => row.intake.order_id === body?.order_id && row.batches.some(batch => batch.batch_id === body.batch_id)), batch = record?.batches.find(row => row.batch_id === body.batch_id);
    const order = findOrder(body?.order_id), node = stages(order).find(row => row.id === record?.intake.resume_stage_node_id);
    if (!active(order) || !batch || batch.wip_status !== 'waiting' || batch.qr_payload !== body.qr_payload || nextStage(order, node)?.apparatus_id !== body.apparatus) return error(409, 'opening_wip_route_invalid');
    return response({ ok: true, batch: clone(batch) });
  }
  if (path === `${pm}/progress-qr/lookup` && method === 'POST') {
    if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.manage')) return error(403, 'forbidden');
    const batch = state.wip.find(row => row.batch_id === body?.progress_batch_id), order = findOrder(batch?.order_id), node = stages(order).find(node => node.id === batch?.source_stage_node_id || node.apparatus_id === batch?.apparatus), next = nextStage(order, node);
    if (!active(order) || !batch || batch.wip_status !== 'waiting' || body.qr_payload && body.qr_payload !== batch.qr_payload || body.order_id && body.order_id !== batch.order_id || body.apparatus && next?.apparatus_id !== body.apparatus) return error(409, 'wip_route_invalid');
    return response({ ok: true, active_order_validated: true, validated_apparatus: body.apparatus || '', validated_order_id: body.apparatus ? batch.order_id : '', batch: clone(batch), input_route: next ? { source_stage_node_id: node.id, stage_node_id: next.id, consumer_apparatus_ids: [next.apparatus_id], map_fingerprint: hash(order.map), remapped: batch.next_apparatus !== next.apparatus_id } : null, input_route_error: next ? null : 'wip_route_ambiguous' });
  }
  if ([`${pm}/capacity`, `${pm}/queue-policies`].includes(path)) {
    if (!(method === 'GET' ? read() : manage())) return error(403, 'forbidden');
    const policy = path.endsWith('queue-policies');
    if (method === 'GET') return response(policy ? { ok: true, policies: state.apparatus.map(row => ({ ...source(row), discipline: state.planning[row.apparatus_id].discipline })) } : { ok: true, capacity: state.apparatus.map(row => { const { availability, ...input } = state.planning[row.apparatus_id].capacity; return { ...source(row), ...clone(input), always_available: availability.mode === 'always', working_windows: availability.mode === 'scheduled' ? clone(availability.working_windows) : [] }; }) });
    if (method !== 'PUT') return error(405, 'method_not_allowed');
    const row = state.apparatus.find(row => row.apparatus_id === body?.apparatus_id), key = str(headers['idempotency-key']);
    if (!row) return error(404, 'apparatus_not_found');
    if (row.lifecycle.state !== 'active') return error(409, 'apparatus_retired');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return error(400, 'idempotency_key_required');
    if (body.expected_revision !== row.source_revision || state.planningCommands.includes(key)) return error(409, 'apparatus_revision_conflict');
    const input = state.planning[row.apparatus_id];
    if (policy ? !['strict_sequence', 'free_pick'].includes(body.discipline) : !validCapacity(body.capacity)) return error(400, 'apparatus_revision_invalid');
    if (policy) input.discipline = body.discipline; else input.capacity = clone(body.capacity);
    row.source_revision += 1; updateFixtureApparatusHash(row, input, { command_id: `apparatus-command:${key}`, actor_id: `principal:${profile.ref}` }); state.planningCommands.push(key); bump();
    return response({ ok: true, revision: { revision: fixtureCanonicalRevision(row), runtime_projection: clone(row), aasx_sha256: row.source_aasx_sha256 } });
  }
  if (path === `${pm}/capacity/downtime`) {
    if (!manage()) return error(403, 'forbidden');
    if (!['POST', 'PUT'].includes(method)) return error(405, 'method_not_allowed');
    const apparatus = state.apparatus.find(row => row.apparatus_id === body?.apparatus_id);
    if (!apparatus || apparatus.lifecycle.state !== 'active' || !str(body.id) || !str(body.reason) || !integer(body.starts_at_unix, 1) || !integer(body.ends_at_unix, body.starts_at_unix + 1) || typeof body.active !== 'boolean') return error(400, 'invalid_downtime');
    const row = { ...clone(body), apparatus: apparatus.display.display_name, actor: clone(profile) }, index = state.downtime.findIndex(row => row.id === body.id);
    if (index >= 0) state.downtime[index] = row; else state.downtime.push(row);
    bump(); return response({ ok: true, downtime: clone(row) });
  }
  if (path === `${pm}/schedule/cancel` && method === 'POST') {
    if (!manage()) return error(403, 'forbidden');
    const row = state.reservations.find(row => row.reservation_id === body?.reservation_id);
    if (!row) return error(404, 'schedule_reservation_not_found');
    if (row.status !== 'planned') return error(409, 'schedule_reservation_locked');
    row.status = 'cancelled'; if (str(body.reason)) row.reason += `; cancelled: ${str(body.reason)}`; row.actor = clone(profile); bump(); return response({ ok: true, reservation: clone(row) });
  }
  if (path === `${pm}/schedule` && method === 'POST') {
    if (!manage()) return error(403, 'forbidden');
    const prior = state.reservations.find(row => row.idempotency_key === body?.idempotency_key);
    if (prior) return prior.order_id === body.order_id && prior.apparatus_id === body.apparatus_id ? response({ ok: true, reservation: clone(prior), conflicts: [] }) : error(409, 'schedule_idempotency_conflict');
    const order = findOrder(body?.order_id), row = state.apparatus.find(row => row.apparatus_id === body?.apparatus_id);
    if (!active(order) || !row || row.lifecycle.state !== 'active' || !stages(order).some(node => node.apparatus_id === row.apparatus_id)) return error(409, 'capacity_unavailable');
    if (!str(body.idempotency_key) || !integer(body.duration_minutes, 1, 43200) || !integer(body.earliest_start_unix, 1) || !integer(body.latest_end_unix, body.earliest_start_unix + 1) || body.latest_end_unix - body.earliest_start_unix > 32 * 86400 || !integer(body.priority, -2147483648, 2147483647) || !Array.isArray(body.candidate_apparatuses) || body.candidate_apparatuses.length || !Array.isArray(body.capability_requirements)) return error(400, 'schedule_input_invalid');
    if (body.capability_requirements.some(item => !integer(item.min_level, 1, 100) || (row.capabilities[item.code] || 0) < item.min_level)) return error(409, 'capability_level_insufficient');
    const capacity = state.planning[row.apparatus_id].capacity, reserved = Math.ceil(body.duration_minutes * 100 / capacity.efficiency_percent) + capacity.setup_minutes + capacity.cleanup_minutes;
    let start = Math.ceil(body.earliest_start_unix / 60) * 60, found = false;
    for (; start + reserved * 60 <= body.latest_end_unix; start += 60) {
      const end = start + reserved * 60, date = new Date(start * 1000), minute = date.getUTCHours() * 60 + date.getUTCMinutes(), day = date.getUTCDay() || 7;
      if (capacity.availability.mode === 'scheduled' && !capacity.availability.working_windows.some(window => window.weekday === day && minute >= window.start_minute && minute + reserved <= window.end_minute)) continue;
      if (state.downtime.some(item => item.apparatus_id === row.apparatus_id && item.active && item.starts_at_unix < end && item.ends_at_unix > start)) continue;
      if (capacity.finite_capacity && state.reservations.filter(item => item.apparatus_id === row.apparatus_id && ['planned', 'active', 'paused'].includes(item.status) && item.starts_at_unix < end && item.ends_at_unix > start).length >= capacity.capacity_slots) continue;
      found = true; break;
    }
    if (!found) return error(409, 'capacity_no_working_window');
    const reservation = { reservation_id: `apparatus-reservation:${body.idempotency_key}`, idempotency_key: body.idempotency_key, order_id: order.map.id, apparatus_id: row.apparatus_id, apparatus: row.display.display_name, starts_at_unix: start, ends_at_unix: start + reserved * 60, requested_duration_minutes: body.duration_minutes, reserved_duration_minutes: reserved, status: 'planned', priority: body.priority, source: body.source, reason: str(body.reason), capability_requirements: clone(body.capability_requirements), actor: clone(profile), created_at_unix: now(state) };
    state.reservations.push(reservation); bump(); return response({ ok: true, reservation: clone(reservation), conflicts: [] });
  }
  return undefined;
}
