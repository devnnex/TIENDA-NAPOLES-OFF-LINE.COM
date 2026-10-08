const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};
const calls = [];
let listener, interval, finishCore;
const coreRead = new Promise((resolve) => { finishCore = resolve; });
const context = vm.createContext({
  state: { page: "admin", currentUser: { id: "staff" }, activeAdminSection: "inventory" },
  navigator: { serviceWorker: { addEventListener: (name, callback) => { listener = callback; } } },
  window: { clearInterval() {}, setInterval: (callback, delay) => { interval = { callback, delay }; } },
  notifyAdminPeers: () => calls.push("peers"),
  refreshCoreNow: () => { calls.push("core"); return coreRead; },
  refreshAdminNow: async () => { calls.push("accounts"); },
  flushAppsScriptOutbox: async () => { calls.push("inventory-write"); },
  refreshRemoteStorageNow: async () => { calls.push("inventory-read"); },
  isBoss: () => false,
  showAdminSection: () => calls.push("render"),
  console
});
vm.runInContext(`${source.match(/^const REMOTE_STORAGE_POLL_MS = \d+;/m)[0]}
${section("  const startRemoteStoragePolling =", "  const queueInventoryUpsert =")}
${section('    navigator.serviceWorker?.addEventListener("message",', '    if (!connect())')}
globalThis.startPolling = startRemoteStoragePolling;`, context);

(async () => {
  context.startPolling();
  assert.equal(interval.delay, 5000, "Inventario consulta el respaldo cada cinco segundos.");
  interval.callback();
  assert.deepEqual(calls, ["inventory-read"]);
  calls.length = 0;
  listener({ data: { type: "OFFLINE_QUEUE_FLUSHED" } });
  assert.deepEqual(calls, ["peers", "inventory-write", "core"],
    "El envío de inventario comienza sin esperar la lectura de catálogo ni de cuentas.");
  finishCore(true);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["peers", "inventory-write", "core", "accounts", "inventory-write", "inventory-read", "render"],
    "Las lecturas y la actualización de las demás secciones continúan.");
  console.log("PASS inventario: respaldo de cinco segundos y envío inmediato sin bloquear las otras secciones");
})().catch((error) => { console.error(error); process.exitCode = 1; });
