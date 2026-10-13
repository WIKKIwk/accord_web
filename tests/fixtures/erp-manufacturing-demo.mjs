// Opt-in DEMO records in native API shape, never client-side chart fabrication.
export function fixtureManufacturingDemoCohort(state, { invalid = false } = {}) {
  const source = state.historicalMaps['zakaz-4001'], durations = [7200, 5400, 12600, 900, 10800, 3600, 8400, 1800], rows = [];
  const apparatus = Object.fromEntries(source.nodes.filter(node => node.kind === 'apparatus').map(node => [node.id, node.apparatus_id]));
  for (let index = 0; index < durations.length; index++) {
    const number = String(4002 + index), id = `zakaz-${number}`, title = `QA DEMO Buyurtma ${number}`;
    const map = { ...structuredClone(source), id, code: number, order_number: number, title };
    state.historicalMaps[id] = map;
    const logs = [], start = 1791892800 - (index + 1) * 86400, paused = 30 + index * 10, print = durations[index], laminate = Math.floor(print / 2) + 300, cut = 200 + index * 35;
    const event = (stage, action, from_state, to_state, at) => logs.push({ event_id: `qa-demo:${id}:${logs.length}`, order_id: id, apparatus: apparatus[stage], stage_node_id: stage, action, from_state, to_state, actor_role: 'aparatchi', actor_ref: 'qa-demo-operator', actor_display_name: 'QA DEMO Operator', created_at_unix: at, completed_with_issue: false });
    const pauseAt = start + Math.floor(print * .6), printEnd = start + print + paused, laminateStart = printEnd + 120, laminateEnd = laminateStart + laminate, cutStart = laminateEnd + 60, cutEnd = cutStart + cut;
    event('print', 'start', 'pending', 'in_progress', start); event('print', 'pause', 'in_progress', 'paused', pauseAt); event('print', 'resume', 'paused', 'in_progress', pauseAt + paused); event('print', 'complete', 'in_progress', 'completed', printEnd);
    event('laminate', 'start', 'pending', 'in_progress', laminateStart); event('laminate', 'complete', 'in_progress', 'completed', laminateEnd);
    event('cut', 'start', 'pending', 'in_progress', cutStart); event('cut', 'complete', 'in_progress', 'completed', cutEnd);
    rows.push({ order_id: id, order_number: number, title, completed_at_unix: cutEnd + 5, logs, progress_batches: [] });
  }
  if (invalid) {
    const id = 'zakaz-4099', title = 'QA DEMO Bosqichsiz tarix'; state.historicalMaps[id] = { ...structuredClone(source), id, code: '4099', order_number: '4099', title };
    rows.push({ order_id: id, order_number: '4099', title, completed_at_unix: 1791807200, progress_batches: [], logs: [
      { event_id: `qa-demo:${id}:0`, order_id: id, apparatus: apparatus.print, stage_node_id: '', action: 'start', from_state: 'pending', to_state: 'in_progress', actor_display_name: 'QA DEMO Operator', created_at_unix: 1791806400 },
      { event_id: `qa-demo:${id}:1`, order_id: id, apparatus: apparatus.print, stage_node_id: '', action: 'complete', from_state: 'in_progress', to_state: 'completed', actor_display_name: 'QA DEMO Operator', created_at_unix: 1791807000 },
    ] });
  }
  return rows;
}
