const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const offline = source.includes('const persistAppsScriptOutbox =');
const section = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
};
const plain = value => JSON.parse(JSON.stringify(value));
function storage() {
  const values = new Map();
  return { getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function harness(indexedDB = new IDBFactory(), localStorage = storage(), name = 'pos-test') {
  const context = vm.createContext({ indexedDB, localStorage, window: { indexedDB }, console, Date, Map,
    LOCAL_DATA_DB: name, LOCAL_DATA_DB_VERSION: 1, LOCAL_DATA_STORE: 'records', DURABLE_LOCAL_KEYS: [],
    APPS_SCRIPT_OUTBOX_KEY: 'outbox', structuredClone });
  vm.runInContext(section('  let localDataDbPromise =', '  const state =')
    + section('  const readLocalJson =', '  function applyBusinessTipSettings')
    + (offline ? section('  const mergeOutboxJobs =', '  const writeAppsScriptOutbox =') : '')
    + ';globalThis.api={persist:persistDurableJson,atomic:persistCheckoutAtomically,read:readLocalJson,hydrate:hydrateDurableKey,flush:flushDurableWrites,record:localDataRecord,open:openLocalDataDb'
    + (offline ? ',outbox:persistAppsScriptOutbox' : '') + '};', context);
  return { api: context.api, context, indexedDB, localStorage };
}

function checkout(h, remote = new Map()) {
  const account = { id: 'account', session_items: [{ id: 'line', quantity: 2, unit_price: 100 }] };
  const state = { sessions: [account], invoiceHistory: h.api.read('invoices', []), inventoryMeta: h.api.read('inventory', { stock: 10 }),
    inventoryMovements: h.api.read('movements', []), currentUser: {}, incomeReport: null };
  Object.assign(h.context, { state, navigator: {}, INVENTORY_STORAGE_KEY: 'inventory', INVOICE_STORAGE_KEY: 'invoices',
    INVENTORY_MOVEMENTS_STORAGE_KEY: 'movements', APPS_SCRIPT_OUTBOX_KEY: 'outbox', toast() {}, isManager: () => true,
    sessionPaid: () => 0, sessionTotals: () => ({ subtotal: 200, total: 200 }),
    closeSession: async (id, input) => {
      if (remote.has(id)) assert.equal(remote.get(id), input.closedAt); else remote.set(id, input.closedAt);
      return { saved: { id, closed_at: input.closedAt } };
    },
    paidInventoryPlan: () => [{ quantity: 2 }],
    applyPaidInventoryLocally: sale => {
      state.inventoryMeta.stock -= 2;
      state.inventoryMovements.push({ movementId: 'SALE-' + sale.id });
      void h.api.persist('inventory', state.inventoryMeta);
      void h.api.persist('movements', state.inventoryMovements);
    },
    applyInvoiceToInventory: sale => {
      state.invoiceHistory.push(sale);
      void h.api.persist('invoices', state.invoiceHistory);
      void h.api.persist('outbox', [...h.api.read('outbox', []), { id: 'job-' + sale.id, action: 'record_sale', payload: { invoice: sale } }]);
    },
    persistInvoiceHistory: () => h.api.persist('invoices', state.invoiceHistory),
    readAppsScriptOutbox: () => h.api.read('outbox', []), writeAppsScriptOutbox: jobs => h.api.persist('outbox', jobs)
  });
  vm.runInContext(section('  const CHECKOUT_INTENTS_KEY =', '  const performPayment =')
    + ';globalThis.checkoutApi={save:saveCheckoutIntent,finish:finishCheckoutIntent};', h.context);
  return { state, account, remote, api: h.context.checkoutApi };
}

test('la factura, inventario, movimientos y cola se confirman juntos y sobreviven a una recarga', async () => {
  const h = harness();
  assert.equal(await h.api.atomic(() => {
    for (const [key, value] of Object.entries({ invoice: { id: 'sale-a', payments: [{ method: 'card', amount: 100 }] }, inventory: { stock: 9 }, movements: ['sale-a'], outbox: [{ id: 'job-a' }] })) {
      void h.api.persist(key, value);
    }
  }), true);
  const reload = harness(h.indexedDB, storage());
  for (const key of ['invoice', 'inventory', 'movements', 'outbox']) await reload.api.hydrate(key);
  assert.equal(reload.api.read('invoice').payments[0].method, 'card');
  assert.equal(reload.api.read('inventory').stock, 9);
  assert.deepEqual(plain(reload.api.read('movements')), ['sale-a']);
  assert.equal(reload.api.read('outbox').length, 1);
});

test('un fallo a mitad de la escritura aborta todas las proyecciones financieras', async () => {
  const h = harness();
  const db = await h.api.open(), transaction = db.transaction.bind(db);
  db.transaction = (...args) => {
    const tx = transaction(...args);
    if (args[1] !== 'readwrite') return tx;
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = name => {
      const store = objectStore(name), put = store.put.bind(store);
      let writes = 0;
      store.put = value => { if (++writes === 2) throw new Error('simulated_quota'); return put(value); };
      return store;
    };
    return tx;
  };
  assert.equal(await h.api.atomic(() => { void h.api.persist('a', 1); void h.api.persist('b', 2); }), false);
  db.transaction = transaction;
  assert.equal(await h.api.record('a'), null);
  assert.equal(await h.api.record('b'), null);
});

test('quota en localStorage no permite que una réplica vieja sustituya el cobro confirmado en IndexedDB', async () => {
  const local = storage(), h = harness(new IDBFactory(), local);
  await h.api.persist('invoice', { id: 'old' });
  local.setItem = () => { throw new Error('quota'); };
  assert.equal(await h.api.atomic(() => void h.api.persist('invoice', { id: 'new' })), true);
  assert.equal(h.api.read('invoice').id, 'new');
  const reload = harness(h.indexedDB, local);
  await reload.api.hydrate('invoice');
  assert.equal(reload.api.read('invoice').id, 'new');
});

test('migra la persistencia anterior sin perder su confirmación durable', async () => {
  const local = storage(); local.setItem('invoice', JSON.stringify({ id: 'historic' }));
  const h = harness(new IDBFactory(), local);
  await h.api.hydrate('invoice');
  assert.equal(await h.api.flush(['invoice']), true);
  assert.equal((await h.api.record('invoice')).value.id, 'historic');
});

test('recupera el cierre confirmado tras reiniciar antes de proyectar la venta, una sola vez', async () => {
  const first = harness(), a = checkout(first);
  const invoice = { id: 'account', sessionId: 'account', createdAt: '2026-10-19T15:00:00Z', payments: [{ method: 'card', amount: 200 }] };
  await a.api.save(invoice, a.account, 0, 'closed');
  const reload = harness(first.indexedDB, storage());
  await reload.api.hydrate('napoles_checkout_intents_v1');
  const b = checkout(reload), intent = reload.api.read('napoles_checkout_intents_v1').account;
  await b.api.finish(intent);
  await b.api.finish(intent);
  assert.equal(b.state.inventoryMeta.stock, 8);
  assert.equal(b.state.invoiceHistory.length, 1);
  assert.equal(reload.api.read('outbox').length, 1);
  assert.deepEqual(plain(reload.api.read('napoles_checkout_intents_v1')), {});
  assert.equal(b.remote.size, 0, 'La etapa cerrada no necesita volver a cerrar remotamente.');
});

test('respuesta de cierre perdida y fallo al guardar su estado conservan la identidad de recuperación', async () => {
  const h = harness(), remote = new Map(), a = checkout(h, remote);
  const invoice = { id: 'account', sessionId: 'account', createdAt: '2026-10-19T15:00:00Z' };
  await a.api.save(invoice, a.account, 0, 'prepared');
  const db = await h.api.open(), transaction = db.transaction.bind(db);
  db.transaction = (...args) => {
    const tx = transaction(...args);
    if (args[1] !== 'readwrite') return tx;
    const store = tx.objectStore('records'), put = store.put.bind(store);
    store.put = record => {
      const request = put(record);
      if (record.key === 'napoles_checkout_intents_v1' && record.value.account?.stage === 'closed') tx.abort();
      return request;
    };
    tx.objectStore = () => store;
    return tx;
  };
  await assert.rejects(a.api.finish({ invoice, session: a.account, paid: 0, stage: 'prepared' }), /IndexedDB/);
  db.transaction = transaction;
  const reload = harness(h.indexedDB, storage());
  await reload.api.hydrate('napoles_checkout_intents_v1');
  const b = checkout(reload, remote);
  await b.api.finish(reload.api.read('napoles_checkout_intents_v1').account);
  assert.equal(remote.size, 1);
  assert.equal(b.state.inventoryMeta.stock, 8);
  assert.equal(b.state.invoiceHistory.length, 1);
});

if (offline) {
  test('clics consecutivos sin esperar IndexedDB conservan todos los trabajos y sus borrados', async () => {
    const h = harness();
    const first = h.api.outbox([{ id: 'one', updatedAt: '2026-10-19T10:00:00Z' }]);
    assert.equal(h.api.read('outbox').length, 1);
    const second = h.api.outbox([...h.api.read('outbox'), { id: 'two', updatedAt: '2026-10-19T10:00:01Z' }]);
    assert.equal(h.api.read('outbox').length, 2);
    await first;
    assert.equal(h.api.read('outbox').length, 2, 'El commit anterior no sustituye la proyección nueva.');
    await second;
    await h.api.outbox(h.api.read('outbox').filter(job => job.id !== 'one'), ['one']);
    const reload = harness(h.indexedDB, storage());
    await reload.api.hydrate('outbox');
    assert.deepEqual(plain(reload.api.read('outbox')).map(job => job.id), ['two']);
  });
  test('confirmar un envío antiguo no borra la venta recién guardada durante ese envío', async () => {
    const h = harness();
    await h.api.outbox([{ id: 'old-job', action: 'record_sale' }]);
    const staleSender = [];
    await h.api.atomic(() => void h.api.persist('outbox', [{ id: 'old-job', action: 'record_sale' }, { id: 'new-sale', action: 'record_sale' }]));
    await h.api.outbox(staleSender, ['old-job']);
    assert.deepEqual(plain((await h.api.record('outbox')).value).map(row => row.id), ['new-sale']);
  });
  test('dos pestañas conservan sus trabajos y una copia atrasada no resucita el confirmado', async () => {
    const factory = new IDBFactory(), local = storage(), a = harness(factory, local), b = harness(factory, local);
    const first = { id: 'one', status: 'pending', updatedAt: '2026-10-19T10:00:00Z' };
    const second = { id: 'two', status: 'pending', updatedAt: '2026-10-19T10:00:01Z' };
    assert.deepEqual(await Promise.all([a.api.outbox([first]), b.api.outbox([second])]), [true, true]);
    assert.equal((await a.api.record('outbox')).value.length, 2);
    await a.api.outbox([second], ['one']);
    await b.api.outbox([first, second]);
    assert.deepEqual(plain((await a.api.record('outbox')).value).map(row => row.id), ['two']);
  });
  test('más de 2.000 operaciones pendientes permanecen recuperables', async () => {
    const h = harness(), jobs = Array.from({ length: 2505 }, (_, index) => ({ id: 'job-' + index, status: 'pending' }));
    assert.equal(await h.api.outbox(jobs), true);
    const reload = harness(h.indexedDB, storage());
    await reload.api.hydrate('outbox');
    assert.equal(reload.api.read('outbox', []).length, jobs.length);
    assert.equal(reload.api.read('outbox', [])[0].id, 'job-0');
  });
}
