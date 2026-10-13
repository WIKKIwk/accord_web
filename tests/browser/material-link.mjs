import assert from 'node:assert/strict';
import { fixtureCapabilities } from '../fixtures/erp-seed.mjs';
import { materialLinkPath } from '../fixtures/erp-material-link.mjs';

// Definitions only. The parent owns fixture controls, isolated contexts and all
// browser/runtime I/O. Each setup runs before its existing synthetic login.
export async function runMaterialLinkAcceptance(ctx) {
  const { run, control, state, waitState, waitRequests, button, dialog, enabled, screenshot, orderAssignment, reopenOrderAssignment, apparatusIds, getPage } = ctx;
  const orderId = 'zakaz-qa-1001', apparatusId = apparatusIds.print;
  const worker = { role: 'aparatchi', ref: 'qa-worker-1', display_name: 'QA Brigadir' };
  const mover = { role: 'material_taminotchi', ref: 'QA-MATERIAL-1', display_name: 'QA Material mas’uli' };
  const admin = { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator' };
  const listNotice = 'Ro‘yxat ushbu buyurtma, apparat va operatorning oxirgi 50 ta so‘rovi bilan chegaralangan.';
  const nativeWrites = async () => (await control('/__qa/log')).requests.filter(row => row.method === 'POST' && row.path === materialLinkPath);
  const nativeReads = async () => (await control('/__qa/log')).requests.filter(row => row.method === 'GET' && row.path === materialLinkPath);
  const online = () => getPage().evaluate(() => window.dispatchEvent(new Event('online')));
  const observations = form => form.getByText('Serverda kuzatilgan native identifikatorlar', { exact: true }).locator('..');
  const assertUnkeyed = log => { assert.equal(log.idempotencyKeyPresent, false); assert.equal(log.expectedRevisionHeader, null); assert.ok(!Object.keys(log.body).some(key => /idempotency|expected|revision|warehouse|receipt/.test(key))); };
  async function setup(scenario = 'available', profile = worker, capabilities = fixtureCapabilities, assignedApparatus = [apparatusId]) {
    assert.ok(capabilities.includes('admin.access'), 'Every web QA session must retain the application admin.access entry gate');
    await control('/__qa/material-link', { scenario }); await control('/__qa/config', { profileOverride: profile, capabilities, assignedApparatus });
  }
  async function panel() {
    const controls = await orderAssignment(orderId); await button('Homashyo ulash so‘rovlari').click(); return { controls, form: dialog('Homashyo ulash so‘rovlari') };
  }
  async function workerPanel() { const ui = await panel(); await ui.form.getByText(listNotice, { exact: true }).waitFor(); return ui; }
  async function managerPanel() {
    const ui = await panel(), request = (await state()).materialLinkRequests[0]; assert.ok(request?.request_id, 'Manager lookup must use an actual saved native request ID');
    await ui.form.getByLabel('Native so‘rov identifikatori', { exact: true }).fill(request.request_id); await button('Ochish', ui.form).click(); return { ...ui, request };
  }
  async function pick(form, barcodes = ['QA-ROLL-1']) { for (const barcode of barcodes) await (await enabled(form.getByRole('checkbox', { name: new RegExp('^' + barcode + ' ·') }))).check(); }
  async function createReview(form, barcodes = ['QA-ROLL-1']) { await pick(form, barcodes); await (await enabled(button('Ulash uchun so‘rov', form))).click(); await button('Tasdiqlash va yuborish', form).waitFor(); }
  async function approveReview(form, barcodes = ['QA-ROLL-1']) { await pick(form, barcodes); await (await enabled(button('Tanlanganlarni ulash', form))).click(); await button('Tasdiqlash va yuborish', form).waitFor(); }
  async function submit(form) { await (await enabled(button('Tasdiqlash va yuborish', form))).click(); }
  async function unknown(form) { await button('Serverdagi so‘rovni tekshirish', form).waitFor(); await form.getByText(/Aynan avvalgi tanlov saqlangan|Yuborilgan so‘rov natijasi aniqlanmagan/).first().waitFor(); }
  async function remount(ui) {
    const original = await getPage().locator('html').elementHandle(); await button('Yopish', ui.form).click();
    const controls = await reopenOrderAssignment(ui.controls, orderId); await button('Homashyo ulash so‘rovlari').click(); const form = dialog('Homashyo ulash so‘rovlari');
    assert.equal(await getPage().evaluate(previous => previous === document.documentElement, original), true, 'Remount must retain the same authenticated document'); return { controls, form };
  }
  async function recoverCreate(form, observedCount) {
    await online(); await (await enabled(button('Serverdagi so‘rovni tekshirish', form))).click();
    const message = `Server ro‘yxatida mos ${observedCount} ta so‘rov kuzatildi. Ro‘yxat oxirgi 50 ta qayd bilan cheklangan; bu identifikatorsiz yuborish natijasini isbotlamaydi. Avvalgi yuborish saqlanmoqda.`;
    const result = form.getByRole('paragraph').filter({ hasText: message }); await result.waitFor(); assert.equal(await result.innerText(), message);
    await form.getByRole('alert').getByText(message, { exact: true }).waitFor();
    await form.getByText('Serverda kuzatilgan native identifikatorlar', { exact: true }).waitFor();
    assert.equal(await button('Ulash uchun so‘rov', form).count(), 0, 'An observation must not release unknown unkeyed creation');
    assert.equal(await button('Avvalgi qarorni aynan yuborish', form).count(), 0, 'Unkeyed creation must have no replay action');
    assert.equal(await form.getByLabel('Biriktirilgan apparat', { exact: true }).isDisabled(), true);
    const posts = await nativeWrites(); assert.equal(posts.length, 1, 'Read recovery replayed an unkeyed create'); assertUnkeyed(posts[0]);
  }
  async function savedDecision(form, expected) {
    await form.getByText('Serverdagi so‘rov holati: ' + expected + '. Qaror vaqti va xodimi saqlangan qayddan olinadi.', { exact: true }).waitFor();
    assert.equal(await button('Serverdagi so‘rovni tekshirish', form).count(), 0);
  }

  await run('material-link-worker-selected-mover-groups', async () => {
    const { form } = await workerPanel(); await createReview(form, ['QA-ROLL-1', 'QA-ROLL-2']); await submit(form);
    await form.getByText('Server 2 ta homashyo ulash so‘rovining haqiqiy identifikatori va holatini qaytardi.', { exact: true }).waitFor();
    const data = await waitState(data => data.materialLinkRequests.length === 2, 'Both selected mover groups must commit');
    assert.deepEqual(data.materialLinkRequests.map(row => row.mover_ref).sort(), ['QA-MATERIAL-1', 'QA-MATERIAL-2']); assert.equal(data.rawAssignments.length, 0);
    for (const request of data.materialLinkRequests) { await form.getByText(request.request_id, { exact: true }).first().waitFor(); assert.equal(request.candidates.length, 1); assert.equal(request.requester_ref, worker.ref); assert.equal(request.expires_at_unix - request.requested_at_unix, 1800); }
    const [post] = await waitRequests(row => row.method === 'POST' && row.path === materialLinkPath, 1); assert.deepEqual(post.body, { action: 'create', order_id: orderId, apparatus: apparatusId, barcodes: ['QA-ROLL-1', 'QA-ROLL-2'] }); assertUnkeyed(post);
    const reads = await nativeReads(); assert.ok(reads.length >= 2); assert.ok(reads.every(row => row.query.order_id === orderId && row.query.apparatus === apparatusId && !row.query.request_id));
  }, () => setup('multi-mover'));

  await run('material-link-worker-pending-block-and-cancel', async () => {
    const { form } = await workerPanel(); await form.getByText('Avvalgi so‘rov bo‘yicha tasdiq kutilmoqda. Yangi yaratish yopiq.', { exact: true }).waitFor();
    assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true); assert.ok(await form.getByRole('checkbox').count() > 0);
    for (const checkbox of await form.getByRole('checkbox').all()) assert.equal(await checkbox.isDisabled(), true);
    await (await enabled(button('So‘rovni bekor qilish', form))).click(); await submit(form); await savedDecision(form, 'Bekor qilingan');
    const request = (await state()).materialLinkRequests[0]; assert.equal(request.status, 'cancelled'); assert.equal(request.decided_by_role, 'aparatchi'); assert.equal(request.decided_by_name, worker.display_name); assert.equal((await state()).rawAssignments.length, 0);
    const [post] = await nativeWrites(); assert.deepEqual(post.body, { request_id: request.request_id, action: 'cancel', barcodes: [] }); assertUnkeyed(post);
  }, () => setup('pending'));

  await run('material-link-create-loss-remount-shared-order-lock', async () => {
    const controls = await orderAssignment(orderId), initialAssignments = (await state()).rawAssignments;
    assert.equal(initialAssignments.length, 1); assert.equal(initialAssignments[0].barcode, 'QA-START-READY'); await enabled(button('Ishni boshlash', controls));
    await button('Homashyo ulash so‘rovlari').click(); let ui = { controls, form: dialog('Homashyo ulash so‘rovlari') }; await ui.form.getByText(listNotice, { exact: true }).waitFor();
    await createReview(ui.form); await control('/__qa/config', { rules: [{ method: 'POST', path: materialLinkPath, dropResponse: true, once: true }] }); await submit(ui.form); await unknown(ui.form);
    await waitState(data => data.materialLinkRequests.length === 1, 'Lost create must preserve its committed native group');
    await button('Yopish', ui.form).click(); await ui.controls.getByText('Shu buyurtmaning boshqa ishlab chiqarish amali natijasi kutilmoqda. Boshlash, topshirish va uskuna almashtirish avvalgi natija aniqlanguncha yopiq.', { exact: true }).waitFor();
    const starts = button('Ishni boshlash', ui.controls); assert.ok(await starts.count() > 0, 'The native scan-required stage must expose a start action to test its shared lock'); for (const start of await starts.all()) assert.equal(await start.isDisabled(), true);
    await getPage().getByText('Shu buyurtmada avvalgi ishlab chiqarish amali bor. Uning natijasi aniqlanmaguncha material qabuli qulflangan.', { exact: true }).waitFor();
    await button('Homashyo ulash so‘rovlari').click(); ui.form = dialog('Homashyo ulash so‘rovlari'); ui = await remount(ui);
    await recoverCreate(ui.form, 1); const request = (await state()).materialLinkRequests[0]; await ui.form.getByText(request.request_id, { exact: true }).first().waitFor();
    const posts = await nativeWrites(); assert.equal(posts.length, 1); assert.deepEqual(posts[0].body, { action: 'create', order_id: orderId, apparatus: apparatusId, barcodes: ['QA-ROLL-1'] });
    assert.deepEqual((await state()).rawAssignments, initialAssignments, 'Unkeyed create and read recovery must preserve every existing assignment');
  }, () => setup('start-ready'));

  await run('material-link-create-interrupted-late-commit', async () => {
    let ui = await workerPanel(); await createReview(ui.form); await control('/__qa/config', { rules: [{ method: 'POST', path: materialLinkPath, delayMs: 1600, once: true }] });
    const dispatched = getPage().waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === materialLinkPath); await submit(ui.form); await dispatched;
    await button('Yopish', ui.form).click(); await waitState(data => data.materialLinkRequests.length === 1, 'Interrupted native create must be observable after its late commit');
    await button('Homashyo ulash so‘rovlari').click(); ui.form = dialog('Homashyo ulash so‘rovlari'); ui = await remount(ui); await recoverCreate(ui.form, 1);
    assert.equal((await state()).materialLinkRequests[0].status, 'pending'); assert.equal((await nativeWrites()).length, 1);
  }, () => setup());

  await run('material-link-partial-group-failure-stays-unknown', async () => {
    let ui = await workerPanel(); await createReview(ui.form, ['QA-ROLL-1', 'QA-ROLL-2']); await submit(ui.form); await unknown(ui.form);
    assert.equal((await state()).materialLinkRequests.length, 1); assert.equal((await nativeWrites())[0].status, 500); ui = await remount(ui); await recoverCreate(ui.form, 1);
    await ui.form.getByText(/qisman yaratilgan yoki cheklangan ro‘yxatda yo‘q so‘rovlarni/).waitFor(); assert.equal((await state()).rawAssignments.length, 0);
  }, () => setup('partial-create'));

  await run('material-link-partial-returned-id-survives-remount', async () => {
    let ui = await workerPanel(); await createReview(ui.form, ['QA-ROLL-1', 'QA-ROLL-2']); await submit(ui.form); await unknown(ui.form);
    const requests = (await state()).materialLinkRequests, first = requests.find(row => row.mover_ref === 'QA-MATERIAL-1'); assert.equal(requests.length, 2);
    await observations(ui.form).getByText(first.request_id, { exact: true }).waitFor();
    ui = await remount(ui); await observations(ui.form).getByText(first.request_id, { exact: true }).waitFor(); await recoverCreate(ui.form, 2);
    for (const request of requests) await observations(ui.form).getByText(request.request_id, { exact: true }).waitFor(); assert.equal((await nativeWrites()).length, 1);
  }, () => setup('partial-receipt'));

  await run('material-link-fresh-quantity-proof-conflict-no-post', async () => {
    const { form } = await workerPanel(); await createReview(form); await control('/__qa/material-link', { action: 'stock', stock_id: 'qa-roll-1', patch: { qty: 79, uom: 'metr' } }); await submit(form);
    await form.getByText('Avvalgi so‘rov, rulon miqdori, joyi, placement versiyasi yoki haqiqiy ko‘chirgan xodim o‘zgargan.', { exact: true }).first().waitFor();
    assert.equal((await nativeWrites()).length, 0); assert.equal((await state()).materialLinkRequests.length, 0); assert.equal(await button('Serverdagi so‘rovni tekshirish', form).count(), 0);
  }, () => setup());

  await run('material-link-fresh-placement-proof-conflict-no-post', async () => {
    const { form } = await workerPanel(); await createReview(form); await control('/__qa/material-link', { action: 'stock', stock_id: 'qa-roll-1', patch: { placement_version: 5, updated_by_ref: 'QA-MATERIAL-2' } }); await submit(form);
    await form.getByText('Avvalgi so‘rov, rulon miqdori, joyi, placement versiyasi yoki haqiqiy ko‘chirgan xodim o‘zgargan.', { exact: true }).first().waitFor(); assert.equal((await nativeWrites()).length, 0);
  }, () => setup());

  await run('material-link-frozen-order-no-create', async () => {
    const { form } = await workerPanel(); await form.getByText('Yangi so‘rov uchun faol native buyurtma kerak.', { exact: true }).waitFor(); assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('frozen'));

  await run('material-link-hidden-start-interaction-no-create', async () => {
    const { form } = await workerPanel(); await form.getByText(/Joriy canonical bosqichning material tanlash ruxsati olinmadi/).waitFor(); assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true);
    for (const checkbox of await form.getByRole('checkbox').all()) assert.equal(await checkbox.isDisabled(), true); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('interaction-hidden'));

  await run('material-link-unassigned-worker-no-native-list', async () => {
    const { form } = await panel(); await form.getByText('Sessiyada biriktirilgan canonical apparat mavjud emas.', { exact: true }).waitFor(); assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true);
    assert.equal((await nativeReads()).length, 0); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('available', worker, fixtureCapabilities, []));

  await run('material-link-worker-queue-capability-required', async () => {
    const { form } = await workerPanel(); await form.getByText('Yangi so‘rov uchun apparatus.queue.manage ruxsati kerak.', { exact: true }).waitFor(); assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('available', worker, fixtureCapabilities.filter(code => code !== 'apparatus.queue.manage')));

  await run('material-link-wrong-actual-role-no-native-read', async () => {
    await orderAssignment(orderId); await getPage().getByText(/Homashyo so‘rovini o‘qish uchun haqiqiy operator yoki manager doirasi/).waitFor();
    assert.equal(await button('Homashyo ulash so‘rovlari').count(), 0); assert.equal((await nativeReads()).length, 0); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('pending', { role: 'qolipchi', ref: 'qa-qolipchi-1', display_name: 'QA Qolipchi' }));

  await run('material-link-manager-request-id-only-no-inbox', async () => {
    const { form } = await panel(); await form.getByText(/Manager uchun umumiy so‘rovlar ro‘yxati native APIda mavjud emas/).waitFor(); assert.equal((await nativeReads()).length, 0);
    await form.getByLabel('Native so‘rov identifikatori', { exact: true }).fill('guessed-material-request'); await button('Ochish', form).click(); await form.getByText(/Native kartadagi material-link-… identifikatorini to‘liq kiriting/).waitFor();
    assert.equal((await nativeReads()).length, 0); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('pending', admin));

  await run('material-link-manager-approve-selected-subset', async () => {
    const { form, request } = await managerPanel(); await approveReview(form, ['QA-ROLL-2']); await submit(form); await savedDecision(form, 'Tasdiqlangan');
    const saved = (await state()).materialLinkRequests[0]; assert.equal(saved.request_id, request.request_id); assert.deepEqual(saved.selected_barcodes, ['QA-ROLL-2']); assert.equal(saved.decided_by_name, mover.display_name); assert.equal(saved.decided_by_role, 'material_taminotchi'); assert.equal(saved.event_sequence, 2);
    await form.getByText('Ulangan rulonlar: QA-ROLL-2', { exact: true }).first().waitFor(); await form.getByText(/Saqlangan qaror: QA Material mas’uli/).first().waitFor();
    const data = await state(); assert.deepEqual(data.rawAssignments.map(row => row.barcode), ['QA-ROLL-2']); assert.equal(data.rawAssignments[0].assigned_by_ref, mover.ref);
    const [post] = await nativeWrites(); assert.deepEqual(post.body, { request_id: request.request_id, action: 'approve', barcodes: ['QA-ROLL-2'] }); assertUnkeyed(post);
    assert.ok((await nativeReads()).every(row => row.query.request_id === request.request_id && !row.query.order_id && !row.query.apparatus));
  }, () => setup('pending', mover));

  await run('material-link-manager-reject-native-cancelled', async () => {
    const { form } = await managerPanel(); await (await enabled(button('So‘rovni rad etish', form))).click(); await submit(form); await savedDecision(form, 'Bekor qilingan');
    const saved = (await state()).materialLinkRequests[0]; assert.equal(saved.status, 'cancelled'); assert.equal(saved.decided_by_role, 'admin'); assert.equal(saved.decided_by_name, admin.display_name); assert.deepEqual(saved.selected_barcodes, []); assert.equal((await state()).rawAssignments.length, 0); assertUnkeyed((await nativeWrites())[0]);
  }, () => setup('pending', admin));

  await run('material-link-manager-exact-mover-read-denied', async () => {
    const { form } = await managerPanel(); await button('Qayta yuklash', form).waitFor(); assert.equal(await button('Tanlanganlarni ulash', form).count(), 0); assert.equal(await button('So‘rovni rad etish', form).count(), 0);
    const reads = await nativeReads(); assert.ok(reads.length >= 1); assert.ok(reads.every(row => row.status === 403)); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('pending', { ...mover, ref: 'QA-MATERIAL-2', display_name: 'QA Ikkinchi material mas’uli' }));

  await run('material-link-admin-access-does-not-replace-assign', async () => {
    const { form } = await managerPanel(); await form.getByText('Qaror uchun raw_material.assign va serverdagi haqiqiy manager doirasi kerak. admin.access bu ruxsatni almashtirmaydi.', { exact: true }).waitFor();
    assert.equal(await button('Tanlanganlarni ulash', form).count(), 0); assert.equal(await button('So‘rovni rad etish', form).count(), 0); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('pending', admin, fixtureCapabilities.filter(code => code !== 'raw_material.assign')));

  await run('material-link-mover-approval-apparatus-scope', async () => {
    const { form } = await managerPanel(); await form.getByText('Rulon ulash uchun bu apparat haqiqiy biriktirish doirangizda bo‘lishi kerak.', { exact: true }).waitFor();
    assert.equal(await button('Tanlanganlarni ulash', form).count(), 0); await enabled(button('So‘rovni rad etish', form)); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('pending', mover, fixtureCapabilities, []));

  await run('material-link-decision-race-preserves-original-saved-selection', async () => {
    const { form, request } = await managerPanel(); await approveReview(form, ['QA-ROLL-1']); await submit(form); await savedDecision(form, 'Tasdiqlangan');
    const saved = (await state()).materialLinkRequests[0]; assert.equal(saved.request_id, request.request_id); assert.deepEqual(saved.selected_barcodes, ['QA-ROLL-2']); assert.equal(saved.decided_by_name, 'QA Original manager'); assert.equal(saved.decided_by_role, 'material_taminotchi'); assert.equal(saved.decided_at_unix, request.requested_at_unix); assert.equal(saved.event_sequence, 2);
    await form.getByText('Ulangan rulonlar: QA-ROLL-2', { exact: true }).first().waitFor(); await form.getByText(/Saqlangan qaror: QA Original manager/).first().waitFor();
    const [post] = await nativeWrites(); assert.deepEqual(post.body.barcodes, ['QA-ROLL-1']); assertUnkeyed(post); assert.deepEqual((await state()).rawAssignments.map(row => row.barcode), ['QA-ROLL-2']);
  }, () => setup('decision-race', admin));

  await run('material-link-decision-read-race-no-post', async () => {
    const { form } = await managerPanel(); await approveReview(form, ['QA-ROLL-1']); await submit(form); await savedDecision(form, 'Tasdiqlangan');
    await form.getByText('Ulangan rulonlar: QA-ROLL-2', { exact: true }).first().waitFor(); await form.getByText(/Saqlangan qaror: QA Original manager/).first().waitFor(); assert.equal((await nativeWrites()).length, 0); assert.equal((await state()).rawAssignments.length, 1);
  }, () => setup('decision-read-race', admin));

  await run('material-link-decision-loss-remount-read-by-id', async () => {
    let ui = await managerPanel(); const requestId = ui.request.request_id; await approveReview(ui.form, ['QA-ROLL-2']); await control('/__qa/config', { rules: [{ method: 'POST', path: materialLinkPath, dropResponse: true, once: true }] }); await submit(ui.form); await unknown(ui.form);
    const original = (await state()).materialLinkRequests[0]; assert.equal(original.status, 'approved'); ui = await remount(ui); await online(); await (await enabled(button('Serverdagi so‘rovni tekshirish', ui.form))).click(); await savedDecision(ui.form, 'Tasdiqlangan');
    assert.deepEqual((await state()).materialLinkRequests[0], original); assert.equal(original.request_id, requestId); assert.equal((await nativeWrites()).length, 1); assert.ok((await nativeReads()).every(row => row.query.request_id === requestId));
    await ui.form.getByText('Ulangan rulonlar: QA-ROLL-2', { exact: true }).first().waitFor();
  }, () => setup('pending', admin));

  await run('material-link-decision-malformed-receipt-read-recovery', async () => {
    let ui = await managerPanel(); await approveReview(ui.form); await control('/__qa/config', { rules: [{ method: 'POST', path: materialLinkPath, responseBody: { request: { status: 'approved' } }, once: true }] }); await submit(ui.form); await unknown(ui.form);
    const original = (await state()).materialLinkRequests[0]; assert.equal(original.status, 'approved'); assert.equal((await nativeWrites())[0].responseOverridden, true); ui = await remount(ui);
    await (await enabled(button('Serverdagi so‘rovni tekshirish', ui.form))).click(); await savedDecision(ui.form, 'Tasdiqlangan'); assert.deepEqual((await state()).materialLinkRequests[0], original); assert.equal((await nativeWrites()).length, 1);
  }, () => setup('pending', admin));

  await run('material-link-decision-unknown-retry-same-native-id', async () => {
    const { form, request } = await managerPanel(); await approveReview(form, ['QA-ROLL-2']); await control('/__qa/config', { rules: [{ method: 'POST', path: materialLinkPath, status: 403, error: 'forbidden', once: true }] }); await submit(form); await unknown(form);
    assert.equal((await state()).materialLinkRequests[0].status, 'pending'); await (await enabled(button('Avvalgi qarorni ko‘rib chiqish', form))).click(); await button('Avvalgi qarorni aynan yuborish', form).click(); await savedDecision(form, 'Tasdiqlangan');
    const posts = await waitRequests(row => row.method === 'POST' && row.path === materialLinkPath, 2); assert.deepEqual(posts[0].body, posts[1].body); assert.equal(posts[0].body.request_id, request.request_id); posts.forEach(assertUnkeyed); assert.equal((await state()).rawAssignments.length, 1);
  }, () => setup('pending', admin));

  await run('material-link-get-persists-expiry', async () => {
    const { form, request } = await managerPanel(); await form.getByText('So‘rov muddati tugagan', { exact: true }).waitFor(); const saved = (await state()).materialLinkRequests[0];
    assert.equal(saved.request_id, request.request_id); assert.equal(saved.status, 'expired'); assert.equal(saved.event_sequence, 2); assert.equal(saved.decided_at_unix, saved.expires_at_unix); assert.equal(saved.decided_by_name, '');
    assert.equal(await button('Tanlanganlarni ulash', form).count(), 0); assert.equal(await button('So‘rovni rad etish', form).count(), 0); assert.equal((await nativeWrites()).length, 0); await screenshot('expired-read');
  }, () => setup('expired', admin));

  await run('material-link-get-persists-stale-placement', async () => {
    const { form } = await managerPanel(); await form.getByText('Holat o‘zgargan — so‘rov yopilgan', { exact: true }).waitFor(); const saved = (await state()).materialLinkRequests[0];
    assert.equal(saved.status, 'stale'); assert.equal(saved.event_sequence, 2); await form.getByText('Rulon boshqa orderga ulangan yoki joyi/holati o‘zgargan. So‘rov yopildi.', { exact: true }).waitFor(); assert.equal((await nativeWrites()).length, 0); assert.equal((await state()).rawAssignments.length, 0);
  }, () => setup('stale', admin));

  await run('material-link-loading-error-read-retry', async () => {
    await control('/__qa/config', { rules: [{ method: 'GET', path: materialLinkPath, delayMs: 1600, once: true }] }); const { form } = await panel();
    await form.locator('[data-slot="skeleton"]').first().waitFor(); assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true); await screenshot('loading'); await form.getByText(listNotice, { exact: true }).waitFor();
    await control('/__qa/config', { rules: [{ method: 'GET', path: materialLinkPath, status: 500, error: 'material_link_store_failed' }] }); await button('Holatni yangilash', form).click(); await button('Qayta yuklash', form).waitFor(); assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true); await screenshot('read-error');
    await control('/__qa/config', { rules: [] }); await button('Qayta yuklash', form).click(); await form.getByText(listNotice, { exact: true }).waitFor(); await pick(form); await enabled(button('Ulash uchun so‘rov', form)); assert.equal((await nativeWrites()).length, 0);
  }, () => setup());

  await run('material-link-empty-candidates-no-create', async () => {
    const { form } = await workerPanel(); await form.getByText('Apparat oldida ushbu buyurtmaga ulash mumkin bo‘lgan bo‘sh rulon yo‘q.', { exact: true }).waitFor();
    assert.equal(await form.getByRole('checkbox').count(), 0); assert.equal(await button('Ulash uchun so‘rov', form).isDisabled(), true); assert.equal((await nativeWrites()).length, 0);
  }, () => setup('empty'));
}
