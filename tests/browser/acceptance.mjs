import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureLogin, apparatusIds } from '../fixtures/erp-seed.mjs';

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
const outcomes = [], blockedRequests = [], consoleErrors = [];
const selected = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',');
const redact = value => String(value).replaceAll(fixtureLogin.phone, '[synthetic-phone]').replaceAll(fixtureLogin.code, '[synthetic-code]').replaceAll('fixture-admin-session', '[synthetic-token]');
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
async function screenshot(label) {
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
async function login() {
  await open('/kirish');
  await page.getByLabel('Server manzili').fill(apiOrigin);
  await page.getByLabel('Telefon raqami').fill(fixtureLogin.phone);
  await page.getByLabel('Kirish kodi', { exact: true }).fill(fixtureLogin.code);
  await button('Kirish').click();
  await page.waitForURL(`${webOrigin}/app/home`);
  await page.getByRole('heading', { name: 'Ish maydoni', exact: true }).waitFor();
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
    const report = JSON.stringify({ synthetic: true, productionVerified: false, runId, webOrigin, apiOrigin, outcomes, blockedRequests, consoleErrors }, null, 2);
    await writeFile(`${output}/results.json`, report); await writeFile(`${runDirectory}/results.json`, report);
  }
}

await mkdir(runDirectory, { recursive: true });
try {
  const health = await control('/__qa/health');
  assert.equal(health.synthetic, true, 'Refuse non-fixture API');
  assert.ok(health.fixtureVersion >= 4, 'Restart the local fixture to load calculator, WIP and planning contracts');
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
    await page.getByText('Hozircha buyurtmalar yo‘q.', { exact: true }).waitFor();
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
    const timeline = page.locator('[data-slot="card"]').filter({ has: page.getByText('Bosqichlar va vaqt qaydlari', { exact: true }) }).last();
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
    await page.keyboard.press('Escape'); await dialog('Ish tafsiloti').waitFor({ state: 'hidden' });
    await profile.getByRole('tab', { name: 'Partiyalar', exact: true }).click(); await choose('Partiyalar tarixi hajmi', 'Oxirgi 200 ta', profile);
    await waitState(data => data.wip[0].worker_ref === 'qa-worker-1', 'Native worker batch identity changed');
    await profile.getByRole('button', { name: 'qa-wip-1 partiya tafsiloti', exact: true }).click();
    await dialog('Partiya tafsiloti').getByText('qa-wip-1', { exact: true }).waitFor();
    assert.equal(await page.getByText('QA-PROFILE-ONLY', { exact: true }).count(), 0, 'Worker login code entered the UI');
    await screenshot('bounded-worker-batch'); await page.keyboard.press('Escape'); await dialog('Partiya tafsiloti').waitFor({ state: 'hidden' });
    assert.ok((await control('/__qa/log')).requests.some(row => row.path.endsWith('/progress-qr/history') && row.query.worker_ref === 'qa-worker-1' && row.query.limit === '200'));
    await open('/app/workers?selected=qa-worker-2'); await profile.getByText('Ochiq ishlar yo‘q.', { exact: true }).waitFor();
    await profile.getByRole('tab', { name: 'Partiyalar', exact: true }).click(); await profile.getByText('So‘nggi partiyalar yo‘q.', { exact: true }).waitFor();
    await profile.getByRole('tab', { name: 'Hodisalar', exact: true }).click(); await profile.getByText('So‘nggi hodisalar yo‘q.', { exact: true }).waitFor();
    await control('/__qa/config', { rules: [{ method: 'GET', path: `${base}/workers/profile-detail`, status: 500, error: 'store_failed', once: true }] });
    await button('Yangilash', profile).click(); await profile.getByRole('alert').waitFor(); await screenshot('worker-server-error');
    await button('Qayta yuklash', profile).click(); await profile.getByRole('alert').waitFor({ state: 'hidden' });
    assert.equal((await control('/__qa/log')).requests.filter(row => ['PUT', 'DELETE'].includes(row.method)).length, 0, 'Worker activity reads sent mutations');
  });

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
  assert.ok(outcomes.length, 'No acceptance scenario matched --only');
} catch (failure) {
  outcomes.push({ id: 'runtime', status: 'failed', error: redact(failure.stack || failure.message), screenshots: [] });
  const report = JSON.stringify({ synthetic: true, productionVerified: false, runId, webOrigin, apiOrigin, outcomes, blockedRequests, consoleErrors }, null, 2);
  await writeFile(`${output}/results.json`, report); await writeFile(`${runDirectory}/results.json`, report);
  process.stderr.write(`FAILED runtime: ${redact(failure.message)}\n`);
} finally {
  await browser?.close();
}
const failed = outcomes.filter(outcome => outcome.status !== 'passed');
process.stdout.write(`Synthetic browser acceptance: ${outcomes.length - failed.length}/${outcomes.length} passed. Report: ${output}/results.json\n`);
if (failed.length) process.exitCode = 1;
