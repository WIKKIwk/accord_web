const base = '/v1/mobile/admin/production-maps', clone = value => structuredClone(value);
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const text = value => typeof value === 'string' ? value.trim() : '', object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const fixturePassportMeasures = ['return_ink_kg', 'lamination_print_leftover_rolls', 'lamination_film_leftover_rolls', 'rezka_bosma_waste', 'rezka_lamination_waste', 'rezka_edge_waste', 'total_waste', 'finished_goods_kg', 'bobina_kg', 'finished_goods_meter', 'diameter'];
const editable = ['produced_qty', 'uom', 'description', ...fixturePassportMeasures], positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const normalizedValues = value => Object.fromEntries(editable.map(key => [key, value[key] ?? (key === 'description' ? '' : null)]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Explicit opt-in: baseline v6 histories and worker ownership remain unchanged. */
export function seedPassportScenario(state, { scenario = 'own', owner = 'qa-admin' } = {}) {
  if (!['own', 'foreign', 'used', 'layer', 'stale'].includes(scenario)) return error(400, 'invalid_passport_fixture');
  const batch = state.wip.find(row => row.batch_id === 'qa-wip-1');
  Object.assign(batch, { worker_ref: scenario === 'foreign' ? 'qa-worker-1' : owner, worker_role: 'admin', worker_display_name: 'QA Passport Owner', executor_name: 'QA Passport Owner',
    revision: 1, action: 'roll_complete', status: 'completed', wip_status: scenario === 'used' ? 'in_use' : 'waiting', finished_goods_meter: 1250, finished_goods_kg: 25, bobina_kg: 1,
    total_waste: 2, description: 'QA Saved measured roll', used_by_session_id: '', used_by_apparatus: '', processed_by_session_id: '', processed_by_apparatus: '',
    payload_json: { stage_node_id: 'print', gross_qty: 27, customer_name: 'QA Mijoz', lineage_fact: 'retain', start_resources: { raw_materials_available: true, raw_materials: [{ barcode: 'QA-ROLL-1', item_code: 'QA-PET-12', source_qty: 80 }] }, ...(scenario === 'layer' ? { origin: 'layer_remainder' } : {}) } });
  if (scenario === 'used') Object.assign(batch, { used_by_session_id: 'qa-passport-consumer', used_by_apparatus: 'apparatus:qa:laminate-1' });
  state.passportFixture = { batchIds: [batch.batch_id], staleIds: scenario === 'stale' ? [batch.batch_id] : [] };
  state.passportCorrections ??= []; state.passportPrintAttempts ??= []; state.rev++;
  return response({ ok: true, batch: clone(batch) });
}
export function fixturePassportReport(state, batch) {
  const scoped = state.wip.filter(row => row.order_id === batch.order_id && state.passportFixture?.batchIds.includes(row.batch_id)), batches = scoped.length ? scoped : [batch];
  const sessions = (state.assignmentSessions ?? []).filter(session => session.order_id === batch.order_id);
  const stale = state.passportFixture?.staleIds.includes(batch.batch_id) === true;
  return { ok: true, history_scope: 'batch_lineage', lineage_complete: true, is_stale: stale, stale_reason: stale ? 'fixture_superseded_batch' : '', scanned_batch: clone(batch),
    current_batch: stale ? null : clone(batch), current_batches: stale ? [] : [clone(batch)], progress_batches: clone(batches), lineage_edges: [], session_resources: [],
    corrections: clone((state.passportCorrections ?? []).filter(row => row.old_values.order_id === batch.order_id)),
    run_sessions: clone(sessions), active_sessions: clone(sessions.filter(row => ['active', 'paused', 'roll_detached', 'frozen'].includes(row.status))),
    logs: [], order: clone(state.orders.find(row => row.map.id === batch.order_id)?.map ?? { id: batch.order_id }), order_status: { lifecycle_status: 'in_progress', order_status: 'waiting_next_stage' }, queue_states: {}, opened_by: null };
}
function boundBatch(state, body) {
  const id = text(body?.progress_batch_id), qr = text(body?.qr_payload);
  return state.wip.find(row => (id ? row.batch_id === id : qr && row.qr_payload === qr) && (!qr || row.qr_payload === qr));
}
function openingRecord(state, body) {
  for (const saved of state.openingWip) {
    const batch = saved.batches.find(row => row.qr_payload === body?.qr_payload && (!body.batch_id || row.batch_id === body.batch_id));
    if (batch && saved.intake.status === 'confirmed' && batch.wip_status !== 'void') return { saved, batch };
  }
  return null;
}
function printReceipt(state, body, batch, intake) {
  if (!Number.isSafeInteger(body.print_count) || body.print_count < 1 || body.print_count > 100 || !text(body.printer) || !text(body.print_mode)) return error(400, 'progress_input_invalid');
  const print = { ok: true, status: 'prepared', qr_payload: batch.qr_payload, item_code: batch.label_item_code, item_name: batch.label_item_name,
    apparatus: intake ? intake.source_apparatus || intake.entry_apparatus : batch.apparatus,
    apparatus_display_name: '', customer_name: batch.payload_json?.customer_name ?? 'QA Mijoz', executor_name: batch.executor_name ?? intake?.actor?.display_name ?? '',
    qty: batch.finished_goods_meter ?? batch.produced_qty ?? batch.finished_goods_kg, gross_qty: intake ? batch.finished_goods_kg : batch.payload_json?.gross_qty ?? batch.finished_goods_kg ?? batch.produced_qty,
    unit: 'kg', progress_unit: intake ? 'm' : batch.uom || 'm', label_kind: 'progress', printer: text(body.printer).toLowerCase(), print_mode: text(body.print_mode).toLowerCase(), printer_status: 'client_usb_pending', print_count: body.print_count };
  print.apparatus_display_name = state.apparatus.find(row => row.apparatus_id === print.apparatus)?.display.display_name ?? print.apparatus;
  print.tare_enabled = Number(batch.bobina_kg) > 0; print.tare_kg = print.tare_enabled ? Math.min(batch.bobina_kg, print.gross_qty) : 0;
  state.passportPrintAttempts ??= []; state.passportPrintAttempts.push({ batch_id: batch.batch_id, transport: body.print_transport === 'offline' ? 'offline' : 'server', physicalPrintConfirmed: false });
  if (body.print_transport !== 'offline') return response({ ok: false, batch: clone(batch), print: { ok: false, status: 'failed', code: 'fixture_physical_print_not_supported', error: 'Synthetic fixture has no printer transport.' } });
  return response({ ok: true, batch: clone(batch), print });
}
export function passportFixtureRoute({ method, path, query, body, state, profile, requires, bump }) {
  const supported = ['/progress-qr/report', '/progress-qr/correct', '/progress-qr/reprint', '/opening-wip/qr-report', '/opening-wip/print'];
  const suffix = path.startsWith(base) ? path.slice(base.length) : '';
  if (!supported.includes(suffix)) return undefined;
  // Do not alter an existing v6 manufacturing/assignment report unless this
  // explicitly selected passport fixture owns the requested batch.
  const batch = suffix.startsWith('/progress-qr/') ? boundBatch(state, body) : null;
  if (suffix === '/progress-qr/report' && !state.passportFixture?.batchIds.includes(text(body?.progress_batch_id)) && !state.passportFixture?.batchIds.includes(batch?.batch_id)) return undefined;
  if (!requires('admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage', ...(suffix === '/progress-qr/reprint' ? ['werka.access'] : []))) return error(403, 'forbidden');
  if (method !== 'POST') return error(405, 'method_not_allowed');
  if (suffix === '/progress-qr/report' && !batch) return error(404, 'progress_batch_not_found');
  if (suffix === '/opening-wip/qr-report' || suffix === '/opening-wip/print') {
    if (suffix.endsWith('/print') && !requires('admin.access', 'production.map.manage')) return error(403, 'forbidden');
    const opening = openingRecord(state, body); if (!opening) return error(404, 'opening_wip_qr_not_found');
    if (suffix.endsWith('/qr-report')) return response({ ok: true, record: { intake: clone(opening.saved.intake), batches: [clone(opening.batch)] } });
    return printReceipt(state, body, opening.batch, opening.saved.intake);
  }
  if (suffix === '/progress-qr/correct') {
    const current = state.wip.find(row => row.batch_id === body?.batch_id);
    if (!current) return error(404, 'progress_batch_not_found');
    if (current.worker_ref !== profile.ref) return error(403, 'progress_batch_correction_forbidden');
    if (current.wip_status !== 'waiting' || ['used_by_session_id', 'used_by_apparatus', 'processed_by_session_id', 'processed_by_apparatus'].some(key => text(current[key])) || current.payload_json?.origin === 'layer_remainder' || current.order_id.startsWith('training-')) return error(409, 'progress_batch_correction_locked');
    if (body.expected_revision !== current.revision) return error(409, 'progress_batch_correction_conflict');
    if (!object(body) || Object.keys(body).some(key => !['batch_id', 'expected_revision', 'reason', ...editable].includes(key)) || !positive(body.produced_qty) || !text(body.uom) || !text(body.reason) || typeof body.description !== 'string' || fixturePassportMeasures.some(key => body[key] != null && !positive(body[key]))) return error(400, text(body?.reason) ? 'progress_input_invalid' : 'progress_batch_correction_reason_required');
    const fields = normalizedValues(body); if (same(fields, normalizedValues(current))) return error(409, 'progress_batch_correction_unchanged');
    const gross = fields.finished_goods_kg !== (current.finished_goods_kg ?? null) ? fields.finished_goods_kg : current.payload_json?.gross_qty ?? current.finished_goods_kg;
    if (Number(fields.bobina_kg) > Number(gross)) return error(400, 'bobina_exceeds_gross');
    const old = clone(current), payload = { ...current.payload_json, ...clone(fields), correction_revision: current.revision + 1 };
    if (fields.finished_goods_kg !== (current.finished_goods_kg ?? null)) payload.gross_qty = fields.finished_goods_kg;
    Object.assign(current, fields, { revision: current.revision + 1, payload_json: payload }); for (const key of editable) if (current[key] === null) delete current[key];
    state.passportCorrections ??= []; state.passportCorrections.push({ batch_id: current.batch_id, previous_revision: old.revision, new_revision: current.revision, reason: text(body.reason), actor: { role: profile.role, ref: profile.ref, display_name: profile.display_name }, old_values: old, new_values: clone(current), created_at_unix: 1791892900 + state.rev });
    bump(); return response({ ok: true, batch: clone(current) });
  }
  if (!batch) return error(404, 'progress_batch_not_found');
  if (suffix === '/progress-qr/report') return response(fixturePassportReport(state, batch));
  if (!['admin', 'werka', 'aparatchi'].includes(profile.role) && batch.worker_ref !== profile.ref) return error(403, 'forbidden');
  if (batch.payload_json?.origin === 'layer_remainder') return error(409, 'progress_batch_correction_locked');
  return printReceipt(state, body, batch);
}
