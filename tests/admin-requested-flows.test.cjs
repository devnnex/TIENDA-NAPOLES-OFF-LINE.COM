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

test('Turno configurado local o remoto evita el modal al refrescar; sin turno abre una vez', async () => {
  const shift = { date: '2026-10-09', startMinutes: 900, endMinutes: 60, base: 100000 };
  for (const [cached, remote, expected] of [[shift, shift, 0], [shift, null, 0], [null, shift, 0], [null, null, 1]]) {
    const state = {};
    let prompts = 0;
    const context = vm.createContext({ state, SalesShift, canAccessAdminSection: () => true,
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
  const fieldValues = { edit_payment_cash: { value: 0 }, edit_payment_transfer: { value: 4000 }, edit_payment_breb: { value: 6000 } };
  const form = { sale_id: { value: 'sale-1' }, payment_method: { value: 'mixed' }, date: { value: '2026-10-09T12:00' },
    table: { value: 'M1' }, payer: { value: '' }, waiter: { value: '' }, reference: { value: '' },
    elements: { namedItem: name => fieldValues[name] }, querySelector: () => ({ disabled: false }) };
  const state = { incomeReport: { records: [record] }, invoiceHistory: [{ id: 'sale-1' }] };
  const sent = [], errors = [];
  const context = vm.createContext({ state, isBoss: () => true, $$: () => [row], uid: () => 'line-1',
    currencyInputNumber: input => Number(input.value), toast: (message, kind) => { if (kind === 'error') errors.push(message); },
    appsScriptRequest: async (action, payload) => { sent.push(payload.invoice); return { ok: true }; },
    readAppsScriptOutbox: () => [], enqueueAppsScriptJob: (action, payload) => sent.push(payload.invoice),
    persistInvoiceHistory() {}, loadIncomeReport: async () => {}, renderIncomeReport() {}, $: () => ({ close() {} }) });
  vm.runInContext(section('saveIncomeEdit', 'exportIncomeCsv') + ';globalThis.save = saveIncomeEdit;', context);
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
