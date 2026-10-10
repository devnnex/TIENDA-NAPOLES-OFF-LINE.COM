const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf('  const ' + from + ' ='), source.indexOf('  const ' + to + ' =', source.indexOf('  const ' + from + ' =') + 1));
function salesContext(overrides = {}) {
  const context = vm.createContext({ state: { tables: [], invoiceHistory: [], incomeRequestId: 1 },
    normalizeText: value => String(value).toLowerCase().trim(), tableLabel: table => table.table_name || `Mesa ${table.table_number}`,
    APPS_SCRIPT_TIMEOUT_MS: 1000, ...overrides });
  vm.runInContext(section('servicePointKind', 'isServicePoint') + section('incomeSaleTypeLabel', 'incomePaymentLabel')
    + section('incomeTotalsFromRecords', 'localIncomeRecords')
    + ';globalThis.api = {incomeRecordSaleType, filterIncomeReportBySaleType, completeIncomeSaleTypeReport, applyIncomeSaleTypeFilter, incomeSaleTypeFiltersKey};', context);
  return context;
}
test('Distingue ventas individuales, mesas, barras y materas, incluso al editar la etiqueta individual', () => {
  const f = salesContext();
  f.state.invoiceHistory = [{ id: 'edited', saleChannel: 'walk_in' }];
  f.state.tables = [{ id: 'bar', table_name: 'Terraza 1', qr_code: 'interno-bar-1' }];
  for (const [record, expected] of [
    [{ saleChannel: 'walk_in' }, 'walk_in'], [{ table: 'Venta individual' }, 'walk_in'],
    [{ saleId: 'edited', table: 'Cliente Ana' }, 'walk_in'], [{ sessionId: 'walk-in-123' }, 'walk_in'],
    [{ table: 'Mesa 1' }, 'table'], [{ table: 'Barra 1' }, 'bar'],
    [{ tableId: 'bar', table: 'Terraza 1' }, 'bar'], [{ table: 'Matera 2' }, 'planter']
  ]) assert.equal(f.api.incomeRecordSaleType(record), expected);
});
test('El filtro completa varias paginas y calcula importes y medios solamente del tipo seleccionado', async () => {
  const records = Array.from({ length: 650 }, (_, i) => ({ saleId: String(i), date: '2026-10-09',
    table: i % 2 ? 'Mesa 1' : 'Venta individual', total: 100, subtotal: 100,
    payments: [{ method: i % 2 ? 'cash' : 'transfer', amount: 100 }] }));
  const calls = [];
  const f = salesContext({ appsScriptRequest: async (action, { filters }) => {
    calls.push(filters.pageRows.length);
    assert.equal(filters.revision, 'rev-1');
    return { ok: true, intervalApplied: true, records: filters.pageRows.map(row => records[Number(row.saleId)]) };
  } });
  const filters = { saleType: 'walk_in', startAt: '2026-10-09T00:00:00Z' };
  const complete = await f.api.completeIncomeSaleTypeReport({ records: records.slice(0, 100), totalRecords: 650,
    revision: 'rev-1', recordRows: records.map(record => ({ saleId: record.saleId })) }, filters, 1);
  assert.deepEqual(calls, [300, 250]);
  const filtered = f.api.filterIncomeReportBySaleType(complete, filters);
  assert.equal(filtered.totalRecords, 325);
  assert.equal(filtered.totals.income, 32500);
  assert.equal(filtered.totals.transfer, 32500);
  assert.equal(filtered.totals.cash, 0);
  assert.equal(filtered.truncated, false);
});
test('No presenta totales completos si faltan filas o una pagina pertenece a una revision anterior', async () => {
  const f = salesContext({ appsScriptRequest: async () => ({ ok: true, stale: true, records: [] }) });
  const filters = { saleType: 'walk_in' };
  await assert.rejects(f.api.completeIncomeSaleTypeReport({ records: [], totalRecords: 2, recordRows: [] }, filters, 1));
  await assert.rejects(f.api.completeIncomeSaleTypeReport({ records: [], totalRecords: 1, recordRows: [{ saleId: 'x' }] }, filters, 1));
  f.appsScriptRequest = async () => ({ ok: true, records: [] });
  await assert.rejects(f.api.completeIncomeSaleTypeReport({ records: [], totalRecords: 1, recordRows: [{ saleId: 'x' }] }, filters, 1));
});
test('Cancela la paginacion de un filtro reemplazado sin consultar mas paginas', async () => {
  let calls = 0;
  const f = salesContext({ appsScriptRequest: async () => {
    calls++;
    f.state.incomeRequestId = 2;
    return { ok: true, records: [] };
  } });
  const report = { records: [], totalRecords: 650, recordRows: Array.from({ length: 650 }, (_, i) => ({ saleId: String(i) })) };
  assert.equal(await f.api.completeIncomeSaleTypeReport(report, { saleType: 'table' }, 1), report);
  assert.equal(calls, 1);
});
test('Combina las ventas individuales pendientes y remotas con totales exactos', () => {
  const f = salesContext({ SalesShift: { matches: () => true }, readAppsScriptOutbox: () => [
    { action: 'record_sale', payload: { invoice: { id: 'local-individual' } } },
    { action: 'record_sale', payload: { invoice: { id: 'local-table' } } }
  ] });
  f.state.inventoryMeta = {};
  f.state.invoiceHistory = [{ id: 'local-individual', table: 'Cliente', saleChannel: 'walk_in', totals: { total: 15000 }, payments: [{ method: 'cash', amount: 15000 }] },
    { id: 'local-table', table: 'Mesa 2', totals: { total: 30000 }, payments: [{ method: 'cash', amount: 30000 }] }];
  vm.runInContext(section('localIncomeRecords', 'localIncomeReport') + section('mergeIncomeReport', 'setIncomeReportStatus') + ';globalThis.merge = mergeIncomeReport;', f);
  const records = [{ saleId: 'remote-individual', table: 'Venta individual', total: 10000, payments: [{ method: 'transfer', amount: 10000 }] },
    { saleId: 'remote-table', table: 'Mesa 1', total: 50000, payments: [{ method: 'cash', amount: 50000 }] }];
  const filtered = f.merge({ records, totalRecords: 2, recordRows: records.map(record => ({ saleId: record.saleId })) }, { saleType: 'walk_in', paymentMethod: 'all' });
  assert.equal(filtered.totalRecords, 2);
  assert.equal(filtered.totals.income, 25000);
  assert.equal(filtered.totals.cash, 15000);
  assert.equal(filtered.totals.transfer, 10000);
  assert.equal(filtered.pendingCount, 1);
});
test('Cambiar el tipo con historial completo disponible renderiza antes de esperar el respaldo', () => {
  const events = [], filters = { dateFrom: '2026-10-09', dateTo: '2026-10-09', saleType: 'table' };
  const f = salesContext({ incomeFiltersFromForm: () => filters,
    mergeIncomeReport: (report, next) => ({ ...report, filters: next }),
    renderIncomeReport: () => events.push('render'), loadIncomeReport: () => { events.push('network'); return new Promise(() => {}); } });
  f.state.incomeSaleTypeSnapshot = { key: f.api.incomeSaleTypeFiltersKey({ ...filters, saleType: 'walk_in' }), report: { records: [] } };
  f.api.applyIncomeSaleTypeFilter();
  assert.deepEqual(events, ['render', 'network']);
  assert.equal(f.state.incomeReport.filters.saleType, 'table');
});
if (source.includes('INCOME_REPORT_CACHE_KEY')) test('Sin conexion permite cambiar el tipo usando el historial completo guardado', async () => {
  const filters = { dateFrom: '2026-10-09', dateTo: '2026-10-09', paymentMethod: 'all', saleType: 'walk_in' };
  const cached = { filters: { ...filters, saleType: 'all' }, report: { totalRecords: 2, records: [
    { saleId: 'one', table: 'Venta individual', total: 10000, payments: [] },
    { saleId: 'two', table: 'Mesa 1', total: 20000, payments: [] }
  ] } };
  const f = salesContext({ $: () => ({}), canAccessAdminSection: () => true, incomeFiltersFromForm: () => filters,
    readAppsScriptOutbox: () => [], navigator: { onLine: false }, INCOME_REPORT_CACHE_KEY: 'cache',
    readLocalJson: () => cached, readAppsScriptStatus: async () => ({ ok: false }),
    mergeIncomeReport: (report, next) => f.api.filterIncomeReportBySaleType(report, next),
    renderIncomeReport() {}, localIncomeReport() { throw Error('Debe usar las ventas guardadas del respaldo.'); } });
  f.state.syncFresh = {};
  vm.runInContext(section('loadIncomeReport', 'refreshBackgroundReports') + ';globalThis.load = loadIncomeReport;', f);
  assert.equal(await f.load(), true);
  assert.equal(f.state.incomeReport.records.length, 1);
  assert.equal(f.state.incomeReport.records[0].saleId, 'one');
  assert.equal(f.state.incomeReport.totals.income, 10000);
  assert.equal(f.state.incomeReport.localOnly, true);
});
function brandContext() {
  const form = { logo_url: { value: '' }, cover_url: { value: '' } };
  const boxes = Object.fromEntries(['logo_url', 'cover_url'].map(field => [field, {
    classList: { toggle() {} }, querySelector() { return this.preview; }, appendChild(node) { this.preview = node; }
  }]));
  const notices = [];
  const context = vm.createContext({ state: { business: { logo_url: 'old-logo', cover_url: 'old-cover' } },
    $: selector => selector === '#businessForm' ? form : selector.includes('data-upload-box') ? boxes[selector.match(/"([^"]+)"/)[1]] : {},
    document: { createElement: () => ({ getAttribute() { return this.src; }, remove() {} }) },
    uid: () => 'unique', toast: (message, kind) => notices.push({ message, kind }) });
  vm.runInContext(section('renderBrandAssetFields', 'renderBusinessForm') + section('uploadAsset', 'saveTable')
    + ';globalThis.api = {renderBrandAssetFields, clearSavedBrandAssetDrafts, uploadAsset};', context);
  return { context, form, boxes, notices };
}
test('La portada subida conserva su URL y vista previa durante los refrescos de Marca', async () => {
  const f = brandContext();
  f.context.state.sb = { storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'new-cover' } }) }) } };
  await f.context.api.uploadAsset({ name: 'cover.png' }, 'cover_url');
  f.context.api.renderBrandAssetFields(f.form);
  assert.equal(f.form.cover_url.value, 'new-cover');
  assert.equal(f.boxes.cover_url.preview.src, 'new-cover');
  assert.equal(f.form.logo_url.value, 'old-logo');
  f.context.api.clearSavedBrandAssetDrafts({ cover_url: 'old-cover' });
  assert.equal(f.context.state.brandAssetDrafts.cover_url, 'new-cover');
  f.context.api.clearSavedBrandAssetDrafts({ cover_url: 'new-cover' });
  assert.equal(f.context.state.brandAssetDrafts.cover_url, undefined);
});
test('Una subida fallida conserva la imagen anterior y libera el indicador de subida', async () => {
  const f = brandContext();
  f.context.state.sb = { storage: { from: () => ({ upload: async () => ({ error: { message: 'denegado' } }) }) } };
  await f.context.api.uploadAsset({ name: 'cover.png' }, 'cover_url');
  assert.equal(f.context.state.brandAssetUploads.size, 0);
  assert.equal(f.form.cover_url.value, 'old-cover');
  assert.equal(f.notices[0].kind, 'error');
});
test('Guardar Marca durante la subida no guarda una URL incompleta', async () => {
  const f = brandContext();
  f.context.state.brandAssetUploads = new Set(['cover_url']);
  vm.runInContext(section('saveBusiness', 'uploadAsset') + ';globalThis.save = saveBusiness;', f.context);
  assert.equal(await f.context.save(f.form), false);
  assert.equal(f.notices[0].kind, 'error');
});
test('Guardar Marca envia la nueva portada y conserva la imagen confirmada', async () => {
  const f = brandContext(), payloads = [];
  for (const [field, value] of Object.entries({ business_name: 'Tienda', subtitle: '', accent_color: '#f05a28' })) f.form[field] = { value };
  f.form.querySelector = () => null;
  Object.assign(f.context, { DEFAULT_CURRENCY: 'COP', updateTipSettingsFromForm: () => true,
    persistBootstrapCache() {}, renderBrand() {}, renderBusinessForm() {}, renderTables() {}, renderServiceTables() {}, refreshIcons() {},
    applyBusinessTipSettings() {}, normalTables: () => [], isOutdoorTable: () => false, isServicePoint: () => false,
    saveOutdoorTableZonesRemotely: async () => ({ tables: [] }), retryQuiet: async operation => {
      const result = await operation(); return result.data;
    } });
  Object.assign(f.context.state, { tables: [], tipSettings: { enabled: false, percentage: 10 }, brandAssetDrafts: { cover_url: 'new-cover' },
    sb: { from: () => ({ upsert(payload) { payloads.push(payload); return this; }, select() { return this; },
      single: async () => ({ data: { ...payloads[0] } }) }) } });
  f.context.api.renderBrandAssetFields(f.form);
  vm.runInContext(section('saveBusiness', 'uploadAsset') + ';globalThis.save = saveBusiness;', f.context);
  await f.context.save(f.form);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payloads[0].cover_url, 'new-cover');
  assert.equal(f.context.state.business.cover_url, 'new-cover');
  assert.equal(f.context.state.brandAssetDrafts.cover_url, undefined);
});
