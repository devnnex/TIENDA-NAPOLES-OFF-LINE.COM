const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const section = (start, end) => {
  const from = source.indexOf('  const ' + start + ' =');
  const to = source.indexOf('  const ' + end + ' =', from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};

test('Actualizar iconos procesa los nuevos y conserva los SVG ya dibujados', () => {
  const selectors = [];
  const context = vm.createContext({ document: { querySelectorAll: selector => { selectors.push(selector); return []; } },
    window: { requestAnimationFrame: callback => callback(), lucide: { createIcons: ({ root }) => root.querySelectorAll('[data-lucide]') } } });
  vm.runInContext('let iconRefreshScheduled = false;' + section('refreshIcons', 'setLoading') + ';refreshIcons();refreshIcons();', context);
  assert.deepEqual(selectors, ['[data-lucide]:not(svg)', '[data-lucide]:not(svg)']);
});

test('Navegacion muestra contenido durante el clic y conserva el control de permisos', () => {
  const calls = [];
  const state = { activeAdminSection: 'dashboard' };
  const context = vm.createContext({ state, $$: () => [],
    syncAdminSectionAccess() {}, tipsEnabled: () => false,
    canAccessAdminSection: name => name !== 'users', firstAllowedAdminSection: () => 'service', allowedAdminSections: () => ['service', 'accounts', 'menu'],
    renderAccounts: () => calls.push('accounts'), renderServiceTables: () => calls.push('service'),
    renderWaiterTableSelect() {}, renderMenuManager: () => calls.push('products'),
    renderTableManager() {}, renderTableFormQr() {}, refreshIcons() {},
    window: { setTimeout() { throw Error('No debe diferir el contenido'); }, requestAnimationFrame() { throw Error('No debe diferir el contenido'); } }
  });
  vm.runInContext(section('showAdminSection', 'findTableFromUrl') + ';globalThis.show = showAdminSection;', context);
  context.show('accounts');
  assert.deepEqual(calls, ['accounts']);
  context.show('menu');
  assert.equal(calls.at(-1), 'products');
  context.show('users');
  assert.equal(state.activeAdminSection, 'service');
  assert.equal(calls.at(-1), 'service');
});

test('Teclear filtra todas las ventas disponibles sin perder filas al borrar la busqueda', () => {
  let query = 'cafe';
  const filters = { dateFrom: '2026-10-10', dateTo: '2026-10-10', saleType: 'all', query: '' };
  const records = [
    { saleId: 'a', total: 10, items: [{ name: 'Café' }] },
    { saleId: 'b', total: 20, table: 'Mesa 2', items: [{ name: 'Agua' }] }
  ];
  const key = value => JSON.stringify({ ...value, saleType: 'all' });
  const state = { incomeSaleTypeSnapshot: { key: key(filters), report: { records, totalRecords: 2, recordRows: [{saleId:'a'}, {saleId:'b'}] } } };
  let renders = 0;
  const context = vm.createContext({ state, incomeFiltersFromForm: () => ({ ...filters, query }),
    incomeSaleTypeFiltersKey: key, normalizeText: value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    incomeTotalsFromRecords: rows => ({ income: rows.reduce((sum, row) => sum + row.total, 0) }),
    mergeIncomeReport: (report, applied) => ({ ...report, filters: applied }), renderIncomeReport: () => renders++ });
  vm.runInContext(section('previewIncomeSearch', 'incomePaymentLabel') + ';globalThis.preview = previewIncomeSearch;', context);
  assert.equal(context.preview(), true);
  assert.equal(state.incomeReport.records[0].saleId, 'a');
  assert.equal(state.incomeReport.totals.income, 10);
  assert.equal(state.incomeReport.recordRows.length, 1);
  query = '';
  assert.equal(context.preview(), true);
  assert.equal(state.incomeReport.records.length, 2);
  assert.equal(state.incomeReport.totals.income, 30);
  assert.equal(renders, 2);
  state.incomeSaleTypeSnapshot.report.totalRecords = 3;
  assert.equal(context.preview(), false, 'Una pagina incompleta requiere consultar el servidor');
  state.incomeSaleTypeSnapshot.report.totalRecords = 2;
  state.incomeSaleTypeSnapshot.key = key({ ...filters, dateFrom: '2026-10-09' });
  assert.equal(context.preview(), false, 'No mezcla periodos distintos');
});

test('Preparar categorias no retrasa la interfaz ni devuelve al usuario a otra seccion', async () => {
  const calls = [];
  const state = { activeAdminSection: 'accounts' };
  const context = vm.createContext({ state, URL, URLSearchParams,
    location: { href: 'https://tienda.test/admin.html#dashboard', search: '', hash: '#dashboard' },
    localStorage: { getItem: () => '0', setItem() {} },
    readLocalJson: () => ({}), USER_CREDENTIALS_CACHE_KEY: 'pins',
    window: { addEventListener() {} }, history: { replaceState() {} },
    setLoading() {}, waitForAdminLogin: async () => calls.push('validated'),
    loadBootstrap: () => { calls.push('cache'); return Promise.resolve(true); },
    loadInventoryStore() {}, loadUsers: async () => [], renderUsers() {},
    renderAdminShell: () => calls.push('shell'), renderBusinessForm() {},
    showAdminSection: section => calls.push(section), updateAlarmButton() {}, bindAdmin() {},
    startSalesShift() {}, armAlarmOnFirstGesture() {}, subscribeAdmin() {}, startAdminPolling() {}, startAlarmLoop() {},
    ensurePresetCategories: () => new Promise(() => {}), renderTableFormQr() {},
    initRemoteStorage: () => calls.push('storage'), startRemoteStoragePolling() {},
    refreshBackgroundReports: async () => true, refreshAdminNow: async () => true });
  vm.runInContext(section('initAdmin', 'resumeRealtimeReception') + ';globalThis.init = initAdmin;', context);
  await context.init();
  assert.ok(calls.indexOf('validated') < calls.indexOf('cache'));
  assert.ok(calls.indexOf('cache') < calls.indexOf('shell'));
  assert.ok(calls.includes('storage'), 'Termina aunque la preparacion de categorias siga pendiente');
  assert.ok(calls.lastIndexOf('accounts') > calls.indexOf('dashboard'));
});

const worker = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
test('Una respuesta remota anterior no reemplaza la busqueda que se sigue tecleando', async () => {
  let query = 'primera', resolveRead, reload;
  const state = { incomeRequestId: 0, incomeLoading: false, syncFresh: {} };
  const context = vm.createContext({ state, Date, navigator: { onLine: true },
    $: () => ({}), canAccessAdminSection: () => true,
    incomeFiltersFromForm: () => ({ dateFrom: '2026-10-10', dateTo: '2026-10-10', query, saleType: 'all' }),
    readAppsScriptOutbox: () => [], readLocalJson: () => null, INCOME_REPORT_CACHE_KEY: 'sales',
    localIncomeReport: filters => ({ records: [], filters }), renderIncomeReport() {}, setIncomeReportStatus() {},
    isAppsScriptConfigured: () => true, APPS_SCRIPT_TIMEOUT_MS: 45000,
    appsScriptRequest: () => new Promise(resolve => { resolveRead = resolve; }),
    mergeIncomeReport: (report, filters) => ({ ...report, filters }),
    persistDurableJson: async () => true, updateGlobalSyncStatus: async () => true,
    window: { setTimeout: callback => { reload = callback; } } });
  vm.runInContext(section('loadIncomeReport', 'refreshBackgroundReports') + ';globalThis.load = loadIncomeReport;', context);
  const first = context.load();
  query = 'segunda';
  await context.load();
  const preview = { records: [{ saleId: 'preview-segunda' }] };
  state.incomeReport = preview;
  resolveRead({ ok: true, records: [{ saleId: 'resultado-primera' }], totalRecords: 1, totals: {} });
  await first;
  assert.equal(state.incomeReport, preview);
  assert.equal(typeof reload, 'function');
  const latest = context.load();
  resolveRead({ ok: true, records: [{ saleId: 'resultado-segunda' }], totalRecords: 1, totals: {} });
  await latest;
  assert.equal(state.incomeReport.records[0].saleId, 'resultado-segunda');
  assert.equal(state.incomeReport.filters.query, 'segunda');
});

if (worker.includes('const APP_ASSET_CACHE =')) test('Recargar reutiliza la misma version y una version nueva descarga el archivo correcto', async () => {
  const handlers = {}, cache = new Map();
  let fetches = 0;
  const context = vm.createContext({ URL, Response,
    self: { location: { origin: 'https://tienda.test' }, addEventListener: (name, fn) => handlers[name] = fn },
    caches: { open: async () => ({ match: async request => cache.get(request.url), put: async (request, response) => cache.set(request.url, response) }) },
    fetch: async () => { fetches++; return new Response('app-v' + fetches); } });
  vm.runInContext(worker, context);
  const read = async version => {
    let response;
    handlers.fetch({ request: { method: 'GET', destination: 'script', url: 'https://tienda.test/app.js?v=' + version }, respondWith: promise => response = promise });
    return (await response).clone().text();
  };
  assert.equal(await read('1'), 'app-v1');
  assert.equal(await read('1'), 'app-v1');
  assert.equal(fetches, 1);
  assert.equal(await read('2'), 'app-v2');
  assert.equal(fetches, 2);
  let intercepted = false;
  handlers.fetch({ request: { method: 'POST', url: 'https://db.test/rpc/pay' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
});
