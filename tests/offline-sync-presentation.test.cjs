const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const statusStart = source.indexOf("  const setGlobalSyncStatus =");
const statusEnd = source.indexOf("  const isSupabaseWriteBlockingJob =", statusStart);
const pinStart = source.indexOf("  const resetUserFormPresentation =");
const pinEnd = source.indexOf("  const toggleUserAccess =", pinStart);
assert.ok(statusStart > 0 && statusEnd > statusStart && pinStart > 0 && pinEnd > pinStart);

const badge = { hidden: true, dataset: {}, title: "", className: "", innerHTML: "" };
const navigator = { onLine: true };
let now = 1000;
let pendingTimer = null;
let queueStatus = { controllerAvailable: true, pending: 2, syncing: 0, failed: 0, conflict: 0, issues: [] };
const statusContext = vm.createContext({
  $: (selector) => selector === "#globalSyncStatus" ? badge : null,
  navigator,
  Date: { now: () => now },
  window: {
    setTimeout: (callback, delay) => { pendingTimer = { callback, delay }; return 1; },
    clearTimeout: () => { pendingTimer = null; }
  },
  icon: (name) => name,
  escapeHTML: (value) => value,
  refreshIcons: () => undefined,
  getOfflineSyncStatus: async () => queueStatus,
  flushDurableWrites: async () => true,
  readAppsScriptOutbox: () => []
});
vm.runInContext(`${source.slice(statusStart, statusEnd)}
;globalThis.testStatus = { updateGlobalSyncStatus, syncBadgeDisplayPhase };`, statusContext);

const toggle = {
  title: "Mostrar PIN",
  innerHTML: "",
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = value; },
  closest() { return form; }
};
const pin = { type: "password" };
const form = {
  pin,
  elements: { pin },
  querySelector(selector) { return selector === "[data-toggle-user-pin]" ? toggle : null; }
};
const pinContext = vm.createContext({
  $: () => form,
  icon: (name) => name,
  refreshIcons: () => undefined
});
vm.runInContext(`${source.slice(pinStart, pinEnd)}
;globalThis.testPin = { toggleUserPinVisibility, resetUserPinVisibility };`, pinContext);

(async () => {
  await statusContext.testStatus.updateGlobalSyncStatus();
  assert.equal(badge.hidden, true, "Al abrir con internet no se muestra un contador interno.");

  navigator.onLine = false;
  await statusContext.testStatus.updateGlobalSyncStatus();
  assert.equal(badge.hidden, false);
  assert.match(badge.innerHTML, /Sin conexión · listo para sincronizar/);
  assert.doesNotMatch(badge.innerHTML, /Sincronizando|\b2\b/);

  navigator.onLine = true;
  now = 2000;
  await statusContext.testStatus.updateGlobalSyncStatus();
  assert.match(badge.innerHTML, /Conexión restablecida/);
  assert.equal(pendingTimer.delay, 60000);

  now = 62000;
  await statusContext.testStatus.updateGlobalSyncStatus();
  assert.match(badge.innerHTML, /Sincronizado/);
  assert.match(badge.className, /is-synced/);
  await statusContext.testStatus.updateGlobalSyncStatus();
  assert.match(badge.innerHTML, /Sincronizado/, "El verde permanece hasta una nueva desconexión.");

  navigator.onLine = false;
  await statusContext.testStatus.updateGlobalSyncStatus();
  assert.match(badge.innerHTML, /Sin conexión/);

  queueStatus = { ...queueStatus, failed: 1, issues: [{ entity: "record_sale", status: "failed", error: "rechazada" }] };
  await statusContext.testStatus.updateGlobalSyncStatus();
  assert.match(badge.innerHTML, /Error de sincronización/,
    "Una falla real no se oculta detrás del estado visual.");

  assert.match(html, /data-toggle-user-pin aria-label="Mostrar PIN"/);
  assert.match(css, /\.user-pin-toggle \{/);
  pinContext.testPin.toggleUserPinVisibility(toggle);
  assert.equal(pin.type, "text");
  assert.equal(toggle.attributes["aria-label"], "Ocultar PIN");
  pinContext.testPin.toggleUserPinVisibility(toggle);
  assert.equal(pin.type, "password");
  pinContext.testPin.toggleUserPinVisibility(toggle);
  pinContext.testPin.resetUserPinVisibility(form);
  assert.equal(pin.type, "password");
  assert.equal(toggle.attributes["aria-label"], "Mostrar PIN");

  console.log("8/8 escenarios visuales de conexión y PIN aprobados");
})().catch((error) => { console.error(error); process.exitCode = 1; });
