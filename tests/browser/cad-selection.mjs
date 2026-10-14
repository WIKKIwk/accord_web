import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A fresh private browser. This driver can access only the authorized local QA origins.
const webOrigin = process.env.QA_WEB_ORIGIN || 'http://127.0.0.1:5184';
const apiOrigin = 'http://127.0.0.1:5199';
assert.equal(webOrigin, 'http://127.0.0.1:5184');
const allowed = new Set([webOrigin, apiOrigin]);
const sourceRevision = process.env.QA_SOURCE_REV || 'unrecorded';
const buildDirectory = process.env.QA_BUILD_DIR || 'unrecorded';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = fileURLToPath(new URL(`../../docs/qa/cad-selection/${runId}/`, import.meta.url));
const packagePath = process.env.PLAYWRIGHT_PACKAGE_PATH || '/tmp/accord-web-quality-qa/node_modules/playwright/index.mjs';
const { chromium } = await import(packagePath.startsWith('/') ? pathToFileURL(packagePath).href : packagePath);
const outsideRequests = [], blockedWrites = [], pageErrors = [], assets = [], proof = [], captures = [];
const sourceHashes = Object.fromEntries(await Promise.all(['src/pages/FactoryMapPage.tsx', 'src/lib/factory-map-selection.ts', 'src/components/factory-stage-strip.tsx'].map(async path => [path, createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex')])));
async function control(path, body) {
  assert.ok(path.startsWith('/__qa/'));
  const response = await fetch(apiOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
}
await mkdir(output, { recursive: true });
const health = await control('/__qa/health');
assert.equal(health.synthetic, true); assert.ok(health.fixtureVersion >= 8);
await control('/__qa/reset', {});
const seed = (await control('/__qa/state')).state;
const firstOrderMap = seed.orders.find(order => order.map.id === 'zakaz-qa-1002').map;
// The first route deliberately excludes B and C. Default shared routes hide this bug.
await control('/__qa/order', { id: firstOrderMap.id, mapPatch: { nodes: firstOrderMap.nodes.filter(node => ['start', 'print', 'end'].includes(node.id)), edges: [{ from: 'start', to: 'print' }, { from: 'print', to: 'end' }] } });
// A bound apparatus with no order proves that isolation requires no active job.
await control('/__qa/apparatus', { apparatus_id: 'apparatus:qa:print-2', placement: { factory_map_object_id: 'node:3:instance:0' } });
const buildHtml = await (await fetch(webOrigin)).text();
const buildAsset = buildHtml.match(/src="([^\"]+\.js)"/)?.[1];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let status = 'running', failure;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1150 }, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (!['data:', 'blob:', 'about:'].includes(url.protocol) && !allowed.has(url.origin)) { outsideRequests.push({ origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient'); }
    if (url.origin === apiOrigin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && url.pathname !== '/v1/mobile/auth/login') { blockedWrites.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url()), origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
    if (allowed.has(origin)) socket.connectToServer();
    else { outsideRequests.push({ origin, path: url.pathname }); socket.close({ code: 1008 }); }
  });
  const page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (/\.glb(?:\.gz)?$/.test(url.pathname)) assets.push(url.pathname); });
  const button = name => page.getByRole('button', { name, exact: true });
  await page.goto(webOrigin + '/kirish'); await page.getByLabel('Server manzili').fill(apiOrigin);
  await page.getByLabel('Telefon raqami').fill('+998900000001'); await page.getByLabel('Kirish kodi', { exact: true }).fill('QA-CODE');
  await button('Kirish').click(); await page.waitForURL(webOrigin + '/app/home');
  // Start in factory overview, with no orderId and no page refresh between selections.
  await page.goto(webOrigin + '/app/factory-map');
  const canvas = page.locator('[data-model-viewer-state][aria-busy="false"] canvas[data-factory-map-canvas][tabindex="0"]');
  await canvas.waitFor({ timeout: 60_000 });
  const original = await canvas.elementHandle(), assetCount = assets.length;
  const list = page.getByLabel('Xaritadagi apparatlar', { exact: true });
  const strip = page.locator('[data-factory-stage-strip]');
  async function idle() {
    await page.locator('canvas[data-camera-motion="idle"][data-camera-damping="false"]').waitFor();
    const stable = await page.evaluate(async () => {
      let previous = '', samples = 0; const start = performance.now();
      while (samples < 3 && performance.now() - start < 15_000) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const node = document.querySelector('canvas[data-factory-map-canvas]');
        const current = `${node?.dataset.cameraPosition}|${node?.dataset.cameraTarget}|${node?.dataset.cameraClip}|${node?.dataset.cameraOrbit}`;
        samples = node?.dataset.cameraMotion === 'idle' && node?.dataset.cameraDamping === 'false' && current === previous ? samples + 1 : 0;
        previous = current;
      }
      return samples >= 3;
    });
    assert.equal(stable, true, 'Camera did not settle');
  }
  async function trace(label) {
    await idle();
    const state = await canvas.evaluate(node => {
      const bridge = JSON.parse(node.parentElement.getAttribute('data-model-viewer-state'));
      return { view: node.dataset.stageView, object: node.dataset.isolatedObjectId, selected: node.dataset.selectedObjectId, visible: JSON.parse(node.dataset.visibleApparatusIds || '[]'),
        cadSegments: Number(node.dataset.isolatedCadSegments), triangles: Number(node.dataset.triangles), activeReels: Number(node.dataset.activeReels), theme: node.dataset.cadTheme,
        stageMotionAllowed: bridge.stageMotionAllowed, nativeMachine: bridge.live.machines.find(machine => machine.objectId === node.dataset.selectedObjectId) || null,
        cameraPosition: node.dataset.cameraPosition, cameraTarget: node.dataset.cameraTarget, cameraClip: node.dataset.cameraClip, cameraOrbit: node.dataset.cameraOrbit };
    });
    assert.equal(await page.evaluate(node => node === document.querySelector('canvas[data-factory-map-canvas]'), original), true, `${label}: selection recreated the canvas`);
    assert.equal(assets.length, assetCount, `${label}: selection reloaded the original CAD`);
    assert.equal(await page.locator('canvas[data-factory-map-canvas]').count(), 1);
    proof.push({ label, ...state }); return state;
  }
  async function capture(name) {
    await page.evaluate(() => {
      let badge = document.getElementById('qa-cad-selection-demo');
      if (!badge) { badge = document.createElement('div'); badge.id = 'qa-cad-selection-demo'; document.body.append(badge); }
      badge.textContent = 'DEMO · Sintetik · Asl CAD';
      Object.assign(badge.style, { position: 'fixed', bottom: '6px', right: '6px', zIndex: '2147483647', pointerEvents: 'none', padding: '2px 6px', border: '1px solid #737373', borderRadius: '4px', background: document.documentElement.classList.contains('dark') ? '#171717' : '#fff', color: document.documentElement.classList.contains('dark') ? '#d4d4d4' : '#171717', font: '500 10px/15px system-ui' });
    });
    await page.screenshot({ path: output + name, fullPage: false }); captures.push(name);
  }
  async function refresh() {
    await button('Yangilash').click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Yangilash' && !node.disabled));
  }
  async function select(name, objectId, label) {
    await list.getByRole('button', { name }).click();
    await page.locator(`canvas[data-stage-view="isolated"][data-isolated-object-id="${objectId}"]`).waitFor();
    const state = await trace(label);
    assert.equal(state.selected, objectId); assert.deepEqual(state.visible, [objectId]); assert.ok(state.cadSegments > 0, `${label}: original CAD contours disappeared`); assert.ok(state.triangles > 0);
    return state;
  }
  async function overview(label) {
    await button('Umumiy ko‘rinish').click();
    await page.locator('canvas[data-stage-view="overview"][data-isolated-object-id=""][data-selected-object-id=""]').waitFor();
    const state = await trace(label); assert.deepEqual(state.visible, []); assert.equal(state.cadSegments, 0); return state;
  }
  async function theme(next, baseline, label) {
    if (await canvas.getAttribute('data-cad-theme') !== next) await button(next === 'dark' ? 'Qorong‘i mavzu' : 'Yorug‘ mavzu').click();
    await page.waitForFunction(expected => document.querySelector('canvas[data-factory-map-canvas]')?.dataset.cadTheme === expected, next);
    const state = await trace(label);
    for (const key of ['view', 'object', 'selected', 'cadSegments', 'triangles', 'cameraPosition', 'cameraTarget', 'cameraClip', 'cameraOrbit']) assert.equal(state[key], baseline[key], `${label}: theme changed ${key}`);
    assert.deepEqual(state.visible, baseline.visible); return state;
  }
  for (const mode of ['light', 'dark']) {
    await overview(`overview-${mode}-start`);
    const a = await select(/QA Flexo 1/, 'node:1:instance:0', `A-${mode}`);
    assert.equal(a.nativeMachine.orderId, 'zakaz-qa-1002'); assert.equal(a.nativeMachine.state, 'in_progress');
    const b = await select(/QA Laminator/, 'node:6:instance:6', `B-outside-A-route-${mode}`);
    assert.equal(b.nativeMachine.orderId, 'zakaz-qa-1003'); assert.equal(b.nativeMachine.state, 'paused');
    assert.equal(await strip.getAttribute('data-factory-apparatus-view'), b.object);
    await strip.getByText('Apparat ko‘rinishi', { exact: true }).waitFor();
    assert.equal(await strip.locator('[data-stage-key="overview"]').getAttribute('aria-current'), null);
    assert.equal(await strip.getByText('Zavodning to‘liq modeli. Bosqichni tanlab uning haqiqiy apparatini alohida ko‘ring.', { exact: true }).count(), 0);
    await strip.getByText('Bu apparat tanlangan buyurtmaning tasdiqlangan yo‘liga kirmaydi.', { exact: true }).waitFor();
    await capture(`selected-B-${mode}.png`);
    if (mode === 'light') {
      await theme('dark', b, 'isolated-B-theme-dark'); await capture('selected-B-dark-theme-toggle.png');
      await theme('light', b, 'isolated-B-theme-light-restored');
    }
    await select(/QA Rezka/, 'node:18:instance:0', `C-outside-A-route-${mode}`);
    await select(/QA Flexo 1/, 'node:1:instance:0', `A-repeated-${mode}`);
    await select(/QA Laminator/, 'node:6:instance:6', `B-repeated-${mode}`);
    const idleMachine = await select(/QA Flexo 2/, 'node:3:instance:0', `bound-no-order-${mode}`);
    assert.equal(await strip.getAttribute('data-factory-apparatus-view'), idleMachine.object);
    assert.equal(idleMachine.nativeMachine.orderId, ''); assert.equal(idleMachine.nativeMachine.state, 'idle'); assert.equal(idleMachine.activeReels, 0);
    await capture(`bound-no-order-${mode}.png`);
    const unbound = await select(/Holodniy kley aparat/, 'node:18:instance:2', `unbound-no-order-${mode}`);
    assert.equal(await strip.getAttribute('data-factory-apparatus-view'), unbound.object);
    assert.equal(unbound.nativeMachine, null); assert.equal(unbound.activeReels, 0);
    await refresh();
    const refreshed = await trace(`direct-selection-after-data-refresh-${mode}`); assert.equal(refreshed.object, unbound.object);
    await capture(`unbound-no-order-${mode}.png`);
    const full = await overview(`overview-${mode}-restored`); await capture(`overview-${mode}.png`);
    if (mode === 'light') await theme('dark', full, 'overview-theme-dark');
  }
  // Keyboard apparatus browsing uses the same independent selection path.
  await canvas.focus(); await page.keyboard.press('End');
  await page.locator('canvas[data-stage-view="isolated"][data-isolated-object-id="equipment:rezka:5"]').waitFor();
  const keyboard = await trace('keyboard-unbound-apparatus'); assert.deepEqual(keyboard.visible, ['equipment:rezka:5']); assert.ok(keyboard.cadSegments > 0);
  await page.keyboard.press('Escape'); await page.locator('canvas[data-stage-view="overview"][data-isolated-object-id=""]').waitFor();
  await trace('keyboard-overview');
  // Explicit stage navigation retains route edits and native future-stage motion guards.
  await strip.locator('[data-stage-key="node:print"]').click();
  await page.locator('canvas[data-isolated-object-id="node:1:instance:0"]').waitFor(); await trace('explicit-print-stage');
  await control('/__qa/order', { id: firstOrderMap.id, mapPatch: { nodes: firstOrderMap.nodes.filter(node => ['start', 'end'].includes(node.id)), edges: [{ from: 'start', to: 'end' }] } });
  await refresh(); await page.locator('canvas[data-stage-view="overview"][data-isolated-object-id=""][data-selected-object-id=""]').waitFor(); await trace('explicit-stage-removed-clears-isolation');
  await select(/QA Laminator/, 'node:6:instance:6', 'direct-apparatus-with-removed-order-route');
  await control('/__qa/order', { id: firstOrderMap.id, mapPatch: { nodes: firstOrderMap.nodes, edges: firstOrderMap.edges } });
  await refresh(); await strip.locator('[data-stage-key="node:laminate"]').waitFor();
  const directAfterRouteEdit = await trace('direct-apparatus-survives-route-edit'); assert.equal(directAfterRouteEdit.object, 'node:6:instance:6');
  await strip.locator('[data-stage-key="node:laminate"]').click();
  const futureStage = await trace('explicit-future-stage'); assert.equal(futureStage.object, 'node:6:instance:6'); assert.equal(futureStage.stageMotionAllowed, false); assert.equal(futureStage.activeReels, 0);
  await control('/__qa/apparatus', { apparatus_id: 'apparatus:qa:laminate-1', placement: null });
  await refresh(); await page.locator('canvas[data-stage-view="overview"][data-isolated-object-id=""][data-selected-object-id=""]').waitFor();
  const unboundStage = await trace('explicit-stage-unbound-clears-isolation'); assert.equal(unboundStage.stageMotionAllowed, false); assert.equal(unboundStage.activeReels, 0);
  await strip.getByText('Bu bosqichning apparati hali 3D modelga biriktirilmagan.', { exact: true }).waitFor();
  assert.deepEqual(outsideRequests, []); assert.deepEqual(blockedWrites, []); assert.deepEqual(pageErrors, []);
  const log = await control('/__qa/log');
  assert.equal(log.requests.filter(row => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) && row.path !== '/v1/mobile/auth/login').length, 0, 'Selection QA dispatched a business write');
  status = 'passed'; await original.dispose();
} catch (error) { status = 'failed'; failure = error.stack || error.message; process.exitCode = 1; }
finally {
  await browser.close();
  await writeFile(output + 'capture-evidence.json', JSON.stringify({ synthetic: true, productionVerified: false, status, failure, sourceRevision, sourceHashes, buildDirectory, buildAsset, fixtureVersion: health.fixtureVersion, capturedAt: new Date().toISOString(), captures, proof, assets, outsideRequests, blockedWrites, pageErrors }, null, 2));
  process.stdout.write(JSON.stringify({ status, output, captures: captures.length, verifiedStates: proof.length, failure }) + '\n');
}
