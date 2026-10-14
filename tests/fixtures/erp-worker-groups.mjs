import { apparatusIds } from './erp-seed.mjs';

// Pure synthetic projection of workers_profiles.rs + worker_groups normalize/store.
// No listener, database or network access. Groups have no DELETE/CAS/idempotency contract.
export const workerGroupsPath = '/v1/mobile/admin/worker-groups';
const base = '/v1/mobile/admin', clone = value => structuredClone(value), text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const response = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const canonical = value => typeof value === 'string' && value.length <= 128 && /^apparatus:[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(value);
const days = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const active = worker => worker.active !== false && worker.blocked !== true;
const workerDto = worker => ({ id: worker.id, name: worker.name, phone: worker.phone || '', level: worker.level });
const identity = value => JSON.stringify([value.apparatus_id, value.group_code]);
function groupCode(value) {
  const code = text(value).split(/\s+/u).join(' ').toUpperCase();
  return code && Buffer.byteLength(code, 'utf8') <= 64 && /^[\p{L}\p{N} ]+$/u.test(code) ? code : null;
}
function time(value, fallback) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text(value) || fallback);
  return match && Number(match[1]) <= 23 && Number(match[2]) <= 59 ? `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}` : null;
}
function hydrate(state, group) {
  return { ...clone(group), workers: group.worker_ids.flatMap(id => { const worker = state.workers.find(row => row.id === id && active(row)); return worker ? [workerDto(worker)] : []; }) };
}
export function workerGroupProfileGroups(state, workerId) {
  return (state.workerGroups || []).filter(group => group.worker_ids.includes(text(workerId))).map(group => hydrate(state, group));
}
function normalized(state, body) {
  if (!object(body) || typeof body.group_code !== 'string' || ['apparatus', 'shift', 'start_time', 'end_time', 'start_day'].some(key => body[key] !== undefined && typeof body[key] !== 'string')
    || body.work_days_per_week !== undefined && !Number.isSafeInteger(body.work_days_per_week) || body.accounting_enabled !== undefined && typeof body.accounting_enabled !== 'boolean'
    || body.worker_ids !== undefined && (!Array.isArray(body.worker_ids) || body.worker_ids.some(id => typeof id !== 'string'))
    || ['previous_apparatus_id', 'previous_group_code'].some(key => body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string')) return error(400, 'invalid_json');
  // Handler validates exact active IDs before normalization/deduplication.
  const requested = [...new Set((body.worker_ids || []).map(text).filter(Boolean))];
  if (requested.some(id => !state.workers.some(worker => worker.id === id && active(worker)))) return error(400, 'worker not found');
  if (!body.apparatus_id) return error(400, 'apparatus is required');
  if (!canonical(body.apparatus_id) || body.previous_apparatus_id != null && !canonical(body.previous_apparatus_id)) return error(400, 'apparatus id is invalid');
  const group_code = groupCode(body.group_code), previous_group_code = body.previous_group_code == null ? null : groupCode(body.previous_group_code);
  if (!group_code || body.previous_group_code != null && !previous_group_code) return error(400, 'worker group is invalid');
  const shift = text(body.shift) || 'kunduz';
  if (Buffer.byteLength(shift, 'utf8') > 64) return error(400, 'worker shift is invalid');
  const start_time = time(body.start_time, '08:00'), end_time = time(body.end_time, '20:00'), work_days_per_week = body.work_days_per_week === 0 ? 6 : body.work_days_per_week ?? 6;
  const start_day = text(body.start_day).toLowerCase() || 'monday';
  if (!start_time || !end_time || work_days_per_week < 1 || work_days_per_week > 7 || !days.has(start_day)) return error(400, 'worker schedule is invalid');
  const seen = new Set(), worker_ids = requested.filter(id => { const key = id.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  return { next: { apparatus_id: body.apparatus_id, apparatus: text(body.apparatus), group_code, shift, start_time, end_time, work_days_per_week, start_day, accounting_enabled: body.accounting_enabled ?? false, worker_ids },
    previous: { apparatus_id: body.previous_apparatus_id ?? body.apparatus_id, group_code: previous_group_code ?? group_code }, hasPrevious: body.previous_apparatus_id != null || body.previous_group_code != null };
}
function upsert(state, body) {
  const parsed = normalized(state, body); if (parsed.status) return parsed;
  const { next, previous, hasPrevious } = parsed, groups = state.workerGroups || [];
  if (hasPrevious && !groups.some(group => identity(group) === identity(previous))) return error(400, 'worker group was not found');
  if (hasPrevious && groups.some(group => identity(group) === identity(next) && identity(group) !== identity(previous))) return error(400, 'worker group name already exists');
  // Native unkeyed create replaces the exact same identity. Frontend must guard it.
  const remaining = groups.filter(group => identity(group) !== identity(hasPrevious ? previous : next)), assigned = new Set(remaining.flatMap(group => group.worker_ids.map(id => id.toLowerCase())));
  if (next.worker_ids.some(id => assigned.has(id.toLowerCase()))) return error(400, 'worker is duplicated in worker groups');
  state.workerGroups = [...remaining, next].sort((a, b) => a.apparatus_id.localeCompare(b.apparatus_id) || a.group_code.localeCompare(b.group_code));
  return response(hydrate(state, next));
}
export function workerGroupFixtureRoute({ method, path, query = {}, body, state, requires, bump }) {
  if (state.workerGroupFixture && method === 'GET' && [base + '/workers', base + '/workers/detail'].includes(path)) {
    if (!requires('admin.access')) return error(403, 'forbidden');
    if (path.endsWith('/detail')) {
      if (!text(query.id)) return error(400, 'worker id is required');
      const worker = state.workers.find(row => row.id === text(query.id) && active(row));
      return worker ? response({ ...workerDto(worker), avatar_url: '/__qa/avatar?token=QA-SYNTHETIC-GROUP-TOKEN', code: 'QA-GROUP-DETAIL-ONLY', code_locked: false, code_retry_after_sec: 0 }) : error(404, 'worker not found');
    }
    const role = text(query.role).toLowerCase(); if (role && !['worker', 'ishchi', 'aparatchi', 'apparatchi'].includes(role)) return response([]);
    const q = text(query.q).toLowerCase(), rawLimit = Number(query.limit), limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.trunc(rawLimit)) : 50;
    return response(state.workers.filter(active).filter(worker => !q || [worker.name, worker.phone, worker.level].some(value => String(value || '').toLowerCase().includes(q)))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)).slice(0, limit).map(workerDto));
  }
  if (path !== workerGroupsPath) return null;
  if (!requires('admin.access')) return error(403, 'forbidden');
  if (method === 'GET') {
    if (query.apparatus_id && !canonical(query.apparatus_id)) return error(400, 'apparatus id is invalid');
    return response((state.workerGroups || []).filter(group => !query.apparatus_id || group.apparatus_id === query.apparatus_id).map(group => hydrate(state, group)));
  }
  if (method === 'PUT') { const result = upsert(state, body); if (result.status === 200) bump?.(); return result; }
  return error(405, 'method_not_allowed');
}
function seedGroup(state, apparatusId, code, workerIds) {
  return { apparatus_id: apparatusId, apparatus: state.apparatus.find(row => row.apparatus_id === apparatusId)?.display.display_name || '', group_code: code, shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6, start_day: 'monday', accounting_enabled: false, worker_ids: workerIds };
}
export function seedWorkerGroupScenario(state, input = {}) {
  if (!object(input)) return error(400, 'invalid_worker_group_fixture');
  if (input.action === 'concurrent') {
    if (!state.workerGroupFixture || Object.keys(input).some(key => !['action', 'apparatus_id', 'group_code', 'patch'].includes(key)) || !object(input.patch)
      || Object.keys(input.patch).some(key => !['apparatus_id', 'apparatus', 'group_code', 'shift', 'start_time', 'end_time', 'work_days_per_week', 'start_day', 'accounting_enabled', 'worker_ids'].includes(key))) return error(400, 'invalid_worker_group_fixture');
    const original = (state.workerGroups || []).find(row => row.apparatus_id === input.apparatus_id && row.group_code === input.group_code);
    if (!original) return error(404, 'worker_group_fixture_not_found');
    const result = upsert(state, { ...original, ...clone(input.patch), previous_apparatus_id: original.apparatus_id, previous_group_code: original.group_code });
    if (result.status === 200) state.rev++; return result;
  }
  if (input.action === 'deactivate') {
    if (!state.workerGroupFixture || Object.keys(input).some(key => !['action', 'worker_id'].includes(key))) return error(400, 'invalid_worker_group_fixture');
    const worker = state.workers.find(row => row.id === input.worker_id); if (!worker) return error(404, 'worker_group_fixture_not_found');
    worker.active = false; worker.blocked = true;
    state.workerGroups = (state.workerGroups || []).map(group => ({ ...group, worker_ids: group.worker_ids.filter(id => id.toLowerCase() !== worker.id.toLowerCase()) }));
    state.rev++; return response({ ok: true });
  }
  const scenario = input.scenario ?? 'empty';
  if (Object.keys(input).some(key => key !== 'scenario') || !['empty', 'groups', 'bounded-workers', 'empty-workers', 'empty-apparatus'].includes(scenario)) return error(400, 'invalid_worker_group_fixture');
  state.workerGroups = scenario === 'groups' ? [seedGroup(state, apparatusIds.print, 'QA PRINT GROUP', ['qa-worker-1']), seedGroup(state, apparatusIds.laminate, 'QA LAMINATION GROUP', ['qa-worker-2'])] : [];
  state.workerGroupFixture = { scenario };
  if (scenario === 'bounded-workers') state.workers.push(...Array.from({ length: 505 }, (_, index) => ({ id: `qa-group-worker-${index}`, name: `QA Group Picker ${String(index).padStart(3, '0')}`, phone: '', level: 'Master', blocked: false })));
  if (scenario === 'empty-workers') state.workers.forEach(worker => { worker.active = false; worker.blocked = true; });
  if (scenario === 'empty-apparatus') state.apparatus.forEach(apparatus => { apparatus.lifecycle.state = 'retired'; });
  state.rev++; return response({ ok: true, scenario });
}
