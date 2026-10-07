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
  received = 100, duplicate = false, drawerAccepted = true } = {}) => {
  const calls = [];
  const session = { id: 'session-1', table_id: 'table-1', session_items: [
    { id: 'line-1', menu_item_id: 'product-1', item_name: 'Producto', quantity: 1, unit_price: 100, status: 'served' }
  ] };
  const state = { paymentProcessing: false, sessions: [session], invoiceHistory: duplicate ? [{ sessionId: session.id }] : [],
    activePaymentTotal: 100, inventoryMeta: {}, localSupabaseWrites: 0, currentUser: { id: 'staff-1' } };
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
      posCashDrawer: { open: async (request) => {
        assert.equal(request.source, 'tienda-napoles-pos');
        calls.push('drawer'); return drawerAccepted;
      } }
    },
    toast: () => {}, tipsEnabled: () => false,
    paymentFromForm: () => validPayment ? { method, payments: [{ method, amount: 100 }] } : null,
    currencyInputNumber: (input) => Number(input?.value || 0), integerMoney: (value) => Number(value),
    paidInventoryPlan: () => [], validatePaidInventory: () => validStock,
    sessionTotals: () => ({ subtotal: 100, total: 100 }), uid: () => 'invoice-1',
    sessionReference: () => 'M1', sessionLabel: () => 'Mesa 1',
    applyPaidInventoryLocally: () => {},
    applyInvoiceToInventory: (invoice) => { state.invoiceHistory.push(invoice); calls.push('invoice'); },
    flushDurableWrites: async () => { calls.push('storage'); return savedLocally; },
    closeSession: () => { calls.push('remote-close'); return closePromise; },
    rollbackLocalPayment: () => { calls.push('rollback'); },
    renderInventory: () => {}, renderInventoryMovements: () => {}, renderIncomeReport: () => {}, renderTips: () => {},
    printThermalReceipt: (paidSession, invoice, receiptWindow) => {
      assert.equal(paidSession.id, session.id);
      assert.equal(invoice.sessionId, session.id);
      assert.equal(receiptWindow, popup);
      calls.push('print');
    },
    paymentMethodLabel: () => method,
    flushAppsScriptOutbox: () => {}
  });
  vm.runInContext(section('  const openCashDrawer =', '  const getAppsScriptUrl =')
    + section('  const bindPaymentConfirmShortcut =', '  const renderConsumptionSelection =')
    + ';globalThis.api = {processPayment, bindPaymentConfirmShortcut};', context);
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
