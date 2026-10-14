import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const productionPath = '/v1/mobile/admin/production-maps/order-image/view', templatePath = '/v1/mobile/calculate/orders/image/view', pendingPath = '/v1/mobile/admin/pending-orders/image';
const productionCaps = ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'];
const paths = new Set([productionPath, templatePath, pendingPath]);
const photos = Array.from({ length: 3 }, (_, i) => ({ full: readFileSync(new URL(`./order-images/qa-product-${i + 1}.webp`, import.meta.url)), thumb: readFileSync(new URL(`./order-images/qa-product-${i + 1}-thumb.webp`, import.meta.url)) }));
const ok = body => ({ status: 200, body }), error = (status, code) => ({ status, body: { error: code } });
const bytes = (body, cache, conditional) => { const etag = `"${createHash('sha256').update(body).digest('hex')}"`, unchanged = conditional?.split(',').some(tag => ['*', etag].includes(tag.trim().replace(/^W\//, ''))); return { status: unchanged ? 304 : 200, contentType: 'image/webp', headers: { 'Cache-Control': cache, ...(conditional !== null ? { ETag: etag, Vary: 'Authorization' } : {}) }, body: new Uint8Array(unchanged ? [] : body) }; };
export function orderImagesFixtureRoute({ method, path, query = {}, headers, state, profile, requires }) {
  const media = state.orderImagesFixture;
  if (media?.scenario === 'history' && method === 'GET' && (path.endsWith('/closed-orders') || path.endsWith('/completed-orders')) && !requires('admin.access', 'production.map.manage', 'apparatus.queue.read')) return error(403, 'forbidden');
  if (media?.scenario === 'history' && method === 'GET' && path.endsWith('/closed-orders')) return ok({ closed_orders: state.orders.slice(0, 2).map(order => ({ order_id: order.map.id, order_number: order.map.order_number, title: order.map.title, product_code: order.map.product_code, closed_by_display_name: 'QA Admin', completed_at_unix: 1791892800 })) });
  if (media?.scenario === 'history' && method === 'GET' && path.endsWith('/completed-orders')) return ok({ completed_orders: (profile.ref === 'qa-admin' ? state.orders.slice(0, 2) : []).map(order => ({ order_id: order.map.id, apparatus: 'apparatus:qa:print-1', status: 'completed', completed_at_unix: 1791892800, issue_note: '' })) });
  if (!paths.has(path)) return null;
  if (!requires(...(path === productionPath ? productionCaps : ['admin.access', 'production.map.manage']))) return error(403, 'forbidden');
  if (method !== 'GET') return error(405, 'method_not_allowed');
  let photo;
  if (path === productionPath) {
    if (typeof query.order_id !== 'string' || !query.order_id.trim()) return error(400, 'order_id kerak');
    // Native production query parsing is raw, with no percent decode.
    const raw = new URLSearchParams({ order_id: query.order_id.trim() }).toString().slice('order_id='.length).toLowerCase();
    const order = state.orders.find(order => order.map.id.toLowerCase() === raw);
    if (!order) return error(404, 'order topilmadi');
    photo = media?.orders[order.map.id];
    if (!photo || photo.kind === 'missing') return error(404, 'rasm topilmadi');
  } else if (path === templatePath) {
    if (typeof query.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(query.id)) return error(400, 'invalid_input');
    photo = media?.templates[query.id];
    if (!photo || photo.owner !== `${profile.role}:${profile.ref}`) return error(404, 'not_found');
  } else {
    if (typeof query.id !== 'string' || !state.pendingOrders.some(row => row.id === query.id)) return error(404, 'pending_order_not_found');
    photo = media?.pending[query.id];
    if (!photo) return error(404, 'pending_order_not_found');
    // This native route has no thumb/ETag contract and ignores variant.
    return bytes(photos[photo.index].full, 'private, no-cache', null);
  }
  if (photo.kind === 'unavailable') return { status: 404, contentType: 'application/octet-stream', body: new Uint8Array() };
  if (photo.kind === 'ambiguous') return error(404, 'legacy_lookup_unavailable');
  if (photo.kind === 'denied') return error(403, 'forbidden');
  const thumbnail = query.variant === 'thumb-v1';
  const body = thumbnail && photo.kind === 'broken' ? Buffer.from('RIFFxxxxWEBPbroken') : thumbnail && photo.kind !== 'oversized-thumb' ? photos[photo.index].thumb : photos[photo.index].full;
  return bytes(body, 'private, max-age=0, must-revalidate', headers['if-none-match']);
}
export function seedOrderImagesScenario(state, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return error(400, 'invalid_image_fixture');
  if (input.action === 'relink') {
    const entry = state.orderImagesFixture?.orders[input.order_id];
    if (!entry || !Number.isInteger(input.index) || input.index < 0 || input.index > 2) return error(400, 'invalid_image_fixture');
    entry.index = input.index; state.orders.find(row => row.map.id === input.order_id).map.image_id = `qa-photo-relinked-${input.index}`; state.rev++; return ok({ ok: true });
  }
  const scenario = input.scenario ?? 'mixed';
  if (Object.keys(input).some(key => key !== 'scenario') || !['mixed', 'long-list', 'queue', 'history', 'clean'].includes(scenario)) return error(400, 'invalid_image_fixture');
  const seed = structuredClone(state.orders[0]);
  if (scenario !== 'queue') state.orders = Array.from({ length: scenario === 'long-list' ? 200 : 8 }, (_, index) => {
    const order = structuredClone(seed), number = 1001 + index;
    order.map.id = `zakaz-qa-${number}`; order.map.order_number = `qa-${number}`; order.map.code = `qa-${number}`; order.map.title = `QA Film mahsuloti ${index % 3 + 1}`;
    order.template.id = `qa-image-order-${number}`; order.template.source_map_id = order.map.id; order.template.order_number = order.map.order_number; order.template.code = order.map.code;
    order.stages = { print: 'pending', laminate: 'pending', cut: 'pending' }; return order;
  });
  const orders = Object.fromEntries(state.orders.map((row, index) => {
    row.map.image_id = index === 1 ? '' : `qa-photo-${index % 3 + 1}`;
    return [row.map.id, { index: index % 3, kind: ['clean', 'queue', 'history', 'long-list'].includes(scenario) ? 'image' : ['image', 'image', 'missing', 'broken', 'oversized-thumb', 'ambiguous', 'unavailable', 'denied'][index % 8] }];
  }));
  state.templates[0].image_id = 'qa-template-photo';
  const pending = state.pendingOrders[0]; pending.template.image_id = 'private-unpublished-image';
  state.orderImagesFixture = { scenario, orders, templates: { 'qa-template-photo': { index: 0, kind: 'image', owner: 'admin:qa-admin' } }, pending: { [pending.id]: { index: 1, kind: 'image' } } };
  state.sequenceOverrides = {}; state.rev++; return ok({ ok: true, scenario, orders: state.orders.length });
}
