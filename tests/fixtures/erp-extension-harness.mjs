import assert from 'node:assert/strict';
import { createSeed } from './erp-seed.mjs';

// Pure dispatch harness for extensions prepared while the browser fixture is
// frozen. No listener, HTTP request, token or filesystem mutation.
export function extensionHarness(route, changes = {}) {
  const state = createSeed(), profile = { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator', ...changes.profile };
  let capabilities = changes.capabilities ?? ['admin.access', 'production.map.manage', 'apparatus.queue.manage', 'apparatus.queue.read', 'raw_material.rule.manage', 'inventory.movement.manage'];
  const equal = (left, right) => { try { assert.deepEqual(left, right); return true; } catch { return false; } };
  const requires = (...codes) => codes.some(code => capabilities.includes(code));
  const findOrder = id => state.orders.find(order => order.map.id === id);
  const bump = () => { state.rev++; };
  const compile = map => ({ operations: map.nodes.filter(node => node.kind === 'apparatus').map(node => ({ node_id: node.id, apparatus_id: node.apparatus_id })) });
  const request = (method, path, body, headers = {}) => {
    const url = new URL(path, 'http://127.0.0.1:5199');
    return route({ method, path: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), body, headers, state, requires, profile, bump, equal, compile, findOrder, config: { assignedApparatus: changes.assignedApparatus ?? [] } });
  };
  return { state, profile, request, capabilities: next => { capabilities = next; } };
}
