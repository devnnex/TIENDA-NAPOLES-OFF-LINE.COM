const OFFLINE_CACHE = "tienda-napoles-offline-shell-v15";
const REMOTE_CACHE = "tienda-napoles-offline-remote-v7";
const OFFLINE_DB = "tienda-napoles-offline-sync-v1";
const OFFLINE_STORE = "entries";
const CONFIRMED_RETENTION_MS = 2_000;
const REMOTE_READ_TIMEOUT_MS = 12_000;
const REMOTE_WRITE_TIMEOUT_MS = 12_000;
const MAX_RETRY_DELAY_MS = 30_000;
const BRAND_CACHE = "tienda-napoles-pwa-brand-v1";
const DYNAMIC_BRAND_ASSETS = new Set(["pwa-manifest.webmanifest", "pwa-icon-192.png", "pwa-icon-512.png"]);
const APP_SHELL = [
  "./", "./index.html", "./admin.html", "./app.js", "./style.css",
  "./manifest.webmanifest", "./pwa-icon.svg", "./tienda-napoles.ico", "./sound/alarm.mp3",
  "./sound/receipt-received.mp3", "./images/check.png", "./images/mesero.png",
  "./vendor/supabase-js.min.js", "./vendor/lucide.min.js",
  "./vendor/qrcode.min.js", "./vendor/jspdf.umd.min.js"
];

const UUID_REST_TABLES = new Set([
  "menu_categories", "menu_items", "restaurant_tables",
  "service_requests", "session_items", "table_sessions"
]);

// Solo estas RPC operativas poseen identificadores estables o son idempotentes.
// Autenticacion, usuarios y RPC de lectura nunca se simulan ni se encolan.
const QUEUEABLE_RPC_NAMES = new Set([
  "acknowledge_service_requests", "resolve_bill", "create_service_request",
  "create_service_requests_batch", "send_chat_message", "close_chat_session",
  "save_table_zones"
]);
const RECONCILIATION_RPC_NAMES = new Set([
  "get_bootstrap_data", "get_admin_snapshot", "get_client_snapshot",
  "get_client_table_state", "list_chat_messages"
]);
const RPC_READ_ENTITIES = {
  get_bootstrap_data: ["business_settings", "restaurant_tables", "menu_categories", "menu_items"],
  get_admin_snapshot: ["restaurant_tables", "table_sessions", "session_items", "service_requests"],
  get_client_snapshot: ["restaurant_tables", "table_sessions", "session_items", "service_requests", "menu_items"],
  get_client_table_state: ["restaurant_tables", "table_sessions", "session_items", "service_requests", "menu_items"],
  list_chat_messages: ["chat_sessions", "chat_messages"]
};

const isSupabaseRequest = (url) => url.hostname.endsWith(".supabase.co");
const isRemoteDataRequest = (url) => isSupabaseRequest(url) || url.hostname === "script.google.com";
const isRestMutation = (request, url) =>
  isSupabaseRequest(url) && url.pathname.includes("/rest/v1/") && !url.pathname.includes("/rpc/")
  && ["POST", "PATCH", "PUT", "DELETE"].includes(request.method);
const rpcNameFor = (url) => url.pathname.split("/").pop() || "";
const isQueueableRpc = (request, url) =>
  isSupabaseRequest(url) && request.method === "POST" && url.pathname.includes("/rpc/")
  && QUEUEABLE_RPC_NAMES.has(rpcNameFor(url));

const SYNC_DEBUG = true;
const syncLog = (event, detail = {}) => {
  if (SYNC_DEBUG) console.debug(`[SYNC] ${event}`, detail);
};

const openOfflineDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(OFFLINE_DB, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(OFFLINE_STORE)) {
      request.result.createObjectStore(OFFLINE_STORE, { keyPath: "id" });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const withStore = async (mode, action) => {
  const database = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OFFLINE_STORE, mode);
    const request = action(transaction.objectStore(OFFLINE_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
};

const putEntry = (entry) => withStore("readwrite", (store) => store.put(entry));
const listEntries = () => withStore("readonly", (store) => store.getAll());
const removeEntry = (id) => withStore("readwrite", (store) => store.delete(id));

const entryCounts = async () => (await listEntries()).reduce((counts, entry) => {
  const status = entry.status || "pending";
  counts[status] = Number(counts[status] || 0) + 1;
  return counts;
}, { pending: 0, syncing: 0, confirmed: 0, failed: 0, conflict: 0 });

const hasBlockingEntries = async () => (await listEntries())
  .some((entry) => ["pending", "syncing", "failed", "conflict"].includes(entry.status));

const hasBlockingEntriesForEntity = async (entity) => (await listEntries())
  .some((entry) => entry.entity === entity
    && ["pending", "syncing", "failed", "conflict"].includes(entry.status));

const hasBlockingEntriesForEntities = async (entities) => (await listEntries())
  .some((entry) => entities.includes(entry.entity)
    && ["pending", "syncing", "failed", "conflict"].includes(entry.status));

const blockingEntityNames = async () => [...new Set((await listEntries())
  .filter((entry) => ["pending", "syncing", "failed", "conflict"].includes(entry.status))
  .map((entry) => entry.entity)
  .filter(Boolean))];

const syncIssues = async () => (await listEntries())
  .filter((entry) => ["failed", "conflict"].includes(entry.status))
  .map((entry) => ({
    operationId: entry.operationId || entry.id,
    entity: entry.entity || "unknown",
    status: entry.status,
    error: String(entry.lastError || "").slice(0, 160)
  }));

const syncStatusSnapshot = async () => {
  const entries = await listEntries();
  const blocking = entries.filter((entry) => ["pending", "syncing", "failed", "conflict"].includes(entry.status));
  const counts = entries.reduce((result, entry) => {
    const status = entry.status || "pending";
    result[status] = Number(result[status] || 0) + 1;
    return result;
  }, { pending: 0, syncing: 0, confirmed: 0, failed: 0, conflict: 0 });
  const blockingRecords = blocking.map((entry) => {
    const recordIds = new Set([...(entry.recordIds || []), entry.recordId].filter(Boolean).map(String));
    try {
      const idFilter = new URL(entry.url).searchParams.get("id") || "";
      if (idFilter.startsWith("eq.")) recordIds.add(idFilter.slice(3));
      if (idFilter.startsWith("in.(") && idFilter.endsWith(")")) {
        idFilter.slice(4, -1).split(",").filter(Boolean).forEach((id) => recordIds.add(id));
      }
    } catch (_) { /* Una URL antigua no debe impedir consultar la cola. */ }
    const payloads = Array.isArray(entry.payload) ? entry.payload : [entry.payload];
    const sessionIds = [...new Set(payloads.flatMap((payload) => [payload?.session_id, payload?.p_session_id])
      .filter(Boolean).map(String))];
    return { entity: entry.entity || "", status: entry.status, recordIds: [...recordIds], sessionIds };
  });
  return {
    counts,
    blockingEntities: [...new Set(blocking.map((entry) => entry.entity).filter(Boolean))],
    blockingRecords,
    issues: blocking.filter((entry) => ["failed", "conflict"].includes(entry.status)).map((entry) => ({
      operationId: entry.operationId || entry.id,
      entity: entry.entity || "unknown",
      status: entry.status,
      error: String(entry.lastError || "").slice(0, 160)
    }))
  };
};

let networkAvailable = true;

// Una operacion de consumos puede quedar guardada con el token anterior.
// Solo la sesion autenticada de la app puede renovar esa credencial; nunca
// se recrea el consumo ni se reintenta un 401 con el mismo token rechazado.
const refreshQueuedSessionItemAuth = async (authToken) => {
  if (!authToken || typeof authToken !== "string") return;
  const entries = await listEntries();
  for (const entry of entries) {
    if (entry.entity !== "session_items" || !["pending", "failed"].includes(entry.status)) continue;
    if (entry.status === "failed" && !/^401(?:\b|\s)/.test(String(entry.lastError || ""))) continue;
    const headers = new Headers(entry.headers || []);
    const previousToken = headers.get("x-app-token");
    if (!previousToken || previousToken === authToken) continue;
    headers.set("x-app-token", authToken);
    await putEntry({
      ...entry,
      headers: [...headers.entries()],
      ...(entry.status === "failed" ? { status: "pending", nextAttemptAt: 0, lastError: "" } : {})
    });
  }
};

// Las aperturas y cambios de cuenta conservan el token con el que se
// encolaron. Tras iniciar una nueva sesion, solo se reintentan con ella si
// Supabase confirma primero que la credencial vigente es valida.
const refreshQueuedTableSessionAuth = async (authToken) => {
  if (!networkAvailable || !authToken || typeof authToken !== "string") return;
  const candidates = (await listEntries()).filter((entry) => {
    if (entry.entity !== "table_sessions") return false;
    const previousToken = new Headers(entry.headers || []).get("x-app-token");
    if (!previousToken || previousToken === authToken) return false;
    return entry.status === "pending"
      || (entry.status === "failed" && /^401(?:\b|\s)/.test(String(entry.lastError || "")))
      || (entry.status === "conflict" && /^406(?:\b|\s)/.test(String(entry.lastError || ""))
        && isReconcilableTableSessionPatch(entry));
  });
  if (!candidates.length) return;
  const headers = new Headers(candidates[0].headers || []);
  headers.set("x-app-token", authToken);
  ["content-length", "prefer", "accept-profile"].forEach((name) => headers.delete(name));
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  try {
    const authUrl = new URL("/rest/v1/rpc/get_current_user", candidates[0].url);
    const response = await fetchWithTimeout(new Request(authUrl.href, {
      method: "POST", headers, body: JSON.stringify({ auth_token: authToken })
    }), REMOTE_WRITE_TIMEOUT_MS);
    if (!response.ok || !(await response.json())?.id) return;
  } catch (_) {
    return;
  }
  for (const entry of candidates) {
    const updatedHeaders = new Headers(entry.headers || []);
    updatedHeaders.set("x-app-token", authToken);
    await putEntry({ ...entry, headers: [...updatedHeaders.entries()], status: "pending", nextAttemptAt: 0, lastError: "" });
  }
};

const extractRecordId = (url, payload) => {
  const raw = url.searchParams.get("id") || "";
  if (raw.startsWith("eq.")) return raw.slice(3);
  if (!Array.isArray(payload) && payload?.id) return String(payload.id);
  return "";
};

const extractRecordIds = (url, payload) => {
  const single = extractRecordId(url, payload);
  if (single) return [single];
  if (!Array.isArray(payload)) return [];
  return payload.map((row) => String(row?.id || "")).filter(Boolean);
};

const normalizeRestPayload = (request, url, rawBody) => {
  let payload = {};
  try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch (_) { return { body: rawBody, payload: {} }; }
  const table = url.pathname.split("/").pop();
  if (request.method === "POST" && UUID_REST_TABLES.has(table)) {
    const withId = (row) => row && typeof row === "object" && !row.id
      ? { ...row, id: crypto.randomUUID() }
      : row;
    payload = Array.isArray(payload) ? payload.map(withId) : withId(payload);
  }
  return { body: JSON.stringify(payload), payload };
};

const serializeRequest = async (request) => {
  const url = new URL(request.url);
  const rawBody = ["GET", "HEAD"].includes(request.method) ? "" : await request.clone().text();
  const normalized = isRestMutation(request, url)
    ? normalizeRestPayload(request, url, rawBody)
    : (() => {
        try { return { body: rawBody, payload: rawBody ? JSON.parse(rawBody) : {} }; }
        catch (_) { return { body: rawBody, payload: {} }; }
      })();
  const entity = url.pathname.includes("/rpc/") ? `rpc:${rpcNameFor(url)}` : url.pathname.split("/").pop();
  const recordIds = extractRecordIds(url, normalized.payload);
  return {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    source: "supabase",
    entity,
    recordId: recordIds[0] || "",
    recordIds,
    operationType: request.method,
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body: normalized.body,
    payload: normalized.payload,
    createdAt: new Date().toISOString(),
    createdOrder: performance.timeOrigin + performance.now(),
    attempts: 0,
    status: "pending",
    nextAttemptAt: 0,
    lastError: ""
  };
};

const normalizeStoredEntry = (entry) => {
  if (entry.operationId && entry.entity && entry.createdAt) return entry;
  const url = new URL(entry.url);
  let payload = {};
  try { payload = entry.body ? JSON.parse(entry.body) : {}; } catch (_) { payload = {}; }
  const entity = url.pathname.includes("/rpc/") ? `rpc:${rpcNameFor(url)}` : url.pathname.split("/").pop();
  return {
    ...entry,
    operationId: entry.operationId || entry.id || crypto.randomUUID(),
    entity,
    payload,
    recordId: entry.recordId || extractRecordId(url, payload),
    recordIds: entry.recordIds || extractRecordIds(url, payload),
    operationType: entry.operationType || entry.method,
    createdAt: entry.createdAt || entry.queuedAt || new Date().toISOString(),
    createdOrder: Number(entry.createdOrder || new Date(entry.createdAt || entry.queuedAt || 0).getTime()),
    attempts: Number(entry.attempts || 0),
    nextAttemptAt: Number(entry.nextAttemptAt || 0),
    lastError: entry.lastError || ""
  };
};

const wantsObject = (headers) => String(new Headers(headers).get("accept") || "")
  .includes("application/vnd.pgrst.object+json");

const localRow = (entry, row = {}) => {
  const now = new Date().toISOString();
  return {
    ...(row && typeof row === "object" ? row : {}),
    ...(entry.recordId ? { id: entry.recordId } : {}),
    id: row?.id || entry.recordId || crypto.randomUUID(),
    created_at: row?.created_at || now,
    updated_at: now,
    _offline_pending: true
  };
};

const queuedRpcPayload = (entry) => {
  const payload = entry.payload || {};
  const rpcName = String(entry.entity || "").replace(/^rpc:/, "");
  if (rpcName === "create_service_requests_batch") {
    return {
      results: (payload.requests || []).map((request) => ({
        request: localRow(entry, {
          id: request.request_id,
          table_id: request.table_id,
          session_id: request.session_id,
          request_type: request.request_type,
          message: request.message || "",
          status: "pending"
        }),
        duplicate: false
      }))
    };
  }
  if (rpcName === "create_service_request") {
    return {
      request: localRow(entry, {
        id: payload.request_id,
        table_id: payload.table_id,
        session_id: payload.session_id,
        request_type: payload.request_type,
        message: payload.message || "",
        status: "pending"
      }),
      duplicate: false
    };
  }
  if (rpcName === "send_chat_message") {
    return { message: localRow(entry, {
      id: payload.p_message_id,
      session_id: payload.p_session_id,
      table_id: payload.p_table_id,
      sender_type: payload.p_sender_type,
      body: payload.p_body
    }) };
  }
  if (rpcName === "acknowledge_service_requests") {
    return (payload.ids || []).map((id) => localRow(entry, {
      id,
      status: payload.message ? "resolved" : "acknowledged",
      acknowledged_at: payload.acknowledged_at,
      message: payload.message || ""
    }));
  }
  if (rpcName === "resolve_bill") return localRow(entry, { id: payload.request_id, status: "resolved" });
  if (rpcName === "close_chat_session") return { closed: true, session_id: payload.p_session_id };
  return { ok: true, offline_queued: true, operation_id: entry.operationId };
};

const queuedResponse = (entry) => {
  if (String(entry.entity).startsWith("rpc:")) {
    return new Response(JSON.stringify(queuedRpcPayload(entry)), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Offline-Queued": "1" }
    });
  }
  const payload = entry.payload || {};
  let body;
  if (entry.method === "DELETE") {
    const deleted = localRow(entry, { id: entry.recordId });
    body = wantsObject(entry.headers) ? deleted : [deleted];
  } else if (Array.isArray(payload)) {
    body = payload.map((row) => localRow(entry, row));
  } else {
    const row = localRow(entry, payload);
    body = wantsObject(entry.headers) ? row : [row];
  }
  return new Response(JSON.stringify(body), {
    status: entry.method === "POST" ? 201 : 200,
    headers: { "Content-Type": "application/json", "X-Offline-Queued": "1" }
  });
};

const purgeConfirmedEntries = async () => {
  const now = Date.now();
  const entries = await listEntries();
  await Promise.all(entries
    .filter((entry) => entry.status === "confirmed"
      && now - new Date(entry.confirmedAt || 0).getTime() >= CONFIRMED_RETENTION_MS)
    .map((entry) => removeEntry(entry.id)));
};

const scheduleConfirmedCleanup = () => {
  setTimeout(() => { void purgeConfirmedEntries(); }, CONFIRMED_RETENTION_MS);
};

const recoverInterruptedEntries = async () => {
  const entries = await listEntries();
  await Promise.all(entries
    .filter((entry) => entry.status === "syncing"
      || (["failed", "conflict"].includes(entry.status)
        && ["table_sessions", "session_items"].includes(entry.entity)
        && !/^401(?:\b|\s)/.test(String(entry.lastError || ""))
        && !(isReconcilableTableSessionPatch(entry)
          && /^406(?:\b|\s)/.test(String(entry.lastError || "")))))
    .map((entry) => putEntry({ ...entry, status: "pending", nextAttemptAt: 0 })));
};

const notifyClients = async (type, payload = {}) => {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  windows.forEach((client) => client.postMessage({ type, ...payload }));
};

const replaceSessionReference = (value, previousId, nextId) => {
  if (Array.isArray(value)) return value.map((entry) => replaceSessionReference(entry, previousId, nextId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
    key,
    ["session_id", "p_session_id"].includes(key) && String(entryValue || "") === previousId
      ? nextId
      : replaceSessionReference(entryValue, previousId, nextId)
  ]));
};

const remapQueuedSessionReferences = async (previousId, nextId, currentEntryId) => {
  const entries = await listEntries();
  for (const stored of entries) {
    if (stored.id === currentEntryId || stored.status === "confirmed") continue;
    const entry = normalizeStoredEntry(stored);
    const payload = replaceSessionReference(entry.payload, previousId, nextId);
    const url = new URL(entry.url);
    ["id", "session_id"].forEach((key) => {
      if (url.searchParams.get(key) === `eq.${previousId}`) url.searchParams.set(key, `eq.${nextId}`);
    });
    const remapsOwnId = entry.entity === "table_sessions" && String(entry.recordId || "") === previousId;
    const recordIds = remapsOwnId
      ? (entry.recordIds || []).map((id) => String(id) === previousId ? nextId : id)
      : entry.recordIds;
    const changed = JSON.stringify(payload) !== JSON.stringify(entry.payload)
      || url.href !== entry.url || remapsOwnId;
    if (!changed) continue;
    await putEntry({
      ...entry,
      payload,
      body: entry.body ? JSON.stringify(payload) : entry.body,
      url: url.href,
      recordId: remapsOwnId ? nextId : entry.recordId,
      recordIds,
      status: "pending",
      nextAttemptAt: 0,
      lastError: ""
    });
  }
};

const resolveOpenSessionConflict = async (entry) => {
  if (entry.entity !== "table_sessions" || entry.method !== "POST" || Array.isArray(entry.payload)) return null;
  const tableId = String(entry.payload?.table_id || "");
  const localSessionId = String(entry.payload?.id || entry.recordId || "");
  if (!tableId || !localSessionId || String(entry.payload?.status || "open") !== "open") return null;
  const lookupUrl = new URL(entry.url);
  lookupUrl.search = "";
  lookupUrl.searchParams.set("table_id", `eq.${tableId}`);
  lookupUrl.searchParams.set("status", "eq.open");
  lookupUrl.searchParams.set("select", "*");
  lookupUrl.searchParams.set("order", "opened_at.desc");
  lookupUrl.searchParams.set("limit", "1");
  const headers = new Headers(entry.headers);
  ["content-type", "content-length", "prefer"].forEach((name) => headers.delete(name));
  headers.set("Accept", "application/json");
  try {
    const lookup = await fetchWithTimeout(new Request(lookupUrl.href, { method: "GET", headers }), REMOTE_WRITE_TIMEOUT_MS);
    if (!lookup.ok) return null;
    const rows = await lookup.json();
    const remoteSession = Array.isArray(rows) ? rows[0] : rows;
    const remoteSessionId = String(remoteSession?.id || "");
    if (!remoteSessionId) return null;

    const updatePayload = Object.fromEntries(Object.entries(entry.payload || {})
      .filter(([key]) => !["id", "table_id", "status", "created_at", "updated_at", "opened_at"].includes(key)));
    if (Object.keys(updatePayload).length) {
      const updateUrl = new URL(entry.url);
      updateUrl.search = "";
      updateUrl.searchParams.set("id", `eq.${remoteSessionId}`);
      updateUrl.searchParams.set("select", "id");
      const updateHeaders = new Headers(entry.headers);
      updateHeaders.set("Content-Type", "application/json");
      updateHeaders.set("Accept", "application/json");
      updateHeaders.set("Prefer", "return=representation");
      const updated = await fetchWithTimeout(new Request(updateUrl.href, {
        method: "PATCH",
        headers: updateHeaders,
        body: JSON.stringify(updatePayload)
      }), REMOTE_WRITE_TIMEOUT_MS);
      if (!updated.ok) return null;
      const updatedRows = await updated.json();
      if (!(Array.isArray(updatedRows) ? updatedRows : [updatedRows]).some((row) => String(row?.id || "") === remoteSessionId)) return null;
    }

    await remapQueuedSessionReferences(localSessionId, remoteSessionId, entry.id);
    await notifyClients("OFFLINE_SESSION_REMAPPED", {
      previousId: localSessionId,
      sessionId: remoteSessionId,
      tableId
    });
    return remoteSessionId;
  } catch (_) {
    return null;
  }
};

const retryDelay = (attempts) => {
  const base = Math.min(MAX_RETRY_DELAY_MS, 500 * Math.pow(2, Math.min(attempts, 6)));
  return Math.round(base * (.75 + Math.random() * .5));
};
const isTransientStatus = (status) => [408, 425, 429, 500, 502, 503, 504].includes(status);
const comparable = (value) => value === null || typeof value !== "object" ? String(value ?? "") : JSON.stringify(value);

const desiredRowMatches = (row, payload) => {
  if (!row || !payload || Array.isArray(payload)) return Boolean(row);
  return Object.entries(payload)
    .filter(([key]) => !["created_at", "updated_at", "_offline_pending"].includes(key))
    .every(([key, value]) => comparable(row[key]) === comparable(value));
};

const verifyRestMutation = async (entry) => {
  const recordIds = entry.recordIds?.length ? entry.recordIds : (entry.recordId ? [entry.recordId] : []);
  if (!recordIds.length || String(entry.entity).startsWith("rpc:")) return false;
  const url = new URL(entry.url);
  url.search = "";
  url.searchParams.set("id", recordIds.length === 1 ? `eq.${recordIds[0]}` : `in.(${recordIds.join(",")})`);
  url.searchParams.set("select", "*");
  const headers = new Headers(entry.headers);
  ["content-type", "content-length", "prefer", "accept-profile"].forEach((name) => headers.delete(name));
  headers.set("Accept", "application/json");
  try {
    const response = await fetch(url.href, { method: "GET", headers });
    if (!response.ok) return false;
    const rows = await response.json();
    const received = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    if (entry.method === "DELETE") return received.length === 0;
    const desired = Array.isArray(entry.payload) ? entry.payload : [entry.payload];
    return desired.length === recordIds.length && desired.every((payload, index) => {
      const expectedId = String(payload?.id || recordIds[index] || "");
      const row = received.find((candidate) => String(candidate?.id || "") === expectedId);
      return desiredRowMatches(row, payload);
    });
  } catch (_) {
    return false;
  }
};

const isReconcilableTableSessionPatch = (entry) => {
  if (entry.entity !== "table_sessions" || entry.method !== "PATCH"
    || !entry.recordId || !entry.payload || Array.isArray(entry.payload)) return false;
  if (entry.payload.status === "closed") return true;
  const fields = Object.keys(entry.payload);
  return fields.length > 0 && fields.every((field) => ["payer_name", "assigned_waiter_id"].includes(field));
};

// Apps Script retira las cuentas cobradas de Supabase. Un cambio de nombre/
// responsable o un cierre que llega despues puede recibir 406. Solo se
// libera si la credencial es valida y la cuenta ya no existe o esta cerrada
// con los mismos importes; una creacion local sin confirmar sigue bloqueada.
const verifySettledTableSessionPatch = async (entry) => {
  if (!isReconcilableTableSessionPatch(entry)) return false;
  const headers = new Headers(entry.headers || []);
  const token = headers.get("x-app-token");
  if (!token) return false;
  ["content-length", "prefer", "accept-profile"].forEach((name) => headers.delete(name));
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  try {
    const authUrl = new URL("/rest/v1/rpc/get_current_user", entry.url);
    const authenticated = await fetchWithTimeout(new Request(authUrl.href, {
      method: "POST", headers, body: JSON.stringify({ auth_token: token })
    }), REMOTE_WRITE_TIMEOUT_MS);
    if (!authenticated.ok || !(await authenticated.json())?.id) return false;
    const rowUrl = new URL(entry.url);
    rowUrl.search = "";
    rowUrl.searchParams.set("id", `eq.${entry.recordId}`);
    rowUrl.searchParams.set("select", "id,status,subtotal,discount,tax,service_fee,total");
    const readHeaders = new Headers(headers);
    readHeaders.delete("content-type");
    const response = await fetchWithTimeout(new Request(rowUrl.href, {
      method: "GET", headers: readHeaders
    }), REMOTE_WRITE_TIMEOUT_MS);
    if (!response.ok) return false;
    const rows = await response.json();
    const matches = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    if (matches.length === 0) {
      // Una cuenta creada sin conexion puede no existir todavia en Supabase.
      // En ese caso, el cambio no equivale a una cuenta ya retirada.
      const unsettledCreate = (await listEntries()).some((candidate) => candidate.entity === "table_sessions"
        && candidate.method === "POST" && candidate.recordId === entry.recordId
        && candidate.status !== "confirmed");
      return !unsettledCreate;
    }
    if (entry.payload.status !== "closed") return false;
    const moneyFields = ["subtotal", "discount", "tax", "service_fee", "total"];
    return matches.length === 1 && matches[0]?.status === "closed"
      && moneyFields.every((field) => !Object.prototype.hasOwnProperty.call(entry.payload, field)
        || Number(matches[0][field]) === Number(entry.payload[field]));
  } catch (_) {
    return false;
  }
};

const reconcileTableSessionConflicts = async (authToken, force = false) => {
  if (!networkAvailable || !authToken || typeof authToken !== "string") return false;
  let confirmedAny = false;
  const now = Date.now();
  for (const entry of await listEntries()) {
    if (entry.status !== "conflict" || !isReconcilableTableSessionPatch(entry)
      || !/^406(?:\b|\s)/.test(String(entry.lastError || ""))) continue;
    const headers = new Headers(entry.headers || []);
    const previousToken = headers.get("x-app-token");
    if (!previousToken) continue;
    if (previousToken !== authToken) continue;
    if (!force && Number(entry.nextReconcileAt || 0) > now) continue;
    if (await verifySettledTableSessionPatch(entry)) {
      await putEntry({ ...entry, status: "confirmed", confirmedAt: new Date().toISOString(), lastError: "", reconciledAs: "already_closed_or_removed" });
      scheduleConfirmedCleanup();
      confirmedAny = true;
    } else {
      await putEntry({ ...entry, nextReconcileAt: now + 30_000 });
    }
  }
  return confirmedAny;
};

let flushingQueue = null;
let forceFlushRequested = false;

const flushQueue = (force = false) => {
  if (!networkAvailable) return entryCounts();
  if (force) forceFlushRequested = true;
  if (flushingQueue) return flushingQueue;
  const forceThisRun = forceFlushRequested;
  forceFlushRequested = false;
  flushingQueue = (async () => {
    let confirmedAny = false;
    await recoverInterruptedEntries();
    await purgeConfirmedEntries();
    while (true) {
      if (!networkAvailable) break;
      const now = Date.now();
      const forceCurrentPass = forceThisRun || forceFlushRequested;
      forceFlushRequested = false;
      const found = (await listEntries())
        .filter((candidate) => candidate.status === "pending" && (forceCurrentPass || Number(candidate.nextAttemptAt || 0) <= now))
        .sort((left, right) => Number(left.createdOrder || new Date(left.createdAt || left.queuedAt || 0).getTime())
          - Number(right.createdOrder || new Date(right.createdAt || right.queuedAt || 0).getTime()))[0];
      const entry = found ? normalizeStoredEntry(found) : null;
      if (!entry) break;
      const startedAt = performance.now();
      await putEntry({ ...entry, status: "syncing", lastAttemptAt: new Date().toISOString() });
      syncLog("sending", { operationId: entry.operationId, destination: "supabase", entity: entry.entity, method: entry.method, attempts: entry.attempts });
      try {
        const queuedRequest = new Request(entry.url, {
          method: entry.method,
          headers: entry.headers,
          body: ["GET", "HEAD"].includes(entry.method) ? undefined : entry.body
        });
        const response = await fetchWithTimeout(queuedRequest, REMOTE_WRITE_TIMEOUT_MS);
        let confirmed = response.ok;
        let reconciledSessionPatch = false;
        // PostgREST puede responder 200 a un PATCH/DELETE cuyo filtro no
        // encontro filas. Para operaciones con identidad estable comprobamos
        // el estado final antes de liberar la cola.
        if (confirmed && entry.recordIds?.length && ["PATCH", "PUT", "DELETE"].includes(entry.method)) {
          confirmed = await verifyRestMutation(entry);
        }
        if (!confirmed && [406, 409].includes(response.status)) confirmed = await verifyRestMutation(entry);
        if (!confirmed && response.status === 409) confirmed = Boolean(await resolveOpenSessionConflict(entry));
        if (!confirmed && response.status === 406) {
          reconciledSessionPatch = await verifySettledTableSessionPatch(entry);
          confirmed = reconciledSessionPatch;
        }
        if (confirmed) {
          await putEntry({ ...entry, status: "confirmed", confirmedAt: new Date().toISOString(), lastError: "",
            ...(reconciledSessionPatch ? { reconciledAs: "already_closed_or_removed" } : {}) });
          scheduleConfirmedCleanup();
          confirmedAny = true;
          syncLog("success", { operationId: entry.operationId, destination: "supabase", entity: entry.entity, attempts: entry.attempts, durationMs: Math.round(performance.now() - startedAt) });
          continue;
        }
        const message = `${response.status} ${response.statusText}`.trim();
        if (isTransientStatus(response.status)) {
          const attempts = Number(entry.attempts || 0) + 1;
          await putEntry({ ...entry, status: "pending", attempts, lastError: message, nextAttemptAt: Date.now() + retryDelay(attempts) });
          syncLog("retry", { operationId: entry.operationId, destination: "supabase", attempts, durationMs: Math.round(performance.now() - startedAt), error: message });
        } else {
          const recoverableSessionConflict = response.status === 409
            && ["table_sessions", "session_items"].includes(entry.entity);
          if (recoverableSessionConflict) {
            const attempts = Number(entry.attempts || 0) + 1;
            await putEntry({ ...entry, status: "pending", attempts, lastError: message, nextAttemptAt: Date.now() + retryDelay(attempts) });
            syncLog("retry", { operationId: entry.operationId, destination: "supabase", attempts, durationMs: Math.round(performance.now() - startedAt), error: message });
            break;
          }
          const status = [406, 409].includes(response.status) ? "conflict" : "failed";
          await putEntry({ ...entry, status, attempts: Number(entry.attempts || 0) + 1, lastError: message });
          syncLog(status, { operationId: entry.operationId, destination: "supabase", attempts: Number(entry.attempts || 0) + 1, durationMs: Math.round(performance.now() - startedAt), error: message });
          await notifyClients("OFFLINE_SYNC_ISSUE", { status, operationId: entry.operationId, entity: entry.entity });
        }
        break;
      } catch (error) {
        const attempts = Number(entry.attempts || 0) + 1;
        await putEntry({
          ...entry,
          status: "pending",
          attempts,
          lastError: String(error?.message || error || "network_error"),
          nextAttemptAt: Date.now() + retryDelay(attempts)
        });
        syncLog("retry", { operationId: entry.operationId, destination: "supabase", attempts, durationMs: Math.round(performance.now() - startedAt), error: String(error?.message || error) });
        break;
      }
    }
    await purgeConfirmedEntries();
    if (confirmedAny) await notifyClients("OFFLINE_QUEUE_FLUSHED", { counts: await entryCounts() });
    return entryCounts();
  })().finally(() => {
    const rerunForced = forceFlushRequested && networkAvailable;
    forceFlushRequested = false;
    flushingQueue = null;
    if (rerunForced) void flushQueue(true);
  });
  return flushingQueue;
};

const saveLocallyThenSend = async (request) => {
  const entry = await serializeRequest(request);
  await putEntry(entry);
  syncLog("queued", { operationId: entry.operationId, destination: "supabase", entity: entry.entity, method: entry.method, attempts: 0 });
  if (self.registration.sync) {
    try { await self.registration.sync.register("tienda-napoles-sync"); } catch (_) { /* El pulso de la app tambien reintenta. */ }
  }
  if (networkAvailable) void flushQueue();
  return queuedResponse(entry);
};

const fetchWithTimeout = async (request, timeoutMs = REMOTE_READ_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(new Request(request, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
};

const networkFirst = async (request) => {
  const url = new URL(request.url);
  const remote = isRemoteDataRequest(url);
  if (remote) {
    if (!networkAvailable) throw new Error("offline");
    // Una escritura pendiente de mesas no debe congelar marca, catalogo ni
    // otros GET independientes. Solo protegemos la misma entidad para evitar
    // que una lectura remota pise su estado optimista local.
    if (isSupabaseRequest(url) && url.pathname.includes("/rest/v1/") && !url.pathname.includes("/rpc/")) {
      const entity = url.pathname.split("/").pop();
      if (await hasBlockingEntriesForEntity(entity)) throw new Error("pending_local_writes");
    }
    // Las respuestas remotas pueden incluir marca, inventario o datos privados.
    // La copia offline de esos datos vive en IndexedDB, no en CacheStorage.
    return fetchWithTimeout(new Request(request, { cache: "no-store" }), REMOTE_READ_TIMEOUT_MS);
  }
  const cache = await caches.open(OFFLINE_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
};

const directSupabaseRequest = async (request, url) => {
  if (!networkAvailable) {
    return new Response('{"message":"offline"}', { status: 503, headers: { "Content-Type": "application/json" } });
  }
  if (RECONCILIATION_RPC_NAMES.has(rpcNameFor(url))
    && await hasBlockingEntriesForEntities(RPC_READ_ENTITIES[rpcNameFor(url)] || [])) {
    return new Response('{"message":"pending_local_writes"}', { status: 503, headers: { "Content-Type": "application/json" } });
  }
  try {
    return await fetchWithTimeout(request);
  } catch (_) {
    return new Response('{"message":"offline"}', { status: 503, headers: { "Content-Type": "application/json" } });
  }
};

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith("tienda-napoles-offline-") && ![OFFLINE_CACHE, REMOTE_CACHE].includes(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/__tienda_napoles_drawer")) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.method === "GET") {
    if (url.origin === self.location.origin) {
      if (DYNAMIC_BRAND_ASSETS.has(url.pathname.split("/").pop())) {
        event.respondWith((async () => {
          const brandCache = await caches.open(BRAND_CACHE);
          const branded = await brandCache.match(request, { ignoreSearch: true });
          return branded || networkFirst(request);
        })());
        return;
      }
      event.respondWith(networkFirst(request).catch(async () => {
        const cache = await caches.open(OFFLINE_CACHE);
        return (await cache.match(request, { ignoreSearch: true })) || (await cache.match("./index.html"));
      }));
      return;
    }
    if (isRemoteDataRequest(url)) event.respondWith(networkFirst(request));
    return;
  }
  if (isRestMutation(request, url) || isQueueableRpc(request, url)) {
    const response = saveLocallyThenSend(request);
    event.respondWith(response);
    event.waitUntil(response.then(() => flushQueue()));
    return;
  }
  if (isSupabaseRequest(url) && request.method === "POST" && url.pathname.endsWith("/rpc/login")) {
    // La renovacion de una sesion abierta offline debe funcionar antes de
    // reanudar el envio de operaciones pendientes.
    event.respondWith(fetch(request));
    return;
  }
  if (isSupabaseRequest(url) && request.method === "POST" && url.pathname.includes("/rpc/")) {
    event.respondWith(directSupabaseRequest(request, url));
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "tienda-napoles-sync") event.waitUntil(flushQueue());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_NETWORK_STATUS") {
    networkAvailable = event.data.online !== false;
  }
  if (event.data?.type === "FLUSH_OFFLINE_QUEUE") {
    event.waitUntil(refreshQueuedSessionItemAuth(event.data?.authToken)
      .then(() => refreshQueuedTableSessionAuth(event.data?.authToken))
      .then(() => reconcileTableSessionConflicts(event.data?.authToken, event.data?.force === true))
      .then(async (reconciled) => {
        const counts = await flushQueue(event.data?.force === true);
        if (reconciled) await notifyClients("OFFLINE_QUEUE_FLUSHED", { counts });
        return counts;
      })
      .then((counts) => event.ports?.[0]?.postMessage({ ok: true, counts })));
  }
  if (event.data?.type === "GET_OFFLINE_SYNC_STATUS") {
    event.waitUntil(syncStatusSnapshot()
      .then((status) => event.ports?.[0]?.postMessage({ ok: true, ...status })));
  }
});
