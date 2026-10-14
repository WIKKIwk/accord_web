import { createPaddonFixtureExtension, paddonsPath } from './erp-paddons.mjs';

export const paddonManagementPath = `${paddonsPath}/management-settings`;
const readCapabilities = ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const trim = value => typeof value === 'string' ? value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') : '';
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
function initialize(state) { createPaddonFixtureExtension(state); }
function settings(state) {
  return { free_movement_enabled: state.paddonFixture.free_movement_enabled, worker_visibility_enabled: state.paddonFixture.worker_visibility_enabled };
}

/** Pure synthetic business setter. Visibility has no write route in this task's fixture slice. */
export function paddonManagementFixtureRoute({ method, path, body, state, profile, requires, bump }) {
  if (path !== paddonManagementPath) return null;
  if (!['GET', 'PUT'].includes(method)) return error(405, 'method_not_allowed');
  if (method === 'GET') {
    if (!requires(...readCapabilities)) return error(403, 'forbidden');
    initialize(state); return response({ ok: true, settings: settings(state) });
  }
  // Native capability and actual-principal role guards run before JSON parsing.
  if (!requires('admin.access') || profile.role !== 'admin') return error(403, 'forbidden');
  if (!object(body) || Object.keys(body).some(key => key !== 'free_movement_enabled')) return error(400, 'invalid_json');
  if (body.free_movement_enabled === undefined || body.free_movement_enabled === null) return error(400, 'paddon_invalid_input');
  if (typeof body.free_movement_enabled !== 'boolean') return error(400, 'invalid_json');
  if (!trim(profile.ref)) return error(400, 'paddon_invalid_input');
  initialize(state);
  // Share the existing paddon business flags, so detail/membership/unlock obey the setting.
  state.paddonFixture.free_movement_enabled = body.free_movement_enabled;
  bump?.(); return response({ ok: true, settings: settings(state) });
}

/** Fixture controls only; no listener, native API, token, printer or persisted settings. */
export function seedPaddonManagementScenario(state, input = {}) {
  if (!object(input)) return error(400, 'invalid_paddon_management_fixture');
  if (input.action === 'concurrent') {
    if (Object.keys(input).some(key => !['action', 'free_movement_enabled'].includes(key)) || typeof input.free_movement_enabled !== 'boolean') return error(400, 'invalid_paddon_management_fixture');
    initialize(state); state.paddonFixture.free_movement_enabled = input.free_movement_enabled;
    state.rev++; return response({ ok: true });
  }
  const scenario = input.scenario ?? 'off';
  if (Object.keys(input).some(key => key !== 'scenario') || !['off', 'on', 'visibility-on', 'empty'].includes(scenario)) return error(400, 'invalid_paddon_management_fixture');
  const extension = createPaddonFixtureExtension(state);
  extension.seed({ scenario: scenario === 'empty' ? 'empty' : scenario === 'on' ? 'free-movement' : 'paddons' });
  // A pre-existing visibility state is test data, never a visibility setter endpoint.
  if (scenario === 'visibility-on') state.paddonFixture.worker_visibility_enabled = true;
  state.paddonManagementFixture = { scenario };
  return response({ ok: true, scenario });
}
