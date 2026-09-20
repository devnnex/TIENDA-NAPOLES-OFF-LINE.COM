const OFFLINE_CACHE = "tienda-napoles-offline-shell-v2";
const REMOTE_CACHE = "tienda-napoles-offline-remote-v2";
const OFFLINE_DB = "tienda-napoles-offline-sync-v1";
const OFFLINE_STORE = "entries";
const CONFIRMED_RETENTION_MS = 2_000;
const REMOTE_READ_TIMEOUT_MS = 2_500;
const REMOTE_WRITE_TIMEOUT_MS = 4_000;
const MAX_RETRY_DELAY_MS = 30_000;
const BRAND_CACHE = "tienda-napoles-pwa-brand-v1";
const DYNAMIC_BRAND_ASSETS = new Set(["pwa-manifest.webmanifest", "pwa-icon-192.png", "pwa-icon-512.png"]);
const APP_SHELL = [
  "./", "./index.html", "./admin.html", "./app.js", "./style.css",
  "./manifest.webmanifest", "./pwa-icon.svg", "./sound/alarm.mp3",
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

const isSupabaseRequest = (url) => url.hostname.endsWith(".supabase.co");
const isRemoteDataRequest = (url) => isSupabaseRequest(url) || url.hostname === "script.google.com";
const isRestMutation = (request, url) =>
  isSupabaseRequest(url) && url.pathname.includes("/rest/v1/") && !url.pathname.includes("/rpc/")
  && ["POST", "PATCH", "PUT", "DELETE"].includes(request.method);
const rpcNameFor = (url) => url.pathname.split("/").pop() || "";
const isQueueableRpc = (request, url) =>
  isSupabaseRequest(url) && request.method === "POST" && url.pathname.includes("/rpc/")
  && QUEUEABLE_RPC_NAMES.has(rpcNameFor(url));

const SYNC_DEBUG = false;
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

let networkAvailable = true;

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
      || (["failed", "conflict"].includes(entry.status) && ["table_sessions", "session_items"].includes(entry.entity)))
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

const retryDelay = (attempts) => Math.min(MAX_RETRY_DELAY_MS, 500 * Math.pow(2, Math.min(attempts, 6)));
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
      await putEntry({ ...entry, status: "syncing", lastAttemptAt: new Date().toISOString() });
      syncLog("sending", { operationId: entry.operationId, entity: entry.entity, method: entry.method });
      try {
        const queuedRequest = new Request(entry.url, {
          method: entry.method,
          headers: entry.headers,
          body: ["GET", "HEAD"].includes(entry.method) ? undefined : entry.body
        });
        const response = await fetchWithTimeout(queuedRequest, REMOTE_WRITE_TIMEOUT_MS);
        let confirmed = response.ok;
        // PostgREST puede responder 200 a un PATCH/DELETE cuyo filtro no
        // encontro filas. Para operaciones con identidad estable comprobamos
        // el estado final antes de liberar la cola.
        if (confirmed && entry.recordIds?.length && ["PATCH", "PUT", "DELETE"].includes(entry.method)) {
          confirmed = await verifyRestMutation(entry);
        }
        if (!confirmed && [406, 409].includes(response.status)) confirmed = await verifyRestMutation(entry);
        if (!confirmed && response.status === 409) confirmed = Boolean(await resolveOpenSessionConflict(entry));
        if (confirmed) {
          await putEntry({ ...entry, status: "confirmed", confirmedAt: new Date().toISOString(), lastError: "" });
          scheduleConfirmedCleanup();
          confirmedAny = true;
          syncLog("success", { operationId: entry.operationId, entity: entry.entity });
          continue;
        }
        const message = `${response.status} ${response.statusText}`.trim();
        if (isTransientStatus(response.status)) {
          const attempts = Number(entry.attempts || 0) + 1;
          await putEntry({ ...entry, status: "pending", attempts, lastError: message, nextAttemptAt: Date.now() + retryDelay(attempts) });
          syncLog("retry", { operationId: entry.operationId, attempts, error: message });
        } else {
          const recoverableSessionConflict = response.status === 409
            && ["table_sessions", "session_items"].includes(entry.entity);
          if (recoverableSessionConflict) {
            const attempts = Number(entry.attempts || 0) + 1;
            await putEntry({ ...entry, status: "pending", attempts, lastError: message, nextAttemptAt: Date.now() + retryDelay(attempts) });
            syncLog("retry", { operationId: entry.operationId, attempts, error: message });
            break;
          }
          const status = [406, 409].includes(response.status) ? "conflict" : "failed";
          await putEntry({ ...entry, status, attempts: Number(entry.attempts || 0) + 1, lastError: message });
          syncLog(status, { operationId: entry.operationId, error: message });
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
        syncLog("retry", { operationId: entry.operationId, attempts, error: String(error?.message || error) });
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
  syncLog("queued", { operationId: entry.operationId, entity: entry.entity, method: entry.method });
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
  const cache = await caches.open(REMOTE_CACHE);
  const remote = isRemoteDataRequest(new URL(request.url));
  try {
    if (remote && !networkAvailable) throw new Error("offline");
    if (remote && await hasBlockingEntries()) throw new Error("pending_local_writes");
    const response = remote ? await fetchWithTimeout(request) : await fetch(request);
    if (response.ok && request.method === "GET") await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = request.method === "GET" ? await cache.match(request) : null;
    if (cached) return cached;
    throw error;
  }
};

const directSupabaseRequest = async (request, url) => {
  if (!networkAvailable) {
    return new Response('{"message":"offline"}', { status: 503, headers: { "Content-Type": "application/json" } });
  }
  if (RECONCILIATION_RPC_NAMES.has(rpcNameFor(url)) && await hasBlockingEntries()) {
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
    event.waitUntil(flushQueue(event.data?.force === true).then((counts) => event.ports?.[0]?.postMessage({ ok: true, counts })));
  }
  if (event.data?.type === "GET_OFFLINE_SYNC_STATUS") {
    event.waitUntil(entryCounts().then((counts) => event.ports?.[0]?.postMessage({ ok: true, counts })));
  }
});
