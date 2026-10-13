import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// An independent fresh Chromium profile; all HTTP and sockets stay on the QA origins.
const webOrigin = process.env.QA_WEB_ORIGIN || 'http://127.0.0.1:5184', apiOrigin = 'http://127.0.0.1:5199';
const webUrl = new URL(webOrigin);
assert.ok(webUrl.protocol === 'http:' && webUrl.hostname === '127.0.0.1' && ['5184', '5186'].includes(webUrl.port) && webUrl.pathname === '/' && !webUrl.search && !webUrl.hash);
const sourceRevision = process.env.QA_SOURCE_REV || 'unrecorded';
const buildDirectory = process.env.QA_BUILD_DIR || 'unrecorded';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = fileURLToPath(new URL(`../../docs/qa/cad-theme/${runId}/`, import.meta.url));
const allowed = new Set([webOrigin, apiOrigin]), outsideRequests = [], pageErrors = [], assets = [], proof = [], captures = [];
const packagePath = process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright';
const { chromium } = await import(packagePath.startsWith('/') ? pathToFileURL(packagePath).href : packagePath);
async function control(path, body) {
  assert.ok(path.startsWith('/__qa/'));
  const response = await fetch(apiOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok); return response.json();
}
await mkdir(output, { recursive: true });
assert.equal((await control('/__qa/health')).synthetic, true);
await control('/__qa/reset', {});
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let status = 'running', failure;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1150 }, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['data:', 'blob:', 'about:'].includes(url.protocol) || allowed.has(url.origin)) return route.continue();
    outsideRequests.push({ origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient');
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
  await button('Kirish').click(); await page.waitForURL(webOrigin + '/app/home'); await page.goto(webOrigin + '/app/factory-map?orderId=zakaz-qa-1002');
  const canvas = page.locator('[data-model-viewer-state][aria-busy="false"] canvas[data-factory-map-canvas][tabindex="0"]');
  await canvas.waitFor({ timeout: 60_000 });
  const original = await canvas.elementHandle(), strip = page.locator('[data-factory-stage-strip]');
  const assetCount = assets.length;
  async function idle() {
    await page.locator('canvas[data-camera-motion="idle"][data-camera-damping="false"]').waitFor();
    const stable = await page.evaluate(async () => {
      let previous = '', samples = 0; const started = performance.now();
      // Renderer diagnostics are throttled to 250 ms. Five animation frames can
      // read the same old attributes while OrbitControls still damps its gesture.
      // Compare five successive diagnostic windows, retaining exact comparisons.
      while (samples < 5 && performance.now() - started < 15000) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const node = document.querySelector('canvas[data-factory-map-canvas]');
        const current = `${node?.dataset.cameraPosition}|${node?.dataset.cameraTarget}|${node?.dataset.cameraClip}|${node?.dataset.cameraOrbit}`;
        samples = node?.dataset.cameraMotion === 'idle' && node?.dataset.cameraDamping === 'false' && current === previous ? samples + 1 : 0;
        previous = current;
      }
      return { stable: samples >= 5, samples };
    });
    assert.equal(stable.stable, true, 'Actual camera diagnostics did not settle before comparison');
  }
  async function trace(label) {
    await idle();
    const current = await canvas.evaluate(node => ({
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', cadTheme: node.dataset.cadTheme,
      view: node.dataset.stageView, object: node.dataset.isolatedObjectId, selected: node.dataset.selectedObjectId,
      cadSegments: Number(node.dataset.isolatedCadSegments), triangles: Number(node.dataset.triangles), activeReels: Number(node.dataset.activeReels),
      cameraPosition: node.dataset.cameraPosition, cameraTarget: node.dataset.cameraTarget, cameraClip: node.dataset.cameraClip, cameraOrbit: node.dataset.cameraOrbit, cameraAutoRotate: node.dataset.cameraAutoRotate,
      visible: JSON.parse(node.dataset.visibleApparatusIds || '[]'),
    }));
    proof.push({ label, ...current, viewport: page.viewportSize() }); return current;
  }
  async function capture(name) {
    await idle();
    await page.evaluate(() => {
      let badge = document.getElementById('qa-cad-theme-demo');
      if (!badge) { badge = document.createElement('div'); badge.id = 'qa-cad-theme-demo'; document.body.append(badge); }
      badge.textContent = 'DEMO · Sintetik · Asl CAD';
      Object.assign(badge.style, { position: 'fixed', bottom: '6px', right: '6px', zIndex: '2147483647', pointerEvents: 'none', padding: '2px 6px', border: '1px solid #737373', borderRadius: '4px', background: document.documentElement.classList.contains('dark') ? '#171717' : '#fff', color: document.documentElement.classList.contains('dark') ? '#d4d4d4' : '#171717', font: '500 10px/15px system-ui' });
    });
    await page.screenshot({ path: output + name, fullPage: false }); captures.push(name);
  }
  async function theme(next, baseline, label) {
    const previous = await page.locator('html').getAttribute('class');
    const modal = page.getByRole('dialog');
    const themeScope = await modal.count() ? modal : page;
    if (Boolean(previous?.split(/\s+/).includes('dark')) !== (next === 'dark')) await themeScope.getByRole('button', { name: next === 'dark' ? 'Qorong‘i mavzu' : 'Yorug‘ mavzu', exact: true }).click();
    await page.waitForFunction(expected => document.documentElement.classList.contains('dark') === expected, next === 'dark');
    // The renderer receives theme through its state bridge without recreation.
    await page.waitForFunction(expected => document.querySelector('canvas[data-factory-map-canvas]')?.dataset.cadTheme === expected, next);
    const current = await trace(label);
    for (const key of ['view', 'object', 'selected', 'cadSegments', 'triangles', 'activeReels', 'cameraPosition', 'cameraTarget', 'cameraClip', 'cameraOrbit', 'cameraAutoRotate']) assert.equal(current[key], baseline[key], `${label}: theme changed ${key}`);
    assert.deepEqual(current.visible, baseline.visible, `${label}: theme changed visible apparatus`);
    assert.equal(await page.evaluate(node => node === document.querySelector('canvas[data-factory-map-canvas]'), original), true, `${label}: theme recreated the canvas`);
    assert.equal(assets.length, assetCount, `${label}: theme reloaded the source model`);
    assert.equal(await page.locator('canvas[data-factory-map-canvas]').count(), 1); return current;
  }
  await strip.locator('[data-stage-key="overview"]').click(); await page.locator('canvas[data-stage-view="overview"][data-isolated-object-id=""]').waitFor();
  const overview = await trace('overview-light-initial'); await capture('factory-overview-light.png');
  for (let index = 0; index < 3; index++) { await theme('dark', overview, `overview-dark-${index + 1}`); if (!index) await capture('factory-overview-dark.png'); await theme('light', overview, `overview-light-restored-${index + 1}`); }
  // Gesture first: retaining only the initial fitted camera would miss a reset regression.
  const bounds = await canvas.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width * .35, bounds.y + bounds.height * .45); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .35 + 55, bounds.y + bounds.height * .45 + 25, { steps: 10 }); await page.mouse.up();
  const orbited = await trace('overview-after-user-orbit'); assert.notEqual(orbited.cameraPosition, overview.cameraPosition, 'Camera gesture did not exercise a user view');
  await theme('dark', orbited, 'orbited-overview-dark'); await theme('light', orbited, 'orbited-overview-light');
  for (const [stage, object] of [['print', 'node:1:instance:0'], ['laminate', 'node:6:instance:6']]) {
    await strip.locator(`[data-stage-key="node:${stage}"]`).click(); await page.locator(`canvas[data-stage-view="isolated"][data-isolated-object-id="${object}"]`).waitFor();
    const selected = await trace(`${stage}-light-initial`); assert.ok(selected.cadSegments > 0); assert.deepEqual(selected.visible, [object]);
    await capture(`isolated-${stage}-light.png`);
    for (let index = 0; index < 3; index++) { await theme('dark', selected, `${stage}-dark-${index + 1}`); if (!index) await capture(`isolated-${stage}-dark.png`); await theme('light', selected, `${stage}-light-restored-${index + 1}`); }
  }
  await button('To‘liq ekran').click(); await button('To‘liq ekrandan chiqish').waitFor(); const full = await trace('fullscreen-lamination-light');
  await theme('dark', full, 'fullscreen-lamination-dark'); await capture('fullscreen-lamination-dark.png'); await theme('light', full, 'fullscreen-lamination-light-restored');
  await page.keyboard.press('Escape'); await button('To‘liq ekran').waitFor();
  await page.setViewportSize({ width: 800, height: 900 }); const resized = await trace('responsive-lamination-light');
  await theme('dark', resized, 'responsive-lamination-dark'); await capture('responsive-lamination-dark.png'); await theme('light', resized, 'responsive-lamination-light-restored');
  await page.goto(webOrigin + '/app/home'); await page.goto(webOrigin + '/app/factory-map?orderId=zakaz-qa-1002');
  await canvas.waitFor({ timeout: 60_000 }); const remounted = await trace('remount-light-overview'); assert.ok(remounted.triangles > 0); assert.equal(remounted.cadTheme, 'light');
  assert.equal(outsideRequests.length, 0); assert.deepEqual(pageErrors, []);
  const log = await control('/__qa/log'); assert.equal(log.requests.filter(row => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) && row.path !== '/v1/mobile/auth/login').length, 0, 'Theme QA dispatched a business write');
  status = 'passed'; await original.dispose();
} catch (error) { status = 'failed'; failure = error.stack || error.message; process.exitCode = 1; }
finally {
  await browser.close();
  const report = { synthetic: true, productionVerified: false, status, failure, sourceRevision, buildDirectory, capturedAt: new Date().toISOString(), captures, proof, assets, outsideRequests, pageErrors };
  await writeFile(output + 'capture-evidence.json', JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status, output, captures: captures.length, verifiedStates: proof.length, failure }) + '\n');
}
