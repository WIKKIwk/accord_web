import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken, apparatusIds } from './erp-seed.mjs';
import { fixturePassportMeasures } from './erp-passport.mjs';
const base = '/v1/mobile/admin', pm = base + '/production-maps', order_id = 'zakaz-qa-1001';
async function setup() { const fixture = createFixture(); const request = (method, url, body, headers = {}) => fixture.dispatch({ method, url, body, headers: { authorization: 'Bearer ' + fixtureToken, ...headers } }); await request('POST', '/v1/mobile/auth/login', fixtureLogin); return { fixture, request }; }
test('integrated raw rules share actual canonical revision and explicit opt-in native group choices', async () => {
  const { request } = await setup(); assert.equal((await request('GET', '/__qa/health')).body.fixtureVersion, 10);
  await request('POST', '/__qa/raw-rules', {}); const groups = (await request('GET', base + '/item-groups/tree')).body;
  assert.ok(JSON.stringify(groups).includes('Homashyo')); const rules = (await request('GET', base + '/raw-material-rules')).body;
  const body = { apparatus_id: apparatusIds.print, expected_revision: rules[0].source_revision, material: { mode: 'all_required', item_group_ids: ['Xomashyo'] }, tooling: rules[0].tooling };
  const saved = await request('PUT', base + '/raw-material-rules', body, { 'Idempotency-Key': 'qa-integrated-rule' }); assert.equal(saved.status, 200); assert.equal(saved.body.runtime_projection.source_revision, 2);
  assert.equal((await request('GET', base + '/apparatus/' + encodeURIComponent(apparatusIds.print))).body.source_aasx_sha256, saved.body.aasx_sha256);
  assert.equal((await request('PUT', base + '/raw-material-rules', body, { 'Idempotency-Key': 'qa-integrated-rule' })).status, 409);
});
test('integrated applied-loss correction is proved by the full immutable audit without another correction', async () => {
  const { fixture, request } = await setup(); await request('POST', '/__qa/passport', { scenario: 'own' });
  const batch = fixture.getState().state.wip[0], body = { batch_id: batch.batch_id, expected_revision: batch.revision, produced_qty: batch.produced_qty, uom: batch.uom, description: 'QA changed passport', reason: 'QA measured correction', ...Object.fromEntries(fixturePassportMeasures.map(key => [key, batch[key] ?? null])) };
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: pm + '/progress-qr/correct', dropResponse: true, once: true }] });
  assert.equal((await request('POST', pm + '/progress-qr/correct', body)).dropResponse, true);
  const report = (await request('POST', pm + '/progress-qr/report', { progress_batch_id: batch.batch_id, qr_payload: batch.qr_payload })).body;
  assert.equal(report.scanned_batch.revision, 2); assert.deepEqual(report.corrections[0].old_values, batch); assert.equal(report.corrections[0].reason, body.reason); assert.equal(report.corrections[0].actor.ref, 'qa-admin');
  assert.equal(fixture.getLog().filter(row => row.path.endsWith('/correct')).length, 1); assert.equal(fixture.getLog().find(row => row.path.endsWith('/correct')).status, 'lost');
});
test('integrated laminate applied-loss recovery reads actor-scoped native immutable receipt and no invented queue fields', async () => {
  const { fixture, request } = await setup(); await request('POST', '/__qa/completion', { scenario: 'laminate' });
  const current = (await request('GET', pm + '/sequence')).body, apparatus = apparatusIds.laminate, control = current.queue_action_controls[apparatus][order_id];
  assert.equal(control.complete_requires_full_report, true); assert.equal(control.work_activity.worker_ref, 'qa-admin');
  const context = (await request('GET', pm + '/laminatsiya-astatka?order_id=' + order_id + '&apparatus=' + encodeURIComponent(apparatus))).body;
  const body = { action: 'complete', order_id, apparatus, session_id: context.session.session_id, request_id: 'web:qa-integrated-completion', full_completion_report_required: true, print_transport: 'offline', finished_goods_meter: 100, finished_goods_kg: 10, total_waste: 0, description: 'QA atomic completion',
    layer_remainders: context.sources.map(source => ({ source_kind: source.source_kind, source_id: source.source_id, expected_revision: source.revision, remaining_net_kg: 0 })), lamination_print_leftover_rolls: 0, lamination_film_leftover_rolls: 0 };
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: pm + '/laminatsiya-astatka', dropResponse: true, once: true }] });
  assert.equal((await request('POST', pm + '/laminatsiya-astatka', body)).dropResponse, true);
  const proof = (await request('GET', pm + '/laminatsiya-astatka?order_id=' + order_id + '&apparatus=' + encodeURIComponent(apparatus) + '&request_id=' + encodeURIComponent(body.request_id))).body.request_result;
  assert.equal(proof.request_id, body.request_id); assert.equal(proof.session.status, 'completed'); assert.equal(proof.progress_batches.length, 1); assert.equal(Object.hasOwn(proof, 'states'), false); assert.equal(Object.hasOwn(proof, 'progress_batch'), false);
  assert.equal((await request('GET', pm + '/sequence')).body.queue_states[apparatus][order_id], 'completed'); assert.equal(fixture.getLog().filter(row => row.method === 'POST' && row.path.endsWith('/laminatsiya-astatka')).length, 1);
});
test('integrated material scope/login and source lookup reconcile one unkeyed receipt with native enriched fields', async () => {
  const { fixture, request } = await setup(); await request('POST', '/__qa/material-intake', { scenario: 'intake' });
  await request('POST', '/__qa/config', { assignedApparatus: [apparatusIds.print] });
  const login = (await request('POST', '/v1/mobile/auth/login', fixtureLogin)).body; assert.deepEqual(login.assigned_apparatus, [apparatusIds.print]); assert.deepEqual(login.assigned_apparatus_labels, ['QA Flexo 1']);
  const snapshot = (await request('GET', pm + '/sequence')).body; assert.equal(snapshot.scope, ''); assert.equal(snapshot.queue_action_controls[apparatusIds.print][order_id].interaction.material_intake_allowed, true);
  await request('POST', '/__qa/config', { rules: [{ method: 'POST', path: base + '/raw-material-intake', dropResponse: true, once: true }] });
  const result = await request('POST', base + '/raw-material-intake', { order_id, apparatus: apparatusIds.print, barcode: 'QA-ROLL-1' }); assert.equal(result.dropResponse, true); assert.equal(Object.hasOwn(result.body, 'session'), false);
  const lookup = (await request('GET', base + '/raw-material-assignments/lookup?barcode=QA-ROLL-1')).body; assert.equal(lookup.status, 'in_use'); assert.equal(lookup.assignment.received_qty, 80); assert.equal(lookup.assignment.remaining_qty, 80); assert.equal(lookup.assignment.consumed_qty, 0); assert.equal(typeof lookup.source_receipt_id, 'string');
  assert.equal(fixture.getLog().filter(row => row.method === 'POST' && row.path.endsWith('/raw-material-intake')).length, 1);
});
