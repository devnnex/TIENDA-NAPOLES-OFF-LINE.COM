const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const offline = !source.includes('  const pendingInventoryIds =');
const section = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, from); return source.slice(a, b);
};
const clone = value => structuredClone(value);

// Exercise the deployed Apps Script adjustment implementation, including its
// event-ID check, with an in-memory Sheets interface rather than another stock algorithm.
function backend(stock = 100) {
  const sheets = new Map(), properties = new Map(), notices = [];
  class Sheet {
    constructor(rows) { this.rows = rows; }
    getLastRow() { return this.rows.length; }
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => this.rows[row - 1 + i]?.[col - 1 + j] ?? '')),
        setValues: values => values.forEach((entry, i) => {
          this.rows[row - 1 + i] ||= [];
          entry.forEach((value, j) => { this.rows[row - 1 + i][col - 1 + j] = value; });
        }),
        createTextFinder: text => ({ matchEntireCell: () => ({ findNext: () => this.rows.slice(row - 1, row - 1 + height).some(entry => String(entry[col - 1]) === String(text)) }) })
      };
    }
  }
  const ctx = vm.createContext({ console, Date, PropertiesService: { getScriptProperties: () => ({ getProperty: k => properties.get(k), setProperty: (k, v) => properties.set(k, v) }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../appscript/Code.gs'), 'utf8'), ctx);
  sheets.set(ctx.APP.sheets.inventory, new Sheet([ctx.HEADERS.inventory, ['product', 'CC', 'Club Colombia', 'Cerveza', 'unidad', 40, 100, stock, 5, true, 'base', '', 1, '']]));
  sheets.set(ctx.APP.sheets.movements, new Sheet([ctx.HEADERS.movements]));
  Object.assign(ctx, { withScriptLock_: fn => fn(), getSpreadsheet_: () => ({ getSheetByName: name => sheets.get(name) }), appendAudit_() {} });
  return {
    notices, ctx,
    inventory: () => clone(ctx.getInventory_().items),
    movements: () => clone(ctx.getInventoryMovements_(800).movements),
    async request(action, payload) {
      if (action === 'get_inventory') return { ok: true, items: this.inventory(), everInitialized: true };
      if (action === 'get_inventory_movements') return { ok: true, ...clone(ctx.getInventoryMovements_(payload.limit, payload.cursor, payload.revision)) };
      assert.equal(action, 'adjust_inventory');
      const result = clone(ctx.adjustInventory_(payload.adjustment, { full_name: 'Equipo' }));
      return result.ok === false ? result : { ...result, ok: true };
    },
    async rpc(name, payload) {
      if (name === 'get_report_changes') return { data: { ok: true, changes: notices.filter(row => row.sequence > payload.p_after), hasMore: false } };
      const changes = name === 'publish_report_changes_batch' ? payload.p_changes : [{ operationId: payload.p_operation_id, action: payload.p_action, payload: payload.p_payload }];
      const results = changes.map(change => {
        let saved = notices.find(row => row.operationId === change.operationId);
        if (!saved) { saved = { ...clone(change), sequence: notices.length + 1 }; notices.push(saved); }
        return { operationId: saved.operationId, sequence: saved.sequence };
      });
      return { data: { ok: true, results } };
    }
  };
}
function device(server, id, stock = 100) {
  const storage = new Map(), timers = [], errors = [], reads = [];
  let serial = 0, lose = false, reading = false;
  const state = { currentUser: { id, role: 'boss', full_name: 'Equipo' }, authToken: id, items: [{ id: 'product', name: 'Club Colombia', price: 100 }],
    inventoryMeta: { product: { stock, version: 1, costPrice: 40, minStock: 5, updatedAt: 'base' } },
    inventoryMovements: [], invoiceHistory: [], appsScriptOutboxBusy: false, localSupabaseWrites: 0, activeAdminSection: 'inventory', syncFresh: {} };
  const context = vm.createContext({ state, console, Date, performance, Map, Set, JSON, Object, Number, clearTimeout,
    navigator: { onLine: true }, window: { setTimeout: fn => { timers.push(fn); return 1; } },
    SUPABASE_CONFIG: { url: 'https://inventory.invalid' }, APPS_SCRIPT_TIMEOUT_MS: 45000,
    uid: () => id + '-' + (++serial), $: () => null, productAcronym: () => 'CC', normalizeText: text => String(text).toLowerCase(),
    isAppsScriptConfigured: () => true, isManager: () => true, canAccessAdminSection: () => false,
    readLocalJson: (key, fallback) => clone(storage.has(key) ? storage.get(key) : fallback),
    persistDurableJson: async (key, value) => { storage.set(key, clone(value)); return true; },
    readAppsScriptOutbox: () => clone(storage.get('jobs') || []),
    writeAppsScriptOutbox: async jobs => { storage.set('jobs', clone(jobs.map(job => ({ status: 'pending', ...job })))); return true; },
    persistInventoryStore() {}, persistBootstrapCache() {}, persistInvoiceHistory() {}, persistInventoryMovements: async () => true,
    renderInventory() {}, renderMenuManager() {}, renderInventoryMovements() {},
    toast: (message, kind) => { if (kind === 'error') errors.push(message); },
    flushAppsScriptOutbox: async () => false, flushDurableWrites: async () => true, getOfflineSyncStatus: async () => ({ blockingRecords: [] }),
    recordSyncEvent() {}, updateGlobalSyncStatus() {}, setInventorySyncStatus() {},
    scheduleAppsScriptRetry() {}, appsScriptRetryDelay: () => 1000,
    transientAppsScriptError: message => Error(message),
    // Drain refreshes are queued, so tests can deliver another device's write
    // between acknowledgment and the final authoritative read.
    refreshInventoryFromPeer: () => reads.push('inventory'), loadInventoryMovements: () => reads.push('movements')
  });
  state.sb = { rpc: (...args) => server.rpc(...args) };
  vm.runInContext(
    section('  const recordLocalInventoryMovement =', '  const productSearchScore =')
    + section(offline ? '  const isPendingInventoryJob =' : '  const pendingInventoryIds =', '  const enqueueAppsScriptJob =')
    + section('  const enqueueAppsScriptJob =', offline ? '  const appsScriptRetryDelay =' : '  const isSupabaseWriteBlockingJob =')
    + section('  const isSupabaseWriteBlockingJob =', offline ? '  const startOfflineSyncPulse =' : '  const isPendingInventoryJob =')
    + section('  const runAppsScriptOutbox =', '  const flushAppsScriptOutbox =')
    + section('  const saveInventoryAdjustment =', offline ? '  const dateInputValue =' : '  const businessDateKey =')
    + section('  const reportMirrorKey =', '  const clientBillEnabled =')
    + section('  const inventorySummary =', '  const renderInventoryLiveCalculation =')
    + ';globalThis.api={saveInventoryAdjustment,runAppsScriptOutbox,queueConfirmedReportChange,flushConfirmedReportChanges,reportMirror,applyConfirmedReportChanges,applyRemoteInventoryItems,inventorySummary};', context);
  context.appsScriptRequest = async (action, payload = {}, timeout, operationId) => {
    if (!context.navigator.onLine) throw Error('Sin conexión');
    const result = await server.request(action, payload);
    if (lose && action === 'adjust_inventory') { lose = false; throw Error('Se perdió la respuesta'); }
    if (action === 'adjust_inventory') await context.api.queueConfirmedReportChange(action, payload, result, operationId);
    return result;
  };
  return { state, context, api: context.api, storage, errors, reads,
    add(delta) { context.api.saveInventoryAdjustment({ product_id: { value: 'product' }, quantity: { value: Math.abs(delta) }, operation: { value: delta < 0 ? 'subtract' : 'add' } }); },
    loseResponse() { lose = true; },
    async drain() { return context.api.runAppsScriptOutbox(true); },
    async read() {
      reading = true;
      const items = server.inventory();
      const apply = () => offline ? context.api.applyRemoteInventoryItems(items, { preserveProductIds: context.pendingInventoryProductIds?.() || new Set() }) : context.api.applyRemoteInventoryItems(items);
      apply(); state.inventoryMovements = server.movements(); reading = false;
    },
    async receive() {
      const mirror = context.api.reportMirror();
      const changes = server.notices.filter(row => row.sequence > mirror.cursor);
      const items = context.api.applyConfirmedReportChanges(mirror, clone(changes), { applyInventory: false });
      if (offline) context.api.applyRemoteInventoryItems(items); else context.api.applyRemoteInventoryItems(items);
    }
  };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };

test('sumar desde una copia antigua suma al saldo remoto y comparte el movimiento real', async () => {
  const server = backend(100), owner = device(server, 'offline', 10), peer = device(server, 'bca');
  owner.add(12);
  const queued = owner.storage.get('jobs'); assert.equal(queued[0].action, 'adjust_inventory');
  assert.equal(queued[0].payload.adjustment.delta, 12); assert.equal(queued[0].payload.stock, undefined);
  assert.equal(await owner.drain(), true); await settle(); await peer.receive();
  assert.equal(server.inventory()[0].stock, 112); assert.equal(owner.state.inventoryMeta.product.stock, 112); assert.equal(peer.state.inventoryMeta.product.stock, 112);
  const movement = server.notices[0].payload.movements[0];
  assert.equal(movement.before, 100); assert.equal(movement.after, 112); assert.equal(movement.delta, 12);
  assert.equal(owner.state.inventoryMovements[0].before, 100); assert.deepEqual(owner.reads, ['inventory', 'movements']);
});

test('una respuesta perdida conserva el evento y su reintento no suma ni inventa otro movimiento', async () => {
  const server = backend(), first = device(server, 'one'), second = device(server, 'two');
  first.add(12); const original = clone(first.storage.get('jobs')[0]); first.loseResponse();
  assert.equal(await first.drain(), false); assert.equal(server.inventory()[0].stock, 112); assert.equal(first.storage.get('jobs')[0].id, original.id);
  second.add(7); await second.drain(); await settle();
  assert.equal(await first.drain(), true); await settle(); await first.read(); await second.read();
  assert.equal(server.movements().length, 2); assert.equal(first.state.inventoryMeta.product.stock, 119); assert.equal(second.state.inventoryMeta.product.stock, 119);
  const receipt = server.notices.find(row => row.operationId === original.id).payload.movements[0];
  assert.equal(receipt.before, 100); assert.equal(receipt.after, 112, 'El saldo actual 119 no sustituye el saldo del evento original.');
});

test('reintentar un ajuste no exige un permiso adicional para consultar Movimientos', async () => {
  const server = backend(), app = device(server, 'stock-only');
  app.state.currentUser = { id: 'stock-only', role: 'admin', permissions: ['inventory'] };
  app.add(4); app.loseResponse(); assert.equal(await app.drain(), false);
  const request = server.request;
  server.request = async function (action, payload) {
    assert.notEqual(action, 'get_inventory_movements', 'Respeta los permisos existentes.');
    return request.call(this, action, payload);
  };
  assert.equal(await app.drain(), true); await settle();
  assert.equal(server.inventory()[0].stock, 104); assert.equal(server.movements().length, 1);
  assert.equal(app.storage.get('jobs').length, 0);
});

test('rafagas sin red en dos equipos conservan todos los deltas, KPI y movimientos al volver', async () => {
  const server = backend(1000), a = device(server, 'a', 1000), b = device(server, 'b', 1000);
  a.context.navigator.onLine = false; b.context.navigator.onLine = false;
  for (let i = 0; i < 50; i++) { a.add(3); b.add(-2); }
  assert.equal(a.storage.get('jobs').length, 50); assert.equal(b.storage.get('jobs').length, 50); assert.equal(server.movements().length, 0);
  a.context.navigator.onLine = true; b.context.navigator.onLine = true;
  assert.deepEqual(await Promise.all([a.drain(), b.drain()]), [true, true]); await settle();
  await a.read(); await b.read(); await a.receive(); await b.receive();
  for (const app of [a, b]) {
    assert.equal(app.state.inventoryMeta.product.stock, 1050); assert.equal(app.state.inventoryMovements.length, 100);
    const kpi = app.api.inventorySummary(); assert.equal(kpi.units, 1050); assert.equal(kpi.costValue, 42000); assert.equal(kpi.saleValue, 105000);
    assert.equal(app.storage.get('jobs').length, 0); assert.deepEqual(app.reads, ['inventory', 'movements']);
    await app.api.flushConfirmedReportChanges(); await app.read(); assert.equal(app.state.inventoryMeta.product.stock, 1050);
  }
  assert.equal(server.notices.length, 100); assert.equal(new Set(server.movements().map(row => row.movementId)).size, 100);
});

test('un retiro rechazado no congela el saldo real ni agrega un movimiento inexistente al otro equipo', async () => {
  const server = backend(2), app = device(server, 'stale', 100);
  app.add(-10); await app.drain(); await app.read();
  assert.equal(app.storage.get('jobs')[0].status, 'failed'); assert.equal(app.state.inventoryMeta.product.stock, 2);
  assert.equal(server.movements().length, 0); assert.equal(server.notices.length, 0); assert.equal(app.errors.length, 1);
});

test('al acabar la cola se vuelve al backend y recibe cambios posteriores aunque se pierda el aviso', async () => {
  const server = backend(), app = device(server, 'first'), peer = device(server, 'second');
  app.add(20); await app.drain(); assert.deepEqual(app.reads, ['inventory', 'movements']);
  peer.add(-7); await peer.drain(); await app.read();
  assert.equal(app.state.inventoryMeta.product.stock, 113); assert.equal(app.state.inventoryMovements.length, 2);
  app.context.navigator.onLine = false; app.add(5); assert.equal(app.state.inventoryMeta.product.stock, 118);
  app.context.navigator.onLine = true; await app.drain(); await app.read(); await peer.read();
  assert.equal(app.state.inventoryMeta.product.stock, 118); assert.equal(peer.state.inventoryMeta.product.stock, 118); assert.equal(server.movements().length, 3);
});

test('una suma antigua aun sin enviar se convierte en delta durable antes de tocar el backend', async () => {
  const server = backend(150), app = device(server, 'upgrade', 112);
  app.storage.set('jobs', [{ id: 'old-sum', status: 'pending', attempts: 0, action: 'set_inventory_stock',
    dedupeKey: 'inventory-stock:product', payload: { productId: 'product', stock: 112, inventoryDelta: 12 } }]);
  app.loseResponse(); assert.equal(await app.drain(), false);
  const protectedJob = app.storage.get('jobs')[0];
  assert.equal(protectedJob.action, 'adjust_inventory'); assert.equal(protectedJob.id, 'old-sum');
  assert.equal(protectedJob.payload.adjustment.eventId, 'units:product:old-sum');
  assert.equal(await app.drain(), true); await settle();
  assert.equal(server.inventory()[0].stock, 162); assert.equal(server.movements().length, 1);
  assert.equal(server.notices[0].payload.movements[0].before, 150);
});

test('un ajuste antiguo con cambio neto cero consulta el saldo real sin escribir el saldo viejo', async () => {
  const server = backend(150), app = device(server, 'zero', 100);
  app.storage.set('jobs', [{ id: 'old-zero', status: 'pending', attempts: 0, action: 'set_inventory_stock',
    dedupeKey: 'inventory-stock:product', payload: { productId: 'product', stock: 100, inventoryDelta: 0 } }]);
  assert.equal(await app.drain(), true);
  assert.equal(server.inventory()[0].stock, 150); assert.equal(app.state.inventoryMeta.product.stock, 150);
  assert.equal(server.movements().length, 0); assert.equal(app.storage.get('jobs').length, 0);
});
