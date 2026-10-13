import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = 'http://127.0.0.1:5184', api = 'http://127.0.0.1:5198';
const output = fileURLToPath(new URL(`../../docs/qa/dashboardcn/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url));
const allowed = new Set([web, api]), outside = [], errors = [], proofs = [];
const packagePath = process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright';
const { chromium } = await import(packagePath.startsWith('/') ? pathToFileURL(packagePath).href : packagePath);
async function control(path, body) {
  assert.ok(path.startsWith('/__qa/'));
  const response = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok); return response.json();
}
await mkdir(output, { recursive: true });
assert.equal((await control('/__qa/health')).synthetic, true);
await control('/__qa/reset', {});
await control('/__qa/config', { manufacturingDemoCohort: true });
const browser = await chromium.launch({ headless: true });
let status = 'running', failure;
try {
  const context = await browser.newContext({ viewport: { width: 1656, height: 1100 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'Asia/Tashkent', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['data:', 'blob:', 'about:'].includes(url.protocol) || allowed.has(url.origin)) return route.continue();
    outside.push({ origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url()), origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
    if (allowed.has(origin)) socket.connectToServer(); else { outside.push({ origin, path: url.pathname }); socket.close({ code: 1008 }); }
  });
  const page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  const button = (name, root = page) => root.getByRole('button', { name, exact: true });
  async function capture(name, root = page) {
    await page.evaluate(() => {
      let badge = document.getElementById('qa-dashboardcn-demo');
      if (!badge) { badge = document.createElement('div'); badge.id = 'qa-dashboardcn-demo'; document.body.append(badge); }
      badge.textContent = 'DEMO · Sintetik · dashboardcn';
      Object.assign(badge.style, { position: 'fixed', bottom: '5px', right: '5px', zIndex: '2147483647', pointerEvents: 'none', padding: '2px 6px', border: '1px solid #737373', borderRadius: '4px', background: document.documentElement.classList.contains('dark') ? '#171717' : '#fff', color: document.documentElement.classList.contains('dark') ? '#d4d4d4' : '#171717', font: '500 10px/15px system-ui' });
      for (const heading of document.querySelectorAll('h1, [data-slot=manufacturing-recorded-analytics] h2, [aria-label="Yopilgan buyurtmaning saqlangan hodisalari"] h3')) {
        if (heading.querySelector('[data-qa-demo-label]')) continue;
        const label = document.createElement('span'); label.dataset.qaDemoLabel = 'true'; label.textContent = 'DEMO · Sintetik';
        Object.assign(label.style, { marginLeft: '8px', padding: '1px 4px', border: '1px solid currentColor', borderRadius: '4px', font: '500 9px/14px system-ui', whiteSpace: 'nowrap', verticalAlign: 'middle', opacity: '.7' }); heading.append(label);
      }
    });
    const settling = await page.evaluate(async () => {
      const finite = () => document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
      const started = performance.now(); let frames = 0;
      while (performance.now() - started < 2500 && frames < 3) { await new Promise(requestAnimationFrame); frames = finite().length ? 0 : frames + 1; }
      return { stable: frames >= 3, remaining: finite().length };
    });
    assert.ok(settling.stable && settling.remaining === 0, 'Visible tab/theme transitions must settle before pixel acceptance');
    await root.screenshot({ path: output + name });
    proofs.push({ screenshot: name, route: page.url(), viewport: page.viewportSize(), settling, theme: await page.locator('html').getAttribute('class'), components: await page.locator('[data-slot]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.slot).filter(slot => ['kpi-card', 'metric-list', 'metric-value', 'timeline', 'composed-chart', 'dot-plot', 'heatmap-chart', 'period-tabs'].includes(slot)))]) });
  }
  await page.goto(web + '/kirish'); await page.getByLabel('Server manzili').fill(api);
  await page.getByLabel('Telefon raqami').fill('+998900000001'); await page.getByLabel('Kirish kodi', { exact: true }).fill('QA-CODE'); await button('Kirish').click(); await page.waitForURL(web + '/app/home');
  await page.locator('[data-slot=kpi-card]').first().waitFor();
  assert.equal(await page.locator('[data-slot=kpi-card]').count(), 6);
  assert.equal(await page.locator('[data-slot=kpi-card] [data-slot=card-header] [data-slot=card-title]').count(), 6);
  await button('Menyuni ochish yoki yopish').click();
  await capture('home-kpi-light.png'); await button('Qorong‘i mavzu').click(); await page.locator('html.dark').waitFor(); await capture('home-kpi-dark.png');
  await page.goto(web + '/app/production-time');
  const analytics = page.locator('[data-slot=manufacturing-recorded-analytics]');
  await analytics.locator('[data-slot=composed-chart] svg.recharts-surface').waitFor();
  await analytics.getByText(/Asia\/Tashkent/).first().waitFor();
  assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'Asia/Tashkent');
  const dateChartPosition = await analytics.boundingBox();
  const rankingsPosition = await page.getByRole('region', { name: 'Ishlab chiqarish vaqtiga umumiy qarash', exact: true }).boundingBox();
  assert.ok(dateChartPosition && rankingsPosition && dateChartPosition.y < rankingsPosition.y, 'Recorded date chart must lead the separate duration rankings');
  proofs.push({ route: page.url(), operationalTimeZone: 'Asia/Tashkent', dateChartFirst: true });
  assert.equal(await page.locator('[data-slot=dot-plot]').count(), 0, 'Queue distribution belongs on apparatus');
  assert.equal(await page.locator('[data-slot=heatmap-chart]').count(), 0, 'Variant matrix belongs on materials');
  await analytics.getByRole('tab', { name: '7 kun', exact: true }).click(); assert.equal(await analytics.getByRole('tab', { name: '7 kun', exact: true }).getAttribute('aria-selected'), 'true');
  await analytics.getByRole('tab', { name: 'Olingan tarix', exact: true }).click();
  await analytics.scrollIntoViewIfNeeded(); await capture('production-time-date-chart-dark.png', analytics);
  await page.evaluate(() => window.scrollTo(0, 0)); await capture('production-time-page-dark.png');
  await button('Yorug‘ mavzu').click(); await page.locator('html:not(.dark)').waitFor(); await capture('production-time-date-chart-light.png', analytics);
  await page.goto(web + '/app/closed?selected=zakaz-4001');
  await page.getByRole('tab', { name: 'Hodisalar', exact: true }).click();
  const timeline = page.getByRole('region', { name: 'Yopilgan buyurtmaning saqlangan hodisalari', exact: true });
  await timeline.locator('[data-slot=timeline] [data-slot=timeline-header]').first().waitFor();
  const eventButtons = timeline.locator('[data-slot=timeline-title] button'); await eventButtons.nth(1).click(); assert.equal(await eventButtons.nth(1).getAttribute('aria-pressed'), 'true');
  await capture('closed-order-events-light.png', page.getByRole('dialog'));
  for (const kind of ['apparatus', 'materials', 'warehouses', 'stock', 'closed']) {
    await page.goto(web + `/app/${kind}${kind === 'stock' ? '?warehouse=QA%20Xomashyo' : ''}`);
    await page.getByRole('tab', { name: 'Umumiy ko‘rinish', exact: true }).click();
    const domain = page.locator('[data-slot=domain-metrics]'); await domain.waitFor();
    assert.equal(await domain.locator('[data-slot=kpi-card]').count(), 3);
    if (kind === 'apparatus') {
      await domain.locator('[data-slot=dot-plot]').waitFor(); await domain.locator('[data-slot=metric-list-row]').first().waitFor();
      const bins = domain.locator('ol button');
      const columns = domain.locator('[data-slot=dot-plot-column]');
      assert.equal(await columns.count(), 4); assert.equal(await bins.count(), 4);
      const binProofs = [];
      for (let index = 0; index < 4; index++) {
        const label = await bins.nth(index).innerText(), match = label.match(/(\d+) apparat/);
        assert.ok(match, 'Each queue category must retain its exact native apparatus count');
        const actualCount = Number(match[1]);
        const dots = await columns.nth(index).locator(':scope > span:not([role=tooltip])').count();
        assert.equal(dots, Math.min(actualCount, 16), 'One displayed dot must represent exactly one apparatus');
        const markBox = await columns.nth(index).boundingBox(), labelBox = await bins.nth(index).boundingBox();
        assert.ok(markBox && labelBox);
        const centerGap = Math.abs(markBox.x + markBox.width / 2 - labelBox.x - labelBox.width / 2);
        assert.ok(centerGap <= 1, 'Queue category labels must align with their marks');
        binProofs.push({ label, nativeApparatusCount: actualCount, displayedDots: dots, centerGap });
      }
      await page.getByRole('tab', { name: 'Ro‘yxat', exact: true }).click();
      const [refreshedQueue] = await Promise.all([
        page.waitForResponse(response => response.url() === api + '/v1/mobile/admin/production-maps/sequence' && response.request().method() === 'GET'),
        button('Ro‘yxatni yangilash').click(),
      ]);
      assert.equal(refreshedQueue.status(), 200, 'Apparatus list refresh must also refresh its native queue snapshot');
      await page.getByRole('tab', { name: 'Umumiy ko‘rinish', exact: true }).click();
      await domain.locator('[data-slot=dot-plot]').waitFor();
      proofs.push({ route: page.url(), oneDotPerApparatus: true, columnsAndLabelsAligned: true, queueRefreshVerified: true, bins: binProofs });
      await bins.first().focus(); assert.equal(await bins.first().getAttribute('aria-pressed'), 'true'); await bins.first().click(); assert.equal(await bins.first().getAttribute('aria-pressed'), 'false');
      await capture('apparatus-queue-distribution-light.png');
    } else if (kind === 'materials') {
      await domain.locator('[data-slot=heatmap-chart]').waitFor();
      const cell = domain.locator('[data-slot=heatmap-chart-cell]').first(); await cell.scrollIntoViewIfNeeded(); await cell.hover(); await page.getByRole('tooltip').filter({ hasText: /Variant (bor|yo‘q)/ }).waitFor();
      const box = await cell.boundingBox(); assert.ok(box && box.height <= 40, 'Catalog cells must remain compact');
      await page.keyboard.press('Escape');
      await domain.locator('[tabindex="0"]').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-slot')), 'heatmap-chart-cell', 'Keyboard enters the native variant matrix');
      await page.getByRole('tooltip').filter({ hasText: /Variant (bor|yo‘q)/ }).waitFor();
      await button('Qorong‘i mavzu').click(); await page.locator('html.dark').waitFor(); await capture('material-variant-matrix-dark.png');
    } else {
      await domain.locator('[data-slot=metric-list-row]').first().waitFor();
      if (kind === 'stock') await capture('stock-exact-unit-metrics-dark.png');
    }
    proofs.push({ route: page.url(), domain: kind, kpiCards: 3, metricRows: await domain.locator('[data-slot=metric-list-row]').count(), qualification: await domain.locator('p').first().innerText() });
  }
  await page.goto(web + '/app/production-time'); await analytics.locator('[data-slot=composed-chart]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await analytics.scrollIntoViewIfNeeded(); await capture('production-time-date-chart-mobile.png', analytics);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'Mobile page overflow');
  await control('/__qa/config', { emptyClosedHistory: true }); await page.reload();
  await analytics.getByText('Bu vaqt oralig‘ida hisoblashga yetarli jarayon yoki to‘xtash qaydi yo‘q.', { exact: true }).waitFor();
  assert.equal(await analytics.locator('[data-slot=composed-chart]').count(), 0); assert.equal(await analytics.locator('[data-slot=dot-plot]').count(), 0); assert.equal(await analytics.locator('[data-slot=heatmap-chart]').count(), 0);
  proofs.push({ route: page.url(), emptyHistory: true, fabricatedCharts: false });
  const log = await control('/__qa/log'); assert.equal(log.requests.filter(row => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) && row.path !== '/v1/mobile/auth/login').length, 0);
  assert.deepEqual(outside, []); assert.deepEqual(errors, []); status = 'passed';
} catch (error) { status = 'failed'; failure = error.stack || error.message; process.exitCode = 1; }
finally {
  await browser.close();
  await writeFile(output + 'capture-evidence.json', JSON.stringify({ synthetic: true, productionVerified: false, status, failure, sourceRevision: process.env.QA_SOURCE_REV || 'unrecorded', buildDirectory: process.env.QA_BUILD_DIR || 'unrecorded', webOrigin: web, fixtureOrigin: api, upstreamCommit: 'b1ffacbca0f7a0be60135c8665b9e8c267205c48', proofs, outsideRequests: outside, pageErrors: errors }, null, 2));
  process.stdout.write(JSON.stringify({ status, output, proofs: proofs.length, failure }) + '\n');
}
