import assert from 'node:assert/strict';
import test from 'node:test';
import { rawRulesFixtureRoute } from './erp-raw-rules.mjs';
import { extensionHarness } from './erp-extension-harness.mjs';
import { fixtureCanonicalRevision } from './erp-canonical.mjs';
import { apparatusIds } from './erp-seed.mjs';

const path = '/v1/mobile/admin/raw-material-rules', key = { 'idempotency-key': 'qa-raw-policy:001' };
const body = (revision = 1, material = { mode: 'all_required', item_group_ids: ['Xomashyo'] }) => ({ apparatus_id: apparatusIds.print, expected_revision: revision, material, tooling: { mode: 'not_required' } });

test('raw policy reads bind native full canonical source identity and strict capability', () => {
  const api = extensionHarness(rawRulesFixtureRoute), rows = api.request('GET', path).body;
  assert.equal(rows.length, 5); assert.equal(rows[0].source_revision, 1); assert.match(rows[0].source_aasx_sha256, /^[a-f0-9]{64}$/); assert.deepEqual(rows[0].policy, { mode: 'not_required' });
  api.capabilities(['admin.access', 'production.map.manage']);
  assert.equal(api.request('GET', path).status, 403); assert.equal(api.request('PUT', path, body(), key).status, 403);
});

test('native raw policy patch preserves canonical runtime fields and queue with exact revision/command', () => {
  const api = extensionHarness(rawRulesFixtureRoute, { capabilities: ['raw_material.rule.manage'] }), row = api.state.apparatus[0], before = structuredClone(row), canonical = fixtureCanonicalRevision(row);
  const saved = api.request('PUT', path, body(), key);
  assert.equal(saved.status, 200); assert.equal(saved.body.revision.revision_metadata.command_id, 'apparatus-command:qa-raw-policy:001'); assert.equal(saved.body.revision.revision_metadata.actor_id, 'principal:qa-admin'); assert.equal(saved.body.revision.revision_metadata.source, 'admin');
  assert.equal(saved.body.revision.revision_metadata.revision, 2); assert.equal(saved.body.runtime_projection.source_aasx_sha256, saved.body.aasx_sha256); assert.notEqual(saved.body.aasx_sha256, before.source_aasx_sha256);
  for (const field of Object.keys(before).filter(field => !['source_revision', 'source_aasx_sha256'].includes(field))) assert.deepEqual(saved.body.runtime_projection[field], before[field]);
  assert.deepEqual(saved.body.revision.policies, { ...canonical.policies, material: body().material }); assert.equal(api.state.rev, 2);
});

test('raw policy native CAS never replays duplicate keys or stale requests', () => {
  const api = extensionHarness(rawRulesFixtureRoute); assert.equal(api.request('PUT', path, body(), key).status, 200);
  assert.equal(api.request('PUT', path, body(), key).status, 409); assert.equal(api.request('PUT', path, body(2, { mode: 'not_required' }), key).status, 409);
  assert.equal(api.request('PUT', path, body(), { 'idempotency-key': 'qa-raw-policy:002' }).status, 409);
  assert.equal(api.state.apparatus[0].source_revision, 2);
});

test('raw requirement sets normalize native ordering and enforce actual bounds/tooling profile', () => {
  const api = extensionHarness(rawRulesFixtureRoute);
  const policy = { mode: 'requirement_sets', sets: [{ requirement_id: 'z', item_group_ids: ['PET', 'PE'], minimum_required_count: 1 }, { requirement_id: 'a', item_group_ids: ['Xomashyo'], minimum_required_count: 1 }] };
  const result = api.request('PUT', path, body(1, policy), key); assert.equal(result.status, 200);
  assert.deepEqual(result.body.revision.policies.material.sets.map(set => set.requirement_id), ['a', 'z']); assert.deepEqual(result.body.revision.policies.material.sets[1].item_group_ids, ['PE', 'PET']);
  for (const invalid of [{ mode: 'all_required', item_group_ids: [] }, { mode: 'all_required', item_group_ids: ['PET', 'PET'] }, { mode: 'requirement_sets', sets: [{ requirement_id: 'a', item_group_ids: ['PET'], minimum_required_count: 2 }] }, { mode: 'not_required', invented: true }]) assert.equal(api.request('PUT', path, body(2, invalid), { 'idempotency-key': 'qa-invalid-rule' }).status, 400);
  assert.equal(api.request('PUT', path, { ...body(2), tooling: { mode: 'qolip_scan_required', tooling_class_id: 'tooling-class:qa' } }, { 'idempotency-key': 'qa-tooling-rule' }).status, 400);
  assert.equal(api.request('PUT', path, { ...body(2), extra: true }, { 'idempotency-key': 'qa-extra-rule' }).status, 400);
  assert.equal(api.request('DELETE', path).status, 405);
});

test('retired raw apparatus remains identifiable and rejects further rule mutations', () => {
  const api = extensionHarness(rawRulesFixtureRoute); api.state.apparatus[0].lifecycle = { state: 'retired', retirement_reason: 'Synthetic shutdown' };
  assert.equal(api.request('PUT', path, body(), key).body.error, 'apparatus_retired'); assert.equal(api.request('GET', path).body[0].apparatus_id, apparatusIds.print);
});
