import assert from 'node:assert/strict';

// All I/O is delegated to the guarded parent runner and its fresh context.
// These scenarios are definitions until the root runs the frozen web/fixture.
export async function runWorkflowExtensions(ctx) {
  const { run, control, state, waitState, waitRequests, button, dialog, choose, open, enabled, screenshot, orderAssignment, reopenOrderAssignment, openingForm, apparatusIds, base, getPage } = ctx;
  const pm = base + '/production-maps', orderId = 'zakaz-qa-1001';
  const writes = async suffix => (await control('/__qa/log')).requests.filter(row => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) && row.path.endsWith(suffix));
  const online = () => getPage().evaluate(() => window.dispatchEvent(new Event('online')));
  async function ruleForm() {
    await open('/app/raw-materials'); await button('Xomashyo qoidalari').click(); const form = dialog('Xomashyo qoidalari');
    await choose('Canonical apparat', new RegExp('^' + apparatusIds.print + ' ·'), form); await enabled(form.getByLabel('Material talabi', { exact: true })); return form;
  }
  async function requiredRule(form) { await choose('Material talabi', 'Barcha guruhlar talab qilinadi', form); await form.getByRole('checkbox', { name: 'Xomashyo', exact: true }).check(); await button('Qoidani ko‘rib chiqish', form).click(); }
  async function passport(path = '/app/wip?status=all&selected=qa-wip-1') {
    await open(path); await button('Rulon pasportini ochish').click(); const form = dialog('Saqlangan rulon pasporti'); await form.getByText('Saqlangan QR', { exact: true }).waitFor(); return form;
  }
  async function correct(form, { gross = '30', reason = 'QA Measured correction' } = {}) {
    await (await enabled(button('Pasportni tahrirlash', form))).click(); await form.getByLabel('Mahsulot / gross, kg (ixtiyoriy)', { exact: true }).fill(gross);
    await form.getByLabel('Correction sababi', { exact: true }).fill(reason); await button('Correctionni ko‘rib chiqish', form).click(); return dialog('Rulon correctionini tasdiqlash');
  }
  async function labelReview(form) {
    await (await enabled(button('Saqlangan yorliq amali', form))).click(); await form.getByLabel('Nusxa soni, 1–100', { exact: true }).fill('2');
    await button('Yorliq amalini ko‘rib chiqish', form).click(); const review = dialog('Saqlangan yorliq amalini tasdiqlash');
    await review.getByRole('checkbox', { name: /Saqlangan QR uchun ushbu alohida yorliq amalini tasdiqlayman/ }).check(); return review;
  }
  async function completionForm(operation = 'print', closing = false) {
    await orderAssignment(); const page = getPage(), controls = page.getByRole('region', { name: 'Bosqichni tugatish hisoboti', exact: true });
    const name = operation === 'print' ? 'QA Flexo 1 · print' : operation === 'laminate' ? 'QA Laminator · laminate' : 'QA Rezka · cut';
    const stage = controls.locator('div.rounded-md').filter({ has: page.getByText(name, { exact: true }) });
    await (await enabled(button(closing ? 'Bosma yopish hisobi' : 'Tugatish hisobotini kiritish', stage))).click();
    const form = dialog(closing ? 'Bosma yopish hisobi' : 'Bosqichni tugatish hisoboti'); await button('Hisobotni tekshirish', form).waitFor(); return { form, controls };
  }
  async function output(form, tare = '1') { for (const [label, value] of [['Rulon uzunligi, m', '1000'], ['Brutto og‘irligi, kg', '30'], ['Bobina og‘irligi, kg', tare]]) await form.getByLabel(label, { exact: true }).fill(value); }
  async function printFields(form, waste = '2') {
    await output(form); await form.getByLabel('Umumiy chiqindi, kg', { exact: true }).fill(waste); await form.locator('#completion-description').fill('QA Measured print report');
    for (let index = 0; index < 6; index++) { await form.locator('#paint-name-' + index).fill('QA Paint ' + index); await form.locator('#paint-label-' + index).fill('kg'); await form.locator('#paint-value-' + index).fill(index < 3 ? '2' : '1'); }
  }
  async function layerFields(form, tare = '0') {
    await output(form, tare); await form.getByLabel('Umumiy chiqindi, kg', { exact: true }).fill('0');
    await form.getByLabel('QA Printed film · 10 kg kirish', { exact: true }).fill('0'); await form.getByLabel('QA Raw film · 20 kg kirish', { exact: true }).fill('2');
    await form.locator('#completion-description').fill('QA Atomic layer report');
  }
  async function intakeForm(barcode = 'QA-ROLL-1') {
    await orderAssignment(); await button('Material qabul qilish').click(); const form = dialog('Material qabul qilish');
    await form.getByLabel('Apparat va bosqich', { exact: true }).waitFor(); await choose('Apparat va bosqich', 'QA Flexo 1 · QA Flexo 1', form);
    await choose('Biriktirilgan material', new RegExp(' · ' + barcode + ' · '), form); await form.getByLabel('Material shtrixkodi', { exact: true }).fill(barcode.toLowerCase()); return form;
  }

  await run('raw-rule-native-required-clear', async () => {
    const form = await ruleForm(), before = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.print })).revision;
    await requiredRule(form); await button('Tasdiqlash va saqlash', form).click(); await form.getByText('Qoida canonical revisionda saqlandi.', { exact: true }).waitFor();
    let saved = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.print })).revision;
    assert.deepEqual(saved.policies.material, { mode: 'all_required', item_group_ids: ['Xomashyo'] }); assert.equal(saved.policies.queue, before.policies.queue); assert.deepEqual(saved.policies.tooling, before.policies.tooling);
    for (const field of ['display', 'hierarchy', 'physical_asset_id', 'execution_profile', 'capacity', 'placement', 'lifecycle']) assert.deepEqual(saved[field], before[field]);
    await button('Joriy qoidani yuklash', form).click(); await enabled(form.getByLabel('Material talabi', { exact: true }));
    await choose('Material talabi', 'Material majburiy emas', form); await form.getByRole('checkbox', { name: 'Xomashyo', exact: true }).uncheck();
    await button('Qoidani ko‘rib chiqish', form).click(); await button('Tasdiqlash va saqlash', form).click(); await form.getByText('Qoida canonical revisionda saqlandi.', { exact: true }).waitFor();
    saved = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.print })).revision; assert.deepEqual(saved.policies.material, { mode: 'not_required' }); assert.equal(saved.revision_metadata.revision, 3);
    const log = await waitRequests(row => row.method === 'PUT' && row.path.endsWith('/raw-material-rules'), 2); assert.ok(log.every(row => row.idempotencyKeyPresent)); assert.equal(log[0].body.expected_revision, 1); assert.equal(log[1].body.expected_revision, 2);
  }, () => control('/__qa/raw-rules', {}));

  await run('raw-rule-native-requirement-sets', async () => {
    const form = await ruleForm(); await choose('Material talabi', 'Talab to‘plamlari', form);
    await form.getByLabel('Talab identifikatori', { exact: true }).fill('QA-PRINT-INPUT'); await form.getByLabel('Kamida nechta', { exact: true }).fill('1');
    await form.getByRole('checkbox', { name: 'Xomashyo', exact: true }).check(); await form.getByRole('checkbox', { name: 'QA Yangi guruh', exact: true }).check();
    await button('Qoidani ko‘rib chiqish', form).click(); await button('Tasdiqlash va saqlash', form).click(); await form.getByText('Qoida canonical revisionda saqlandi.', { exact: true }).waitFor();
    const saved = (await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.print })).revision;
    assert.deepEqual(saved.policies.material, { mode: 'requirement_sets', sets: [{ requirement_id: 'QA-PRINT-INPUT', item_group_ids: ['QA Yangi guruh', 'Xomashyo'], minimum_required_count: 1 }] });
    assert.equal((await writes('/raw-material-rules')).length, 1);
  }, () => control('/__qa/raw-rules', {}));

  await run('raw-rule-loss-retained-read-recovery', async () => {
    let form = await ruleForm(); const handle = await getPage().locator('html').elementHandle(); await requiredRule(form);
    await control('/__qa/config', { rules: [{ method: 'PUT', path: base + '/raw-material-rules', dropResponse: true, once: true }] }); await button('Tasdiqlash va saqlash', form).click();
    await button('Server holatini tekshirish', form).waitFor(); assert.equal(await form.getByLabel('Canonical apparat', { exact: true }).isDisabled(), true);
    await button('Yopish', form).click(); await button('Xomashyo qoidalari').click(); form = dialog('Xomashyo qoidalari'); await button('Server holatini tekshirish', form).waitFor();
    assert.equal(await getPage().evaluate(original => original === document.documentElement, handle), true); await online();
    await (await enabled(button('Server holatini tekshirish', form))).click(); await form.getByText('Qoidaning joriy qiymatlari server o‘qishida tasdiqlandi.', { exact: true }).waitFor();
    assert.equal((await writes('/raw-material-rules')).length, 1); assert.equal((await control('/__qa/canonical-apparatus', { apparatus_id: apparatusIds.print })).revision.revision_metadata.revision, 2); await handle.dispose(); await screenshot('observed-rule');
  }, () => control('/__qa/raw-rules', {}));

  await run('raw-rule-stale-review-and-strict-permission', async () => {
    const form = await ruleForm(); await requiredRule(form); await control('/__qa/apparatus', { apparatus_id: apparatusIds.print, profilePatch: { display: { display_name: 'QA Concurrent rule profile', description: 'Synthetic', catalog_order: 10 } } });
    await button('Tasdiqlash va saqlash', form).click(); await form.getByText(/Apparat revision’i o‘zgargan/).waitFor(); assert.equal((await writes('/raw-material-rules')).length, 0);
    await button('Yopish', form).click(); await control('/__qa/config', { capabilities: ['admin.access', 'production.map.manage', 'raw_material.assign'] });
    await open('/kirish'); await getPage().getByLabel('Server manzili').fill(ctx.apiOrigin); await getPage().getByLabel('Telefon raqami').fill(ctx.fixtureLogin.phone); await getPage().getByLabel('Kirish kodi', { exact: true }).fill(ctx.fixtureLogin.code); await button('Kirish').click(); await getPage().waitForURL(/\/app\/home$/);
    await open('/app/raw-materials'); assert.equal(await button('Xomashyo qoidalari').count(), 0); assert.equal((await writes('/raw-material-rules')).length, 0);
  }, () => control('/__qa/raw-rules', {}));

  await run('passport-native-correction-and-offline-label', async () => {
    const form = await passport(), before = (await state()).wip.find(row => row.batch_id === 'qa-wip-1'), review = await correct(form);
    await button('Tasdiqlash va correctionni saqlash', review).click(); await getPage().getByText('Rulon correctioni saqlandi.', { exact: true }).waitFor(); await review.waitFor({ state: 'hidden' }); await form.getByText('Revision 2', { exact: true }).waitFor();
    const saved = (await state()).wip.find(row => row.batch_id === before.batch_id); assert.equal(saved.finished_goods_kg, 30); assert.equal(saved.payload_json.gross_qty, 30); assert.deepEqual(saved.payload_json.start_resources, before.payload_json.start_resources);
    const audit = (await state()).passportCorrections[0]; assert.deepEqual(audit.old_values, before); assert.deepEqual(audit.new_values, saved); assert.equal(audit.actor.ref, 'qa-admin');
    const label = await labelReview(form); await button('Tasdiqlash va topshiriqni tayyorlash', label).click(); await getPage().getByText('Offline yorliq topshirig‘i tayyorlandi. USB bosma bajarilmadi.', { exact: true }).waitFor();
    await label.waitFor({ state: 'hidden' }); await getPage().getByText('prepared · client_usb_pending', { exact: true }).waitFor(); assert.equal(await getPage().getByText('Server printer bosmasini tasdiqladi.', { exact: true }).count(), 0);
    assert.equal((await writes('/progress-qr/correct')).length, 1); assert.equal((await writes('/progress-qr/reprint')).length, 1); assert.deepEqual((await state()).wip.find(row => row.batch_id === saved.batch_id), saved); await screenshot('saved-label-prepared');
  }, () => control('/__qa/passport', { scenario: 'own' }));

  await run('passport-correction-loss-read-audit-no-replay', async () => {
    let form = await passport(); const handle = await getPage().locator('html').elementHandle(), review = await correct(form);
    await control('/__qa/config', { rules: [{ method: 'POST', path: pm + '/progress-qr/correct', dropResponse: true, once: true }] }); await button('Tasdiqlash va correctionni saqlash', review).click();
    await review.getByText('So‘rov takrorlanmaydi. Bu oynani yopib, pasportdagi tekshirish amalidan foydalaning.', { exact: true }).waitFor(); await button('Yopish', review).click();
    await button('Saqlangan rulonni tekshirish', form).waitFor(); await button('Close', form).click(); await button('Rulon pasportini ochish').click(); form = dialog('Saqlangan rulon pasporti');
    await button('Saqlangan rulonni tekshirish', form).waitFor(); assert.equal(await getPage().evaluate(original => original === document.documentElement, handle), true); await online();
    await (await enabled(button('Saqlangan rulonni tekshirish', form))).click(); await getPage().getByText('Correction audit yozuvi serverda tasdiqlandi.', { exact: true }).waitFor();
    assert.equal((await writes('/progress-qr/correct')).length, 1); assert.equal((await state()).passportCorrections.length, 1); assert.equal((await state()).wip[0].revision, 2); await handle.dispose();
  }, () => control('/__qa/passport', { scenario: 'own' }));

  await run('passport-foreign-and-used-correction-locked', async () => {
    let form = await passport(); await form.getByText(/Admin roli egalikni almashtirmaydi/).waitFor(); assert.equal(await button('Pasportni tahrirlash', form).isDisabled(), true); assert.equal((await writes('/progress-qr/correct')).length, 0);
    await control('/__qa/passport', { scenario: 'used' }); await button('Pasportni yangilash', form).click(); await form.getByText(/Ishlatilgan, almashtirilgan yoki kutmayotgan rulon/).waitFor();
    assert.equal(await button('Pasportni tahrirlash', form).isDisabled(), true); assert.equal((await writes('/progress-qr/correct')).length, 0);
  }, () => control('/__qa/passport', { scenario: 'foreign' }));

  await run('passport-opening-saved-label-separate-store', async () => {
    const create = await openingForm(1); await button('Qabulni tasdiqlash', create).click(); await button('Yangi qabulni boshlash', create).waitFor(); const saved = (await state()).openingWip[0]; await button('Yopish', create).click();
    const form = await passport('/app/opening-wip?status=all&selected=' + encodeURIComponent(saved.batches[0].batch_id)); assert.equal(await button('Pasportni tahrirlash', form).count(), 0);
    const label = await labelReview(form); await button('Tasdiqlash va topshiriqni tayyorlash', label).click(); await getPage().getByText('Offline yorliq topshirig‘i tayyorlandi. USB bosma bajarilmadi.', { exact: true }).waitFor();
    await getPage().getByText('prepared · client_usb_pending', { exact: true }).waitFor(); assert.deepEqual((await state()).openingWip[0], saved); assert.equal((await writes('/opening-wip/print')).length, 1); assert.equal((await writes('/progress-qr/correct')).length, 0); assert.equal((await writes('/progress-qr/reprint')).length, 0);
  });

  await run('passport-label-loss-retained-physical-unknown', async () => {
    const form = await passport(), before = (await state()).wip[0], review = await labelReview(form);
    await control('/__qa/config', { rules: [{ method: 'POST', path: pm + '/progress-qr/reprint', dropResponse: true, once: true }] }); await button('Tasdiqlash va topshiriqni tayyorlash', review).click();
    await review.getByText('So‘rov takrorlanmaydi. Bu oynani yopib, pasportdagi tekshirish amalidan foydalaning.', { exact: true }).waitFor(); await button('Yopish', review).click(); await online();
    await (await enabled(button('Saqlangan rulonni tekshirish', form))).click(); await form.getByText(/API fizik bosma holatini o‘qimaydi/).waitFor(); assert.equal(await button('Noma’lum bosma holatini yopish', form).isDisabled(), true);
    assert.equal((await writes('/progress-qr/reprint')).length, 1); assert.deepEqual((await state()).wip[0], before); assert.equal((await state()).passportPrintAttempts[0].physicalPrintConfirmed, false);
    assert.equal(await getPage().getByText('Offline yorliq topshirig‘i tayyorlandi. USB bosma bajarilmadi.', { exact: true }).count(), 0); await screenshot('physical-print-unknown');
  }, () => control('/__qa/passport', { scenario: 'own' }));

  await run('completion-print-native-paint-output', async () => {
    const { form, controls } = await completionForm(); await printFields(form); await button('Hisobotni tekshirish', form).click(); await button('Hisobotni saqlash', form).click(); await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).waitFor();
    const data = await state(), session = data.assignmentSessions.find(row => row.session_id.startsWith('qa-completion-session')); assert.equal(session.status, 'completed'); assert.equal(session.payload_json.return_ink_kg, 3); assert.equal(session.payload_json.total_waste, 2);
    const outputs = data.wip.filter(row => row.batch_id.startsWith('qa-completion-output')); assert.equal(outputs.length, 1); assert.equal(outputs[0].finished_goods_kg, 30); assert.equal(outputs[0].finished_goods_meter, 1000); assert.equal(outputs[0].revision, 1);
    await controls.getByText(/client_usb_pending fizik bosma tasdig‘i emas/).waitFor(); const log = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/queue-action'), 1); assert.equal(Object.hasOwn(log[0].body, 'idempotency_key'), false); assert.equal(Object.hasOwn(log[0].body, 'expected_revision'), false); await screenshot('native-print-completion');
  }, () => control('/__qa/completion', { scenario: 'print' }));

  await run('completion-print-zero-approval-no-output', async () => {
    const { form, controls } = await completionForm(); await printFields(form, '0'); await button('Hisobotni tekshirish', form).click(); await button('Tasdiqlash so‘rovini yuborish', form).click(); await controls.getByText('Tasdiqlash kutilmoqda', { exact: true }).waitFor();
    const data = await state(); assert.equal(data.completionRequests.length, 1); assert.deepEqual(data.completionRequests[0].zero_metric_codes, ['total_waste']); assert.equal(data.orders[0].stages.print, 'paused'); assert.equal(data.wip.filter(row => row.batch_id.startsWith('qa-completion-output')).length, 0);
    assert.equal(await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).count(), 0); assert.equal((await writes('/queue-action')).length, 1);
  }, () => control('/__qa/completion', { scenario: 'print' }));

  await run('completion-print-closing-existing-output-no-new-roll', async () => {
    const { form, controls } = await completionForm('print', true), before = (await state()).wip;
    assert.equal(await form.getByLabel('Rulon uzunligi, m', { exact: true }).count(), 0);
    await form.getByLabel('Umumiy chiqindi, kg', { exact: true }).fill('0'); await form.locator('#completion-description').fill('QA Close saved output');
    for (let index = 0; index < 6; index++) { await form.locator('#paint-name-' + index).fill('QA Paint ' + index); await form.locator('#paint-label-' + index).fill('kg'); await form.locator('#paint-value-' + index).fill('0'); }
    await button('Hisobotni tekshirish', form).click(); await button('Hisobotni saqlash', form).click(); await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).waitFor();
    const data = await state(); assert.deepEqual(data.wip, before); assert.equal(data.completionRequests.length, 0); const session = data.assignmentSessions.find(row => row.session_id.startsWith('qa-completion-session'));
    assert.equal(session.payload_json.complete_without_output, true); assert.equal(session.payload_json.closing_output_batch_id, 'qa-closing-output'); assert.equal(session.payload_json.return_ink_kg, 0);
    const log = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/queue-action'), 1); assert.equal(log[0].body.progress_batch_id, 'qa-closing-output'); assert.equal(Object.hasOwn(log[0].body, 'finished_goods_meter'), false);
  }, () => control('/__qa/completion', { scenario: 'print-closing' }));

  await run('completion-print-loss-retained-unkeyed-shared-lock', async () => {
    let { form, controls } = await completionForm(); const handle = await getPage().locator('html').elementHandle(); await printFields(form); await button('Hisobotni tekshirish', form).click();
    await control('/__qa/config', { rules: [{ method: 'POST', path: pm + '/queue-action', dropResponse: true, once: true }] }); await button('Hisobotni saqlash', form).click(); await controls.getByText('Tugatish hisoboti natijasi noaniq', { exact: true }).waitFor();
    assert.equal(await button('Aynan shu hisobotni tiklash', controls).count(), 0); const legacy = getPage().getByRole('region', { name: 'Buyurtma va apparat navbatini boshqarish' }); assert.equal(await button('Muzlatish', legacy).isDisabled(), true);
    await button('Yangilash', controls).click(); await controls.getByText('Tugatish hisoboti natijasi noaniq', { exact: true }).waitFor(); await reopenOrderAssignment(controls);
    controls = getPage().getByRole('region', { name: 'Bosqichni tugatish hisoboti', exact: true }); await controls.getByText('Tugatish hisoboti natijasi noaniq', { exact: true }).waitFor();
    assert.equal(await getPage().evaluate(original => original === document.documentElement, handle), true); assert.equal(await button('Aynan shu hisobotni tiklash', controls).count(), 0);
    assert.equal((await state()).wip.filter(row => row.batch_id.startsWith('qa-completion-output')).length, 1); assert.equal((await writes('/queue-action')).length, 1); assert.equal(await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).count(), 0); await handle.dispose();
  }, () => control('/__qa/completion', { scenario: 'print' }));

  await run('completion-laminate-loss-immutable-keyed-read', async () => {
    const { form, controls } = await completionForm('laminate'); await layerFields(form); await button('Hisobotni tekshirish', form).click();
    await control('/__qa/config', { rules: [{ method: 'POST', path: pm + '/laminatsiya-astatka', dropResponse: true, once: true }] }); await button('Hisobotni saqlash', form).click(); await button('Aynan shu hisobotni tiklash', controls).waitFor();
    const legacy = getPage().getByRole('region', { name: 'Buyurtma va apparat navbatini boshqarish' }); assert.equal(await button('Muzlatish', legacy).isDisabled(), true);
    await online(); await (await enabled(button('Aynan shu hisobotni tiklash', controls))).click(); await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).waitFor();
    const data = await state(), commands = Object.values(data.completionCommands); assert.equal(commands.length, 1); assert.equal(commands[0].receipt.remainders.length, 2); assert.equal(commands[0].receipt.remainders[0].qr_payload, ''); assert.ok(commands[0].receipt.remainders[1].qr_payload); assert.equal(Object.hasOwn(commands[0].body, 'bobina_kg'), false);
    assert.equal((await writes('/laminatsiya-astatka')).length, 1); const log = (await control('/__qa/log')).requests; assert.ok(log.some(row => row.method === 'GET' && row.path.endsWith('/laminatsiya-astatka') && row.query.request_id === commands[0].body.request_id));
    await controls.getByText(/Ushbu javobda yorliq\/printer holati tasdiqlanmagan/).waitFor(); await screenshot('immutable-layer-receipt');
  }, () => control('/__qa/completion', { scenario: 'laminate' }));

  await run('completion-laminate-foreign-owner-blocked', async () => {
    const { form } = await completionForm('laminate'); await layerFields(form); await button('Hisobotni tekshirish', form).click(); await form.getByText(/Admin roli sessiya egaligini almashtirmaydi/).waitFor(); assert.equal((await writes('/laminatsiya-astatka')).length, 0); assert.equal((await state()).assignmentSessions[0].status, 'active');
  }, () => control('/__qa/completion', { scenario: 'laminate', owner: 'qa-worker-1' }));

  await run('completion-cut-saved-and-issue-slots', async () => {
    const { form, controls } = await completionForm('cut'), scope = (await state()).completionFixture, before = (await state()).wip.length;
    for (const suffix of ['metres', 'grossKg', 'tareKg', 'diameter']) assert.equal(await form.locator('#completion-frame-0-' + suffix).isDisabled(), true);
    await form.locator('#completion-frame-1-issue').fill('QA Damaged slot'); await form.getByLabel('Umumiy chiqindi, kg', { exact: true }).fill('2'); await button('Hisobotni tekshirish', form).click(); await button('Hisobotni saqlash', form).click(); await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).waitFor();
    const data = await state(); assert.equal(data.wip.length, before); const log = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/queue-action'), 1); assert.deepEqual(log[0].body.rezka_frames[0], scope.saved[0].input); assert.deepEqual(log[0].body.rezka_frames[1], { issue_note: 'QA Damaged slot' });
    const session = data.assignmentSessions.find(row => row.session_id === scope.sessionId); assert.equal(session.payload_json.rezka_frame_issues[0].frame_index, 2); assert.deepEqual(session.payload_json.rezka_output_report, []);
  }, () => control('/__qa/completion', { scenario: 'cut-saved' }));

  await run('completion-cut-real-one-based-output', async () => {
    const { form, controls } = await completionForm('cut');
    for (let index = 0; index < 2; index++) for (const [key, value] of [['metres', '100'], ['grossKg', '10'], ['tareKg', '1'], ['diameter', '30']]) await form.locator('#completion-frame-' + index + '-' + key).fill(value);
    await form.getByLabel('Umumiy chiqindi, kg', { exact: true }).fill('2'); await button('Hisobotni tekshirish', form).click(); await button('Hisobotni saqlash', form).click(); await controls.getByText('Bosqich hisoboti saqlandi', { exact: true }).waitFor();
    const data = await state(), outputs = data.wip.filter(row => row.batch_id.startsWith('qa-completion-output')); assert.equal(outputs.length, 2); assert.deepEqual(outputs.map(row => row.payload_json.rezka_frame_index), [1, 2]); assert.ok(outputs.every(row => row.parent_batch_id === 'qa-completion-input' && row.payload_json.rezka_frame_count === 2)); assert.equal(new Set(outputs.map(row => row.qr_payload)).size, 2);
    assert.equal(data.wip.find(row => row.batch_id === 'qa-completion-input').wip_status, 'processed'); assert.equal((await writes('/queue-action')).length, 1);
  }, () => control('/__qa/completion', { scenario: 'cut' }));

  await run('material-delivery-native-custody-audit', async () => {
    const form = await intakeForm('QA-ROLL-2'), before = (await state()).assets.find(row => row.asset_ref === 'qa-roll-2');
    await choose('Olib kelgan xodim', /^QA Material mas’uli ·/, form); await (await enabled(button('Yetkazishni qayd etish', form))).click(); await button('Tasdiqlash va qabul qilish', form).click();
    await form.getByText('Yetkazish qaydi va rulonning apparat oldidagi tayyorligi serverda tasdiqlandi.', { exact: true }).waitFor();
    const data = await state(), asset = data.assets.find(row => row.asset_ref === before.asset_ref); assert.equal(asset.qty, before.qty); assert.equal(asset.custody_warehouse, before.custody_warehouse); assert.equal(asset.status, 'available'); assert.equal(asset.physical_location.id, 'qa-location-print');
    const events = data.rawHistory.filter(row => row.event_type === 'delivery_received'); assert.equal(events.length, 1); assert.equal(events[0].actor_ref, 'qa-admin'); assert.equal(events[0].payload_json.delivered_by.ref, 'QA-MATERIAL-1'); assert.equal(events[0].qty_delta, 0);
    const log = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/raw-material-start-receipt'), 1); assert.equal(events[0].source_id, log[0].body.idempotency_key); assert.deepEqual(Object.keys(log[0].body).sort(), ['apparatus', 'barcode', 'delivered_by_ref', 'delivered_by_role', 'idempotency_key', 'order_id']);
  }, () => control('/__qa/material-intake', { scenario: 'delivery' }));

  await run('material-delivery-loss-historical-key-read', async () => {
    let form = await intakeForm('QA-ROLL-2'); const handle = await getPage().locator('html').elementHandle(); await choose('Olib kelgan xodim', /^QA Material mas’uli ·/, form); await (await enabled(button('Yetkazishni qayd etish', form))).click();
    await control('/__qa/config', { rules: [{ method: 'POST', path: base + '/raw-material-start-receipt', dropResponse: true, once: true }] }); await button('Tasdiqlash va qabul qilish', form).click(); await button('Serverdagi qabulni tekshirish', form).waitFor();
    await button('Yopish', form).click(); await button('Material qabul qilish').click(); form = dialog('Material qabul qilish'); await button('Serverdagi qabulni tekshirish', form).waitFor(); assert.equal(await getPage().evaluate(original => original === document.documentElement, handle), true);
    await control('/__qa/order', { id: orderId, control: 'frozen' }); await online(); await (await enabled(button('Serverdagi qabulni tekshirish', form))).click();
    await form.getByText('Aynan avvalgi yetkazish qaydi serverda tasdiqlandi. Joriy material holatini yangilang.', { exact: true }).waitFor(); assert.equal((await writes('/raw-material-start-receipt')).length, 1); assert.equal((await state()).rawHistory.filter(row => row.event_type === 'delivery_received').length, 1);
    const reads = (await control('/__qa/log')).requests.filter(row => row.method === 'GET' && row.path.endsWith('/raw-material-history')); assert.ok(reads.some(row => row.query.event_type === 'delivery_received' && row.query.limit === '200' && row.query.warehouse === 'QA Xomashyo')); await handle.dispose();
  }, () => control('/__qa/material-intake', { scenario: 'delivery' }));

  await run('material-intake-loss-observation-no-replay-shared-lock', async () => {
    const form = await intakeForm(), before = (await state()).assets.find(row => row.asset_ref === 'qa-roll-1'); await (await enabled(button('Qo‘shimcha materialni qabul qilish', form))).click();
    await control('/__qa/config', { rules: [{ method: 'POST', path: base + '/raw-material-intake', dropResponse: true, once: true }] }); await button('Tasdiqlash va qabul qilish', form).click(); await button('Serverdagi qabulni tekshirish', form).waitFor();
    assert.equal(await button('Avvalgi yetkazishni ko‘rib chiqish', form).count(), 0); await button('Yopish', form).click(); const legacy = getPage().getByRole('region', { name: 'Buyurtma va apparat navbatini boshqarish' }); assert.equal(await button('Muzlatish', legacy).isDisabled(), true);
    await button('Material qabul qilish').click(); const retained = dialog('Material qabul qilish'); await online(); await (await enabled(button('Serverdagi qabulni tekshirish', retained))).click(); await retained.getByText('Aynan shu rulonning joriy qabul holati serverda tasdiqlandi. Amal qayta yuborilmadi.', { exact: true }).waitFor();
    const asset = (await state()).assets.find(row => row.asset_ref === before.asset_ref); assert.equal(asset.status, 'in_use'); assert.equal(asset.reserved_order_id, orderId); assert.equal(asset.qty, before.qty); assert.equal(asset.custody_warehouse, before.custody_warehouse);
    const log = await waitRequests(row => row.method === 'POST' && row.path.endsWith('/raw-material-intake'), 1); assert.deepEqual(Object.keys(log[0].body).sort(), ['apparatus', 'barcode', 'order_id']); assert.equal(await button('Avvalgi yetkazishni aynan yuborish', retained).count(), 0); await screenshot('intake-observed');
  }, async () => { await control('/__qa/material-intake', { scenario: 'intake' }); await control('/__qa/config', { assignedApparatus: [apparatusIds.print] }); });

  await run('material-intake-scope-and-repeated-stage-blocked', async () => {
    let form = await intakeForm(); await form.getByText(/Qo‘shimcha qabul uchun bu apparat sessiyaning haqiqiy biriktirish doirasida bo‘lishi kerak/).waitFor(); assert.equal(await button('Qo‘shimcha materialni qabul qilish', form).count(), 0);
    await control('/__qa/material-intake', { scenario: 'repeated' }); await orderAssignment(); await button('Material qabul qilish').click(); form = dialog('Material qabul qilish');
    await form.getByText(/Uskuna bir nechta bosqichda takrorlangan/).waitFor(); assert.equal(await button('Qo‘shimcha materialni qabul qilish', form).count(), 0); assert.equal(await button('Yetkazishni qayd etish', form).count(), 0);
    assert.equal((await writes('/raw-material-intake')).length, 0); assert.equal((await writes('/raw-material-start-receipt')).length, 0);
  }, () => control('/__qa/material-intake', { scenario: 'intake' }));
}
