const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const start = source.indexOf("  const pendingPeerRefreshes =");
const end = source.indexOf("  let adminRefreshPending =", start);
assert.ok(start >= 0 && end > start);
const timers = new Map(), sent = [];
let timerId = 0, responseOk = true, throwNetwork = false, gate = null;
const navigator = { onLine: true };
const context = vm.createContext({
  navigator, AbortController,
  state: { authToken: "staff-token", currentUser: { id: "staff" }, adminBroadcastChannel: null },
  SUPABASE_CONFIG: { url: "https://test.supabase.co", anonKey: "public-key" },
  window: { setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id) },
  fetch: async (url, options) => {
    sent.push({ url, options, body: JSON.parse(options.body) });
    if (gate) await gate;
    if (throwNetwork) throw new Error("Sin internet");
    return { ok: responseOk };
  }
});
vm.runInContext(source.slice(start, end) + ";globalThis.api = { notifyAdminPeers, flushPeerRefreshes };", context);
const settle = () => new Promise(setImmediate);

(async () => {
  context.api.notifyAdminPeers({ operational: true, core: true, reports: true, users: true });
  await settle();
  assert.equal(sent.length, 1, "Una petición entrega los avisos sin esperar un socket conectado.");
  assert.deepEqual(sent[0].body.messages.map((message) => message.event).sort(),
    ["refresh", "core-refresh", "reports-refresh", "users-refresh"].sort());
  assert.ok(sent[0].body.messages.every((message) => message.topic === "admin" && message.private === false));
  assert.ok(sent[0].body.messages.every((message) => Object.keys(message.payload).length === 0), "No transmite datos del negocio.");
  assert.equal(timers.size, 0);

  responseOk = false;
  context.api.notifyAdminPeers({ core: true });
  await settle();
  const retry = [...timers.values()].find((timer) => timer.delay === 1000);
  assert.ok(retry, "Un rechazo del aviso programa su reintento.");
  responseOk = true;
  retry.callback();
  await settle();
  assert.equal(sent.at(-1).body.messages[0].event, "core-refresh");

  navigator.onLine = false;
  const beforeOffline = sent.length;
  context.api.notifyAdminPeers({ reports: true });
  await settle();
  assert.equal(sent.length, beforeOffline);
  navigator.onLine = true;
  context.api.notifyAdminPeers({ operational: true });
  await settle();
  assert.deepEqual(sent.at(-1).body.messages.map((message) => message.event).sort(), ["reports-refresh", "refresh"].sort(),
    "La reconexión entrega el aviso retenido junto al nuevo.");

  let finishRequest;
  gate = new Promise((resolve) => { finishRequest = resolve; });
  context.api.notifyAdminPeers({ core: true });
  context.api.notifyAdminPeers({ users: true });
  finishRequest();
  await settle();
  gate = null;
  await context.api.flushPeerRefreshes();
  assert.equal(sent.at(-1).body.messages[0].event, "users-refresh", "Los cambios confirmados durante otro aviso conservan su entrega.");
  console.log("PASS Offline a BCA: entrega HTTP confirmada, todos los dominios, reintentos, reconexión y avisos concurrentes");
})().catch((error) => { console.error(error); process.exitCode = 1; });
