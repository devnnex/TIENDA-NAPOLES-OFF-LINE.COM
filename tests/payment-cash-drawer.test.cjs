const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};

const setup = ({ method = 'cash', validPayment = true, validStock = true, savedLocally = true,
  received = 100, duplicate = false, drawerAccepted = true, beforeDurableSave = null, device = 'bridge', online = true } = {}) => {
  const calls = [];
  const session = { id: 'session-1', table_id: 'table-1', session_items: [
    { id: 'line-1', menu_item_id: 'product-1', item_name: 'Producto', quantity: 1, unit_price: 100, status: 'served' }
  ] };
  const state = { paymentProcessing: false, sessions: [session], invoiceHistory: duplicate ? [{ sessionId: session.id }] : [],
    authToken: 'valid-token', activePaymentTotal: 100, inventoryMeta: {}, localSupabaseWrites: 0, currentUser: { id: 'staff-1' } };
  state.posFeatures = { remote_drawer: true };
  state.sb = { rpc: async (name) => { calls.push(name); return { data: { command: { id: 'remote-command', status: 'accepted' } } }; } };
  const buttons = [{ value: 'save', disabled: false }, { value: 'print', disabled: false }];
  const form = { session_id: { value: session.id }, cash_received: { value: received, focus() {} },
    payment_reference: { value: '' }, querySelector: () => buttons[0] };
  const listeners = {};
  const dialog = { open: true, close() { this.open = false; calls.push('dialog-close'); },
    addEventListener(name, listener) { listeners[name] = listener; } };
  let finishClose;
  const closePromise = new Promise((resolve) => { finishClose = resolve; });
  const popup = { close() { calls.push('popup-close'); } };
  const context = vm.createContext({
    state, console,
    INVENTORY_STORAGE_KEY: 'inventory', INVOICE_STORAGE_KEY: 'invoices',
    INVENTORY_MOVEMENTS_STORAGE_KEY: 'movements', APPS_SCRIPT_OUTBOX_KEY: 'outbox',
    $: (selector) => selector === '#paymentDialog' ? dialog : selector === '#paymentForm' ? form : null,
    $$: () => buttons,
    window: {
      open: () => { calls.push('popup'); return popup; },
      posCashDrawer: device === 'bridge' ? { open: async (request) => {
        assert.equal(request.source, 'tienda-napoles-pos');
        calls.push('drawer'); return drawerAccepted;
      } } : null
    },
    navigator: { userAgent: device === 'mobile' ? 'Android' : 'Windows', onLine: online }, setTimeout: callback => callback(),
    cashDrawerRequest: async () => { if (device === 'controller') return { settings: { printer: 'POS' }, printers: ['POS'] }; throw Error('No local drawer'); },
    sendCashDrawerPulse: async () => { calls.push('drawer'); return true; },
    dbQuiet: async query => (await query).data,
    toast: () => {}, tipsEnabled: () => false,
    paymentFromForm: () => validPayment ? { method, payments: [{ method, amount: state.activePaymentTotal }] } : null,
    currencyInputNumber: (input) => Number(input?.value || 0), integerMoney: (value) => Number(value),
    paidInventoryPlan: () => [], validatePaidInventory: () => validStock,
    sessionTotals: () => ({ subtotal: 100, total: 100 }), uid: () => 'invoice-1',
    sessionReference: () => 'M1', sessionLabel: () => 'Mesa 1',
    applyPaidInventoryLocally: () => {},
    applyInvoiceToInventory: (invoice) => { state.invoiceHistory.push(invoice); calls.push('invoice'); },
    flushDurableWrites: async () => { calls.push('storage'); beforeDurableSave?.(state); return savedLocally; },
    closeSession: () => { calls.push('remote-close'); return closePromise; },
    rollbackLocalPayment: () => { calls.push('rollback'); },
    renderInventory: () => calls.push('render-inventory'), renderInventoryMovements: () => {}, renderIncomeReport: () => {}, renderTips: () => {},
    printThermalReceipt: (paidSession, invoice, receiptWindow) => {
      assert.equal(paidSession.id, session.id);
      assert.equal(invoice.sessionId, session.id);
      assert.equal(receiptWindow, popup);
      calls.push('print');
    },
    paymentMethodLabel: () => method,
    flushAppsScriptOutbox: () => {}
  });
  vm.runInContext(section("  const sessionPayments =", "  const abonoRowsHtml ="), context);
  vm.runInContext(section('  const openLocalCashDrawer =', '  const getAppsScriptUrl =')
    + section('  const bindPaymentConfirmShortcut =', '  const renderConsumptionSelection =')
    + ';globalThis.api = {processPayment, bindPaymentConfirmShortcut, openCashDrawer};', context);
  return { context, state, form, buttons, dialog, listeners, calls, finishClose };
};

for (const method of ['cash', 'transfer', 'breb', 'mixed']) {
  for (const action of ['save', 'print']) {
    test(`cobro ${method}/${action}: abre una vez y solo imprime cuando se solicita`, async () => {
      const app = setup({ method });
      const saving = app.context.api.processPayment(app.form, { value: action });
      await new Promise(setImmediate);
      assert.equal(app.calls.filter((call) => call === 'drawer').length, 1);
      assert.equal(app.calls.filter((call) => call === 'print').length, action === 'print' ? 1 : 0);
      assert.equal(app.calls.includes('popup'), action === 'print');
      assert.ok(app.calls.indexOf('storage') < app.calls.indexOf('drawer'));
      assert.ok(app.calls.indexOf('drawer') < app.calls.indexOf('render-inventory'), 'El pulso sale antes de reconstruir la interfaz.');
      assert.equal(app.dialog.open, false);
      assert.equal(app.state.invoiceHistory.length, 1);
      // El hardware actua sin esperar la confirmacion remota, tambien offline.
      await app.context.api.processPayment(app.form, { value: action });
      assert.equal(app.calls.filter((call) => call === 'drawer').length, 1);
      app.finishClose({ saved: { id: 'session-1' } });
      await saving;
    });
  }
}

for (const device of ['mobile', 'desktop', 'controller']) for (const online of [true, false]) {
  test(`cobro desde ${device}, online=${online}: abre exclusivamente la caja local`, async () => {
    const app = setup({ device, online });
    const saving = app.context.api.processPayment(app.form, { value: 'print' });
    await new Promise(setImmediate);
    assert.equal(app.calls.filter(call => call === 'drawer').length, device === 'controller' ? 1 : 0);
    assert.equal(app.calls.includes('request_pos_drawer'), false);
    assert.equal(app.calls.filter(call => call === 'print').length, 1);
    assert.equal(app.state.invoiceHistory.length, 1);
    app.finishClose({ saved: { id: 'session-1' } });
    await saving;
  });
}

test('la apertura manual explícita conserva su comportamiento', async () => {
  const app = setup({ device: 'mobile' });
  assert.equal(await app.context.api.openCashDrawer(), true);
  assert.equal(app.calls.filter(call => call === 'request_pos_drawer').length, 1);
});

for (const options of [{ validPayment: false }, { validStock: false }, { received: 99 }, { savedLocally: false }, { duplicate: true }]) {
  test(`un cobro rechazado no abre la caja ni imprime: ${JSON.stringify(options)}`, async () => {
    const app = setup(options);
    await app.context.api.processPayment(app.form, { value: 'print' });
    assert.equal(app.calls.includes('drawer'), false);
    assert.equal(app.calls.includes('print'), false);
  });
}

test('mantener la tecla o repetir el envio mientras se guarda no duplica la venta', async () => {
  const app = setup();
  const first = app.context.api.processPayment(app.form, { value: 'save' });
  await app.context.api.processPayment(app.form, { value: 'print' });
  app.finishClose({});
  await first;
  assert.equal(app.state.invoiceHistory.length, 1);
  assert.equal(app.calls.filter((call) => call === 'drawer').length, 1);
  assert.equal(app.calls.includes('print'), false);
});

test('un rechazo del controlador no duplica el cobro ni impide generar su recibo', async () => {
  const app = setup({ drawerAccepted: false });
  const saving = app.context.api.processPayment(app.form, { value: 'print' });
  app.finishClose({});
  await saving;
  assert.equal(app.state.invoiceHistory.length, 1);
  assert.equal(app.calls.filter((call) => call === 'drawer').length, 1);
  assert.equal(app.calls.filter((call) => call === 'print').length, 1);
});

test('el cierre cobra solo el saldo y conserva el abono en la factura sin duplicar ingresos', async () => {
  const app = setup();
  app.state.sessions[0].session_payments = [{ id: 'abono-1', amount: 40, payment_method: 'cash', created_at: '2026-10-07T18:00:00Z' }];
  app.state.activePaymentTotal = 60;
  const saving = app.context.api.processPayment(app.form, { value: 'print' });
  app.finishClose({});
  await saving;
  const invoice = app.state.invoiceHistory[0];
  assert.equal(invoice.remainingPaid, 60);
  assert.equal(invoice.payments[0].amount, 100);
  assert.equal(invoice.prepayments.length, 1);
  assert.equal(invoice.changeDue, 40);
  assert.equal(app.calls.filter(call => call === 'drawer').length, 1);
});

test('un abono que llega mientras se guarda obliga a revisar y no imprime un saldo atrasado', async () => {
  const app = setup({ beforeDurableSave: state => {
    state.sessions[0].session_payments = [{ id: 'abono-nuevo', amount: 40, payment_method: 'transfer' }];
  } });
  await app.context.api.processPayment(app.form, { value: 'print' });
  assert.equal(app.calls.includes('rollback'), true);
  assert.equal(app.calls.includes('remote-close'), false);
  assert.equal(app.calls.includes('drawer'), false);
  assert.equal(app.calls.includes('print'), false);
  assert.equal(app.state.localSupabaseWrites, 0);
});

test('Enter principal y numerico eligen sin imprimir incluso con foco en Imprimir', () => {
  const app = setup();
  const submitted = [];
  app.form.requestSubmit = (button) => submitted.push(button.value);
  app.context.api.bindPaymentConfirmShortcut();
  const press = (options = {}) => {
    let prevented = false;
    app.listeners.keydown({ key: 'Enter', code: 'Enter', target: app.buttons[1],
      preventDefault: () => { prevented = true; }, ...options });
    return prevented;
  };
  assert.equal(press(), true);
  assert.equal(press({ code: 'NumpadEnter', location: 3 }), true);
  assert.equal(press({ repeat: true }), true);
  assert.deepEqual(submitted, ['save', 'save']);
  app.state.paymentProcessing = true;
  assert.equal(press(), true);
  app.state.paymentProcessing = false;
  app.buttons[0].disabled = true;
  assert.equal(press(), true);
  assert.equal(submitted.length, 2);
  app.buttons[0].disabled = false;
  assert.equal(press({ isComposing: true }), false);
  assert.equal(press({ key: 'Escape', code: 'Escape' }), false);
  app.dialog.open = false;
  assert.equal(press(), false);
  assert.equal(submitted.length, 2);
});
