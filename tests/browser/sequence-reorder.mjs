import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureLogin, fixtureToken, apparatusIds } from '../fixtures/erp-seed.mjs';
import { sequenceFixtureIds as ids } from '../fixtures/erp-sequence.mjs';

const web = 'http://127.0.0.1:5186', api = 'http://127.0.0.1:5199', path = '/v1/mobile/admin/production-maps/sequence';
const runId = new Date().toISOString().replace(/[:.]/g, '-'), output = fileURLToPath(new URL(`../../docs/qa/sequence-reorder/${runId}/`, import.meta.url));
const selected = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
const allowed = new Set([web, api]), outside = [], pageErrors = [], outcomes = [];
const sourceRevision = process.env.QA_SOURCE_REV || 'unrecorded', buildDirectory = process.env.QA_BUILD_DIR || 'unrecorded';
const redact = value => [fixtureLogin.phone, fixtureLogin.code, fixtureToken].reduce((text, value) => text.replaceAll(value, '[synthetic-credential]'), String(value));
const pkg = process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright';
const { chromium } = await import(pkg.startsWith('/') ? pathToFileURL(pkg).href : pkg);
let browser, page, context, outcome;
async function control(url, body) {
  assert.ok(url.startsWith('/__qa/')); const response = await fetch(api + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${url}: ${response.status}`); return response.json();
}
const writes = async () => (await control('/__qa/log')).requests.filter(row => row.path === path && row.method === 'POST');
const state = async () => (await control('/__qa/state')).state;
const queue = () => page.locator('[aria-label="Apparat navbatini tartiblash"]');
const row = id => queue().locator(`tr[data-order-id="${id}"]`);
const handle = id => row(id).getByRole('button', { name: /^Navbatni surish:/ });
const button = (name, root = page) => root.getByRole('button', { name, exact: true });
const dialog = () => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Navbat o‘rnini saqlash', exact: true }) });
async function until(get, predicate, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await get(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(label);
}
async function enabled(target) { await target.waitFor(); await until(() => target.isEnabled(), value => value, 'Control remained disabled'); return target; }
async function openQueue() {
  await page.goto(`${web}/app/orders?view=queue&apparatus=${encodeURIComponent(apparatusIds.print)}`);
  await handle(ids.c).waitFor(); await enabled(handle(ids.c));
}
async function drag(from, to) {
  await (await enabled(handle(from))).scrollIntoViewIfNeeded();
  const start = await handle(from).boundingBox(), target = await row(to).boundingBox(); assert.ok(start && target);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 - 12, { steps: 3 });
  await page.mouse.move(start.x + start.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up(); await dialog().waitFor();
}
async function save() { await (await enabled(button('Navbatni saqlash', dialog()))).click(); await dialog().waitFor({ state: 'hidden' }); }
async function frames() { await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }); }
async function keyboardTrace(label) {
  outcome.keyboardTrace ??= []; outcome.keyboardTrace.push({ label, rows: await queue().locator('tr[data-order-id]').evaluateAll(rows => rows.map(row => ({ id: row.dataset.orderId, dragging: row.dataset.dragging, style: row.getAttribute('style'), pressed: row.querySelector('button')?.getAttribute('aria-pressed') }))), live: await page.locator('[aria-live]').allTextContents() });
}
async function expectOrder(expected) {
  await until(state, value => JSON.stringify(value.sequenceOverrides[apparatusIds.print]) === JSON.stringify(expected), 'Native queue order did not match expected');
  await until(async () => queue().locator('tr[data-order-id]').evaluateAll(rows => rows.map(row => row.dataset.orderId)), actual => JSON.stringify(actual.filter(id => ![ids.frozen, ids.rawFrozen].includes(id))) === JSON.stringify(expected.filter(id => id !== ids.hidden)), 'Displayed queue did not reconcile native receipt');
}
async function capture(label) {
  await page.evaluate(() => {
    let badge = document.getElementById('qa-sequence-demo'); if (!badge) { badge = document.createElement('div'); badge.id = 'qa-sequence-demo'; document.body.append(badge); }
    badge.textContent = 'DEMO · Sintetik · Apparat navbati'; Object.assign(badge.style, { position: 'fixed', bottom: '6px', right: '6px', zIndex: '2147483647', pointerEvents: 'none', padding: '3px 7px', border: '1px solid #737373', borderRadius: '4px', background: document.documentElement.classList.contains('dark') ? '#171717' : '#fff', color: document.documentElement.classList.contains('dark') ? '#d4d4d4' : '#171717', font: '500 10px/15px system-ui' });
  });
  const settling = await page.evaluate(async () => {
    const finite = () => document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))); let stable = 0, start = performance.now();
    while (stable < 2 && performance.now() - start < 2000) { await new Promise(requestAnimationFrame); stable = finite().length ? 0 : stable + 1; } return { settled: stable >= 2, remaining: finite().length };
  });
  const file = `${outcome.id}-${label}.png`; await page.screenshot({ path: output + file, fullPage: true });
  outcome.screenshots.push({ file, route: page.url(), viewport: page.viewportSize(), theme: await page.locator('html').getAttribute('class'), settling });
}
async function run(id, execute, options = {}) {
  if (selected && !selected.includes(id)) return;
  outcome = { id, status: 'running', screenshots: [] }; outcomes.push(outcome); const started = Date.now();
  try {
    await control('/__qa/reset', {}); await control('/__qa/sequence', {});
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', ...options });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (['data:', 'blob:', 'about:'].includes(url.protocol) || allowed.has(url.origin)) return route.continue(); outside.push({ case: id, origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient'); });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => { const url = new URL(socket.url()), origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`; if (allowed.has(origin)) socket.connectToServer(); else { outside.push({ case: id, origin, path: url.pathname }); socket.close({ code: 1008 }); } });
    page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push({ case: id, message: redact(error.message) }));
    await page.goto(web + '/kirish'); await page.getByLabel('Server manzili').fill(api); await page.getByLabel('Telefon raqami').fill(fixtureLogin.phone); await page.getByLabel('Kirish kodi', { exact: true }).fill(fixtureLogin.code); await button('Kirish').click(); await page.waitForURL(web + '/app/home');
    await openQueue(); await execute();
    const log = await control('/__qa/log'); outcome.requests = log.requests;
    assert.equal(outside.filter(entry => entry.case === id).length, 0); assert.deepEqual(pageErrors.filter(entry => entry.case === id), []);
    assert.deepEqual(log.requests.filter(entry => entry.error === 'fixture_route_not_implemented'), []);
    await capture('passed'); outcome.status = 'passed';
  } catch (error) {
    outcome.status = 'failed'; outcome.error = redact(error.stack || error.message);
    if (page && !page.isClosed()) try { await capture('failed'); } catch { /* Retain actual failure. */ }
    try { outcome.requests = (await control('/__qa/log')).requests; } catch { /* Retain actual failure. */ }
  } finally {
    outcome.durationMs = Date.now() - started; await context?.close(); context = null; page = null;
    await writeFile(output + 'results.json', JSON.stringify({ synthetic: true, productionVerified: false, runId, sourceRevision, buildDirectory, fixtureVersion: 9, web, api, outcomes, outside, pageErrors }, null, 2));
    process.stdout.write(`${outcome.status.toUpperCase()} ${id}${outcome.error ? ': ' + outcome.error.split('\n')[0] : ''}\n`);
  }
}

await mkdir(output, { recursive: true });
assert.equal((await control('/__qa/health')).fixtureVersion, 9);
browser = await chromium.launch({ headless: true });
try {
  await run('pointer-save-light', async () => {
    assert.equal(await handle(ids.running).isDisabled(), true); assert.equal(await handle(ids.paused).isDisabled(), true); assert.equal(await handle(ids.frozen).isDisabled(), true); assert.equal(await handle(ids.rawFrozen).isDisabled(), true);
    assert.equal(await row(ids.hidden).count(), 0); await capture('before');
    await drag(ids.c, ids.a); assert.equal((await writes()).length, 0); await capture('review'); await save();
    await expectOrder([ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]);
    const sent = await writes(); assert.equal(sent.length, 1); assert.deepEqual(Object.keys(sent[0].body).sort(), ['apparatus', 'before_order_id', 'expected_version', 'idempotency_key', 'order_id']); assert.equal(sent[0].body.before_order_id, ids.a);
  });
  await run('keyboard-save-dark', async () => {
    await button('Qorong‘i mavzu').click(); await page.locator('html.dark').waitFor();
    await handle(ids.c).focus(); await page.keyboard.press('Space');
    await until(() => handle(ids.c).getAttribute('aria-pressed'), value => value === 'true', 'Keyboard handle did not activate');
    await frames(); await keyboardTrace('picked'); await page.keyboard.press('ArrowUp'); await frames(); await keyboardTrace('up-one');
    await page.keyboard.press('ArrowUp'); await frames(); await keyboardTrace('up-two'); await page.keyboard.press('Space'); await frames(); await keyboardTrace('dropped'); await dialog().waitFor(); await save();
    await expectOrder([ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]);
    await until(() => handle(ids.c).evaluate(node => document.activeElement === node), value => value, 'Focus must return to the moved handle');
  });
  await run('arrow-save-repeated', async () => {
    await (await enabled(button('qa-4104: navbatda oldinga', row(ids.b)))).click(); await dialog().waitFor(); await save(); await expectOrder([ids.running, ids.paused, ids.b, ids.a, ids.c, ids.hidden]);
    await (await enabled(button('qa-4104: navbatda orqaga', row(ids.b)))).click(); await dialog().waitFor(); await save(); await expectOrder([ids.running, ids.paused, ids.a, ids.b, ids.c, ids.hidden]);
    const sent = await writes(); assert.equal(sent.length, 2); assert.notEqual(sent[0].body.idempotency_key, sent[1].body.idempotency_key); assert.notEqual(sent[0].body.expected_version, sent[1].body.expected_version);
  });
  await run('locked-barrier-clamp', async () => {
    await drag(ids.c, ids.running); await dialog().getByText(/eng yaqin ruxsat etilgan o‘rin/).waitFor(); await save(); await expectOrder([ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]);
    assert.equal((await writes())[0].body.before_order_id, ids.a);
  });
  await run('search-and-cancel-no-writes', async () => {
    await page.getByLabel('Navbatdan qidirish').fill('qa-4103'); assert.equal(await handle(ids.a).isDisabled(), true); await queue().getByText(/Qidirish paytida navbat o‘zgartirilmaydi/).waitFor();
    await page.getByLabel('Navbatdan qidirish').fill('none-matching'); await queue().getByRole('cell', { name: 'Qidiruvga mos buyurtma topilmadi.', exact: true }).waitFor();
    await page.getByLabel('Navbatdan qidirish').fill(''); await enabled(handle(ids.c));
    await handle(ids.c).focus(); await page.keyboard.press('Space'); await frames(); await page.keyboard.press('ArrowUp'); await frames(); await page.keyboard.press('Escape'); await frames(); assert.equal(await dialog().count(), 0);
    await drag(ids.c, ids.a); await button('Bekor qilish', dialog()).click(); assert.equal((await writes()).length, 0); assert.equal((await state()).sequenceOverrides[apparatusIds.print], undefined);
  });
  await run('fresh-version-conflict-before-write', async () => {
    await drag(ids.c, ids.a); await control('/__qa/order', { id: ids.a, stageStates: { print: 'paused' } }); await save();
    await queue().getByText(/Navbat yoki buyurtma holati o‘zgargan/).waitFor(); assert.equal((await writes()).length, 0); assert.equal(await handle(ids.a).isDisabled(), true);
    await (await enabled(button('qa-4105: navbatda oldinga', row(ids.c)))).click(); await save(); await expectOrder([ids.running, ids.paused, ids.a, ids.c, ids.b, ids.hidden]);
  });
  await run('single-loss-exact-auto-retry', async () => {
    await control('/__qa/config', { rules: [{ method: 'POST', path, once: true, dropResponse: true }] });
    await drag(ids.c, ids.a); await save(); await expectOrder([ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]);
    const sent = await writes(); assert.equal(sent.length, 2); assert.deepEqual(sent[0].body, sent[1].body); assert.equal((await state()).rev, 3);
  });
  await run('unknown-remount-read-recovery', async () => {
    await control('/__qa/config', { rules: [{ method: 'POST', path, dropResponse: true }] }); await drag(ids.c, ids.a); await save();
    await queue().getByText('Navbat buyrug‘i natijasi noaniq', { exact: true }).waitFor(); const original = await writes(); assert.equal(original.length, 2); assert.deepEqual(original[0].body, original[1].body);
    await control('/__qa/config', { rules: [] }); await button('Navbatni yangilash').click(); await enabled(button('Asl navbat buyrug‘i natijasini tekshirish')); assert.equal(await handle(ids.a).isDisabled(), true);
    await page.getByRole('tab', { name: 'Ro‘yxat', exact: true }).click(); await page.getByRole('tab', { name: 'Apparat navbati', exact: true }).click(); await queue().getByText('Navbat buyrug‘i natijasi noaniq', { exact: true }).waitFor();
    assert.equal((await writes()).length, 2); await button('Asl navbat buyrug‘i natijasini tekshirish').click(); await expectOrder([ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]);
    await until(writes, values => values.length === 3, 'Original-key recovery was not sent'); const recovered = await writes(); assert.deepEqual(recovered[2].body, original[0].body); await enabled(handle(ids.a)); assert.equal((await state()).rev, 3);
  });
  await run('interrupted-save-retains-command', async () => {
    await control('/__qa/config', { rules: [{ method: 'POST', path, once: true, delayMs: 500 }] }); await drag(ids.c, ids.a);
    const request = page.waitForRequest(req => req.url() === api + path && req.method() === 'POST'); await button('Navbatni saqlash', dialog()).click(); await request; await button('Yopish', dialog()).click();
    await queue().getByText('Navbat buyrug‘i natijasi noaniq', { exact: true }).waitFor(); await until(writes, values => values.length === 1, 'Interrupted native request did not complete');
    const first = (await writes())[0]; await button('Navbatni yangilash').click(); await enabled(button('Asl navbat buyrug‘i natijasini tekshirish')); await button('Asl navbat buyrug‘i natijasini tekshirish').click();
    await expectOrder([ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]); await enabled(handle(ids.a)); assert.equal((await writes()).length, 2); assert.deepEqual((await writes())[1].body, first.body); assert.equal((await state()).rev, 3);
  });
  await run('permission-refusal-no-commit', async () => {
    await drag(ids.c, ids.a); await control('/__qa/config', { capabilities: ['apparatus.queue.read', 'apparatus.queue.manage'] }); await save(); await queue().getByText('Bu amal uchun ruxsat berilmagan.', { exact: true }).waitFor();
    assert.equal((await writes()).length, 1); assert.equal((await state()).sequenceOverrides[apparatusIds.print], undefined); assert.equal((await writes())[0].status, 403);
  });
  await run('mobile-buttons-reduced-motion', async () => {
    const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); assert.ok(width.document <= width.viewport, 'Mobile document must not overflow horizontally');
    await (await enabled(button('qa-4104: navbatda oldinga', row(ids.b)))).click(); await save(); await expectOrder([ids.running, ids.paused, ids.b, ids.a, ids.c, ids.hidden]);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  }, { viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  await run('mobile-touch-drag', async () => {
    await handle(ids.c).scrollIntoViewIfNeeded(); const start = await handle(ids.c).boundingBox(), target = await row(ids.a).boundingBox(); assert.ok(start && target);
    const touch = await context.newCDPSession(page), x = start.x + start.width / 2, fromY = start.y + start.height / 2, toY = target.y + target.height / 2;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] });
    await until(() => handle(ids.c).getAttribute('aria-pressed'), value => value === 'true', 'Touch handle did not activate');
    for (let step = 1; step <= 10; step++) { await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: fromY + (toY - fromY) * step / 10 }] }); await frames(); }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach(); await dialog().waitFor(); await save(); await expectOrder([ids.running, ids.paused, ids.c, ids.a, ids.b, ids.hidden]);
    assert.equal((await writes()).length, 1);
  }, { viewport: { width: 390, height: 844 }, hasTouch: true });
  assert.ok(outcomes.length);
} finally { await browser?.close(); }
const failures = outcomes.filter(value => value.status !== 'passed');
process.stdout.write(`Queue browser acceptance: ${outcomes.length - failures.length}/${outcomes.length} passed. ${output}results.json\n`);
if (failures.length) process.exitCode = 1;
