const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { randomUUID } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = (start, end) => {
  const from = source.indexOf(`  const ${start} =`);
  const to = source.indexOf(`  const ${end} =`, from + 1);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const makeLine = (id = randomUUID()) => ({ id, session_id: "account", table_id: "table", item_name: "Producto", quantity: 1, unit_price: 5000, notes: "", status: "served" });

function harness() {
  const session = { id: "account", table_id: "table", status: "open", payer_name: "Ana", assigned_waiter_id: "staff", session_items: [], session_payments: [] };
  const state = { sessions: [session], tables: [{ id: "table" }], items: [], currentUser: { id: "staff" }, optimisticSessionStates: new Map(), optimisticRequestStates: new Map() };
  const backend = { inserted: [], beforeItems: null, beforeDelete: null, failDelete: false, inserts: [], cached: null };
  state.sb = { from(table) {
    let payload, operation, id;
    const query = {
      insert(value) { operation = "insert"; payload = value; return this; },
      update(value) { operation = "update"; payload = value; return this; },
      select() { return this; }, eq(key, value) { if (key === "id") id = value; return this; }, single() { return this; },
      then(resolve, reject) { return Promise.resolve().then(async () => {
        if (table === "table_sessions") return { data: { ...session, ...payload } };
        assert.equal(table, "session_items");
        if (operation === "insert") {
          backend.inserts.push(structuredClone(payload));
          const rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ ...row, id: row.id || randomUUID() }));
          backend.inserted.push(...rows);
          if (backend.beforeItems) await backend.beforeItems(rows);
          return { data: Array.isArray(payload) ? rows : rows[0] };
        }
        const row = { ...backend.inserted.find(row => row.id === id), ...payload, id };
        if (backend.beforeDelete) await backend.beforeDelete(row);
        if (backend.failDelete) return { data: null, error: new Error("write failed") };
        backend.inserted = backend.inserted.map(entry => entry.id === id ? row : entry);
        return { data: row };
      }).then(resolve, reject); }
    };
    return query;
  } };
  const context = vm.createContext({ state, Date, Map, Set, uid: randomUUID, REMOTE_CONFIRMATION_HOLD_MS: 15000,
    retryPosMutation: async factory => (await factory()).data,
    retryQuiet: async factory => (await factory()).data, dbQuiet: async query => (await query).data,
    persistOfflineAdminSnapshot() { backend.cached = { sessions: structuredClone(state.sessions), requests: [] }; }, renderAdminLive() {}, renderAdmin() {}, renderTableConsumptionPreview() {}, renderLastConsumptionTime() {}, toast() {},
    isLocalWalkInSession: row => row.local_only === true, persistWalkInDrafts() {}, askForConfirmation: async () => true,
    consumptionChangeAllowed: () => true, clearPaymentsWithoutConsumption: row => row,
    currencyInputNumber: field => Number(field.value), $: () => ({ close() {} }), openPaymentDialog() {}
  });
  vm.runInContext(section("mergeOptimisticRequests", "applyOfflineSessionRemap") +
    section("pendingAdminReadScope", "setScopedAdminRead") +
    section("addConsumptionBatch", "confirmConsumptionSelection") +
    section("deleteConsumption", "showStockWarning") +
    section("addManualConsumption", "copyQr") +
    ";globalThis.api={addConsumptionBatch,addManualConsumption,deleteConsumption,mergeOptimisticSessions,pendingAdminReadScope,mergePendingAdminRows};", context);
  const form = Object.fromEntries(Object.entries({ session_id: "account", pending_table_id: "", payer_name: "Ana", session_item_id: "", menu_item_id: "", item_name: "Producto", unit_price: "5000", quantity: "1", notes: "", quick_checkout: "0" }).map(([key, value]) => [key, { value }]));
  const snapshot = (items) => [{ ...session, session_items: structuredClone(items) }];
  return { state, backend, api: context.api, form, snapshot };
}

test("un lote no duplica el consumo si la lectura remota llega antes de la respuesta de escritura", async () => {
  const h = harness();
  h.backend.beforeItems = rows => { h.state.sessions = h.api.mergeOptimisticSessions(h.snapshot(rows)); };
  await h.api.addConsumptionBatch(h.form, [{ itemName: "Producto", quantity: 1, unitPrice: 5000 }]);
  assert.equal(h.backend.inserted.length, 1);
  assert.equal(h.state.sessions[0].session_items.length, 1);
  assert.equal(h.state.sessions[0].session_items[0].id, h.backend.inserted[0].id);
});

test("el consumo manual no duplica el registro confirmado durante una lectura concurrente", async () => {
  const h = harness();
  h.backend.beforeItems = rows => { h.state.sessions = h.api.mergeOptimisticSessions(h.snapshot(rows)); };
  await h.api.addManualConsumption(h.form);
  assert.equal(h.state.sessions[0].session_items.length, 1);
});

test("el consumo usa el mismo UUID local, enviado y confirmado", async () => {
  const h = harness();
  let optimisticId;
  h.backend.beforeItems = () => { optimisticId = h.state.sessions[0].session_items[0].id; };
  await h.api.addConsumptionBatch(h.form, [{ itemName: "Producto", quantity: 1, unitPrice: 5000 }]);
  assert.match(optimisticId, /^[\da-f-]{36}$/i);
  assert.equal(h.backend.inserts[0][0].id, optimisticId);
  assert.equal(h.backend.inserted[0].id, optimisticId);
});

test("eliminar una sola vez no permite que el overlay anterior reviva el consumo", async () => {
  const h = harness();
  const line = makeLine();
  h.state.sessions = h.snapshot([line]); h.backend.inserted = [line];
  h.state.optimisticSessionStates.set("account", { mode: "upsert", session: h.state.sessions[0], expectedItems: [line] });
  h.backend.beforeDelete = () => {
    h.state.sessions = h.api.mergeOptimisticSessions(h.snapshot([line]));
    assert.equal(h.state.sessions[0].session_items[0].status, "cancelled", "Una lectura anterior no revive el consumo mientras se guarda la cancelacion.");
  };
  await h.api.deleteConsumption("account", line.id);
  h.state.sessions = h.api.mergeOptimisticSessions(h.snapshot(h.backend.inserted));
  assert.equal(h.state.sessions[0].session_items[0].status, "cancelled");
  h.state.sessions = h.api.mergeOptimisticSessions(h.snapshot([line]));
  assert.equal(h.state.sessions[0].session_items[0].status, "cancelled", "Una lectura tardia no deshace la cancelacion confirmada.");
});

test("normaliza duplicados del mismo UUID, conservando consumos distintos del mismo producto", () => {
  const h = harness(), line = makeLine(), another = makeLine();
  const merged = h.api.mergeOptimisticSessions(h.snapshot([line, line, another]));
  assert.equal(merged[0].session_items.length, 2);
});

test("un fallo real al eliminar restaura el consumo y su proteccion previa", async () => {
  const h = harness(), line = makeLine();
  h.state.sessions = h.snapshot([line]); h.backend.inserted = [line]; h.backend.failDelete = true;
  h.state.optimisticSessionStates.set("account", { mode: "upsert", session: h.state.sessions[0], expectedItems: [line] });
  await h.api.deleteConsumption("account", line.id);
  assert.equal(h.state.sessions[0].session_items[0].status, "served");
  assert.equal(h.api.mergeOptimisticSessions(h.snapshot([line]))[0].session_items[0].status, "served");
});

test("el consumo manual envia el UUID mostrado localmente y editar conserva ese registro", async () => {
  const h = harness();
  let localId;
  h.backend.beforeItems = () => { localId = h.state.sessions[0].session_items[0].id; };
  await h.api.addManualConsumption(h.form);
  assert.equal(h.backend.inserts[0].id, localId);
  h.form.session_item_id.value = localId; h.form.quantity.value = "3";
  await h.api.addManualConsumption(h.form);
  assert.equal(h.backend.inserted.length, 1);
  assert.equal(h.state.sessions[0].session_items.length, 1);
  assert.equal(h.state.sessions[0].session_items[0].quantity, 3);
});

test("eliminar varios consumos conserva todas las cancelaciones frente a lecturas tardias", async () => {
  const h = harness(), lines = [makeLine(), makeLine(), makeLine()];
  h.state.sessions = h.snapshot(lines); h.backend.inserted = lines;
  for (const line of lines) {
    await h.api.deleteConsumption("account", line.id);
    h.state.sessions = h.api.mergeOptimisticSessions(h.snapshot(lines));
  }
  assert.equal(h.state.sessions[0].session_items.filter(row => row.status !== "cancelled").length, 0);
  assert.equal(h.state.optimisticSessionStates.get("account").expectedItems.length, 3);
});

test("una cancelacion en cola queda en el snapshot durable para la siguiente apertura", async () => {
  const h = harness(), line = makeLine();
  h.state.sessions = h.snapshot([line]); h.backend.inserted = [line];
  await h.api.deleteConsumption("account", line.id);
  assert.equal(h.backend.cached.sessions[0].session_items[0].status, "cancelled");
  const restarted = harness();
  const scope = restarted.api.pendingAdminReadScope(h.backend.cached, { blockingRecords: [{
    entity: "session_items", method: "PATCH", recordIds: [line.id], sessionIds: ["account"], changedFields: ["status", "updated_by_user_id"]
  }] });
  const merged = restarted.api.mergePendingAdminRows({ sessions: h.snapshot([line]), requests: [] }, h.backend.cached, scope);
  assert.equal(merged.sessions[0].session_items[0].status, "cancelled");
});

test("un producto igual agregado intencionalmente conserva su identidad y los consumos del otro equipo", async () => {
  const h = harness(), peer = makeLine();
  h.backend.beforeItems = rows => { h.state.sessions = h.api.mergeOptimisticSessions(h.snapshot([peer, ...h.backend.inserted])); };
  for (let i = 0; i < 2; i++) await h.api.addConsumptionBatch(h.form, [{ itemName: "Producto", quantity: 1, unitPrice: 5000 }]);
  assert.equal(h.state.sessions[0].session_items.length, 3);
  assert.equal(new Set(h.state.sessions[0].session_items.map(row => row.id)).size, 3);
});

test("si falla una cancelacion, no restaura otro consumo que se elimino mientras tanto", async () => {
  const h = harness(), first = makeLine(), second = makeLine();
  h.state.sessions = h.snapshot([first, second]); h.backend.inserted = [first, second];
  let releaseFirst;
  h.backend.beforeDelete = async row => {
    if (row.id === first.id) {
      await new Promise(resolve => { releaseFirst = resolve; });
      h.backend.failDelete = true;
    }
  };
  const pending = h.api.deleteConsumption("account", first.id);
  await tick();
  await h.api.deleteConsumption("account", second.id);
  releaseFirst(); await pending;
  assert.equal(h.state.sessions[0].session_items.find(row => row.id === first.id).status, "served");
  assert.equal(h.state.sessions[0].session_items.find(row => row.id === second.id).status, "cancelled");
  const merged = h.api.mergeOptimisticSessions(h.snapshot([first, second]))[0];
  assert.equal(merged.session_items.find(row => row.id === second.id).status, "cancelled");
});
