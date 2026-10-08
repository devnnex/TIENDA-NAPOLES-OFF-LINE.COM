const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const cases = [
  [path.resolve(__dirname, ".."), "inventoryReadPromise", "let reconnectSyncPromise ="]
];

(async () => {
  for (const [root, inFlightName, endMarker] of cases) {
    const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
    const start = source.indexOf("  let inventoryPeerRefreshPending =");
    const end = source.indexOf(`  ${endMarker}`, start);
    assert.ok(start >= 0 && end > start, `${root}: controlador de actualización`);
    let finishRead;
    const currentRead = new Promise((resolve) => { finishRead = resolve; });
    const calls = [];
    const context = vm.createContext({
      state: { currentUser: { id: "staff" }, activeAdminSection: "inventory" },
      navigator: { onLine: true },
      isAppsScriptConfigured: () => true,
      syncInventoryWithAppsScript: async () => { calls.push("inventory"); return true; },
      loadInventoryMovements: async () => { calls.push("movements"); },
      [inFlightName]: currentRead
    });
    vm.runInContext(source.slice(start, end) + ";globalThis.refresh = refreshInventoryFromPeer;", context);
    const first = context.refresh();
    const second = context.refresh();
    assert.equal(first, second, `${root}: varios avisos comparten la misma actualización`);
    assert.equal(calls.length, 0, `${root}: espera la lectura anterior`);
    context[inFlightName] = null;
    finishRead(true);
    await first;
    assert.deepEqual(calls, ["inventory"], `${root}: consulta inventario tras la lectura anterior`);
    context.navigator.onLine = false;
    await context.refresh();
    assert.equal(calls.length, 1, `${root}: sin conexión no fuerza una lectura remota`);
  }
  const offlineSource = fs.readFileSync(path.join(cases[0][0], "app.js"), "utf8");
  const applyStart = offlineSource.indexOf("  const applyRemoteInventoryItems =");
  const applyEnd = offlineSource.indexOf("  const enqueueAppsScriptJob =", applyStart);
  const work = [];
  const product = { id: "product-a", name: "Agua", price: 2000, is_available: true };
  const inventoryState = { items: [product], inventoryMeta: {}, activeAdminSection: "inventory" };
  const applyContext = vm.createContext({
    state: inventoryState, Map, Set,
    productAcronym: () => "AG",
    persistInventoryStore: () => work.push("save"),
    persistBootstrapCache: () => work.push("cache"),
    renderInventory: () => work.push("render"),
    renderMenuManager: () => work.push("menu")
  });
  vm.runInContext(offlineSource.slice(applyStart, applyEnd)
    + ";globalThis.apply = applyRemoteInventoryItems;", applyContext);
  const remote = { productId: "product-a", name: "Agua", code: "AG", stock: 8,
    minStock: 2, costPrice: 1000, salePrice: 2000, unit: "unidad",
    isAvailable: true, updatedAt: "2026-10-08T12:00:00Z", version: 1 };
  applyContext.apply([remote]);
  assert.deepEqual(work, ["save", "cache", "render"]);
  work.length = 0;
  applyContext.apply([remote]);
  assert.deepEqual(work, [], "una lectura idéntica no vuelve a guardar ni dibujar el inventario");
  applyContext.apply([{ ...remote, stock: 7, version: 2 }]);
  assert.deepEqual(work, ["save", "cache", "render"]);
  assert.equal(inventoryState.inventoryMeta["product-a"].stock, 7);
  console.log("PASS inventario: aviso entre equipos, lecturas ordenadas y comportamiento sin conexión");
})().catch((error) => { console.error(error); process.exitCode = 1; });
