import { canonicalFixtureRoute, fixtureCanonicalRevision } from './erp-canonical.mjs';

const path = '/v1/mobile/admin/raw-material-rules', clone = value => structuredClone(value);
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const groups = value => Array.isArray(value) && value.length > 0 && value.every(reference) && new Set(value).size === value.length;
const ordinal = (a, b) => { const x = Array.from(a), y = Array.from(b); for (let i = 0; i < Math.min(x.length, y.length); i++) { const diff = x[i].codePointAt(0) - y[i].codePointAt(0); if (diff) return diff; } return x.length - y.length; };
function materialPolicy(value) {
  if (!object(value)) return null;
  if (value.mode === 'not_required' && Object.keys(value).every(key => ['mode', 'item_group_ids'].includes(key)) && (value.item_group_ids === undefined || Array.isArray(value.item_group_ids) && value.item_group_ids.length === 0 || groups(value.item_group_ids))) return { mode: value.mode, ...(value.item_group_ids?.length ? { item_group_ids: [...value.item_group_ids].sort(ordinal) } : {}) };
  if (value.mode === 'all_required' && Object.keys(value).every(key => ['mode', 'item_group_ids'].includes(key)) && groups(value.item_group_ids)) return { mode: value.mode, item_group_ids: [...value.item_group_ids].sort(ordinal) };
  if (value.mode !== 'requirement_sets' || Object.keys(value).some(key => !['mode', 'sets'].includes(key)) || !Array.isArray(value.sets) || !value.sets.length || new Set(value.sets.map(set => set?.requirement_id)).size !== value.sets.length) return null;
  const sets = [];
  for (const set of value.sets) {
    if (!object(set) || Object.keys(set).some(key => !['requirement_id', 'item_group_ids', 'minimum_required_count'].includes(key)) || !reference(set.requirement_id) || !groups(set.item_group_ids) || !Number.isSafeInteger(set.minimum_required_count) || set.minimum_required_count < 1 || set.minimum_required_count > Math.min(65535, set.item_group_ids.length)) return null;
    sets.push({ requirement_id: set.requirement_id, item_group_ids: [...set.item_group_ids].sort(ordinal), minimum_required_count: set.minimum_required_count });
  }
  return { mode: value.mode, sets: sets.sort((a, b) => ordinal(a.requirement_id, b.requirement_id)) };
}
function toolingPolicy(value) {
  if (!object(value)) return null;
  if (value.mode === 'not_required' && Object.keys(value).length === 1) return { mode: value.mode };
  if (value.mode === 'qolip_scan_required' && Object.keys(value).every(key => ['mode', 'tooling_class_id'].includes(key)) && reference(value.tooling_class_id)) return { mode: value.mode, tooling_class_id: value.tooling_class_id };
  return null;
}
export function seedRawRulesScenario(state) {
  if (!state.groups.some(row => row.name === 'Homashyo')) state.groups.push({ name: 'Homashyo', item_group_name: 'Homashyo', parent_item_group: 'All Item Groups', is_group: true });
  // Native web choices use direct Homashyo children. This setup is opt-in so
  // baseline catalog/group assertions retain their original hierarchy.
  for (const name of ['Xomashyo', 'QA Yangi guruh']) state.groups.find(row => row.name === name).parent_item_group = 'Homashyo';
  return response({ ok: true });
}
export function rawRulesFixtureRoute(context) {
  const { method, state, body, requires, headers } = context;
  if (context.path !== path) return undefined;
  if (!requires('raw_material.rule.manage')) return error(403, 'forbidden');
  if (method === 'GET') return response(state.apparatus.map(row => { const revision = fixtureCanonicalRevision(row); return { apparatus_id: row.apparatus_id, source_revision: row.source_revision, source_aasx_sha256: row.source_aasx_sha256, policy: clone(revision.policies.material), tooling: clone(revision.policies.tooling) }; }));
  if (method !== 'PUT') return error(405, 'method_not_allowed');
  if (!object(body) || Object.keys(body).some(key => !['apparatus_id', 'expected_revision', 'material', 'tooling'].includes(key))) return error(400, 'apparatus_revision_invalid');
  const material = materialPolicy(body.material), tooling = toolingPolicy(body.tooling);
  if (!material || !tooling) return error(400, 'apparatus_revision_invalid');
  const row = state.apparatus.find(row => row.apparatus_id === body.apparatus_id);
  if (!row) return error(404, 'apparatus_not_found');
  const canonical = fixtureCanonicalRevision(row);
  // This native endpoint authorizes raw_material.rule.manage, then calls the same
  // canonical patch service. It preserves all fields outside policies.
  return canonicalFixtureRoute({ ...context, method: 'PATCH', path: '/v1/mobile/admin/apparatus/' + body.apparatus_id, body: { expected_revision: body.expected_revision, patch: { policies: { queue: canonical.policies.queue, material, tooling } } }, headers, requires: () => true });
}
