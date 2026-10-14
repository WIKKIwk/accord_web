import { createHash } from 'node:crypto';
import { apparatusIds } from './erp-seed.mjs';

export const sequenceFixtureIds = { running: 'zakaz-qa-4101', paused: 'zakaz-qa-4102', a: 'zakaz-qa-4103', b: 'zakaz-qa-4104', c: 'zakaz-qa-4105', frozen: 'zakaz-qa-4106', rawFrozen: 'zakaz-qa-4107', hidden: 'zakaz-qa-4108' };
export function seedSequenceScenario(state) {
  const source = structuredClone(state.orders[0]);
  state.orders = Object.entries(sequenceFixtureIds).map(([kind, id]) => {
    const order = structuredClone(source), number = id.replace('zakaz-', '');
    Object.assign(order.map, { id, code: number, order_number: number, title: `DEMO ${kind === 'a' ? 'PET plyonka' : kind === 'b' ? 'PE plyonka' : kind === 'c' ? 'Laminat buyurtmasi' : kind === 'running' ? 'Ishdagi buyurtma' : kind === 'paused' ? 'To‘xtatilgan buyurtma' : kind.includes('Frozen') || kind === 'frozen' ? 'Muzlatilgan buyurtma' : 'Yakunlangan buyurtma'}`, customer_name: 'DEMO Mijoz' });
    order.template.id = `sequence-${number}`; order.template.source_map_id = id;
    order.stages = { print: kind === 'running' ? 'in_progress' : kind === 'paused' ? 'paused' : kind === 'rawFrozen' ? 'frozen' : kind === 'hidden' ? 'completed' : 'pending', laminate: kind === 'hidden' ? 'completed' : 'pending', cut: kind === 'hidden' ? 'completed' : 'pending' };
    order.control = kind === 'frozen' ? 'frozen' : 'active'; return order;
  });
  state.sequenceOverrides = {}; state.sequenceCohort = true; state.rev++;
  return { status: 200, body: { ok: true, synthetic: true, apparatus: apparatusIds.print, ids: sequenceFixtureIds } };
}
export function sequenceCohortSnapshot(state, current) {
  if (!state.sequenceCohort) return current;
  for (const [apparatus, canonical] of Object.entries(current.sequences)) {
    const frozen = Object.keys(current.queue_states[apparatus]).filter(id => current.order_controls[id]?.state === 'frozen' || current.queue_states[apparatus]?.[id] === 'frozen');
    const ids = canonical.filter(id => !frozen.includes(id)); current.sequences[apparatus] = ids;
    current.sequence_versions[apparatus] = createHash('sha256').update(JSON.stringify([apparatus, ids, ids.map(id => [id, current.queue_states[apparatus][id]]), [...frozen].sort()])).digest('hex');
  }
  return current;
}

/** Opt-in synthetic coverage of native move DTO/version/actor receipt/barriers. */
export function sequenceCohortMove(state, current, body, actor, idempotency, bump) {
  const fail = (status, error) => ({ status, body: { error } });
  const allowed = new Set(['apparatus', 'order_id', 'before_order_id', 'after_order_id', 'expected_version', 'idempotency_key']);
  if (!body || Object.keys(body).some(key => !allowed.has(key)) || typeof body.order_id !== 'string' || !body.order_id.trim() || typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim() || body.idempotency_key.length > 200 || !/^[a-f0-9]{64}$/.test(body.expected_version) || body.before_order_id && body.after_order_id || body.before_order_id === body.order_id || body.after_order_id === body.order_id) return fail(400, 'queue_reorder_invalid');
  const receiptKey = `sequence:${body.apparatus}:${actor.role}:${actor.ref}:${body.idempotency_key}`;
  const payload = JSON.stringify(body), prior = idempotency.get(receiptKey);
  if (prior) return prior.payload === payload ? { status: 200, body: structuredClone(prior.saved) } : fail(409, 'queue_reorder_idempotency_conflict');
  const ids = current.sequences[body.apparatus];
  if (!ids || current.sequence_versions[body.apparatus] !== body.expected_version) return fail(409, 'queue_reorder_conflict');
  if (!ids.includes(body.order_id) || current.queue_states[body.apparatus][body.order_id] !== 'pending') return fail(409, 'queue_reorder_blocked');
  const remaining = ids.filter(id => id !== body.order_id), anchor = body.before_order_id || body.after_order_id;
  if (anchor && !remaining.includes(anchor)) return fail(409, 'queue_reorder_conflict');
  const requested = anchor ? remaining.indexOf(anchor) + (body.after_order_id ? 1 : 0) : remaining.length;
  const lastBarrier = remaining.reduce((last, id, index) => ['in_progress', 'print_preflight', 'paused'].includes(current.queue_states[body.apparatus][id]) ? index : last, -1);
  const target = Math.max(requested, lastBarrier + 1), next = [...remaining]; next.splice(target, 0, body.order_id);
  state.sequenceOverrides[body.apparatus] = next; bump();
  // Retain frozen entries in the input to snapshot hashing, just as the native
  // version includes the frozen set despite excluding it from editable IDs.
  const frozen = state.orders.filter(order => order.map.nodes.some(node => node.apparatus_id === body.apparatus) && (order.control === 'frozen' || order.stages.print === 'frozen')).map(order => order.map.id);
  const version = createHash('sha256').update(JSON.stringify([body.apparatus, next, next.map(id => [id, current.queue_states[body.apparatus][id]]), [...frozen].sort()])).digest('hex');
  const result = { ok: true, order_ids: next, version, adjusted: target !== requested, epoch: state.epoch, revision: state.rev };
  idempotency.set(receiptKey, { payload, saved: structuredClone(result) }); return { status: 200, body: result };
}
