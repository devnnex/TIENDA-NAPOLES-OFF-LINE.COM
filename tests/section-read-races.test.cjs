const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Marca, mesas y catalogo conservan altas, cambios y eliminaciones hechos durante una lectura", async () => {
  const response = deferred();
  const snapshot = { business: { id: "brand", business_name: "Antes" }, tables: [{ id: "table", table_name: "Antes" }], categories: [{ id: "category", name: "Bebidas" }], items: [{ id: "product", name: "Antes", price: 1000 }] };
  const state = { ...structuredClone(snapshot), page: "admin", authToken: "valid", activeAdminSection: "dashboard", syncFresh: {}, sb: { rpc: () => response.promise } };
  const context = vm.createContext({ state, Date, URLSearchParams, location: { search: "" }, window: { setTimeout },
    getOfflineSyncStatus: async () => ({ blockingRecords: [] }), setScopedCoreRead: async () => true, dbQuiet: async query => (await query).data,
    applyBusinessTipSettings() {}, persistBootstrapCache() {}, renderBrand() {}, syncTipFeatureVisibility() {}, renderTables() {}, renderServiceTables() {}, renderTableManager() {}, renderMenuManager() {}, renderInventory() {}, renderBusinessForm() {}, updateGlobalSyncStatus() {} });
  vm.runInContext(section("  const mergePendingCoreData =", "  const updateNavRequestBadge =") + ";globalThis.refresh=refreshCoreNow;", context);
  const reading = context.refresh(); await tick();
  state.business = { ...state.business, business_name: "Actual" };
  state.tables = [];
  state.categories.push({ id: "new-category", name: "Nueva" });
  state.items = [{ id: "product", name: "Nombre local", price: 1000 }];
  response.resolve({ data: { ...snapshot, items: [{ id: "product", name: "Antes", price: 9000 }, { id: "peer", name: "Desde BCA" }] } });
  await reading;
  assert.equal(state.business.business_name, "Actual");
  assert.equal(state.tables.length, 0);
  assert.equal(state.categories.filter(row => row.id === "new-category").length, 1);
  assert.equal(state.items.find(row => row.id === "product").name, "Nombre local");
  assert.equal(state.items.find(row => row.id === "product").price, 9000);
  assert.ok(state.items.some(row => row.id === "peer"));
});

function usersHarness() {
  const response = deferred(), boss = { id: "boss", full_name: "Jefe", role: "boss" };
  const state = { users: [boss, { id: "edit", full_name: "Mesero", is_active: true }, { id: "delete", full_name: "Eliminar" }], currentUser: boss, authToken: "valid", syncFresh: {}, sb: { rpc: () => response.promise } };
  const context = vm.createContext({ state, USER_LIST_CACHE_KEY: "users", ADMIN_USER_CACHE_KEY: "current", readLocalJson: () => [], isBoss: () => true, renderUsers() {}, persistUsersCache() {}, applyCurrentUser() {}, updateGlobalSyncStatus() {}, localStorage: { setItem() {} },
    mergeUsers: (...collections) => [...new Map(collections.flat().map(user => [user.id, user])).values()] });
  vm.runInContext(section("  let usersLoadPromise =", "  const renderUsers =") + ";globalThis.load=loadUsers;", context);
  return { state, response, context };
}

test("una lista de usuarios atrasada no restaura una eliminacion ni un acceso editado", async () => {
  const h = usersHarness(), remote = structuredClone(h.state.users);
  const reading = h.context.load(); await tick();
  h.state.users = h.state.users.filter(user => user.id !== "delete").map(user => user.id === "edit" ? { ...user, is_active: false } : user);
  h.state.users.push({ id: "new", full_name: "Nuevo" });
  h.response.resolve({ data: [...remote, { id: "peer", full_name: "Desde BCA" }] }); await reading;
  assert.equal(h.state.users.some(user => user.id === "delete"), false);
  assert.equal(h.state.users.find(user => user.id === "edit").is_active, false);
  assert.equal(h.state.users.filter(user => user.id === "new").length, 1);
  assert.ok(h.state.users.some(user => user.id === "peer"));
});

test("un error de lectura de usuarios conserva cambios realizados mientras se consultaba", async () => {
  const h = usersHarness(), reading = h.context.load(); await tick();
  h.state.users = h.state.users.filter(user => user.id !== "delete");
  h.response.reject(new Error("offline")); await reading;
  assert.equal(h.state.users.some(user => user.id === "delete"), false);
});

function movementHarness() {
  const response = deferred();
  const state = { currentUser: { id: "staff" }, inventoryMovements: [{ movementId: "edit", unitCost: 1 }, { movementId: "delete", unitCost: 1 }], syncFresh: {} };
  const jobs = [], pendingIds = new Set();
  const context = vm.createContext({ state, isAppsScriptConfigured: () => true, appsScriptRequest: () => response.promise, readAppsScriptOutbox: () => jobs, pendingInventoryMovementIds: () => pendingIds,
    persistInventoryMovements() {}, renderInventoryMovements() {}, updateGlobalSyncStatus() {}, $: () => null });
  vm.runInContext(section("  let movementLoadPromise =", "  const resetInventoryForm =") + ";globalThis.load=loadInventoryMovements;", context);
  return { state, jobs, pendingIds, response, context };
}

test("movimientos conserva correcciones pendientes, altas y eliminaciones sin duplicar IDs", async () => {
  const h = movementHarness();
  h.state.inventoryMovements[0].unitCost = 2; h.pendingIds.add("edit");
  const reading = h.context.load(); await tick();
  h.state.inventoryMovements = h.state.inventoryMovements.filter(row => row.movementId !== "delete");
  h.state.inventoryMovements.push({ movementId: "new", unitCost: 3 });
  h.response.resolve({ ok: true, movements: [{ movementId: "edit", unitCost: 1 }, { movementId: "delete", unitCost: 1 }, { movementId: "peer", unitCost: 5 }] }); await reading;
  assert.equal(h.state.inventoryMovements.find(row => row.movementId === "edit").unitCost, 2);
  assert.equal(h.state.inventoryMovements.some(row => row.movementId === "delete"), false);
  assert.equal(h.state.inventoryMovements.filter(row => row.movementId === "new").length, 1);
  assert.ok(h.state.inventoryMovements.some(row => row.movementId === "peer"));
});

test("limpiar movimientos durante la consulta no restaura el historial anterior", async () => {
  const h = movementHarness(), remote = structuredClone(h.state.inventoryMovements);
  const reading = h.context.load(); await tick();
  h.jobs.push({ action: "clear_inventory_movements" }); h.state.inventoryMovements = [];
  h.response.resolve({ ok: true, movements: remote }); await reading;
  assert.equal(h.state.inventoryMovements.length, 0);
});

test("eliminar una venta invalida una consulta anterior del informe", async () => {
  const state = { incomeRequestId: 3, incomeLoading: true, incomeReport: { records: [{ saleId: "sale", total: 1000, items: [], payments: [] }], totals: { income: 1000, sales: 1 }, totalRecords: 1 }, invoiceHistory: [], items: [], inventoryMeta: {} };
  const context = vm.createContext({ state, canDeleteRecords: () => true, readAppsScriptOutbox: () => [], writeAppsScriptOutbox() {}, persistInvoiceHistory() {}, persistInventoryStore() {}, renderIncomeReport() {}, renderInventory() {}, enqueueAppsScriptJob() {}, toast() {}, $: () => ({ close() {} }), reportMirror: () => ({ deleted: {}, sales: {} }), reportMirrorKey: () => 'mirror', saveReportSyncValue() {}, removeDeletedSaleMovements: rows => rows || [], persistInventoryMovements() {}, renderInventoryMovements() {} });
  vm.runInContext(section("  const deleteIncomeSale =", "  const replaceEditedIncomeRecord =") + ";globalThis.remove=deleteIncomeSale;", context);
  await context.remove({ sale_id: { value: "sale" } });
  assert.equal(state.incomeRequestId, 4);
  assert.equal(state.incomeReport.records.length, 0);
  assert.equal(state.incomeLoading, false);
});
