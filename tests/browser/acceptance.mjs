import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureLogin, fixtureSecondLogin, fixtureToken, fixtureSecondToken, apparatusIds } from '../fixtures/erp-seed.mjs';
import { fixtureApparatusAasx, fixtureAasxMime, fixtureBytesHash } from '../fixtures/erp-canonical.mjs';
import { runWorkflowExtensions } from './workflow-extensions.mjs';
import { runMaterialLinkAcceptance } from './material-link.mjs';

// Always a fresh official Chromium context: no native user browser/profile access.
const webOrigin = process.env.QA_WEB_ORIGIN || 'http://127.0.0.1:5186';
const apiOrigin = process.env.QA_API_ORIGIN || 'http://127.0.0.1:5199';
function loopbackOrigin(value, port) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === String(port) && url.pathname === '/' && !url.search && !url.hash, `Only loopback port ${port} is permitted`);
  return url.origin;
}
loopbackOrigin(webOrigin, 5186); loopbackOrigin(apiOrigin, 5199);
const allowed = new Set([new URL(webOrigin).origin, new URL(apiOrigin).origin]);
const output = fileURLToPath(new URL('../../docs/qa/synthetic-browser/', import.meta.url));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDirectory = `${output}/${runId}`;
const base = '/v1/mobile/admin';
const sourceRevision = process.env.QA_SOURCE_REV || 'unrecorded';
const buildDirectory = process.env.QA_BUILD_DIR || 'unrecorded';
let fixtureVersion;
const outcomes = [], blockedRequests = [], consoleErrors = [];
const selected = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',');
const redact = value => [fixtureLogin.phone, fixtureSecondLogin.phone, fixtureLogin.code, fixtureSecondLogin.code, fixtureSecondToken, fixtureToken]
  .reduce((message, credential) => message.replaceAll(credential, '[synthetic-credential]'), String(value));
let browser, page, context, currentCase;

async function control(path, body) {
  assert.ok(path.startsWith('/__qa/'), 'Only fixture control routes may be called by the runner');
  const result = await fetch(new URL(path, apiOrigin), { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await result.json();
  assert.ok(result.ok, `Fixture control ${path} returned ${result.status}: ${payload.error || 'unknown'}`);
  return payload;
}
async function state() { return (await control('/__qa/state')).state; }
async function waitState(predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  do { const current = await state(); if (predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
  throw new Error(message);
}
async function waitRequests(predicate, count, timeout = 10_000) {
  const end = Date.now() + timeout;
  do {
    const matches = (await control('/__qa/log')).requests.filter(predicate);
    if (matches.length >= count) { assert.equal(matches.length, count, 'Unexpected additional native request'); return matches; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < end);
  throw new Error('Expected completed native request log did not arrive');
}
async function screenshot(label) {
  const settled = await page.evaluate(async () => {
    const finite = () => document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
    const started = performance.now(), count = finite().length; let stableFrames = 0;
    while (performance.now() - started < 2000 && stableFrames < 2) { await new Promise(resolve => requestAnimationFrame(resolve)); stableFrames = finite().length ? 0 : stableFrames + 1; }
    return { finiteAnimationsAtStart: count, finiteAnimationsRemaining: finite().length, settled: stableFrames >= 2 };
  });
  outcomes.at(-1).screenshotSettling ??= []; outcomes.at(-1).screenshotSettling.push({ label, ...settled });
  const file = `${currentCase}-${label}.png`;
  await page.screenshot({ path: `${runDirectory}/${file}`, fullPage: true });
  outcomes.at(-1).screenshots.push(`${runId}/${file}`);
}
async function factorySelection(label, expected, { listVisible = true } = {}) {
  const trace = await page.evaluate(label => {
    const canvas = document.querySelector('canvas[data-factory-map-canvas]');
    const host = canvas?.closest('[data-model-viewer-state]');
    let renderer = {}; try { renderer = JSON.parse(host?.getAttribute('data-model-viewer-state') || '{}'); } catch { /* Record malformed state. */ }
    const list = document.querySelector('[aria-label="Xaritadagi apparatlar"]');
    return { label, canvasSelected: canvas?.getAttribute('data-selected-object-id'), hostSelected: renderer.selectedObjectId,
      hostFocused: renderer.focusedObjectId, busy: host?.getAttribute('aria-busy'), rendererInitialized: canvas?.getAttribute('data-renderer-initialized'),
      pressed: [...(list?.querySelectorAll('button[aria-pressed="true"]') || [])].map(button => button.textContent.trim()),
      selectedNotice: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent.trim()).filter(text => text.startsWith('Tanlangan apparat:')),
      fullscreen: Boolean(document.querySelector('[aria-label="To‘liq ekrandan chiqish"]')),
      focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
    };
  }, label);
  const outcome = outcomes.at(-1); outcome.selectionTrace ??= []; outcome.selectionTrace.push(trace);
  assert.equal(trace.canvasSelected, expected, `${label}: canvas selected key changed`);
  assert.equal(trace.hostSelected, expected, `${label}: viewer selected key changed`);
  assert.equal(trace.hostFocused, expected, `${label}: viewer focus key changed`);
  if (listVisible && expected) assert.equal(trace.pressed.length, 1, `${label}: exactly one list button must reflect selection`);
  return trace;
}
const button = (name, root = page) => root.getByRole('button', { name, exact: true });
const dialog = title => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
async function choose(label, option, root = page) {
  await root.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).last().click();
}
async function open(path) {
  await page.goto(`${webOrigin}${path}`, { waitUntil: 'domcontentloaded' });
}
async function login(credentials = fixtureLogin, { navigate = true } = {}) {
  if (navigate) await open('/kirish');
  await page.getByLabel('Server manzili').fill(apiOrigin);
  await page.getByLabel('Telefon raqami').fill(credentials.phone);
  await page.getByLabel('Kirish kodi', { exact: true }).fill(credentials.code);
  await button('Kirish').click();
  await page.waitForURL(`${webOrigin}/app/home`);
  await page.getByRole('heading', { name: 'Ish maydoni', exact: true }).waitFor();
}
async function enabled(target, timeout = 10_000) {
  await target.waitFor(); const end = Date.now() + timeout;
  while (await target.isDisabled()) { assert.ok(Date.now() < end, 'The expected action stayed disabled'); await new Promise(resolve => setTimeout(resolve, 100)); }
  return target;
}
async function openAsset(ref = 'qa-roll-1') {
  await open(`/app/assets?selected=${encodeURIComponent(JSON.stringify(['raw_material', ref]))}`);
  const controls = page.getByRole('region', { name: 'Inventar amallari', exact: true }); await controls.waitFor();
  return controls;
}
async function resourceLink(kind, title, moduleTitle) {
  const link = page.locator('a[data-sidebar="menu-sub-button"]').filter({ hasText: title }).and(page.locator('a[href="/app/' + kind + '"]'));
  if (!await link.isVisible()) await button(moduleTitle).click();
  await link.click(); await page.waitForURL(new RegExp(`/app/${kind}(?:\\?|$)`));
}
async function assetInSession(ref = 'qa-roll-1') {
  await resourceLink('assets', 'Inventar joylashuvi', 'Ombor');
  await page.getByRole('row').filter({ hasText: ref === 'qa-roll-1' ? 'QA-ROLL-1' : 'QA-ROLL-2' }).getByRole('button', { name: 'Inventar tafsiloti', exact: true }).click();
  const controls = page.getByRole('region', { name: 'Inventar amallari', exact: true }); await controls.waitFor(); return controls;
}
async function transferCreate() {
  const controls = await openAsset('qa-roll-2'); await (await enabled(button('Omborlararo transfer', controls))).click();
  const form = dialog('Omborlararo transfer'); await choose('Manzil', 'QA Tayyor mahsulot · Ombor', form);
  await button('Amalni tasdiqlash', form).click(); await button('Yangi amal', form).waitFor();
  const created = (await state()).inventoryTransfers[0]; assert.equal(created.status, 'requested');
  await button('Yopish', form).click(); await open('/app/assets'); await button('Ombor transferlari').click();
  const directory = dialog('Ombor transferlari'); await directory.getByRole('button', { name: new RegExp(created.id) }).click();
  return { id: created.id, directory, controls: directory.getByRole('region', { name: 'Transfer amallari', exact: true }) };
}
async function transferAction(transfer, label, nextStatus) {
  await (await enabled(button(label, transfer.controls))).click(); const form = dialog(label);
  await button('Amalni tasdiqlash', form).click(); await button('Yangi amal', form).waitFor();
  await waitState(data => data.inventoryTransfers.find(row => row.id === transfer.id)?.status === nextStatus, `Transfer failed to reach ${nextStatus}`);
  await button('Yopish', form).click(); await button('Yangi amal', transfer.controls).click();
}
async function apparatusSheet(id = apparatusIds.spare, { navigate = true } = {}) {
  if (navigate) await open('/app/apparatus');
  await page.getByRole('row').filter({ hasText: id }).getByRole('button', { name: 'Uskuna tafsiloti', exact: true }).click();
  await enabled(button('Apparatni tahrirlash'));
  return page.getByRole('dialog').filter({ has: page.getByText('Uskuna tafsiloti', { exact: true }) });
}
async function apparatusEditor(id = apparatusIds.spare) {
  await apparatusSheet(id); await button('Apparatni tahrirlash').click(); const form = dialog('Apparat profilini tahrirlash');
  await form.getByLabel('Apparat nomi', { exact: true }).waitFor(); return form;
}
async function orderAssignment(orderId = 'zakaz-qa-1001', { navigate = true } = {}) {
  if (navigate) await open('/app/orders');
  await page.getByRole('row').filter({ hasText: orderId.replace('zakaz-', '') }).getByRole('button', { name: 'Buyurtma tafsiloti', exact: true }).click();
  const controls = page.getByRole('region', { name: 'Bosqichni tayyorlash va ishni boshlash', exact: true }); await controls.waitFor(); return controls;
}
function assignmentStage(controls, label) { return controls.locator('div.rounded-md').filter({ has: page.getByText(label, { exact: true }) }); }
async function prepareAssignment(controls, label, action, fill) {
  await (await enabled(button(action, assignmentStage(controls, label)))).click(); const form = dialog(action);
  if (fill) await fill(form);
  await button('Kirish ma’lumotlarini tekshirish', form).click(); await form.getByText('Kirish ma’lumotlari tekshirildi', { exact: true }).waitFor(); return form;
}
async function reopenOrderAssignment(controls, orderId = 'zakaz-qa-1001') {
  await button('Close', page.getByRole('dialog').filter({ has: controls })).click(); return orderAssignment(orderId, { navigate: false });
}
async function saveNativeMap() {
  await button('O‘zgarishlarni saqlash').click();
  await button('Tasdiqlash', dialog('Xarita o‘zgarishlarini saqlash')).click();
}
async function nativeEditor() {
  await open('/app/map-editor?mapId=zakaz-qa-1001');
  await page.locator('#node-title').waitFor();
}
async function calculateLoaded(path, kg) {
  await open(path); await page.getByLabel('KG *', { exact: true }).waitFor();
  if (kg) await page.getByLabel('KG *', { exact: true }).fill(kg);
  await button('Hisoblash').click(); await page.getByText('Asosiy variant', { exact: true }).waitFor();
}
async function openingForm(rollCount = 2) {
  await open('/app/opening-wip'); await button('Boshlang‘ich WIP qabul qilish').click();
  const form = dialog('Boshlang‘ich WIP qabul qilish');
  await choose('Buyurtma', /qa-1001/, form); await choose('Chiqish apparati / bosqich', /^QA Flexo 1\b/, form);
  for (let index = 1; index < rollCount; index++) await button('Rulon qo‘shish', form).click();
  for (let index = 0; index < rollCount; index++) {
    await form.getByLabel('Uzunlik, m', { exact: true }).nth(index).fill(String(1000 - index * 100));
    await form.getByLabel('Tayyor mahsulot, kg', { exact: true }).nth(index).fill(String(40 - index * 5));
    await form.getByLabel('Bobina, kg', { exact: true }).nth(index).fill('1');
  }
  return form;
}
async function openPlanning(apparatus = apparatusIds.laminate) {
  await open(`/app/apparatus?selected=${encodeURIComponent(apparatus)}`); await button('Quvvat, navbat va ish vaqti').click();
  const editor = dialog('Apparat quvvati va navbati');
  await editor.getByLabel('Samaradorlik, %', { exact: true }).waitFor(); return editor;
}
async function run(id, execute, configure, contextOptions = {}) {
  if (selected && !selected.includes(id)) return;
  currentCase = id;
  const outcome = { id, status: 'running', screenshots: [], assertions: 'UI and synthetic server state', started: new Date().toISOString() };
  outcomes.push(outcome);
  const started = Date.now();
  try {
    await control('/__qa/reset', {});
    if (configure) await configure();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', ...contextOptions });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['data:', 'blob:', 'about:'].includes(url.protocol) || allowed.has(url.origin)) return route.continue();
      blockedRequests.push({ case: id, origin: url.origin, path: url.pathname });
      return route.abort('blockedbyclient');
    });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      const origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
      if (allowed.has(origin)) socket.connectToServer();
      else { blockedRequests.push({ case: id, origin, path: url.pathname }); socket.close({ code: 1008, reason: 'Outside isolated QA origins' }); }
    });
    page = await context.newPage();
    outcome.assetRequests = [];
    page.on('request', request => { const url = new URL(request.url()); if (/\.glb(?:\.gz)?$/.test(url.pathname)) outcome.assetRequests.push({ origin: url.origin, path: url.pathname }); });
    page.setDefaultTimeout(12_000); page.setDefaultNavigationTimeout(20_000);
    page.on('pageerror', failure => consoleErrors.push({ case: id, message: redact(failure.message) }));
    await login();
    await execute();
    const log = await control('/__qa/log');
    const unsupported = log.requests.filter(row => row.error === 'fixture_route_not_implemented');
    assert.deepEqual(unsupported, [], 'Unsupported fixture paths cannot count as accepted behavior');
    assert.equal(blockedRequests.filter(row => row.case === id).length, 0, 'An outside network request was blocked');
    assert.deepEqual(consoleErrors.filter(row => row.case === id), [], 'An uncaught browser page error cannot count as acceptance');
    outcome.requests = log.requests;
    await screenshot('passed');
    outcome.status = 'passed';
  } catch (failure) {
    outcome.status = 'failed'; outcome.error = redact(failure.stack || failure.message);
    if (page && !page.isClosed()) try { await screenshot('failed'); } catch (capture) { outcome.captureError = redact(capture.message); }
    try { outcome.requests = (await control('/__qa/log')).requests; } catch { /* Preserve the actual original failure. */ }
  } finally {
    outcome.durationMs = Date.now() - started;
    if (context) await context.close(); page = null; context = null;
    process.stdout.write(`${outcome.status.toUpperCase()} ${id}${outcome.error ? `: ${outcome.error.split('\n')[0]}` : ''}\n`);
    const report = JSON.stringify({ synthetic: true, productionVerified: false, runId, sourceRevision, buildDirectory, fixtureVersion, webOrigin, apiOrigin, outcomes, blockedRequests, consoleErrors }, null, 2);
    await writeFile(`${output}/results.json`, report); await writeFile(`${runDirectory}/results.json`, report);
  }
}

await mkdir(runDirectory, { recursive: true });
try {
  const health = await control('/__qa/health');
  assert.equal(health.synthetic, true, 'Refuse non-fixture API');
  assert.ok(health.fixtureVersion >= 8, 'Restart the local fixture to load native rule, passport, completion, intake and material-link contracts');
  fixtureVersion = health.fixtureVersion;
  const packagePath = process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright';
  const { chromium } = await import(packagePath.startsWith('/') ? pathToFileURL(packagePath).href : packagePath);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  await run('auth-dashboard-filters', async () => {
    const table = page.getByRole('table', { name: 'Buyurtmalar holati va ishlab chiqarish bosqichlari' });
    await table.getByRole('link', { name: 'qa-1003', exact: true }).waitFor();
    const filters = page.getByRole('group', { name: 'Buyurtmalar holati bo‘yicha filtr' });
    await button('E’tibor kerak', filters).click();
    await table.getByRole('link', { name: 'qa-1003', exact: true }).waitFor();
    assert.equal(await table.getByRole('link', { name: 'qa-1001', exact: true }).count(), 0);
    await button('Jarayonda', filters).click();
    await table.getByRole('link', { name: 'qa-1002', exact: true }).waitFor();
    await page.getByLabel('Buyurtma yoki mijozni qidirish').fill('QA-ABSENT');
    await table.getByRole('cell').filter({ hasText: 'Bu filtrga mos buyurtma topilmadi.' }).waitFor();
    assert.equal(await table.getByRole('link').count(), 0, 'Search left an unmatched order visible');
    await button('Filtrni tozalash').click();
    await table.getByRole('link', { name: 'qa-1001', exact: true }).waitFor();
  });

  await run('dashboard-unknown-empty', async () => {
    await page.getByText('1 ta buyurtma holati noma’lum', { exact: true }).waitFor();
    await screenshot('unknown');
    await control('/__qa/config', { emptyProduction: true, unknownOrderStatuses: [] });
    await button('Yangilash').first().click();
    const table = page.getByRole('table', { name: 'Buyurtmalar holati va ishlab chiqarish bosqichlari', exact: true });
    await table.getByRole('cell', { name: 'Hozircha buyurtmalar yo‘q.', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Joriy ishlab chiqarish ko‘rinishi', exact: true }).getByText('Hozircha buyurtmalar yo‘q.', { exact: true }).waitFor();
    assert.equal(await table.getByRole('link').count(), 0, 'Empty production retained a stale order');
  }, () => control('/__qa/config', { unknownOrderStatuses: ['zakaz-qa-1001'] }));

  await run('dashboard-loading-error', async () => {
    await page.getByText('Buyurtmalar yuklanmoqda…', { exact: true }).waitFor();
    await screenshot('loading');
    await page.getByRole('link', { name: 'qa-1002', exact: true }).waitFor();
    await control('/__qa/config', { rules: [{ method: 'GET', path: `${base}/production-maps/sequence`, status: 500, error: 'store_failed' }] });
    await button('Yangilash').first().click();
    await page.getByText('Ba’zi ma’lumotlar yangilanmadi', { exact: true }).waitFor({ timeout: 20_000 });
    await screenshot('server-error');
    await control('/__qa/config', { rules: [] });
    await button('Qayta urinish').first().click();
    await page.getByText('Ba’zi ma’lumotlar yangilanmadi', { exact: true }).waitFor({ state: 'hidden' });
  }, () => control('/__qa/config', { rules: [{ method: 'GET', path: `${base}/production-maps/sequence`, delayMs: 1800 }] }));

  await run('product-edit-blocked-delete', async () => {
    await open('/app/items?selected=QA-PET-12');
    await button('Tahrirlash').click();
    await dialog('Tahrirlash').getByLabel('Nomi', { exact: true }).fill('QA PET Edited');
    await button('Saqlash', dialog('Tahrirlash')).click();
    await waitState(data => data.items.some(row => row.code === 'QA-PET-12' && row.name === 'QA PET Edited'), 'Product rename did not persist');
    await dialog('Tahrirlash').waitFor({ state: 'hidden' });
    await control('/__qa/config', { blockedDeleteCodes: ['QA-PET-12'] });
    await button('O‘chirish').click();
    await button('Tasdiqlash', dialog('O‘chirish')).click();
    await dialog('O‘chirish').getByRole('alert').waitFor();
    assert.ok((await state()).items.some(row => row.code === 'QA-PET-12'), 'Blocked delete removed the item');
  });

  await run('product-partial-move-recovery', async () => {
    await open('/app/items?selected=QA-PE-50');
    await button('Guruhga ko‘chirish').click();
    await choose('Mahsulot guruhi', 'QA Yangi guruh', dialog('Guruhni o‘zgartirish'));
    await button('Saqlash', dialog('Guruhni o‘zgartirish')).click();
    await dialog('Guruhni o‘zgartirish').getByRole('alert').waitFor();
    assert.equal((await state()).items.find(row => row.code === 'QA-PE-50').item_group, 'Xomashyo');
    await screenshot('partial-refused');
    await control('/__qa/config', { partialMoveCodes: [] });
    await button('Saqlash', dialog('Guruhni o‘zgartirish')).click();
    await waitState(data => data.items.find(row => row.code === 'QA-PE-50').item_group === 'QA Yangi guruh', 'Explicit move recovery did not persist');
    await dialog('Guruhni o‘zgartirish').waitFor({ state: 'hidden' });
  }, () => control('/__qa/config', { partialMoveCodes: ['QA-PE-50'] }));

  await run('supplier-assign-unassign-restore', async () => {
    await open('/app/suppliers?selected=QA-SUPPLIER-1');
    await button('Biriktirish').click();
    await button('Mahsulot tanlang', dialog('Mahsulot biriktirish')).click();
    await page.getByRole('option', { name: /QA PE 50 mkm/ }).click();
    await button('Tasdiqlash', dialog('Mahsulot biriktirish')).click();
    await waitState(data => data.suppliers[0].assigned_item_codes.includes('QA-PE-50'), 'Supplier assignment did not persist');
    await page.getByRole('button', { name: 'QA PE 50 mkm biriktirishini olib tashlash', exact: true }).click();
    await button('Tasdiqlash', dialog('Biriktirishni olib tashlash')).click();
    await waitState(data => !data.suppliers[0].assigned_item_codes.includes('QA-PE-50'), 'Supplier unassignment did not persist');
    await button('O‘chirish').click(); await button('Tasdiqlash', dialog('O‘chirish')).click();
    await waitState(data => data.suppliers[0].removed, 'Supplier removal did not persist');
    await open('/app/suppliers?inactive=true&selected=QA-SUPPLIER-1');
    await button('Tiklash').click(); await button('Tasdiqlash', dialog('Tiklash')).click();
    await waitState(data => !data.suppliers[0].removed, 'Supplier restoration did not persist');
  });

  await run('worker-role-assignment', async () => {
    await open('/app/workers?selected=qa-worker-2');
    await button('Rol va ruxsat doirasi').click();
    await choose('Rol', 'QA Kuzatuvchi', page.getByRole('dialog').last());
    await button('Saqlash', page.getByRole('dialog').last()).click();
    await waitState(data => data.roleAssignments.some(row => row.principal_ref === 'qa-worker-2' && row.role_id === 'qa-observer'), 'Role assignment used the wrong principal');
  });

  await run('native-map-unsaved-cancel', async () => {
    await nativeEditor(); await page.locator('#node-title').fill('QA Unsaved title');
    await page.getByText('Saqlanmagan tahrir', { exact: true }).waitFor();
    await button('Bekor qilish').first().click();
    await dialog('Saqlanmagan tahrirlarni bekor qilish').waitFor();
    await screenshot('discard-confirmation');
    await button('Tahrirlashda qolish', dialog('Saqlanmagan tahrirlarni bekor qilish')).click();
    assert.equal(await page.locator('#node-title').inputValue(), 'QA Unsaved title');
    await button('Bekor qilish').first().click();
    await button('Tahrirlarni bekor qilish', dialog('Saqlanmagan tahrirlarni bekor qilish')).click();
    await page.waitForURL(/\/app\/orders\?selected=zakaz-qa-1001$/);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PUT').length, 0);
  });

  await run('native-map-conflict', async () => {
    await nativeEditor(); await page.locator('#node-title').fill('QA Conflicting local title');
    await control('/__qa/order', { id: 'zakaz-qa-1001', nodePatch: { id: 'cut', x: 900 } });
    await saveNativeMap();
    await page.getByText(/Xarita boshqa oynada o‘zgargan/).first().waitFor();
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PUT').length, 0);
    assert.equal(await page.locator('#node-title').inputValue(), 'QA Conflicting local title');
  });

  await run('native-map-lost-response', async () => {
    await nativeEditor(); await page.locator('#node-title').fill('QA Saved through lost response');
    await control('/__qa/config', { rules: [{ method: 'PUT', path: `${base}/production-maps`, dropResponse: true, once: true }] });
    await saveNativeMap();
    await page.getByText('Saqlash natijasi tekshirilishi kerak', { exact: true }).waitFor();
    await screenshot('uncertain');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await button('Saqlash holatini tekshirish').click();
    await page.waitForURL(/\/app\/orders\?selected=zakaz-qa-1001$/);
    const current = await state();
    assert.equal(current.orders[0].map.nodes.find(node => node.id === 'order').title, 'QA Saved through lost response');
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PUT' && row.path === `${base}/production-maps`).length, 1, 'Recovery replayed the native PUT');
  });

  await run('factory-map-selection-search-fullscreen', async () => {
    await open('/app/factory-map');
    const list = page.getByLabel('Xaritadagi apparatlar', { exact: true });
    await list.getByRole('button', { name: /QA Flexo 1/ }).first().waitFor({ timeout: 45_000 });
    await list.getByRole('button', { name: /QA Flexo 1/ }).first().click();
    await page.getByText(/Tanlangan apparat: QA Flexo 1/).waitFor();
    const renderer = page.locator('[data-model-viewer-state][aria-busy="false"]');
    const canvas = renderer.locator('canvas[data-factory-map-canvas][tabindex="0"]');
    await canvas.waitFor({ timeout: 45_000 });
    await factorySelection('before-search', 'node:1:instance:0');
    await screenshot('selection');
    await page.getByLabel('Xaritadagi apparat yoki buyurtmani qidirish').fill('QA-NO-OBJECT');
    await page.getByText('Bu qidiruv yoki filtrga mos apparat topilmadi.', { exact: true }).waitFor();
    await factorySelection('after-search', 'node:1:instance:0', { listVisible: false });
    await page.getByRole('button', { name: 'Apparat qidiruvini tozalash', exact: true }).click();
    await list.getByRole('button', { name: /QA Flexo 1/ }).first().waitFor();
    await factorySelection('after-clear-search', 'node:1:instance:0');
    await page.getByRole('button', { name: 'To‘liq ekran', exact: true }).click();
    await page.getByRole('button', { name: 'To‘liq ekrandan chiqish', exact: true }).waitFor();
    await screenshot('fullscreen');
    assert.ok((await canvas.boundingBox())?.width > 0, 'Bundled CAD canvas was not visible in fullscreen');
    await factorySelection('after-fullscreen', 'node:1:instance:0');
    await page.getByRole('button', { name: 'To‘liq ekrandan chiqish', exact: true }).click();
    await page.getByRole('button', { name: 'To‘liq ekran', exact: true }).waitFor();
    await factorySelection('after-fullscreen-exit', 'node:1:instance:0');
    await button('To‘liq ekran').click();
    await button('To‘liq ekrandan chiqish').waitFor();
    await page.keyboard.press('Escape');
    await button('To‘liq ekran').waitFor();
    await factorySelection('after-fullscreen-escape', 'node:1:instance:0');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'To‘liq ekran', 'Fullscreen Escape did not restore the initiating button focus');
  });

  await run('factory-map-keyboard-touch', async () => {
    await open('/app/factory-map');
    const list = page.getByLabel('Xaritadagi apparatlar', { exact: true });
    const flexo = list.getByRole('button', { name: /QA Flexo 1/ }).first();
    await flexo.waitFor({ timeout: 45_000 });
    const target = await flexo.boundingBox(); assert.ok(target, 'Touch target is unavailable');
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    await page.getByText(/Tanlangan apparat: QA Flexo 1/).waitFor();
    const canvas = page.locator('[data-model-viewer-state][aria-busy="false"] canvas[data-factory-map-canvas][tabindex="0"]');
    await canvas.waitFor({ timeout: 45_000 });
    await factorySelection('after-touch-list-selection', 'node:1:instance:0');
    await canvas.focus(); await canvas.press('ArrowRight');
    await page.waitForFunction(() => { const value = document.querySelector('canvas[data-factory-map-canvas]')?.getAttribute('data-selected-object-id'); return Boolean(value && value !== 'node:1:instance:0'); });
    const next = await canvas.getAttribute('data-selected-object-id'); assert.ok(next && next !== 'node:1:instance:0', 'ArrowRight did not select another native object');
    await factorySelection('after-keyboard-next', next);
    await screenshot('keyboard-next');
    await canvas.press('Escape');
    await page.locator('canvas[data-factory-map-canvas][data-selected-object-id=""]').waitFor();
    await factorySelection('after-keyboard-clear', '');
    assert.equal(await list.getByRole('button', { pressed: true }).count(), 0, 'Escape left a selected list row');
  }, undefined, { hasTouch: true });

  await run('materials-micron-reorder', async () => {
    await open('/app/materials?selected=qa-pet'); await button('Materialni tahrirlash').click();
    const editor = dialog('Materialni tahrirlash');
    await editor.getByLabel('Material nomi', { exact: true }).fill('PET QA');
    await editor.getByLabel('Zichlik, g/cm³', { exact: true }).fill('1.5');
    await button('Mikron qo‘shish', editor).click();
    await editor.getByLabel('Mikron', { exact: true }).last().fill('20');
    await button('Saqlash', editor).click();
    await waitState(data => data.materials.some(row => row.id === 'qa-pet' && row.name === 'PET QA' && row.variants.some(variant => variant.micron === 20 && Math.abs(variant.coefficient - 1.8) < 1e-10)), 'Material/micron normalization did not persist');
    await editor.waitFor({ state: 'hidden' });
    await open('/app/materials'); await button('Tartibni o‘zgartirish').click();
    const sequence = dialog('Materiallar tartibi');
    await sequence.getByRole('button', { name: 'PET QA pastga ko‘chirish', exact: true }).click();
    await button('Saqlash', sequence).click();
    await waitState(data => data.materials[0].id === 'qa-pe' && data.materials[1].id === 'qa-pet', 'Material order did not persist');
    await sequence.waitFor({ state: 'hidden' });
  });

  await run('raw-material-assign-unlink', async () => {
    await open('/app/raw-materials?selected=QA-ROLL-1');
    await button('Buyurtmaga biriktirish').click();
    const assign = dialog('Xomashyoni buyurtmaga biriktirish');
    await choose('Mos buyurtma', /qa-1001/, assign); await choose('Mos apparat', /^QA Flexo 1\b/, assign);
    await button('Tasdiqlash', assign).click();
    await waitState(data => data.rawAssignments.some(row => row.barcode === 'QA-ROLL-1' && row.order_id === 'zakaz-qa-1001' && row.apparatus_id === apparatusIds.print), 'Raw assignment did not persist exact identities');
    await button('Biriktirishni uzish').click();
    await button('Tasdiqlash', dialog('Biriktirishni uzish')).click();
    await waitState(data => !data.rawAssignments.some(row => row.barcode === 'QA-ROLL-1'), 'Raw unlink did not persist');
  });

  await run('production-pause-resume-freeze', async () => {
    await open('/app/orders?selected=zakaz-qa-1002');
    const controls = page.getByRole('region', { name: 'Buyurtma va apparat navbatini boshqarish' });
    await button('To‘xtatish va hisobot', controls).click();
    const pause = dialog('To‘xtatish va hisobot');
    await pause.getByLabel('Ishlab chiqarilgan miqdor').fill('1250'); await pause.getByLabel('O‘lchov birligi', { exact: true }).fill('m');
    await button('Tasdiqlash', pause).click();
    await waitState(data => data.orders[1].stages.print === 'paused' && data.wip.some(row => row.action === 'pause'), 'Pause report/WIP did not persist');
    await button('Davom ettirish', controls).click(); await button('Tasdiqlash', dialog('Davom ettirish')).click();
    await waitState(data => data.orders[1].stages.print === 'in_progress', 'Resume did not persist');
    await button('Muzlatish', controls).click(); await button('Tasdiqlash', dialog('Muzlatish')).click();
    await waitState(data => data.orders[1].control === 'frozen', 'Freeze did not persist');
    await button('Muzlatishni olib tashlash', controls).click(); await button('Tasdiqlash', dialog('Muzlatishni olib tashlash')).click();
    await waitState(data => data.orders[1].control === 'active', 'Unfreeze did not persist');
  });

  await run('production-queue-reorder', async () => {
    await open('/app/orders?selected=zakaz-qa-1001');
    const controls = page.getByRole('region', { name: 'Buyurtma va apparat navbatini boshqarish' });
    const queue = controls.locator('div.rounded-md').filter({ has: page.getByText('QA Laminator', { exact: true }) });
    await queue.waitFor();
    assert.equal(await queue.count(), 1, 'The chosen apparatus queue must be unique');
    await button('Orqaga', queue).click(); await button('Tasdiqlash', dialog('Navbatda orqaga')).click();
    await waitState(data => data.sequenceOverrides[apparatusIds.laminate]?.[1] === 'zakaz-qa-1001', 'Native versioned queue move did not persist');
  });

  await run('calculator-order-edit', async () => {
    await calculateLoaded('/app/calculate?orderId=zakaz-qa-1001', '180');
    await button('Buyurtma tahririni saqlash').click(); await button('Tasdiqlash', dialog('Buyurtma tahririni saqlash')).click();
    await page.waitForURL(/\/app\/orders\?selected=zakaz-qa-1001$/);
    const order = (await state()).orders.find(row => row.map.id === 'zakaz-qa-1001');
    assert.equal(order.template.kg, 180); assert.equal(order.map.order_kg, 180); assert.equal(order.calculationRevision, 2);
    const writes = (await control('/__qa/log')).requests.filter(row => ['POST', 'PUT'].includes(row.method) && /production-maps/.test(row.path));
    assert.deepEqual(writes.map(row => `${row.method} ${row.path}`), [`PUT ${base}/production-maps/order-edit`]);
  });

  await run('calculator-order-conflict', async () => {
    await calculateLoaded('/app/calculate?orderId=zakaz-qa-1001', '180');
    await button('Buyurtma tahririni saqlash').click();
    await control('/__qa/order', { id: 'zakaz-qa-1001', templatePatch: { note: 'QA another editor' } });
    await button('Tasdiqlash', dialog('Buyurtma tahririni saqlash')).click();
    await dialog('Buyurtma tahririni saqlash').getByText(/Ma’lumotlar o‘zgargan/).waitFor();
    assert.equal(await page.getByLabel('KG *', { exact: true }).inputValue(), '180', 'Conflict discarded the retained calculator draft');
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PUT').length, 0, 'Calculator conflict sent a stale write');
  });

  await run('calculator-template-edit-delete', async () => {
    await open('/app/calculate?templateId=qa-route-template&edit=1'); await button('Shablonni yangilash').waitFor();
    await button('Shablonni yangilash').click();
    await dialog('Buyurtma shablonini saqlash').getByLabel('Shablon nomi', { exact: true }).fill('QA Route Updated');
    await button('Tasdiqlash', dialog('Buyurtma shablonini saqlash')).click();
    await page.waitForURL(/\/app\/templates\?selected=qa-route-template$/);
    const saved = (await state()).templates.find(row => row.id === 'qa-route-template');
    assert.equal(saved.name, 'QA Route Updated'); assert.equal(saved.kg, 0); assert.equal(saved.source_map_id, 'zakaz-qa-1001');
    await open('/app/calculate?templateId=qa-route-template&edit=1'); await button('Shablonni o‘chirish').click();
    await button('Tasdiqlash', dialog('Shablonni o‘chirish')).click(); await page.waitForURL(`${webOrigin}/app/templates`);
    assert.equal((await state()).templates.length, 0); assert.equal((await state()).orders.length, 3);
  });

  await run('calculator-pending-reserved-release', async () => {
    await calculateLoaded('/app/calculate?pendingId=zakaz-2001');
    assert.equal(await page.getByLabel('KG *', { exact: true }).inputValue(), '120');
    await button('Ishlab chiqarishga chiqarish').click();
    await choose('Xarita shabloni', /QA Flexo xaritasi/, dialog('Kutilayotgan buyurtmani chiqarish'));
    await button('Tasdiqlash', dialog('Kutilayotgan buyurtmani chiqarish')).click();
    await page.waitForURL(/\/app\/orders\?selected=zakaz-2001$/);
    const current = await state(); assert.equal(current.orders.length, 4);
    assert.equal(current.pendingOrders[0].completion.saved.map.id, 'zakaz-2001'); assert.equal(current.pendingOrders[0].completion.template.order_number, '2001');
    const log = (await control('/__qa/log')).requests;
    const release = log.filter(row => row.method === 'PUT' && row.path.endsWith('/with-order'));
    assert.equal(release.length, 1); assert.equal(release[0].body.pending_order_id, 'zakaz-2001');
    assert.equal(log.filter(row => row.path.endsWith('/auto-open')).length, 0, 'Pending release allocated through automatic opening');
  });

  await run('opening-wip-register-cancel-used-lock', async () => {
    const form = await openingForm(); await button('Qabulni tasdiqlash', form).click();
    await button('Yangi qabulni boshlash', form).waitFor();
    const created = (await state()).openingWip[0]; assert.equal(created.batches.length, 2); assert.equal(created.intake.source_apparatus, apparatusIds.print);
    await screenshot('registered'); await button('Yopish', form).click();
    await open(`/app/opening-wip?status=all&selected=${encodeURIComponent(created.batches[0].batch_id)}`);
    const controls = page.getByRole('region', { name: 'WIP boshqaruvi', exact: true });
    await choose('Canonical kirish apparati', /apparatus:qa:laminate-1/, controls); await button('Kirish mosligini tekshirish', controls).click();
    await controls.getByText(/shu rulonning kirish mosligini tasdiqladi/).waitFor();
    await button('Rulonni bekor qilish', controls).click(); await button('Bekor qilishni tasdiqlash', dialog('Rulonni bekor qilish')).click();
    await waitState(data => data.openingWip[0].batches[0].wip_status === 'void', 'Selected opening roll was not cancelled');
    assert.equal((await state()).openingWip[0].batches[1].wip_status, 'waiting'); assert.equal((await state()).openingWip[0].intake.status, 'confirmed');
    await control('/__qa/opening-wip', { batch_id: created.batches[1].batch_id, batchPatch: { wip_status: 'in_use', used_by_session_id: 'qa-active-session' } });
    await open(`/app/opening-wip?status=all&selected=${encodeURIComponent(created.batches[1].batch_id)}`);
    await controls.getByText('Faqat foydalanilmagan kutayotgan rulon bekor qilinadi.', { exact: true }).waitFor();
    assert.equal(await button('Rulonni bekor qilish', controls).isDisabled(), true);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'DELETE' && row.path.endsWith('/opening-wip')).length, 1, 'Used roll sent an extra cancellation');
  });

  await run('opening-wip-lost-response-recovery', async () => {
    const form = await openingForm(1);
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/opening-wip`, dropResponse: true, once: true }] });
    await button('Qabulni tasdiqlash', form).click(); await button('Server holatini tekshirish', form).waitFor();
    await screenshot('uncertain-intake'); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await button('Server holatini tekshirish', form).click(); await button('Yangi qabulni boshlash', form).waitFor();
    assert.equal((await state()).openingWip.length, 1);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/opening-wip')).length, 1, 'Opening recovery created a second intake');
  });

  await run('wip-authoritative-route-preview', async () => {
    const before = (await state()).wip;
    await open('/app/wip?status=all&selected=qa-wip-1');
    const controls = page.getByRole('region', { name: 'WIP boshqaruvi', exact: true });
    await controls.getByText(/Joriy xaritaga qayta bog‘langan/).waitFor();
    await choose('Canonical kirish apparati', /apparatus:qa:laminate-1/, controls); await button('Kirish mosligini tekshirish', controls).click();
    await controls.getByText(/Server apparatus:qa:laminate-1 uchun shu rulonning kirish mosligini tasdiqladi/).waitFor();
    assert.deepEqual((await state()).wip, before, 'Read-only route preview changed WIP');
    const log = (await control('/__qa/log')).requests.filter(row => row.path.endsWith('/progress-qr/lookup'));
    assert.ok(log.some(row => row.body.apparatus === apparatusIds.laminate && row.body.order_id === 'zakaz-qa-1003'));
    assert.equal((await control('/__qa/log')).requests.filter(row => ['PUT', 'DELETE'].includes(row.method)).length, 0);
  }, () => control('/__qa/wip', { batch_id: 'qa-wip-1', batchPatch: { next_apparatus: apparatusIds.cut } }));

  await run('apparatus-capacity-policy-downtime', async () => {
    const editor = await openPlanning();
    await editor.getByLabel('Samaradorlik, %', { exact: true }).fill('120'); await button('Quvvat profilini ko‘rib chiqish', editor).click();
    await button('Tasdiqlash va saqlash', dialog('Quvvat profilini saqlash')).click();
    await waitState(data => data.planning[apparatusIds.laminate].capacity.efficiency_percent === 120, 'Capacity profile did not commit');
    await dialog('Quvvat profilini saqlash').waitFor({ state: 'hidden' });
    await choose('Navbat siyosati', 'Tayyor buyurtmani erkin tanlash', editor); await button('Navbat siyosatini ko‘rib chiqish', editor).click();
    await button('Tasdiqlash va saqlash', dialog('Navbat siyosatini saqlash')).click();
    await waitState(data => data.planning[apparatusIds.laminate].discipline === 'free_pick', 'Non-printing queue policy did not commit');
    await dialog('Navbat siyosatini saqlash').waitFor({ state: 'hidden' });
    await editor.getByLabel('Boshlanish, UTC', { exact: true }).fill('2030-01-07T08:00'); await editor.getByLabel('Tugash, UTC', { exact: true }).fill('2030-01-07T09:00');
    await editor.getByLabel('Ish to‘xtashi sababi', { exact: true }).fill('QA Synthetic maintenance'); await button('Ish to‘xtashini ko‘rib chiqish', editor).click();
    await button('Tasdiqlash va saqlash', dialog('Ish to‘xtashini saqlash')).click();
    await waitState(data => data.downtime.length === 1 && data.downtime[0].active, 'Downtime did not commit'); await dialog('Ish to‘xtashini saqlash').waitFor({ state: 'hidden' });
    await screenshot('planning-profile'); await button('Faolsizlantirish', editor).click(); await button('Tasdiqlash va saqlash', dialog('Ish to‘xtashini saqlash')).click();
    await waitState(data => !data.downtime[0].active, 'Downtime deactivation did not persist');
    const row = (await state()).apparatus.find(row => row.apparatus_id === apparatusIds.laminate); assert.equal(row.source_revision, 3);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PUT' && /\/(capacity|queue-policies)$/.test(row.path)).length, 2);
  });

  await run('apparatus-capacity-conflict', async () => {
    const editor = await openPlanning(); await editor.getByLabel('Samaradorlik, %', { exact: true }).fill('130'); await button('Quvvat profilini ko‘rib chiqish', editor).click();
    await control('/__qa/apparatus', { apparatus_id: apparatusIds.laminate });
    await button('Tasdiqlash va saqlash', dialog('Quvvat profilini saqlash')).click();
    await dialog('Quvvat profilini saqlash').getByText(/Aparat boshqa joyda o‘zgargan/).waitFor();
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PUT').length, 0);
    assert.equal((await state()).planning[apparatusIds.laminate].capacity.efficiency_percent, 100);
    await button('Joriy nusxani yuklash', dialog('Quvvat profilini saqlash')).click();
    assert.equal(await editor.getByLabel('Samaradorlik, %', { exact: true }).inputValue(), '100');
  });

  await run('order-scheduling-cancel', async () => {
    await open('/app/orders?selected=zakaz-qa-1001'); await button('Apparat vaqtini rejalashtirish').click();
    const form = dialog('Buyurtma uchun apparat vaqtini rejalashtirish'); await choose('Buyurtma xaritasidagi apparat', 'QA Laminator', form);
    await form.getByLabel('Eng erta boshlanish, UTC', { exact: true }).fill('2030-01-07T08:00'); await form.getByLabel('Eng kech tugash, UTC', { exact: true }).fill('2030-01-07T09:00');
    await form.getByLabel('Ish davomiyligi, daqiqa', { exact: true }).fill('20'); await form.getByLabel('Rejalashtirish sababi', { exact: true }).fill('QA Synthetic schedule');
    await button('Rejani ko‘rib chiqish', form).click(); await button('Tasdiqlash va saqlash', dialog('Jadvalga band qilish')).click();
    await waitState(data => data.reservations.length === 1, 'Order reservation did not persist');
    const reservation = (await state()).reservations[0]; assert.equal(reservation.apparatus_id, apparatusIds.laminate); assert.equal(reservation.order_id, 'zakaz-qa-1001'); assert.equal(reservation.reserved_duration_minutes, 30);
    await button('Bandni bekor qilish').click(); await dialog('Jadval bandini bekor qilish').getByLabel('Bekor qilish sababi', { exact: true }).fill('QA Cancelled');
    await button('Bandni bekor qilishni tasdiqlash', dialog('Jadval bandini bekor qilish')).click();
    await waitState(data => data.reservations[0].status === 'cancelled', 'Returned reservation did not cancel');
    assert.equal((await state()).reservations[0].reservation_id, reservation.reservation_id);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && /\/(queue-action|order-control|sequence)$/.test(row.path)).length, 0, 'Scheduling changed production queue control');
  });

  await run('manufacturing-time-closed-ruler-zoom', async () => {
    await open('/app/production-time?orderId=zakaz-4001');
    await page.getByText('Saqlangan buyurtma tarixi', { exact: true }).waitFor();
    const timeline = page.getByRole('region', { name: 'Bosqichlar va vaqt qaydlari', exact: true });
    const ruler = timeline.getByRole('group', { name: 'Vaqt bo‘yicha hodisani tanlash', exact: true }); await ruler.waitFor();
    await timeline.getByRole('img', { name: 'QA Flexo 1: qayd etilgan jarayon 5 daq 0 son, to‘xtash 50 son, 0 baholanmagan oraliq', exact: true }).waitFor();
    assert.ok(await ruler.getByRole('button').count() >= 6, 'Canonical transition markers are missing');
    await ruler.focus(); await ruler.press('Home');
    const selection = timeline.getByRole('region', { name: 'Tanlangan hodisa', exact: true }); await selection.waitFor();
    const first = await selection.innerText(); await page.keyboard.press('End');
    await page.waitForFunction(previous => document.querySelector('[aria-label="Tanlangan hodisa"]')?.innerText !== previous, first);
    assert.notEqual(await selection.innerText(), first, 'Keyboard ruler did not reach the last event');
    await button('Vaqt chizig‘ini yaqinlashtirish', timeline).click(); assert.equal(await button('To‘liq oyna', timeline).isEnabled(), true);
    await screenshot('zoomed-history'); await button('To‘liq oyna', timeline).click(); assert.equal(await button('To‘liq oyna', timeline).isDisabled(), true);
    await ruler.focus(); await ruler.press('Home'); await timeline.getByLabel('Hodisalarni qidirish', { exact: true }).fill('Bosqich hisoboti');
    await button('Keyingi hodisa', selection).click(); await selection.getByText('Jarayonda → Navbatda', { exact: true }).waitFor();
    await timeline.getByLabel('Hodisalarni qidirish', { exact: true }).fill(''); await ruler.focus(); await ruler.press('Home');
    await timeline.getByLabel('Hodisalarni qidirish', { exact: true }).fill('Bosqich hisoboti'); await ruler.focus(); await ruler.press('ArrowRight');
    await selection.getByText('Jarayonda → Navbatda', { exact: true }).waitFor(); await timeline.getByLabel('Hodisalarni qidirish', { exact: true }).fill('');
    await timeline.getByRole('tab', { name: /^Hodisalar \(/ }).click();
    await timeline.getByLabel('Hodisalarni qidirish', { exact: true }).fill('QA-ABSENT-EVENT');
    await timeline.getByText('Qidiruv va bosqich filtri bo‘yicha hodisa topilmadi.', { exact: true }).waitFor();
    await timeline.getByLabel('Hodisalarni qidirish', { exact: true }).fill('');
    await choose('Buyurtma', /qa-1002/, page); await page.waitForURL(/orderId=zakaz-qa-1002/);
    await page.getByRole('tab', { name: 'Hodisalar (0)', exact: true }).click();
    await page.getByText('Vaqti qayd etilgan tarixiy hodisa olinmagan.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Tanlangan hodisa', exact: true }).count(), 0, 'Order change retained another order event selection');
  });

  await run('manufacturing-time-partial-error-empty', async () => {
    await open('/app/production-time?orderId=zakaz-qa-1003&batchId=qa-wip-1');
    await page.getByText('Partiya zanjiri', { exact: true }).waitFor();
    await page.getByText(/Buyurtmaning to‘liq holat tarixi olinmagani uchun davomiylik baholanmagan/).waitFor();
    assert.equal(await page.getByRole('img', { name: /qayd etilgan jarayon [0-9]/ }).count(), 0, 'Partial batch lineage gained fabricated elapsed intervals');
    await screenshot('partial-lineage');
    await control('/__qa/config', { rules: [{ method: 'GET', path: `${base}/production-maps/closed-orders`, status: 500, error: 'store_failed' }] });
    await button('Yangilash').first().click(); await page.getByText('Tarixning bir qismi yuklanmadi', { exact: true }).waitFor();
    await page.getByText('Oxirgi olingan ma’lumot', { exact: true }).waitFor(); await screenshot('stale-history');
    await control('/__qa/config', { rules: [], emptyClosedHistory: true }); await button('Yangilash').first().click();
    await page.getByText('Tarixning bir qismi yuklanmadi', { exact: true }).waitFor({ state: 'hidden' });
    await choose('Buyurtma', /qa-1001/, page); await page.waitForURL(/orderId=zakaz-qa-1001/);
    assert.ok(!new URL(page.url()).searchParams.has('batchId'), 'Order selection retained the previous batch identity');
    await page.getByRole('tab', { name: 'Hodisalar (0)', exact: true }).click();
    await page.getByText('Vaqti qayd etilgan tarixiy hodisa olinmagan.', { exact: true }).waitFor();
  });

  await run('manufacturing-time-wrong-report-identity', async () => {
    await open('/app/production-time?orderId=zakaz-qa-1003&batchId=qa-wip-1');
    await page.getByText('Rulon tarixi tanlangan buyurtma va partiyaga mos kelmadi.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Partiya zanjiri', { exact: true }).count(), 0, 'Wrong-order report was accepted as batch lineage');
    assert.equal((await control('/__qa/log')).requests.filter(row => ['PUT', 'DELETE'].includes(row.method)).length, 0, 'History read wrote ERP data');
  }, () => control('/__qa/config', { manufacturingReportMode: 'wrong_identity' }));

  await run('worker-activity-bounded-history-empty-error', async () => {
    await open('/app/workers?selected=qa-worker-1');
    const profile = page.getByRole('region', { name: 'Ishchi faoliyati', exact: true }); await profile.waitFor();
    await profile.getByRole('button', { name: 'zakaz-qa-1002 ish tafsiloti', exact: true }).click();
    await dialog('Ish tafsiloti').getByText('qa-worker-session-1', { exact: true }).waitFor();
    await button('Close', dialog('Ish tafsiloti')).click(); await dialog('Ish tafsiloti').waitFor({ state: 'hidden' });
    assert.equal(await profile.count(), 1, 'Closing a worker record also dismissed its profile');
    await profile.getByRole('tab', { name: 'Partiyalar', exact: true }).click(); await choose('Partiyalar tarixi hajmi', 'Oxirgi 200 ta', profile);
    await waitState(data => data.wip[0].worker_ref === 'qa-worker-1', 'Native worker batch identity changed');
    await profile.getByRole('button', { name: 'qa-wip-1 partiya tafsiloti', exact: true }).click();
    await dialog('Partiya tafsiloti').getByText('qa-wip-1', { exact: true }).waitFor();
    assert.equal(await page.getByText('QA-PROFILE-ONLY', { exact: true }).count(), 0, 'Worker login code entered the UI');
    await screenshot('bounded-worker-batch'); await button('Close', dialog('Partiya tafsiloti')).click(); await dialog('Partiya tafsiloti').waitFor({ state: 'hidden' });
    assert.ok((await control('/__qa/log')).requests.some(row => row.path.endsWith('/progress-qr/history') && row.query.worker_ref === 'qa-worker-1' && row.query.limit === '200'));
    await open('/app/workers?selected=qa-worker-2'); await profile.getByText('Ochiq ishlar yo‘q.', { exact: true }).waitFor();
    await profile.getByRole('tab', { name: 'Partiyalar', exact: true }).click(); await profile.getByText('So‘nggi partiyalar yo‘q.', { exact: true }).waitFor();
    await profile.getByRole('tab', { name: 'Hodisalar', exact: true }).click(); await profile.getByText('So‘nggi hodisalar yo‘q.', { exact: true }).waitFor();
    await control('/__qa/config', { rules: [{ method: 'GET', path: `${base}/workers/profile-detail`, status: 500, error: 'store_failed', once: true }] });
    await button('Yangilash', profile).click(); await profile.getByRole('alert').waitFor(); await screenshot('worker-server-error');
    await button('Qayta yuklash', profile).click(); await profile.getByRole('alert').waitFor({ state: 'hidden' });
    assert.equal((await control('/__qa/log')).requests.filter(row => ['PUT', 'DELETE'].includes(row.method)).length, 0, 'Worker activity reads sent mutations');
  });

  async function workerNestedEscape() {
    await open('/app/workers?selected=qa-worker-1');
    const profile = page.getByRole('region', { name: 'Ishchi faoliyati', exact: true }); await profile.waitFor();
    const sessionRecord = profile.getByRole('button', { name: 'zakaz-qa-1002 ish tafsiloti', exact: true });
    await sessionRecord.click(); await dialog('Ish tafsiloti').getByText('qa-worker-session-1', { exact: true }).waitFor();
    await page.keyboard.press('Escape'); await dialog('Ish tafsiloti').waitFor({ state: 'hidden' }); await profile.waitFor();
    // Radix restores focus in its unmount callback after an empty presence
    // transition. Reduced motion can hide the DOM before that callback runs.
    await page.waitForFunction(node => node === document.activeElement, await sessionRecord.elementHandle(), { timeout: 3000 });
    assert.equal(await sessionRecord.evaluate(node => node === document.activeElement), true, 'Session Escape did not restore the initiating record button');
    const batches = profile.getByRole('tab', { name: 'Partiyalar', exact: true }); await batches.click();
    const batchRecord = profile.getByRole('button', { name: 'qa-wip-1 partiya tafsiloti', exact: true });
    await batchRecord.click(); await dialog('Partiya tafsiloti').getByText('qa-wip-1', { exact: true }).waitFor();
    await page.keyboard.press('Escape'); await dialog('Partiya tafsiloti').waitFor({ state: 'hidden' }); await profile.waitFor();
    await page.waitForFunction(node => node === document.activeElement, await batchRecord.elementHandle(), { timeout: 3000 });
    assert.equal(await batches.getAttribute('aria-selected'), 'true', 'Batch Escape reset the parent activity tab');
    assert.equal(await batchRecord.evaluate(node => node === document.activeElement), true, 'Batch Escape did not restore the initiating record button');
    assert.equal(new URL(page.url()).searchParams.get('selected'), 'qa-worker-1', 'Nested Escape dismissed the parent worker sheet');
    assert.equal((await control('/__qa/log')).requests.filter(row => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) && row.path.startsWith(base)).length, 0);
  }
  await run('worker-nested-escape-focus', workerNestedEscape);
  await run('worker-nested-escape-focus-reduced-motion', workerNestedEscape, undefined, { reducedMotion: 'reduce' });

  await run('resource-create-native-worker-system-receipts', async () => {
    await open('/app/workers'); await button('Yangi xodim').click(); let form = dialog('Yangi xodim');
    await form.getByLabel(/^Nomi/).fill('QA Browser yangi xodim'); await choose('Malaka darajasi *', 'Brigadir', form);
    await button('Saqlash', form).click(); await form.waitFor({ state: 'hidden' });
    const worker = (await state()).workers.find(row => row.name === 'QA Browser yangi xodim');
    assert.match(worker.id, /^worker_[a-f0-9]{24}$/); assert.equal(worker.level, 'Brigader'); assert.equal(worker.phone, '');
    await page.getByRole('row').filter({ hasText: worker.name }).waitFor();
    await open('/app/users?role=boyoqchi'); await button('Yangi foydalanuvchi').click(); form = dialog('Yangi foydalanuvchi');
    await form.getByLabel('Ism *', { exact: true }).fill('QA Browser yangi boyoqchi'); await form.getByLabel('Telefon *', { exact: true }).fill('+998900000083');
    await choose('Rol *', 'Bo‘yoqchi', form); await button('Saqlash', form).click(); await form.waitFor({ state: 'hidden' });
    const user = (await state()).systemUsers.find(row => row.name === 'QA Browser yangi boyoqchi');
    assert.match(user.id, /^boyoqchi_[a-f0-9]{24}$/); assert.equal(user.role, 'boyoqchi'); assert.equal(user.phone, '+998900000083');
    await page.getByRole('row').filter({ hasText: user.name }).waitFor();
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && [`${base}/workers`, `${base}/system-users`].includes(row.path));
    assert.equal(writes.length, 2); assert.ok(writes.every(row => !Object.hasOwn(row.body, 'id') && !Object.hasOwn(row.body, 'ref')));
  });

  await run('resource-create-finished-ancestry-customer', async () => {
    await open('/app/items'); await button('Yangi mahsulot').click(); const form = dialog('Yangi mahsulot');
    await form.getByLabel('Mahsulot kodi *', { exact: true }).fill('QA-REQUESTED-FINISHED'); await form.getByLabel('Nomi *', { exact: true }).fill('QA Browser tayyor paket');
    await choose('Material guruhi', 'QA Tayyor paketlar', form);
    const code = form.getByLabel('Mahsulot kodi', { exact: true }); assert.equal(await code.isDisabled(), true); assert.equal(await code.getAttribute('placeholder'), 'Server yaratadi');
    await button('Saqlash', form).click(); await form.getByText('Tayyor mahsulot uchun mijozni tanlang.', { exact: true }).waitFor();
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path === `${base}/items`).length, 0, 'Missing finished-goods customer sent a write');
    await button('Mijoz tanlang', form).click(); await page.getByRole('option', { name: /QA Mijoz/ }).click();
    await button('Saqlash', form).click(); await form.waitFor({ state: 'hidden' });
    const item = (await state()).items.find(row => row.name === 'QA Browser tayyor paket');
    assert.match(item.code, /^[A-F0-9]{24}$/); assert.notEqual(item.code, 'QA-REQUESTED-FINISHED'); assert.equal(item.item_group, 'QA Tayyor paketlar');
    assert.ok((await state()).customers.find(row => row.ref === 'QA-CUSTOMER-1').assigned_item_codes.includes(item.code));
    await page.getByRole('row').filter({ hasText: item.name }).waitFor();
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path === `${base}/items`).length, 1);
  });

  await run('resource-create-malformed-200-retain-review', async () => {
    await open('/app/workers'); const documentHandle = await page.locator('html').elementHandle();
    await button('Yangi xodim').click(); let form = dialog('Yangi xodim'); await form.getByLabel('Nomi *', { exact: true }).fill('QA Browser noaniq xodim');
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/workers`, responseBody: {}, delayMs: 1500, once: true }] });
    await button('Saqlash', form).click(); await button('Bekor qilish', form).and(form.locator('button:disabled')).waitFor();
    assert.equal(await button('Close', form).count(), 0, 'Pending creation exposed the close button');
    await enabled(button('Saqlangan yozuvlarni tekshirish', form)); await form.getByRole('alert').waitFor();
    await enabled(button('Bekor qilish', form));
    assert.equal(await button('Saqlash', form).isDisabled(), true, 'Malformed success permitted another create');
    assert.equal((await state()).workers.filter(row => row.name === 'QA Browser noaniq xodim').length, 1); await screenshot('unknown-create');
    await button('Bekor qilish', form).click(); await button('Yangi xodim').click(); form = dialog('Yangi xodim');
    await button('Saqlangan yozuvlarni tekshirish', form).waitFor(); assert.equal(await form.getByLabel('Nomi *', { exact: true }).inputValue(), 'QA Browser noaniq xodim');
    assert.equal(await button('Saqlash', form).isDisabled(), true); await button('Bekor qilish', form).click();
    await page.getByRole('link', { name: 'Bosh sahifa', exact: true }).click(); await page.waitForURL(`${webOrigin}/app/home`);
    await resourceLink('workers', 'Xodimlar', 'Boshqaruv'); await button('Yangi xodim').click(); form = dialog('Yangi xodim');
    assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true, 'Create retention case reloaded its RAM scope');
    await button('Saqlangan yozuvlarni tekshirish', form).click(); await button('Shu yozuvdan foydalanish', form).waitFor();
    await button('Shu yozuvdan foydalanish', form).click(); await button('Tasdiqlash', dialog('Topilgan yozuvdan foydalanish')).click();
    await form.waitFor({ state: 'hidden' }); assert.equal((await state()).workers.filter(row => row.name === 'QA Browser noaniq xodim').length, 1);
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path === `${base}/workers`);
    assert.equal(writes.length, 1, 'Close, navigation or review issued another create'); assert.equal(writes[0].responseOverridden, true);
    await documentHandle.dispose();
  });

  await run('inventory-relocate-own-warehouse-return', async () => {
    const controls = await openAsset(); await (await enabled(button('Aktivni ko‘chirish', controls))).click();
    const form = dialog('Aktivni ko‘chirish'); await choose('Manzil', 'QA Rezka sexi · Zavod joyi', form);
    await button('Amalni tasdiqlash', form).click(); await button('Yangi amal', form).waitFor();
    let asset = (await state()).assets.find(row => row.asset_ref === 'qa-roll-1');
    assert.equal(asset.physical_location.id, 'qa-location-cut'); assert.equal(asset.custody_warehouse_id, 'QA Xomashyo');
    assert.equal(asset.qty, 80); assert.equal(asset.placement_version, 2); await screenshot('relocated');
    await button('Yopish', form).click(); await button('Yangi amal', controls).click();
    await (await enabled(button('O‘z omboriga qaytarish', controls))).click(); const returnForm = dialog('O‘z omboriga qaytarish');
    await button('Amalni tasdiqlash', returnForm).click(); await button('Yangi amal', returnForm).waitFor();
    asset = (await state()).assets.find(row => row.asset_ref === 'qa-roll-1');
    assert.equal(asset.physical_location.id, 'qa-location-stock'); assert.equal(asset.custody_warehouse_id, 'QA Xomashyo');
    assert.equal(asset.qty, 80); assert.equal(asset.placement_version, 3);
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.startsWith(`${base}/inventory/`));
    assert.deepEqual(writes.map(row => row.path), [`${base}/inventory/relocations`, `${base}/inventory/returns/batch`]);
    assert.ok(writes.every(row => !Object.hasOwn(row.body, 'expected_placement_version') && !Object.hasOwn(row.body, 'movement_id')));
  });

  await run('inventory-lost-response-retained-read-recovery', async () => {
    const controls = await openAsset(), documentHandle = await page.locator('html').elementHandle(); await (await enabled(button('Aktivni ko‘chirish', controls))).click();
    const form = dialog('Aktivni ko‘chirish'); await choose('Manzil', 'QA Rezka sexi · Zavod joyi', form);
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/inventory/relocations`, dropResponse: true, once: true }] });
    await button('Amalni tasdiqlash', form).click(); await button('Server holatini tekshirish', form).waitFor();
    await screenshot('uncertain-relocation'); await button('Yopish', form).click();
    await button('Close', page.getByRole('dialog').filter({ has: controls })).click();
    await page.getByRole('link', { name: 'Bosh sahifa', exact: true }).click(); await page.waitForURL(`${webOrigin}/app/home`);
    const retained = await assetInSession(); await button('Server holatini tekshirish', retained).waitFor();
    assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true, 'Retained-attempt case reloaded its RAM scope');
    assert.equal(await button('Aktivni ko‘chirish', retained).isDisabled(), true, 'An uncertain relocation permitted a new movement');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await enabled(button('Server holatini tekshirish', retained))).click(); await button('Yangi amal', retained).waitFor();
    const asset = (await state()).assets.find(row => row.asset_ref === 'qa-roll-1'); assert.equal(asset.physical_location.id, 'qa-location-cut'); assert.equal(asset.placement_version, 2);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path === `${base}/inventory/relocations`).length, 1, 'Read recovery resent the relocation');
    await documentHandle.dispose();
  });

  await run('inventory-custody-unavailable-preflight', async () => {
    const controls = await openAsset(); await (await enabled(button('Aktivni ko‘chirish', controls))).click();
    const form = dialog('Aktivni ko‘chirish'); await choose('Manzil', 'QA Rezka sexi · Zavod joyi', form);
    await control('/__qa/asset', { kind: 'raw_material', asset_ref: 'qa-roll-1', patch: { custody_warehouse_id: 'QA Tayyor mahsulot', custody_warehouse: 'QA Tayyor mahsulot', status: 'reserved' } });
    await button('Amalni tasdiqlash', form).click(); await form.getByRole('alert').waitFor();
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path === `${base}/inventory/relocations`).length, 0, 'Changed custody or reserved state passed the fresh preflight');
    const asset = (await state()).assets.find(row => row.asset_ref === 'qa-roll-1'); assert.equal(asset.physical_location.id, 'qa-location-print'); assert.equal(asset.qty, 80);
    await button('Yopish', form).click(); await controls.getByText('Band, tranzitdagi yoki ruxsat doirasidan tashqaridagi aktiv ko‘chirilmaydi.', { exact: true }).waitFor();
    assert.equal(await button('Aktivni ko‘chirish', controls).isDisabled(), true); assert.equal(await button('O‘z omboriga qaytarish', controls).isDisabled(), true);
  });

  await run('inventory-transfer-approve-dispatch-receive', async () => {
    const transfer = await transferCreate(); const source = (await state()).assets.find(row => row.asset_ref === 'qa-roll-2');
    assert.equal(source.status, 'transfer_reserved'); assert.equal(source.physical_location.id, 'qa-location-stock'); assert.equal(source.transfer_id, transfer.id);
    await transferAction(transfer, 'Transferni tasdiqlash', 'approved'); await transferAction(transfer, 'Transferni jo‘natish', 'in_transit');
    const inTransit = (await state()).assets.find(row => row.asset_ref === 'qa-roll-2');
    assert.equal(inTransit.status, 'in_transit'); assert.equal(inTransit.custody_warehouse_id, 'QA Xomashyo'); assert.equal(inTransit.physical_location.id, 'qa-location-stock');
    assert.equal(await button('Transferni bekor qilish', transfer.controls).count(), 0, 'Dispatched transfer offered cancellation'); await screenshot('in-transit');
    await transferAction(transfer, 'Transferni qabul qilish', 'received');
    const received = (await state()).assets.find(row => row.asset_ref === 'qa-roll-2');
    assert.equal(received.status, 'available'); assert.equal(received.transfer_id, ''); assert.equal(received.custody_warehouse_id, 'QA Tayyor mahsulot');
    assert.equal(received.physical_location.id, 'qa-location-finished'); assert.equal(received.qty, 95); assert.equal(received.placement_version, 2);
    await transfer.controls.getByText(/Joriy holat va ombor ruxsatida transfer amali mavjud emas/).waitFor();
    await button('Ro‘yxatga qaytish', transfer.directory).click(); await choose('Transfer holati', 'Qabul qilingan', transfer.directory);
    await transfer.directory.getByRole('button', { name: new RegExp(transfer.id) }).waitFor();
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.startsWith(`${base}/inventory/transfers`));
    assert.deepEqual(writes.map(row => row.path.split('/').at(-1)), ['transfers', 'approve', 'dispatch', 'receive']);
  });

  await run('inventory-transfer-approved-cancel', async () => {
    const transfer = await transferCreate(); await transferAction(transfer, 'Transferni tasdiqlash', 'approved');
    await transferAction(transfer, 'Transferni bekor qilish', 'cancelled');
    const released = (await state()).assets.find(row => row.asset_ref === 'qa-roll-2');
    assert.equal(released.status, 'available'); assert.equal(released.transfer_id, ''); assert.equal(released.physical_location.id, 'qa-location-stock');
    assert.equal(released.custody_warehouse_id, 'QA Xomashyo'); assert.equal(released.placement_version, 1); assert.equal(released.qty, 95);
    await transfer.controls.getByText(/Joriy holat va ombor ruxsatida transfer amali mavjud emas/).waitFor();
    assert.equal(await button('Transferni jo‘natish', transfer.controls).count(), 0); assert.equal(await button('Transferni qabul qilish', transfer.controls).count(), 0);
  });

  await run('factory-location-create-edit-bind-retire', async () => {
    await open('/app/locations'); await button('Zavod joylarini boshqarish').click(); const directory = dialog('Zavod joylari');
    await button('Yangi zavod joyi', directory).click(); await directory.getByLabel('Joy nomi', { exact: true }).fill('QA Browser sexi');
    await directory.getByRole('checkbox', { name: 'QA Laminator ' + apparatusIds.laminate, exact: true }).check(); await button('Zavod joyini yaratish', directory).click();
    await button('Yangi amal', directory).waitFor(); const created = (await state()).factoryLocations.find(row => row.name === 'QA Browser sexi');
    assert.match(created.id, /^state_[a-f0-9]{32}$/); assert.deepEqual(created.apparatus_ids, [apparatusIds.laminate]);
    await button('Ro‘yxatga qaytish', directory).click(); await directory.getByRole('button', { name: new RegExp(`QA Browser sexi.*${created.id}`) }).click();
    const controls = directory.getByRole('region', { name: 'Zavod joyini boshqarish', exact: true });
    await (await enabled(button('Joyni tahrirlash', controls))).click(); let form = dialog('Joyni tahrirlash');
    await form.getByLabel('Joy nomi', { exact: true }).fill('QA Browser yangi sex'); await button('O‘zgarishni saqlash', form).click(); await button('Yangi amal', form).waitFor();
    await button('Yopish', form).click(); await button('Yangi amal', controls).click();
    await (await enabled(button('Apparatlarni bog‘lash', controls))).click(); form = dialog('Apparatlarni bog‘lash');
    await form.getByRole('checkbox', { name: /QA Flexo 1/ }).check(); await button('O‘zgarishni saqlash', form).click(); await button('Yangi amal', form).waitFor();
    let location = (await state()).factoryLocations.find(row => row.id === created.id); assert.equal(location.name, 'QA Browser yangi sex');
    assert.deepEqual([...location.apparatus_ids].sort(), [apparatusIds.laminate, apparatusIds.print].sort());
    await button('Yopish', form).click(); await button('Yangi amal', controls).click();
    await (await enabled(button('Joyni tahrirlash', controls))).click(); form = dialog('Joyni tahrirlash');
    await form.getByRole('checkbox', { name: 'Faol joy', exact: true }).uncheck(); await button('O‘zgarishni saqlash', form).click(); await button('Yangi amal', form).waitFor();
    location = (await state()).factoryLocations.find(row => row.id === created.id); assert.equal(location.active, false); assert.equal(location.created_at_unix, created.created_at_unix);
    assert.deepEqual([...location.apparatus_ids].sort(), [apparatusIds.laminate, apparatusIds.print].sort());
    const projection = (await state()).locations.find(row => row.factory_location_id === created.id); assert.equal(projection.active, false); assert.equal(projection.name, location.name);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'DELETE' && row.path.includes('/factory-locations')).length, 0);
  });

  await run('factory-location-only-permission', async () => {
    await open('/app/locations'); await page.getByText(/Inventar joylari ro‘yxatini ko‘rish uchun ruxsat berilmagan/).waitFor();
    await button('Zavod joylarini boshqarish').click(); const directory = dialog('Zavod joylari');
    await directory.getByRole('button', { name: /QA Bosma sexi/ }).waitFor(); await button('Yangi zavod joyi', directory).click();
    await directory.getByLabel('Joy nomi', { exact: true }).fill('QA Factory-only sex'); await button('Zavod joyini yaratish', directory).click(); await button('Yangi amal', directory).waitFor();
    assert.ok((await state()).factoryLocations.some(row => row.name === 'QA Factory-only sex'));
    const log = (await control('/__qa/log')).requests; assert.ok(log.some(row => row.path === `${base}/factory-locations` && row.method === 'POST' && row.status === 200));
    assert.equal(log.filter(row => row.path.startsWith(`${base}/inventory/`)).length, 0, 'Factory-only route sent forbidden inventory reads or writes');
  }, () => control('/__qa/config', { capabilities: ['admin.access', 'factory.location.manage'] }));

  await run('inventory-only-permission', async () => {
    await open('/app/locations'); await page.getByRole('table').waitFor();
    await page.getByText('Zavod joylarini o‘qish va tahrirlash uchun ruxsat berilmagan.', { exact: true }).waitFor();
    assert.equal(await button('Zavod joylarini boshqarish').count(), 0);
    const log = (await control('/__qa/log')).requests; assert.ok(log.some(row => row.path === `${base}/inventory/locations` && row.status === 200));
    assert.equal(log.filter(row => row.path.includes('/factory-locations')).length, 0, 'Inventory permission alone sent factory location requests');
  }, () => control('/__qa/config', { capabilities: ['admin.access', 'inventory.movement.manage'] }));

  await run('inventory-resession-clears-uncertain-attempt', async () => {
    const controls = await openAsset(), documentHandle = await page.locator('html').elementHandle(); await (await enabled(button('Aktivni ko‘chirish', controls))).click(); const form = dialog('Aktivni ko‘chirish');
    await choose('Manzil', 'QA Rezka sexi · Zavod joyi', form);
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/inventory/relocations`, dropResponse: true, once: true }] });
    await button('Amalni tasdiqlash', form).click(); await button('Server holatini tekshirish', form).waitFor(); await button('Yopish', form).click();
    await button('Close', page.getByRole('dialog').filter({ has: controls })).click();
    await page.getByRole('link', { name: 'Bosh sahifa', exact: true }).click(); await page.waitForURL(`${webOrigin}/app/home`);
    await page.getByRole('button', { name: /QA Administrator.*Administrator/ }).click();
    await page.getByRole('menuitem', { name: 'Hisobdan chiqish', exact: true }).click(); await page.waitForURL(`${webOrigin}/kirish`);
    await login(fixtureSecondLogin, { navigate: false }); const secondControls = await assetInSession();
    await enabled(button('Aktivni ko‘chirish', secondControls)); await secondControls.getByText('Joriy joy: QA Rezka sexi', { exact: true }).waitFor();
    assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true, 'Resession case erased its attempt by reloading the document');
    assert.equal(await button('Server holatini tekshirish', secondControls).count(), 0, 'Previous principal uncertainty crossed into a new session');
    assert.equal(await button('Aynan qayta yuborish', secondControls).count(), 0, 'Previous principal request could replay in the new session');
    assert.equal((await state()).assets.find(row => row.asset_ref === 'qa-roll-1').placement_version, 2);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path === `${base}/inventory/relocations`).length, 1);
    await documentHandle.dispose();
  });

  await run('canonical-apparatus-create-rename-retire', async () => {
    await open('/app/apparatus'); await button('Apparat qo‘shish').click(); let form = dialog('Yangi canonical apparat');
    await choose('Ierarxiya uchun mavjud apparat namunasi (ixtiyoriy)', 'QA Flexo 1', form);
    await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Browser canonical'); await form.getByLabel('Yangi jismoniy aktiv ID', { exact: true }).fill('physical-asset:qa:browser-new');
    await button('Yangi apparatni ko‘rib chiqish', form).click(); await button('Tasdiqlash va saqlash', dialog('Yangi apparatni yaratish')).click();
    await dialog('Yangi apparat tasdiqlandi').getByText('Serverdagi apparat tasdiqlandi.', { exact: true }).waitFor();
    const created = (await state()).apparatus.find(row => row.physical_asset_id === 'physical-asset:qa:browser-new'); assert.match(created.apparatus_id, /^apparatus:default:[a-f0-9]{32}$/); assert.equal(created.source_revision, 1);
    await page.getByRole('link', { name: 'Apparat tafsilotlari', exact: true }).click(); await enabled(button('Apparatni tahrirlash'));
    await button('Apparatni tahrirlash').click(); form = dialog('Apparat profilini tahrirlash'); await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Browser canonical edited');
    await button('Amalni ko‘rib chiqish', form).click(); await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).click();
    await dialog('Apparat revisioni tasdiqlandi').waitFor(); await button('Yopish', dialog('Apparat revisioni tasdiqlandi')).click();
    const edited = (await state()).apparatus.find(row => row.apparatus_id === created.apparatus_id); assert.equal(edited.source_revision, 2); assert.equal(edited.physical_asset_id, created.physical_asset_id);
    await (await enabled(button('Foydalanishdan chiqarish'))).click(); form = dialog('Foydalanishdan chiqarish');
    await form.getByLabel('Foydalanishdan chiqarish sababi', { exact: true }).fill('QA Synthetic retirement'); await button('Amalni ko‘rib chiqish', form).click();
    await button('Tasdiqlash va saqlash', dialog('Apparatni foydalanishdan chiqarish')).click();
    await waitState(data => data.apparatus.find(row => row.apparatus_id === created.apparatus_id)?.lifecycle.state === 'retired', 'Canonical retirement did not commit');
    await page.waitForURL(value => !value.searchParams.has('selected'));
    await page.getByRole('row').filter({ hasText: created.apparatus_id }).getByRole('button', { name: 'Uskuna tafsiloti', exact: true }).click();
    await page.getByText(/Foydalanishdan chiqarilgan apparat tahrirlanmaydi/).waitFor();
    for (const action of ['Apparatni tahrirlash', 'AASX faylidan yangilash', 'Foydalanishdan chiqarish']) assert.equal(await button(action).isDisabled(), true);
    const writes = (await control('/__qa/log')).requests.filter(row => ['POST', 'PATCH', 'DELETE'].includes(row.method) && row.path.startsWith(`${base}/apparatus`));
    assert.deepEqual(writes.map(row => row.method), ['POST', 'PATCH', 'DELETE']); assert.ok(writes.every(row => row.idempotencyKeyPresent));
    assert.equal((await state()).apparatus.find(row => row.apparatus_id === created.apparatus_id).source_revision, 3);
  });

  await run('canonical-apparatus-active-reference-guard', async () => {
    const before = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.print })).revision;
    const form = await apparatusEditor(apparatusIds.print); await form.getByText(/Web faol yoki holati noma’lum buyurtmaga bog‘liq apparatni/).waitFor();
    assert.equal(await form.getByLabel('Operatsiya', { exact: true }).isDisabled(), true); assert.equal(await form.getByLabel('Texnologiya', { exact: true }).isDisabled(), true);
    await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Active apparatus renamed'); await button('Amalni ko‘rib chiqish', form).click();
    await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).click(); await dialog('Apparat revisioni tasdiqlandi').waitFor(); await button('Yopish', dialog('Apparat revisioni tasdiqlandi')).click();
    const after = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.print })).revision;
    assert.equal(after.display.display_name, 'QA Active apparatus renamed'); for (const key of ['capabilities', 'execution_profile', 'policies', 'capacity', 'placement', 'hierarchy', 'physical_asset_id']) assert.deepEqual(after[key], before[key]);
    await button('Foydalanishdan chiqarish').click(); const retire = dialog('Foydalanishdan chiqarish'); await retire.getByText(/Web faol yoki holati noma’lum buyurtmaga bog‘liq apparatni/).waitFor();
    assert.equal(await retire.getByLabel('Foydalanishdan chiqarish sababi', { exact: true }).isDisabled(), true); assert.equal(await button('Amalni ko‘rib chiqish', retire).isDisabled(), true);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'DELETE' && row.path.includes('/apparatus/')).length, 0);
  });

  await run('canonical-apparatus-stale-review-conflict', async () => {
    const form = await apparatusEditor(); await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Stale edit'); await button('Amalni ko‘rib chiqish', form).click();
    const current = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.spare })).revision;
    await control('/__qa/apparatus', { apparatus_id: apparatusIds.spare, profilePatch: { display: { ...current.display, display_name: 'QA Concurrent edit' } } });
    await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).click(); await dialog('Apparat profilini saqlash').getByText(/Apparat boshqa joyda o‘zgargan/).waitFor();
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PATCH').length, 0, 'Stale canonical review sent a write');
    await button('Joriy nusxani yuklash', dialog('Apparat profilini saqlash')).click(); assert.equal(await form.getByLabel('Apparat nomi', { exact: true }).inputValue(), 'QA Concurrent edit');
    await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Explicit conflict'); await button('Amalni ko‘rib chiqish', form).click();
    await control('/__qa/config', { rules: [{ method: 'PATCH', path: `${base}/apparatus/${apparatusIds.spare}`, status: 409, error: 'apparatus_revision_conflict', once: true }] });
    await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).click(); await dialog('Apparat profilini saqlash').getByText(/Apparat revisioni o‘zgargan/).waitFor();
    assert.equal((await state()).apparatus.find(row => row.apparatus_id === apparatusIds.spare).source_revision, 2);
    assert.equal(await button('Serverdagi saqlashni tekshirish', dialog('Apparat profilini saqlash')).count(), 0, 'Explicit conflict became uncertain success');
  });

  await run('canonical-apparatus-loss-retained-read-recovery', async () => {
    const form = await apparatusEditor(), documentHandle = await page.locator('html').elementHandle();
    await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Lost canonical reply'); await button('Amalni ko‘rib chiqish', form).click();
    await control('/__qa/config', { rules: [{ method: 'PATCH', path: `${base}/apparatus/${apparatusIds.spare}`, dropResponse: true, once: true }] });
    await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).click(); await button('Serverdagi saqlashni tekshirish', dialog('Apparat profilini saqlash')).waitFor();
    assert.equal(await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).isDisabled(), true); await screenshot('uncertain-canonical');
    await page.goBack(); await page.waitForURL(value => !value.searchParams.has('selected'));
    await page.getByRole('row').filter({ hasText: apparatusIds.spare }).getByRole('button', { name: 'Uskuna tafsiloti', exact: true }).click();
    await dialog('Apparat profilini saqlash').waitFor(); assert.equal(await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).isDisabled(), true);
    assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true, 'Canonical retention case reloaded its RAM scope');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await enabled(button('Serverdagi saqlashni tekshirish', dialog('Apparat profilini saqlash')))).click(); await dialog('Apparat revisioni tasdiqlandi').waitFor();
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'PATCH' && row.path === `${base}/apparatus/${apparatusIds.spare}`);
    assert.equal(writes.length, 1, 'Canonical read recovery sent another PATCH'); assert.equal((await state()).apparatus.find(row => row.apparatus_id === apparatusIds.spare).source_revision, 2);
    await documentHandle.dispose();
  });

  await run('canonical-apparatus-malformed-200-read-recovery', async () => {
    const form = await apparatusEditor(); await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Malformed canonical receipt'); await button('Amalni ko‘rib chiqish', form).click();
    await control('/__qa/config', { rules: [{ method: 'PATCH', path: `${base}/apparatus/${apparatusIds.spare}`, responseBody: {}, once: true }] });
    await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).click(); await button('Serverdagi saqlashni tekshirish', dialog('Apparat profilini saqlash')).waitFor();
    assert.equal(await dialog('Apparat revisioni tasdiqlandi').count(), 0, 'Malformed canonical receipt entered success UI');
    await button('Serverdagi saqlashni tekshirish', dialog('Apparat profilini saqlash')).click(); await dialog('Apparat revisioni tasdiqlandi').waitFor();
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'PATCH'); assert.equal(writes.length, 1); assert.equal(writes[0].responseOverridden, true);
  });

  await run('canonical-apparatus-later-matching-command-refused', async () => {
    const form = await apparatusEditor(); await form.getByLabel('Apparat nomi', { exact: true }).fill('QA Same value later'); await button('Amalni ko‘rib chiqish', form).click();
    await control('/__qa/config', { rules: [{ method: 'PATCH', path: `${base}/apparatus/${apparatusIds.spare}`, responseBody: {}, once: true }] });
    await button('Tasdiqlash va saqlash', dialog('Apparat profilini saqlash')).click(); await button('Serverdagi saqlashni tekshirish', dialog('Apparat profilini saqlash')).waitFor();
    const committed = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.spare })).revision;
    await control('/__qa/apparatus', { apparatus_id: apparatusIds.spare, profilePatch: { display: committed.display } });
    await button('Serverdagi saqlashni tekshirish', dialog('Apparat profilini saqlash')).click();
    await dialog('Apparat profilini saqlash').getByText(/Yuborilgan qiymatlar joriy revisionda tasdiqlanmadi/).waitFor();
    assert.equal(await dialog('Apparat revisioni tasdiqlandi').count(), 0, 'Unrelated matching revision confirmed the previous command');
    await button('Joriy nusxani yuklash', dialog('Apparat profilini saqlash')).click();
    assert.equal(await form.getByLabel('Apparat nomi', { exact: true }).inputValue(), 'QA Same value later'); assert.equal((await state()).apparatus.find(row => row.apparatus_id === apparatusIds.spare).source_revision, 3);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'PATCH').length, 1);
  });

  await run('canonical-apparatus-admin-only-no-manage', async () => {
    await open('/app/apparatus'); await page.getByRole('row').filter({ hasText: apparatusIds.spare }).getByRole('button', { name: 'Uskuna tafsiloti', exact: true }).click();
    await page.getByText('Apparat profili', { exact: true }).waitFor();
    for (const action of ['Apparat qo‘shish', 'Apparatni tahrirlash', 'AASX faylidan yangilash', 'Foydalanishdan chiqarish']) assert.equal(await button(action).count(), 0);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.path.endsWith('/aasx') || row.path.endsWith('/apparatus/options') || ['POST', 'PATCH', 'DELETE'].includes(row.method) && row.path.startsWith(`${base}/apparatus`)).length, 0);
  }, () => control('/__qa/config', { capabilities: ['admin.access'] }));

  await run('canonical-apparatus-aasx-validate-import', async () => {
    await apparatusSheet(); await button('AASX faylidan yangilash').click(); const form = dialog('AASX faylidan yangilash');
    const file = form.getByLabel('Canonical .aasx fayli, 16 MiB gacha', { exact: true }); await enabled(file);
    await file.setInputFiles({ name: 'qa-invalid.aasx', mimeType: fixtureAasxMime, buffer: Buffer.from('synthetic-invalid-package') }); await form.getByRole('alert').waitFor();
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/aasx')).length, 0);
    const revision = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.spare })).revision; revision.display.display_name = 'QA Imported canonical';
    const bytes = fixtureApparatusAasx(revision), digest = fixtureBytesHash(bytes);
    await file.setInputFiles({ name: 'qa-valid.aasx', mimeType: fixtureAasxMime, buffer: Buffer.from(bytes) }); await form.getByText('QA Imported canonical', { exact: true }).waitFor();
    await button('Amalni ko‘rib chiqish', form).click(); const confirmation = dialog('AASX orqali apparatni yangilash'); await confirmation.getByText(`Fayl SHA-256: ${digest}`, { exact: true }).waitFor();
    await button('Tasdiqlash va saqlash', confirmation).click(); await dialog('Apparat revisioni tasdiqlandi').waitFor();
    const saved = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.spare })).revision;
    assert.equal(saved.display.display_name, 'QA Imported canonical'); assert.equal(saved.revision_metadata.source, 'aasx_import'); assert.equal(saved.revision_metadata.source_reference, `sha256:${digest}`);
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/aasx')); assert.equal(writes.length, 1); assert.equal(writes[0].expectedRevisionHeader, '1');
    assert.deepEqual(writes[0].body, { syntheticBinary: true, byteLength: bytes.length });
  });

  await run('assignment-start-material-tooling-scans', async () => {
    const controls = await orderAssignment();
    const form = await prepareAssignment(controls, 'QA Flexo 1 · print', 'Ishni boshlash', async form => {
      await form.getByLabel('Xomashyo shtrixkodlari · har qatorda bittadan', { exact: true }).fill('QA-ROLL-1');
      await form.getByLabel('Qolip kodlari · har qatorda bittadan', { exact: true }).fill('QA-QOLIP-1');
    });
    await form.getByText('Xomashyo skanlari: 1 / 1', { exact: true }).waitFor(); await form.getByText('Qolip tayyorligi: 1 / 1', { exact: true }).waitFor();
    assert.equal((await state()).rawAssignments[0].execution_status, 'waiting', 'Input proof claimed material before final start');
    assert.equal((await control('/__qa/log')).requests.filter(row => row.path.endsWith('/queue-action')).length, 0);
    await button('Tasdiqlash', form).click(); await form.waitFor({ state: 'hidden' });
    const data = await waitState(data => data.assignmentSessions.some(row => row.order_id === 'zakaz-qa-1001' && row.status === 'active'), 'Native start did not create an active session');
    assert.equal(data.assignmentSessions[0].apparatus, apparatusIds.print); assert.equal(data.assignmentSessions[0].stage_node_id, 'print'); assert.equal(data.assignmentSessions[0].worker_ref, 'qa-admin');
    assert.equal(data.rawAssignments[0].execution_status, 'in_use');
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')); assert.equal(writes.length, 1);
    assert.equal(Object.hasOwn(writes[0].body, 'idempotency_key'), false); assert.equal(Object.hasOwn(writes[0].body, 'expected_revision'), false);
  }, () => control('/__qa/assignment', { scenario: 'scans' }));

  await run('assignment-wip-start-loss-retain-cross-action-lock', async () => {
    let controls = await orderAssignment('zakaz-qa-1003'); const documentHandle = await page.locator('html').elementHandle();
    const form = await prepareAssignment(controls, 'QA Laminator · laminate', 'Ishni boshlash', async form => {
      await form.getByLabel('Kirish WIP partiyasi (QR bo‘lsa ixtiyoriy)', { exact: true }).fill('qa-wip-1');
    });
    await form.getByText('Oldingi bosqich WIPsi tasdiqlandi', { exact: true }).waitFor();
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/queue-action`, dropResponse: true, once: true }] });
    await button('Tasdiqlash', form).click(); await button('Holatni qayta tekshirish', controls).waitFor();
    const legacy = page.getByRole('region', { name: 'Buyurtma va apparat navbatini boshqarish', exact: true });
    assert.equal(await button('Muzlatish', legacy).isDisabled(), true, 'Uncertain assignment did not lock the legacy order action');
    assert.equal(await button('To‘xtatish va hisobot', legacy).isDisabled(), true, 'Uncertain start allowed a conflicting legacy pause');
    assert.equal(await button('Bir xil buyruq natijasini tekshirish', controls).count(), 0, 'Unkeyed start exposed write replay'); await screenshot('unkeyed-start-uncertain');
    await button('Yangilash', controls).click(); await button('Holatni qayta tekshirish', controls).waitFor();
    assert.equal(await button('Muzlatish', legacy).isDisabled(), true, 'Refresh released an uncertain cross-action lock');
    controls = await reopenOrderAssignment(controls, 'zakaz-qa-1003'); await button('Holatni qayta tekshirish', controls).waitFor();
    assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true, 'Assignment retention reloaded the document');
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await (await enabled(button('Holatni qayta tekshirish', controls))).click();
    await controls.getByText('Amal natijasi noaniq', { exact: true }).waitFor({ state: 'hidden' }); await enabled(button('Muzlatish', legacy));
    const data = await state(), used = data.wip.find(row => row.batch_id === 'qa-wip-1'), session = data.assignmentSessions[0];
    assert.equal(used.wip_status, 'in_use'); assert.equal(used.used_by_session_id, session.session_id); assert.equal(session.payload_json.input_wip_source_kind, 'progress_batch'); assert.equal(session.apparatus, apparatusIds.laminate);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')).length, 1, 'Observation repeated an unkeyed start');
    await documentHandle.dispose();
  }, () => control('/__qa/assignment', { scenario: 'wip-start' }));

  await run('assignment-opening-start-loss-stays-unresolved', async () => {
    const intakeForm = await openingForm(1); await button('Qabulni tasdiqlash', intakeForm).click(); await button('Yangi qabulni boshlash', intakeForm).waitFor();
    const batch = (await state()).openingWip[0].batches[0]; await button('Close', intakeForm).click();
    await control('/__qa/assignment', { scenario: 'opening-start' }); const controls = await orderAssignment();
    const form = await prepareAssignment(controls, 'QA Laminator · laminate', 'Ishni boshlash', async form => {
      await form.getByLabel('Kirish WIP partiyasi (QR bo‘lsa ixtiyoriy)', { exact: true }).fill(batch.batch_id); await form.getByLabel('Boshlang‘ich WIP QR kodi', { exact: true }).fill(batch.qr_payload);
    });
    await form.getByText('Boshlang‘ich WIP QR tasdiqlandi', { exact: true }).waitFor();
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/queue-action`, dropResponse: true, once: true }] });
    await button('Tasdiqlash', form).click(); await button('Holatni qayta tekshirish', controls).waitFor(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await enabled(button('Holatni qayta tekshirish', controls))).click(); await controls.getByText(/Joriy server holati aynan avvalgi amal natijasini tasdiqlamadi/).waitFor();
    await controls.getByText('Amal natijasi noaniq', { exact: true }).waitFor(); assert.equal(await button('Bir xil buyruq natijasini tekshirish', controls).count(), 0);
    const data = await state(); assert.equal(data.openingWip[0].batches[0].wip_status, 'in_use'); assert.equal(data.assignmentSessions[0].payload_json.input_wip_source_kind, 'opening_wip');
    const log = (await control('/__qa/log')).requests; assert.equal(log.filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')).length, 1);
    assert.equal(log.filter(row => row.path.endsWith('/progress-qr/report') && row.body.progress_batch_id === batch.batch_id).length, 0, 'Opening input was falsely verified through normal lineage');
  });

  await run('assignment-move-malformed-retained-observation', async () => {
    let controls = await orderAssignment(); const documentHandle = await page.locator('html').elementHandle(), before = (await state()).orders[0].map;
    const form = await prepareAssignment(controls, 'QA Flexo 1 · print', 'Uskunani almashtirish', form => choose('Yangi uskuna nomzodi', 'QA Flexo 2', form));
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/move`, responseBody: {}, once: true }] });
    await button('Tasdiqlash', form).click(); await button('Holatni qayta tekshirish', controls).waitFor();
    controls = await reopenOrderAssignment(controls); await button('Holatni qayta tekshirish', controls).waitFor();
    assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true); await button('Holatni qayta tekshirish', controls).click();
    await controls.getByText('Amal natijasi noaniq', { exact: true }).waitFor({ state: 'hidden' });
    const after = (await state()).orders[0].map; assert.equal(after.nodes.find(row => row.id === 'print').apparatus_id, apparatusIds.spare); assert.deepEqual(after.edges, before.edges); assert.deepEqual(after.nodes.map(row => row.id), before.nodes.map(row => row.id));
    const log = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/move')); assert.equal(log.length, 1); assert.equal(log[0].responseOverridden, true);
    await documentHandle.dispose();
  }, () => control('/__qa/assignment', { scenario: 'start' }));

  await run('assignment-paused-transfer-loss-exact-key-recovery', async () => {
    let controls = await orderAssignment(); const documentHandle = await page.locator('html').elementHandle();
    const form = await prepareAssignment(controls, 'QA Flexo 1 · print', 'To‘xtatilgan ishni ko‘chirish', async form => {
      await choose('Yangi uskuna nomzodi', 'QA Flexo 2', form); await form.getByLabel('To‘xtatish hisobotining WIP partiyasi', { exact: true }).fill('qa-paused-roll'); await form.getByLabel('Ko‘chirish sababi', { exact: true }).fill('QA Motor stopped');
    });
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/apparatus-transfer`, dropResponse: true, once: true }] });
    await button('Tasdiqlash', form).click(); await button('Bir xil buyruq natijasini tekshirish', controls).waitFor(); await screenshot('keyed-transfer-uncertain');
    controls = await reopenOrderAssignment(controls); await button('Bir xil buyruq natijasini tekshirish', controls).waitFor(); assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true);
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await (await enabled(button('Bir xil buyruq natijasini tekshirish', controls))).click(); await controls.getByText('Amal natijasi noaniq', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('To‘xtatilgan ish, sessiya, WIP va material biriktirish holati ko‘chirildi.', { exact: true }).waitFor();
    const data = await state(); assert.equal(data.assignmentSessions[0].session_id, 'qa-assignment-paused-transfer'); assert.equal(data.assignmentSessions[0].apparatus, apparatusIds.spare);
    const batch = data.wip.find(row => row.batch_id === 'qa-paused-roll'); assert.equal(batch.apparatus, apparatusIds.spare); assert.equal(batch.wip_status, 'waiting');
    assert.equal(data.rawAssignments[0].apparatus_id, apparatusIds.spare, 'Paused transfer did not preserve the actual material assignment identity');
    const log = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/apparatus-transfer'), 2); assert.deepEqual(log[0].body, log[1].body); assert.deepEqual(log.map(row => row.status), ['lost', 200]);
    assert.equal(Object.keys(data.assignmentCommands).length, 1); await documentHandle.dispose();
  }, () => control('/__qa/assignment', { scenario: 'paused-transfer' }));

  await run('assignment-lamination-handoff-mounted-input', async () => {
    const controls = await orderAssignment(); const form = await prepareAssignment(controls, 'QA Laminator · laminate', 'Ishni topshirish', async form => {
      await form.getByLabel('Ulangan kirish WIP partiyasi', { exact: true }).fill('qa-input-roll'); await form.getByLabel('Bosma qoldiq rulonlari', { exact: true }).fill('0'); await form.getByLabel('Plyonka qoldiq rulonlari', { exact: true }).fill('2'); await form.getByLabel('Umumiy chiqindi, kg', { exact: true }).fill('0');
    });
    await form.getByText('Ulangan kirish WIP va joriy operator tasdiqlandi', { exact: true }).waitFor(); await button('Tasdiqlash', form).click(); await form.waitFor({ state: 'hidden' });
    const data = await state(), session = data.assignmentSessions[0]; assert.equal(session.status, 'paused'); assert.equal(session.payload_json.worker_handoff, true); assert.equal(session.payload_json.roll_removed_from_apparatus, false);
    assert.equal(session.payload_json.lamination_print_leftover_rolls, 0); assert.equal(session.payload_json.lamination_film_leftover_rolls, 2); assert.equal(session.payload_json.total_waste, 0); assert.equal(session.payload_json.total_waste_uom, 'kg'); assert.equal(session.payload_json.description, '');
    assert.equal(data.wip.find(row => row.batch_id === 'qa-input-roll').wip_status, 'in_use'); assert.equal(session.payload_json.input_progress_batch_id, 'qa-input-roll');
    const log = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')); assert.equal(log.length, 1); assert.equal(log[0].body.worker_handoff, true); assert.equal(log[0].body.print_transport, 'offline'); assert.equal(Object.hasOwn(log[0].body, 'remove_roll_from_apparatus'), false);
  }, () => control('/__qa/assignment', { scenario: 'handoff' }));

  await run('assignment-handoff-loss-no-report-replay', async () => {
    const controls = await orderAssignment(); const form = await prepareAssignment(controls, 'QA Laminator · laminate', 'Ishni topshirish', async form => {
      for (const [label, value] of [['Ulangan kirish WIP partiyasi', 'qa-input-roll'], ['Bosma qoldiq rulonlari', '0'], ['Plyonka qoldiq rulonlari', '1'], ['Umumiy chiqindi, kg', '0.5']]) await form.getByLabel(label, { exact: true }).fill(value);
    });
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/queue-action`, dropResponse: true, once: true }] });
    await button('Tasdiqlash', form).click(); await button('Holatni qayta tekshirish', controls).waitFor(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await enabled(button('Holatni qayta tekshirish', controls))).click(); await controls.getByText(/Joriy ro‘yxat topshirish hisoboti va aniq miqdorlarni qayta tasdiqlamaydi/).waitFor();
    assert.equal(await button('Bir xil buyruq natijasini tekshirish', controls).count(), 0); assert.equal((await state()).assignmentSessions[0].payload_json.total_waste, 0.5);
    assert.equal((await state()).wip.find(row => row.batch_id === 'qa-input-roll').wip_status, 'in_use');
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')).length, 1);
  }, () => control('/__qa/assignment', { scenario: 'handoff' }));

  await run('assignment-preflight-loss-later-status-and-consumption', async () => {
    const controls = await orderAssignment(); const form = await prepareAssignment(controls, 'QA Flexo 1 · print', 'Rang sinovini boshlash');
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/print-preflight`, dropResponse: true, once: true }] });
    await button('Tasdiqlash', form).click(); await button('Bir xil buyruq natijasini tekshirish', controls).waitFor(); const hold = (await state()).assignmentHolds[0]; assert.equal(hold.status, 'running');
    await control('/__qa/preflight', { hold_id: hold.hold_id, status: 'passed' }); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await enabled(button('Bir xil buyruq natijasini tekshirish', controls))).click(); await controls.getByText('Amal natijasi noaniq', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await state()).assignmentHolds.length, 1); assert.equal((await state()).assignmentHolds[0].status, 'passed');
    await page.getByText('Rang sinovi serverda tasdiqlandi: o‘tgan.', { exact: true }).waitFor();
    const holds = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/print-preflight'), 2); assert.deepEqual(holds[0].body, holds[1].body); assert.deepEqual(holds.map(row => row.status), ['lost', 200]);
    const start = await prepareAssignment(controls, 'QA Flexo 1 · print', 'Ishni boshlash'); await button('Tasdiqlash', start).click(); await start.waitFor({ state: 'hidden' });
    assert.equal((await state()).assignmentHolds[0].status, 'consumed'); assert.equal((await state()).assignmentSessions[0].status, 'active');
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')); assert.equal(writes.length, 1); assert.equal(writes[0].body.print_preflight_hold_id, hold.hold_id);
  }, () => control('/__qa/assignment', { scenario: 'preflight' }));

  await run('assignment-preflight-refusal-and-changed-review', async () => {
    const controls = await orderAssignment(); let form = await prepareAssignment(controls, 'QA Flexo 1 · print', 'Rang sinovini boshlash');
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/print-preflight`, status: 403, error: 'forbidden', once: true }] });
    await button('Tasdiqlash', form).click(); await controls.getByText('Amal natijasi noaniq', { exact: true }).waitFor(); assert.equal((await state()).assignmentHolds.length, 0);
    assert.equal(await button('Rang sinovini boshlash', assignmentStage(controls, 'QA Flexo 1 · print')).isDisabled(), true);
    await button('Yangilash', controls).click(); await enabled(button('Bir xil buyruq natijasini tekshirish', controls));
    await controls.getByText('Amal natijasi noaniq', { exact: true }).waitFor();
    assert.equal(await button('Rang sinovini boshlash', assignmentStage(controls, 'QA Flexo 1 · print')).isDisabled(), true, 'Refresh released a dispatched unresolved command');
    assert.equal((await state()).assignmentHolds.length, 0);
    const writes = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/print-preflight'), 1); assert.equal(writes[0].status, 403);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/print-preflight')).length, 1, 'Ordinary refresh replayed a denied command');
  }, () => control('/__qa/assignment', { scenario: 'preflight' }));

  await run('assignment-preflight-fresh-changed-review-no-write', async () => {
    const controls = await orderAssignment(); const form = await prepareAssignment(controls, 'QA Flexo 1 · print', 'Rang sinovini boshlash');
    await control('/__qa/order', { id: 'zakaz-qa-1001', stageStates: { print: 'in_progress' } }); await button('Tasdiqlash', form).click();
    await controls.getByText(/Buyurtma, bosqich yoki navbat o‘zgargan/).waitFor(); assert.equal((await state()).assignmentHolds.length, 0);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/print-preflight')).length, 0, 'Concurrent stage change sent a fresh business command');
  }, () => control('/__qa/assignment', { scenario: 'preflight' }));

  await run('assignment-unknown-and-frozen-fail-closed', async () => {
    const controls = await orderAssignment(); await controls.getByText('Holat noma’lum', { exact: true }).first().waitFor();
    assert.equal(await button('Ishni boshlash', controls).count(), 0); assert.equal(await button('Uskunani almashtirish', assignmentStage(controls, 'QA Flexo 1 · print')).count(), 0);
    await control('/__qa/assignment', { scenario: 'start' }); await control('/__qa/order', { id: 'zakaz-qa-1001', control: 'frozen' }); await button('Yangilash', controls).click();
    await controls.getByText('Buyurtma muzlatilgan. Boshlash, topshirish va uskuna almashtirish amallari yopiq.', { exact: true }).first().waitFor();
    for (const action of ['Ishni boshlash', 'Uskunani almashtirish', 'To‘xtatilgan ishni ko‘chirish', 'Rang sinovini boshlash']) assert.equal(await button(action, controls).count(), 0);
    assert.equal((await control('/__qa/log')).requests.filter(row => row.method === 'POST' && [ '/queue-action', '/move', '/apparatus-transfer', '/print-preflight' ].some(path => row.path.endsWith(path))).length, 0);
  }, () => control('/__qa/assignment', { scenario: 'unknown' }));

  await run('assignment-legacy-uncertainty-locks-new-controls', async () => {
    let assignment = await orderAssignment('zakaz-qa-1002'); const documentHandle = await page.locator('html').elementHandle();
    const legacy = page.getByRole('region', { name: 'Buyurtma va apparat navbatini boshqarish', exact: true });
    await button('To‘xtatish va hisobot', legacy).click(); const form = dialog('To‘xtatish va hisobot');
    await form.getByLabel('Ishlab chiqarilgan miqdor').fill('1250'); await form.getByLabel('O‘lchov birligi', { exact: true }).fill('m');
    await control('/__qa/config', { rules: [{ method: 'POST', path: `${base}/production-maps/queue-action`, dropResponse: true, once: true }] });
    await button('Tasdiqlash', form).click(); await legacy.getByText('Amal natijasi noaniq', { exact: true }).waitFor();
    await assignment.getByText(/Shu buyurtmaning boshqa ishlab chiqarish amali/).waitFor();
    assert.equal(await button('Uskunani almashtirish', assignmentStage(assignment, 'QA Laminator · laminate')).isDisabled(), true, 'Legacy uncertainty permitted a new assignment preflight');
    await button('Joriy holatni o‘qish', legacy).click(); await legacy.getByText('Amal natijasi noaniq', { exact: true }).waitFor();
    assignment = await reopenOrderAssignment(assignment, 'zakaz-qa-1002'); await assignment.getByText(/Shu buyurtmaning boshqa ishlab chiqarish amali/).waitFor();
    assert.equal(await page.evaluate(original => original === document.documentElement, documentHandle), true);
    assert.equal(await button('Uskunani almashtirish', assignmentStage(assignment, 'QA Laminator · laminate')).isDisabled(), true);
    assert.equal((await state()).orders.find(row => row.map.id === 'zakaz-qa-1002').stages.print, 'paused');
    const writes = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && ['/queue-action', '/move', '/apparatus-transfer', '/print-preflight'].some(path => row.path.endsWith(path)));
    assert.equal(writes.length, 1, 'Refresh or remount repeated a legacy write or dispatched a conflicting new action'); await documentHandle.dispose();
  });

  await run('manufacturing-demo-cohort-rank-keyboard-pointer-touch', async () => {
    await open('/app/production-time'); const overview = page.getByRole('region', { name: 'Ishlab chiqarish vaqtiga umumiy qarash', exact: true });
    const plot = overview.getByLabel('Qayd etilgan bosqich davomiyliklari, uzunligiga ko‘ra', { exact: true }); await plot.getByRole('button').waitFor();
    assert.equal(await plot.getByRole('button').count(), 1); assert.equal(await plot.locator('polyline').count(), 0, 'A single native record gained an invented curve');
    await control('/__qa/config', { manufacturingDemoCohort: true, manufacturingDemoInvalidRecord: true }); await button('Yangilash').first().click();
    const points = plot.getByRole('button'); await points.nth(7).waitFor(); assert.equal(await points.count(), 8);
    await overview.getByText('Olingan buyurtma tarixi', { exact: true }).locator('..').getByText('10', { exact: true }).waitFor();
    await overview.getByText('Vaqt oralig‘i mavjud', { exact: true }).locator('..').getByText('9', { exact: true }).waitFor();
    assert.equal((await plot.locator('polyline').getAttribute('points')).trim().split(/\s+/).length, 8, 'Ranking curve did not use exactly the eight observed points');
    const ranks = overview.getByRole('region', { name: 'Eng uzun qayd etilgan jarayonlar', exact: true }); assert.equal(await ranks.getByRole('listitem').count(), 8);
    assert.equal(await ranks.getByText(/#4099/).count(), 0, 'Stage-less legacy record entered duration rankings');
    await points.first().focus();
    for (let index = 0; index < 8; index++) {
      if (index) await page.keyboard.press('Tab');
      assert.equal(await points.nth(index).evaluate(node => node === document.activeElement), true, `Ranking point ${index + 1} was not keyboard reachable`);
      assert.equal(await points.nth(index).getAttribute('aria-pressed'), 'true');
    }
    for (let index = 0; index < 8; index++) { await points.nth(index).hover(); assert.equal(await points.nth(index).getAttribute('aria-pressed'), 'true', `Normal pointer selection failed at ranking point ${index + 1}`); }
    await screenshot('demo-eight-native-ranks');
    await page.setViewportSize({ width: 390, height: 844 });
    for (let index = 0; index < 8; index++) {
      await points.nth(index).scrollIntoViewIfNeeded(); const target = await points.nth(index).boundingBox(); assert.ok(target);
      await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2); assert.equal(await points.nth(index).getAttribute('aria-pressed'), 'true', `Touch selection failed at ranking point ${index + 1}`);
    }
    assert.equal(await plot.locator('button[aria-pressed="true"]').count(), 1); await screenshot('demo-mobile-native-ranks');
    const orderNumber = (await points.nth(7).getAttribute('aria-label')).match(/#(\d+)/)[1];
    await ranks.getByRole('listitem').nth(7).getByRole('button').click(); await page.waitForURL(value => value.searchParams.get('orderId') === `zakaz-${orderNumber}`);
    await page.getByRole('region', { name: 'Bosqichlar va vaqt qaydlari', exact: true }).waitFor();
    const log = (await control('/__qa/log')).requests; assert.ok(log.some(row => row.path === `${base}/production-maps` && row.query.id === `zakaz-${orderNumber}` && row.status === 200));
    assert.equal(log.filter(row => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) && row.path.startsWith(base)).length, 0, 'DEMO history interaction sent a business write');
  }, undefined, { hasTouch: true });

  await run('factory-stage-isolation-single-model', async () => {
    await open('/app/factory-map?orderId=zakaz-qa-1002');
    const canvas = page.locator('[data-model-viewer-state][aria-busy="false"] canvas[data-factory-map-canvas][tabindex="0"]'); await canvas.waitFor({ timeout: 45_000 });
    const handle = await canvas.elementHandle(), modelRequests = outcomes.at(-1).assetRequests.length;
    const strip = page.locator('[data-factory-stage-strip]'); assert.equal(await strip.count(), 1);
    await strip.locator('[data-stage-key="node:print"]').click();
    await page.locator('canvas[data-stage-view="isolated"][data-isolated-object-id="node:1:instance:0"]').waitFor();
    assert.deepEqual(JSON.parse(await canvas.getAttribute('data-visible-apparatus-ids')), ['node:1:instance:0']);
    await button('Keyingi bosqich', strip).click();
    await page.locator('canvas[data-stage-view="isolated"][data-isolated-object-id="node:6:instance:6"]').waitFor();
    assert.equal(JSON.parse(await canvas.locator('..').getAttribute('data-model-viewer-state')).stageMotionAllowed, false, 'A future stage gained ERP motion');
    await page.locator('canvas[data-factory-map-canvas][data-active-reels="0"]').waitFor();
    await screenshot('isolated-future-stage'); await button('Oldingi bosqich', strip).click();
    await strip.locator('[data-stage-key="node:print"][aria-current="step"]').waitFor();
    assert.equal(await page.evaluate(original => original === document.querySelector('canvas[data-factory-map-canvas]'), handle), true, 'Stage navigation recreated the canvas');
    assert.equal(outcomes.at(-1).assetRequests.length, modelRequests, 'Stage navigation fetched another CAD model');
    await strip.locator('[data-stage-key="overview"]').click(); await page.locator('canvas[data-stage-view="overview"]').waitFor();
    await page.getByLabel('Xaritadagi apparatlar', { exact: true }).getByRole('button', { name: /QA Flexo 1/ }).first().click();
    await strip.locator('[data-stage-key="node:print"][aria-current="step"]').waitFor();
    await button('To‘liq ekran').click(); await button('To‘liq ekrandan chiqish').waitFor(); assert.equal(await page.locator('[data-factory-stage-strip]').count(), 1);
    await page.keyboard.press('Escape'); await button('To‘liq ekran').waitFor();
    await strip.locator('[data-stage-key="node:print"][aria-current="step"]').waitFor();
    await handle.dispose();
  });

  await run('factory-stage-repeated-unbound-stale', async () => {
    await open('/app/factory-map?orderId=zakaz-qa-1001');
    const canvas = page.locator('[data-model-viewer-state][aria-busy="false"] canvas[data-factory-map-canvas][tabindex="0"]'); await canvas.waitFor({ timeout: 45_000 });
    const strip = page.locator('[data-factory-stage-strip]');
    await strip.locator('[data-stage-key="node:print-again"]').click();
    await strip.locator('[data-stage-key="node:print-again"][aria-current="step"]').waitFor();
    await page.locator('canvas[data-isolated-object-id="node:1:instance:0"]').waitFor();
    await page.getByLabel('Xaritadagi apparatlar', { exact: true }).getByRole('button', { name: /QA Flexo 1/ }).first().click();
    await strip.locator('[data-stage-key="node:print-again"][aria-current="step"]').waitFor();
    await control('/__qa/apparatus', { apparatus_id: apparatusIds.laminate, placement: null }); await button('Yangilash').first().click();
    await strip.locator('[data-stage-key="node:laminate"]').click();
    await strip.getByText('Bu bosqichning apparati hali 3D modelga biriktirilmagan.', { exact: true }).waitFor();
    await page.locator('canvas[data-stage-view="overview"][data-isolated-object-id=""]').waitFor();
    assert.equal(JSON.parse(await canvas.locator('..').getAttribute('data-model-viewer-state')).stageMotionAllowed, false);
    await strip.locator('[data-stage-key="node:print-again"]').click();
    await control('/__qa/config', { rules: [{ method: 'GET', path: `${base}/production-maps/sequence`, status: 500, error: 'store_failed' }] });
    await button('Yangilash').first().click(); await page.getByText('Ish holati yangilanmadi', { exact: true }).waitFor({ timeout: 20_000 });
    await strip.getByText(/Ish holati yangilanmagan: bajarilayotgan bosqich noma’lum/).waitFor();
    await page.locator('canvas[data-active-reels="0"]').waitFor();
    assert.equal(JSON.parse(await canvas.locator('..').getAttribute('data-model-viewer-state')).stageMotionAllowed, false);
    await screenshot('stale-repeated-stage');
  }, async () => {
    const map = (await state()).orders[0].map, first = map.nodes.find(node => node.id === 'print');
    map.nodes.splice(map.nodes.findIndex(node => node.id === 'laminate'), 0, { ...first, id: 'print-again', title: 'QA Takroriy bosma', y: 360 });
    map.edges = map.edges.filter(edge => !(edge.from === 'print' && edge.to === 'laminate'));
    map.edges.push({ from: 'print', to: 'print-again' }, { from: 'print-again', to: 'laminate' });
    await control('/__qa/order', { id: map.id, mapPatch: { nodes: map.nodes, edges: map.edges }, stageStates: { 'print-again': 'pending' } });
  });

  await run('factory-stage-unresolved-reduced-motion-touch', async () => {
    await open('/app/factory-map?orderId=zakaz-qa-1001');
    const canvas = page.locator('[data-model-viewer-state][aria-busy="false"] canvas[data-factory-map-canvas][tabindex="0"]'); await canvas.waitFor({ timeout: 45_000 });
    const strip = page.locator('[data-factory-stage-strip]'), group = strip.locator('[data-stage-key="group:qa-print-choice"]'); await group.waitFor();
    await group.scrollIntoViewIfNeeded();
    const target = await group.boundingBox(); assert.ok(target); await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    await strip.getByText('Bu bosqich uchun muqobil apparat hali tanlanmagan.', { exact: true }).waitFor();
    await page.locator('canvas[data-stage-view="overview"][data-isolated-object-id=""]').waitFor();
    assert.equal(await canvas.getAttribute('data-selected-object-id'), '', 'Unresolved alternative guessed an apparatus');
    await strip.locator('[data-stage-key="node:cut"]').click(); await page.locator('canvas[data-isolated-object-id="node:18:instance:0"]').waitFor();
    await page.locator('canvas[data-active-reels="0"]').waitFor(); await page.locator('canvas[data-camera-motion="idle"]').waitFor();
    await button('To‘liq ekran').click(); await button('To‘liq ekrandan chiqish').waitFor(); assert.equal(await page.locator('[data-factory-stage-strip]').count(), 1);
    await screenshot('reduced-motion-touch-stage'); await page.keyboard.press('Escape'); await button('To‘liq ekran').waitFor();
    await strip.locator('[data-stage-key="node:cut"][aria-current="step"]').waitFor();
  }, async () => {
    const map = (await state()).orders[0].map, first = map.nodes.find(node => node.id === 'print');
    Object.assign(first, { alternative_group_id: 'qa-print-choice', alternative_group_label: 'QA Muqobil bosma' });
    map.nodes.splice(map.nodes.findIndex(node => node.id === 'laminate'), 0, { ...first, id: 'print-alt', apparatus_id: apparatusIds.spare, title: 'QA Muqobil Flexo 2', y: 360 });
    map.edges.push({ from: 'order', to: 'print-alt' }, { from: 'print-alt', to: 'laminate' });
    await control('/__qa/order', { id: map.id, mapPatch: { nodes: map.nodes, edges: map.edges }, stageStates: { 'print-alt': 'pending' } });
  }, { hasTouch: true, reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  await runWorkflowExtensions({ run, control, state, waitState, waitRequests, button, dialog, choose, open, enabled, screenshot, orderAssignment, reopenOrderAssignment, openingForm, apparatusIds, base, apiOrigin, fixtureLogin, getPage: () => page });
  await runMaterialLinkAcceptance({ run, control, state, waitState, waitRequests, button, dialog, open, enabled, screenshot, orderAssignment, reopenOrderAssignment, apparatusIds, getPage: () => page });
  assert.ok(outcomes.length, 'No acceptance scenario matched --only');
} catch (failure) {
  outcomes.push({ id: 'runtime', status: 'failed', error: redact(failure.stack || failure.message), screenshots: [] });
  const report = JSON.stringify({ synthetic: true, productionVerified: false, runId, sourceRevision, buildDirectory, fixtureVersion, webOrigin, apiOrigin, outcomes, blockedRequests, consoleErrors }, null, 2);
  await writeFile(`${output}/results.json`, report); await writeFile(`${runDirectory}/results.json`, report);
  process.stderr.write(`FAILED runtime: ${redact(failure.message)}\n`);
} finally {
  await browser?.close();
}
const failed = outcomes.filter(outcome => outcome.status !== 'passed');
process.stdout.write(`Synthetic browser acceptance: ${outcomes.length - failed.length}/${outcomes.length} passed. Report: ${output}/results.json\n`);
if (failed.length) process.exitCode = 1;
