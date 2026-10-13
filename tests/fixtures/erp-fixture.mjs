import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSeed, fixtureCapabilities, fixtureLogin, fixtureToken } from './erp-seed.mjs';
import { updateFixtureApparatusHash, workflowRoute } from './erp-workflows.mjs';

const base = '/v1/mobile/admin';
const clone = value => structuredClone(value);
const stableJson = value => JSON.stringify(value, (_key, entry) => object(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const equal = (a, b) => stableJson(a) === stableJson(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value.trim() : '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator', legal_name: 'QA Synthetic' };
const response = (body, status = 200) => ({ status, body });
const error = (status, code, detail) => response({ error: code, ...(detail ? { detail } : {}) }, status);
const capabilityLabels = Object.fromEntries(fixtureCapabilities.map(code => [code, `QA ${code}`]));
const configDefaults = () => ({ capabilities: [...fixtureCapabilities], rules: [], partialMoveCodes: [], orderEditLocked: false, workerDeleteBlocked: false, emptyProduction: false, unknownOrderStatuses: [], blockedDeleteCodes: [], emptyClosedHistory: false, manufacturingReportMode: 'partial' });
const queueVersion = ids => createHash('sha256').update(JSON.stringify(ids)).digest('hex');
const fixtureVersion = 4;
const phone = value => { let digits = string(value).replace(/\D/g, ''); if (digits.length === 9) digits = `998${digits}`; return digits ? `+${digits}` : ''; };

/** Request logs intentionally omit authorization values, phones, login codes and rotated codes. */
export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /token|authorization|password|secret|phone|(^|_)code$|credential/i.test(key) ? '[redacted]' : sanitize(entry)]));
}

function page(rows, query, search = true) {
  let result = rows;
  const q = string(query.q).toLowerCase();
  if (search && q) result = result.filter(row => JSON.stringify(row).toLowerCase().includes(q));
  const offset = Math.max(0, Number(query.offset) || 0), limit = Math.max(1, Math.min(500, Number(query.limit) || 50));
  return clone(result.slice(offset, offset + limit));
}
function compile(map) {
  return { map: clone(map), program: { map_id: map.id, product_code: map.product_code,
    operations: map.nodes.map((node, index) => ({ order: index + 1, node_id: node.id, op_code: node.kind, args: { title: node.title, ...(node.apparatus_id ? { apparatus_id: node.apparatus_id } : {}) } })) } };
}
function normalize(map) {
  const next = clone(map);
  next.id = string(next.id).toLowerCase();
  next.product_code = string(next.product_code); next.title = string(next.title);
  next.nodes = next.nodes.map(node => ({ ...node, id: string(node.id).toLowerCase(), title: string(node.title), x: Number.isFinite(node.x) ? node.x : 0, y: Number.isFinite(node.y) ? node.y : 0 }));
  next.edges = next.edges.map(edge => ({ ...edge, from: string(edge.from).toLowerCase(), to: string(edge.to).toLowerCase(), ...(edge.branch ? { branch: string(edge.branch).toLowerCase() } : {}) }));
  return next;
}
function validMap(map, apparatus) {
  if (!object(map) || !string(map.id) || !string(map.product_code) || !string(map.title) || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) return false;
  const ids = new Set(map.nodes.map(node => node.id));
  return map.nodes.filter(node => node.kind === 'start').length === 1 && map.nodes.filter(node => node.kind === 'end').length === 1 && ids.size === map.nodes.length
    && map.nodes.every(node => string(node.id) && string(node.title) && (node.kind !== 'apparatus' || apparatus.some(row => row.apparatus_id === node.apparatus_id)))
    && map.edges.every(edge => ids.has(edge.from) && ids.has(edge.to));
}
const effectiveApparatus = node => node.alternative_assigned_apparatus_id || node.apparatus_id;
function nativeNodeDefaults(node) {
  if (!node) return null;
  const next = clone(node);
  for (const key of ['apparatus_id', 'role_code', 'item_code', 'qty_formula', 'from_location', 'to_location', 'alternative_group_id', 'alternative_group_label', 'alternative_assigned_title', 'alternative_assigned_apparatus_id']) next[key] ??= '';
  next.formula ??= null; next.rezka_kadr_count ??= null; next.rezka_frame_groups ??= []; next.rezka_label_length ??= null; next.x ??= 0; next.y ??= 0;
  return next;
}

function snapshot(state) {
  const maps = state.orders.map(order => compile(order.map));
  const stage_states = Object.fromEntries(state.orders.map(order => [order.map.id, clone(order.stages)]));
  const order_controls = Object.fromEntries(state.orders.map(order => [order.map.id, { state: order.control, ...(order.earlyClose ? { early_close: order.earlyClose } : {}) }]));
  const sequences = {}, queue_states = {}, queue_action_controls = {}, visible_order_ids = {};
  for (const apparatus of state.apparatus) {
    const id = apparatus.apparatus_id;
    const orders = state.orders.filter(order => order.map.nodes.some(node => node.kind === 'apparatus' && effectiveApparatus(node) === id));
    sequences[id] = state.sequenceOverrides[id] || orders.map(order => order.map.id);
    queue_states[id] = {};
    queue_action_controls[id] = {};
    visible_order_ids[id] = [];
    for (const order of orders) {
      const node = order.map.nodes.find(node => node.kind === 'apparatus' && effectiveApparatus(node) === id);
      const apparatusNodes = order.map.nodes.filter(candidate => candidate.kind === 'apparatus');
      const previousNode = apparatusNodes[apparatusNodes.indexOf(node) - 1];
      const previousReady = !previousNode || order.stages[previousNode.id] === 'completed';
      const native = order.stages[node.id] || 'pending', status = order.control === 'frozen' ? 'frozen' : native;
      queue_states[id][order.map.id] = status;
      if (native !== 'completed') visible_order_ids[id].push(order.map.id);
      const mode = status === 'pending' ? previousReady ? 'fresh_start_blocked' : 'waiting_previous_stage' : status;
      queue_action_controls[id][order.map.id] = { state: status, stage_node_id: node.id, allowed_actions: status === 'in_progress' ? ['pause'] : status === 'paused' ? ['resume'] : [],
        previous_stage_ready: previousReady, complete_requires_full_report: false,
        ...(previousNode ? { previous_stage: effectiveApparatus(previousNode) } : {}),
        ...(node.id === 'cut' ? { rezka_output_kadr_counts: node.rezka_frame_groups || [1, 1] } : {}),
        interaction: { mode, start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: true, material_intake_allowed: false,
          previous_wip_mode: mode === 'waiting_previous_stage' ? 'waiting' : 'not_required', qolip_mode: 'not_required', resume_input_required: false,
          ...(status === 'pending' ? { blocking_reason_code: previousReady ? 'waiting_sequence' : 'waiting_previous_stage' } : {}) } };
    }
  }
  const order_statuses = Object.fromEntries(state.orders.map(order => {
    const stages = Object.values(order.stages);
    const status = order.control === 'frozen' ? 'frozen' : stages.includes('in_progress') ? 'in_progress' : stages.includes('paused') ? 'paused' : stages.length && stages.every(value => value === 'completed') ? 'completed' : 'not_started';
    return [order.map.id, { lifecycle_status: status === 'not_started' ? 'released' : 'in_progress', order_status: status, work_status: status, flow_status: status === 'not_started' ? 'waiting' : status, completed_with_issue_count: 0 }];
  }));
  return { ok: true, rev: state.rev, epoch: state.epoch, scope: '', maps, stage_states, queue_states, sequences, visible_order_ids,
    sequence_versions: Object.fromEntries(Object.entries(sequences).map(([id, ids]) => [id, queueVersion(ids)])),
    sequence_revisions: Object.fromEntries(Object.keys(sequences).map(id => [id, state.rev])),
    queue_action_controls, order_controls, order_statuses, order_customers: Object.fromEntries(state.orders.map(order => [order.map.id, order.map.customer_name])), frozen_orders_by_apparatus: {} };
}

export function createFixture() {
  let resetCount = 1, state = createSeed(), config = configDefaults(), logs = [], sequence = 0;
  const idempotency = new Map();
  const bump = () => { state.rev += 1; };
  const requires = (...codes) => codes.some(code => config.capabilities.includes(code));
  const findOrder = id => state.orders.find(order => order.map.id === string(id).toLowerCase());
  const publicState = () => {
    const { sessions: _sessions, ...data } = state;
    return { synthetic: true, state: clone(data), config: clone(config), authenticatedSessions: state.sessions.size };
  };
  const detail = (kind, row) => {
    if (!row) return error(404, 'not_found');
    if (kind === 'items') return response({ ...clone(row), customers: state.customers.filter(party => party.assigned_item_codes.includes(row.code)).map(party => ({ ref: party.ref, name: party.name, phone: party.phone })) });
    return response({ ...clone(row), avatar_url: '', code_locked: row.code_locked || false, code_retry_after_sec: row.code_retry_after_sec || 0,
      assigned_items: state.items.filter(item => (row.assigned_item_codes || []).includes(item.code)), assigned_item_count: (row.assigned_item_codes || []).length });
  };

  function control(method, path, body) {
    if (path === '/__qa/health' && method === 'GET') return response({ ok: true, synthetic: true, fixtureVersion, epoch: state.epoch });
    if (path === '/__qa/log' && method === 'GET') return response({ synthetic: true, requests: clone(logs) });
    if (path === '/__qa/state' && method === 'GET') return response(publicState());
    if (path === '/__qa/reset' && method === 'POST') {
      state = createSeed(`qa-local-epoch-${++resetCount}`); config = configDefaults(); logs = []; sequence = 0; idempotency.clear();
      if (object(body) && Array.isArray(body.capabilities)) config.capabilities = body.capabilities.filter(value => typeof value === 'string');
      return response({ ok: true, synthetic: true, epoch: state.epoch });
    }
    if (path === '/__qa/config' && method === 'POST') {
      if (!object(body)) return error(400, 'invalid_fixture_config');
      const known = new Set(Object.keys(configDefaults()));
      if (Object.keys(body).some(key => !known.has(key))) return error(400, 'unknown_fixture_config_field');
      if (body.capabilities && (!Array.isArray(body.capabilities) || body.capabilities.some(value => typeof value !== 'string'))) return error(400, 'invalid_fixture_capabilities');
      if (body.partialMoveCodes && (!Array.isArray(body.partialMoveCodes) || body.partialMoveCodes.some(value => typeof value !== 'string'))) return error(400, 'invalid_fixture_partial_move_codes');
      if (body.manufacturingReportMode !== undefined && !['partial', 'complete', 'wrong_identity'].includes(body.manufacturingReportMode)) return error(400, 'invalid_fixture_report_mode');
      if (body.rules && (!Array.isArray(body.rules) || body.rules.some(rule => !object(rule) || !string(rule.path).startsWith('/v1/') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(rule.method)
        || rule.delayMs !== undefined && (!Number.isFinite(rule.delayMs) || rule.delayMs < 0 || rule.delayMs > 30_000)
        || rule.status !== undefined && ![400, 401, 403, 404, 409, 429, 500, 502, 503].includes(rule.status)))) return error(400, 'invalid_fixture_rule');
      config = { ...config, ...clone(body) };
      return response({ ok: true, config: clone(config) });
    }
    if (path === '/__qa/order' && method === 'POST') {
      const order = findOrder(body?.id);
      if (!order) return error(404, 'map_not_found');
      if (object(body.mapPatch)) Object.assign(order.map, clone(body.mapPatch));
      if (object(body.nodePatch)) {
        const node = order.map.nodes.find(node => node.id === body.nodePatch.id);
        if (!node) return error(404, 'node_not_found');
        Object.assign(node, clone(body.nodePatch));
      }
      if (object(body.stageStates)) Object.assign(order.stages, clone(body.stageStates));
      if (object(body.templatePatch)) { Object.assign(order.template, clone(body.templatePatch)); order.calculationRevision += 1; }
      if (typeof body.control === 'string') order.control = body.control;
      bump(); return response({ ok: true, saved: compile(order.map), rev: state.rev });
    }
    if (path === '/__qa/apparatus' && method === 'POST') {
      const row = state.apparatus.find(row => row.apparatus_id === body?.apparatus_id);
      if (!row) return error(404, 'apparatus_not_found');
      if (Object.hasOwn(body, 'placement')) row.placement = clone(body.placement);
      row.source_revision += 1; updateFixtureApparatusHash(row, state.planning[row.apparatus_id]); bump(); return response(row);
    }
    if (path === '/__qa/opening-wip' && method === 'POST') {
      const record = state.openingWip.find(record => record.batches.some(batch => batch.batch_id === body?.batch_id)), batch = record?.batches.find(batch => batch.batch_id === body.batch_id);
      if (!batch) return error(404, 'opening_wip_not_found');
      if (object(body.batchPatch)) Object.assign(batch, clone(body.batchPatch));
      if (object(body.intakePatch)) Object.assign(record.intake, clone(body.intakePatch));
      batch.updated_at_unix += 1; record.intake.updated_at_unix += 1; bump(); return response({ ok: true });
    }
    if (path === '/__qa/wip' && method === 'POST') {
      const batch = state.wip.find(row => row.batch_id === body?.batch_id);
      if (!batch) return error(404, 'wip_not_found');
      if (object(body.batchPatch)) Object.assign(batch, clone(body.batchPatch));
      bump(); return response({ ok: true });
    }
    if (path === '/__qa/dependencies' && method === 'POST') {
      if (!state.workers.some(worker => worker.id === body?.worker_id)) return error(404, 'worker_not_found');
      state.dependencies[body.worker_id] = { active_work: clone(body.active_work || []), connections: clone(body.connections || []) };
      return response({ ok: true });
    }
    return error(404, 'fixture_control_not_found');
  }

  function route(method, path, query, body, headers) {
    if (path === '/v1/mobile/auth/login' && method === 'POST') {
      if (body?.phone !== fixtureLogin.phone || body?.code !== fixtureLogin.code) return error(401, 'invalid_credentials');
      state.sessions.add(fixtureToken);
      return response({ token: fixtureToken, profile, capabilities: [...config.capabilities], assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] });
    }
    const token = string(headers.authorization).replace(/^Bearer\s+/i, '');
    if (!state.sessions.has(token)) return error(401, 'unauthorized');
    if (path === '/v1/mobile/me' && method === 'GET') return response(profile);
    if (path === '/v1/mobile/auth/logout' && method === 'POST') { state.sessions.delete(token); return response({ ok: true }); }
    const workflow = workflowRoute({ method, path, query, body, headers, state, config, requires, compile, bump, findOrder, profile, equal });
    if (workflow) return workflow;
    if (path === `${base}/production-maps/sequence` && method === 'GET') {
      if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.read')) return error(403, 'forbidden');
      const current = snapshot(state);
      for (const id of config.unknownOrderStatuses) if (current.order_statuses[id]) { current.order_statuses[id].order_status = 'unknown'; current.order_statuses[id].work_status = 'unknown'; }
      if (config.emptyProduction) { current.maps = []; current.order_statuses = {}; current.order_customers = {}; current.sequences = {}; current.visible_order_ids = {}; current.queue_states = {}; current.stage_states = {}; current.queue_action_controls = {}; current.order_controls = {}; }
      return response(current);
    }
    if (path === `${base}/production-maps/sequence` && method === 'POST') {
      if (!requires('admin.access', 'production.map.manage')) return error(403, 'forbidden');
      const current = snapshot(state), ids = current.sequences[body?.apparatus];
      if (!ids || !ids.includes(body.order_id) || !string(body.idempotency_key)) return error(400, 'queue_reorder_invalid');
      const receiptKey = `sequence:${body.idempotency_key}`, payload = stableJson(body), prior = idempotency.get(receiptKey);
      if (prior) return prior.payload === payload ? response(prior.saved) : error(409, 'queue_reorder_idempotency_conflict');
      if (body.expected_version !== current.sequence_versions[body.apparatus]) return error(409, 'queue_reorder_conflict');
      if (current.queue_states[body.apparatus][body.order_id] !== 'pending') return error(409, 'queue_reorder_blocked');
      const next = ids.filter(id => id !== body.order_id), anchor = body.before_order_id || body.after_order_id, index = next.indexOf(anchor);
      if (index < 0) return error(400, 'queue_reorder_invalid');
      next.splice(index + (body.after_order_id ? 1 : 0), 0, body.order_id); state.sequenceOverrides[body.apparatus] = next; bump();
      const result = { ok: true, order_ids: next, version: queueVersion(next), adjusted: false, epoch: state.epoch, revision: state.rev };
      idempotency.set(receiptKey, { payload, saved: clone(result) }); return response(result);
    }
    if (path === `${base}/production-maps/order-control` && method === 'POST') {
      if (!requires('admin.access', 'production.map.manage')) return error(403, 'forbidden');
      const order = findOrder(body?.order_id);
      if (!order) return error(404, 'map_not_found');
      if (['freeze', 'close_early'].includes(body.action)) order.control = 'frozen';
      else if (['cancel_freeze', 'unfreeze'].includes(body.action)) order.control = 'active';
      else return error(400, 'order_control_action_invalid');
      if (body.action === 'close_early') order.earlyClose = { comment: body.comment, requested_at_unix: 1791892800, closed_at_unix: null };
      bump(); return response({ ok: true, control: { order_id: order.map.id, state: order.control, ...(order.earlyClose ? { early_close: order.earlyClose } : {}) }, rev: state.rev, epoch: state.epoch });
    }
    if (path === `${base}/production-maps/queue-action` && method === 'POST') {
      if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.manage')) return error(403, 'forbidden');
      const order = findOrder(body?.order_id), node = order?.map.nodes.find(node => node.kind === 'apparatus' && effectiveApparatus(node) === body.apparatus);
      if (!node) return error(404, 'map_not_found');
      if (order.control !== 'active' || !(body.action === 'pause' && order.stages[node.id] === 'in_progress' || body.action === 'resume' && order.stages[node.id] === 'paused')) return error(409, 'queue_action_not_allowed');
      order.stages[node.id] = body.action === 'pause' ? 'paused' : 'in_progress'; bump();
      const result = { ok: true, states: { [order.map.id]: order.stages[node.id] }, rev: state.rev, epoch: state.epoch, order_status: snapshot(state).order_statuses[order.map.id] };
      if (body.action === 'pause') {
        result.progress_batch = { batch_id: `qa-pause-${state.rev}`, order_id: order.map.id, apparatus: body.apparatus, action: 'pause', produced_qty: body.produced_qty || 1, uom: body.uom || 'm', wip_status: 'waiting', status: 'completed', current_apparatus: body.apparatus, current_location: 'QA Bosma sexi', label_item_code: order.map.product_code, label_item_name: order.map.title };
        state.wip.push(clone(result.progress_batch));
      }
      return response(result);
    }
    if (path === `${base}/production-maps`) {
      if (method === 'GET') {
        if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access')) return error(403, 'forbidden');
        const order = findOrder(query.id);
        return query.id ? order ? response(compile(order.map)) : error(404, 'map_not_found') : response(state.orders.map(order => compile(order.map)));
      }
      if (method === 'PUT') {
        if (!requires('admin.access', 'production.map.manage')) return error(403, 'forbidden');
        if (!validMap(body, state.apparatus)) return error(400, 'invalid_production_map');
        const order = findOrder(body.id);
        if (!order) return error(400, 'new_order_requires_calculation');
        const next = normalize(body);
        if (['product_code', 'title', 'customer_name', 'roll_count', 'width_mm', 'print_val_size_mm', 'order_kg', 'base_length', 'code', 'order_number'].some(key => (next[key] ?? null) !== (order.map[key] ?? null))) return error(409, 'production_map_opened_order_calculation_locked');
        const started = new Set(order.map.nodes.filter(node => node.kind === 'apparatus' && (order.stages[node.id] || 'pending') !== 'pending').map(effectiveApparatus));
        const locked = new Set(order.map.nodes.filter(node => node.kind === 'apparatus' && started.has(effectiveApparatus(node))).map(node => node.id));
        const groups = new Set(order.map.nodes.filter(node => locked.has(node.id)).map(node => node.alternative_group_id).filter(Boolean));
        for (const node of order.map.nodes) if (groups.has(node.alternative_group_id)) locked.add(node.id);
        const incoming = map => map.edges.filter(edge => locked.has(edge.to)).map(edge => ({ ...edge, branch: edge.branch || '' })).map(stableJson).sort();
        if ([...locked].some(id => !equal(nativeNodeDefaults(order.map.nodes.find(node => node.id === id)), nativeNodeDefaults(next.nodes.find(node => node.id === id))))
          || !equal(incoming(order.map), incoming(next))) return error(409, 'production_map_started_stage_locked');
        order.map = next;
        for (const node of next.nodes.filter(node => node.kind === 'apparatus')) order.stages[node.id] ??= 'pending';
        bump(); return response(compile(next));
      }
      return error(405, 'method_not_allowed');
    }
    if (path === `${base}/production-maps/order-edit`) {
      if (!requires('admin.access', 'production.map.manage')) return error(403, 'forbidden');
      const order = findOrder(query.id);
      if (!order) return error(404, 'map_not_found');
      if (config.orderEditLocked || Object.values(order.stages).some(value => value !== 'pending')) return error(409, 'Buyurtmada harakat bor');
      const source = () => ({ map: clone(order.map), template: clone(order.template), revision: order.calculationRevision });
      if (method === 'GET') return response(source());
      if (method === 'PUT') {
        if (!equal(body?.original, source())) return error(409, 'order_edit_conflict');
        if (!object(body.template)) return error(400, 'invalid_template');
        order.template = { ...clone(body.template), id: order.template.id, source_map_id: order.map.id, code: order.map.code, order_number: order.map.order_number };
        order.map.order_kg = body.template.kg; order.map.title = body.template.product; order.map.customer_name = body.template.customer;
        order.calculationRevision += 1; bump(); return response(source());
      }
      return error(405, 'method_not_allowed');
    }
    if (path.startsWith(`${base}/apparatus/`)) {
      if (!requires('admin.access', 'production.map.manage')) return error(403, 'forbidden');
      const row = state.apparatus.find(row => row.apparatus_id === path.slice(`${base}/apparatus/`.length));
      if (!row) return error(404, 'apparatus_not_found');
      if (method === 'GET') return response(row);
      if (method === 'PATCH') {
        const key = headers['idempotency-key'];
        if (!key) return error(400, 'idempotency_key_required');
        const prior = idempotency.get(key), payload = JSON.stringify(body);
        if (prior) return prior.payload === payload ? response(clone(prior.saved)) : error(409, 'apparatus_idempotency_conflict');
        if (body?.expected_revision !== row.source_revision) return error(409, 'apparatus_revision_conflict');
        if (!object(body.patch) || !Object.hasOwn(body.patch, 'placement')) return error(400, 'placement_patch_required');
        const target = body.patch.placement?.factory_map_object_id;
        if (target && state.apparatus.some(other => other !== row && other.placement?.factory_map_object_id === target)) return error(409, 'apparatus_placement_conflict');
        row.placement = body.patch.placement === null ? null : clone(body.patch.placement); row.source_revision += 1; updateFixtureApparatusHash(row, state.planning[row.apparatus_id]); bump();
        idempotency.set(key, { payload, saved: clone(row) }); return response(row);
      }
      return error(405, 'method_not_allowed');
    }
    if (path === `${base}/apparatus` && method === 'GET') return requires('admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign') ? response(page(state.apparatus, query)) : error(403, 'forbidden');
    if (path === `${base}/items/uoms` && method === 'GET') return response(['kg', 'dona', 'metr']);
    if (path === `${base}/items/bulk-move-group` && method === 'POST') {
      if (!requires('catalog.item.bulk_move')) return error(403, 'forbidden');
      if (!Array.isArray(body?.item_codes) || !state.groups.some(group => group.name === body.item_group)) return error(400, 'invalid_item_group_move');
      const updated = [], failed = [];
      for (const code of body.item_codes) {
        const item = state.items.find(row => row.code === code);
        if (!item || config.partialMoveCodes.includes(code)) failed.push(code);
        else { item.item_group = body.item_group; updated.push(code); }
      }
      return response({ item_group: body.item_group, requested_count: body.item_codes.length, updated_count: updated.length, failed_count: failed.length, updated_item_codes: updated, failed_item_codes: failed });
    }
    if (path === `${base}/items/detail`) {
      if (!requires(method === 'GET' ? 'catalog.item.read' : 'admin.access')) return error(403, 'forbidden');
      const row = state.items.find(row => row.code === (method === 'PUT' ? body?.original_code : query.code));
      if (!row) return error(404, 'item_not_found');
      if (method === 'GET') return detail('items', row);
      if (method === 'PUT') {
        if (!string(body.code) || !string(body.name)) return error(400, 'invalid_item');
        if (state.items.some(other => other !== row && other.code === body.code)) return error(409, 'duplicate_item_code');
        const oldCode = row.code; row.code = body.code; row.name = body.name;
        for (const party of [...state.customers, ...state.suppliers]) party.assigned_item_codes = party.assigned_item_codes.map(code => code === oldCode ? row.code : code);
        return detail('items', row);
      }
      if (method === 'DELETE') { if (config.blockedDeleteCodes.includes(row.code)) return error(409, 'item_delete_blocked'); state.items = state.items.filter(item => item !== row); return response({ ok: true }); }
    }
    if (path === `${base}/items`) {
      if (method === 'GET') {
        if (!requires('catalog.item.read', 'gscale.catalog.read')) return error(403, 'forbidden');
        return response(page(state.items.filter(row => !query.group || row.item_group === query.group), query));
      }
      if (method === 'POST') {
        if (!requires('catalog.item.create')) return error(403, 'forbidden');
        if (!string(body?.code) || !string(body.name) || !string(body.uom)) return error(400, 'invalid_item');
        if (state.items.some(row => row.code === body.code)) return error(409, 'duplicate_item_code');
        const row = { ...clone(body), item_group: body.item_group || 'Xomashyo' }; state.items.push(row); return detail('items', row);
      }
    }
    if (path === `${base}/item-groups/tree` && method === 'GET') return requires('catalog.item_group.read', 'gscale.catalog.read') ? response(clone(state.groups)) : error(403, 'forbidden');
    if (path === `${base}/item-groups`) {
      if (!requires('catalog.item_group.manage')) return error(403, 'forbidden');
      if (method === 'POST') {
        if (!string(body?.name) || state.groups.some(row => row.name === body.name)) return error(409, 'duplicate_group');
        const row = { name: body.name, item_group_name: body.name, parent_item_group: body.parent || '', is_group: body.is_group === true }; state.groups.push(row); return response(row);
      }
      if (method === 'PUT') {
        const row = state.groups.find(row => row.name === body?.name);
        if (!row) return error(404, 'group_not_found');
        if (body.parent === row.name) return error(400, 'item_group_cycle');
        row.parent_item_group = body.parent || 'All Item Groups'; return response(row);
      }
    }
    const partyMatch = path.match(/^\/v1\/mobile\/admin\/(customers|suppliers)(?:\/(.*))?$/);
    if (partyMatch) {
      const [, kind, action = ''] = partyMatch, capability = kind === 'customers' ? 'customer' : 'supplier';
      const code = action === 'code/regenerate' ? 'code.manage' : action.startsWith('items/') ? 'item.assign' : method === 'GET' ? 'read' : 'manage';
      if (!requires(`party.${capability}.${code}`)) return error(403, 'forbidden');
      const rows = state[kind], row = rows.find(row => row.ref === query.ref);
      if (action === 'inactive' && method === 'GET' && kind === 'suppliers') return response(rows.filter(row => row.removed));
      if (action === 'list' && method === 'GET') return response(page(rows.filter(row => kind !== 'suppliers' || !row.removed).map(row => ({ ...row, assigned_item_count: row.assigned_item_codes.length })), query, false));
      if (!action && method === 'POST') {
        if (!string(body?.name)) return error(400, 'invalid_party');
        const next = { ref: `QA-${capability.toUpperCase()}-${state.nextId++}`, name: body.name, phone: phone(body.phone), assigned_item_codes: [], blocked: false, removed: false };
        rows.push(next); return detail(kind, next);
      }
      if (!row) return error(404, 'party_not_found');
      if (action === 'detail' && method === 'GET') return detail(kind, row);
      if (action === 'phone' && method === 'PUT') { row.phone = phone(body?.phone); return detail(kind, row); }
      if (action === 'items/add' && method === 'POST') {
        if (!state.items.some(item => item.code === body?.item_code)) return error(404, 'item_not_found');
        row.assigned_item_codes = [...new Set([...row.assigned_item_codes, body.item_code])]; return detail(kind, row);
      }
      if (action === 'items/remove' && method === 'DELETE') { row.assigned_item_codes = row.assigned_item_codes.filter(code => code !== query.item_code); return detail(kind, row); }
      if (action === 'status' && method === 'PUT' && kind === 'suppliers') { row.blocked = body?.blocked === true; return detail(kind, row); }
      if (action === 'remove' && method === 'DELETE') { row.removed = true; return response({ ok: true }); }
      if (action === 'restore' && method === 'POST' && kind === 'suppliers') { row.removed = false; return detail(kind, row); }
      if (action === 'code/regenerate' && method === 'POST') return response({ ...detail(kind, row).body, code: `QA-ROTATED-${++state.codeCounter}` });
      return error(405, 'method_not_allowed');
    }
    if (path === `${base}/warehouses/summary` && method === 'GET') return response(page(state.warehouses.map(row => ({ ...row, assignment_count: state.warehouseAssignments.filter(assignment => assignment.warehouse === row.warehouse).length, assigned_display_names: state.warehouseAssignments.filter(assignment => assignment.warehouse === row.warehouse).map(row => row.display_name) })), query));
    if (path === `${base}/warehouses/assignments`) {
      if (!requires(method === 'GET' ? 'catalog.item.read' : 'admin.access')) return error(403, 'forbidden');
      if (method === 'GET') return response(state.warehouseAssignments);
      if (method === 'POST') { state.warehouseAssignments.push(clone(body)); return response(body); }
      if (method === 'DELETE') {
        const index = state.warehouseAssignments.findIndex(row => row.principal_role === body?.principal_role && row.principal_ref === body.principal_ref && row.assignment_kind === body.assignment_kind && (body.assignment_kind === 'apparatus' ? row.apparatus_id === body.apparatus_id : row.warehouse === body.warehouse));
        if (index < 0) return error(404, 'assignment_not_found');
        const [assignment] = state.warehouseAssignments.splice(index, 1); return response({ ok: true, assignment });
      }
    }
    if (path === `${base}/warehouses`) {
      if (method === 'GET') return requires('admin.access', 'production.map.manage', 'catalog.item.read') ? response(page(state.warehouses, query)) : error(403, 'forbidden');
      if (method === 'POST') {
        if (!requires('production.map.manage')) return error(403, 'forbidden');
        if (!string(body?.warehouse)) return error(400, 'warehouse_required');
        let row = state.warehouses.find(row => row.warehouse === body.warehouse);
        if (!row) { row = { product_count: 0, reserved_count: 0 }; state.warehouses.push(row); }
        Object.assign(row, clone(body)); return response(row);
      }
      if (method === 'DELETE') {
        if (!requires('admin.access')) return error(403, 'forbidden');
        const row = state.warehouses.find(row => row.warehouse === body?.warehouse);
        if (!row) return error(404, 'warehouse_not_found');
        if (row.product_count > 0 && body.delete_products !== true) return error(409, 'warehouse_not_empty');
        const deletedAssignmentCount = state.warehouseAssignments.filter(assignment => assignment.warehouse === row.warehouse).length;
        state.warehouseAssignments = state.warehouseAssignments.filter(assignment => assignment.warehouse !== row.warehouse);
        state.warehouses = state.warehouses.filter(other => other !== row);
        return response({ warehouse: row.warehouse, deleted_product_count: body.delete_products === true ? row.product_count : 0, deleted_assignment_count: deletedAssignmentCount });
      }
    }
    const identityMatch = path.match(/^\/v1\/mobile\/admin\/(workers|system-users|material-taminotchilar)(?:\/(.*))?$/);
    if (identityMatch) {
      const [, kind, action = ''] = identityMatch;
      const data = kind === 'workers' ? state.workers : kind === 'system-users' ? state.systemUsers : state.materialUsers;
      const ref = kind === 'material-taminotchilar' ? query.ref : query.id || body?.id;
      const row = data.find(row => (row.id || row.ref) === ref);
      const permission = kind === 'material-taminotchilar' ? action === 'phone' ? 'party.customer.manage' : action === 'code/regenerate' ? 'party.customer.code.manage' : action === 'item-groups' ? 'admin.access' : 'party.customer.read' : 'admin.access';
      if (!requires(permission)) return error(403, 'forbidden');
      if (!action && method === 'GET') return response(page(data, query));
      if (!action && method === 'POST') {
        if (!string(body?.name) || !string(body.phone)) return error(400, 'invalid_identity');
        const next = { ...clone(body), id: `qa-${kind}-${state.nextId++}`, code_locked: false, code_retry_after_sec: 0 };
        if (kind === 'workers') next.level ||= 'Master';
        data.push(next); return response(next);
      }
      if (!row) return error(404, 'identity_not_found');
      if (action === 'detail' && method === 'GET') return detail(kind, row);
      if (action === 'delete-check' && method === 'GET' && kind === 'workers') {
        const dependency = state.dependencies[row.id] || { active_work: [], connections: [] };
        return response({ worker_id: row.id, worker_name: row.name, blocked: config.workerDeleteBlocked || dependency.active_work.length > 0,
          requires_confirmation: dependency.connections.length > 0, ...clone(dependency) });
      }
      if (!action && method === 'PUT') { for (const field of ['name', 'phone', 'level']) if (Object.hasOwn(body, field)) row[field] = body[field]; return detail(kind, row); }
      if (!action && method === 'DELETE' && kind === 'workers') {
        const dependency = state.dependencies[row.id] || { active_work: [], connections: [] };
        if (config.workerDeleteBlocked || dependency.active_work.length || dependency.connections.length && query.confirm_connections !== 'true') return error(409, 'worker_delete_blocked');
        row.blocked = true; state.roleAssignments = state.roleAssignments.filter(assignment => assignment.principal_ref !== row.id); state.warehouseAssignments = state.warehouseAssignments.filter(assignment => assignment.principal_ref !== row.id);
        state.dependencies[row.id] = { active_work: [], connections: [] }; return response({ ok: true });
      }
      if (action === 'phone' && method === 'PUT') { row.phone = body?.phone || ''; return detail(kind, row); }
      if (action === 'item-groups' && method === 'PUT') { row.assigned_item_groups = clone(body?.assigned_item_groups || []); return detail(kind, row); }
      if (action === 'code/regenerate' && method === 'POST') return response({ ...detail(kind, row).body, code: `QA-ROTATED-${++state.codeCounter}` });
      return error(405, 'method_not_allowed');
    }
    if (path === `${base}/capabilities` && method === 'GET') return requires('role.capability.read') ? response(fixtureCapabilities.map(code => ({ code, label: capabilityLabels[code], default_roles: ['admin'] }))) : error(403, 'forbidden');
    if (path === `${base}/roles`) {
      if (!requires(method === 'GET' ? 'role.capability.read' : 'role.capability.manage')) return error(403, 'forbidden');
      if (method === 'GET') return response(state.roles);
      if (method === 'PUT') {
        let row = state.roles.find(row => row.id === body?.id);
        if (row?.system) return error(409, 'system_role_protected');
        if (!string(body?.id) || !string(body.label) || !Array.isArray(body.capability_codes)) return error(400, 'invalid_role');
        if (body.capability_codes.some(code => !fixtureCapabilities.includes(code))) return error(400, 'invalid_capability');
        if (!row) { row = { id: body.id, base_role: null, system: false }; state.roles.push(row); }
        row.label = body.label; row.capability_codes = clone(body.capability_codes); return response(row);
      }
    }
    if (path === `${base}/role-assignments`) {
      if (!requires(method === 'GET' ? 'role.capability.read' : 'role.capability.manage')) return error(403, 'forbidden');
      if (method === 'GET') return response(state.roleAssignments);
      if (method === 'PUT') {
        if (!state.roles.some(row => row.id === body?.role_id)) return error(404, 'role_not_found');
        state.roleAssignments = state.roleAssignments.filter(row => row.principal_role !== body.principal_role || row.principal_ref !== body.principal_ref);
        state.roleAssignments.push(clone(body)); return response(body);
      }
    }
    if (path === `${base}/users/list` && method === 'GET') {
      if (!requires('party.customer.read') || !requires('party.supplier.read')) return error(403, 'forbidden');
      const users = [
        ...state.workers.map(row => ({ ...row, id: `worker:${row.id}`, entity_ref: row.id, source: 'worker', principal_role: 'aparatchi', role_label: row.level })),
        ...state.systemUsers.map(row => ({ ...row, entity_ref: row.id, source: 'system_user', principal_role: row.role, role_label: row.role })),
        ...state.materialUsers.map(row => ({ ...row, id: row.ref, entity_ref: row.ref, source: 'material_taminotchi', principal_role: 'material_taminotchi', role_label: 'Material mas’uli' })),
        ...state.customers.map(row => ({ ...row, id: `customer:${row.ref}`, entity_ref: row.ref, source: 'customer', principal_role: 'customer', role_label: 'Mijoz' })),
        ...state.suppliers.map(row => ({ ...row, id: `supplier:${row.ref}`, entity_ref: row.ref, source: 'supplier', principal_role: 'supplier', role_label: 'Ta’minotchi' })),
      ].map(row => ({ ...row, status: row.blocked ? 'blocked' : 'active', blocked: row.blocked || false }));
      const selected = users.filter(row => (!query.source || row.source === query.source) && (!query.principal_role || row.principal_role === query.principal_role));
      return response({ items: page(selected, query), has_more: (Number(query.offset) || 0) + (Number(query.limit) || 50) < selected.length });
    }
    if (path === `${base}/inventory/locations` && method === 'GET') return response(state.locations);
    if (path === `${base}/inventory/assets` && method === 'GET') return response(page(state.assets, query));
    if (path === `${base}/warehouses/items` && method === 'GET') return response(page(state.assets.filter(row => !query.warehouse || row.custody_warehouse === query.warehouse).map(row => ({ warehouse: row.custody_warehouse, code: row.item_code, name: row.item_name, item_group: 'Xomashyo', on_hand_qty: row.qty, package_count: 1, uom: row.uom, order_id: '' })), query));
    if (path === `${base}/warehouses/items/rolls` && method === 'GET') return response(page(state.assets.filter(row => row.item_code === query.item_code), query));
    const rawStock = () => state.assets.map(row => ({ id: row.asset_ref, barcode: row.identifier, warehouse: row.custody_warehouse, item_code: row.item_code, item_name: row.item_name, qty: row.qty, uom: row.uom, width_mm: 515, micron: row.item_code === 'QA-PE-50' ? 50 : 12, status: row.status, reserved_order_id: '' }));
    const rawLookup = stock => {
      const assignment = state.rawAssignments.find(row => row.barcode === stock.barcode) || null;
      const order = assignment ? findOrder(assignment.order_id) : null;
      return { ...stock, assignment: clone(assignment), order: order ? compile(order.map) : null, queue_states: order ? Object.fromEntries(order.map.nodes.filter(node => node.kind === 'apparatus').map(node => [effectiveApparatus(node), order.stages[node.id] || 'pending'])) : {}, logs: [] };
    };
    if (path === `${base}/raw-material-stock` && method === 'GET') return response(page(rawStock().filter(row => !query.warehouse || row.warehouse === query.warehouse), query));
    if (path === `${base}/raw-material-history` && method === 'GET') return response(state.rawHistory.filter(row => !query.warehouse || row.warehouse === query.warehouse).slice(0, 200));
    if (path.startsWith(`${base}/raw-material-assignments`)) {
      if (!requires('admin.access', 'production.map.manage', 'raw_material.assign', 'apparatus.queue.manage')) return error(403, 'forbidden');
      const action = path.slice(`${base}/raw-material-assignments`.length), stock = rawStock().find(row => row.barcode === (query.barcode || body?.barcode));
      if (!action && method === 'GET') return response(state.rawAssignments.filter(row => !query.order_id || row.order_id === query.order_id));
      if (action === '/candidates' && method === 'GET') return response(rawStock().filter(stock => !state.rawAssignments.some(assignment => assignment.barcode === stock.barcode)).map(stock => ({ ...stock, apparatus_options: [state.apparatus[0].apparatus_id] })));
      if (!stock) return error(404, 'raw_material_stock_unavailable');
      if (action === '/lookup' && method === 'GET') return response(rawLookup(stock));
      if (action === '/candidate-orders' && method === 'GET') return response(state.rawAssignments.some(row => row.barcode === stock.barcode) ? [] : state.orders.map(order => ({ order: compile(order.map), apparatus_options: [state.apparatus[0].apparatus_id] })));
      if (action === '/diagnostics' && method === 'GET') return response({ barcode: stock.barcode, order_id: query.order_id || '', apparatus: query.apparatus || '', compatible: !state.rawAssignments.some(row => row.barcode === stock.barcode), reason: 'compatible', warehouse: stock.warehouse, item_code: stock.item_code, stock_status: stock.status, reserved_order_id: stock.reserved_order_id, apparatus_options: [state.apparatus[0].apparatus_id], order_width_mm: 515, roll_width_mm: stock.width_mm, minimum_width_mm: 500, maximum_width_mm: 530 });
      if (!requires('raw_material.assign')) return error(403, 'forbidden');
      if (!action && method === 'POST') {
        if (!findOrder(body?.order_id) || !state.apparatus.some(row => row.apparatus_id === body.apparatus)) return error(400, 'raw_material_order_not_active');
        if (state.rawAssignments.some(row => row.barcode === stock.barcode)) return error(409, 'raw_material_already_assigned');
        const assignment = { order_id: body.order_id, barcode: stock.barcode, apparatus_id: body.apparatus, item_code: stock.item_code, item_name: stock.item_name, item_group: 'Xomashyo', assigned_at: '2026-10-13T12:00:00Z', assigned_by_display_name: 'QA Administrator', stock_status: stock.status, execution_status: 'ready', stock_warehouse: stock.warehouse, reserved_order_id: '', stock_qty: stock.qty, stock_uom: stock.uom, received_qty: 0, consumed_qty: 0, remaining_qty: stock.qty };
        state.rawAssignments.push(assignment); state.rawHistory.unshift({ event_id: `qa-raw-${state.rev}`, event_type: 'assigned', barcode: stock.barcode, warehouse: stock.warehouse, order_id: body.order_id, qty_delta: 0, uom: stock.uom, occurred_at_unix: 1791892800, actor_display_name: 'QA Administrator', stock_status_before: 'available', stock_status_after: 'available' }); bump(); return response(assignment);
      }
      if (!action && method === 'DELETE') {
        const assignment = state.rawAssignments.find(row => row.barcode === stock.barcode && row.order_id === body?.order_id);
        if (!assignment) return error(404, 'raw_material_assignment_not_found');
        if (assignment.execution_status === 'in_use' || assignment.consumed_qty > 0) return error(409, 'raw_material_assignment_locked');
        state.rawAssignments = state.rawAssignments.filter(row => row !== assignment); bump(); return response({ ok: true, assignment });
      }
      return error(405, 'method_not_allowed');
    }
    if (path === `${base}/production-maps/completed-orders` && method === 'GET') return response({ completed_orders: [] });
    if (path === `${base}/production-maps/completion-requests` && method === 'GET') return response({ completion_requests: [] });
    if (path === `${base}/activity` && method === 'GET') return response([]);
    if (path === `${base}/calculate-materials/sequence` && method === 'PUT') {
      if (!requires('admin.access')) return error(403, 'forbidden');
      const active = state.materials.filter(row => row.active), ids = body?.material_ids;
      if (!Array.isArray(ids) || ids.length !== active.length || new Set(ids).size !== active.length || ids.some(id => !active.some(row => row.id === id))) return error(400, 'invalid_material_sequence');
      state.materials = [...ids.map((id, index) => ({ ...state.materials.find(row => row.id === id), sort_order: index })), ...state.materials.filter(row => !row.active)]; return response({ ok: true, materials: state.materials });
    }
    if (path === `${base}/calculate-materials`) {
      if (!requires('admin.access', ...(method === 'GET' ? ['production.map.manage'] : []))) return error(403, 'forbidden');
      if (method === 'GET') return response({ ok: true, materials: state.materials });
      if (method === 'PUT') {
        if (!string(body?.name) || !Number.isFinite(body.density_g_cm3) || !Array.isArray(body.variants)) return error(400, 'invalid_material');
        let row = state.materials.find(row => row.id === body.id);
        if (!row) { row = { id: body.id || `qa-material-${state.nextId++}`, sort_order: state.materials.length }; state.materials.push(row); }
        Object.assign(row, { name: body.name.trim(), active: body.active, density_g_cm3: body.density_g_cm3, variants: body.variants.map(variant => {
          const gsm = variant.actual_gsm ?? variant.micron * body.density_g_cm3;
          return { micron: variant.micron, coefficient: gsm * 0.06, ...(variant.actual_gsm !== undefined ? { actual_gsm: variant.actual_gsm } : {}) };
        }).sort((a, b) => a.micron - b.micron) });
        return response({ ok: true, material: row });
      }
    }
    if (path === `${base}/settings`) {
      if (!requires(method === 'GET' ? 'admin.settings.read' : 'admin.settings.manage')) return error(403, 'forbidden');
      if (method === 'GET') return response(state.settings);
      if (method === 'PUT') { for (const field of ['default_target_warehouse', 'default_uom', 'werka_name', 'werka_phone']) if (typeof body?.[field] === 'string') state.settings[field] = body[field]; return response(state.settings); }
    }
    if (path === `${base}/system/monitor` && method === 'GET') return response({ server: { status: 'running', uptime_seconds: 7200 }, database: { reachable: true, database_kind: 'synthetic', size_bytes: 0 }, runtime: { cpu_percent: 2, memory_percent: 3, disk_percent: 1 }, backups: { snapshot_count: 0, snapshots: [], active_job: null } });
    return error(404, 'fixture_route_not_implemented', `${method} ${path}`);
  }

  async function dispatch({ method = 'GET', url = '/', headers = {}, body } = {}) {
    const parsed = new URL(url, 'http://127.0.0.1'), path = decodeURIComponent(parsed.pathname), query = Object.fromEntries(parsed.searchParams);
    const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (path.startsWith('/__qa/')) return control(method, path, body);
    const rule = config.rules.find(rule => rule.method === method && rule.path === path);
    if (rule?.once) config.rules = config.rules.filter(candidate => candidate !== rule);
    if (rule?.delayMs) await sleep(rule.delayMs);
    const result = rule?.status && !rule.applyBeforeFailure ? error(rule.status, rule.error || `http_${rule.status}`, rule.detail)
      : route(method, path, query, body, normalizedHeaders);
    if (rule?.status && rule.applyBeforeFailure) Object.assign(result, error(rule.status, rule.error || `http_${rule.status}`, rule.detail));
    if (rule?.dropResponse) result.dropResponse = true;
    if (rule?.invalidJson) result.invalidJson = true;
    logs.push({ sequence: ++sequence, method, path, query: sanitize(query), body: sanitize(body ?? null),
      authorized: Boolean(normalizedHeaders.authorization), idempotencyKeyPresent: Boolean(normalizedHeaders['idempotency-key']),
      status: result.dropResponse ? 'lost' : result.status, error: result.body?.error || null, invalidJson: result.invalidJson || false });
    if (logs.length > 500) logs.shift();
    return clone(result);
  }
  return { dispatch, getState: publicState, getLog: () => clone(logs) };
}

export function createFixtureServer({ webPorts = [5186, 5184, 5174, 4174], fixture = createFixture() } = {}) {
  if (!webPorts.length || webPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid localhost web ports');
  const origins = new Set(webPorts.flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]));
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture_origin_forbidden' })); return; }
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-File-Name', 'Access-Control-Max-Age': '0' }); res.end(); return;
    }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_048_576) throw new Error('fixture_body_too_large'); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const result = await fixture.dispatch({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      if (result.dropResponse) {
        // Flush a response before losing its body. A socket closed before headers
        // lets Chromium transparently retransmit an idempotent PUT in transport.
        const partial = '{"synthetic_response_loss":';
        res.writeHead(result.status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(JSON.stringify(result.body)) + 128 });
        res.flushHeaders();
        res.write(partial, () => setTimeout(() => res.destroy(), 20));
        return;
      }
      res.writeHead(result.status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(result.invalidJson ? '{synthetic-invalid-json' : JSON.stringify(result.body));
    } catch (caught) {
      if (!res.headersSent) res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: caught.message === 'fixture_body_too_large' ? caught.message : 'invalid_fixture_request' }));
    }
  });
  server.fixture = fixture;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawPort = process.argv.find(argument => argument.startsWith('--port='))?.split('=')[1] || '5199';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use --port=<1..65535>');
  const server = createFixtureServer();
  server.on('error', failure => { process.stderr.write(`Fixture listener failed: ${failure.code}\n`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Synthetic ERP fixture: http://127.0.0.1:${port}\nLogin: ${fixtureLogin.phone} / ${fixtureLogin.code}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
