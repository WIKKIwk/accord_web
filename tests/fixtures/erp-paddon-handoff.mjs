import { apparatusIds } from './erp-seed.mjs';
import { refreshFixtureCanonical } from './erp-canonical.mjs';
import { createPaddonFixtureExtension, paddonsPath } from './erp-paddons.mjs';

// Pure synthetic actor-scoped handoff. Printing/confirm/preparation/settings are not exposed.
export const paddonActivePath = `${paddonsPath}/active`;
export const paddonNextPath = `${paddonActivePath}/next`;
const clone = value => structuredClone(value), object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const trim = value => typeof value === 'string' ? value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') : '';
const canonical = value => typeof value === 'string' && value.length <= 128 && /^apparatus:[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(value);
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const activeCapabilities = ['admin.access', 'production.map.manage', 'apparatus.queue.manage'];
const apparatusCapabilities = ['admin.access', 'production.map.manage', 'catalog.item.read', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'];
const actor = profile => ({ actor_role: trim(profile.role), actor_ref: trim(profile.ref) });
const selectionKey = (profile, apparatus) => JSON.stringify([trim(profile.role), trim(profile.ref), apparatus]);
const rowKey = row => JSON.stringify([row.actor_role, row.actor_ref, row.apparatus]);
const visible = (state, paddon, profile) => profile.role !== 'aparatchi' || state.paddonFixture?.worker_visibility_enabled || !!trim(profile.ref) && paddon.created_by_ref === trim(profile.ref);
function initialize(state) {
  createPaddonFixtureExtension(state);
  state.paddonSuccessors ??= []; state.paddonHandoffOutputBatchIds ??= [];
}
function resolve(state, id) {
  if (!canonical(id)) return error(400, 'canonical_apparatus_id_required');
  const row = state.apparatus.find(row => row.apparatus_id === id);
  return !row || row.lifecycle.state !== 'active' ? error(500, 'store_failed') : { row };
}
function selection(state, profile, apparatus) {
  const raw = state.paddonActiveSelections.find(row => rowKey(row) === selectionKey(profile, apparatus));
  const paddon = raw?.code && state.paddons.find(row => row.code === raw.code);
  return paddon && paddon.locked_at_unix === null && !paddon.receipt && visible(state, paddon, profile) ? paddon.code : null;
}
function saveSelection(state, profile, apparatus, code) {
  const existing = state.paddonActiveSelections.find(row => rowKey(row) === selectionKey(profile, apparatus));
  if (existing) existing.code = code;
  else state.paddonActiveSelections.push({ ...actor(profile), apparatus, code });
}
function parsedInput(body) {
  if (!object(body) || Object.keys(body).some(key => !['apparatus', 'code'].includes(key)) || typeof body.apparatus !== 'string' || typeof body.code !== 'string') return error(400, 'invalid_json');
  return { apparatus: trim(body.apparatus), code: trim(body.code) };
}
function snapshot(state, context, code) {
  return createPaddonFixtureExtension(state).route({ ...context, method: 'GET', path: `${paddonsPath}/detail`, query: { code }, body: undefined });
}
function pruneSuccessorCycles(state, source) {
  // Prior fixture unlock owns its endpoint. Cycle tags also cover unlock/relock controls when routed there first.
  state.paddonSuccessors = state.paddonSuccessors.filter(row => row.source_code !== source.code || row.source_locked_at === source.locked_at_unix);
}
export function paddonHandoffFixtureRoute(context) {
  const { method, path, query = {}, body, state, profile, requires, config = {}, bump } = context;
  if (state.paddonHandoffFixture && method === 'GET' && path === '/v1/mobile/admin/apparatus') {
    if (!requires(...apparatusCapabilities)) return error(403, 'forbidden');
    const q = trim(query.q).toLowerCase(), limit = Math.max(1, Math.min(500, Number(query.limit) || 50));
    return response(clone(state.apparatus.filter(row => !q || row.display.display_name.toLowerCase().includes(q)).slice(0, limit)));
  }
  if (state.paddonHandoffFixture && path === `${paddonsPath}/unlock` && method === 'POST') {
    const source = state.paddons.find(row => row.code === trim(body?.code)), wasLocked = source?.locked_at_unix !== null && source?.locked_at_unix !== undefined;
    const result = createPaddonFixtureExtension(state).route(context);
    if (result?.status === 200 && wasLocked) state.paddonSuccessors = (state.paddonSuccessors || []).filter(row => row.source_code !== source.code);
    return result;
  }
  if (state.paddonHandoffFixture && path === `${paddonsPath}/delete` && method === 'POST') {
    const code = trim(body?.code), mappings = state.paddonSuccessors || [];
    if (!mappings.some(row => row.code === code)) return createPaddonFixtureExtension(state).route(context);
    // Native permissions, visibility and history checks precede DELETE's successor FK (NO ACTION).
    // Disable bump: the caller's callback closes over the real state, even while probing a clone.
    const probeState = clone(state), probe = createPaddonFixtureExtension(probeState).route({ ...context, state: probeState, bump: undefined });
    if (probe?.status !== 200) return probe;
    const currentCycle = mapping => {
      const source = state.paddons.find(row => row.code === mapping.source_code);
      return source && source.locked_at_unix !== null && source.locked_at_unix === mapping.source_locked_at;
    };
    if (mappings.some(row => row.code === code && currentCycle(row))) return error(500, 'store_failed');
    const result = createPaddonFixtureExtension(state).route(context);
    // Older synthetic unlock controls do not know these mappings; native unlock already removed them.
    if (result?.status === 200) state.paddonSuccessors = mappings.filter(currentCycle);
    return result;
  }
  if (path !== paddonActivePath && path !== paddonNextPath) return null;
  initialize(state);
  if (path === paddonActivePath) {
    if (!['GET', 'PUT'].includes(method)) return error(405, 'method_not_allowed');
    if (!requires(...activeCapabilities)) return error(403, 'forbidden');
    let input;
    if (method === 'PUT') { input = parsedInput(body); if (input.status) return input; }
    else { if (typeof query.apparatus !== 'string') return error(400, 'apparatus is required'); input = { apparatus: trim(query.apparatus) }; }
    const resolved = resolve(state, input.apparatus); if (resolved.status) return resolved;
    if (!requires('admin.access') && !(config.assignedApparatus || []).some(value => trim(value) === input.apparatus)) return error(400, 'apparatus_not_assigned');
    if (!trim(profile.role) || !trim(profile.ref) || resolved.row.execution_profile.operation !== 'cut') return error(400, 'paddon_invalid_input');
    if (method === 'GET') return response({ ok: true, apparatus: input.apparatus, code: selection(state, profile, input.apparatus) });
    if (Buffer.byteLength(input.code, 'utf8') > 128) return error(400, 'paddon_invalid_input');
    if (input.code) {
      const target = state.paddons.find(row => row.code === input.code);
      if (!target || !visible(state, target, profile)) return error(404, 'paddon_not_found');
      if (target.locked_at_unix !== null) return error(409, 'paddon_locked');
      if (target.receipt) return error(400, 'paddon_invalid_input');
    }
    saveSelection(state, profile, input.apparatus, input.code || null); bump?.();
    return response({ ok: true, apparatus: input.apparatus, code: input.code || null });
  }
  if (method !== 'POST') return error(405, 'method_not_allowed');
  if (!requires('apparatus.queue.manage')) return error(403, 'forbidden');
  const input = parsedInput(body); if (input.status) return input;
  const source = state.paddons.find(row => row.code === input.code);
  if (profile.role === 'aparatchi' && (!input.code || !source || !visible(state, source, profile))) return !input.code ? error(400, 'paddon_invalid_input') : error(404, 'paddon_not_found');
  // Native assigned_cut_apparatuses returns none for all non-aparatchi actors, even admin.access.
  if (profile.role !== 'aparatchi') return error(403, 'forbidden');
  const assignedCuts = [];
  for (const id of config.assignedApparatus || []) {
    const resolved = resolve(state, trim(id)); if (resolved.status) return resolved;
    if (resolved.row.execution_profile.operation === 'cut') assignedCuts.push(trim(id));
  }
  if (!assignedCuts.includes(input.apparatus)) return error(403, 'forbidden');
  if (!trim(profile.ref) || !input.code || Buffer.byteLength(input.code, 'utf8') > 128) return error(400, 'paddon_invalid_input');
  if (!source) return error(404, 'paddon_not_found');
  if (source.locked_at_unix === null) return error(400, 'paddon_invalid_input');
  pruneSuccessorCycles(state, source);
  const scopeKey = JSON.stringify([source.code, trim(profile.role), trim(profile.ref), input.apparatus]);
  const mapping = state.paddonSuccessors.find(row => row.key === scopeKey);
  let successor;
  if (mapping) {
    successor = state.paddons.find(row => row.code === mapping.code);
    if (!successor) return error(500, 'store_failed');
    if (successor.locked_at_unix !== null || successor.receipt) return error(409, 'paddon_locked');
  } else {
    const created = createPaddonFixtureExtension(state).route({ ...context, method: 'POST', path: `${paddonsPath}/create`, body: { location: input.apparatus, note: '' } });
    if (created.status !== 200) return created;
    successor = state.paddons.find(row => row.code === created.body.paddon.code);
    state.paddonSuccessors.push({ key: scopeKey, source_code: source.code, source_locked_at: source.locked_at_unix, ...actor(profile), apparatus: input.apparatus, code: successor.code });
  }
  saveSelection(state, profile, input.apparatus, successor.code); bump?.();
  const result = snapshot(state, context, successor.code); if (result.status !== 200) return result;
  return response({ ok: true, apparatus: input.apparatus, code: successor.code, paddon: result.body.paddon });
}

/** Mirrors native cut-output attachment; caller handles rollback of its own completion state on an error. */
export function attachPaddonHandoffOutputs({ state, profile, apparatus, batches }) {
  initialize(state);
  const id = trim(apparatus), row = state.apparatus.find(item => item.apparatus_id === id);
  if (!canonical(id) || !row || row.lifecycle.state !== 'active') return { status: 500, error: 'store_failed' };
  if (row.execution_profile.operation !== 'cut') return { status: 200, code: null, attached: [] };
  if (!trim(profile.role) || !trim(profile.ref)) return { status: 400, error: 'paddon_invalid_input' };
  if (!Array.isArray(batches) || batches.some(batch => !object(batch) || !trim(batch.batch_id))) return { status: 400, error: 'progress_input_invalid' };
  const known = new Set([...state.paddonHandoffOutputBatchIds, ...state.paddonBatches.map(batch => batch.batch_id)]);
  const fresh = [...new Map(batches.filter(batch => !known.has(batch.batch_id)).map(batch => [batch.batch_id, batch])).values()];
  if (!fresh.length) return { status: 200, code: null, attached: [] };
  const code = selection(state, profile, id), target = code && state.paddons.find(paddon => paddon.code === code);
  if (target && fresh.some(batch => state.paddonMemberships.some(member => !member.removed && member.batch_id === batch.batch_id && member.code !== target.code))) return { status: 409, error: 'paddon_item_already_assigned' };
  // No state changes occur until all new outputs and membership conflicts are validated.
  state.paddonHandoffOutputBatchIds.push(...fresh.map(batch => batch.batch_id)); state.paddonBatches.push(...clone(fresh));
  if (!target) return { status: 200, code: null, attached: [] };
  const attached = [];
  for (const batch of fresh) {
    if (!state.paddonMemberships.some(member => !member.removed && member.code === target.code && member.batch_id === batch.batch_id)) state.paddonMemberships.push({ code: target.code, batch_id: batch.batch_id, removed: false });
    attached.push(batch.batch_id);
  }
  target.updated_at_unix = ++state.paddonFixture.clock; target.history = true;
  return { status: 200, code: target.code, attached };
}

export function seedPaddonHandoffScenario(state, input = {}) {
  if (!object(input)) return error(400, 'invalid_paddon_handoff_fixture');
  initialize(state);
  if (input.action) {
    if (['active', 'concurrent'].includes(input.action)) {
      if (Object.keys(input).some(key => !['action', 'apparatus', 'code', 'actor_role', 'actor_ref'].includes(key)) || !canonical(input.apparatus)
        || typeof input.code !== 'string' || Buffer.byteLength(trim(input.code), 'utf8') > 128
        || ['actor_role', 'actor_ref'].some(key => input[key] !== undefined && (typeof input[key] !== 'string' || !trim(input[key])))) return error(400, 'invalid_paddon_handoff_fixture');
      const profile = { role: input.actor_role || 'admin', ref: input.actor_ref || 'qa-admin' }, code = trim(input.code), target = state.paddons.find(row => row.code === code);
      if (code && (!target || target.locked_at_unix !== null || target.receipt || !visible(state, target, profile))) return error(400, 'invalid_paddon_handoff_fixture');
      saveSelection(state, profile, input.apparatus, code || null); state.rev++; return response({ ok: true });
    }
    if (['lock', 'unlock', 'received', 'remove-paddon'].includes(input.action) && Object.keys(input).every(key => ['action', 'code'].includes(key))) {
      const result = createPaddonFixtureExtension(state).seed(input);
      if (result.status === 200 && (input.action === 'unlock' || input.action === 'remove-paddon')) state.paddonSuccessors = state.paddonSuccessors.filter(row => row.source_code !== input.code && (input.action !== 'remove-paddon' || row.code !== input.code));
      return result;
    }
    if (input.action === 'retire-apparatus' && Object.keys(input).every(key => ['action', 'apparatus'].includes(key))) {
      const row = state.apparatus.find(item => item.apparatus_id === input.apparatus); if (!row) return error(404, 'paddon_handoff_fixture_not_found');
      row.lifecycle = { state: 'retired', retirement_reason: 'Synthetic handoff QA retirement' }; row.source_revision++;
      refreshFixtureCanonical(row, state.planning[row.apparatus_id]); state.rev++; return response({ ok: true });
    }
    return error(400, 'invalid_paddon_handoff_fixture');
  }
  const scenario = input.scenario ?? 'handoff';
  if (Object.keys(input).some(key => key !== 'scenario') || !['empty', 'handoff', 'selected', 'bounded'].includes(scenario)) return error(400, 'invalid_paddon_handoff_fixture');
  createPaddonFixtureExtension(state).seed({ scenario: scenario === 'empty' ? 'empty' : scenario === 'bounded' ? 'bounded' : 'paddons' });
  state.paddonHandoffFixture = { scenario }; state.paddonSuccessors = []; state.paddonHandoffOutputBatchIds = [];
  // Handoff worker can see the seeded locked source without enabling global worker visibility.
  const source = state.paddons.find(row => row.code === (scenario === 'bounded' ? '00204' : '00002'));
  if (source) { source.created_by_ref = 'qa-worker-1'; source.created_by_display_name = 'QA Operator'; source.locked_by_ref = 'qa-worker-1'; source.locked_at_unix = ++state.paddonFixture.clock; source.history = true; }
  const original = state.apparatus.find(row => row.apparatus_id === apparatusIds.cut), count = scenario === 'bounded' ? 505 : 1;
  // Re-seeding replaces only earlier synthetic handoff catalog additions.
  state.apparatus = state.apparatus.filter(row => !row.apparatus_id.startsWith('apparatus:qa:handoff-cut-'));
  for (let index = 0; index < count; index++) {
    const id = `apparatus:qa:handoff-cut-${index}`, row = clone(original);
    row.apparatus_id = id; row.display = { ...row.display, display_name: `QA Handoff CUT ${String(index).padStart(3, '0')}`, catalog_order: 1000 + index };
    row.physical_asset_id = `physical-asset:qa:handoff-cut-${index}`; row.hierarchy.work_unit_id = `work-unit:handoff-cut-${index}`; row.placement = null;
    state.planning[id] = clone(state.planning[original.apparatus_id]); refreshFixtureCanonical(row, state.planning[id]); state.apparatus.push(row);
  }
  if (scenario === 'selected') {
    saveSelection(state, { role: 'admin', ref: 'qa-admin' }, apparatusIds.cut, '00003');
    saveSelection(state, { role: 'aparatchi', ref: 'qa-worker-1' }, apparatusIds.cut, '00007');
  }
  state.rev++; return response({ ok: true, scenario });
}
