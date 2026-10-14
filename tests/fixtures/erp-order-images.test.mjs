import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken } from './erp-seed.mjs';
const production = '/v1/mobile/admin/production-maps/order-image/view', template = '/v1/mobile/calculate/orders/image/view', pending = '/v1/mobile/admin/pending-orders/image';
async function setup(scenario = 'clean') { const fixture = createFixture(), request = (method, url, body, headers = {}) => fixture.dispatch({ method, url, body, headers: { authorization: 'Bearer ' + fixtureToken, ...headers } }); await request('POST', '/v1/mobile/auth/login', fixtureLogin); await request('POST', '/__qa/order-images', { scenario }); return { fixture, request }; }
test('mounted native thumb/full contracts remain binary, distinct and read-only', async () => {
 const { fixture, request } = await setup(), before = fixture.getState().state;
 const thumb = await request('GET', production + '?order_id=zakaz-qa-1001&variant=thumb-v1'), full = await request('GET', production + '?order_id=zakaz-qa-1001');
 assert.equal(thumb.status, 200); assert.equal(full.status, 200); assert.equal(thumb.contentType, 'image/webp'); assert.ok(thumb.body instanceof Uint8Array); assert.ok(thumb.body.byteLength < full.body.byteLength); assert.notEqual(thumb.headers.ETag, full.headers.ETag); assert.equal(thumb.headers.Vary, 'Authorization'); assert.equal(thumb.headers['Cache-Control'], 'private, max-age=0, must-revalidate'); assert.deepEqual(fixture.getState().state, before);
 const unchanged = await request('GET', production + '?order_id=zakaz-qa-1001&variant=thumb-v1', undefined, { 'if-none-match': thumb.headers.ETag }); assert.equal(unchanged.status, 304); assert.equal(unchanged.body.byteLength, 0);
});
test('native production OR6 does not promote queue-manage or anonymous access', async () => {
 const { fixture, request } = await setup(); for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access']) { await request('POST', '/__qa/config', { capabilities: [capability] }); assert.equal((await request('GET', production + '?order_id=zakaz-qa-1001&variant=thumb-v1')).status, 200); }
 await request('POST', '/__qa/config', { capabilities: ['apparatus.queue.manage'] }); assert.equal((await request('GET', production + '?order_id=zakaz-qa-1001')).status, 403);
 assert.equal((await fixture.dispatch({ method: 'GET', url: production + '?order_id=zakaz-qa-1001', headers: {} })).status, 401);
});
test('legacy image absence in metadata and attacker hints never change order authority', async () => {
 const { request } = await setup(); const one = await request('GET', production + '?order_id=zakaz-qa-1002&variant=thumb-v1'), hinted = await request('GET', production + '?order_id=zakaz-qa-1002&image_id=other-private-image&variant=thumb-v1'); assert.equal(one.status, 200); assert.deepEqual(one.body, hinted.body);
 assert.equal((await request('GET', production + '?order_id=missing')).body.error, 'order topilmadi');
 assert.equal((await request('GET', production + '?order_id=zakaz-with%20space')).status, 404);
});
test('absent, unavailable, ambiguous and malformed images remain distinct from full availability', async () => {
 const { request } = await setup('mixed'); assert.equal((await request('GET', production + '?order_id=zakaz-qa-1003')).body.error, 'rasm topilmadi');
 const route = await request('GET', production + '?order_id=zakaz-qa-1007&variant=thumb-v1'); assert.equal(route.status, 404); assert.equal(route.body.byteLength, 0);
 assert.equal((await request('GET', production + '?order_id=zakaz-qa-1006')).body.error, 'legacy_lookup_unavailable');
 const broken = await request('GET', production + '?order_id=zakaz-qa-1004&variant=thumb-v1'), full = await request('GET', production + '?order_id=zakaz-qa-1004'); assert.equal(broken.status, 200); assert.ok(broken.body.byteLength < 32); assert.equal(full.status, 200); assert.ok(full.body.byteLength > 1000);
});
test('pending outer ID is full-only; template owner access is independently authorized', async () => {
 const { request } = await setup(); const one = await request('GET', pending + '?id=zakaz-2001'), variant = await request('GET', pending + '?id=zakaz-2001&variant=thumb-v1'); assert.equal(one.status, 200); assert.deepEqual(one.body, variant.body); assert.equal(one.headers.ETag, undefined); assert.equal(one.headers['Cache-Control'], 'private, no-cache');
 assert.equal((await request('GET', pending + '?id=qa-pending-template-2001')).status, 404);
 assert.equal((await request('GET', template + '?id=qa-template-photo&variant=thumb-v1')).status, 200);
 await request('POST', '/__qa/config', { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' } }); assert.equal((await request('GET', template + '?id=qa-template-photo')).status, 404);
 await request('POST', '/__qa/config', { capabilities: ['apparatus.queue.read'] }); assert.equal((await request('GET', pending + '?id=zakaz-2001')).status, 403);
});
test('long list supplies200 rows without eager image jobs; relink changes selected authoritative pixels', async () => {
 const { fixture, request } = await setup('long-list'), list = await request('GET', '/v1/mobile/admin/production-maps/sequence'); assert.equal(list.body.maps.length, 200); assert.equal(fixture.getLog().filter(row => row.path === production).length, 0);
 const first = await request('GET', production + '?order_id=zakaz-qa-1001&variant=thumb-v1'); await request('POST', '/__qa/order-images', { action: 'relink', order_id: 'zakaz-qa-1001', index: 2 }); const next = await request('GET', production + '?order_id=zakaz-qa-1001&image_id=old-hint&variant=thumb-v1'); assert.notEqual(first.headers.ETag, next.headers.ETag);
});
test('closed and completed media use current order identity and preserve existing composite fields', async () => {
 const { request } = await setup('history'); const closed = await request('GET', '/v1/mobile/admin/production-maps/closed-orders'), completed = await request('GET', '/v1/mobile/admin/production-maps/completed-orders'); assert.equal(closed.body.closed_orders.length, 2); assert.equal(completed.body.completed_orders.length, 2); assert.equal(completed.body.completed_orders[0].apparatus, 'apparatus:qa:print-1'); assert.equal((await request('GET', production + '?order_id=' + closed.body.closed_orders[0].order_id + '&variant=thumb-v1')).status, 200);
});
test('history list guards and actor scope remain narrower than production photo reads', async () => {
 const { request } = await setup('history'); await request('POST', '/__qa/config', { capabilities: ['raw_material.assign'] }); assert.equal((await request('GET', production + '?order_id=zakaz-qa-1001')).status, 200); assert.equal((await request('GET', '/v1/mobile/admin/production-maps/completed-orders')).status, 403);
 await request('POST', '/__qa/config', { capabilities: ['apparatus.queue.read'], profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' } }); assert.deepEqual((await request('GET', '/v1/mobile/admin/production-maps/completed-orders')).body.completed_orders, []);
});
