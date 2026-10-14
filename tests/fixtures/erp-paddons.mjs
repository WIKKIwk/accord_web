import { apparatusIds } from './erp-seed.mjs';

// Synthetic RAM only. Native membership transactions have no CAS/idempotency receipt.
export const paddonsPath = '/v1/mobile/admin/production-maps/paddons';
const readCapabilities = ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'];
const writeCapabilities = ['admin.access', 'production.map.manage', 'apparatus.queue.manage'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const trim = value => typeof value === 'string' ? value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') : '';
const clone = value => structuredClone(value), response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const allowedScenarios = ['empty', 'paddons', 'bounded', 'free-movement', 'received', 'visibility'];
const timestamp = 1791979200;
const batchKeys = ['wip_status', 'finished_goods_stock_id', 'received_warehouse', 'finished_goods_kg', 'bobina_kg', 'finished_goods_meter'];
const codeFor = number => String(number).padStart(5, '0');
function newPaddon(number, creator = 'qa-admin', patch = {}) {
  return { id: `paddon-${codeFor(number)}`, code: codeFor(number), location: '', note: '', created_by_ref: creator,
    created_by_display_name: creator === 'qa-admin' ? 'QA Administrator' : 'QA Operator', created_at_unix: timestamp, updated_at_unix: timestamp,
    locked_at_unix: null, locked_by_ref: '', receipt: null, history: false, ...patch };
}
function batch(number, patch = {}) {
  return { batch_id: `qa-paddon-wip-${number}`, revision: 1, session_id: `qa-paddon-session-${number}`, started_at_unix: timestamp, completed_at_unix: timestamp,
    apparatus: apparatusIds.cut, order_id: `qa-paddon-order-${number}`, action: 'roll_complete', status: 'completed', produced_qty: 1000 + number, uom: 'm',
    qr_payload: `QA-PADDON-ROLL:${number}`, label_item_code: 'QA-FILM-1', label_item_name: `QA Paddon plyonkasi ${number}`, executor_name: 'QA Operator',
    worker_role: 'aparatchi', worker_ref: 'qa-worker-1', worker_display_name: 'QA Operator', wip_status: 'waiting', finished_goods_kg: 10, bobina_kg: 0.5,
    finished_goods_meter: 1000 + number, payload_json: {}, ...patch };
}
function nativeBatchIds(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !trim(value))) return null;
  const ids = [...new Set(values.map(trim))]; return ids.length && ids.length <= 500 ? ids : null;
}
const units = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 1e6)) ? Math.round(value * 1e6) : null;
function totals(items) {
  let gross = 0, net = 0;
  for (const item of items.filter(row => row.wip_status === 'waiting')) {
    const measured = Object.hasOwn(item.payload_json || {}, 'gross_qty') && item.payload_json.gross_qty !== null ? item.payload_json.gross_qty : item.finished_goods_kg;
    const g = units(measured), tare = units(item.bobina_kg), n = g !== null && g > 0 && tare !== null && tare <= g ? g - tare : null;
    gross = gross !== null && g !== null && g > 0 && Number.isSafeInteger(gross + g) ? gross + g : null;
    net = net !== null && n !== null && Number.isSafeInteger(net + n) ? net + n : null;
  }
  return { total_gross_kg: gross === null ? null : gross / 1e6, total_net_kg: net === null ? null : net / 1e6 };
}
function fieldsFor(paddon, state) {
  const memberIds = new Set(state.paddonMemberships.filter(row => row.code === paddon.code && !row.removed).map(row => row.batch_id));
  const items = state.paddonBatches.filter(row => memberIds.has(row.batch_id));
  return { summary: { id: paddon.id, code: paddon.code, location: paddon.location, note: paddon.note, created_by_ref: paddon.created_by_ref,
    created_by_display_name: paddon.created_by_display_name, created_at_unix: paddon.created_at_unix, updated_at_unix: paddon.updated_at_unix,
    item_count: items.length, locked_at_unix: paddon.locked_at_unix, ...(paddon.receipt ? clone(paddon.receipt) : totals(items)) }, items };
}
function visible(paddon, profile, settings) {
  return profile.role !== 'aparatchi' || settings.worker_visibility_enabled || !!trim(profile.ref) && paddon.created_by_ref === trim(profile.ref);
}
function movable(row) {
  return row.wip_status === 'waiting' && !row.payload_json?.finished_goods_stock_id && !row.payload_json?.received_warehouse;
}
function touch(state, paddon) { paddon.updated_at_unix = ++state.paddonFixture.clock; paddon.history = true; }
function snapshot(state, paddon, profile, requires) {
  const settings = state.paddonFixture, { summary, items } = fieldsFor(paddon, state);
  const can_manage_items = !paddon.receipt && (paddon.locked_at_unix === null || settings.free_movement_enabled);
  const available_items = can_manage_items ? state.paddonBatches.filter(row => {
    const owner = state.paddonMemberships.find(member => member.batch_id === row.batch_id && !member.removed);
    if (settings.free_movement_enabled) return movable(row) && (!owner || owner.code !== paddon.code && !state.paddons.find(source => source.code === owner.code)?.receipt);
    // Native unassigned query excludes processed and assigned rows, not every ineligible roll.
    return row.wip_status !== 'processed' && !owner;
  }).sort((a, b) => b.completed_at_unix - a.completed_at_unix || b.batch_id.localeCompare(a.batch_id)).slice(0, 500) : [];
  const can_unlock = paddon.locked_at_unix !== null && !paddon.receipt && requires(...writeCapabilities) && !!trim(profile.ref)
    && (profile.role === 'admin' || settings.free_movement_enabled || profile.role === 'aparatchi' && paddon.locked_by_ref === trim(profile.ref));
  return response({ ok: true, paddon: summary, items: clone(items), available_items: clone(available_items), free_movement_enabled: settings.free_movement_enabled, can_manage_items, can_unlock });
}
function parsed(body, kind) {
  if (!object(body)) return error(400, 'invalid_json');
  if (kind === 'create') {
    if (['location', 'note'].some(key => body[key] !== undefined && typeof body[key] !== 'string')) return error(400, 'invalid_json');
    const location = trim(body.location), note = trim(body.note);
    if (Buffer.byteLength(location, 'utf8') > 160 || Buffer.byteLength(note, 'utf8') > 500) return error(400, 'paddon_invalid_input');
    return { location, note };
  }
  if ((kind === 'delete' || kind === 'unlock') && (Object.keys(body).some(key => key !== 'code') || typeof body.code !== 'string')) return error(400, 'invalid_json');
  if (body.code !== undefined && typeof body.code !== 'string') return error(400, 'invalid_json');
  const code = trim(body.code);
  if (!code || (kind === 'delete' || kind === 'unlock') && Buffer.byteLength(code, 'utf8') > 128) return error(400, 'paddon_invalid_input');
  if (kind === 'delete' || kind === 'unlock') return { code };
  if (body.progress_batch_ids !== undefined && (!Array.isArray(body.progress_batch_ids) || body.progress_batch_ids.some(id => typeof id !== 'string'))) return error(400, 'invalid_json');
  const progress_batch_ids = nativeBatchIds(body.progress_batch_ids ?? []);
  return progress_batch_ids ? { code, progress_batch_ids } : error(400, 'paddon_invalid_input');
}
export function createPaddonFixtureExtension(state, options = {}) {
  state.paddons ??= []; state.paddonBatches ??= []; state.paddonMemberships ??= []; state.paddonActiveSelections ??= [];
  state.paddonFixture ??= { scenario: 'empty', free_movement_enabled: false, worker_visibility_enabled: false, clock: timestamp, next_number: 1 };
  if (options.scenario) seed({ scenario: options.scenario });
  if (typeof options.freeMovementEnabled === 'boolean') state.paddonFixture.free_movement_enabled = options.freeMovementEnabled;
  if (typeof options.workerVisibilityEnabled === 'boolean') state.paddonFixture.worker_visibility_enabled = options.workerVisibilityEnabled;
  function route({ method, path, query = {}, body, profile, requires, bump }) {
    const kind = path === paddonsPath ? 'list' : path === `${paddonsPath}/detail` ? 'detail' : path === `${paddonsPath}/create` ? 'create'
      : path === `${paddonsPath}/delete` ? 'delete' : path === `${paddonsPath}/unlock` ? 'unlock'
        : path === `${paddonsPath}/items/add-batch` ? 'add' : path === `${paddonsPath}/items/remove-batch` ? 'remove' : null;
    if (!kind) return null;
    const read = kind === 'list' || kind === 'detail';
    if (!requires(...(read ? readCapabilities : writeCapabilities))) return error(403, 'forbidden');
    if (method !== (read ? 'GET' : 'POST')) return error(405, 'method_not_allowed');
    if (kind === 'list') {
      if (query.limit !== undefined && (!/^\d+$/.test(String(query.limit)) || !Number.isSafeInteger(Number(query.limit))) || query.selectable_only !== undefined && !['true', 'false'].includes(String(query.selectable_only))) return error(400, 'invalid_query');
      const limit = Math.max(1, Math.min(200, query.limit === undefined ? 50 : Number(query.limit)));
      return response({ ok: true, paddons: state.paddons.filter(row => visible(row, profile, state.paddonFixture))
        .filter(row => query.selectable_only !== 'true' || row.locked_at_unix === null && !row.receipt)
        .sort((a, b) => b.updated_at_unix - a.updated_at_unix || a.code.localeCompare(b.code)).slice(0, limit).map(row => fieldsFor(row, state).summary) });
    }
    if (kind === 'detail') {
      const code = trim(query.code); if (!code) return error(400, 'paddon_invalid_input');
      const paddon = state.paddons.find(row => row.code === code);
      return paddon && visible(paddon, profile, state.paddonFixture) ? snapshot(state, paddon, profile, requires) : error(404, 'paddon_not_found');
    }
    const input = parsed(body, kind); if (input.status) return input;
    if (kind === 'create') {
      if (state.paddonFixture.next_number > 99999) return error(409, 'paddon_code_exhausted');
      const paddon = newPaddon(state.paddonFixture.next_number++, trim(profile.ref), { ...input, created_by_display_name: trim(profile.display_name), created_at_unix: ++state.paddonFixture.clock, updated_at_unix: state.paddonFixture.clock });
      state.paddons.push(paddon); bump?.(); return response({ ok: true, paddon: fieldsFor(paddon, state).summary });
    }
    const paddon = state.paddons.find(row => row.code === input.code);
    if (!paddon || !visible(paddon, profile, state.paddonFixture)) return error(404, 'paddon_not_found');
    if (kind === 'delete') {
      if (paddon.locked_at_unix !== null || paddon.receipt || paddon.history || paddon.updated_at_unix !== paddon.created_at_unix || state.paddonMemberships.some(row => row.code === paddon.code)) return error(409, 'paddon_delete_locked');
      state.paddons = state.paddons.filter(row => row !== paddon);
      state.paddonActiveSelections.forEach(row => { if (row.code === paddon.code) row.code = null; });
      bump?.(); return response({ ok: true });
    }
    if (paddon.receipt) return error(409, 'paddon_already_received');
    if (kind === 'unlock') {
      if (!trim(profile.ref)) return error(400, 'paddon_invalid_input');
      if (paddon.locked_at_unix !== null) {
        if (!snapshot(state, paddon, profile, requires).body.can_unlock) return error(403, 'paddon_unlock_forbidden');
        paddon.locked_at_unix = null; paddon.locked_by_ref = ''; touch(state, paddon); bump?.();
      }
      return snapshot(state, paddon, profile, requires);
    }
    const free = state.paddonFixture.free_movement_enabled;
    if (paddon.locked_at_unix !== null && !free) return error(409, 'paddon_locked');
    const members = [], ids = [...input.progress_batch_ids].sort();
    // Validate the entire request before any membership or timestamp changes.
    for (const id of ids) {
      const item = state.paddonBatches.find(row => row.batch_id === id), owner = state.paddonMemberships.find(row => row.batch_id === id && !row.removed);
      if (kind === 'add' || free) {
        if (!item) return error(404, 'progress_batch_not_found');
        if (kind === 'add' && !free && owner?.code === paddon.code) continue;
        if (free && owner && state.paddons.find(row => row.code === owner.code)?.receipt) return error(409, 'paddon_already_received');
        if (kind === 'add' && !free && owner && owner.code !== paddon.code) return error(409, 'paddon_item_already_assigned');
        if (!movable(item)) return error(400, 'progress_batch_not_accepted');
      }
      if (kind === 'remove' && (!owner || owner.code !== paddon.code)) return error(400, 'paddon_item_not_assigned');
      members.push({ id, owner });
    }
    let changed = kind === 'remove';
    for (const { id, owner } of members) {
      if (kind === 'remove') { owner.removed = true; continue; }
      if (owner?.code === paddon.code) continue;
      if (owner) { owner.removed = true; const source = state.paddons.find(row => row.code === owner.code); if (source) touch(state, source); }
      state.paddonMemberships.push({ code: paddon.code, batch_id: id, removed: false }); changed = true;
    }
    if (changed) { touch(state, paddon); bump?.(); }
    return snapshot(state, paddon, profile, requires);
  }
  function seed(input = {}) {
    if (!object(input)) return error(400, 'invalid_paddon_fixture');
    if (input.action) {
      if (input.action === 'batch') {
        if (Object.keys(input).some(key => !['action', 'batch_id', 'patch'].includes(key)) || !object(input.patch) || Object.keys(input.patch).some(key => !batchKeys.includes(key))) return error(400, 'invalid_paddon_fixture');
        if (input.patch.wip_status !== undefined && !['waiting', 'in_use', 'processed'].includes(input.patch.wip_status)
          || ['finished_goods_stock_id', 'received_warehouse'].some(key => input.patch[key] !== undefined && input.patch[key] !== null && typeof input.patch[key] !== 'string')
          || ['finished_goods_kg', 'bobina_kg', 'finished_goods_meter'].some(key => input.patch[key] !== undefined && input.patch[key] !== null && (typeof input.patch[key] !== 'number' || !Number.isFinite(input.patch[key]) || input.patch[key] < 0))) return error(400, 'invalid_paddon_fixture');
        const item = state.paddonBatches.find(row => row.batch_id === input.batch_id); if (!item) return error(404, 'paddon_fixture_not_found');
        for (const [key, value] of Object.entries(input.patch)) {
          if (key === 'finished_goods_stock_id' || key === 'received_warehouse') item.payload_json[key] = value; else item[key] = value;
        }
        state.rev++; return response({ ok: true });
      }
      if (!['lock', 'unlock', 'received', 'history', 'concurrent', 'remove-paddon'].includes(input.action)
        || Object.keys(input).some(key => !['action', 'code', ...(input.action === 'concurrent' ? ['patch'] : [])].includes(key))) return error(400, 'invalid_paddon_fixture');
      const paddon = state.paddons.find(row => row.code === input.code); if (!paddon) return error(404, 'paddon_fixture_not_found');
      if (input.action === 'concurrent') {
        if (!object(input.patch) || Object.keys(input.patch).some(key => !['location', 'note'].includes(key))) return error(400, 'invalid_paddon_fixture');
        const parsedInput = parsed({ location: paddon.location, note: paddon.note, ...input.patch }, 'create'); if (parsedInput.status) return parsedInput;
        Object.assign(paddon, parsedInput); touch(state, paddon);
      } else if (input.action === 'remove-paddon') {
        state.paddons = state.paddons.filter(row => row !== paddon); state.paddonMemberships = state.paddonMemberships.filter(row => row.code !== paddon.code);
      } else if (input.action === 'received') { paddon.receipt = totals(fieldsFor(paddon, state).items); touch(state, paddon); }
      else if (input.action === 'history') { paddon.history = true; }
      else { paddon.locked_at_unix = input.action === 'lock' ? ++state.paddonFixture.clock : null; paddon.locked_by_ref = input.action === 'lock' ? paddon.created_by_ref : ''; touch(state, paddon); }
      state.rev++; return response({ ok: true });
    }
    const scenario = input.scenario ?? 'empty';
    if (Object.keys(input).some(key => key !== 'scenario') || !allowedScenarios.includes(scenario)) return error(400, 'invalid_paddon_fixture');
    state.paddonFixture = { scenario, free_movement_enabled: scenario === 'free-movement', worker_visibility_enabled: false, clock: timestamp, next_number: 1 };
    state.paddons = []; state.paddonMemberships = []; state.paddonActiveSelections = [];
    state.paddonBatches = [batch(1, { payload_json: { gross_qty: 12 } }), batch(2, { finished_goods_kg: 20, bobina_kg: 0 }), batch(3, { finished_goods_kg: null, bobina_kg: null }),
      batch(4, { wip_status: 'in_use' }), batch(5, { payload_json: { finished_goods_stock_id: 'qa-stock-received' } }), batch(6, { wip_status: 'processed' }),
      batch(8), batch(9, { payload_json: { received_warehouse: 'QA Tayyor mahsulot', finished_goods_stock_id: 'qa-paddon-stock-9' } })];
    if (scenario !== 'empty') {
      state.paddons = [newPaddon(1, 'qa-admin', { history: true, updated_at_unix: timestamp + 1 }),
        newPaddon(2, 'qa-admin', { locked_at_unix: timestamp + 2, locked_by_ref: 'qa-admin', history: true, updated_at_unix: timestamp + 2 }),
        newPaddon(3), newPaddon(4, 'qa-admin', { history: true }),
        newPaddon(5, 'qa-admin', { receipt: { total_gross_kg: 77, total_net_kg: 75 }, history: true, updated_at_unix: timestamp + 3 }),
        newPaddon(6, 'qa-worker-2'), newPaddon(7, 'qa-worker-1')];
      state.paddonMemberships = [{ code: '00001', batch_id: 'qa-paddon-wip-1', removed: false }, { code: '00002', batch_id: 'qa-paddon-wip-8', removed: false },
        { code: '00004', batch_id: 'qa-paddon-historic-wip', removed: true }, { code: '00005', batch_id: 'qa-paddon-wip-9', removed: false }];
      state.paddonFixture.next_number = 8; state.paddonFixture.clock = timestamp + 3;
    }
    if (scenario === 'received') { state.paddons = state.paddons.filter(row => row.receipt); state.paddonMemberships = state.paddonMemberships.filter(row => row.code === '00005'); }
    if (scenario === 'visibility') { state.paddons = state.paddons.filter(row => ['00006', '00007'].includes(row.code)); state.paddonMemberships = []; }
    if (scenario === 'bounded') {
      state.paddons = Array.from({ length: 205 }, (_, index) => newPaddon(index + 1)); state.paddonMemberships = [];
      state.paddonBatches = Array.from({ length: 505 }, (_, index) => batch(index + 1000)); state.paddonFixture.next_number = 206;
    }
    state.rev++; return response({ ok: true, scenario });
  }
  return { route, seed };
}
