const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `No se encontro ${start}`);
  return source.slice(from, to);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

(async () => {
  const calls = [];
  const reads = {
    sales: deferred(), inventory: deferred(), movements: deferred()
  };
  let statusGate = null;
  let historyRevision = "new-sales";
  let movementRevision = "new-movements";
  const state = {
    incomeLoading: false,
    incomeReport: { records: [] },
    incomeRevision: "old-sales",
    inventoryRevision: "old-movements",
    movementRevision: "old-movements",
    incomeFetchedAt: Date.now(),
    backgroundReportSyncBusy: false,
    backgroundReportCheckedAt: 0
  };
  const context = vm.createContext({
    state,
    navigator: { onLine: true },
    canAccessAdminSection: () => true,
    isAppsScriptConfigured: () => true,
    readAppsScriptStatus: async () => {
      calls.push("status");
      if (statusGate) return statusGate.promise;
      return { ok: true, historyRevision, movementRevision };
    },
    readAppsScriptOutbox: () => [],
    loadIncomeReport: () => { calls.push("sales"); return reads.sales.promise; },
    syncInventoryWithAppsScript: () => { calls.push("inventory"); return reads.inventory.promise; },
    loadInventoryMovements: () => { calls.push("movements"); return reads.movements.promise; },
    window: { setTimeout },
    Date
  });
  vm.runInContext(`${section("  const refreshBackgroundReports =", "  const resetSectionData =")}
globalThis.refreshBackgroundReports = refreshBackgroundReports;`, context);
  const refresh = context.refreshBackgroundReports();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["status", "sales", "inventory", "movements"], "Las tres lecturas comienzan juntas.");
  reads.movements.resolve(true);
  reads.inventory.resolve(true);
  reads.sales.resolve(true);
  assert.equal(await refresh, true);
  assert.equal(state.inventoryRevision, "new-movements");
  assert.equal(state.backgroundReportSyncBusy, false);
  state.incomeRevision = historyRevision;
  state.movementRevision = movementRevision;
  assert.equal(await context.refreshBackgroundReports(), false, "Se evita repetir peticiones durante cinco segundos.");
  assert.equal(calls.filter((call) => call === "status").length, 1);
  statusGate = deferred();
  const inFlight = context.refreshBackgroundReports({ force: true });
  await new Promise(setImmediate);
  assert.equal(await context.refreshBackgroundReports({ force: true }), false);
  assert.equal(state.backgroundReportForcePending, true, "La reconexion concurrente queda pendiente.");
  statusGate.resolve({ ok: true, historyRevision, movementRevision });
  await inFlight;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.filter((call) => call === "status").length, 3, "La revision forzada se repite tras la lectura activa.");
  statusGate = null;
  historyRevision = "sale-burst";
  movementRevision = "movement-burst";
  await context.refreshBackgroundReports({ force: true });
  assert.equal(calls.filter((call) => call === "sales").length, 2, "Una venta posterior genera nueva lectura.");
  assert.equal(calls.filter((call) => call === "inventory").length, 2);
  assert.equal(calls.filter((call) => call === "movements").length, 2);

  const reconnectCalls = [];
  const outbox = deferred();
  const reconnectReads = {
    sales: deferred(), inventory: deferred(), movements: deferred()
  };
  const reconnectState = {
    page: "admin", activeAdminSection: "income", syncFresh: {}, startupSyncComplete: false
  };
  const reconnectContext = vm.createContext({
    state: reconnectState,
    performance,
    navigator: { onLine: true },
    recordSyncEvent: () => undefined,
    refreshCoreNow: async () => { reconnectCalls.push("core"); return true; },
    getOfflineSyncStatus: async () => ({ controllerAvailable: true }),
    flushOfflineQueue: async () => { reconnectCalls.push("offline-outbox"); return true; },
    refreshAdminNow: async () => { reconnectCalls.push("admin"); return true; },
    flushAppsScriptOutbox: () => { reconnectCalls.push("appscript-outbox"); return outbox.promise; },
    syncInventoryWithAppsScript: () => { reconnectCalls.push("inventory"); return reconnectReads.inventory.promise; },
    loadInventoryMovements: () => { reconnectCalls.push("movements"); return reconnectReads.movements.promise; },
    loadIncomeReport: () => { reconnectCalls.push("sales"); return reconnectReads.sales.promise; },
    refreshBackgroundReports: () => { reconnectCalls.push("verify-revisions"); return Promise.resolve(false); },
    flushPeerRefreshes: () => Promise.resolve(),
    isManager: () => true,
    canAccessAdminSection: () => true,
    isBoss: () => false,
    showAdminSection: () => undefined,
    requiredSyncDomains: () => [],
    readAppsScriptOutbox: () => [],
    updateGlobalSyncStatus: () => Promise.resolve()
  });
  vm.runInContext(`${section("  let reconnectSyncPromise =", "  const startRemoteStoragePolling =")}
globalThis.synchronizeAfterReconnect = synchronizeAfterReconnect;`, reconnectContext);
  const reconnect = reconnectContext.synchronizeAfterReconnect();
  await new Promise(setImmediate);
  assert.equal(reconnectCalls.includes("sales"), true, "Las ventas actuales se consultan mientras la cola sigue en curso.");
  assert.equal(reconnectCalls.includes("inventory"), true);
  assert.equal(reconnectCalls.includes("movements"), true);
  assert.equal(reconnectCalls.includes("admin"), true);
  outbox.resolve(true);
  await new Promise(setImmediate);
  assert.deepEqual(reconnectCalls.slice(-4), ["appscript-outbox", "inventory", "movements", "sales"]);
  reconnectReads.movements.resolve(true);
  reconnectReads.sales.resolve(true);
  reconnectReads.inventory.resolve(true);
  assert.equal(await reconnect, true);
  assert.equal(reconnectCalls.includes("verify-revisions"), true);

  console.log("Actualizacion paralela y reconciliacion posterior al envio pendientes OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
