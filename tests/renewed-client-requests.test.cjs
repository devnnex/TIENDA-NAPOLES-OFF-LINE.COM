const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (from, to) => {
  const start = source.indexOf('  const ' + from + ' =');
  const end = source.indexOf('  const ' + to + ' =', start + 1);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function harness() {
  const saved = new Map(), completed = new Set(), rpcCalls = [], signals = [];
  const admin = { requests: [], tables: [], adminSyncBusy: true, adminChats: new Map() };
  let renders = 0, gate = null;
  const normalizeText = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const adminContext = vm.createContext({ state: admin, normalizeText,
    rememberCompletedAdminRequests: (ids = []) => { ids.forEach(id => completed.add(id)); return completed; },
    mergeOptimisticRequests: rows => rows, persistPendingAdminRequests() {},
    compareRequestArrival: (a, b) => String(a.created_at).localeCompare(String(b.created_at)),
    renderAdminLive: () => { renders++; } });
  vm.runInContext(section('isSongRequest', 'hasOpenAdminChatForRequest')
    + section('receiveAdminRequests', 'refreshAdminRequests')
    + section('groupedActiveRequests', 'requestGroupDetailsHtml')
    + ';globalThis.api = {receiveAdminRequests, groupedActiveRequests};', adminContext);
  const clients = [];
  const client = tableId => {
    let serial = 0, timerId = 0;
    const timers = new Map(), storage = new Map(), chatMessages = [], notices = [];
    const state = { page: 'client', currentTable: { id: tableId }, currentSession: { id: 'session-' + tableId },
      clientRequests: [], clientQueuePositions: [], requestOutboxMemory: [], adminChatActive: true,
      clientStaffMessageSoundIds: new Set(), assistantThreads: { bar: [], song: [] }, assistantMode: 'bar', chatMessages: [] };
    admin.tables.push({ id: tableId });
    state.sb = { rpc: async (name, payload) => {
      rpcCalls.push({ name, payload });
      assert.equal(name, 'createServiceRequestsBatch');
      if (gate) await gate;
      return { data: { results: payload.requests.map(event => {
        if (!saved.has(event.request_id)) saved.set(event.request_id, {
          ...event, id: event.request_id, status: 'pending', created_at: new Date().toISOString()
        });
        return { request: { ...saved.get(event.request_id) } };
      }) } };
    } };
    const context = vm.createContext({ state, Date, console, REQUEST_OUTBOX_KEY: 'outbox',
      navigator: { onLine: true }, normalizeText, uid: () => tableId + '-' + ++serial,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      window: { clearTimeout: id => timers.delete(id), setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; } },
      readRealtimeData: async query => (await query).data,
      signalRequestArrival: async (attempt, ids) => { signals.push([...ids]); adminContext.api.receiveAdminRequests(ids.map(id => ({ ...saved.get(id) }))); },
      renderBillChat() {}, refreshClientPosData() {}, renderAssistant() {}, setPeerTyping() {},
      $: () => ({ hidden: true, scrollIntoView() {} }),
      tableCode: table => 'code-' + table.id, tableLabel: table => 'Mesa ' + table.id, polishGuestText: text => text,
      assistantSay: (role, text) => { const message = { id: tableId + '-message-' + ++serial, role, text }; notices.push(message); return message; },
      persistChatMessage: async (role, text, options) => { chatMessages.push({ role, text, ...options }); return { id: options.messageId }; },
      broadcastChatEvent() {}, ensureOpenSession: async () => state.currentSession,
      findAssistantItem: () => null, includesAny: (text, words) => words.some(word => text.includes(word)),
      assistantUnderstands: () => false, parseAssistantOrder: () => null,
      document: { querySelector: () => null }, toast() {}, REQUEST_LABELS: { waiter: 'Mesero' }
    });
    vm.runInContext(section('readRequestOutbox', 'signalRequestArrival')
      + section('flushRequestOutbox', 'mergeChatMessageList')
      + section('isSongRequest', 'hasOpenAdminChatForRequest')
      + section('songTurnCount', 'addItemToSession')
      + section('finishClientChat', 'fetchChatMessages')
      + section('createRequest', 'thankBill')
      + ';globalThis.api = {handleAssistantMessage, handleSongRequest, createServiceNotification, createRequest, finishClientChat, songTurnCount};', context);
    const result = { state, api: context.api, chatMessages, notices,
      drain: async () => {
        await settle();
        while ([...timers.values()].some(timer => timer.delay === 0)) {
          for (const [id, timer] of [...timers]) if (timer.delay === 0) { timers.delete(id); timer.callback(); }
          await settle();
        }
      } };
    clients.push(result); return result;
  };
  return { admin, saved, rpcCalls, signals, client, renders: () => renders,
    groups: () => adminContext.api.groupedActiveRequests(),
    resolve(ids) { ids.forEach(id => { saved.get(id).status = 'resolved'; }); adminContext.api.receiveAdminRequests(ids.map(id => ({ ...saved.get(id) }))); },
    pause() { let release; gate = new Promise(resolve => { release = resolve; }); return () => { release(); gate = null; }; }
  };
}
test('Cada mensaje aparece como solicitud nueva, incluso con chat activo, respondido o cerrado sin aviso al cliente', async () => {
  const h = harness(), client = h.client('a');
  await client.api.handleAssistantMessage('Hola'); await client.drain();
  const first = h.groups()[0];
  assert.equal(first.kind, 'chat'); assert.equal(first.count, 1);
  h.resolve(first.request_ids);
  assert.equal(h.groups().length, 0);
  assert.equal(client.state.adminChatActive, true, 'Simula el cierre cuyo aviso no llegó al cliente.');
  await client.api.handleAssistantMessage('Hola'); await client.drain();
  const reopened = h.groups()[0];
  assert.equal(reopened.count, 1); assert.notEqual(reopened.id, first.id);
  await client.api.handleAssistantMessage('Hola'); await client.drain();
  assert.equal(h.groups()[0].count, 2);
  assert.equal(new Set(h.groups()[0].request_ids).size, 2);
  client.api.finishClientChat();
  assert.equal(client.state.adminChatActive, false);
  await client.api.handleAssistantMessage('Hola nuevamente'); await client.drain();
  assert.equal(h.groups()[0].count, 3);
  assert.equal(client.chatMessages.length, 4);
  assert.ok(h.groups()[0].entries.some(row => row.message.includes('Hola nuevamente')));
});
test('Distintas mesas y categorias llegan inmediatamente al confirmar la escritura, aunque el snapshot esté ocupado', async () => {
  const h = harness(), a = h.client('a'), b = h.client('b');
  const release = h.pause();
  const message = a.api.handleAssistantMessage('Necesito atención');
  assert.equal(h.rpcCalls.length, 1, 'El envio inicia en el mismo evento sin esperar un temporizador.');
  await message;
  assert.equal(h.renders(), 0, 'Las solicitudes se muestran después de confirmarlas en la base de datos.');
  release(); await a.drain();
  assert.equal(h.groups().length, 1);
  b.api.createRequest('waiter');
  await b.api.handleSongRequest('Canción para mesa b');
  await b.api.handleAssistantMessage('Pedido de mesa b');
  await b.drain();
  assert.equal(h.groups().length, 4);
  assert.deepEqual(new Set(h.groups().map(row => row.table_id + ':' + row.kind)), new Set(['a:chat', 'b:chat', 'b:song', 'b:waiter']));
  assert.equal(h.admin.adminSyncBusy, true);
  assert.equal(h.signals.flat().length, 4);
});
test('Reabrir el chat no elimina el limite de cinco canciones ni permite enviar una sexta solicitud', async () => {
  const h = harness(), client = h.client('a');
  for (let i = 0; i < 5; i++) await client.api.handleSongRequest('Canción ' + i);
  await client.drain();
  assert.equal(client.api.songTurnCount(), 5);
  assert.equal(h.groups()[0].count, 5);
  client.api.finishClientChat();
  await client.api.handleSongRequest('Sexta canción');
  await client.api.handleAssistantMessage('Mensaje con el turno completo');
  await client.drain();
  assert.equal(h.saved.size, 5);
  assert.equal(client.chatMessages.length, 0);
  assert.equal(h.groups()[0].kind, 'song');
});
