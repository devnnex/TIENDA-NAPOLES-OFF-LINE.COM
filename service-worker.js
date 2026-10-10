const OFFLINE_CACHE = "tienda-napoles-offline-shell-v35";
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
  "./", "./index.html", "./admin.html", "./app.js", "./sales-shift.js", "./style.css",
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
  "save_table_zones", "record_session_payment", "replay_table_session_change"
]);
const RECONCILIATION_RPC_NAMES = new Set([
  "get_bootstrap_data", "get_admin_snapshot", "get_client_snapshot",
  "get_client_table_state", "list_chat_messages"
]);
const RPC_READ_ENTITIES = {
  get_bootstrap_data: ["business_settings", "restaurant_tables", "menu_categories", "menu_items"],
  get_admin_snapshot: ["restaurant_tables", "table_sessions", "session_items", "service_requests", "rpc:record_session_payment", "rpc:replay_table_session_change"],
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
const listEntries = async () => (await withStore("readonly", (store) => store.getAll())).map(normalizeStoredEntry);
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
  const blockingRecords = blocking.sort((left,right) => queueOrder(left)-queueOrder(right)).map((entry) => {
    const recordIds = new Set([...(entry.recordIds || []), entry.recordId,
      ...(entry.entity === "rpc:acknowledge_service_requests" ? (entry.payload?.ids || []) : [])]
      .filter(Boolean).map(String));
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
    const patches = entry.entity === "rpc:replay_table_session_change" ? [entry.payload?.p_patch] : payloads;
    const changedFields = [...new Set(patches.flatMap((patch) => Object.keys(patch || {})))].filter((field) => !/token|secret|password|pin|key/i.test(field));
    return { entity: entry.entity || "", status: entry.status, method: entry.method, changedFields, recordIds: [...recordIds], sessionIds,
      sessionStatus: entry.entity === "table_sessions" ? entry.payload?.status || "" : entry.entity === "rpc:replay_table_session_change" ? entry.payload?.p_patch?.status || "" : "" };
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
    if (headers.has("x-table-code") || headers.has("x-table-id")) continue;
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
    const entryHeaders = new Headers(entry.headers || []);
    if (entryHeaders.has("x-table-code") || entryHeaders.has("x-table-id")) return false;
    const previousToken = entryHeaders.get("x-app-token");
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

// Las RPC guardan la credencial tambien en el cuerpo. Un 400 antiguo no
// permite conocer el motivo: se reintenta una vez con una sesion nueva
// validada, conservando la misma operacion idempotente y sus identificadores.
const refreshQueuedRequestAuth = async (authToken) => {
  if (!networkAvailable || !authToken || typeof authToken !== "string") return;
  const candidates = (await listEntries()).filter((entry) => {
    const headers = new Headers(entry.headers || []);
    if (headers.has("x-table-code") || headers.has("x-table-id")) return false;
    if (String(entry.entity).startsWith("rpc:")) {
      let payload;
      try { payload = JSON.parse(entry.body); } catch (_) { return false; }
      const previousToken = payload?.auth_token || payload?.p_auth_token;
      if (!QUEUEABLE_RPC_NAMES.has(String(entry.entity).slice(4)) || !previousToken || previousToken === authToken) return false;
      return entry.status === "pending" || (entry.status === "failed"
        && /^(?:400|401)(?:\b|\s)/.test(String(entry.lastError || "")));
    }
    // PostgREST devuelve 406 cuando la credencial vieja deja de ver la fila
    // solicitada como objeto. Una credencial nueva debe validarse primero.
    return (UUID_REST_TABLES.has(entry.entity) || entry.entity === "business_settings")
      && headers.get("x-app-token") && headers.get("x-app-token") !== authToken
      && (entry.status === "pending" || (entry.status === "failed"
        && /^401(?:\b|\s)/.test(String(entry.lastError || "")))
        || (entry.status === "conflict" && /^406(?:\b|\s)/.test(String(entry.lastError || ""))));
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
  } catch (_) { return; }
  for (const candidate of candidates) {
    // No sobrescribir una operacion que el envio de fondo ya haya confirmado.
    const entry = (await listEntries()).find((saved) => saved.id === candidate.id);
    if (!entry || entry.status !== candidate.status || entry.body !== candidate.body) continue;
    const updatedHeaders = new Headers(entry.headers || []);
    updatedHeaders.set("x-app-token", authToken);
    updatedHeaders.delete("content-length");
    let body = entry.body;
    let payload = entry.payload;
    if (String(entry.entity).startsWith("rpc:")) {
      payload = JSON.parse(body);
      payload = { ...payload, [payload.auth_token ? "auth_token" : "p_auth_token"]: authToken };
      body = JSON.stringify(payload);
    }
    await putEntry({ ...entry, headers: [...updatedHeaders.entries()], body, payload,
      status: "pending", nextAttemptAt: 0, lastError: "" });
  }
};

const extractRecordId = (url, payload) => {
  const raw = url.searchParams.get("id") || "";
  if (raw.startsWith("eq.")) return raw.slice(3);
  if (!Array.isArray(payload) && payload?.id) return String(payload.id);
  if (!Array.isArray(payload) && payload?.payment_id) return String(payload.payment_id);
  if (!Array.isArray(payload) && payload?.p_session_id && url.pathname.endsWith("/replay_table_session_change")) return String(payload.p_session_id);
  return "";
};

const extractRecordIds = (url, payload) => {
  const single = extractRecordId(url, payload);
  if (single) return [single];
  const filter = url.searchParams.get("id") || "";
  if (filter.startsWith("in.(") && filter.endsWith(")")) return filter.slice(4, -1).split(",").filter(Boolean);
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
  const url = new URL(entry.url);
  let payload = entry.payload;
  if (payload == null) {
    try { payload = entry.body ? JSON.parse(entry.body) : {}; } catch (_) { payload = {}; }
  }
  const entity = entry.entity || (url.pathname.includes("/rpc/") ? `rpc:${rpcNameFor(url)}` : url.pathname.split("/").pop());
  return {
    ...entry,
    operationId: entry.operationId || entry.id || crypto.randomUUID(),
    entity,
    payload,
    recordId: entry.recordId || extractRecordId(url, payload),
    recordIds: [...new Set([...(entry.recordIds || []), ...extractRecordIds(url, payload), entry.recordId].filter(Boolean))],
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
  if (rpcName === "record_session_payment") return { payment: localRow(entry, {
    id: payload.payment_id, session_id: payload.p_session_id, amount: payload.p_amount,
    payment_method: payload.p_method, reference: payload.p_reference || "", created_at: payload.p_created_at
  }), duplicate: false };
  if (rpcName === "replay_table_session_change") return { session: localRow(entry, { id: payload.p_session_id, ...payload.p_patch }) };
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
      || (entry.status === "failed" && Number(entry.nextAttemptAt || 0) <= Date.now()
        && ((entry.entity === "rpc:acknowledge_service_requests" && isAcknowledgeSqlError(entry.lastError))
          || (entry.entity === "rpc:save_table_zones" && isZoneSqlError(entry.lastError))))
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
    const remapsOwnId = ["table_sessions", "rpc:replay_table_session_change"].includes(entry.entity) && String(entry.recordId || "") === previousId;
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

const isAcknowledgeSqlError = (message) => /\b0A000\b/.test(String(message || ""))
  && /WITH clause containing a data-modifying statement must be at the top level/i.test(String(message || ""));
const isZoneSqlError = (message) => /\b21000\b/.test(String(message || ""))
  && /UPDATE requires a WHERE clause/i.test(String(message || ""));

const staffForEntry = async (entry) => {
  const headers = new Headers(entry.headers || []);
  if (headers.has("x-table-code") || headers.has("x-table-id")) return null;
  const token = entry.payload?.auth_token || entry.payload?.p_auth_token || headers.get("x-app-token");
  if (!token) return null;
  headers.set("x-app-token", token);
  ["content-length", "prefer", "accept-profile"].forEach((key) => headers.delete(key));
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const response = await fetchWithTimeout(new Request(new URL("/rest/v1/rpc/get_current_user", entry.url), {
    method: "POST", headers, body: JSON.stringify({ auth_token: token })
  }), REMOTE_WRITE_TIMEOUT_MS);
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? { user, headers } : null;
};

const readStaffRows = async (entry, headers, table, ids) => {
  const url = new URL(`/rest/v1/${table}`, entry.url);
  url.searchParams.set("id", ids.length === 1 ? `eq.${ids[0]}` : `in.(${ids.join(",")})`);
  url.searchParams.set("select", "*");
  const readHeaders = new Headers(headers);
  readHeaders.delete("content-type");
  readHeaders.delete("prefer");
  const response = await fetchWithTimeout(new Request(url, { headers: readHeaders }), REMOTE_WRITE_TIMEOUT_MS);
  if (!response.ok) return null;
  const rows = await response.json();
  return Array.isArray(rows) ? rows : null;
};

const hasQueuedCreate = async (entity, ids) => (await listEntries()).some((stored) => {
  const candidate = normalizeStoredEntry(stored);
  if (candidate.status === "confirmed" || candidate.method !== "POST") return false;
  if (candidate.entity === entity) return (candidate.recordIds || [candidate.recordId]).some((id) => ids.includes(id));
  if (entity !== "service_requests") return false;
  if (candidate.entity === "rpc:create_service_request") return ids.includes(candidate.payload?.request_id);
  return candidate.entity === "rpc:create_service_requests_batch"
    && (candidate.payload?.requests || []).some((request) => ids.includes(request.request_id));
});

// El worker ya respondio localmente a la RPC: el fallback REST de app.js no
// puede ver su rechazo posterior. Reproducirlo aqui SOLO ante el error SQL
// confirmado, con una sesion validada y comprobacion remota del resultado.
const acknowledgeThroughRest = async (entry) => {
  const payload = entry.payload;
  if (entry.entity !== "rpc:acknowledge_service_requests" || !Array.isArray(payload?.ids)
    || !payload.ids.length || payload.ids.length > 50
    || payload.ids.some((id) => typeof id !== "string" || !/^[\w-]+$/.test(id))) return false;
  const staff = await staffForEntry(entry);
  if (!staff) return false;
  const ids = [...new Set(payload.ids)];
  const before = await readStaffRows(entry, staff.headers, "service_requests", ids);
  if (!before) return false;
  const missing = ids.filter((id) => !before.some((row) => row.id === id));
  if (await hasQueuedCreate("service_requests", missing)) return false;
  const live = before.filter((row) => ["pending", "acknowledged"].includes(row.status));
  const update = {
    status: "acknowledged", acknowledged_by_user_id: staff.user.id,
    acknowledged_at: payload.acknowledged_at || new Date().toISOString(),
    ...(payload.message == null ? {} : { message: String(payload.message).slice(0, 1000) })
  };
  if (live.length) {
    const url = new URL("/rest/v1/service_requests", entry.url);
    url.searchParams.set("id", `in.(${live.map((row) => row.id).join(",")})`);
    // Una solicitud resuelta mientras se envia nunca debe volver a abrirse.
    url.searchParams.set("status", "in.(pending,acknowledged)");
    const headers = new Headers(staff.headers);
    headers.set("Prefer", "return=representation");
    const response = await fetchWithTimeout(new Request(url, {
      method: "PATCH", headers, body: JSON.stringify(update)
    }), REMOTE_WRITE_TIMEOUT_MS);
    if (!response.ok) return false;
  }
  const after = await readStaffRows(entry, staff.headers, "service_requests", ids);
  if (!after || await hasQueuedCreate("service_requests", ids.filter((id) => !after.some((row) => row.id === id)))) return false;
  return after.every((row) => row.status === "resolved"
    || (row.status === "acknowledged" && row.acknowledged_by_user_id === update.acknowledged_by_user_id
      && new Date(row.acknowledged_at).getTime() === new Date(update.acknowledged_at).getTime()
      && (payload.message == null || row.message === update.message)));
};

const readZoneTables = async (entry, headers) => {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL("/rest/v1/restaurant_tables", entry.url);
    url.searchParams.set("select", "id,is_outdoor,qr_code,table_name");
    url.searchParams.set("order", "id.asc");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", String(offset));
    const response = await fetchWithTimeout(new Request(url, { headers }), REMOTE_WRITE_TIMEOUT_MS);
    if (!response.ok) return null;
    const rows = await response.json();
    if (!Array.isArray(rows)) return null;
    all.push(...rows);
    if (rows.length < 1000) return all;
  }
};

const isZoneServicePoint = (table) => /^(?:interno-bar-|interno-planter-)/.test(String(table.qr_code || ""))
  || /^(?:barra|matera)\s+\d+$/.test(String(table.table_name || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().trim());

// 21000 viene de safeupdate en la RPC del servidor. Solo se modifica la
// bandera de zona, con WHERE por UUID, usuario autorizado y lectura final.
const saveZonesThroughRest = async (entry) => {
  const ids = entry.payload?.outdoor_table_ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^[\w-]+$/.test(id))) return false;
  const staff = await staffForEntry(entry);
  if (!staff || !["admin", "boss"].includes(staff.user.role)
    || (staff.user.role !== "boss" && Array.isArray(staff.user.permissions)
      && !staff.user.permissions.includes("brand"))) return false;
  const before = await readZoneTables(entry, staff.headers);
  if (!before?.length) return false;
  const normal = before.filter((row) => !isZoneServicePoint(row));
  for (const outdoor of [false, true]) {
    const changed = normal.filter((row) => ids.includes(row.id) === outdoor && row.is_outdoor !== outdoor);
    for (let index = 0; index < changed.length; index += 100) {
      const url = new URL("/rest/v1/restaurant_tables", entry.url);
      url.searchParams.set("id", `in.(${changed.slice(index, index + 100).map((row) => row.id).join(",")})`);
      const response = await fetchWithTimeout(new Request(url, {
        method: "PATCH", headers: staff.headers, body: JSON.stringify({ is_outdoor: outdoor })
      }), REMOTE_WRITE_TIMEOUT_MS);
      if (!response.ok) return false;
    }
  }
  const after = await readZoneTables(entry, staff.headers);
  return Boolean(after && normal.every((row) => after.some((saved) => saved.id === row.id
    && saved.is_outdoor === ids.includes(row.id))));
};

let archiveReadConfig = null;

const verifyArchivedItem = async (entry, token) => {
  if (!archiveReadConfig || !entry.payload?.session_id) return false;
  // Solo lectura del historial ya existente. No registra ventas, no descuenta
  // inventario y no considera la mera ausencia de una mesa prueba de cobro.
  const invoice = archiveReadConfig.invoices.find((row) => row.sessionId === entry.payload.session_id);
  const response = await fetchWithTimeout(new Request(archiveReadConfig.url, {
    method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "get_income_report", authToken: token, origin: self.location.origin,
      payload: { filters: { dateFrom: "2000-01-01", dateTo: "2100-12-31", paymentMethod: "all",
        query: invoice?.id || "", limit: 500 } } }), redirect: "follow"
  }), REMOTE_WRITE_TIMEOUT_MS);
  if (!response.ok) return false;
  const result = await response.json();
  if (!result?.ok || result.stale || !Array.isArray(result.records)) return false;
  const sale = result.records.find((row) => row.sessionId === entry.payload.session_id);
  const line = sale?.items?.find((row) => row.lineId === entry.recordId);
  return Boolean(line && line.name === entry.payload.item_name
    && Number(line.quantity) === Number(entry.payload.quantity)
    && Number(line.unitPrice) === Number(entry.payload.unit_price)
    && String(line.menuItemId || "") === String(entry.payload.menu_item_id || ""));
};

// PGRST116 con cero filas no prueba que se haya guardado el consumo. Para
// un PATCH completo en una cuenta abierta se restaura el MISMO UUID; para
// una cuenta archivada se exige el detalle de la factura remota coincidente.
const recoverMissingSessionItem = async (entry, response) => {
  if (entry.entity !== "session_items" || entry.method !== "PATCH" || !entry.recordId
    || !entry.payload || Array.isArray(entry.payload)) return "";
  const error = await response.clone().json().catch(() => null);
  if (error?.code !== "PGRST116" || !/\b0 rows\b/i.test(String(error.details || ""))) return "";
  const staff = await staffForEntry(entry);
  if (!staff) return "";
  const rows = await readStaffRows(entry, staff.headers, "session_items", [entry.recordId]);
  if (!rows || rows.length || await hasQueuedCreate("session_items", [entry.recordId])) return "";
  if (entry.payload.status === "cancelled") return "already_removed";
  const payload = entry.payload;
  if (!payload.session_id || !payload.table_id || !payload.item_name || payload.status !== "served"
    || !Number.isFinite(Number(payload.unit_price)) || Number(payload.unit_price) < 0
    || !Number.isInteger(Number(payload.quantity)) || Number(payload.quantity) < 1 || Number(payload.quantity) > 100) return "";
  const sessions = await readStaffRows(entry, staff.headers, "table_sessions", [payload.session_id]);
  if (!sessions || await hasQueuedCreate("table_sessions", [payload.session_id])) return "";
  if (!sessions.length || sessions[0].status === "closed") {
    return await verifyArchivedItem(entry, staff.headers.get("x-app-token")) ? "already_in_remote_invoice" : "";
  }
  if (sessions.length !== 1 || sessions[0].status !== "open" || sessions[0].table_id !== payload.table_id) return "";
  const headers = new Headers(staff.headers);
  headers.set("Prefer", "return=representation");
  const restored = await fetchWithTimeout(new Request(new URL("/rest/v1/session_items", entry.url), {
    method: "POST", headers, body: JSON.stringify({ ...payload, id: entry.recordId,
      created_by_user_id: payload.created_by_user_id || staff.user.id })
  }), REMOTE_WRITE_TIMEOUT_MS);
  if (!restored.ok && restored.status !== 409) return "";
  return await verifyRestMutation(entry) ? "missing_item_restored" : "";
};

const isReconcilableTableSessionPatch = (entry) => {
  if (entry.entity !== "table_sessions" || entry.method !== "PATCH"
    || !entry.recordId || !entry.payload || Array.isArray(entry.payload)) return false;
  if (entry.payload.status === "closed") return true;
  const fields = Object.keys(entry.payload);
  return fields.length > 0 && fields.every((field) => ["payer_name", "assigned_waiter_id",
    "table_id", "sale_channel", "updated_by_user_id", "updated_at", "notes", "payment_method"].includes(field));
};

const readSessionForSync = async (entry, headers, token) => {
  const url = new URL("/rest/v1/rpc/get_table_session_for_sync", entry.url);
  try {
    const response = await fetchWithTimeout(new Request(url.href, {
      method: "POST", headers, body: JSON.stringify({ auth_token: token, p_session_id: entry.recordId })
    }), REMOTE_WRITE_TIMEOUT_MS);
    if (!response.ok) return null;
    const result = await response.json();
    return typeof result?.exists === "boolean" ? result : null;
  } catch (_) { return null; }
};

// Recupera un rechazo REST de cero filas mediante la operación autorizada
// del servidor, respetando el UUID, el cuerpo y el filtro de estado original.
const replayRejectedSessionPatch = async (entry) => {
  if (!isReconcilableTableSessionPatch(entry)) return false;
  const url = new URL(entry.url);
  if ([...url.searchParams.keys()].some((key) => !["id", "status", "select"].includes(key))) return false;
  const status = url.searchParams.get("status") || "";
  if (status && !status.startsWith("eq.")) return false;
  const staff = await staffForEntry(entry);
  if (!staff) return false;
  const response = await fetchWithTimeout(new Request(new URL("/rest/v1/rpc/replay_table_session_change", url).href, {
    method: "POST", headers: staff.headers,
    body: JSON.stringify({ auth_token: new Headers(entry.headers).get("x-app-token"), p_session_id: entry.recordId,
      p_patch: entry.payload, p_expected_status: status.slice(3), p_expected_paid: null })
  }), REMOTE_WRITE_TIMEOUT_MS);
  if (!response.ok) return false;
  const row = (await response.json())?.session;
  return Boolean(row?.id === entry.recordId && Object.entries(entry.payload).every(([key, value]) => {
    if (["updated_at", "closed_at"].includes(key)) return new Date(row[key]).getTime() === new Date(value).getTime() || key === "updated_at";
    if (["subtotal", "discount", "tax", "service_fee", "total"].includes(key)) return Number(row[key]) === Number(value);
    return row[key] === value;
  }));
};

const verifyCommittedTableSessionCreate = async (entry) => {
  if (entry.entity !== 'table_sessions' || entry.method !== 'POST' || !entry.recordId) return false;
  const rows = Array.isArray(entry.payload) ? entry.payload : [entry.payload];
  if (rows.length !== 1) return false;
  const payload = rows[0];
  const allowed = ['id','table_id','status','sale_channel','payer_name','assigned_waiter_id','opened_at','created_at','updated_at','created_by_user_id'];
  if (!payload || payload.id !== entry.recordId || !payload.table_id || (payload.status || 'open') !== 'open'
    || Object.keys(payload).some((field) => !allowed.includes(field))) return false;
  const staff = await staffForEntry(entry);
  if (!staff) return false;
  const authority = await readSessionForSync(entry,staff.headers,new Headers(entry.headers).get('x-app-token'));
  const row = authority?.session;
  return Boolean(authority?.exists && row?.id === payload.id && row.table_id === payload.table_id
    && ['open','closed'].includes(row.status) && (!payload.sale_channel || row.sale_channel === payload.sale_channel));
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
    const authority = await readSessionForSync(entry, headers, token);
    let rows;
    if (authority) rows = authority.session ? [authority.session] : [];
    else {
      const rowUrl = new URL(entry.url);
      rowUrl.search = '';
      rowUrl.searchParams.set('id',`eq.${entry.recordId}`);
      rowUrl.searchParams.set('select','id,status,subtotal,discount,tax,service_fee,total');
      const readHeaders = new Headers(headers); readHeaders.delete('content-type');
      const response = await fetchWithTimeout(new Request(rowUrl.href,{method:'GET',headers:readHeaders}),REMOTE_WRITE_TIMEOUT_MS);
      if (!response.ok) return false;
      rows = await response.json();
    }
    const matches = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    if (matches.length === 0) {
      if (!authority) return false;
      // Una cuenta creada sin conexion puede no existir todavia en Supabase.
      // En ese caso, el cambio no equivale a una cuenta ya retirada.
      const unsettledCreate = (await listEntries()).some((candidate) => candidate.entity === "table_sessions"
        && candidate.method === "POST" && candidate.recordId === entry.recordId
        && candidate.status !== "confirmed");
      return !unsettledCreate;
    }
    if (entry.payload.status !== "closed") {
      // Un cambio tardío de nombre o responsable no puede reabrir una cuenta
      // cerrada. No contiene importes y su estado terminal está verificado.
      if (matches.length !== 1 || matches[0]?.id !== entry.recordId || matches[0]?.status !== "closed") return false;
      return !(await hasQueuedCreate("table_sessions", [entry.recordId]));
    }
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
      if ((await listEntries()).find((saved) => saved.id === entry.id)?.status !== "conflict") continue;
      await putEntry({ ...entry, status: "confirmed", confirmedAt: new Date().toISOString(), lastError: "", reconciledAs: "already_closed_or_removed" });
      scheduleConfirmedCleanup();
      confirmedAny = true;
    } else {
      // Una cuenta que sigue abierta necesita reintentar su cambio original,
      // no esperar eternamente a que alguien mas la cierre. Nunca se quitan
      // los filtros ni se aplican importes sobre una cuenta ya cerrada.
      const staff = await staffForEntry(entry).catch(() => null);
      const authority = staff ? await readSessionForSync(entry, staff.headers, previousToken) : null;
      const rows = authority ? (authority.session ? [authority.session] : [])
        : staff ? await readStaffRows(entry, staff.headers, "table_sessions", [entry.recordId]).catch(() => null) : null;
      const replay = rows?.length === 1 && rows[0].id === entry.recordId && rows[0].status === "open";
      if ((await listEntries()).find((saved) => saved.id === entry.id)?.status !== "conflict") continue;
      await putEntry({ ...entry, ...(replay ? { status: "pending", nextAttemptAt: 0 } : {}), nextReconcileAt: now + 30_000 });
    }
  }
  return confirmedAny;
};

let flushingQueue = null;
let forceFlushRequested = false;

const queueOrder = (entry) => Number(entry.createdOrder || new Date(entry.createdAt || entry.queuedAt || 0).getTime());
const writeReferences = (stored) => {
  const entry = normalizeStoredEntry(stored);
  const url = new URL(entry.url);
  const rows = Array.isArray(entry.payload) ? entry.payload : [entry.payload || {}];
  const ids = [...new Set([...(entry.recordIds || []), entry.recordId,
    ...extractRecordIds(url, entry.payload)].filter(Boolean))];
  const refs = new Set(ids.map((id) => `${entry.entity}:${id}`));
  rows.forEach((row) => {
    if (row.session_id || row.p_session_id) refs.add(`session:${row.session_id || row.p_session_id}`);
    if (row.table_id || row.p_table_id) refs.add(`table:${row.table_id || row.p_table_id}`);
    if (row.menu_item_id) refs.add(`product:${row.menu_item_id}`);
    if (row.category_id) refs.add(`category:${row.category_id}`);
  });
  const sessionFilter = url.searchParams.get("session_id") || "";
  if (sessionFilter.startsWith("eq.")) refs.add(`session:${sessionFilter.slice(3)}`);
  if (entry.entity === "table_sessions") ids.forEach((id) => refs.add(`session:${id}`));
  if (entry.entity === "menu_items") ids.forEach((id) => refs.add(`product:${id}`));
  if (entry.entity === "menu_categories") ids.forEach((id) => refs.add(`category:${id}`));
  if (entry.entity === "restaurant_tables") ids.forEach((id) => refs.add(`table:${id}`));
  const financial = ["table_sessions", "session_items", "service_requests", "rpc:record_session_payment", "rpc:replay_table_session_change"].includes(entry.entity);
  return { entity: entry.entity, ids, refs, financial,
    unknownSession: financial && ![...refs].some((ref) => ref.startsWith("session:")) };
};
const writesAreRelated = (left, right) => {
  const a = writeReferences(left), b = writeReferences(right);
  if (a.entity === b.entity && (!a.ids.length || !b.ids.length)) return true;
  if ([a.entity, b.entity].includes("rpc:save_table_zones")
    && [a.entity, b.entity].includes("restaurant_tables")) return true;
  if (a.financial && b.financial && (a.unknownSession || b.unknownSession)) return true;
  return [...a.refs].some((ref) => b.refs.has(ref));
};

const flushQueue = (force = false) => {
  if (!networkAvailable) return entryCounts();
  if (force) forceFlushRequested = true;
  if (flushingQueue) return flushingQueue;
  const forceThisRun = forceFlushRequested;
  forceFlushRequested = false;
  flushingQueue = (async () => {
    let confirmedAny = false;
    const attempted = new Set();
    await recoverInterruptedEntries();
    await purgeConfirmedEntries();
    while (true) {
      if (!networkAvailable) break;
      const now = Date.now();
      const forceCurrentPass = forceThisRun || forceFlushRequested;
      forceFlushRequested = false;
      const blocked = (await listEntries()).filter((candidate) => candidate.status !== "confirmed")
        .sort((left, right) => queueOrder(left) - queueOrder(right));
      const found = blocked.find((candidate, index) => candidate.status === "pending" && !attempted.has(candidate.id)
        && (forceCurrentPass || Number(candidate.nextAttemptAt || 0) <= now)
        && !blocked.slice(0, index).some((earlier) => writesAreRelated(earlier, candidate)));
      const entry = found ? normalizeStoredEntry(found) : null;
      if (!entry) break;
      attempted.add(entry.id);
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
        let reconciledAs = "";
        // PostgREST puede responder 200 a un PATCH/DELETE cuyo filtro no
        // encontro filas. Para operaciones con identidad estable comprobamos
        // el estado final antes de liberar la cola.
        if (confirmed && entry.recordIds?.length && ["PATCH", "PUT", "DELETE"].includes(entry.method)) {
          confirmed = await verifyRestMutation(entry);
        }
        if (!confirmed && [406, 409].includes(response.status)) confirmed = await verifyRestMutation(entry);
        if (!confirmed && [406,409].includes(response.status) && await verifyCommittedTableSessionCreate(entry)) {
          confirmed = true; reconciledAs = 'session_creation_verified_with_authorization';
        }
        if (!confirmed && response.status === 409) confirmed = Boolean(await resolveOpenSessionConflict(entry));
        if (!confirmed && response.status === 406) {
          reconciledSessionPatch = await verifySettledTableSessionPatch(entry);
          confirmed = reconciledSessionPatch;
          if (!confirmed && entry.entity === "table_sessions") {
            confirmed = await replayRejectedSessionPatch(entry);
            if (confirmed) reconciledAs = "session_change_replayed_with_authorization";
          }
          if (!confirmed) {
            reconciledAs = await recoverMissingSessionItem(entry, response);
            confirmed = Boolean(reconciledAs);
          }
        }
        if (!confirmed && response.status === 400 && entry.entity === "rpc:acknowledge_service_requests") {
          const detail = await response.clone().json().catch(() => null);
          if (isAcknowledgeSqlError(`${detail?.code} ${detail?.message}`)) {
            confirmed = await acknowledgeThroughRest(entry);
            if (confirmed) reconciledAs = "acknowledged_through_rest";
          }
        }
        if (!confirmed && response.status === 400 && entry.entity === "rpc:save_table_zones") {
          const detail = await response.clone().json().catch(() => null);
          if (isZoneSqlError(`${detail?.code} ${detail?.message}`)) {
            confirmed = await saveZonesThroughRest(entry);
            if (confirmed) reconciledAs = "zones_saved_through_rest";
          }
        }
        if (confirmed) {
          await putEntry({ ...entry, status: "confirmed", confirmedAt: new Date().toISOString(), lastError: "",
            ...(reconciledSessionPatch ? { reconciledAs: "already_closed_or_removed" }
              : reconciledAs ? { reconciledAs } : {}) });
          scheduleConfirmedCleanup();
          confirmedAny = true;
          // El aviso de esta escritura no espera otros envíos de la cola.
          await notifyClients("OFFLINE_MUTATION_CONFIRMED", { entity: entry.entity, operationId: entry.operationId });
          syncLog("success", { operationId: entry.operationId, destination: "supabase", entity: entry.entity, attempts: entry.attempts, durationMs: Math.round(performance.now() - startedAt) });
          continue;
        }
        let message = `${response.status} ${response.statusText}`.trim();
        try {
          const detail = await response.clone().json();
          const reason = [detail?.code, detail?.message, detail?.details, detail?.hint]
            .filter((value) => typeof value === "string" && value).join(" · ");
          if (reason) message += ` · ${reason}`;
        } catch (_) { /* Un rechazo sin JSON conserva su codigo HTTP. */ }
        // El diagnostico no debe guardar ni mostrar credenciales.
        const secrets = [new Headers(entry.headers || []).get("x-app-token"),
          entry.payload?.auth_token, entry.payload?.p_auth_token].filter(Boolean);
        for (const secret of secrets) message = message.split(secret).join("[credencial]");
        message = message.slice(0, 500);
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
            continue;
          }
          const status = [406, 409].includes(response.status) ? "conflict" : "failed";
          await putEntry({ ...entry, status, attempts: Number(entry.attempts || 0) + 1, lastError: message,
            ...((entry.entity === "rpc:acknowledge_service_requests" && isAcknowledgeSqlError(message))
              || (entry.entity === "rpc:save_table_zones" && isZoneSqlError(message))
              ? { nextAttemptAt: Date.now() + 30_000 } : {}) });
          syncLog(status, { operationId: entry.operationId, destination: "supabase", attempts: Number(entry.attempts || 0) + 1, durationMs: Math.round(performance.now() - startedAt), error: message });
          await notifyClients("OFFLINE_SYNC_ISSUE", { status, operationId: entry.operationId, entity: entry.entity });
        }
        continue;
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
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
};

const scopedAdminReaders = new Set();
const scopedCoreReaders = new Set();
const directSupabaseRequest = async (request, url, clientId = "") => {
  if (!networkAvailable) {
    return new Response('{"message":"offline"}', { status: 503, headers: { "Content-Type": "application/json" } });
  }
  if (RECONCILIATION_RPC_NAMES.has(rpcNameFor(url))
    && !(rpcNameFor(url) === "get_admin_snapshot" && scopedAdminReaders.has(clientId))
    && !(rpcNameFor(url) === "get_bootstrap_data" && scopedCoreReaders.has(clientId))
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
    event.respondWith(directSupabaseRequest(request, url, event.clientId));
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "tienda-napoles-sync") event.waitUntil(flushQueue());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === 'SET_SCOPED_CORE_READ') {
    if (event.source?.id) {
      if (event.data.enabled === true) scopedCoreReaders.add(event.source.id);
      else scopedCoreReaders.delete(event.source.id);
    }
    event.ports?.[0]?.postMessage({ok:Boolean(event.source?.id)});
  }
  if (event.data?.type === "SET_SCOPED_ADMIN_READ") {
    if (event.source?.id) {
      if (event.data.enabled === true) scopedAdminReaders.add(event.source.id);
      else scopedAdminReaders.delete(event.source.id);
    }
    event.ports?.[0]?.postMessage({ ok: Boolean(event.source?.id) });
  }
  if (event.data?.type === "SET_NETWORK_STATUS") {
    networkAvailable = event.data.online !== false;
  }
  if (event.data?.type === "FLUSH_OFFLINE_QUEUE") {
    archiveReadConfig = null;
    try {
      const url = new URL(event.data?.appsScriptUrl);
      if (url.protocol === "https:" && url.hostname === "script.google.com"
        && /^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) {
        archiveReadConfig = { url: url.href,
          invoices: Array.isArray(event.data?.invoices) ? event.data.invoices : [] };
      }
    } catch (_) { /* La configuracion es opcional; sin prueba no se libera el consumo. */ }
    event.waitUntil(refreshQueuedSessionItemAuth(event.data?.authToken)
      .then(() => refreshQueuedTableSessionAuth(event.data?.authToken))
      .then(() => refreshQueuedRequestAuth(event.data?.authToken))
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
