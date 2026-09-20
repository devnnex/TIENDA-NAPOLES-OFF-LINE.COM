const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { webcrypto } = require("node:crypto");

const records = new Map();
let remoteFetch = async () => new Response("[]", { status: 200 });

const requestFor = (transaction, action) => {
  const request = {};
  queueMicrotask(() => {
    try {
      request.result = action();
      request.onsuccess?.({ target: request });
      queueMicrotask(() => transaction.oncomplete?.());
    } catch (error) {
      request.error = error;
      request.onerror?.({ target: request });
      transaction.onerror?.({ target: transaction });
    }
  });
  return request;
};

const database = {
  objectStoreNames: { contains: () => true },
  createObjectStore: () => undefined,
  close: () => undefined,
  transaction: () => {
    const transaction = {};
    transaction.objectStore = () => ({
      put: (value) => requestFor(transaction, () => {
        records.set(value.id, structuredClone(value));
        return value.id;
      }),
      getAll: () => requestFor(transaction, () => [...records.values()].map((value) => structuredClone(value))),
      delete: (id) => requestFor(transaction, () => records.delete(id))
    });
    return transaction;
  }
};

const indexedDB = {
  open: () => {
    const request = { result: database };
    queueMicrotask(() => request.onsuccess?.({ target: request }));
    return request;
  }
};

const listeners = new Map();
const self = {
  location: { origin: "http://127.0.0.1:8765", hostname: "127.0.0.1" },
  registration: { sync: { register: async () => undefined } },
  clients: { matchAll: async () => [] },
  skipWaiting: async () => undefined,
  addEventListener: (name, listener) => listeners.set(name, listener)
};

const cache = { addAll: async () => undefined, match: async () => undefined, put: async () => undefined };
const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
const context = vm.createContext({
  AbortController,
  Headers,
  Request,
  Response,
  URL,
  caches,
  clearTimeout,
  console,
  crypto: webcrypto,
  fetch: (input, init) => remoteFetch(new Request(input, init)),
  indexedDB,
  performance,
  queueMicrotask,
  self,
  setTimeout,
  structuredClone
});

const workerPath = path.join(__dirname, "..", "service-worker.js");
const workerSource = fs.readFileSync(workerPath, "utf8");
vm.runInContext(`${workerSource}\n;globalThis.__syncTest = {
  directSupabaseRequest, flushQueue, isQueueableRpc, isRestMutation,
  listEntries, normalizeStoredEntry, putEntry, queuedResponse,
  recoverInterruptedEntries, serializeRequest, verifyRestMutation
};`, context, { filename: workerPath });

const api = context.__syncTest;
const endpoint = (table, query = "") => `https://example.supabase.co/rest/v1/${table}${query}`;
const request = (table, method, body, query = "") => new Request(endpoint(table, query), {
  method,
  headers: {
    accept: "application/vnd.pgrst.object+json",
    apikey: "test",
    "content-type": "application/json"
  },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const pendingEntry = (overrides = {}) => ({
  id: webcrypto.randomUUID(),
  operationId: webcrypto.randomUUID(),
  source: "supabase",
  entity: "menu_items",
  recordId: "row-1",
  recordIds: ["row-1"],
  operationType: "POST",
  url: endpoint("menu_items"),
  method: "POST",
  headers: [["content-type", "application/json"]],
  body: JSON.stringify({ id: "row-1", name: "Uno" }),
  payload: { id: "row-1", name: "Uno" },
  createdAt: new Date().toISOString(),
  createdOrder: performance.timeOrigin + performance.now(),
  attempts: 0,
  status: "pending",
  nextAttemptAt: 0,
  lastError: "",
  ...overrides
});

const reset = () => {
  records.clear();
  remoteFetch = async () => new Response("[]", { status: 200 });
};

const tests = [];
const test = (name, run) => tests.push({ name, run });

test("01 conserva el UUID de un CREATE local", async () => {
  const entry = await api.serializeRequest(request("menu_items", "POST", { id: "fixed-id", name: "Producto" }));
  assert.equal(entry.recordId, "fixed-id");
  assert.equal(JSON.parse(entry.body).id, "fixed-id");
});

test("02 asigna UUID estables a un INSERT por lote", async () => {
  const entry = await api.serializeRequest(request("session_items", "POST", [{ item_name: "A" }, { item_name: "B" }]));
  const body = JSON.parse(entry.body);
  assert.equal(entry.recordIds.length, 2);
  assert.deepEqual(Array.from(entry.recordIds), body.map((row) => row.id));
  assert.notEqual(body[0].id, body[1].id);
});

test("03 responde localmente con la misma identidad", async () => {
  const entry = await api.serializeRequest(request("menu_items", "POST", { id: "local-id", name: "Producto" }));
  const response = api.queuedResponse(entry);
  const row = await response.json();
  assert.equal(row.id, "local-id");
  assert.equal(row._offline_pending, true);
});

test("04 conserva el pendiente cuando la red falla", async () => {
  const entry = pendingEntry();
  await api.putEntry(entry);
  remoteFetch = async () => { throw new TypeError("offline"); };
  await api.flushQueue(true);
  const stored = (await api.listEntries())[0];
  assert.equal(stored.status, "pending");
  assert.equal(stored.attempts, 1);
});

test("05 procesa la cola en orden FIFO", async () => {
  const sent = [];
  for (let index = 0; index < 3; index += 1) {
    await api.putEntry(pendingEntry({ id: `op-${index}`, recordId: `row-${index}`, recordIds: [`row-${index}`], url: endpoint("menu_items", `?order=${index}`), createdOrder: index + 1 }));
  }
  remoteFetch = async (input) => {
    sent.push(new URL(input.url || input).searchParams.get("order"));
    return new Response("[]", { status: 201 });
  };
  await api.flushQueue(true);
  assert.deepEqual(sent, ["0", "1", "2"]);
});

test("06 confirma un CREATE reintentado que ya existe", async () => {
  const entry = pendingEntry();
  await api.putEntry(entry);
  remoteFetch = async (input) => input.method === "GET"
    ? new Response(JSON.stringify([{ id: "row-1", name: "Uno" }]), { status: 200 })
    : new Response("conflict", { status: 409 });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("07 verifica todos los IDs de un lote tras respuesta perdida", async () => {
  const payload = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const entry = pendingEntry({ recordId: "a", recordIds: ["a", "b"], payload, body: JSON.stringify(payload) });
  await api.putEntry(entry);
  remoteFetch = async (input) => input.method === "GET"
    ? new Response(JSON.stringify(payload), { status: 200 })
    : new Response("conflict", { status: 409 });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("08 confirma DELETE si el registro ya no existe", async () => {
  const entry = pendingEntry({ method: "DELETE", operationType: "DELETE", payload: {}, body: "{}", url: endpoint("menu_items", "?id=eq.row-1") });
  await api.putEntry(entry);
  remoteFetch = async (input) => input.method === "GET"
    ? new Response("[]", { status: 200 })
    : new Response("conflict", { status: 409 });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("09 retiene como conflicto una versión remota distinta", async () => {
  const entry = pendingEntry();
  await api.putEntry(entry);
  remoteFetch = async (input) => input.method === "GET"
    ? new Response(JSON.stringify([{ id: "row-1", name: "Mas nuevo" }]), { status: 200 })
    : new Response("conflict", { status: 409 });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("10 recupera operaciones syncing después de reabrir", async () => {
  await api.putEntry(pendingEntry({ status: "syncing" }));
  await api.recoverInterruptedEntries();
  assert.equal((await api.listEntries())[0].status, "pending");
});

test("11 bloquea reconciliación remota mientras hay cambios locales", async () => {
  await api.putEntry(pendingEntry());
  const rpc = new Request("https://example.supabase.co/rest/v1/rpc/get_admin_snapshot", { method: "POST", body: "{}" });
  const response = await api.directSupabaseRequest(rpc, new URL(rpc.url));
  assert.equal(response.status, 503);
});

test("12 no encola RPC de lectura ni autenticación", async () => {
  const rpc = new Request("https://example.supabase.co/rest/v1/rpc/get_current_user", { method: "POST", body: "{}" });
  assert.equal(api.isQueueableRpc(rpc, new URL(rpc.url)), false);
  const tableZones = new Request("https://example.supabase.co/rest/v1/rpc/save_table_zones", { method: "POST", body: JSON.stringify({ outdoor_table_ids: [] }) });
  assert.equal(api.isQueueableRpc(tableZones, new URL(tableZones.url)), true);
});

test("13 adapta la respuesta local de RPC idempotente", async () => {
  const rpc = new Request("https://example.supabase.co/rest/v1/rpc/send_chat_message", {
    method: "POST",
    body: JSON.stringify({ p_message_id: "message-1", p_session_id: "session-1", p_body: "Hola" })
  });
  const entry = await api.serializeRequest(rpc);
  const body = await api.queuedResponse(entry).json();
  assert.equal(body.message.id, "message-1");
  assert.equal(body.message.body, "Hola");
});

test("14 deja Apps Script bajo su única cola especializada", async () => {
  const appsScript = new Request("https://script.google.com/macros/s/example/exec", { method: "POST", body: "{}" });
  assert.equal(api.isRestMutation(appsScript, new URL(appsScript.url)), false);
  assert.equal(api.isQueueableRpc(appsScript, new URL(appsScript.url)), false);
});

test("15 conserva CREATE -> UPDATE -> DELETE en ese orden", async () => {
  const sent = [];
  let remoteRow = null;
  const operations = ["POST", "PATCH", "DELETE"];
  for (let index = 0; index < operations.length; index += 1) {
    const method = operations[index];
    await api.putEntry(pendingEntry({
      id: `chain-${index}`,
      method,
      operationType: method,
      createdOrder: 100 + index,
      url: endpoint("menu_items", `?step=${index}${method === "POST" ? "" : "&id=eq.row-1"}`)
    }));
  }
  remoteFetch = async (input) => {
    if (input.method === "GET") {
      return new Response(JSON.stringify(remoteRow ? [remoteRow] : []), { status: 200 });
    }
    sent.push(input.method);
    if (input.method === "POST" || input.method === "PATCH") remoteRow = { id: "row-1", name: "Uno" };
    if (input.method === "DELETE") remoteRow = null;
    return new Response("[]", { status: 200 });
  };
  await api.flushQueue(true);
  assert.deepEqual(sent, operations);
});

(async () => {
  let passed = 0;
  for (const scenario of tests) {
    reset();
    try {
      await scenario.run();
      passed += 1;
      console.log(`PASS ${scenario.name}`);
    } catch (error) {
      console.error(`FAIL ${scenario.name}`);
      console.error(error);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`${passed}/${tests.length} escenarios de sincronización aprobados`);
})();
