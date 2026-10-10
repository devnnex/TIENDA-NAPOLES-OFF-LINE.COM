const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const offline = source.includes('sale-edit:${record.saleId}:${uid()}');
const section = (from, to) => source.slice(source.indexOf('  const ' + from + ' ='), source.indexOf('  const ' + to + ' =', source.indexOf('  const ' + from + ' =') + 1));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function setup() {
  const response = deferred();
  const record = { saleId: 'sale-1', invoice: 'F1', sessionId: 'session-1', date: '2026-10-09T12:00:00Z',
    subtotal: 10000, total: 10000, cost: 1000, profit: 9000, payments: [{ method: 'cash', amount: 10000 }],
    items: [{ quantity: 1, cost: 1000 }] };
  const originalInvoice = { id: 'sale-1', number: 'F1', totals: { total: 10000 } };
  const state = { incomeRequestId: 1, incomeLoading: false, activeAdminSection: 'income', invoiceHistory: [originalInvoice],
    incomeReport: { records: [record], allLocalRecords: [record], filters: {}, totals: {
      income: 35000, sales: 3, subtotal: 35000, cost: 3000, profit: 32000, cash: 35000, averageTicket: 35000 / 3
    } }, syncFresh: {} };
  const values = { name: { value: 'Producto' }, quantity: { value: '2' }, price: { value: 10000 } };
  const row = { dataset: { lineId: 'line-1', incomeLine: '0' }, querySelector: selector => values[selector.match(/"(.+)"/)[1]] };
  const amounts = { edit_payment_cash: { value: 7000 }, edit_payment_transfer: { value: 13000 }, edit_payment_breb: { value: 0 } };
  const form = { sale_id: { value: 'sale-1' }, table: { value: 'M1' }, date: { value: '2026-10-09T12:00' },
    payer: { value: 'Cliente' }, waiter: { value: 'Mesero' }, payment_method: { value: 'mixed' }, reference: { value: '' },
    elements: { namedItem: name => amounts[name] } };
  let closed = 0, rendered = 0, saved = 0, nextId = 0;
  const jobs = [], calls = [], notices = [];
  const context = vm.createContext({ state, isBoss: () => true, $$: () => [row],
    $: selector => selector === '#incomeEditDialog' ? { close() { closed++; } } : {},
    uid: () => 'operation-' + ++nextId, currencyInputNumber: input => Number(input.value),
    persistInvoiceHistory() { saved++; }, renderIncomeReport() { rendered++; },
    toast: (message, kind) => notices.push({ message, kind }),
    appsScriptRequest: (action, payload) => { calls.push({ action, payload }); return response.promise; },
    readAppsScriptOutbox: () => jobs,
    enqueueAppsScriptJob: (action, payload, dedupeKey) => {
      if (!jobs.some(job => job.dedupeKey === dedupeKey)) jobs.push({ action, payload, dedupeKey });
    }, loadIncomeReport: () => new Promise(() => {}) });
  vm.runInContext(section('incomeTotalsFromRecords', 'localIncomeRecords') + section('replaceEditedIncomeRecord', 'exportIncomeCsv') + ';globalThis.save = saveIncomeEdit;', context);
  return { context, state, form, record, originalInvoice, response, jobs, calls, notices, values,
    stats: () => ({ closed, rendered, saved }) };
}

test('La edicion actualiza la venta, sus medios y todos los totales antes de esperar la red', async () => {
  const f = setup();
  const pending = f.context.save(f.form);
  assert.deepEqual(f.stats(), { closed: 1, rendered: 1, saved: 1 });
  assert.equal(f.state.incomeReport.records[0].total, 20000);
  assert.equal(f.state.incomeReport.allLocalRecords[0].total, 20000);
  assert.equal(f.state.incomeReport.totals.income, 45000, 'Conserva ventas fuera de la pagina visible.');
  assert.equal(f.state.incomeReport.totals.cost, 4000);
  assert.equal(f.state.incomeReport.totals.profit, 41000);
  assert.equal(f.state.incomeReport.totals.cash, 32000);
  assert.equal(f.state.incomeReport.totals.transfer, 13000);
  assert.equal(f.state.incomeReport.totals.averageTicket, 15000);
  assert.equal(f.state.incomeRequestId, 2);
  f.response.resolve({ ok: true });
  await pending; // La consulta de fondo nunca resuelve; no bloquea el guardado.
});

test(offline ? 'Dos ediciones rapidas conservan ambas operaciones en la cola' : 'Un rechazo remoto restaura la venta y sus totales e informa del error', async () => {
  const f = setup();
  const pending = f.context.save(f.form);
  if (offline) {
    await pending;
    f.form.payment_method.value = 'breb';
    f.values.quantity.value = '3';
    await f.context.save(f.form);
    assert.equal(f.jobs.length, 2);
    assert.equal(f.jobs[1].payload.invoice.totals.total, 30000);
    assert.equal(f.state.incomeReport.totals.income, 55000);
    assert.equal(f.state.incomeReport.totals.transfer, 0);
    assert.equal(f.state.incomeReport.totals.breb, 30000);
  } else {
    await f.context.save(f.form);
    assert.equal(f.calls.length, 1, 'Evita dos guardados simultaneos de la misma venta.');
    f.response.resolve({ ok: false, error: 'No autorizado' });
    await pending;
    assert.equal(f.state.incomeReport.records[0], f.record);
    assert.equal(f.state.invoiceHistory[0], f.originalInvoice);
    assert.equal(f.state.incomeReport.totals.income, 35000);
    assert.equal(f.state.incomeReport.totals.cash, 35000);
    assert.equal(f.state.incomeReport.totals.transfer, 0);
    assert.ok(f.notices.some(notice => notice.kind === 'error' && notice.message === 'No autorizado'));
    assert.equal(f.state.pendingIncomeEdits.size, 0);
  }
});

test('Una consulta iniciada antes de editar no reemplaza la correccion con datos antiguos', async () => {
  const f = setup(), stale = deferred();
  const filters = { dateFrom: '2026-10-09', dateTo: '2026-10-09' };
  Object.assign(f.context, { canAccessAdminSection: () => true, incomeFiltersFromForm: () => filters,
    clearTimeout() {}, isAppsScriptConfigured: () => true, APPS_SCRIPT_TIMEOUT_MS: 1000,
    navigator: { onLine: true }, readLocalJson: () => null, INCOME_REPORT_CACHE_KEY: 'cache',
    setIncomeReportStatus() {}, localIncomeReport: () => f.state.incomeReport,
    mergeIncomeReport: remote => remote,
    appsScriptRequest: action => action === 'get_income_report' ? stale.promise : f.response.promise });
  vm.runInContext(section('loadIncomeReport', 'refreshBackgroundReports') + ';globalThis.load = loadIncomeReport;', f.context);
  const reading = f.context.load({ background: true, force: true });
  const saving = f.context.save(f.form);
  const editedReport = f.state.incomeReport;
  stale.resolve({ ok: true, revision: 'old', recordRows: [], records: [f.record], totals: {} });
  assert.equal(await reading, false);
  assert.equal(f.state.incomeReport, editedReport);
  assert.equal(f.state.incomeReport.records[0].total, 20000);
  if (!offline) assert.equal(await f.context.load({ background: true }), false, 'Evita lecturas durante el guardado.');
  f.response.resolve({ ok: true });
  await saving;
});

test('La X cierra antes de ocultar la lista del buscador y cambiar el foco', () => {
  const start = source.indexOf('    document.addEventListener("pointerdown", (event) => {\n      if (event.button === 0');
  assert.ok(start >= 0);
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  let handler, cancelled = 0, hidden = 0, prevented = 0;
  vm.runInNewContext(source.slice(start, end), { document: { addEventListener: (_, fn) => { handler = fn; } },
    cancelConsumption() { cancelled++; }, closeWaiterTableOptions() { hidden++; }, closeConsumptionProductOptions() { hidden++; } });
  handler({ button: 0, target: { closest: selector => selector.includes('[data-cancel-consumption]') ? {} : null }, preventDefault() { prevented++; } });
  assert.equal(cancelled, 1);
  assert.equal(hidden, 0);
  assert.equal(prevented, 1);
});

test('El desglose se puede abrir y cerrar en movil, y permanece abierto en escritorio', () => {
  let mobile = true;
  const preview = { hidden: true }, button = { setAttribute(name, value) { this[name] = value; } };
  const context = vm.createContext({ window: { matchMedia: () => ({ matches: mobile }) },
    $: selector => selector === '#tableConsumptionPreview' ? preview : button,
    icon: () => '', refreshIcons() {} });
  vm.runInContext(section('setTableConsumptionPreviewVisible', 'formatConsumptionTimestamp') + ';globalThis.toggle = setTableConsumptionPreviewVisible;', context);
  context.toggle(true);
  assert.equal(preview.hidden, false);
  assert.equal(button['aria-expanded'], 'true');
  context.toggle(false);
  assert.equal(preview.hidden, true);
  assert.match(button.innerHTML, /Ver desglose/);
  mobile = false;
  context.toggle(false);
  assert.equal(preview.hidden, false);
});
