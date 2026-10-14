import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureLogin, fixtureToken, apparatusIds } from '../fixtures/erp-seed.mjs';

const web = 'http://127.0.0.1:5186', api = 'http://127.0.0.1:5199', path = '/v1/mobile/admin/production-maps/paddons';
const runId = new Date().toISOString().replace(/[:.]/g, '-'), output = fileURLToPath(new URL(`../../docs/qa/paddon-handoff/${runId}/`, import.meta.url));
const selectedCases = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
const viewportCapture = process.argv.includes('--viewport-capture');
const allowed = new Set([web, api]), outside = [], pageErrors = [], outcomes = [];
const sourceRevision = process.env.QA_SOURCE_REV || 'unrecorded';
const previewMetadata = JSON.parse(await readFile('/tmp/accord-web-quality-local-5186.json', 'utf8'));
assert.equal(previewMetadata.cwd, fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''));
assert.equal(previewMetadata.port, 5186);
const buildDirectory = previewMetadata.command[previewMetadata.command.indexOf('--outDir') + 1];
assert.ok(buildDirectory.startsWith('/tmp/accord-web-quality-static-'));
if (process.env.QA_BUILD_DIR) assert.equal(process.env.QA_BUILD_DIR, buildDirectory, 'QA metadata must match the actually served preview build');
const redact = value => [fixtureLogin.phone, fixtureLogin.code, fixtureToken].reduce((result, secret) => result.replaceAll(secret, '[synthetic-credential]'), String(value));
const pkg = process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright', { chromium } = await import(pkg.startsWith('/') ? pathToFileURL(pkg).href : pkg);
let browser, page, context, outcome;
async function control(url, body) { assert.ok(url.startsWith('/__qa/')); const result = await fetch(api + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.ok(result.ok, `${url}: ${result.status}`); return result.json(); }
async function native(url) { const result = await fetch(api + path + url, { headers: { authorization: 'Bearer ' + fixtureToken } }); assert.ok(result.ok, `${url}: ${result.status}`); return result.json(); }
const writes = async () => (await control('/__qa/log')).requests.filter(row => row.path.startsWith(path) && ['POST','PUT'].includes(row.method));
const dialog = () => page.getByRole('dialog').filter({has: page.getByRole('heading', {name: /^(Faol kesish paddoni|Faol paddon amali natijasini tekshirish)$/})}), button = (name, root = page) => root.getByRole('button', { name, exact: true });
async function until(get, predicate, label, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await get(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 70)); } throw new Error(label); }
async function enabled(target) { await target.waitFor(); await until(() => target.isEnabled(), value => value, 'Control remained disabled'); return target; }
const title = name => dialog().getByRole('heading', { name, exact: true }).waitFor();
async function capture(label) {
  await page.evaluate(() => { let badge = document.getElementById('qa-paddon-handoff-demo'); if (!badge) { badge = document.createElement('div'); badge.id = 'qa-paddon-handoff-demo'; document.body.append(badge); } badge.textContent = 'DEMO · Sintetik · Faol paddon'; Object.assign(badge.style, { position: 'fixed', bottom: '6px', right: '6px', zIndex: '2147483647', pointerEvents: 'none', padding: '3px 7px', border: '1px solid #737373', borderRadius: '4px', background: document.documentElement.classList.contains('dark') ? '#171717' : '#fff', color: document.documentElement.classList.contains('dark') ? '#d4d4d4' : '#171717', font: '500 10px/15px system-ui' }); });
  await page.evaluate(async () => { let stable = 0, start = performance.now(); while (stable < 2 && performance.now() - start < 1600) { await new Promise(requestAnimationFrame); stable = document.getAnimations().some(animation => animation.playState === 'running' && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) ? 0 : stable + 1; } });
  const file = `${outcome.id}-${label}.png`; await page.screenshot({ path: output + file, fullPage: !viewportCapture }); outcome.screenshots.push({ file, route: page.url(), viewport: page.viewportSize(), fullPage: !viewportCapture, theme: await page.locator('html').getAttribute('class') });
}
async function run(id, execute, { scenario = 'handoff', capabilities, profileOverride, assignedApparatus, rules, denied = false, ...options } = {}) {
  if (selectedCases && !selectedCases.includes(id)) return;
  outcome = { id, status: 'running', screenshots: [] }; outcomes.push(outcome); const started = Date.now();
  try {
    await control('/__qa/reset', {}); await control('/__qa/paddon-handoff', { scenario }); if (capabilities || profileOverride || assignedApparatus || rules) await control('/__qa/config', { ...(capabilities ? { capabilities } : {}), ...(profileOverride ? { profileOverride } : {}), ...(assignedApparatus ? { assignedApparatus } : {}), ...(rules ? { rules } : {}) });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', ...options });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (['data:', 'blob:', 'about:'].includes(url.protocol) || allowed.has(url.origin)) return route.continue(); outside.push({ case: id, origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient'); });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => { const url = new URL(socket.url()), origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`; if (allowed.has(origin)) socket.connectToServer(); else { outside.push({ case: id, origin, path: url.pathname }); socket.close({ code: 1008 }); } });
    page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push({ case: id, message: redact(error.message) }));
    await page.goto(web + '/kirish'); await page.getByLabel('Server manzili').fill(api); await page.getByLabel('Telefon raqami').fill(fixtureLogin.phone); await page.getByLabel('Kirish kodi', { exact: true }).fill(fixtureLogin.code); await button('Kirish').click(); if (denied) await page.getByText('Bu web qismiga kirish uchun administrator huquqi talab qilinadi.', { exact: true }).waitFor(); else await page.waitForURL(web + '/app/home');
    await page.goto(web + '/app/paddons'); if (!denied) await page.getByRole('heading', { name: 'Paddonlar', exact: true }).waitFor(); await execute();
    outcome.requests = (await control('/__qa/log')).requests; assert.equal(outside.filter(row => row.case === id).length, 0); assert.deepEqual(pageErrors.filter(row => row.case === id), []); assert.deepEqual(outcome.requests.filter(row => row.error === 'fixture_route_not_implemented'), []);
    await capture('passed'); outcome.status = 'passed';
  } catch (error) { outcome.status = 'failed'; outcome.error = redact(error.stack || error.message); if (page && !page.isClosed()) try { await capture('failed'); } catch {} try { outcome.requests = (await control('/__qa/log')).requests; } catch {} }
  finally { outcome.durationMs = Date.now() - started; await context?.close(); context = null; page = null; await writeFile(output + 'results.json', JSON.stringify({ synthetic: true, productionVerified: false, runId, sourceRevision, buildDirectory, fixtureVersion, web, api, outcomes, outside, pageErrors }, null, 2)); process.stdout.write(`${outcome.status.toUpperCase()} ${id}${outcome.error ? ': ' + outcome.error.split('\n')[0] : ''}\n`); }
}
const cut = apparatusIds.cut, otherCut = 'apparatus:qa:handoff-cut-0';
const operator = { profileOverride: { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Operator' }, assignedApparatus: [cut] };
const activeSelection = id => native('/active?apparatus=' + encodeURIComponent(id || cut));
async function selectMachine(id = cut) {
  const state = (await control('/__qa/state')).state, name = state.apparatus.find(row => row.apparatus_id === id).display.display_name;
  await (await enabled(dialog().getByRole('combobox', { name: 'Kesish apparati' }))).click();
  await page.getByRole('option', { name, exact: true }).click();
  await dialog().locator('[aria-label="Serverdagi faol paddon"]').getByText(id, { exact: true }).waitFor();
  await enabled(dialog().getByLabel('Faol paddon uchun kod'));
}
async function openHandoff(id = cut) { await button('Faol kesish paddoni').click(); await title('Faol kesish paddoni'); await selectMachine(id); }
async function choose(code) { await (await enabled(dialog().getByLabel('Faol paddon uchun kod'))).fill(code); await (await enabled(button('Faol paddonni saqlash', dialog()))).click(); }
async function chosen(code, id = cut) { await until(() => activeSelection(id), row => row.code === code, 'Native active selection did not match'); await dialog().locator('[aria-label="Serverdagi faol paddon"]').getByText(code ? `Faol paddon: ${code}` : 'Faol paddon tanlanmagan.', { exact: true }).waitFor(); }
async function inspectNext(code = '00002') {
  await button('Keyingi paddonga o‘tish', dialog()).click(); await dialog().getByLabel('Bosish qulfi bor paddon kodi').fill(code);
  await button('Manbani tekshirish', dialog()).click(); await dialog().locator('[aria-label="Paddon tafsilotlari"]').waitFor();
}
async function confirmNext() { await dialog().getByRole('checkbox', { name: 'Keyingi paddon shu hisob va apparatning faol tanlovini almashtirishini tasdiqlayman.' }).check(); }
async function recover({ expected, next = false, preserve = false } = {}) {
  await title('Faol paddon amali natijasini tekshirish'); await capture('unknown');
  const before = (await writes()).length; assert.ok(before >= 1);
  assert.equal(await button('Faol paddonni saqlash', dialog()).count(), 0); assert.equal(await button('Keyingi paddonni ochish', dialog()).count(), 0);
  await (await enabled(button('Joriy faol paddonni tekshirish', dialog()))).click();
  await dialog().getByText(/Bu asl amal natijasini tasdiqlamaydi/).waitFor();
  if (next) await dialog().getByText(/yo‘qolgan javobdagi keyingi paddon aniqlanmagan/).waitFor();
  if (expected !== undefined) await dialog().locator('[aria-label="Serverdagi faol paddon"]').getByText(expected ? `Faol paddon: ${expected}` : 'Faol paddon tanlanmagan.', { exact: true }).waitFor();
  await capture('observation'); assert.equal((await writes()).length, before);
  if (preserve) return;
  assert.equal(await button('Faol paddon tekshiruvini yakunlash', dialog()).isDisabled(), true);
  await dialog().getByRole('checkbox', { name: 'Avvalgi amal va joriy tanlovni ko‘rdim. Asl javob tasdiqlanmaganini tushunaman.' }).check();
  await button('Faol paddon tekshiruvini yakunlash', dialog()).click(); await title('Faol kesish paddoni'); assert.equal((await writes()).length, before);
}
const fixtureVersion = (await control('/__qa/health')).fixtureVersion; assert.ok(fixtureVersion >= 13);
await mkdir(output, { recursive: true }); browser = await chromium.launch({ headless: true });
try {
  await run('admin-select-clear-native-fields', async () => {
    await openHandoff(); assert.equal(await button('Keyingi paddonga o‘tish', dialog()).count(), 0);
    await choose('00003'); await chosen('00003'); await capture('selected');
    await (await enabled(button('Faol tanlovni tozalash', dialog()))).click(); await chosen(null);
    const sent = await writes(); assert.equal(sent.length, 2); assert.ok(sent.every(row => row.body.apparatus === cut)); assert.deepEqual(sent.map(row => Object.keys(row.body).sort()), [['apparatus', 'code'], ['apparatus', 'code']]);
    assert.ok(sent.every(row => row.method === 'PUT' && row.path === path + '/active' && row.idempotencyKeyPresent === false));
  });
  await run('choice-search-keeps-code-and-apparatus', async () => {
    await openHandoff(); await button('00003 paddonini tanlash', dialog()).click();
    await dialog().getByLabel('Tanlash uchun paddonlarni qidirish').fill('no-matching-paddon'); await dialog().getByText(/Tanlangan kod saqlanmoqda/).waitFor();
    await dialog().getByLabel('Kesish apparatini qidirish').fill('QA Handoff CUT');
    await dialog().locator('[aria-label="Serverdagi faol paddon"]').getByText(cut, { exact: true }).waitFor();
    assert.equal(await dialog().getByLabel('Faol paddon uchun kod').inputValue(), '00003');
    await (await enabled(button('Faol paddonni saqlash', dialog()))).click(); await chosen('00003'); assert.equal((await writes())[0].body.apparatus, cut);
  });
  await run('apparatus-scoped-independent-selections', async () => {
    await openHandoff(); await choose('00003'); await chosen('00003'); await selectMachine(otherCut);
    await choose('00001'); await chosen('00001', otherCut); await selectMachine(cut); await chosen('00003'); assert.equal((await writes()).length, 2);
  });
  await run('bounded-direct-code-and-pinned-machine', async () => {
    await openHandoff(); await dialog().getByText(/500 tagacha apparat o‘qildi/).waitFor(); await dialog().getByText(/200 tagacha ochiq paddon yuklandi/).waitFor();
    assert.equal(await button('00205 paddonini tanlash', dialog()).count(), 0); await choose('00205'); await chosen('00205');
    await dialog().getByLabel('Kesish apparatini qidirish').fill('QA Handoff CUT 504'); await dialog().locator('[aria-label="Serverdagi faol paddon"]').getByText(cut, { exact: true }).waitFor();
    assert.equal((await writes()).length, 1);
  }, { scenario: 'bounded' });
  await run('empty-picker-keeps-server-null', async () => { await openHandoff(); await dialog().getByText('Tanlash uchun ochiq paddonlar yo‘q.', { exact: true }).waitFor(); assert.equal(await button('Faol paddonni saqlash', dialog()).isDisabled(), true); assert.equal(await button('Faol tanlovni tozalash', dialog()).isDisabled(), true); assert.equal((await writes()).length, 0); }, { scenario: 'empty' });
  await run('stale-active-preflight-no-put', async () => {
    await openHandoff(); await dialog().getByLabel('Faol paddon uchun kod').fill('00003'); await control('/__qa/paddon-handoff', { action: 'concurrent', apparatus: cut, code: '00001' });
    await button('Faol paddonni saqlash', dialog()).click(); await dialog().getByText(/Faol paddon boshqa joyda o‘zgargan/).waitFor(); assert.equal((await writes()).length, 0);
    await button('Joriy tanlovni ko‘rib qayta boshlash', dialog()).click(); await chosen('00001');
  });
  await run('stale-target-lock-no-put', async () => { await openHandoff(); await dialog().getByLabel('Faol paddon uchun kod').fill('00003'); await control('/__qa/paddon-handoff', { action: 'lock', code: '00003' }); await button('Faol paddonni saqlash', dialog()).click(); await button('Joriy tanlovni ko‘rib qayta boshlash', dialog()).waitFor(); assert.equal((await writes()).length, 0); });
  await run('retired-canonical-preflight-no-put', async () => { await openHandoff(); await dialog().getByLabel('Faol paddon uchun kod').fill('00003'); await control('/__qa/paddon-handoff', { action: 'retire-apparatus', apparatus: cut }); await button('Faol paddonni saqlash', dialog()).click(); await button('Joriy tanlovni ko‘rib qayta boshlash', dialog()).waitFor(); assert.equal((await writes()).length, 0); });
  for (const [status, error] of [[403, 'forbidden'], [409, 'paddon_locked']]) await run(`native-${status}-known-refusal`, async () => {
    await openHandoff(); await control('/__qa/config', { rules: [{ method: 'PUT', path: path + '/active', once: true, status, error }] }); await choose('00003');
    await button('Joriy tanlovni ko‘rib qayta boshlash', dialog()).waitFor(); assert.equal((await writes()).length, 1); assert.equal((await writes())[0].status, status);
    assert.equal(await dialog().getByRole('heading', { name: 'Faol paddon amali natijasini tekshirish' }).count(), 0); assert.equal(await button('Faol paddonni saqlash', dialog()).isDisabled(), true);
  });
  await run('operator-next-confirmation-and-reuse', async () => {
    await openHandoff(); await inspectNext(); assert.equal(await button('Keyingi paddonni ochish', dialog()).isDisabled(), true); await capture('confirmation'); await confirmNext(); await button('Keyingi paddonni ochish', dialog()).click();
    const first = await until(() => activeSelection(), row => !!row.code, 'Successor missing'); await chosen(first.code); const count = (await control('/__qa/state')).state.paddons.length;
    await inspectNext(); await confirmNext(); await button('Keyingi paddonni ochish', dialog()).click();
    await until(() => writes(), rows => rows.length === 2, 'Second explicit handoff missing'); await chosen(first.code); assert.equal((await control('/__qa/state')).state.paddons.length, count);
    assert.equal((await native('/detail?code=00002')).paddon.locked_at_unix !== null, true);
  }, operator);
  await run('next-locked-received-source-is-allowed', async () => { await control('/__qa/paddon-handoff', { action: 'received', code: '00002' }); await openHandoff(); await inspectNext(); await confirmNext(); await button('Keyingi paddonni ochish', dialog()).click(); const selected = await until(() => activeSelection(), row => !!row.code, 'Received source successor missing'); await chosen(selected.code); assert.equal((await writes()).length, 1); }, operator);
  await run('next-source-lock-cycle-changed-no-post', async () => { await openHandoff(); await inspectNext(); await confirmNext(); await control('/__qa/paddon-handoff', { action: 'unlock', code: '00002' }); await control('/__qa/paddon-handoff', { action: 'lock', code: '00002' }); await button('Keyingi paddonni ochish', dialog()).click(); await dialog().getByText(/Manba paddonning bosish qulfi o‘zgargan/).waitFor(); assert.equal((await writes()).length, 0); }, operator);
  await run('next-source-unlocked-no-action', async () => { await openHandoff(); await inspectNext('00007'); await dialog().getByText(/Bu paddonda bosish qulfi yo‘q/).waitFor(); assert.equal(await button('Keyingi paddonni ochish', dialog()).count(), 0); assert.equal((await writes()).length, 0); }, operator);
  await run('canonical-read-permission-denied-no-write', async () => { await button('Faol kesish paddoni').click(); await dialog().getByRole('alert').waitFor(); assert.equal(await button('Kesish apparatlarini qayta yuklash', dialog()).count(), 0); assert.equal(await button('Faol paddonni saqlash', dialog()).count(), 0); assert.equal((await writes()).length, 0); }, { capabilities: ['admin.access', 'apparatus.queue.read'], rules: [{ method: 'GET', path: '/v1/mobile/admin/apparatus', status: 403 }] });
  await run('queue-read-alone-preserves-workspace-gate', async () => { await page.waitForURL(web + '/kirish'); assert.equal((await control('/__qa/log')).requests.filter(row => row.path.startsWith(path)).length, 0); }, { capabilities: ['apparatus.queue.read'], denied: true });
  await run('apparatus-loading-error-read-retry', async () => {
    await control('/__qa/config', { rules: [{ method: 'GET', path: '/v1/mobile/admin/apparatus', once: true, delayMs: 700, status: 503 }] }); await button('Faol kesish paddoni').click();
    await dialog().getByRole('status').filter({ hasText: 'Kesish apparatlari yuklanmoqda…' }).waitFor(); await capture('loading'); await button('Kesish apparatlarini qayta yuklash', dialog()).click(); await selectMachine(); assert.equal((await writes()).length, 0);
  });
  await run('active-read-permission-refusal-has-no-write', async () => { await control('/__qa/config', { rules: [{ method: 'GET', path: path + '/active', status: 403 }] }); await button('Faol kesish paddoni').click(); await dialog().getByRole('alert').waitFor(); assert.equal(await button('Tanlovni qayta yuklash', dialog()).count(), 0); assert.equal(await button('Faol paddonni saqlash', dialog()).count(), 0); assert.equal((await writes()).length, 0); });
  await run('selectable-read-error-retry-and-code-validation', async () => { await control('/__qa/config', { rules: [{ method: 'GET', path, once: true, status: 503 }] }); await openHandoff(); await button('Ochiq paddonlarni qayta yuklash', dialog()).click(); await button('00003 paddonini tanlash', dialog()).waitFor(); await choose('invalid-code'); await dialog().getByRole('alert').waitFor(); assert.equal((await writes()).length, 0); });
  for (const kind of ['choose', 'clear', 'next']) await run(`uncertain-${kind}-loss-read-only`, async () => {
    await openHandoff(); await control('/__qa/config', { rules: [{ method: kind === 'next' ? 'POST' : 'PUT', path: path + (kind === 'next' ? '/active/next' : '/active'), once: true, dropResponse: true }] });
    if (kind === 'next') { await inspectNext(); await confirmNext(); await button('Keyingi paddonni ochish', dialog()).click(); }
    else if (kind === 'clear') await button('Faol tanlovni tozalash', dialog()).click(); else await choose('00001');
    await recover({ next: kind === 'next', ...(kind === 'next' ? {} : { expected: kind === 'clear' ? null : '00001' }) });
    assert.equal((await writes()).length, 1);
  }, { ...(kind === 'next' ? operator : {}), scenario: 'selected' });
  for (const [label, rule] of [['503', { status: 503, applyBeforeFailure: true }], ['429', { status: 429, applyBeforeFailure: true }], ['malformed200', { invalidJson: true }], ['missing-code200', { responseBody: { ok: true, apparatus: cut } }]]) await run(`uncertain-choose-${label}`, async () => {
    await openHandoff(); await control('/__qa/config', { rules: [{ method: 'PUT', path: path + '/active', once: true, ...rule }] }); await choose('00001'); await recover({ expected: '00001' }); assert.equal((await writes()).length, 1);
  }, { scenario: 'selected' });
  await run('uncertain-408-fetch-boundary-no-replay', async () => {
    await openHandoff(); await page.evaluate(activeUrl => { const original = window.fetch.bind(window); window.fetch = async (input, init) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; if (url.split('?')[0] === activeUrl && init?.method === 'PUT') { const applied = await original(input, init); if (applied.ok) return new Response(JSON.stringify({ error: 'request_timeout' }), { status: 408, headers: { 'content-type': 'application/json' } }); return applied; } return original(input, init); }; }, api + path + '/active');
    await choose('00003'); await recover({ expected: '00003' }); assert.equal((await writes()).length, 1); outcome.transportBoundary = '408 synthesized after one successful native fixture PUT; browser HTTP retry policy excluded';
  });
  await run('unknown-next-observes-concurrent-choice-no-proof', async () => {
    await openHandoff(); await control('/__qa/config', { rules: [{ method: 'POST', path: path + '/active/next', once: true, dropResponse: true }] }); await inspectNext(); await confirmNext(); await button('Keyingi paddonni ochish', dialog()).click(); await title('Faol paddon amali natijasini tekshirish');
    await control('/__qa/paddon-handoff', { action: 'concurrent', apparatus: cut, code: '00007', actor_role: 'aparatchi', actor_ref: 'qa-worker-1' }); await recover({ expected: '00007', next: true }); assert.equal((await writes()).length, 1); assert.equal((await control('/__qa/state')).state.paddonSuccessors.length, 1);
  }, operator);
  await run('offline-unknown-still-allows-read-only-check', async () => {
    await openHandoff(); await page.evaluate(activeUrl => { const original = window.fetch.bind(window); window.fetch = async (input, init) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; if (url.split('?')[0] === activeUrl && init?.method === 'PUT') { await original(input, init); throw new TypeError('QA Synthetic reply lost'); } return original(input, init); }; }, api + path + '/active');
    await choose('00003'); await title('Faol paddon amali natijasini tekshirish'); await page.getByText('Server bilan aloqa uzildi', { exact: true }).waitFor();
    assert.equal(await button('Joriy faol paddonni tekshirish', dialog()).isEnabled(), true); await recover({ expected: '00003' }); assert.equal((await writes()).length, 1);
  });
  await run('interrupted-preflight-no-write-or-unknown', async () => {
    await openHandoff(); await control('/__qa/config', { rules: [{ method: 'GET', path: '/v1/mobile/admin/apparatus/' + cut, once: true, delayMs: 700 }] });
    const dispatched = page.waitForRequest(request => request.method() === 'GET' && decodeURIComponent(new URL(request.url()).pathname) === '/v1/mobile/admin/apparatus/' + cut); await choose('00003'); await dispatched;
    await button('Oynani yopish', dialog()).click(); await dialog().waitFor({ state: 'hidden' }); await openHandoff(); assert.equal((await writes()).length, 0); assert.equal(await page.getByText('Tekshirish kerak', { exact: true }).count(), 0);
  });
  await run('interrupted-dispatched-next-remount-no-replay', async () => {
    await openHandoff(); await inspectNext(); await confirmNext(); await control('/__qa/config', { rules: [{ method: 'POST', path: path + '/active/next', once: true, delayMs: 550, dropResponse: true }] });
    const dispatched = page.waitForRequest(request => request.method() === 'POST' && request.url() === api + path + '/active/next'); await button('Keyingi paddonni ochish', dialog()).click(); await dispatched;
    await button('Oynani yopish', dialog()).click(); await dialog().waitFor({ state: 'hidden' });
    await until(() => writes(), rows => rows.length === 1, 'Dispatched next absent'); await button(/^Faol kesish paddoni/).click(); await recover({ next: true }); assert.equal((await writes()).length, 1);
  }, operator);
  await run('double-click-one-selection-write-and-focus-return', async () => {
    await openHandoff(); await control('/__qa/config', { rules: [{ method: 'PUT', path: path + '/active', once: true, delayMs: 350 }] }); await dialog().getByLabel('Faol paddon uchun kod').fill('00003');
    await button('Faol paddonni saqlash', dialog()).evaluate(node => { node.click(); node.click(); }); await chosen('00003'); assert.equal((await writes()).length, 1);
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); await until(() => button('Faol kesish paddoni').evaluate(node => document.activeElement === node), value => value, 'Focus did not return to handoff toolbar');
  });
  await run('nested-cut-apparatus-and-queue-entry-only', async () => {
    await page.goto(web + '/app/apparatus?selected=' + encodeURIComponent(cut)); await button('Faol kesish paddoni').waitFor(); await openHandoff(); await capture('apparatus-dialog');
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('dialog').count(), 1);
    await page.goto(web + '/app/apparatus?selected=' + encodeURIComponent(apparatusIds.print)); await page.getByRole('dialog').waitFor(); assert.equal(await button('Faol kesish paddoni').count(), 0);
    await page.goto(web + '/app/orders?view=queue&apparatus=' + encodeURIComponent(cut)); await openHandoff(); await capture('queue-dialog'); await button('Oynani yopish', dialog()).click();
    await page.goto(web + '/app/orders?view=queue&apparatus=' + encodeURIComponent(apparatusIds.print)); await page.locator('[aria-label="Apparat navbatini tartiblash"]').waitFor(); assert.equal(await button('Faol kesish paddoni').count(), 0); assert.equal((await writes()).length, 0);
  });
  await run('mapped-successor-delete500-retains-unknown', async () => {
    await openHandoff(); await inspectNext(); await confirmNext(); await button('Keyingi paddonni ochish', dialog()).click(); const next = await until(() => activeSelection(), row => !!row.code, 'Successor absent'); await chosen(next.code); await button('Oynani yopish', dialog()).click();
    await page.getByLabel('Paddon kodi', { exact: true }).fill(next.code); await button('Ochish').click();
    const details = page.getByRole('dialog'); await details.locator('[aria-label="Paddon tafsilotlari"]').waitFor(); await (await enabled(button('O‘chirishni ko‘rib chiqish', details))).click(); await details.getByRole('checkbox', { name: 'Paddonni o‘chirishni tasdiqlayman.' }).check(); await button('Paddonni o‘chirish', details).click();
    await details.getByRole('heading', { name: 'Paddon amali natijasini tekshirish', exact: true }).waitFor(); await button('Serverdagi paddon holatini tekshirish', details).click(); await details.getByText(/^Paddon mavjud, ammo/).waitFor(); await capture('delete-unknown');
    const sent = await writes(); assert.equal(sent.length, 2); assert.equal(sent[1].path, path + '/delete'); assert.equal(sent[1].status, 500); assert.equal(sent[1].error, 'store_failed'); assert.equal((await activeSelection()).code, next.code); assert.equal((await control('/__qa/state')).state.paddonSuccessors.length, 1);
  }, operator);
  for (const kind of ['selected', 'cleared']) await run(`cut-output-uses-server-${kind}-selection`, async () => {
    await openHandoff(); if (kind === 'selected') { await choose('00001'); await chosen('00001'); } else { await button('Faol tanlovni tozalash', dialog()).click(); await chosen(null); }
    await button('Oynani yopish', dialog()).click(); await control('/__qa/completion', { scenario: 'cut' }); await page.goto(web + '/app/orders');
    await page.getByRole('row').filter({ hasText: 'qa-1001' }).getByRole('button', { name: 'Buyurtma tafsiloti', exact: true }).click();
    const controls = page.getByRole('region', { name: 'Bosqichni tugatish hisoboti', exact: true }), stage = controls.locator('div.rounded-md').filter({ has: page.getByText('QA Rezka · cut', { exact: true }) });
    await (await enabled(button('Tugatish hisobotini kiritish', stage))).click(); const form = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Bosqichni tugatish hisoboti', exact: true }) });
    for (let index = 0; index < 2; index++) for (const [field, value] of [['metres', '100'], ['grossKg', '10'], ['tareKg', '1'], ['diameter', '30']]) await form.locator(`#completion-frame-${index}-${field}`).fill(value);
    await form.getByLabel('Umumiy chiqindi, kg', { exact: true }).fill('2'); await button('Hisobotni tekshirish', form).click(); await button('Hisobotni saqlash', form).click(); await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).waitFor();
    const state = (await control('/__qa/state')).state, ids = state.wip.filter(row => row.batch_id.startsWith('qa-completion-output')).map(row => row.batch_id); assert.equal(ids.length, 2);
    const memberships = state.paddonMemberships.filter(row => ids.includes(row.batch_id)); assert.equal(memberships.length, kind === 'selected' ? 2 : 0); if (kind === 'selected') assert.ok(memberships.every(row => row.code === '00001'));
    const commands = (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path.endsWith('/queue-action')); assert.equal(commands.length, 1); assert.equal(Object.hasOwn(commands[0].body, 'output_paddon_code'), false); assert.equal(Object.hasOwn(commands[0].body, 'use_active_paddon'), false); assert.equal((await writes()).length, 1);
  }, { scenario: 'selected' });
  await run('mobile-dark-reduced-motion-active-selection', async () => { await button('Qorong‘i mavzu').click(); await openHandoff(); await chosen('00003'); await capture('selection'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await button('00001 paddonini tanlash', dialog()).click(); await capture('choice'); assert.equal((await writes()).length, 0); }, { scenario: 'selected', viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' });
} finally { await browser.close(); }
process.stdout.write(JSON.stringify({ output, passed: outcomes.filter(row => row.status === 'passed').length, failed: outcomes.filter(row => row.status !== 'passed').length }) + '\n');
if (outcomes.some(row => row.status !== 'passed')) process.exitCode = 1;
