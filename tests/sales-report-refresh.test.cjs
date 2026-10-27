const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const start = source.indexOf("  const refreshBackgroundReports =");
const end = source.indexOf(source.includes("  const resetSectionData =") ? "  const resetSectionData =" : "  const loadMoreIncomeRecords =", start);
assert.ok(start >= 0 && end > start);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness() {
  const income = deferred(), movements = deferred(), calls = [], timers = [];
  const state = { currentUser: { id: "staff" }, backgroundReportSyncBusy: false, backgroundReportCheckedAt: 0,
    incomeReport: { records: [] }, incomeLoading: false, incomeRevision: "same", movementRevision: "same", movementLoaded: true, inventoryMovements: [],
    incomeFetchedAt: Date.now(), activeAdminSection: "income" };
  const context = vm.createContext({ state, navigator: { onLine: true }, Date, SYNC_INTERVAL_MS: 1500,
    isAppsScriptConfigured: () => true, canAccessAdminSection: () => true, $: () => null,
    window: { setTimeout(callback) { timers.push(callback); } }, readAppsScriptOutbox: () => [],
    readAppsScriptStatus: async () => { calls.push("status"); return { ok: true, historyRevision: "same", movementRevision: "same" }; },
    appsScriptRequest: async action => { assert.equal(action, "status"); calls.push("status"); return { ok: true, historyRevision: "same", movementRevision: "same" }; },
    loadIncomeReport: options => { calls.push(["income", options]); return income.promise; },
    loadInventoryMovements: options => { calls.push(["movements", options]); return movements.promise; },
    syncInventoryWithAppsScript: async () => { calls.push("inventory"); return true; }, renderPurchaseHistory() {}
  });
  vm.runInContext(source.slice(start, end) + ";globalThis.refresh=refreshBackgroundReports;", context);
  return { state, calls, timers, income, movements, context };
}

test("un aviso confirmado consulta ventas y movimientos en paralelo sin esperar status", async () => {
  const h = harness(), reading = h.context.refresh({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.includes("status"), false);
  assert.deepEqual(h.calls.filter(Array.isArray).map(call => call[0]).sort(), ["income", "movements"]);
  assert.equal(h.calls.find(call => call[0] === "income")[1].force, true);
  assert.equal(h.calls.find(call => call[0] === "movements")[1].force, true);
  h.income.resolve(true); h.movements.resolve(true); assert.equal(await reading, true);
});

test("un aviso durante una lectura queda pendiente para una nueva consulta", async () => {
  const h = harness(), reading = h.context.refresh({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  await h.context.refresh({ force: true });
  h.income.resolve(true); h.movements.resolve(true); await reading;
  assert.equal(h.timers.length, 1);
  h.timers.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === "income").length, 2);
});

test("la consulta periodica conserva el control por revision y offline conserva los datos", async () => {
  const h = harness();
  h.state.inventoryRevision = "same"; h.state.appsScriptInventoryRevision = "same";
  await h.context.refresh();
  assert.deepEqual(h.calls, ["status"]);
  h.context.navigator.onLine = false; await h.context.refresh({ force: true });
  assert.deepEqual(h.calls, ["status"]);
});

if (source.includes('state.syncFresh?.sales === false')) test("un informe local en cero vuelve a consultar sin depender de que status cambie o responda", async () => {
  const h = harness();
  h.state.incomeReport = { records: [], localOnly: true };
  h.state.incomeFetchedAt = 0;
  h.context.readAppsScriptStatus = async () => { throw Error('status no disponible'); };
  const loading = h.context.refresh();
  assert.equal(h.calls[0][0], 'income');
  assert.equal(h.calls[0][1].force, true);
  h.income.resolve(true);
  assert.equal(await loading, true);
  assert.equal(h.calls.length, 1);
});

test("un aviso no espera una consulta de status que todavia no ha respondido", async () => {
  const h=harness(), status=deferred();
  const waiting=()=>{h.calls.push("status");return status.promise;};
  h.context.readAppsScriptStatus=waiting;h.context.appsScriptRequest=waiting;
  const polling=h.context.refresh();await new Promise(resolve=>setImmediate(resolve));
  const confirmed=h.context.refresh({force:true});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.filter(Array.isArray).map(call=>call[0]).sort(),["income","movements"]);
  h.income.resolve(true);h.movements.resolve(true);await confirmed;
  status.resolve({ok:true,historyRevision:"same",movementRevision:"same"});await polling;
});

test("movimientos comienza a consultar aunque una lectura anterior de inventario siga pendiente", async () => {
  const previous=deferred(), calls=[];
  const from=source.indexOf("  let inventoryPeerRefreshPending =");
  const to=source.indexOf(source.includes("  let reconnectSyncPromise =")?"  let reconnectSyncPromise =":"  const queueInventoryUpsert =",from);
  const context=vm.createContext({state:{currentUser:{id:"staff"},activeAdminSection:"movements"},navigator:{onLine:true},isAppsScriptConfigured:()=>true,
    inventoryReadPromise:previous.promise,inventorySyncPromise:previous.promise,
    loadInventoryMovements:async()=>{calls.push("movements");return true;},syncInventoryWithAppsScript:async()=>{calls.push("inventory");return true;}});
  vm.runInContext(source.slice(from,to)+";globalThis.refresh=refreshInventoryFromPeer;",context);
  const reading=context.refresh();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,["movements"]);
  context.inventoryReadPromise=null;context.inventorySyncPromise=null;previous.resolve(true);await reading;
  assert.deepEqual(calls,["movements","inventory"]);
});
