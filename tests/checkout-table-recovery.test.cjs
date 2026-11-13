const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const offline = source.includes('const applyOfflineSessionRemap =');
const section = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, from);
  return source.slice(a, b);
};
const clone = value => JSON.parse(JSON.stringify(value));
const account = (table = '3', id = 'account-' + table) => ({ id, table_id: 'table-' + table, status: 'open',
  session_items: [{ id: 'line-' + id, menu_item_id: 'product', item_name: 'Agua', quantity: 2, unit_price: 100, status: 'served' }], session_payments: [] });
const invoice = session => ({ id: session.id, sessionId: session.id, tableId: session.table_id, number: 'TN-' + session.id,
  createdAt: '2026-11-12T17:00:00.000Z', baseTotal: 200, totals: { subtotal: 200, total: 200 },
  items: clone(session.session_items), payments: [{ method: 'cash', amount: 200 }], prepayments: [], checkoutAccepted: true });
function harness({ indexedDB = new IDBFactory(), localStorage, invoices = [], sessions = [], ledger = {}, queued = false, rejected = false } = {}) {
  const values = new Map();
  localStorage ||= { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const remote = new Map(sessions.map(row => [row.id, clone(row)])), events = [], messages = [], jobs = [];
  const state = { sessions: clone(sessions), requests: [], invoiceHistory: clone(invoices), inventoryMeta: { stock: 10 }, inventoryMovements: [],
    incomeReport: null, optimisticSessionStates: new Map(), optimisticRequestStates: new Map(), checkoutClosures: clone(ledger),
    currentUser: { id: 'boss', role: 'boss' }, authToken: 'test', posFeatures: { abonos: true }, activePaymentTotal: 200, activePaymentBase: 200 };
  const context = vm.createContext({ state, console, indexedDB, localStorage, structuredClone, Date, Map, Set,
    window: { indexedDB }, navigator: { onLine: !queued },
    LOCAL_DATA_DB: 'checkout-recovery', LOCAL_DATA_DB_VERSION: 1, LOCAL_DATA_STORE: 'records', DURABLE_LOCAL_KEYS: [],
    INVENTORY_STORAGE_KEY: 'inventory', INVOICE_STORAGE_KEY: 'invoices', INVENTORY_MOVEMENTS_STORAGE_KEY: 'movements', APPS_SCRIPT_OUTBOX_KEY: 'outbox',
    REMOTE_CONFIRMATION_HOLD_MS: 1500,
    sessionTotals: row => { const total = (row.session_items || []).filter(line => line.status !== 'cancelled').reduce((sum, line) => sum + line.quantity * line.unit_price, 0); return { subtotal: total, total, discount: 0, tax: 0, serviceFee: 0 }; },
    sessionPaid: row => (row.session_payments || []).reduce((sum, payment) => sum + payment.amount, 0),
    isManager: () => true, isLocalWalkInSession: () => false, persistWalkInDrafts() {}, persistOfflineAdminSnapshot() {},
    renderAdminLive() {}, renderAdmin() {}, persistPendingAdminRequests() {}, rememberCompletedAdminRequests() {}, readPendingAdminRequests: () => [],
    toast: (...args) => messages.push(args), $: () => ({ close() { events.push('dialog-close'); } }),
    paidInventoryPlan: () => [], applyPaidInventoryLocally: () => { events.push('inventory'); state.inventoryMeta.stock -= 2; },
    readAppsScriptOutbox: () => jobs,
    writeAppsScriptOutbox: next => { jobs.splice(0, jobs.length, ...next); return context.api.persist('outbox', jobs); },
    enqueueAppsScriptJob: (action, payload, dedupeKey) => { if (!jobs.some(job => job.dedupeKey === dedupeKey)) jobs.push({ id: dedupeKey, action, payload, dedupeKey }); },
    persistInvoiceHistory: () => context.api.persist('invoices', state.invoiceHistory),
    applyInvoiceToInventory: sale => { state.invoiceHistory.push(sale); context.enqueueAppsScriptJob('record_sale', { invoice: sale }, 'sale:' + sale.sessionId); },
    flushAppsScriptOutbox: () => events.push('flush'),
    retryPosMutation: async factory => (await factory()).data,
    readRealtimeData: async query => (await query).data
  });
  state.sb = {
    rpc: async (_name, payload) => {
      events.push('remote-close');
      if (rejected) return { data: null, error: { message: 'rejected' } };
      const row = remote.get(payload.p_session_id);
      if (!row) return { data: null };
      const next = { ...row, ...payload.p_patch, ...(queued ? { _offline_pending: true } : {}) };
      if (!queued) remote.set(row.id, clone(next));
      return { data: { session: next } };
    },
    from(table) {
      let id;
      const query = { select() { return this; }, update() { return this; }, eq(key, value) { if (key === 'id') id = value; return this; },
        single() { return this; }, maybeSingle() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: table === 'table_sessions' ? clone(remote.get(id) || null) : [] }).then(resolve, reject); } };
      return query;
    }
  };
  vm.runInContext(section('  let localDataDbPromise =', '  const state =')
    + section('  const readLocalJson =', '  function applyBusinessTipSettings')
    + section('  const mergeOutboxJobs =', '  const writeAppsScriptOutbox =')
    + section('  const mergeOptimisticRequests =', offline ? '  const applyOfflineSessionRemap =' : '  const isSongRequest =')
    + section('  const closeSession =', '  const thermalReceiptHtml =')
    + section('  const CHECKOUT_INTENTS_KEY =', '  const performPayment =')
    + ';globalThis.api={persist:persistDurableJson,hydrate:hydrateDurableKey,read:readLocalJson,process:processPayment,recover:recoverPendingCheckouts,finish:finishCheckoutIntent,save:saveCheckoutIntent,commit:commitCheckout,merge:mergeOptimisticSessions,signature:checkoutSessionSignature,close:closeSession};', context);
  return { context, api: context.api, state, remote, events, messages, jobs, indexedDB, localStorage,
    pay: id => context.api.process({ session_id: { value: id } }, { value: 'save' }) };
}

for (const table of ['1', '3', '8', '20']) test('reconcilia la factura existente de mesa ' + table + ' con el cierre persistente, sin otro cobro', async () => {
  const session = account(table), sale = invoice(session), h = harness({ sessions: [session], invoices: [sale] });
  await h.pay(session.id);
  assert.equal(h.remote.get(session.id).status, 'closed');
  assert.equal(h.remote.get(session.id).closed_at, sale.createdAt);
  assert.equal(h.state.sessions.length, 0);
  assert.equal(h.state.invoiceHistory.length, 1);
  assert.equal(h.state.inventoryMeta.stock, 10);
  assert.equal(h.jobs.length, 1, 'Recupera el respaldo faltante con el mismo ID.');
  assert.equal(h.jobs[0].payload.invoice.id, sale.id);
  assert.equal(h.jobs[0].payload.invoice.checkoutAccepted, true);
  assert.ok(h.api.read('napoles_checkout_closures_v1', {})[session.id], JSON.stringify(h.messages));
});

test('una recarga o reinicio de PWA descarta la copia atrasada aun sin el overlay temporal', async () => {
  const session = account(), h = harness({ sessions: [session], invoices: [invoice(session)] });
  await h.pay(session.id);
  const reload = harness({ indexedDB: h.indexedDB, sessions: [session] });
  await reload.api.hydrate('napoles_checkout_closures_v1');
  reload.state.checkoutClosures = reload.api.read('napoles_checkout_closures_v1', {});
  assert.equal(reload.state.optimisticSessionStates.size, 0);
  assert.equal(reload.api.merge([session]).length, 0);
  const fresh = account('3', 'new-account');
  assert.equal(reload.api.merge([session, fresh]).length, 1);
  assert.equal(reload.api.merge([fresh])[0].id, fresh.id);
});

test('no oculta ni cierra consumo distinto con el mismo total y el mismo UUID de cuenta', async () => {
  const old = account(), changed = clone(old); changed.session_items[0].id = 'another-line';
  const h = harness({ sessions: [changed], invoices: [invoice(old)] });
  h.state.checkoutClosures[old.id] = { signature: h.api.signature(old) };
  h.state.optimisticSessionStates.set(old.id, { mode: 'remove' });
  assert.equal(h.api.merge([changed]).length, 1);
  await h.pay(old.id);
  assert.equal(h.remote.get(old.id).status, 'open');
  assert.equal(h.state.sessions.length, 1);
  assert.equal(h.events.includes('remote-close'), false);
  assert.match(h.messages[0][0], /no coinciden/);
});

test('un abono nuevo conserva la cuenta y no se confunde con la factura anterior', async () => {
  const old = account(), changed = clone(old); changed.session_payments.push({ id: 'abono', amount: 50 });
  const h = harness({ sessions: [changed], invoices: [invoice(old)] });
  await h.pay(old.id);
  assert.equal(h.state.sessions.length, 1);
  assert.equal(h.events.includes('remote-close'), false);
});

test('un cierre rechazado conserva el consumo y el intento para reintentar con la factura original', async () => {
  const session = account(), h = harness({ sessions: [session], invoices: [invoice(session)], rejected: true });
  await h.pay(session.id);
  assert.equal(h.state.sessions.length, 1);
  assert.equal(h.state.invoiceHistory.length, 1);
  assert.equal(h.api.read('napoles_checkout_intents_v1')[session.id].stage, 'prepared');
  assert.deepEqual(clone(h.state.checkoutClosures), {});
});

test('recupera una factura de una version anterior aunque no tuviera checkoutAccepted', async () => {
  const session = account(), sale = invoice(session); delete sale.checkoutAccepted;
  const h = harness({ sessions: [session], invoices: [sale] });
  await h.pay(session.id);
  assert.equal(h.state.invoiceHistory[0].checkoutAccepted, true);
  assert.equal(h.api.read('invoices')[0].checkoutAccepted, true);
  assert.equal(h.state.inventoryMeta.stock, 10);
});

test('la recuperacion automatica tras cargar el snapshot repara todas las cuentas facturadas', async () => {
  const sessions = ['1','3','5'].map(id => account(id));
  const h = harness({ sessions, invoices: sessions.map(invoice) });
  h.state.sessions = h.api.merge(sessions);
  await h.api.recover();
  assert.equal(h.state.sessions.length, 0);
  assert.equal(h.state.invoiceHistory.length, 3);
  assert.equal([...h.remote.values()].every(row => row.status === 'closed'), true);
  assert.equal(h.jobs.length, 3);
  await h.api.recover();
  assert.equal(h.jobs.length, 3);
  assert.equal(h.state.inventoryMeta.stock, 10);
});

test('el cierre guardado sin red no reaparece al reiniciar aunque el servidor aun tenga la cuenta abierta', async () => {
  const session = account(), h = harness({ sessions: [session], invoices: [invoice(session)], queued: true });
  await h.pay(session.id);
  assert.equal(h.remote.get(session.id).status, 'open');
  assert.equal(h.state.sessions.length, 0);
  const reload = harness({ indexedDB: h.indexedDB });
  await reload.api.hydrate('napoles_checkout_closures_v1');
  reload.state.checkoutClosures = reload.api.read('napoles_checkout_closures_v1');
  assert.equal(reload.api.merge([session]).length, 0);
});

test('Postgres +00:00 y JavaScript Z son el mismo cierre al perderse su respuesta', async () => {
  const session = account(), sale = invoice(session), h = harness({ sessions: [session], rejected: true });
  h.remote.set(session.id, { ...session, ...sale.totals, status: 'closed', closed_at: '2026-11-12T17:00:00+00:00' });
  const closed = await h.api.close(session.id, { session, paid: 0, totals: sale.totals, closedAt: sale.createdAt });
  assert.equal(closed.saved.status, 'closed');
});

test('un cambio de productos durante el cobro conserva el intento aunque el importe sea igual', async () => {
  const session = account(), h = harness({ sessions: [session] }), sale = invoice(session);
  const intent = { invoice: sale, session: clone(session), paid: 0, stage: 'prepared' };
  h.state.sessions[0].session_items[0].id = 'changed';
  assert.equal(await h.api.finish(intent), false);
  assert.equal(h.events.includes('remote-close'), false);
  assert.equal(h.state.invoiceHistory.length, 0);
});

test('consulta el consumo vigente antes de cerrar: productos distintos con igual importe no se descartan', async () => {
  const session = account(), h = harness({ sessions: [session], invoices: [invoice(session)] });
  const changed = clone(session); changed.session_items[0].id = 'remote-new-product';
  h.remote.set(session.id, changed);
  await h.pay(session.id);
  assert.equal(h.remote.get(session.id).status, 'open');
  assert.equal(h.events.includes('remote-close'), false);
  assert.equal(h.state.sessions[0].session_items[0].id, 'remote-new-product');
  assert.equal(h.state.invoiceHistory.length, 1);
});

test('conserva el consumo local aun pendiente si el servidor solo contiene la factura antigua', async () => {
  const session = account(), h = harness({ sessions: [session], invoices: [invoice(session)] });
  h.state.sessions[0].session_items.push({ ...session.session_items[0], id: 'pending-line', quantity: 1 });
  await h.pay(session.id);
  assert.equal(h.events.includes('remote-close'), false);
  assert.equal(h.state.sessions[0].session_items.length, 2);
});

test('una cuenta archivada en Supabase se concilia sin recrearla ni repetir inventario', async () => {
  const session = account(), h = harness({ sessions: [session], invoices: [invoice(session)] });
  h.remote.delete(session.id);
  await h.pay(session.id);
  assert.equal(h.state.sessions.length, 0);
  assert.equal(h.events.includes('remote-close'), false);
  assert.equal(h.state.invoiceHistory.length, 1);
  assert.equal(h.state.inventoryMeta.stock, 10);
});

test('una factura sin pagos completos no prueba un cobro y conserva la cuenta', async () => {
  const session = account(), sale = invoice(session); sale.payments[0].amount = 10;
  const h = harness({ sessions: [session], invoices: [sale] });
  await h.pay(session.id);
  assert.equal(h.state.sessions.length, 1);
  assert.equal(h.events.includes('remote-close'), false);
});
