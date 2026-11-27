const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};

test('batched confirmations remain bounded throughout a long shift and retain recent updates', () => {
  const state = {};
  const context = vm.createContext({ state, Date });
  vm.runInContext(section('  const rememberRemoteConfirmation =', '  const REQUEST_LABELS =') + ';globalThis.remember=rememberRemoteConfirmation;', context);
  for (let batch = 0; batch < 80; batch++) {
    context.remember({ entity: 'session_items', confirmedRows: Array.from({ length: 200 }, (_, i) => ({ id: String(batch * 200 + i) })) });
    assert.equal(state.confirmedRemoteRows.size, Math.min(4000, (batch + 1) * 200));
  }
  assert.equal(state.confirmedRemoteRows.has('session_items:0'), false);
  context.remember({ entity: 'session_items', confirmedRows: [{ id: '12000', quantity: 7 }] });
  context.remember({ entity: 'session_items', confirmedRows: [{ id: 'new' }, null, {}] });
  assert.equal(state.confirmedRemoteRows.size, 4000);
  assert.equal(state.confirmedRemoteRows.get('session_items:12000').row.quantity, 7);
  assert.equal(state.confirmedRemoteRows.has('session_items:12001'), false);
  assert.equal(state.confirmedRemoteRows.has('session_items:15999'), true);
});

test('reconciling many open accounts scans the invoice history once', () => {
  let visits = 0;
  const invoices = Array.from({ length: 20000 }, (_, i) => ({ get sessionId() { visits++; return 'paid-' + i; } }));
  const state = { invoiceHistory: invoices, optimisticSessionStates: new Map(), checkoutClosures: {} };
  const context = vm.createContext({ state, Date, mergeSessionItems: rows => rows || [] });
  const end = source.includes('  const applyOfflineSessionRemap =') ? '  const applyOfflineSessionRemap =' : '  const isSongRequest =';
  vm.runInContext(section('  const mergeOptimisticSessions =', end) + ';globalThis.merge=mergeOptimisticSessions;', context);
  const sessions = Array.from({ length: 300 }, (_, i) => ({ id: 'open-' + i, session_items: [] }));
  sessions.push({ id: 'paid-19999', session_items: [] });
  assert.equal(context.merge(sessions).length, 301);
  assert.equal(visits, 20000, 'History work must be proportional to invoices, not invoices multiplied by active accounts.');
  assert.equal(state.checkoutReconciliationCandidates.size, 1);
  assert.equal(state.checkoutReconciliationCandidates.has('paid-19999'), true);
});

test('unchanged background catalog reads preserve nodes and avoid repeated cache writes', async () => {
  let reads = 0, renders = 0, caches = 0, valid = true;
  const snapshot = { business: { business_name: 'Napoles' }, tables: [{ id: 'table' }], categories: [{ id: 'category' }],
    items: Array.from({ length: 2000 }, (_, i) => ({ id: String(i), name: 'Product ' + i, price: i + 1 })) };
  const state = { ...structuredClone(snapshot), page: 'admin', authToken: 'test', activeAdminSection: 'dashboard',
    sb: { rpc: async () => { reads++; return valid ? structuredClone(snapshot) : null; } } };
  const count = () => { renders++; };
  const context = vm.createContext({ state, Date, URLSearchParams, location: { search: '' }, window: { setTimeout },
    getOfflineSyncStatus: async () => ({ blockingRecords: [] }), setScopedCoreRead: async () => true,
    mergePendingCoreData: data => data, dbQuiet: async request => request, tableCode: () => '',
    persistBootstrapCache: () => { caches++; }, applyBusinessTipSettings: count, renderBrand: count,
    syncTipFeatureVisibility: count, renderTables: count, renderServiceTables: count, renderTableManager: count,
    renderMenuManager: count, renderInventory: count, renderBusinessForm: count, renderMenu: count });
  vm.runInContext(section('  let coreRefreshPromise =', '  const updateNavRequestBadge =') + ';globalThis.refresh=refreshCoreNow;', context);
  const originalItems = state.items;
  for (let i = 0; i < 50; i++) assert.equal(await context.refresh({ periodic: true }), true);
  assert.equal(reads, 50);
  assert.equal(renders, 0);
  assert.equal(caches, 0);
  assert.equal(state.items, originalItems);
  assert.equal(state.syncFresh.core, true);
  assert.ok(state.coreRefreshedAt > 0);
  snapshot.items[0].price = 9876;
  await context.refresh();
  assert.equal(state.items[0].price, 9876);
  assert.equal(caches, 1);
  assert.ok(renders > 0);
  const afterChange = renders;
  await context.refresh();
  assert.equal(renders, afterChange);
  valid = false;
  assert.equal(await context.refresh(), false);
  assert.equal(state.syncFresh.core, false);
  assert.equal(state.items[0].price, 9876);
  assert.equal(renders, afterChange);
});
