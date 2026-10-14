import { createPaddonFixtureExtension, paddonsPath } from './erp-paddons.mjs';

// Pure synthetic report and offline preparation. No confirmation, driver or physical-print endpoint.
export const paddonQrReportPath = `${paddonsPath}/qr/report`;
export const paddonQrPrintPath = `${paddonsPath}/qr/print`;
const readCapabilities = ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const trim = value => typeof value === 'string' ? value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') : '';
const asciiLower = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const canonical = value => typeof value === 'string' && value.length <= 128 && /^apparatus:[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(value);
function scan(context, code) {
  // The authenticated print handler loads its snapshot without requiring report capability.
  // Bypass only the old detail route's exact four-capability read guard; preserve native unlock metadata checks.
  const requires = (...codes) => codes.length === readCapabilities.length && codes.every(code => readCapabilities.includes(code)) || context.requires(...codes);
  const result = createPaddonFixtureExtension(context.state).route({ ...context, method: 'GET', path: `${paddonsPath}/detail`, query: { code }, body: undefined, requires });
  if (result.status !== 200) return result;
  const { available_items: _available, ...snapshot } = result.body;
  return response({ ...snapshot, qr_payload: snapshot.paddon.code });
}
function closeOffer(context, paddon) {
  if (paddon.locked_at_unix !== null || !context.requires('apparatus.queue.manage') || context.profile.role !== 'aparatchi') return { value: false };
  let cut = false;
  for (const value of context.config?.assignedApparatus || []) {
    const id = trim(value);
    if (!canonical(id)) return error(400, 'canonical_apparatus_id_required');
    const row = context.state.apparatus.find(row => row.apparatus_id === id);
    if (!row || row.lifecycle.state !== 'active') return error(500, 'store_failed');
    if (row.execution_profile.operation === 'cut') cut = true;
  }
  return { value: cut };
}
export function paddonLabelFixtureRoute(context) {
  const { method, path, query = {}, body, profile, requires } = context;
  if (path !== paddonQrReportPath && path !== paddonQrPrintPath) return null;
  // Main fixture verifies the actual token before dispatch; the pure harness supplies the resulting principal.
  if (!object(profile) || typeof profile.role !== 'string' || !profile.role || typeof profile.display_name !== 'string') return error(401, 'unauthorized');
  if (path === paddonQrReportPath) {
    if (!requires(...readCapabilities)) return error(403, 'forbidden');
    if (method !== 'GET') return error(405, 'method_not_allowed');
    if (typeof query.code !== 'string') return error(400, 'invalid_query');
    return scan(context, trim(query.code));
  }
  if (method !== 'POST') return error(405, 'method_not_allowed');
  if (!object(body) || ['code', 'driver_url', 'printer', 'print_mode', 'print_transport'].some(key => body[key] !== undefined && typeof body[key] !== 'string')
    || body.print_count !== undefined && (!Number.isInteger(body.print_count) || body.print_count < 0 || body.print_count > 0xffff_ffff)) return error(400, 'invalid_json');
  // The native route also offers server transport; this local slice deliberately exposes only preparation.
  if (asciiLower(trim(body.print_transport)) !== 'offline') return error(400, 'offline_preparation_only');
  const snapshot = scan(context, trim(body.code)); if (snapshot.status !== 200) return snapshot;
  const offer = closeOffer(context, snapshot.body.paddon); if (offer.status) return offer;
  const { paddon, items, qr_payload } = snapshot.body;
  const print = {
    ok: true, status: 'prepared', qr_payload, item_code: paddon.code, item_name: `Paddon ${paddon.code}`,
    apparatus: '', apparatus_display_name: '', customer_name: '', executor_name: trim(profile.display_name),
    qty: 1, gross_qty: 1, tare_enabled: false, tare_kg: 0, unit: 'dona', progress_unit: 'dona', label_kind: 'paddon_code',
    printer: asciiLower(trim(body.printer)) || 'godex', print_mode: asciiLower(trim(body.print_mode)) || 'label',
    printer_status: 'client_usb_pending', print_count: body.print_count || 1,
  };
  return response({ ok: true, paddon, items, qr_payload, print, can_close_after_print: offer.value });
}

export function seedPaddonLabelScenario(state, input = {}) {
  if (!object(input)) return error(400, 'invalid_paddon_label_fixture');
  const paddons = createPaddonFixtureExtension(state);
  if (input.action) {
    if (input.action === 'identity' && Object.keys(input).every(key => ['action', 'code', 'id'].includes(key)) && typeof input.id === 'string' && trim(input.id) && trim(input.id) === input.id) {
      const paddon = state.paddons.find(row => row.code === input.code); if (!paddon) return error(404, 'paddon_label_fixture_not_found');
      if (state.paddons.some(row => row !== paddon && row.id === input.id)) return error(400, 'invalid_paddon_label_fixture');
      paddon.id = input.id; state.rev++; return response({ ok: true });
    }
    if (input.action === 'visibility' && Object.keys(input).every(key => ['action', 'enabled'].includes(key)) && typeof input.enabled === 'boolean') {
      state.paddonFixture.worker_visibility_enabled = input.enabled; state.rev++; return response({ ok: true });
    }
    if (['lock', 'unlock', 'received', 'concurrent', 'remove-paddon', 'batch'].includes(input.action)) return paddons.seed(input);
    return error(400, 'invalid_paddon_label_fixture');
  }
  const scenario = input.scenario ?? 'labels';
  if (Object.keys(input).some(key => key !== 'scenario') || !['empty', 'labels', 'locked', 'received', 'visibility', 'unknown-weight'].includes(scenario)) return error(400, 'invalid_paddon_label_fixture');
  const result = paddons.seed({ scenario: ['empty', 'received', 'visibility'].includes(scenario) ? scenario : 'paddons' });
  if (result.status !== 200) return result;
  if (scenario === 'locked') paddons.seed({ action: 'lock', code: '00001' });
  if (scenario === 'unknown-weight') {
    const batch = state.paddonBatches.find(row => row.batch_id === 'qa-paddon-wip-1');
    delete batch.payload_json.gross_qty; batch.finished_goods_kg = null; batch.bobina_kg = null;
  }
  state.paddonLabelFixture = { scenario }; return response({ ok: true, scenario });
}
