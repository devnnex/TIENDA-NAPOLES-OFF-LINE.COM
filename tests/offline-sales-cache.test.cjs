const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = source.indexOf("  const loadIncomeReport =");
const end = source.indexOf("  const refreshBackgroundReports =", start);
assert.ok(start > 0 && end > start, "No se encontró la carga de ventas.");

const filters = { dateFrom: "2026-10-05", dateTo: "2026-10-05", paymentMethod: "all", query: "", limit: 300 };
const report = { records: [{ saleId: "sale-1", date: "2026-10-05" }], totals: { income: 1000, sales: 1 }, revision: "rev-1" };
const state = {
  incomeLoading: false,
  incomeReloadRequested: false,
  incomeRequestId: 0,
  incomeReport: null,
  incomeRevision: "",
  incomeVisibleCount: 60,
  activeAdminSection: "income",
  syncFresh: { sales: false }
};
let serverRevision = "rev-1";
let statusReachable = true;
let statusReads = 0;
let fullReads = 0;
const context = vm.createContext({
  state,
  navigator: { onLine: true },
  $: () => ({}),
  canAccessAdminSection: () => true,
  incomeFiltersFromForm: () => filters,
  readAppsScriptOutbox: () => [],
  readLocalJson: () => ({ filters, report }),
  mergeIncomeReport: (remote, currentFilters) => ({ ...remote, filters: currentFilters }),
  localIncomeReport: (currentFilters) => ({ filters: currentFilters, records: [], totals: {} }),
  renderIncomeReport: () => undefined,
  setIncomeReportStatus: () => undefined,
  isAppsScriptConfigured: () => true,
  readAppsScriptStatus: async () => {
    statusReads += 1;
    if (!statusReachable) throw new Error("offline");
    return { ok: true, historyRevision: serverRevision };
  },
  appsScriptRequest: async () => {
    fullReads += 1;
    return { ok: true, records: report.records, totals: report.totals, revision: serverRevision };
  },
  persistDurableJson: async () => true,
  updateGlobalSyncStatus: async () => undefined,
  toast: () => undefined,
  window: { setTimeout },
  INCOME_REPORT_CACHE_KEY: "test-income",
  APPS_SCRIPT_TIMEOUT_MS: 45000
});
vm.runInContext(`${source.slice(start, end)}\n;globalThis.loadIncomeReport = loadIncomeReport;`, context);

(async () => {
  assert.equal(await context.loadIncomeReport({ background: true }), true);
  assert.equal(statusReads, 1);
  assert.equal(fullReads, 0, "Una revisión sin cambios no debe releer todas las ventas.");
  assert.equal(state.syncFresh.sales, true);

  serverRevision = "rev-2";
  assert.equal(await context.loadIncomeReport({ background: true }), true);
  assert.equal(fullReads, 1, "Una revisión nueva debe descargar el informe.");
  assert.equal(state.incomeRevision, "rev-2");

  context.navigator.onLine = false;
  statusReachable = false;
  assert.equal(await context.loadIncomeReport(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fullReads, 1, "Sin conexión, Ventas debe responder desde la copia local.");
  assert.equal(state.syncFresh.sales, false);

  statusReachable = true;
  assert.equal(await context.loadIncomeReport(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fullReads, 2, "Si el navegador informa offline por error, la comprobación real debe actualizar Ventas.");
  assert.equal(state.syncFresh.sales, true);
  console.log("4/4 escenarios de caché, revisión y Ventas offline aprobados");
})().catch((error) => { console.error(error); process.exitCode = 1; });
