const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const helpersStart = source.indexOf("  const isSupabaseWriteBlockingJob =");
const helpersEnd = source.indexOf("  const startOfflineSyncPulse =", helpersStart);
const runnerStart = source.indexOf("  const runAppsScriptOutbox =");
const runnerEnd = source.indexOf("  const flushAppsScriptOutbox =", runnerStart);
assert.ok(helpersStart > 0 && helpersEnd > helpersStart && runnerStart > 0 && runnerEnd > runnerStart);

const state = { localSupabaseWrites: 0, appsScriptOutboxBusy: false, appsScriptOutboxTimer: null };
let jobs = [];
let status = {};
let sent = [];
let retryScheduled = false;
let requestFailure = false;
const context = vm.createContext({
  state,
  Date,
  performance,
  clearTimeout,
  window: { setTimeout: () => { retryScheduled = true; return 1; } },
  scheduleAppsScriptRetry: () => { retryScheduled = true; },
  appsScriptRetryDelay: () => 1000,
  isAppsScriptConfigured: () => true,
  flushDurableWrites: async () => true,
  getOfflineSyncStatus: async () => status,
  readAppsScriptOutbox: () => structuredClone(jobs),
  writeAppsScriptOutbox: async (updated) => { jobs = structuredClone(updated); return true; },
  setInventorySyncStatus: () => undefined,
  recordSyncEvent: () => undefined,
  appsScriptRequest: async (action, payload) => {
    sent.push({ action, payload });
    if (requestFailure) throw new Error("offline");
    return { ok: true, items: [] };
  },
  applyRemoteInventoryItems: () => undefined,
  updateGlobalSyncStatus: async () => undefined,
  toast: () => undefined,
  normalizeText: (value) => String(value),
  APPS_SCRIPT_TIMEOUT_MS: 45000
});
vm.runInContext(`${source.slice(helpersStart, helpersEnd)}\n${source.slice(runnerStart, runnerEnd)}
;globalThis.testApi = { isSupabaseWriteBlockingJob, nextReadyAppsScriptJob, runAppsScriptOutbox };`, context);

const sale = (id, sessionId, productId = "product-1") => ({
  id,
  operationId: id,
  action: "record_sale",
  status: "pending",
  nextAttemptAt: 0,
  payload: { invoice: { id, sessionId, items: [{ menu_item_id: productId }] } }
});
const blocked = (entity, recordIds = [], sessionIds = [], entryStatus = "failed") => ({
  entity, recordIds, sessionIds, status: entryStatus
});
const counts = (...records) => ({
  pending: records.filter((entry) => entry.status === "pending").length,
  failed: records.filter((entry) => entry.status === "failed").length,
  conflict: records.filter((entry) => entry.status === "conflict").length,
  syncing: records.filter((entry) => entry.status === "syncing").length,
  blockingRecords: records
});
const reset = (nextJobs, nextStatus) => {
  jobs = structuredClone(nextJobs);
  status = nextStatus;
  sent = [];
  retryScheduled = false;
  requestFailure = false;
  state.localSupabaseWrites = 0;
};

(async () => {
  const ownSale = sale("sale-1", "session-1");
  reset([ownSale], counts(blocked("table_sessions", ["other-session"])));
  assert.equal(await context.testApi.runAppsScriptOutbox(), true);
  assert.deepEqual(sent.map((entry) => entry.action), ["record_sale"]);
  assert.equal(jobs.length, 0, "La venta confirmada sale de la cola local.");

  reset([ownSale], counts(blocked("table_sessions", ["session-1"])));
  assert.equal(await context.testApi.runAppsScriptOutbox(), false);
  assert.equal(sent.length, 0, "La misma mesa debe llegar a Supabase primero.");
  assert.equal(retryScheduled, true);

  reset([ownSale], counts(blocked("session_items", ["line-1"], ["session-1"])));
  assert.equal(context.testApi.isSupabaseWriteBlockingJob(ownSale, status), true);
  reset([ownSale], counts(blocked("service_requests", ["call-1"], ["other-session"])));
  assert.equal(context.testApi.isSupabaseWriteBlockingJob(ownSale, status), false);
  reset([ownSale], counts(blocked("menu_items", ["product-1"])));
  assert.equal(context.testApi.isSupabaseWriteBlockingJob(ownSale, status), true);
  reset([ownSale], counts(blocked("menu_items", ["other-product"])));
  assert.equal(context.testApi.isSupabaseWriteBlockingJob(ownSale, status), false);
  reset([ownSale], counts(blocked("table_sessions")));
  assert.equal(context.testApi.isSupabaseWriteBlockingJob(ownSale, status), true,
    "Una referencia antigua sin ID no puede declararse independiente.");

  reset([sale("sale-blocked", "session-1"), sale("sale-ready", "session-2")],
    counts(blocked("table_sessions", ["session-1"])));
  assert.equal(await context.testApi.runAppsScriptOutbox(), false);
  assert.deepEqual(sent.map((entry) => entry.payload.invoice.id), ["sale-ready"]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "sale-blocked");

  reset([ownSale], counts(blocked("table_sessions", ["other-session"])));
  state.localSupabaseWrites = 1;
  assert.equal(await context.testApi.runAppsScriptOutbox(), false);
  assert.equal(sent.length, 0, "El cobro local en curso conserva su orden.");

  reset([ownSale], counts());
  requestFailure = true;
  assert.equal(await context.testApi.runAppsScriptOutbox(), false);
  assert.equal(jobs[0].status, "pending", "Una caída de red conserva la venta en la cola.");
  requestFailure = false;
  assert.equal(await context.testApi.runAppsScriptOutbox(true), true);
  assert.equal(jobs.length, 0, "Al volver internet se confirma la misma venta sin crear otra.");

  console.log("9/9 escenarios de dependencias y envío de ventas aprobados");
})().catch((error) => { console.error(error); process.exitCode = 1; });
