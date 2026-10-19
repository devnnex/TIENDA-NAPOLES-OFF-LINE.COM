const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const SalesShift = require('../sales-shift.js');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (start, end) => {
  const from = source.indexOf('  const ' + start + ' =');
  const to = source.indexOf('  const ' + end + ' =', from + 1);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};

test('La alarma conserva la preferencia si el navegador bloquea audio y reintenta con clic', async () => {
  const values = new Map();
  const state = { soundEnabled: true };
  const listeners = {};
  let plays = 0, blocked = true;
  const audio = { play: async () => { plays++; if (blocked) throw Error('NotAllowedError'); }, pause() {} };
  const context = vm.createContext({ state, localStorage: { setItem: (key, value) => values.set(key, value) },
    document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    getAlarmAudio: () => audio, updateAlarmButton() {}, toast() {}, activeRequests: () => [],
    window: { setTimeout() {} } });
  vm.runInContext(section('unlockAlarm', 'startAlarmLoop') + ';globalThis.arm = armAlarmOnFirstGesture;', context);
  context.arm();
  await listeners.mousemove();
  assert.equal(state.soundEnabled, true);
  assert.equal(state.soundPrimed, false);
  assert.equal(values.get('waiter_alarm_enabled'), '1');
  blocked = false;
  await listeners.pointerdown();
  assert.equal(state.soundPrimed, true);
  assert.equal(plays, 2);
  await listeners.pointerdown();
  assert.equal(plays, 2, 'No reproduce otro sonido después de desbloquearse.');
  assert.match(source, /state\.soundEnabled = localStorage\.getItem\("waiter_alarm_enabled"\) !== "0"/);
});

test('Al iniciar sesión solicita el nuevo turno tras el cierre y lo recuerda solo en esa sesión', async () => {
  const expired = { date: '2026-10-09', startMinutes: 900, endMinutes: 60, base: 100000 };
  const active = { ...expired, date: '2026-10-10', endMinutes: 660 };
  const now = new Date('2026-10-10T13:00:00-05:00');
  const FixedDate = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } };
  for (const [cached, remote, expected] of [[expired, expired, 1], [expired, active, 0], [null, active, 0], [null, null, 1]]) {
    const state = {};
    let prompts = 0;
    const context = vm.createContext({ state, SalesShift, Date: FixedDate, canAccessAdminSection: () => true,
      salesShiftStorageKey: () => 'shift', localStorage: { getItem: () => JSON.stringify({ shift: cached }) },
      readLocalJson: () => ({ shift: cached }), renderSalesShift() {},
      syncSalesShift: async () => { state.salesShift = remote; }, openSalesShift: () => prompts++,
      window: { clearInterval() {}, setInterval() {}, addEventListener() {} } });
    vm.runInContext(section('startSalesShift', 'incomeRangeDates') + ';globalThis.start = startSalesShift;', context);
    context.start();
    await new Promise(setImmediate);
    assert.equal(prompts, expected);
    context.start();
    await new Promise(setImmediate);
    assert.equal(prompts, expected);
  }
});

test('Un turno seleccionado no vuelve a consultar ventas hasta que cambia su horario', () => {
  const state = { incomeRangePreset: 'today', selectedSalesShiftId: 'shift-1', activeAdminSection: 'income' };
  const fields = { '#incomeDateFrom': { value: '' }, '#incomeDateTo': { value: '' } };
  let loads = 0, endAt = '2026-10-11T07:00:00.000Z';
  const range = () => ({ dateFrom: '2026-10-10', dateTo: '2026-10-11', startAt: '2026-10-10T16:00:00.000Z', endAt, shiftId: 'shift-1' });
  const context = vm.createContext({ state, incomeRangeDates: range, renderSalesShift() {}, markIncomeRangePreset() {},
    loadIncomeReport: () => { loads++; }, $: selector => fields[selector],
    window: { clearTimeout() {}, setTimeout() { return 1; } }, Date });
  vm.runInContext(section('refreshSalesShiftRange', 'syncSalesShift') + section('setIncomeRange', 'incomeFiltersFromForm')
    + ';globalThis.select = setIncomeRange; globalThis.refresh = refreshSalesShiftRange;', context);
  context.select('shift');
  context.refresh();
  context.refresh();
  assert.equal(loads, 1, 'La selección hace una sola consulta inicial.');
  endAt = '2026-10-11T08:00:00.000Z';
  context.refresh();
  context.refresh();
  assert.equal(loads, 2, 'Un cambio real de horario hace una sola consulta adicional.');
});

test('Sin cambios remotos, la sincronización conserva el selector y el cuadro del turno', () => {
  const shift = { id: 'shift-1', date: '2026-10-10', startMinutes: 660, endMinutes: 120,
    base: 250000, initialBase: 250000, updatedAt: '2026-10-11T05:42:00Z' };
  const state = { salesShift: shift, salesShiftHistory: [shift], incomeRangePreset: 'shift', selectedSalesShiftId: shift.id };
  let summaryWrites = 0, optionWrites = 0, iconRefreshes = 0;
  const button = { set innerHTML(value) { summaryWrites++; } };
  const history = { value: '', set innerHTML(value) { optionWrites++; } };
  const edit = { disabled: true };
  const register = { hidden: true };
  const now = new Date('2026-10-11T08:00:00-05:00');
  const FixedDate = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } };
  const context = vm.createContext({ state, SalesShift, Date: FixedDate, icon: () => '<svg></svg>', money: value => String(value),
    escapeHTML: value => String(value), formatIncomeDate: value => String(value), refreshIcons: () => iconRefreshes++,
    $: selector => ({ '#salesShiftBase': button, '#registerSalesShift': register, '#salesShiftHistory': history, '#editSalesShiftHistory': edit })[selector] });
  vm.runInContext(section('renderSalesShift', 'refreshSalesShiftRange') + ';globalThis.render = renderSalesShift;', context);
  context.render();
  context.render();
  assert.equal(summaryWrites, 1);
  assert.equal(optionWrites, 1);
  assert.equal(iconRefreshes, 1);
  assert.equal(history.value, shift.id);
  assert.equal(edit.disabled, false);
  assert.equal(register.hidden, false, 'El botón sigue disponible si se cerró el modal sin registrar.');
  state.salesShift = { ...shift, date: '2026-10-11' };
  context.render();
  assert.equal(register.hidden, true, 'Al registrar el turno nuevo, el botón desaparece.');
});

test('Un informe de turno conserva el contenido al verificarse otra vez y muestra cambios reales', () => {
  const state = { incomeRangePreset: 'shift', incomeVisibleCount: 60, incomeReport: {
    filters: { dateFrom: '2026-10-10', dateTo: '2026-10-11', paymentMethod: 'all', saleType: 'all' },
    totals: { income: 0, profit: 0, cost: 0 }, records: [], totalRecords: 0, localOnly: false
  } };
  let writes = 0, statuses = 0;
  const fields = Object.fromEntries(['#incomeKpis', '#incomePaymentBreakdown', '#incomeRecords', '#incomeFilterSummary']
    .map(key => [key, { set innerHTML(value) { writes++; } }]));
  const context = vm.createContext({ state, $: selector => fields[selector], renderSalesShift() {},
    icon: () => '', money: String, escapeHTML: String, emptyState: () => 'Sin ventas',
    incomeSaleTypeLabel: () => 'Todas', refreshIcons() {}, setIncomeReportStatus() { statuses++; } });
  vm.runInContext(section('renderIncomeReport', 'loadIncomeReport') + ';globalThis.render = renderIncomeReport;', context);
  context.render();
  assert.equal(writes, 4);
  state.incomeReport = { ...state.incomeReport, generatedAt: '2026-10-11T15:00:00Z' };
  context.render();
  assert.equal(writes, 4, 'La verificación remota conserva el DOM y los detalles abiertos.');
  assert.equal(state.incomeRenderedReport, state.incomeReport);
  state.incomeReport = { ...state.incomeReport, totals: { income: 100, profit: 50, cost: 50 } };
  context.render();
  assert.equal(writes, 8, 'Los nuevos importes sí se muestran.');
  state.incomeReport = { ...state.incomeReport, localOnly: true };
  context.render();
  assert.equal(statuses, 3, 'El estado sin conexión también se actualiza.');
});

test('La corrección offline conserva el turno vigente y guarda historial y operación pendientes', async () => {
  const previous = { id: 'past-shift', date: '2026-10-09', startMinutes: 900, endMinutes: 60, base: 100000, initialBase: 100000, version: 1 };
  const current = { ...previous, id: 'current-shift', date: '2026-10-10' };
  const state = { salesShift: current, salesShiftFormSnapshot: previous, salesShiftHistory: [previous, current] };
  const submit = { disabled: false }, error = { textContent: '' };
  const values = { action: { value: 'edit' }, amount: { value: '100000' }, date: { value: '2026-10-09' },
    start_time: { value: '11' }, start_period: { value: 'AM' }, end_time: { value: '2' }, end_period: { value: 'AM' } };
  const form = { elements: { namedItem: name => values[name] }, querySelector: () => submit };
  let durable;
  const context = vm.createContext({ state, SalesShift, SUPABASE_CONFIG: { url: 'test-project' },
    persistDurableJson: async (key, value) => { durable = JSON.parse(JSON.stringify(value)); return true; },
    $: selector => ({ '#salesShiftError': error, '#salesShiftDialog': { close() {} } })[selector],
    uid: () => 'correction-operation', currencyInputNumber: input => Number(input.value),
    refreshSalesShiftRange() {}, syncSalesShift: async () => false });
  vm.runInContext(section('salesShiftStorageKey', 'renderSalesShift') + section('saveSalesShift', 'bindSalesShift')
    + ';globalThis.save = saveSalesShift;', context);
  await context.save(form);
  assert.equal(error.textContent, '');
  assert.equal(durable.shift.id, current.id);
  assert.equal(durable.pending.action, 'edit');
  assert.equal(durable.pending.expectedId, previous.id);
  assert.equal(durable.shifts[0].startMinutes, 660);
  assert.equal(durable.shifts[0].endMinutes, 120);
  assert.equal(durable.shifts[0].base, previous.base);
  assert.equal(durable.shifts[0].version, 2);
  assert.equal(durable.shifts[1].id, current.id);
});

test('Aviso de solicitud lee la fila confirmada y la muestra aunque el snapshot siga ocupado', async () => {
  const state = { authToken: 'staff', adminSyncBusy: true, tables: [{ id: 'table-1' }], requests: [] };
  let renders = 0, saved = [];
  const completed = new Set();
  const row = { id: 'request-1', table_id: 'table-1', status: 'pending', request_type: 'other', message: 'Hola', created_at: '2026-10-09T15:00:00Z' };
  const context = vm.createContext({ state, rememberCompletedAdminRequests: (ids = []) => { ids.forEach(id => completed.add(id)); return completed; },
    mergeOptimisticRequests: rows => rows, compareRequestArrival: () => 0,
    persistPendingAdminRequests: rows => { saved = rows; }, renderAdminLive: () => renders++,
    readRealtimeData: async query => query });
  state.sb = { from: name => { assert.equal(name, 'service_requests'); return { select: () => ({ in: (key, ids) => {
    assert.equal(key, 'id'); assert.deepEqual(Array.from(ids), ['request-1']); return [row];
  } }) }; } };
  const from = source.indexOf('  const receiveAdminRequests =');
  const to = source.indexOf('  let adminRefreshPending =', from);
  vm.runInContext(source.slice(from, to) + ';globalThis.refresh = refreshAdminRequests;globalThis.receive = receiveAdminRequests;', context);
  const pending = context.refresh(['request-1']);
  assert.equal(renders, 0, 'No muestra información sin confirmar en la base de datos.');
  await pending;
  assert.equal(state.requests[0].message, 'Hola');
  assert.equal(state.requests[0].restaurant_tables.id, 'table-1');
  assert.equal(saved.length, 1);
  assert.equal(renders, 1);
  context.receive([{ ...row, status: 'acknowledged' }]);
  context.receive([row]);
  assert.equal(state.requests[0].status, 'acknowledged', 'Un aviso tardío no reactiva una solicitud atendida.');
});

test('Editar venta guarda los nuevos medios e importes y rechaza un mixto que no suma el total', async () => {
  const record = { saleId: 'sale-1', invoice: 'F1', items: [{ cost: 1000, quantity: 1 }] };
  const lineValues = { name: { value: 'Producto' }, quantity: { value: '1' }, price: { value: 10000 } };
  const row = { dataset: { incomeLine: '0', lineId: 'line-1' }, querySelector: selector => lineValues[selector.match(/"(.+)"/)[1]] };
  const fieldValues = { edit_payment_cash: { value: 0 }, edit_payment_transfer: { value: 4000 }, edit_payment_breb: { value: 6000 }, edit_payment_card: { value: 0 } };
  const form = { sale_id: { value: 'sale-1' }, payment_method: { value: 'mixed' }, date: { value: '2026-10-09T12:00' },
    table: { value: 'M1' }, payer: { value: '' }, waiter: { value: '' }, reference: { value: '' },
    elements: { namedItem: name => fieldValues[name] }, querySelector: () => ({ disabled: false }) };
  const state = { incomeReport: { records: [record] }, invoiceHistory: [{ id: 'sale-1' }] };
  const sent = [], errors = [];
  const context = vm.createContext({ incomeRecordSaleType: () => "table", state, isBoss: () => true, $$: () => [row], uid: () => 'line-1',
    currencyInputNumber: input => Number(input.value), toast: (message, kind) => { if (kind === 'error') errors.push(message); },
    appsScriptRequest: async (action, payload) => { sent.push(payload.invoice); return { ok: true }; },
    readAppsScriptOutbox: () => [], enqueueAppsScriptJob: (action, payload) => sent.push(payload.invoice),
    persistInvoiceHistory() {}, loadIncomeReport: async () => {}, renderIncomeReport() {}, $: () => ({ close() {} }) });
  vm.runInContext(section('incomeTotalsFromRecords', 'localIncomeRecords') + section('replaceEditedIncomeRecord', 'exportIncomeCsv') + ';globalThis.save = saveIncomeEdit;', context);
  await context.save(form);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].payments)), [{ method: 'transfer', amount: 4000 }, { method: 'breb', amount: 6000 }]);
  state.incomeReport = { records: [record] };
  fieldValues.edit_payment_breb.value = 5000;
  await context.save(form);
  assert.equal(sent.length, 1);
  assert.equal(errors.length, 1);
  form.payment_method.value = 'cash';
  await context.save(form);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].payments)), [{ method: 'cash', amount: 10000 }]);
});

test('La factura se dibuja inmediatamente y solicita imprimir en el siguiente cuadro de pantalla', () => {
  const calls = [];
  let ready;
  const popup = { closed: false, document: { open: () => calls.push('open'), write: html => calls.push(html), close: () => calls.push('close') },
    requestAnimationFrame: callback => { ready = callback; }, focus: () => calls.push('focus'), print: () => calls.push('print') };
  const context = vm.createContext({ window: { open: () => popup }, thermalReceiptHtml: () => '<html>Factura completa</html>', toast() {} });
  vm.runInContext(section('printThermalReceipt', 'updateMixedPayment') + ';globalThis.printReceipt = printThermalReceipt;', context);
  assert.equal(context.printReceipt({}, {}), true);
  assert.deepEqual(calls, ['open', '<html>Factura completa</html>', 'close']);
  ready();
  assert.deepEqual(calls.slice(-2), ['focus', 'print']);
  popup.closed = true;
  ready();
  assert.equal(calls.filter(call => call === 'print').length, 1);
});
