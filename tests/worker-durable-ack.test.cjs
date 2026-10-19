const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../service-worker.js'), 'utf8');

test('el reintento explícito conserva identidad y datos, sin cambiar solicitudes de clientes', async () => {
  const entries = [{ id: 'sale-job', operationId: 'same-operation', entity: 'session_items', status: 'failed', payload: { quantity: 2 } },
    { id: 'request-job', entity: 'service_requests', status: 'failed' }];
  const start = source.indexOf('const retryFailedStaffEntries ='), end = source.indexOf('const notifyClients =', start);
  const context = vm.createContext({ listEntries: async () => structuredClone(entries), putEntry: async value => {
    const index = entries.findIndex(entry => entry.id === value.id); entries[index] = value;
  } });
  vm.runInContext(source.slice(start, end) + ';globalThis.retry=retryFailedStaffEntries;', context);
  await context.retry();
  assert.equal(entries[0].operationId, 'same-operation');
  assert.equal(entries[0].payload.quantity, 2);
  assert.equal(entries[0].status, 'pending');
  assert.equal(entries[1].status, 'failed');
});

test('IndexedDB no confirma el trabajo cuando el request terminó pero la transacción abortó', async () => {
  const start = source.indexOf('const withStore ='), end = source.indexOf('const putEntry =', start);
  const database = { close() {}, transaction() {
    const tx = { objectStore: () => ({ put: () => {
      const request = {};
      setImmediate(() => { request.result = 'operation'; request.onsuccess(); setImmediate(() => tx.onabort()); });
      return request;
    } }) };
    return tx;
  } };
  const context = vm.createContext({ openOfflineDb: async () => database, OFFLINE_STORE: 'entries' });
  vm.runInContext(source.slice(start, end) + ';globalThis.write=()=>withStore("readwrite",store=>store.put({id:"one"}));', context);
  await assert.rejects(context.write(), /offline_transaction_aborted/);
});

test('el consumo local durable responde sin esperar la red y su cabecera de control no llega al servidor', async () => {
  const sent = [];
  let onSend;
  const started = new Promise(resolve => { onSend = resolve; });
  let release;
  const remote = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({ console: { info() {}, log() {}, warn() {}, debug() {} }, indexedDB: new IDBFactory(),
    Headers, Request, Response, URL, AbortController, crypto: webcrypto, performance,
    fetch: async request => { sent.push(request); onSend(); await remote; return new Response(request.body ? await request.clone().text() : '[]', { status: 200, headers: { 'Content-Type': 'application/json' } }); },
    setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; }, clearTimeout,
    self: { addEventListener() {}, clients: { matchAll: async () => [] }, registration: {} }
  });
  vm.runInContext(source + ';globalThis.api={save:saveLocallyThenSend,list:listEntries,flush:flushQueue};', context);
  const request = new Request('https://pos-test.supabase.co/rest/v1/session_items', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pos-local-commit': '1' }, body: JSON.stringify({ id: 'line-1', session_id: 'account', item_name: 'Agua', quantity: 1, unit_price: 100 }) });
  const response = await Promise.race([context.api.save(request), new Promise((_, reject) => setTimeout(() => reject(Error('waited_for_network')), 2000))]);
  assert.equal(response.ok, true);
  const localRows = await response.json();
  assert.equal((Array.isArray(localRows) ? localRows[0] : localRows).id, 'line-1');
  assert.equal((await context.api.list()).length, 1);
  await started;
  assert.ok(sent.length > 0);
  assert.equal(sent[0].headers.has('x-pos-local-commit'), false);
  release();
  await context.api.flush(true);
  assert.equal((await context.api.list())[0].status, 'confirmed');
});
