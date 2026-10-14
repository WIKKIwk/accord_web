import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureLogin, fixtureToken, apparatusIds } from '../fixtures/erp-seed.mjs';
import { workerGroupsPath as path } from '../fixtures/erp-worker-groups.mjs';

const web = 'http://127.0.0.1:5186', api = 'http://127.0.0.1:5199';
const runId = new Date().toISOString().replace(/[:.]/g, '-'), output = fileURLToPath(new URL(`../../docs/qa/worker-groups/${runId}/`, import.meta.url));
const selected = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
const allowed = new Set([web, api]), outside = [], pageErrors = [], outcomes = [];
const sourceRevision = process.env.QA_SOURCE_REV || 'unrecorded', buildDirectory = process.env.QA_BUILD_DIR || 'unrecorded';
const redact = value => [fixtureLogin.phone, fixtureLogin.code, fixtureToken].reduce((text, value) => text.replaceAll(value, '[synthetic-credential]'), String(value));
const pkg = process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright';
const { chromium } = await import(pkg.startsWith('/') ? pathToFileURL(pkg).href : pkg);
let browser, page, context, outcome;
async function control(url, body) {
  assert.ok(url.startsWith('/__qa/'));
  const response = await fetch(api + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${url}: ${response.status}`); return response.json();
}
async function nativeGet(url) { const response = await fetch(api + url, { headers: { Authorization: 'Bearer ' + fixtureToken } }); assert.ok(response.ok); return response.json(); }
const writes = async () => (await control('/__qa/log')).requests.filter(row => row.path === path && row.method === 'PUT');
const state = async () => (await control('/__qa/state')).state;
const dialog = () => page.getByRole('dialog');
const button = (name, root = page) => root.getByRole('button', { name, exact: true });
const title = name => dialog().getByRole('heading', { name, exact: true }).waitFor();
async function until(get, predicate, label, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await get(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 70)); } throw new Error(label); }
async function enabled(target) { await target.waitFor(); await until(() => target.isEnabled(), value => value, 'Control remained disabled'); return target; }
async function directory() { await title('Ishchi guruhlari'); await enabled(button('Guruh yaratish', dialog())); }
async function open() { await button('Ishchi guruhlari').click(); await directory(); }
async function create(name = 'QA NEW GROUP', apparatus = 'QA Flexo 1') {
  await (await enabled(button('Guruh yaratish', dialog()))).click(); await title('Yangi ishchi guruhi');
  await dialog().getByLabel('Guruh nomi', { exact: true }).fill(name); await choose('Apparat', apparatus);
}
async function choose(label, name) { await (await enabled(dialog().getByRole('combobox', { name: label, exact: true }))).click(); await page.getByRole('option', { name, exact: true }).click(); }
const member = name => dialog().locator('[aria-label="Biriktirish uchun ishchilar"]').getByRole('checkbox', { name: new RegExp('^' + name) });
async function save() { await (await enabled(button('Guruhni saqlash', dialog()))).click(); await directory(); }
async function group(name) { const groups = (await state()).workerGroups; return groups.find(row => row.group_code === name); }
async function inspectReceipt(expectedKeys, count = 1) {
  const sent = await writes(); assert.equal(sent.length, count);
  assert.deepEqual(Object.keys(sent.at(-1).body).sort(), expectedKeys.sort());
  assert.equal(sent.at(-1).idempotencyKeyPresent, false); assert.equal(sent.at(-1).expectedRevisionHeader, null);
}
const fields = ['apparatus_id', 'apparatus', 'group_code', 'shift', 'start_time', 'end_time', 'work_days_per_week', 'start_day', 'accounting_enabled', 'worker_ids'];
async function capture(label) {
  await page.evaluate(() => {
    let badge = document.getElementById('qa-worker-groups-demo'); if (!badge) { badge = document.createElement('div'); badge.id = 'qa-worker-groups-demo'; document.body.append(badge); }
    badge.textContent = 'DEMO · Sintetik · Ishchi guruhlari'; Object.assign(badge.style, { position: 'fixed', bottom: '6px', right: '6px', zIndex: '2147483647', pointerEvents: 'none', padding: '3px 7px', border: '1px solid #737373', borderRadius: '4px', background: document.documentElement.classList.contains('dark') ? '#171717' : '#fff', color: document.documentElement.classList.contains('dark') ? '#d4d4d4' : '#171717', font: '500 10px/15px system-ui' });
  });
  await page.evaluate(async () => { let stable = 0, start = performance.now(); while (stable < 2 && performance.now() - start < 1600) { await new Promise(requestAnimationFrame); stable = document.getAnimations().some(a => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime))) ? 0 : stable + 1; } });
  const file = `${outcome.id}-${label}.png`; await page.screenshot({ path: output + file, fullPage: true });
  outcome.screenshots.push({ file, route: page.url(), viewport: page.viewportSize(), theme: await page.locator('html').getAttribute('class') });
}
async function run(id, execute, { scenario = 'empty', noOpen = false, ...options } = {}) {
  if (selected && !selected.includes(id)) return;
  outcome = { id, status: 'running', screenshots: [] }; outcomes.push(outcome); const started = Date.now();
  try {
    await control('/__qa/reset', {}); await control('/__qa/worker-groups', { scenario });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', ...options });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (['data:', 'blob:', 'about:'].includes(url.protocol) || allowed.has(url.origin)) return route.continue(); outside.push({ case: id, origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient'); });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => { const url = new URL(socket.url()), origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`; if (allowed.has(origin)) socket.connectToServer(); else { outside.push({ case: id, origin, path: url.pathname }); socket.close({ code: 1008 }); } });
    page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push({ case: id, message: redact(error.message) }));
    await page.goto(web + '/kirish'); await page.getByLabel('Server manzili').fill(api); await page.getByLabel('Telefon raqami').fill(fixtureLogin.phone); await page.getByLabel('Kirish kodi', { exact: true }).fill(fixtureLogin.code); await button('Kirish').click(); await page.waitForURL(web + '/app/home');
    await page.goto(web + '/app/workers'); await button('Ishchi guruhlari').waitFor(); if (!noOpen) await open(); await execute();
    const log = await control('/__qa/log'); outcome.requests = log.requests;
    assert.equal(outside.filter(entry => entry.case === id).length, 0); assert.deepEqual(pageErrors.filter(entry => entry.case === id), []);
    assert.deepEqual(log.requests.filter(entry => entry.error === 'fixture_route_not_implemented'), []);
    await capture('passed'); outcome.status = 'passed';
  } catch (error) {
    outcome.status = 'failed'; outcome.error = redact(error.stack || error.message);
    if (page && !page.isClosed()) try { await capture('failed'); } catch { /* retain actual failure */ }
    try { outcome.requests = (await control('/__qa/log')).requests; } catch { /* retain actual failure */ }
  } finally {
    outcome.durationMs = Date.now() - started; await context?.close(); context = null; page = null;
    await writeFile(output + 'results.json', JSON.stringify({ synthetic: true, productionVerified: false, runId, sourceRevision, buildDirectory, fixtureVersion, web, api, outcomes, outside, pageErrors }, null, 2));
    process.stdout.write(`${outcome.status.toUpperCase()} ${id}${outcome.error ? ': ' + outcome.error.split('\n')[0] : ''}\n`);
  }
}
async function recovery() {
  await title('Saqlash natijasini tekshirish'); await dialog().getByText(/shu sessiya xotirasida/).waitFor();
  await capture('uncertain'); assert.equal((await writes()).length, 1);
  await button('Oynani yopish', dialog()).click(); await button(/^Ishchi guruhlari\s*Tekshirish kerak$/).waitFor();
  await button(/^Ishchi guruhlari\s*Tekshirish kerak$/).click(); await title('Saqlash natijasini tekshirish');
  assert.equal((await writes()).length, 1); await button('Serverdagi joriy holatni tekshirish', dialog()).click();
  await dialog().getByText(/Joriy qiymatlar yuborilgan tanlovga mos/).waitFor();
  assert.equal(await button('Tekshiruvni yakunlash', dialog()).isDisabled(), true);
  assert.equal(await dialog().getByText('Ishchi guruhi saqlandi.', { exact: true }).count(), 0);
  assert.equal((await writes()).length, 1); await capture('observed');
  await dialog().getByRole('checkbox', { name: /^Avvalgi tanlov va joriy holatni ko‘rdim/ }).check();
  await button('Tekshiruvni yakunlash', dialog()).click(); await directory(); assert.equal((await writes()).length, 1);
}

await mkdir(output, { recursive: true });
const fixtureVersion = (await control('/__qa/health')).fixtureVersion; assert.ok(fixtureVersion >= 10);
browser = await chromium.launch({ headless: true });
try {
  await run('create-overnight-membership-profile', async () => {
    await dialog().getByText('Ishchi guruhlari hali yo‘q.', { exact: true }).waitFor(); await capture('empty');
    const before = await nativeGet('/v1/mobile/admin/workers/profile-detail?id=qa-worker-1');
    await create('  qa   night group '); await dialog().getByLabel('Smena', { exact: true }).fill('tun');
    await dialog().getByLabel('Boshlanish vaqti').fill('20:00'); await dialog().getByLabel('Tugash vaqti').fill('08:00');
    await choose('Haftadagi ish kunlari', '5 kun'); await choose('Hafta boshlanish kuni', 'Seshanba');
    await dialog().getByRole('checkbox', { name: 'Guruh uchun hisoblashni yoqish', exact: true }).check(); await member('QA Brigadir').check();
    await dialog().evaluate(node => node.scrollTo(0, 0)); await capture('editor'); await save(); await inspectReceipt([...fields]);
    assert.deepEqual(await group('QA NIGHT GROUP'), { apparatus_id: apparatusIds.print, apparatus: 'QA Flexo 1', group_code: 'QA NIGHT GROUP', shift: 'tun', start_time: '20:00', end_time: '08:00', work_days_per_week: 5, start_day: 'tuesday', accounting_enabled: true, worker_ids: ['qa-worker-1'] });
    const profile = await nativeGet('/v1/mobile/admin/workers/profile-detail?id=qa-worker-1'); assert.equal(profile.assigned_groups[0].group_code, 'QA NIGHT GROUP'); assert.deepEqual(profile.assigned_apparatus, before.assigned_apparatus);
    await button('Oynani yopish', dialog()).click(); const row = page.getByRole('row').filter({ has: page.getByText('QA Brigadir', { exact: true }) }); await row.getByRole('button', { name: /tafsiloti$/ }).click();
    await page.getByRole('dialog').getByText('QA NIGHT GROUP · QA Flexo 1', { exact: true }).waitFor(); await capture('native-profile');
  });
  await run('rename-move-remove-and-free-member', async () => {
    await button('QA PRINT GROUP guruhini tahrirlash', dialog()).click(); await title('Ishchi guruhini tahrirlash');
    await dialog().getByLabel('Guruh nomi', { exact: true }).fill('QA CUT GROUP'); await choose('Apparat', 'QA Rezka');
    await button('QA Brigadirni guruhdan olib tashlash', dialog()).click(); await save(); await inspectReceipt([...fields, 'previous_apparatus_id', 'previous_group_code']);
    const moved = await group('QA CUT GROUP'); assert.equal(moved.apparatus_id, apparatusIds.cut); assert.deepEqual(moved.worker_ids, []); assert.equal(await group('QA PRINT GROUP'), undefined);
    assert.deepEqual((await nativeGet('/v1/mobile/admin/workers/profile-detail?id=qa-worker-1')).assigned_groups, []);
    await create(); await member('QA Brigadir').check(); await save(); assert.deepEqual((await group('QA NEW GROUP')).worker_ids, ['qa-worker-1']); assert.equal((await writes()).length, 2);
  }, { scenario: 'groups' });
  await run('directory-search-and-assigned-worker-guard', async () => {
    const overview = dialog().locator('[data-slot="worker-group-overview"]'); assert.equal(await overview.locator('[data-metric="groups"] [data-slot="metric-value"]').textContent(), '2');
    await dialog().getByLabel('Guruhlarni qidirish').fill('QA Operator'); await button('QA LAMINATION GROUP guruhini tahrirlash', dialog()).waitFor(); assert.equal(await button('QA PRINT GROUP guruhini tahrirlash', dialog()).count(), 0);
    assert.equal(await overview.locator('[data-metric="groups"] [data-slot="metric-value"]').textContent(), '2');
    await dialog().getByLabel('Guruhlarni qidirish').fill('absent'); await dialog().getByText(/Qidiruvga mos guruh topilmadi/).waitFor(); await dialog().getByLabel('Guruhlarni qidirish').fill('');
    await create(); assert.equal(await member('QA Brigadir').isDisabled(), true); assert.equal(await member('QA Operator').isDisabled(), true); await button('Bekor qilish', dialog()).click(); assert.equal((await writes()).length, 0);
  }, { scenario: 'groups' });
  await run('bounded-search-retains-selected-member', async () => {
    await create(); await dialog().getByText(/Ko‘pi bilan 500 ta natija/).waitFor(); await member('QA Group Picker 000').check();
    await dialog().getByLabel('Guruh a’zolari').fill('QA Group Picker 504'); await member('QA Group Picker 504').waitFor(); await (await enabled(member('QA Group Picker 504'))).check();
    await dialog().getByLabel('Guruh a’zolari').fill('absent'); await dialog().getByText('Qidiruvga mos faol ishchi topilmadi.', { exact: true }).waitFor();
    await save(); assert.deepEqual((await group('QA NEW GROUP')).worker_ids.sort(), ['qa-group-worker-0', 'qa-group-worker-504']);
  }, { scenario: 'bounded-workers' });
  await run('stale-baseline-blocks-before-put', async () => {
    await button('QA PRINT GROUP guruhini tahrirlash', dialog()).click(); await title('Ishchi guruhini tahrirlash'); await dialog().getByLabel('Smena', { exact: true }).fill('tun');
    await control('/__qa/worker-groups', { action: 'concurrent', apparatus_id: apparatusIds.print, group_code: 'QA PRINT GROUP', patch: { shift: 'QA CONCURRENT' } });
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await button('Joriy guruhlarni ko‘rib qayta boshlash', dialog()).waitFor(); assert.equal((await writes()).length, 0);
    assert.equal(await button('Guruhni saqlash', dialog()).isDisabled(), true); await button('Joriy guruhlarni ko‘rib qayta boshlash', dialog()).click(); await directory(); await dialog().getByText(/QA CONCURRENT/).waitFor();
  }, { scenario: 'groups' });
  await run('fresh-create-identity-conflict-no-overwrite', async () => {
    await create('QA COLLISION');
    await control('/__qa/worker-groups', { scenario: 'groups' });
    await control('/__qa/worker-groups', { action: 'concurrent', apparatus_id: apparatusIds.print, group_code: 'QA PRINT GROUP', patch: { group_code: 'QA COLLISION' } });
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await button('Joriy guruhlarni ko‘rib qayta boshlash', dialog()).waitFor(); assert.equal((await writes()).length, 0); assert.deepEqual((await group('QA COLLISION')).worker_ids, ['qa-worker-1']);
  });
  await run('deactivated-exact-member-blocked-before-put', async () => {
    await create(); await member('QA Brigadir').check(); await control('/__qa/worker-groups', { action: 'deactivate', worker_id: 'qa-worker-1' });
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await dialog().getByRole('alert').waitFor(); assert.equal((await writes()).length, 0); assert.equal((await state()).workerGroups.length, 0);
    await button('QA Brigadirni guruhdan olib tashlash', dialog()).click(); await save(); assert.deepEqual((await group('QA NEW GROUP')).worker_ids, []);
  });
  for (const status of [400, 403]) await run(`native-${status}-known-refusal`, async () => {
    await create(); await control('/__qa/config', { rules: [{ method: 'PUT', path, once: true, status, error: status === 400 ? 'worker is duplicated in worker groups' : 'forbidden' }] });
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await dialog().getByRole('alert').waitFor(); await enabled(button('Guruhni saqlash', dialog()));
    assert.equal((await writes()).length, 1); assert.equal((await writes())[0].status, status); assert.equal((await state()).workerGroups.length, 0);
    await button('Bekor qilish', dialog()).click(); await directory(); assert.equal(await page.getByText('Tekshirish kerak', { exact: true }).count(), 0);
  });
  for (const [kind, rule] of [['loss', { dropResponse: true }], ['malformed-200', { responseBody: { ok: true } }], ['408-fetch-boundary', { status: 408, applyBeforeFailure: true }], ['429', { status: 429, applyBeforeFailure: true }]]) await run(`uncertain-${kind}-read-only-review`, async () => {
    // Native 408 is applied by the fixture. Deliver its real response directly to
    // fetch to distinguish app handling from Chromium's observed wire retransmit.
    if (kind === '408-fetch-boundary') await page.route(api + path, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch({ maxRetries: 0 }); await route.fulfill({ response });
    });
    await create(); await member('QA Brigadir').check(); await control('/__qa/config', { rules: [{ method: 'PUT', path, once: true, ...rule }] });
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await recovery();
    assert.deepEqual((await group('QA NEW GROUP')).worker_ids, ['qa-worker-1']);
  });
  await run('native-408-transport-behavior-recorded', async () => {
    await create(); await control('/__qa/config', { rules: [{ method: 'PUT', path, once: true, status: 408, applyBeforeFailure: true }] });
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await directory();
    const sent = await writes(); assert.equal(sent.length, 2); assert.deepEqual(sent.map(row => row.status), [408, 200]); assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal((await state()).workerGroups.length, 1);
    outcome.transportLimitation = 'This Chromium retransmitted the wire PUT after native HTTP 408. The app received the later exact 200; this does not provide server CAS/idempotency.';
  });
  await run('interrupted-dispatched-save-retained', async () => {
    await create(); await control('/__qa/config', { rules: [{ method: 'PUT', path, once: true, delayMs: 700 }] });
    const dispatched = page.waitForRequest(req => req.url() === api + path && req.method() === 'PUT');
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await dispatched; await button('Oynani yopish', dialog()).click();
    await until(writes, rows => rows.length === 1, 'Delayed native write did not finish'); await button(/^Ishchi guruhlari\s*Tekshirish kerak$/).click(); await recovery();
  });
  await run('interrupted-preflight-no-write-no-retained-intent', async () => {
    await create(); await control('/__qa/config', { rules: [{ method: 'GET', path, once: true, delayMs: 700 }] });
    const started = page.waitForRequest(req => req.url() === api + path && req.method() === 'GET');
    await (await enabled(button('Guruhni saqlash', dialog()))).click(); await started; await button('Oynani yopish', dialog()).click();
    await until(async () => (await control('/__qa/log')).requests.filter(row => row.path === path && row.method === 'GET').length, n => n >= 2, 'Preflight did not settle');
    await open(); assert.equal((await writes()).length, 0); assert.equal(await page.getByText('Tekshirish kerak', { exact: true }).count(), 0);
  });
  await run('unknown-reload-cancel-preserves-ram-intent', async () => {
    await create(); await control('/__qa/config', { rules: [{ method: 'PUT', path, once: true, dropResponse: true }] }); await (await enabled(button('Guruhni saqlash', dialog()))).click(); await title('Saqlash natijasini tekshirish');
    let prompted = false; page.once('dialog', async event => { prompted = true; assert.equal(event.type(), 'beforeunload'); await event.dismiss(); });
    await page.reload({ timeout: 2500 }).catch(error => { assert.equal(prompted, true); assert.match(error.message, /ERR_ABORTED|aborted|net::|Timeout/); });
    assert.equal(prompted, true); assert.equal(page.url(), web + '/app/workers'); await recovery();
  });
  await run('loading-and-retry-read-states', async () => {
    await control('/__qa/config', { rules: [{ method: 'GET', path, once: true, delayMs: 600, status: 503 }] }); await button('Ishchi guruhlari').click();
    await dialog().getByText('Ishchi guruhlari yuklanmoqda…', { exact: true }).waitFor(); assert.equal(await button('Guruh yaratish', dialog()).isDisabled(), true); await capture('loading');
    await button('Qayta yuklash', dialog()).waitFor(); assert.equal(await dialog().locator('[data-slot="worker-group-overview"]').count(), 0); await capture('error'); await button('Qayta yuklash', dialog()).click(); await directory();
  }, { noOpen: true });
  await run('permission-read-refusal-does-not-show-empty-or-retry', async () => {
    await control('/__qa/config', { capabilities: ['production.map.manage'] }); await button('Ishchi guruhlari').click();
    await dialog().getByRole('alert').waitFor(); assert.equal(await button('Guruh yaratish', dialog()).isDisabled(), true);
    assert.equal(await button('Qayta yuklash', dialog()).count(), 0); assert.equal(await dialog().getByText('Ishchi guruhlari hali yo‘q.', { exact: true }).count(), 0);
    assert.equal((await writes()).length, 0);
  }, { noOpen: true });
  await run('worker-picker-error-retry-retains-draft', async () => {
    await control('/__qa/config', { rules: [{ method: 'GET', path: '/v1/mobile/admin/workers', once: true, status: 503 }] });
    await create('QA RETAINED DRAFT'); await button('Ishchilarni qayta yuklash', dialog()).waitFor(); assert.equal(await button('Guruhni saqlash', dialog()).isDisabled(), true);
    await button('Ishchilarni qayta yuklash', dialog()).click(); await enabled(member('QA Brigadir')); assert.equal(await dialog().getByLabel('Guruh nomi', { exact: true }).inputValue(), 'QA RETAINED DRAFT');
    await member('QA Brigadir').check(); await save(); assert.equal((await writes()).length, 1);
  });
  await run('repeated-submit-single-put', async () => {
    await create(); await control('/__qa/config', { rules: [{ method: 'PUT', path, once: true, delayMs: 250 }] });
    await (await enabled(button('Guruhni saqlash', dialog()))).evaluate(node => { node.click(); node.click(); });
    await directory(); assert.equal((await writes()).length, 1); assert.equal((await state()).workerGroups.length, 1);
  });
  for (const scenario of ['empty-workers', 'empty-apparatus']) await run(scenario, async () => {
    if (scenario === 'empty-workers') { await create(); await dialog().getByText('Qidiruvga mos faol ishchi topilmadi.', { exact: true }).waitFor(); await save(); assert.deepEqual((await group('QA NEW GROUP')).worker_ids, []); }
    else { await button('Guruh yaratish', dialog()).click(); await title('Yangi ishchi guruhi'); await dialog().getByText('Qidiruvga mos faol apparat yo‘q.', { exact: true }).waitFor(); assert.equal(await button('Guruhni saqlash', dialog()).isDisabled(), true); assert.equal((await writes()).length, 0); }
  }, { scenario });
  await run('keyboard-escape-returns-toolbar-focus', async () => {
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); await until(() => button('Ishchi guruhlari').evaluate(node => document.activeElement === node), value => value, 'Focus did not return to group toolbar'); assert.equal((await writes()).length, 0);
  });
  await run('mobile-dark-reduced-motion-create', async () => {
    await button('Oynani yopish', dialog()).click(); await button('Qorong‘i mavzu').click(); await page.locator('html.dark').waitFor(); await open(); await capture('directory');
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); assert.ok(overflow.document <= overflow.viewport);
    const modalOverflow = await dialog().evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth })); assert.ok(modalOverflow.scroll <= modalOverflow.client);
    await create('QA MOBILE GROUP'); await member('QA Brigadir').check(); await dialog().evaluate(node => node.scrollTo(0, 0)); await capture('editor-top');
    await button('Guruhni saqlash', dialog()).scrollIntoViewIfNeeded(); await capture('editor-members-save'); await save(); assert.equal((await writes()).length, 1);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  }, { viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
} finally { await browser?.close(); }
const failures = outcomes.filter(value => value.status !== 'passed');
process.stdout.write(`Worker group browser acceptance: ${outcomes.length - failures.length}/${outcomes.length} passed. ${output}results.json\n`);
if (failures.length) process.exitCode = 1;
