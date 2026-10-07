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
  listEntries, networkFirst, normalizeStoredEntry, putEntry, queuedResponse,
  recoverInterruptedEntries, refreshQueuedSessionItemAuth, serializeRequest,
  syncStatusSnapshot, verifyRestMutation
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
  vm.runInContext("archiveReadConfig = null", context);
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

test("11 bloquea reconciliación remota mientras hay cambios locales relacionados", async () => {
  await api.putEntry(pendingEntry({ entity: "table_sessions" }));
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

test("16 fusiona una cuenta offline con la sesion remota abierta", async () => {
  const localSessionId = "11111111-1111-4111-8111-111111111111";
  const remoteSessionId = "22222222-2222-4222-8222-222222222222";
  const tableId = "33333333-3333-4333-8333-333333333333";
  const sessionEntry = await api.serializeRequest(request("table_sessions", "POST", {
    id: localSessionId,
    table_id: tableId,
    status: "open",
    sale_channel: "table",
    payer_name: "Cliente offline"
  }));
  sessionEntry.createdOrder = 1;
  sessionEntry.status = "conflict";
  const itemEntry = await api.serializeRequest(request("session_items", "POST", [{
    session_id: localSessionId,
    table_id: tableId,
    item_name: "Producto offline",
    quantity: 2,
    unit_price: 7000,
    status: "served"
  }]));
  itemEntry.createdOrder = 2;
  await api.putEntry(sessionEntry);
  await api.putEntry(itemEntry);
  let uploadedSessionId = "";
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (input.method === "POST" && url.pathname.endsWith("/table_sessions")) {
      return new Response("conflict", { status: 409 });
    }
    if (input.method === "GET" && url.pathname.endsWith("/table_sessions")) {
      if (url.searchParams.get("table_id") === `eq.${tableId}`) {
        return new Response(JSON.stringify([{ id: remoteSessionId, table_id: tableId, status: "open" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }
    if (input.method === "PATCH" && url.pathname.endsWith("/table_sessions")) {
      assert.equal(url.searchParams.get("id"), `eq.${remoteSessionId}`);
      return new Response(JSON.stringify([{ id: remoteSessionId }]), { status: 200 });
    }
    if (input.method === "POST" && url.pathname.endsWith("/session_items")) {
      uploadedSessionId = JSON.parse(await input.text())[0].session_id;
      return new Response("[]", { status: 201 });
    }
    return new Response("[]", { status: 200 });
  };
  await api.flushQueue(true);
  const entries = await api.listEntries();
  assert.equal(uploadedSessionId, remoteSessionId);
  assert.equal(entries.every((entry) => entry.status === "confirmed"), true);
});

test("17 una reconexion forzada acelera la cola que ya estaba trabajando", async () => {
  await api.putEntry(pendingEntry({ id: "active-1", createdOrder: 1 }));
  await api.putEntry(pendingEntry({
    id: "delayed-2",
    recordId: "row-2",
    recordIds: ["row-2"],
    body: JSON.stringify({ id: "row-2", name: "Dos" }),
    payload: { id: "row-2", name: "Dos" },
    createdOrder: 2,
    nextAttemptAt: Date.now() + 60_000
  }));
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let sent = 0;
  remoteFetch = async () => {
    sent += 1;
    if (sent === 1) {
      markStarted();
      await gate;
    }
    return new Response("[]", { status: 201 });
  };
  const running = api.flushQueue(false);
  await started;
  const forced = api.flushQueue(true);
  releaseFirst();
  await Promise.all([running, forced]);
  assert.equal(sent, 2);
});

test("18 no consume tiempo de red mientras el equipo esta offline", async () => {
  await api.putEntry(pendingEntry());
  let sent = 0;
  remoteFetch = async () => {
    sent += 1;
    return new Response("[]", { status: 201 });
  };
  const messageListener = listeners.get("message");
  messageListener({ data: { type: "SET_NETWORK_STATUS", online: false }, waitUntil: () => undefined, ports: [] });
  await api.flushQueue(true);
  assert.equal(sent, 0);
  assert.equal((await api.listEntries())[0].status, "pending");
  messageListener({ data: { type: "SET_NETWORK_STATUS", online: true }, waitUntil: () => undefined, ports: [] });
  await api.flushQueue(true);
  assert.equal(sent, 1);
});

test("19 una cola de mesas no bloquea la lectura actual de marca", async () => {
  await api.putEntry(pendingEntry({ entity: "table_sessions" }));
  let reads = 0;
  remoteFetch = async () => {
    reads += 1;
    return new Response(JSON.stringify([{ accent_color: "#0033ff" }]), { status: 200 });
  };
  const response = await api.networkFirst(request("business_settings", "GET"));
  assert.equal((await response.json())[0].accent_color, "#0033ff");
  assert.equal(reads, 1);
});

test("20 una lectura remota fallida no devuelve datos antiguos de CacheStorage", async () => {
  const previousMatch = cache.match;
  cache.match = async () => new Response(JSON.stringify([{ accent_color: "#aabbcc" }]), { status: 200 });
  remoteFetch = async () => { throw new TypeError("network_error"); };
  try {
    await assert.rejects(api.networkFirst(request("business_settings", "GET")), /network_error/);
  } finally {
    cache.match = previousMatch;
  }
});

test("21 una escritura pendiente de marca protege su propia lectura", async () => {
  await api.putEntry(pendingEntry({ entity: "business_settings" }));
  let reads = 0;
  remoteFetch = async () => {
    reads += 1;
    return new Response("[]", { status: 200 });
  };
  await assert.rejects(api.networkFirst(request("business_settings", "GET")), /pending_local_writes/);
  assert.equal(reads, 0);
});

test("22 una cola de catálogo no bloquea el snapshot de mesas", async () => {
  await api.putEntry(pendingEntry({ entity: "menu_categories" }));
  const rpc = new Request("https://example.supabase.co/rest/v1/rpc/get_admin_snapshot", { method: "POST", body: "{}" });
  let reads = 0;
  remoteFetch = async () => {
    reads += 1;
    return new Response("{}", { status: 200 });
  };
  const response = await api.directSupabaseRequest(rpc, new URL(rpc.url));
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
});

test("23 una cola de mesas protege el snapshot operativo", async () => {
  await api.putEntry(pendingEntry({ entity: "table_sessions" }));
  const rpc = new Request("https://example.supabase.co/rest/v1/rpc/get_admin_snapshot", { method: "POST", body: "{}" });
  let reads = 0;
  remoteFetch = async () => {
    reads += 1;
    return new Response("{}", { status: 200 });
  };
  const response = await api.directSupabaseRequest(rpc, new URL(rpc.url));
  assert.equal(response.status, 503);
  assert.equal(reads, 0);
});

const flushAsAuthenticatedApp = async (authToken, detail = {}) => {
  let task;
  let result;
  listeners.get("message")({
    data: { type: "FLUSH_OFFLINE_QUEUE", force: true, authToken, ...detail },
    waitUntil: (promise) => { task = promise; },
    ports: [{ postMessage: (message) => { result = message; } }]
  });
  await task;
  return result;
};

test("24 recupera un consumo 401 con el token nuevo sin recrear la operacion", async () => {
  const entry = pendingEntry({
    entity: "session_items",
    url: endpoint("session_items"),
    headers: [["content-type", "application/json"], ["x-app-token", "token-anterior"]],
    status: "failed",
    lastError: "401 Unauthorized"
  });
  await api.putEntry(entry);
  let sends = 0;
  remoteFetch = async (input) => {
    sends += 1;
    assert.equal(input.headers.get("x-app-token"), "token-vigente");
    assert.equal(await input.text(), entry.body);
    return new Response("[]", { status: 201 });
  };
  const response = await flushAsAuthenticatedApp("token-vigente");
  const stored = (await api.listEntries())[0];
  assert.equal(response.ok, true);
  assert.equal(sends, 1);
  assert.equal(stored.status, "confirmed");
  assert.equal(stored.operationId, entry.operationId);
  assert.equal(stored.id, entry.id);
  assert.equal(stored.body, entry.body);
});

test("25 no repite un 401 con la misma credencial rechazada", async () => {
  await api.putEntry(pendingEntry({
    entity: "session_items",
    url: endpoint("session_items"),
    headers: [["x-app-token", "token-rechazado"]],
    status: "failed",
    lastError: "401 Unauthorized"
  }));
  let sends = 0;
  remoteFetch = async () => {
    sends += 1;
    return new Response("[]", { status: 201 });
  };
  await flushAsAuthenticatedApp("token-rechazado");
  assert.equal(sends, 0);
  assert.equal((await api.listEntries())[0].status, "failed");
});

test("26 no altera conflictos ni consumos de clientes sin token de usuario", async () => {
  await api.putEntry(pendingEntry({
    id: "conflict-item",
    entity: "session_items",
    url: endpoint("session_items"),
    headers: [["x-app-token", "token-anterior"]],
    status: "conflict",
    lastError: "409 Conflict"
  }));
  await api.putEntry(pendingEntry({
    id: "table-client-item",
    entity: "session_items",
    url: endpoint("session_items"),
    headers: [["x-table-code", "mesa-1"]],
    status: "failed",
    lastError: "401 Unauthorized"
  }));
  await api.refreshQueuedSessionItemAuth("token-vigente");
  const entries = await api.listEntries();
  assert.equal(entries.find((entry) => entry.id === "conflict-item").status, "conflict");
  assert.equal(new Headers(entries.find((entry) => entry.id === "conflict-item").headers).get("x-app-token"), "token-anterior");
  assert.equal(entries.find((entry) => entry.id === "table-client-item").status, "failed");
});

test("27 actualiza un consumo pendiente antes de enviarlo", async () => {
  await api.putEntry(pendingEntry({
    entity: "session_items",
    url: endpoint("session_items"),
    headers: [["x-app-token", "token-anterior"]]
  }));
  remoteFetch = async (input) => {
    assert.equal(input.headers.get("x-app-token"), "token-vigente");
    return new Response("[]", { status: 201 });
  };
  await flushAsAuthenticatedApp("token-vigente");
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("28 recupera el ciclo completo 401, nueva sesion y confirmacion", async () => {
  const entry = pendingEntry({
    entity: "session_items",
    url: endpoint("session_items"),
    headers: [["x-app-token", "token-anterior"]]
  });
  await api.putEntry(entry);
  const tokensSent = [];
  remoteFetch = async (input) => {
    const token = input.headers.get("x-app-token");
    tokensSent.push(token);
    return new Response("[]", { status: token === "token-vigente" ? 201 : 401 });
  };
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "failed");
  await flushAsAuthenticatedApp("token-anterior");
  assert.deepEqual(tokensSent, ["token-anterior"]);
  await flushAsAuthenticatedApp("token-vigente");
  assert.deepEqual(tokensSent, ["token-anterior", "token-vigente"]);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

const closedSessionEntry = (overrides = {}) => {
  const payload = { status: "closed", closed_at: "2026-10-05T12:00:00.000Z", subtotal: 12000, total: 12000 };
  return pendingEntry({
    entity: "table_sessions",
    recordId: "session-1",
    recordIds: ["session-1"],
    url: endpoint("table_sessions", "?id=eq.session-1&status=eq.open"),
    method: "PATCH",
    operationType: "PATCH",
    headers: [["accept", "application/vnd.pgrst.object+json"], ["apikey", "test"], ["x-app-token", "valid-token"]],
    body: JSON.stringify(payload),
    payload,
    status: "conflict",
    lastError: "406 Not Acceptable",
    ...overrides
  });
};

test("29 confirma cierre 406 si la venta ya archivo la cuenta remota", async () => {
  const entry = closedSessionEntry();
  await api.putEntry(entry);
  let patches = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET" && url.pathname.endsWith("/table_sessions")) return new Response("[]", { status: 200 });
    if (input.method === "PATCH") patches += 1;
    return new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  const stored = (await api.listEntries())[0];
  assert.equal(patches, 0);
  assert.equal(stored.status, "confirmed");
  assert.equal(stored.id, entry.id);
  assert.equal(stored.operationId, entry.operationId);
});

test("30 conserva el conflicto 406 si la cuenta sigue abierta", async () => {
  await api.putEntry(closedSessionEntry());
  let patches = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response(JSON.stringify([{ id: "session-1", status: "open" }]), { status: 200 });
    if (input.method === "PATCH") patches += 1;
    return new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(patches, 0);
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("31 no descarta cierre 406 si la credencial ya no es valida", async () => {
  await api.putEntry(closedSessionEntry());
  remoteFetch = async (input) => new URL(input.url).pathname.endsWith("/rpc/get_current_user")
    ? new Response("{}", { status: 401 })
    : new Response("[]", { status: 200 });
  await flushAsAuthenticatedApp("valid-token");
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("32 reconcilia el 406 de un cierre que aun estaba pendiente", async () => {
  await api.putEntry(closedSessionEntry({ status: "pending", lastError: "" }));
  let patches = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response("[]", { status: 200 });
    if (input.method === "PATCH") patches += 1;
    return new Response("{}", { status: 406 });
  };
  await api.flushQueue(true);
  assert.equal(patches, 1);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("33 no resuelve un 406 de otra actualizacion de mesa", async () => {
  const payload = { table_id: "different-table" };
  await api.putEntry(closedSessionEntry({ payload, body: JSON.stringify(payload) }));
  let patches = 0;
  remoteFetch = async (input) => {
    if (input.method === "PATCH") patches += 1;
    return input.method === "GET"
      ? new Response("[]", { status: 200 })
      : new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(patches, 1);
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("34 confirma un cierre 406 si la cuenta ya esta cerrada con los mismos importes", async () => {
  await api.putEntry(closedSessionEntry());
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response(JSON.stringify([{
      id: "session-1", status: "closed", subtotal: 12000, total: 12000
    }]), { status: 200 });
    throw new Error("No se debe repetir el PATCH");
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("35 conserva el 406 si la cuenta cerrada tiene importes distintos", async () => {
  await api.putEntry(closedSessionEntry());
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response(JSON.stringify([{
      id: "session-1", status: "closed", subtotal: 12000, total: 11000
    }]), { status: 200 });
    throw new Error("No se debe repetir el PATCH");
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("36 conserva el 406 si la creacion de esa cuenta sigue pendiente", async () => {
  const close = closedSessionEntry();
  await api.putEntry(close);
  await api.putEntry(pendingEntry({
    id: "create-session-1", entity: "table_sessions", recordId: "session-1", recordIds: ["session-1"],
    method: "POST", status: "failed", lastError: "400 Bad Request"
  }));
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response("[]", { status: 200 });
    return new Response("{}", { status: 400 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal((await api.listEntries()).find((entry) => entry.id === close.id).status, "conflict");
});

test("37 reintenta el cierre 406 una vez con la credencial vigente", async () => {
  const entry = closedSessionEntry({ headers: [["apikey", "test"], ["x-app-token", "old-token"]] });
  await api.putEntry(entry);
  let patches = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    assert.equal(input.headers.get("x-app-token"), "valid-token");
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response("[]", { status: 200 });
    if (input.method === "PATCH") patches += 1;
    return new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(patches, 1);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("38 recupera una apertura de mesa 401 con la sesion vigente", async () => {
  const entry = pendingEntry({
    entity: "table_sessions", recordId: "session-1", recordIds: ["session-1"],
    url: endpoint("table_sessions"), method: "POST", status: "failed", lastError: "401 Unauthorized",
    headers: [["apikey", "test"], ["x-app-token", "expired-token"]],
    payload: { id: "session-1", status: "open" }, body: JSON.stringify({ id: "session-1", status: "open" })
  });
  await api.putEntry(entry);
  let posts = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    assert.equal(input.headers.get("x-app-token"), "valid-token");
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "POST") posts += 1;
    return new Response("[]", { status: 201 });
  };
  await flushAsAuthenticatedApp("valid-token");
  const saved = (await api.listEntries())[0];
  assert.equal(posts, 1);
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.operationId, entry.operationId);
  assert.equal(saved.recordId, entry.recordId);
});

test("39 no reintenta mesa 401 si la nueva sesion tampoco valida", async () => {
  await api.putEntry(pendingEntry({
    entity: "table_sessions", url: endpoint("table_sessions"), method: "POST",
    status: "failed", lastError: "401 Unauthorized",
    headers: [["apikey", "test"], ["x-app-token", "expired-token"]]
  }));
  let posts = 0;
  remoteFetch = async (input) => {
    if (new URL(input.url).pathname.endsWith("/rpc/get_current_user")) return new Response("{}", { status: 400 });
    posts += 1;
    return new Response("[]", { status: 201 });
  };
  await flushAsAuthenticatedApp("another-expired-token");
  assert.equal(posts, 0);
  assert.equal((await api.listEntries())[0].status, "failed");
});

const metadataSessionEntry = (overrides = {}) => {
  const payload = { payer_name: "Cliente", assigned_waiter_id: "waiter-1" };
  return closedSessionEntry({ payload, body: JSON.stringify(payload), ...overrides });
};

test("40 concilia el 406 de nombre y responsable de una cuenta retirada", async () => {
  const entry = metadataSessionEntry();
  await api.putEntry(entry);
  let patches = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response("[]", { status: 200 });
    if (input.method === "PATCH") patches += 1;
    return new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  const saved = (await api.listEntries())[0];
  assert.equal(patches, 0);
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.operationId, entry.operationId);
});

test("41 renueva la credencial del 406 de nombre antes de conciliar", async () => {
  await api.putEntry(metadataSessionEntry({ headers: [["apikey", "test"], ["x-app-token", "expired-token"]] }));
  let patches = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    assert.equal(input.headers.get("x-app-token"), "valid-token");
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response("[]", { status: 200 });
    if (input.method === "PATCH") patches += 1;
    return new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(patches, 1);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("42 conserva el 406 de nombre si la cuenta aun existe con otros datos", async () => {
  await api.putEntry(metadataSessionEntry());
  let patches = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    if (input.method === "GET") return new Response(JSON.stringify([{
      id: "session-1", status: "open", payer_name: "Otro"
    }]), { status: 200 });
    if (input.method === "PATCH") patches += 1;
    return new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(patches, 0);
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("43 no concilia nombre de mesa ausente si su creacion sigue pendiente", async () => {
  const update = metadataSessionEntry();
  await api.putEntry(update);
  await api.putEntry(pendingEntry({
    id: "create-session-1", entity: "table_sessions", recordId: "session-1", recordIds: ["session-1"],
    method: "POST", status: "failed", lastError: "401 Unauthorized",
    headers: [["x-app-token", "valid-token"]]
  }));
  remoteFetch = async (input) => new URL(input.url).pathname.endsWith("/rpc/get_current_user")
    ? new Response(JSON.stringify({ id: "boss-1" }), { status: 200 })
    : new Response("[]", { status: 200 });
  await flushAsAuthenticatedApp("valid-token");
  assert.equal((await api.listEntries()).find((entry) => entry.id === update.id).status, "conflict");
});

test("44 recupera tres aperturas 401 con una sola validacion de sesion", async () => {
  const entries = Array.from({ length: 3 }, (_, index) => pendingEntry({
    entity: "table_sessions", recordId: `session-${index}`, recordIds: [`session-${index}`],
    url: endpoint("table_sessions"), method: "POST", status: "failed", lastError: "401 Unauthorized",
    headers: [["apikey", "test"], ["x-app-token", "expired-token"]],
    payload: { id: `session-${index}`, status: "open" },
    body: JSON.stringify({ id: `session-${index}`, status: "open" })
  }));
  for (const entry of entries) await api.putEntry(entry);
  let validations = 0;
  let posts = 0;
  remoteFetch = async (input) => {
    assert.equal(input.headers.get("x-app-token"), "valid-token");
    if (new URL(input.url).pathname.endsWith("/rpc/get_current_user")) {
      validations += 1;
      return new Response(JSON.stringify({ id: "boss-1" }), { status: 200 });
    }
    posts += 1;
    return new Response("[]", { status: 201 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(validations, 1);
  assert.equal(posts, 3);
  assert.equal((await api.listEntries()).filter((entry) => entry.status === "confirmed").length, 3);
});

test("45 no reutiliza una sesion administrativa para una mesa de cliente", async () => {
  await api.putEntry(pendingEntry({
    entity: "table_sessions", url: endpoint("table_sessions"), method: "POST",
    status: "failed", lastError: "401 Unauthorized", headers: [["x-table-code", "mesa-1"]]
  }));
  let requests = 0;
  remoteFetch = async () => { requests += 1; return new Response("[]", { status: 201 }); };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(requests, 0);
  assert.equal((await api.listEntries())[0].status, "failed");
});

test("46 el estado de la cola identifica la mesa y el producto de cada operacion", async () => {
  await api.putEntry(pendingEntry({
    entity: "table_sessions", recordId: "other-session", recordIds: ["other-session"],
    url: endpoint("table_sessions", "?id=eq.other-session"), status: "failed", lastError: "401 Unauthorized"
  }));
  await api.putEntry(pendingEntry({
    entity: "session_items", recordId: "line-1", recordIds: ["line-1"],
    payload: { id: "line-1", session_id: "sale-session" }
  }));
  await api.putEntry(pendingEntry({
    entity: "menu_items", recordId: "product-1", recordIds: ["product-1"], status: "confirmed"
  }));
  const snapshot = await api.syncStatusSnapshot();
  assert.equal(snapshot.counts.failed, 1);
  assert.equal(snapshot.counts.pending, 1);
  assert.equal(snapshot.blockingRecords.length, 2);
  assert.deepEqual(Array.from(snapshot.blockingRecords[0].recordIds), ["other-session"]);
  assert.deepEqual(Array.from(snapshot.blockingRecords[1].sessionIds), ["sale-session"]);
  assert.equal(snapshot.issues.length, 1);
});

const acknowledgedEntry = (overrides = {}) => {
  const payload = { auth_token: "expired-token", ids: ["request-1"], acknowledged_at: "2026-10-07T20:00:00Z", message: "Atendido" };
  return pendingEntry({ entity: "rpc:acknowledge_service_requests", recordId: "", recordIds: [],
    url: endpoint("rpc/acknowledge_service_requests"), method: "POST",
    headers: [["apikey", "test"], ["content-type", "application/json"], ["x-app-token", "expired-token"]],
    payload, body: JSON.stringify(payload), status: "failed", lastError: "400", ...overrides });
};

test("47 recupera la RPC 400 con credencial validada en cuerpo y cabecera", async () => {
  const entry = acknowledgedEntry();
  await api.putEntry(entry);
  let validations = 0;
  let sends = 0;
  remoteFetch = async (input) => {
    assert.equal(input.headers.get("x-app-token"), "valid-token");
    const body = await input.json();
    assert.equal(body.auth_token, "valid-token");
    if (new URL(input.url).pathname.endsWith("/rpc/get_current_user")) {
      validations += 1;
      return new Response(JSON.stringify({ id: "staff-1" }), { status: 200 });
    }
    sends += 1;
    assert.deepEqual(body.ids, entry.payload.ids);
    assert.equal(body.acknowledged_at, entry.payload.acknowledged_at);
    assert.equal(body.message, entry.payload.message);
    return new Response("[]", { status: 200 });
  };
  await flushAsAuthenticatedApp("valid-token");
  const saved = (await api.listEntries())[0];
  assert.equal(validations, 1);
  assert.equal(sends, 1);
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.operationId, entry.operationId);
  assert.equal(saved.id, entry.id);
});

test("48 conserva la RPC rechazada si la sesion nueva no valida", async () => {
  await api.putEntry(acknowledgedEntry());
  let sends = 0;
  remoteFetch = async (input) => {
    if (!new URL(input.url).pathname.endsWith("/rpc/get_current_user")) sends += 1;
    return new Response("{}", { status: 400 });
  };
  await flushAsAuthenticatedApp("invalid-token");
  assert.equal(sends, 0);
  assert.equal((await api.listEntries())[0].status, "failed");
  assert.equal((await api.listEntries())[0].payload.auth_token, "expired-token");
});

test("49 no reintenta la RPC con el mismo token ni modifica otros rechazos", async () => {
  await api.putEntry(acknowledgedEntry({ id: "same-token" }));
  await api.putEntry(acknowledgedEntry({ id: "bad-schema", lastError: "404" }));
  await api.putEntry(acknowledgedEntry({ id: "table-auth", headers: [["x-table-code", "mesa-1"]] }));
  let sends = 0;
  remoteFetch = async () => { sends += 1; return new Response("[]", { status: 200 }); };
  await flushAsAuthenticatedApp("expired-token");
  assert.equal(sends, 0);
  assert.equal((await api.listEntries()).filter((entry) => entry.status === "failed").length, 3);
});

test("50 conserva el mensaje real del 400 y no oculta un rechazo persistente", async () => {
  await api.putEntry(acknowledgedEntry());
  let sends = 0;
  remoteFetch = async (input) => {
    if (new URL(input.url).pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "staff-1" }), { status: 200 });
    sends += 1;
    return new Response(JSON.stringify({ code: "P0001", message: "Solicitudes invalidas. valid-token", details: null }), { status: 400 });
  };
  await flushAsAuthenticatedApp("valid-token");
  await flushAsAuthenticatedApp("valid-token");
  const saved = (await api.listEntries())[0];
  assert.equal(sends, 1);
  assert.equal(saved.status, "failed");
  assert.match(saved.lastError, /400.*P0001.*Solicitudes invalidas/);
  assert.doesNotMatch(saved.lastError, /valid-token/);
});

test("51 recupera un consumo 406 con sesion nueva sin duplicar su identidad", async () => {
  const entry = pendingEntry({ entity: "session_items", method: "POST", url: endpoint("session_items"),
    status: "conflict", lastError: "406", headers: [["x-app-token", "expired-token"]] });
  await api.putEntry(entry);
  let sends = 0;
  remoteFetch = async (input) => {
    assert.equal(input.headers.get("x-app-token"), "valid-token");
    if (new URL(input.url).pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "staff-1" }), { status: 200 });
    sends += 1;
    assert.equal(await input.text(), entry.body);
    return new Response(JSON.stringify({ id: "row-1" }), { status: 201 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal(sends, 1);
  const saved = (await api.listEntries())[0];
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.operationId, entry.operationId);
  assert.equal(saved.body, entry.body);
});

test("52 no descarta un consumo 406 cuya fila sigue sin ser visible", async () => {
  await api.putEntry(pendingEntry({ entity: "session_items", method: "PATCH", url: endpoint("session_items", "?id=eq.row-1"),
    status: "conflict", lastError: "406", headers: [["x-app-token", "expired-token"]] }));
  remoteFetch = async (input) => {
    if (new URL(input.url).pathname.endsWith("/rpc/get_current_user")) return new Response(JSON.stringify({ id: "staff-1" }), { status: 200 });
    return input.method === "GET" ? new Response("[]", { status: 200 }) : new Response("{}", { status: 406 });
  };
  await flushAsAuthenticatedApp("valid-token");
  assert.equal((await api.listEntries())[0].status, "conflict");
});

const sqlFailure = () => new Response(JSON.stringify({ code: "0A000",
  message: "WITH clause containing a data-modifying statement must be at the top level" }), { status: 400 });
const missingFailure = () => new Response(JSON.stringify({ code: "PGRST116",
  message: "Cannot coerce the result to a single JSON object", details: "The result contains 0 rows" }), { status: 406 });
const sqlRejectedEntry = (overrides = {}) => acknowledgedEntry({
  lastError: "400 · 0A000 · WITH clause containing a data-modifying statement must be at the top level", ...overrides
});
const completeItemEntry = (overrides = {}) => {
  const payload = { session_id: "session-1", table_id: "table-1", menu_item_id: "product-1",
    item_name: "Cerveza", quantity: 2, unit_price: 4500, status: "served", notes: "",
    updated_by_user_id: "staff-1" };
  return pendingEntry({ entity: "session_items", recordId: "item-1", recordIds: ["item-1"],
    url: endpoint("session_items", "?id=eq.item-1&select=*"), method: "PATCH",
    headers: [["apikey", "test"], ["x-app-token", "expired-token"], ["accept", "application/vnd.pgrst.object+json"]],
    status: "conflict", lastError: "406 · PGRST116 · The result contains 0 rows",
    payload, body: JSON.stringify(payload), ...overrides });
};

test("53 reproduce tres RPC 0A000 y consumo 406 de la foto, y libera la cola completa", async () => {
  const requests = new Map();
  for (let index = 0; index < 3; index += 1) {
    const payload = { ...acknowledgedEntry().payload, ids: [`request-${index}`] };
    requests.set(payload.ids[0], { id: payload.ids[0], status: "pending" });
    await api.putEntry(sqlRejectedEntry({ id: `rpc-${index}`, createdOrder: index + 1, payload, body: JSON.stringify(payload) }));
  }
  const item = completeItemEntry({ createdOrder: 4 });
  await api.putEntry(item);
  await api.putEntry(pendingEntry({ id: "next-write", createdOrder: 5 }));
  let savedItem = null;
  let inserts = 0;
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/acknowledge_service_requests")) return sqlFailure();
    if (url.pathname.endsWith("/rpc/get_current_user")) return Response.json({ id: "staff-1" });
    if (url.pathname.endsWith("/service_requests")) {
      const filter = url.searchParams.get("id");
      const rows = [...requests.values()].filter((row) => filter.includes(row.id));
      if (input.method === "PATCH") {
        const patch = await input.json();
        assert.equal(input.headers.get("accept"), "application/json");
        rows.forEach((row) => Object.assign(row, patch));
      }
      return Response.json(rows);
    }
    if (url.pathname.endsWith("/table_sessions")) return Response.json([{ id: "session-1", table_id: "table-1", status: "open" }]);
    if (url.pathname.endsWith("/session_items")) {
      if (input.method === "PATCH") return missingFailure();
      if (input.method === "POST") {
        inserts += 1;
        savedItem = await input.json();
        assert.equal(savedItem.id, item.recordId);
        return Response.json([savedItem], { status: 201 });
      }
      return Response.json(savedItem ? [savedItem] : []);
    }
    return Response.json([], { status: 201 });
  };
  // El token NO cambia: la causa de la foto es SQL, no una sesion vencida.
  await flushAsAuthenticatedApp("expired-token");
  assert.equal(inserts, 1);
  const saved = await api.listEntries();
  assert.equal(saved.length, 5);
  assert.equal(saved.filter((row) => row.status === "confirmed").length, 5);
  assert.equal(saved.find((row) => row.id === item.id).reconciledAs, "missing_item_restored");
  assert.equal(saved.find((row) => row.id === item.id).operationId, item.operationId);
  assert.equal(savedItem.quantity * savedItem.unit_price, 9000);
});

test("54 no aplica el fallback de solicitudes a un 400 distinto de 0A000", async () => {
  await api.putEntry(sqlRejectedEntry({ status: "pending" }));
  let patches = 0;
  remoteFetch = async (input) => {
    if (input.method === "PATCH") patches += 1;
    return Response.json({ code: "P0001", message: "Solicitudes invalidas." }, { status: 400 });
  };
  await api.flushQueue(true);
  assert.equal(patches, 0);
  assert.equal((await api.listEntries())[0].status, "failed");
});

test("55 no modifica solicitudes si la credencial no valida", async () => {
  await api.putEntry(sqlRejectedEntry());
  let patches = 0;
  remoteFetch = async (input) => {
    if (input.method === "PATCH") patches += 1;
    return new URL(input.url).pathname.endsWith("/rpc/acknowledge_service_requests")
      ? sqlFailure() : Response.json({}, { status: 401 });
  };
  await api.flushQueue(true);
  assert.equal(patches, 0);
  assert.equal((await api.listEntries())[0].status, "failed");
});

test("56 no confirma fallback REST 200 si el servidor no guardo el cambio", async () => {
  await api.putEntry(sqlRejectedEntry());
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/acknowledge_service_requests")) return sqlFailure();
    if (url.pathname.endsWith("/rpc/get_current_user")) return Response.json({ id: "staff-1" });
    return Response.json([{ id: "request-1", status: "pending" }]);
  };
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "failed");
});

test("57 una solicitud ya resuelta no se vuelve a abrir", async () => {
  await api.putEntry(sqlRejectedEntry());
  let patches = 0;
  remoteFetch = async (input) => {
    if (input.method === "PATCH") patches += 1;
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/acknowledge_service_requests")) return sqlFailure();
    if (url.pathname.endsWith("/rpc/get_current_user")) return Response.json({ id: "staff-1" });
    return Response.json([{ id: "request-1", status: "resolved" }]);
  };
  await api.flushQueue(true);
  assert.equal(patches, 0);
  assert.equal((await api.listEntries())[0].status, "confirmed");
});

test("58 no da por retirada una solicitud que todavia debe crearse", async () => {
  await api.putEntry(sqlRejectedEntry({ createdOrder: 1 }));
  const payload = { request_id: "request-1" };
  await api.putEntry(pendingEntry({ id: "later-create", entity: "rpc:create_service_request", payload,
    body: JSON.stringify(payload), createdOrder: 2, status: "failed", lastError: "401" }));
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    if (url.pathname.endsWith("/rpc/acknowledge_service_requests")) return sqlFailure();
    if (url.pathname.endsWith("/rpc/get_current_user")) return Response.json({ id: "staff-1" });
    return Response.json([]);
  };
  await api.flushQueue(true);
  assert.equal((await api.listEntries()).find((row) => row.entity === "rpc:acknowledge_service_requests").status, "failed");
});

const missingItemServer = ({ parent = "open", staffValid = true, invoice = null, rejectInsert = false } = {}) => {
  let restored = null;
  const calls = [];
  remoteFetch = async (input) => {
    const url = new URL(input.url);
    calls.push({ method: input.method, path: url.pathname });
    if (url.hostname === "script.google.com") {
      const body = await input.json();
      assert.equal(body.action, "get_income_report");
      return Response.json({ ok: true, records: invoice ? [invoice] : [] });
    }
    if (url.pathname.endsWith("/rpc/get_current_user")) return staffValid
      ? Response.json({ id: "staff-1" }) : Response.json({}, { status: 401 });
    if (url.pathname.endsWith("/table_sessions")) return Response.json(parent === "absent" ? []
      : [{ id: "session-1", table_id: "table-1", status: parent }]);
    if (input.method === "PATCH") return missingFailure();
    if (input.method === "POST") {
      if (rejectInsert) return Response.json({}, { status: 409 });
      restored = await input.json();
      return Response.json([restored], { status: 201 });
    }
    return Response.json(restored ? [restored] : []);
  };
  return calls;
};

test("59 cancelacion de un consumo ausente no crea cargos nuevos", async () => {
  const payload = { status: "cancelled", updated_by_user_id: "staff-1" };
  await api.putEntry(completeItemEntry({ payload, body: JSON.stringify(payload) }));
  const calls = missingItemServer();
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].reconciledAs, "already_removed");
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session_items")).length, 0);
});

test("60 un consumo oculto por credencial invalida no se considera retirado", async () => {
  const payload = { status: "cancelled" };
  await api.putEntry(completeItemEntry({ payload, body: JSON.stringify(payload) }));
  const calls = missingItemServer({ staffValid: false });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "conflict");
  assert.equal(calls.filter((call) => call.path.endsWith("/table_sessions")).length, 0);
});

test("61 cuenta ausente sin factura comprobada conserva el consumo pendiente", async () => {
  await api.putEntry(completeItemEntry());
  const calls = missingItemServer({ parent: "absent" });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "conflict");
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session_items")).length, 0);
});

const remoteInvoice = { sessionId: "session-1", items: [{ lineId: "item-1", name: "Cerveza",
  quantity: 2, unitPrice: 4500, menuItemId: "product-1" }] };
const configureArchiveRead = () => vm.runInContext(`archiveReadConfig = {
  url: "https://script.google.com/macros/s/test/exec", invoices: []
}`, context);

test("62 consumo facturado se verifica por UUID, precio y cantidad en el servidor", async () => {
  await api.putEntry(completeItemEntry());
  configureArchiveRead();
  const calls = missingItemServer({ parent: "absent", invoice: remoteInvoice });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].reconciledAs, "already_in_remote_invoice");
  assert.equal(calls.filter((call) => call.path.endsWith("/exec")).length, 1);
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session_items")).length, 0);
});

test("63 factura con cantidad distinta no libera el consumo", async () => {
  await api.putEntry(completeItemEntry());
  configureArchiveRead();
  missingItemServer({ parent: "closed", invoice: { ...remoteInvoice,
    items: [{ ...remoteInvoice.items[0], quantity: 1 }] } });
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("64 un INSERT de recuperacion rechazado conserva la identidad y el conflicto", async () => {
  const entry = completeItemEntry();
  await api.putEntry(entry);
  missingItemServer({ rejectInsert: true });
  await api.flushQueue(true);
  const saved = (await api.listEntries())[0];
  assert.equal(saved.status, "conflict");
  assert.equal(saved.body, entry.body);
  assert.equal(saved.operationId, entry.operationId);
});

test("65 no omite la creacion pendiente del mismo consumo", async () => {
  await api.putEntry(completeItemEntry({ createdOrder: 1 }));
  await api.putEntry(completeItemEntry({ id: "unsaved-create", method: "POST", status: "failed", lastError: "401",
    createdOrder: 2 }));
  const calls = missingItemServer();
  await api.flushQueue(true);
  assert.equal((await api.listEntries()).find((row) => row.method === "PATCH").status, "conflict");
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session_items")).length, 0);
});

test("66 un POST 406 o respuesta singular con varias filas no se descarta", async () => {
  await api.putEntry(completeItemEntry({ method: "POST", status: "pending" }));
  remoteFetch = async () => missingFailure();
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "conflict");
  reset();
  await api.putEntry(completeItemEntry());
  remoteFetch = async (input) => input.method === "PATCH"
    ? Response.json({ code: "PGRST116", details: "The result contains 2 rows" }, { status: 406 })
    : Response.json([]);
  await api.flushQueue(true);
  assert.equal((await api.listEntries())[0].status, "conflict");
});

test("67 el mensaje real de la app configura solo la lectura de la factura remota", async () => {
  await api.putEntry(completeItemEntry());
  missingItemServer({ parent: "closed", invoice: remoteInvoice });
  await flushAsAuthenticatedApp("expired-token", {
    appsScriptUrl: "https://script.google.com/macros/s/test/exec",
    invoices: [{ id: "invoice-1", sessionId: "session-1" }]
  });
  assert.equal((await api.listEntries())[0].reconciledAs, "already_in_remote_invoice");
});

test("68 sin configuracion valida no envia credenciales ni descarta el conflicto", async () => {
  await api.putEntry(completeItemEntry());
  configureArchiveRead();
  const calls = missingItemServer({ parent: "absent", invoice: remoteInvoice });
  await flushAsAuthenticatedApp("expired-token", {
    appsScriptUrl: "https://otra-web.example/macros/s/test/exec", invoices: []
  });
  assert.equal((await api.listEntries())[0].status, "conflict");
  assert.equal(calls.filter((call) => call.path.endsWith("/exec")).length, 0);
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
