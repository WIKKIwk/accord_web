import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureLogin, fixtureToken, apparatusIds } from '../fixtures/erp-seed.mjs';
import { apparatusCollectionsPath as path } from '../fixtures/erp-apparatus-collections.mjs';
const web = 'http://127.0.0.1:5186', api = 'http://127.0.0.1:5199';
const runId = new Date().toISOString().replace(/[:.]/g, '-'), output = fileURLToPath(new URL(`../../docs/qa/apparatus-collections/${runId}/`, import.meta.url));
const selected = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
const allowed = new Set([web, api]), outside = [], pageErrors = [], outcomes = [];
const sourceRevision = process.env.QA_SOURCE_REV || 'unrecorded', buildDirectory = process.env.QA_BUILD_DIR || 'unrecorded';
const redact = value => [fixtureLogin.phone, fixtureLogin.code, fixtureToken].reduce((text, value) => text.replaceAll(value, '[synthetic-credential]'), String(value));
const pkg = process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright';
const { chromium } = await import(pkg.startsWith('/') ? pathToFileURL(pkg).href : pkg);
let browser, page, context, outcome;
async function control(url, body) { assert.ok(url.startsWith('/__qa/')); const response = await fetch(api + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.ok(response.ok, `${url}: ${response.status}`); return response.json(); }
const state = async () => (await control('/__qa/state')).state;
const writes = async () => (await control('/__qa/log')).requests.filter(row => row.path.startsWith(path) && ['POST', 'PUT', 'DELETE'].includes(row.method));
const dialog = () => page.getByRole('dialog');
const button = (name, root = page) => root.getByRole('button', { name, exact: true });
const title = name => dialog().getByRole('heading', { name, exact: true }).waitFor();
async function until(get, predicate, label, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await get(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 70)); } throw new Error(label); }
async function enabled(target) { await target.waitFor(); await until(() => target.isEnabled(), value => value, 'Control remained disabled'); return target; }
async function directory(manage = true) { await title('Apparat guruhlari'); if (manage) await enabled(button('Apparat guruhi yaratish', dialog())); else await dialog().getByText(/O‘zgartirish uchun ruxsat yetarli emas/).waitFor(); }
async function open(manage = true) { await button('Apparat guruhlari').click(); await directory(manage); }
const choice = name => dialog().locator('[aria-label="Guruh uchun faol apparatlar"] label').filter({ has: page.getByText(name, { exact: true }) }).getByRole('checkbox');
async function create(name = 'QA New liniya') { await button('Apparat guruhi yaratish', dialog()).click(); await title('Yangi apparat guruhi'); await dialog().getByLabel('Apparat guruhi nomi', { exact: true }).fill(name); await dialog().locator('[aria-label="Guruh uchun faol apparatlar"]').waitFor(); }
async function edit(name) { await button(`${name} guruhini tahrirlash`, dialog()).click(); await title('Apparat guruhini tahrirlash'); await dialog().locator('[aria-label="Guruh uchun faol apparatlar"]').waitFor(); }
async function deleteReview(name) { await button(`${name} guruhini o‘chirish`, dialog()).click(); await title('Apparat guruhini o‘chirish'); }
async function save() { await (await enabled(button('Apparat guruhini saqlash', dialog()))).click(); await directory(); }
async function collection(name) { return (await state()).apparatusCollections.find(row => row.name === name); }
async function capture(label) {
  await page.evaluate(() => { let badge = document.getElementById('qa-collections-demo'); if (!badge) { badge = document.createElement('div'); badge.id = 'qa-collections-demo'; document.body.append(badge); } badge.textContent = 'DEMO · Sintetik · Apparat guruhlari'; Object.assign(badge.style, { position: 'fixed', bottom: '6px', right: '6px', zIndex: '2147483647', pointerEvents: 'none', padding: '3px 7px', border: '1px solid #737373', borderRadius: '4px', background: document.documentElement.classList.contains('dark') ? '#171717' : '#fff', color: document.documentElement.classList.contains('dark') ? '#d4d4d4' : '#171717', font: '500 10px/15px system-ui' }); });
  await page.evaluate(async () => { let stable = 0, start = performance.now(); while (stable < 2 && performance.now() - start < 1600) { await new Promise(requestAnimationFrame); stable = document.getAnimations().some(a => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime))) ? 0 : stable + 1; } });
  const file = `${outcome.id}-${label}.png`; await page.screenshot({ path: output + file, fullPage: true }); outcome.screenshots.push({ file, route: page.url(), viewport: page.viewportSize(), theme: await page.locator('html').getAttribute('class') });
}
async function run(id, execute, { scenario = 'empty', noOpen = false, capabilities, ...options } = {}) {
  if (selected && !selected.includes(id)) return;
  outcome = { id, status: 'running', screenshots: [] }; outcomes.push(outcome); const started = Date.now();
  try {
    await control('/__qa/reset', {}); await control('/__qa/apparatus-collections', { scenario }); if (capabilities) await control('/__qa/config', { capabilities });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', ...options });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (['data:', 'blob:', 'about:'].includes(url.protocol) || allowed.has(url.origin)) return route.continue(); outside.push({ case: id, origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient'); });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => { const url = new URL(socket.url()), origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`; if (allowed.has(origin)) socket.connectToServer(); else { outside.push({ case: id, origin, path: url.pathname }); socket.close({ code: 1008 }); } });
    page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push({ case: id, message: redact(error.message) }));
    await page.goto(web + '/kirish'); await page.getByLabel('Server manzili').fill(api); await page.getByLabel('Telefon raqami').fill(fixtureLogin.phone); await page.getByLabel('Kirish kodi', { exact: true }).fill(fixtureLogin.code); await button('Kirish').click(); await page.waitForURL(web + '/app/home');
    await page.goto(web + '/app/apparatus'); await button('Apparat guruhlari').waitFor(); if (!noOpen) await open(!capabilities); await execute();
    const log = await control('/__qa/log'); outcome.requests = log.requests;
    assert.equal(outside.filter(row => row.case === id).length, 0); assert.deepEqual(pageErrors.filter(row => row.case === id), []); assert.deepEqual(log.requests.filter(row => row.error === 'fixture_route_not_implemented'), []);
    await capture('passed'); outcome.status = 'passed';
  } catch (error) { outcome.status = 'failed'; outcome.error = redact(error.stack || error.message); if (page && !page.isClosed()) try { await capture('failed'); } catch {} try { outcome.requests = (await control('/__qa/log')).requests; } catch {} }
  finally { outcome.durationMs = Date.now() - started; await context?.close(); context = null; page = null; await writeFile(output + 'results.json', JSON.stringify({ synthetic: true, productionVerified: false, runId, sourceRevision, buildDirectory, fixtureVersion, web, api, outcomes, outside, pageErrors }, null, 2)); process.stdout.write(`${outcome.status.toUpperCase()} ${id}${outcome.error ? ': ' + outcome.error.split('\n')[0] : ''}\n`); }
}
async function recover(expected = 'matches') {
  await title('Guruh amali natijasini tekshirish'); await dialog().getByText(/shu sessiya xotirasida/).waitFor(); const sent = await writes(); assert.equal(sent.length, 1); await capture('unknown');
  await button('Oynani yopish', dialog()).click(); await button(/^Apparat guruhlari\s*Tekshirish kerak$/).click(); await title('Guruh amali natijasini tekshirish');
  await button('Serverdagi guruh holatini tekshirish', dialog()).click(); await dialog().getByText(expected === 'missing' ? /^Guruh joriy ro‘yxatda topilmadi/ : expected === 'different' ? /^Guruh mavjud, ammo/ : /^Joriy qiymatlar avval yuborilgan tanlovga mos/).waitFor();
  assert.equal(await button('Guruh tekshiruvini yakunlash', dialog()).isDisabled(), true); assert.equal((await writes()).length, 1); await capture('read-only-observation');
  await dialog().getByRole('checkbox', { name: /^Avvalgi tanlov va joriy holatni ko‘rdim/ }).check(); await button('Guruh tekshiruvini yakunlash', dialog()).click(); await directory(); assert.equal((await writes()).length, 1);
}
await mkdir(output, { recursive: true }); const fixtureVersion = (await control('/__qa/health')).fixtureVersion; assert.ok(fixtureVersion >= 11); browser = await chromium.launch({ headless: true });
try {
  await run('create-native-members-and-receipt', async () => {
    await dialog().getByText('Apparat guruhlari hali yo‘q.', { exact: true }).waitFor(); const before = await state(); await create('  QA New liniya  '); await choice('QA Flexo 1').check(); await choice('QA Laminator').check(); await capture('editor'); await save();
    const saved = await collection('QA New liniya'); assert.equal(saved.revision, 1); assert.match(saved.id, /^apparatus-collection:[0-9a-f]{32}$/); assert.deepEqual(saved.apparatus_ids, [apparatusIds.laminate, apparatusIds.print].sort());
    assert.deepEqual((await state()).apparatus, before.apparatus); assert.deepEqual((await state()).roleAssignments, before.roleAssignments);
    const sent = await writes(); assert.equal(sent.length, 1); assert.equal(sent[0].method, 'POST'); assert.deepEqual(Object.keys(sent[0].body).sort(), ['apparatus_ids', 'name']); assert.equal(sent[0].idempotencyKeyPresent, false);
  });
  await run('rename-membership-revision-and-overlap', async () => {
    const original = await collection('QA Bosma liniyasi'); await edit(original.name); await dialog().getByLabel('Apparat guruhi nomi').fill('QA Changed liniya'); await choice('QA Flexo 1').uncheck(); await choice('QA Laminator').check(); await save();
    const saved = await collection('QA Changed liniya'); assert.equal(saved.id, original.id); assert.equal(saved.revision, 2); assert.equal(await collection(original.name), undefined); assert.ok(saved.apparatus_ids.includes(apparatusIds.laminate));
    assert.ok((await collection('QA Aralash liniya')).apparatus_ids.includes(apparatusIds.laminate)); const sent = await writes(); assert.equal(sent[0].method, 'PUT'); assert.equal(sent[0].body.expected_revision, 1); assert.deepEqual(Object.keys(sent[0].body).sort(), ['apparatus_ids','expected_revision','name']);
  }, { scenario: 'collections' });
  await run('delete-native204-keeps-apparatus', async () => {
    const before = await state(); await deleteReview('QA Bosma liniyasi'); await capture('confirmation'); await button('Guruhni o‘chirish', dialog()).click(); await directory();
    assert.equal(await collection('QA Bosma liniyasi'), undefined); assert.deepEqual((await state()).apparatus, before.apparatus); assert.deepEqual((await state()).roleAssignments, before.roleAssignments);
    const sent = await writes(); assert.equal(sent.length, 1); assert.equal(sent[0].method, 'DELETE'); assert.equal(sent[0].status, 204); assert.deepEqual(sent[0].body, { expected_revision: 1 });
  }, { scenario: 'collections' });
  await run('cancel-and-search-no-writes', async () => {
    await dialog().getByLabel('Apparat guruhlarini qidirish').fill('QA Flexo 1'); await button('QA Bosma liniyasi guruhini tahrirlash', dialog()).waitFor(); await dialog().getByLabel('Apparat guruhlarini qidirish').fill('absent'); await dialog().getByText('Qidiruvga mos apparat guruhi topilmadi.', { exact: true }).waitFor(); await dialog().getByLabel('Apparat guruhlarini qidirish').fill('');
    await create(); await button('Bekor qilish', dialog()).click(); await directory(); await deleteReview('QA Bosma liniyasi'); await button('Bekor qilish', dialog()).click(); await directory(); assert.equal((await writes()).length, 0);
  }, { scenario: 'collections' });
  await run('bounded-existing-selection-retained', async () => {
    await edit('QA Bounded liniya'); await dialog().getByText(/Ko‘pi bilan 500 ta apparat/).waitFor(); await button('apparatus:qa:collection-picker-504ni guruhdan olib tashlash', dialog()).waitFor();
    await dialog().getByLabel('Guruhga apparat qo‘shish').fill('QA Collection Picker 504'); await choice('QA Collection Picker 504').waitFor(); assert.equal(await choice('QA Collection Picker 504').isChecked(), true); await dialog().getByLabel('Guruhga apparat qo‘shish').fill('absent'); await dialog().getByText('Qidiruvga mos faol apparat topilmadi.', { exact: true }).waitFor(); await save(); assert.deepEqual((await collection('QA Bounded liniya')).apparatus_ids, ['apparatus:qa:collection-picker-504']);
  }, { scenario: 'bounded-apparatus' });
  await run('native-duplicate-name-keeps-editable-draft', async () => {
    await create('qa bosma liniyasi'); await (await enabled(button('Apparat guruhini saqlash',dialog()))).click(); await dialog().getByRole('alert').waitFor(); await enabled(button('Apparat guruhini saqlash',dialog()));
    assert.equal((await writes()).length,1); assert.equal((await writes())[0].status,409); assert.equal(await dialog().getByLabel('Apparat guruhi nomi').inputValue(),'qa bosma liniyasi');
    await dialog().getByLabel('Apparat guruhi nomi').fill('QA Different liniya'); await save(); assert.equal((await writes()).length,2); assert.ok(await collection('QA Different liniya'));
  },{scenario:'collections'});
  for (const kind of ['update','delete']) await run(`stale-${kind}-preflight`, async () => {
    const original = await collection('QA Bosma liniyasi'); if (kind === 'update') await edit(original.name); else await deleteReview(original.name);
    await control('/__qa/apparatus-collections', { action:'concurrent', id:original.id, patch:{name:'QA Concurrent liniya'} });
    await (await enabled(button(kind === 'update' ? 'Apparat guruhini saqlash' : 'Guruhni o‘chirish', dialog()))).click(); await button('Joriy guruhlarni ko‘rib qayta boshlash', dialog()).waitFor(); assert.equal((await writes()).length, 0);
    await button('Joriy guruhlarni ko‘rib qayta boshlash', dialog()).click(); await directory(); await dialog().getByRole('heading', {name:'QA Concurrent liniya',exact:true}).waitFor();
  }, { scenario:'collections' });
  for (const kind of ['update','delete']) await run(`native-${kind}-cas409-after-preflight`, async () => {
    const original = await collection('QA Bosma liniyasi'); if (kind === 'update') { await edit(original.name); await dialog().getByLabel('Apparat guruhi nomi').fill('QA Requested liniya'); } else await deleteReview(original.name);
    await page.route(api + path + '/' + encodeURIComponent(original.id), async route => { if (route.request().method() !== (kind === 'update' ? 'PUT' : 'DELETE')) return route.continue(); await control('/__qa/apparatus-collections',{action:'concurrent',id:original.id,patch:{name:'QA Later liniya'}}); await route.continue(); });
    await (await enabled(button(kind === 'update' ? 'Apparat guruhini saqlash' : 'Guruhni o‘chirish', dialog()))).click(); await button('Joriy guruhlarni ko‘rib qayta boshlash', dialog()).waitFor(); assert.equal((await writes()).length, 1); assert.equal((await writes())[0].status, 409); assert.equal(await button(kind === 'update' ? 'Apparat guruhini saqlash' : 'Guruhni o‘chirish',dialog()).isDisabled(),true);
    await button('Joriy guruhlarni ko‘rib qayta boshlash', dialog()).click(); await directory(); await dialog().getByRole('heading',{name:'QA Later liniya',exact:true}).waitFor();
  }, { scenario:'collections' });
  await run('retired-member-exact-preflight', async () => { await create(); await choice('QA Flexo 1').check(); await control('/__qa/apparatus-collections',{action:'retire',apparatus_id:apparatusIds.print}); await (await enabled(button('Apparat guruhini saqlash',dialog()))).click(); await dialog().getByRole('alert').waitFor(); assert.equal((await writes()).length,0); await button(`${apparatusIds.print}ni guruhdan olib tashlash`,dialog()).click(); await save(); assert.deepEqual((await collection('QA New liniya')).apparatus_ids,[]); });
  await run('read-only-admin-has-no-write-actions', async () => { await dialog().getByRole('heading',{name:'QA Bosma liniyasi',exact:true}).waitFor(); assert.equal(await button('Apparat guruhi yaratish',dialog()).count(),0); assert.equal(await dialog().getByRole('button',{name:/guruhini (tahrirlash|o‘chirish)$/}).count(),0); assert.equal((await writes()).length,0); }, {scenario:'collections',capabilities:['admin.access']});
  for (const kind of ['create','update','delete']) await run(`uncertain-${kind}-loss-read-review`, async () => {
    const original = kind === 'create' ? null : await collection('QA Bosma liniyasi'); if (kind === 'create') await create(); else if (kind === 'update') { await edit(original.name); await dialog().getByLabel('Apparat guruhi nomi').fill('QA Changed liniya'); } else await deleteReview(original.name);
    const method = kind === 'create' ? 'POST' : kind === 'update' ? 'PUT' : 'DELETE', nativePath = original ? path + '/' + original.id : path;
    // Deliver native applied-loss to fetch without Chromium's observed DELETE
    // wire retransmission. The real fixture still applies exactly one command.
    if (kind === 'delete') await page.route(api + path + '/' + encodeURIComponent(original.id), async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      try { await route.fetch({ maxRetries: 0 }); throw new Error('Expected native response loss'); }
      catch (error) { assert.match(error.message, /socket hang up|ECONNRESET|closed|reset/i); await route.abort('failed'); }
    });
    await control('/__qa/config',{rules:[{method,path:nativePath,once:true,dropResponse:true}]}); await (await enabled(button(kind === 'delete' ? 'Guruhni o‘chirish' : 'Apparat guruhini saqlash',dialog()))).click(); await recover(kind === 'delete' ? 'missing' : 'matches');
  }, {scenario:'collections'});
  await run('native-delete-loss-transport-retry-recorded', async () => {
    const original=await collection('QA Bosma liniyasi'); await deleteReview(original.name);
    await control('/__qa/config',{rules:[{method:'DELETE',path:path+'/'+original.id,once:true,dropResponse:true}]}); await button('Guruhni o‘chirish',dialog()).click();
    await button('Joriy guruhlarni ko‘rib qayta boshlash',dialog()).waitFor(); const sent=await writes(); assert.equal(sent.length,2); assert.deepEqual(sent.map(row=>row.status),['lost',404]); assert.deepEqual(sent[0].body,sent[1].body);
    assert.equal(await button('Guruhni o‘chirish',dialog()).isDisabled(),true); await button('Joriy guruhlarni ko‘rib qayta boshlash',dialog()).click(); await directory(); assert.equal(await collection(original.name),undefined);
    outcome.transportLimitation='Configured Chromium retried the native DELETE wire request after response loss. Native CAS/404 prevented a second mutation; application sends no replay and requires current-state conflict review.';
  },{scenario:'collections'});
  await run('malformed200-create-is-unknown', async () => { await create(); await control('/__qa/config',{rules:[{method:'POST',path,once:true,responseBody:{ok:true}}]}); await (await enabled(button('Apparat guruhini saqlash',dialog()))).click(); await recover(); });
  await run('native403-known-no-commit', async () => { await create(); await control('/__qa/config',{rules:[{method:'POST',path,once:true,status:403}]}); await (await enabled(button('Apparat guruhini saqlash',dialog()))).click(); await dialog().getByRole('alert').waitFor(); await enabled(button('Apparat guruhini saqlash',dialog())); assert.equal((await writes()).length,1); assert.equal((await state()).apparatusCollections.length,0); });
  for (const kind of ['create','delete']) await run(`interrupted-${kind}-after-dispatch`, async () => {
    const original = kind === 'delete' ? await collection('QA Bosma liniyasi') : null; if (original) await deleteReview(original.name); else await create(); const method = original ? 'DELETE' : 'POST', nativePath = original ? path+'/'+original.id : path;
    await control('/__qa/config',{rules:[{method,path:nativePath,once:true,delayMs:600}]}); const dispatched = page.waitForRequest(request => decodeURIComponent(new URL(request.url()).pathname) === nativePath && request.method() === method);
    await (await enabled(button(original ? 'Guruhni o‘chirish' : 'Apparat guruhini saqlash',dialog()))).click(); await dispatched; await button('Oynani yopish',dialog()).click(); await until(writes,rows=>rows.length===1,'Delayed native collection write did not finish'); await button(/^Apparat guruhlari\s*Tekshirish kerak$/).click(); await recover(original ? 'missing' : 'matches');
  },{scenario:'collections'});
  await run('interrupted-preflight-no-command', async () => { await create(); await control('/__qa/config',{rules:[{method:'GET',path,once:true,delayMs:600}]}); const started=page.waitForRequest(request=>request.url()===api+path&&request.method()==='GET'); await (await enabled(button('Apparat guruhini saqlash',dialog()))).click(); await started; await button('Oynani yopish',dialog()).click(); await until(async()=> (await control('/__qa/log')).requests.filter(r=>r.path===path&&r.method==='GET').length,n=>n>=2,'Preflight did not settle'); await open(); assert.equal((await writes()).length,0); });
  await run('loading-error-retry-not-false-empty', async () => { await control('/__qa/config',{rules:[{method:'GET',path,once:true,delayMs:400,status:503}]}); await button('Apparat guruhlari').click(); await dialog().getByText('Apparat guruhlari yuklanmoqda…',{exact:true}).waitFor(); await button('Guruhlarni qayta yuklash',dialog()).waitFor(); assert.equal(await dialog().getByText('Apparat guruhlari hali yo‘q.',{exact:true}).count(),0); await button('Guruhlarni qayta yuklash',dialog()).click(); await directory(); },{noOpen:true});
  await run('empty-active-catalog-can-create-empty-group', async () => { await create('QA Empty liniya'); await dialog().getByText('Qidiruvga mos faol apparat topilmadi.',{exact:true}).waitFor(); await save(); assert.deepEqual((await collection('QA Empty liniya')).apparatus_ids,[]); },{scenario:'empty-apparatus'});
  await run('repeated-submit-and-keyboard-focus', async () => { await create(); await control('/__qa/config',{rules:[{method:'POST',path,once:true,delayMs:250}]}); await (await enabled(button('Apparat guruhini saqlash',dialog()))).evaluate(node=>{node.click();node.click();}); await directory(); assert.equal((await writes()).length,1); await page.keyboard.press('Escape'); await dialog().waitFor({state:'hidden'}); await until(()=>button('Apparat guruhlari').evaluate(node=>document.activeElement===node),Boolean,'Toolbar focus was not restored'); });
  await run('mobile-dark-reduced-motion', async () => { await button('Oynani yopish',dialog()).click(); await button('Qorong‘i mavzu').click(); await page.locator('html.dark').waitFor(); await open(); await capture('directory'); await create('QA Mobile liniya'); await choice('QA Flexo 1').check(); await capture('editor'); const widths=await dialog().evaluate(node=>({viewport:innerWidth,document:document.documentElement.scrollWidth,client:node.clientWidth,scroll:node.scrollWidth})); assert.ok(widths.document<=widths.viewport&&widths.scroll<=widths.client); await save(); assert.equal((await writes()).length,1); assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true); },{viewport:{width:390,height:844},hasTouch:true,reducedMotion:'reduce',scenario:'collections'});
} finally { await browser?.close(); }
const failures = outcomes.filter(row => row.status !== 'passed'); process.stdout.write(`Apparatus collection acceptance: ${outcomes.length-failures.length}/${outcomes.length} passed. ${output}results.json\n`); if (failures.length) process.exitCode=1;
