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
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = (jobs = []) => {
  const state = { currentUser: { id: "staff" }, appsScriptOutboxBusy: false,
    remoteStorageSyncBusy: false, activeAdminSection: "inventory", syncFresh: {},
    items: [{ id: "a", price: 100 }, { id: "b", price: 100 }],
    inventoryMeta: { a: { stock: 10, updatedAt: "local-a" }, b: { stock: 10, updatedAt: "local-b" } } };
  const remote = [{ productId: "a", stock: 7, updatedAt: "remote-a", version: 2 },
    { productId: "b", stock: 4, updatedAt: "remote-b", version: 3 }];
  const calls = [], labels = [];
  let writeGate = null, readGate = null, failRead = false;
  const context = vm.createContext({
    state, Date, Map, Set, $: () => null,
    readAppsScriptOutbox: () => structuredClone(jobs),
    isAppsScriptConfigured: () => true,
    productAcronym: () => "P",
    persistInventoryStore() {}, persistBootstrapCache() {}, renderInventory() {}, renderMenuManager() {},
    setInventorySyncStatus: (label) => labels.push(label),
    updateGlobalSyncStatus: async () => true,
    appsScriptRequest: async (action) => {
      calls.push(action);
      if (readGate) await readGate.promise;
      if (failRead) throw new Error("Sin red");
      return { ok: true, items: structuredClone(remote) };
    },
    flushAppsScriptOutbox: async () => { calls.push("write"); if (writeGate) await writeGate.promise; return true; }
  });
  vm.runInContext(`${section("  const isPendingInventoryJob =", "  const enqueueAppsScriptJob =")}
${section("  let inventoryReadPromise =", "  let reconnectSyncPromise =")}
globalThis.api = { syncInventoryWithAppsScript, refreshRemoteStorageNow };`, context);
  return { state, jobs, remote, calls, labels, api: context.api,
    setWriteGate: (gate) => { writeGate = gate; }, setReadGate: (gate) => { readGate = gate; },
    fail: (value) => { failRead = value; } };
};

(async () => {
  const unrelated = fixture([{ id: "history", action: "clear_income", status: "pending" }]);
  unrelated.setWriteGate(deferred());
  const read = unrelated.api.refreshRemoteStorageNow();
  await new Promise(setImmediate);
  assert.deepEqual(unrelated.calls, ["write", "get_inventory"], "Lee inventario sin esperar el envío de otra sección.");
  assert.equal(await read, true);
  assert.equal(unrelated.state.inventoryMeta.a.stock, 7);
  assert.equal(unrelated.labels.at(-1), "Inventario sincronizado", "Un pendiente de otra sección no se cuenta como inventario.");

  const busy = fixture();
  busy.state.appsScriptOutboxBusy = true;
  assert.equal(await busy.api.refreshRemoteStorageNow(), true, "Consulta el backend mientras la cola está ocupada.");
  assert.equal(busy.state.inventoryMeta.b.stock, 4);

  for (const status of ["failed", "conflict"]) {
    const rejected = fixture([{ id: "old", action: "upsert_inventory", status, payload: { item: { productId: "a", stock: 10 } } }]);
    const previousJobs = structuredClone(rejected.jobs);
    assert.equal(await rejected.api.syncInventoryWithAppsScript(), true);
    assert.equal(rejected.state.inventoryMeta.a.stock, 7, "Un cambio rechazado no congela las existencias actuales.");
    assert.equal(rejected.labels.at(-1), "Inventario sincronizado");
    assert.deepEqual(rejected.jobs, previousJobs, "Conserva el registro de la operación rechazada.");
  }

  const pending = fixture([{ id: "local", action: "set_inventory_stock", status: "pending", payload: { productId: "a", stock: 10 } }]);
  assert.equal(await pending.api.syncInventoryWithAppsScript(), true);
  assert.equal(pending.state.inventoryMeta.a.stock, 10, "Protege la modificación local que aún debe enviarse.");
  assert.equal(pending.state.inventoryMeta.b.stock, 4, "Los otros productos reciben los cambios de BCA.");
  assert.match(pending.labels.at(-1), /1 cambio pendiente/);

  const initial = fixture([{ id: "initial", action: "sync_inventory", status: "pending", payload: { items: [{ productId: "a" }] } }]);
  assert.equal(await initial.api.syncInventoryWithAppsScript(), true, "Una carga inicial pendiente permite consultar el backend.");
  assert.equal(initial.state.inventoryMeta.a.stock, 10);
  assert.equal(initial.state.inventoryMeta.b.stock, 4);

  const concurrent = fixture(), gate = deferred();
  concurrent.setReadGate(gate);
  const inflight = concurrent.api.syncInventoryWithAppsScript();
  concurrent.state.inventoryMeta.a = { stock: 6, updatedAt: "newly-confirmed" };
  gate.resolve();
  await inflight;
  assert.equal(concurrent.state.inventoryMeta.a.stock, 6, "Una lectura anterior no pisa una escritura recién confirmada.");
  assert.equal(concurrent.state.inventoryMeta.b.stock, 4);

  const reconnect = fixture();
  reconnect.fail(true);
  assert.equal(await reconnect.api.syncInventoryWithAppsScript(), false);
  assert.equal(reconnect.state.inventoryMeta.a.stock, 10);
  reconnect.fail(false);
  assert.equal(await reconnect.api.syncInventoryWithAppsScript(), true);
  assert.equal(reconnect.state.inventoryMeta.a.stock, 7, "Al volver internet recibe las existencias actuales.");
  console.log("PASS inventario actual: lecturas independientes, pendientes propios, rechazados sin congelar datos y reconexión");
})().catch((error) => { console.error(error); process.exitCode = 1; });
