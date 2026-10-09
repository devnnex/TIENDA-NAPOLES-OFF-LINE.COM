const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const block = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const section = (start, end) => block(`  const ${start} =`, `  const ${end} =`);
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function backend() {
  const server = { channels: [], messages: [], requests: [], snapshotGate: null, ledgerGate: new Promise(() => {}) };
  server.channel = name => {
    const channel = {
      name, active: true, handlers: [], status: null,
      on(type, filter, handler) { this.handlers.push({ type, filter, handler }); return this; },
      subscribe(handler) { this.status = handler; queueMicrotask(() => { if (this.active) handler?.('SUBSCRIBED'); }); return this; },
      send(event) { server.emit(name, event.event, event.payload, this); return Promise.resolve('ok'); }
    };
    server.channels.push(channel);
    return channel;
  };
  server.emit = (name, event, payload = {}, sender = null) => {
    server.channels.filter(channel => channel.active && channel.name === name && channel !== sender)
      .forEach(channel => channel.handlers.filter(handler => handler.type === 'broadcast' && handler.filter.event === event)
        .forEach(handler => { void handler.handler({ payload }); }));
  };
  server.sb = {
    channel: server.channel,
    removeChannel(channel) { channel.active = false; channel.status?.('CLOSED'); },
    rpc: async (name, payload) => {
      if (name === 'getClientTableState') return { data: { session: { id: 'session-a', table_id: 'table-a' }, sessionItems: [], requests: server.requests } };
      if (name === 'getClientSnapshot') {
        if (server.snapshotGate) await server.snapshotGate;
        return { data: { sessionItems: [], requests: server.requests.map(row => ({ ...row })) } };
      }
      if (name === 'get_service_request_queue') return { data: { requests: [] } };
      if (name === 'get_session_payments') { await server.ledgerGate; return { data: { payments: [] } }; }
      if (name === 'getAdminSnapshot') return { data: { requests: server.requests.map(row => ({ ...row })), sessions: [] } };
      if (name === 'listChatMessages') return { data: { messages: server.messages.filter(row => row.session_id === payload.p_session_id).map(row => ({ ...row })) } };
      if (name === 'sendChatMessage') {
        const message = { id: payload.p_message_id, session_id: payload.p_session_id, sender_type: payload.p_sender_type,
          body: payload.p_body, created_at: new Date().toISOString() };
        server.messages.push(message);
        return { data: { message } };
      }
      throw Error(name);
    },
    from(name) {
      const query = { select() { return this; }, eq() { return this; }, neq() { return this; }, order() { return this; },
        in() { return this; }, limit() { return this; }, maybeSingle() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: name === 'service_requests' ? server.requests : [] }).then(resolve, reject); } };
      return query;
    }
  };
  return server;
}

function device(server, page = 'client') {
  let clock = 0, nextId = 0, renders = 0;
  const sounds = [], queueBox = { hidden: true, innerHTML: '' };
  const timers = new Map(), events = new Map(), storage = new Map();
  const schedule = (callback, delay, interval = false) => {
    const id = ++nextId;
    timers.set(id, { callback, due: clock + delay, delay, interval });
    return id;
  };
  const state = {
    page, currentTable: { id: 'table-a' }, currentSession: page === 'client' ? null : { id: 'session-a' }, sb: server.sb,
    clientHydrationToken: 0, clientStaffMessageSoundIds: new Set(), clientSyncBusy: false, clientRequests: [],
    chatMessages: [], assistantMode: 'bar', assistantThreads: { bar: [], song: [] },
    adminChats: new Map(), adminChatTypingTimers: new Map(), subscriptions: [], requests: [], sessions: [],
    authToken: page === 'admin' ? 'valid' : '', optimisticRequestStates: new Map(), posFeatures: {}, syncFresh: {}
  };
  const document = { hidden: false, addEventListener: (name, callback) => events.set(name, callback) };
  const context = vm.createContext({
    state, document, navigator: { onLine: true }, console, Date, AbortController, SUPABASE_CONFIG: { url: 'fixture' },
    SYNC_INTERVAL_MS: 5000, CHAT_SYNC_INTERVAL_MS: 1200,
    window: { setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: id => timers.delete(id),
      addEventListener: (name, callback) => events.set(name, callback) },
    setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: id => timers.delete(id),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    db: async query => (await query)?.data || null, retryQuiet: async factory => (await factory())?.data || null,
    readOfflineAdminSnapshot: () => null, getOfflineSyncStatus: async () => ({ blockingRecords: [] }), persistOfflineAdminSnapshot() {},
    tableCode: () => 'table-code', uid: () => `message-${page}-${++nextId}`,
    $: selector => selector === '#clientQueueStatus' ? queueBox : null, escapeHTML: String,
    RECEIPT_SOUND: 'notification.mp3', Audio: class { constructor(src) { this.src = src; } async play() { sounds.push(this.src); } },
    normalizeText: value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    renderAccount() {}, renderBillChat() {}, renderTablePicker() {}, refreshTableLock() {},
    renderClientQueue() {}, songTurnCount: () => 0, pendingBillIds: () => [], readRequestOutbox: () => [],
    renderAssistant: () => { renders++; }, renderAdminChat: () => { renders++; }, renderAdminLive: () => { renders++; },
    playClientChatReceipt() {}, playAdminChatReceipt() {}, assistantSay() {}, setPeerTyping() {},
    mergeOptimisticRequests: rows => rows, mergeOptimisticSessions: rows => rows,
    refreshBackgroundReports() {}, notifyAdminPeers() {}, refreshInventoryFromPeer() {}, isBoss: () => false,
    setRealtimeStatus() {}, refreshCoreNow() {}, loadUsers() {}
  });
  vm.runInContext(section('dbQuiet', 'bootstrapCacheKey')
    + section('ensureOpenSession', 'bootstrapCacheKey')
      .split('  const dbQuiet =')[0]
    + section('loadClientSnapshot', 'pwaAssetUrl')
    + section('playClientChatReceipt', 'playAdminChatReceipt')
    + section('isSongRequest', 'hasOpenAdminChatForRequest')
    + section('renderClientQueue', 'bindAccountFeatures')
    + section('mergeChatMessageList', 'setPeerTyping')
    + section('broadcastChatEvent', 'broadcastTyping')
    + section('subscribeClient', 'initClient')
    + section('subscribeAdminChat', 'openAdminChat')
    + block('  let clientPosReadPending =', '  const renderClientQueue =')
    + section('pendingAdminRequestsStorageKey', 'mergePendingCoreData')
    + section('pendingAdminReadScope', 'pendingAdminRequestsStorageKey')
    + block('  let adminRefreshPending =', '  const startAdminPolling =')
    + section('subscribeAdmin', 'tableFromScannedValue')
    + section('resumeRealtimeReception', 'init')
    + ';globalThis.api = { hydrateSelectedTable, subscribeClient, loadChatMessages, persistChatMessage, '
    + 'broadcastChatEvent, resumeRealtimeReception, subscribeAdmin, refreshAdminNow, readRealtimeData, renderClientQueue };', context);
  return {
    state, api: context.api, document, sounds, queueBox, renders: () => renders,
    async advance(ms) {
      const end = clock + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        clock = timer.due;
        if (timer.interval) timer.due += timer.delay; else timers.delete(id);
        timer.callback();
        await settle();
      }
      clock = end;
      await settle();
    },
    timerCount: () => timers.size
  };
}

(async () => {
  const server = backend(), first = device(server), second = device(server), admin = device(server, 'admin');
  let initialized = false;
  first.api.hydrateSelectedTable('table-a').then(() => { initialized = true; });
  await second.api.hydrateSelectedTable('table-a');
  await settle();
  assert.equal(initialized, true, 'Una consulta de pagos que no responde no retrasa el inicio de la recepción.');
  assert.ok(first.state.clientChannel && second.state.clientChannel, 'Cada dispositivo abre su propia recepción por mesa.');
  const originalChannel = first.state.clientChannel;
  first.api.subscribeClient();
  assert.equal(first.state.clientChannel, originalChannel, 'Revisar la sesión conserva una conexión saludable.');

  admin.api.subscribeAdmin();
  const adminChat = { sessionId: 'session-a', table: { id: 'table-a' }, messages: [], channel: server.channel('table:table-a') };
  admin.state.adminChats.set('session-a', adminChat);
  await admin.api.persistChatMessage('staff', 'Respuesta en vivo', { sessionId: 'session-a', table: adminChat.table });
  await admin.api.broadcastChatEvent('chat-refresh', {}, 'session-a');
  await settle();
  for (const client of [first, second]) {
    assert.ok(client.state.chatMessages.some(row => row.body === 'Respuesta en vivo'), 'Ambos clientes reciben el mensaje sin recargar.');
    assert.ok(client.renders() > 0);
    await client.advance(0);
    assert.equal(client.sounds.length, 1, 'La respuesta del administrador reproduce el sonido en cada dispositivo.');
    await client.api.loadChatMessages();
    await client.advance(0);
    assert.equal(client.sounds.length, 1, 'Leer el mismo mensaje otra vez no repite el sonido.');
  }
  await first.api.persistChatMessage('client', 'Mensaje desde la mesa');
  await first.api.broadcastChatEvent('chat-refresh');
  await settle();
  assert.ok(second.state.chatMessages.some(row => row.body === 'Mensaje desde la mesa'));

  server.requests.push({ id: 'request-a', table_id: 'table-a', session_id: 'session-a', status: 'pending', request_type: 'waiter', created_at: '2026-10-08T18:00:00Z' });
  server.emit('admin', 'refresh');
  server.emit('table:table-a', 'refresh');
  await settle();
  assert.equal(admin.state.requests[0].id, 'request-a', 'El admin recibe las solicitudes mediante el aviso remoto.');
  assert.equal(first.state.clientRequests[0].id, 'request-a', 'La recepción de solicitudes no espera a los pagos.');

  assert.doesNotMatch(first.queueBox.innerHTML, /Te estamos atendiendo/);
  server.requests[0].status = 'acknowledged';
  server.requests.push({ id: 'chat-request', table_id: 'table-a', session_id: 'session-a', status: 'acknowledged', request_type: 'other', message: 'Hola' });
  server.emit('table:table-a', 'refresh');
  await settle();
  assert.match(first.queueBox.innerHTML, /data-attending-request="request-a"/);
  assert.match(first.queueBox.innerHTML, /está siendo atendida en este momento/);
  assert.doesNotMatch(first.queueBox.innerHTML, /data-attending-request="chat-request"/, 'El chat conserva su propio aviso de conexión.');
  server.requests[0].status = 'resolved';
  server.emit('table:table-a', 'refresh');
  await settle();
  assert.doesNotMatch(first.queueBox.innerHTML, /Te estamos atendiendo/);

  first.state.clientChannel.active = false;
  server.messages.push({ id: 'fallback', session_id: 'session-a', sender_type: 'staff', body: 'Recibido sin WebSocket', created_at: '2026-10-08T18:01:00Z' });
  await first.advance(1200);
  assert.ok(first.state.chatMessages.some(row => row.id === 'fallback'), 'El respaldo de 1,2 segundos entrega mensajes cuando se pierde el canal.');
  originalChannel.status('CHANNEL_ERROR');
  await first.advance(3000);
  assert.notEqual(first.state.clientChannel, originalChannel, 'El canal fallido se reconstruye automáticamente.');
  assert.equal(first.state.clientRealtimeNeedsReconnect, false);

  server.snapshotGate = new Promise(() => {});
  server.emit('table:table-a', 'refresh');
  await settle();
  assert.equal(first.state.clientSyncBusy, true);
  server.messages.push({ id: 'independent', session_id: 'session-a', sender_type: 'staff', body: 'Chat independiente', created_at: '2026-10-08T18:02:00Z' });
  server.emit('table:table-a', 'chat-refresh');
  await settle();
  assert.ok(first.state.chatMessages.some(row => row.id === 'independent'), 'El chat recibe aunque otra lectura siga esperando.');
  await first.advance(8000);
  server.snapshotGate = null;
  await first.advance(0);

  first.document.hidden = true;
  server.messages.push({ id: 'resume', session_id: 'session-a', sender_type: 'staff', body: 'Mensaje durante suspensión', created_at: '2026-10-08T18:03:00Z' });
  first.document.hidden = false;
  first.api.resumeRealtimeReception();
  await settle();
  assert.ok(first.state.chatMessages.some(row => row.id === 'resume'), 'Volver a la pestaña recupera inmediatamente los mensajes pendientes.');

  const requestsBeforeClose = JSON.stringify(second.state.clientRequests);
  second.state.assistantMode = 'song';
  second.state.assistantThreads.song = [{ role: 'bot', text: 'Tu canción está pendiente.' }];
  server.messages = [];
  server.emit('table:table-a', 'chat-closed', { sessionId: 'session-a' });
  assert.match(second.state.assistantThreads.bar[0].text, /La conversación ha finalizado/);
  assert.equal(second.state.assistantThreads.song[0].text, 'Tu canción está pendiente.');
  assert.equal(JSON.stringify(second.state.clientRequests), requestsBeforeClose, 'La despedida no modifica otras solicitudes.');
  await second.advance(1000);
  const previousSounds = second.sounds.length;
  server.messages.push({ id: 'after-close', session_id: 'session-a', sender_type: 'staff', body: 'Nueva respuesta', created_at: '2026-10-08T18:04:00Z' });
  server.emit('table:table-a', 'chat-refresh');
  await settle();
  await second.advance(0);
  assert.equal(second.sounds.length, previousSounds + 1, 'La primera respuesta después de un cierre también suena.');
  second.state.adminChatActive = true;
  server.messages = [];
  await second.api.loadChatMessages();
  assert.match(second.state.assistantThreads.bar[0].text, /La conversación ha finalizado/, 'El respaldo detecta el cierre aunque no llegue el aviso remoto.');
  assert.equal(second.state.chatMessages.length, 0);

  let finishRead;
  const oldRpc = server.sb.rpc;
  server.sb.rpc = name => name === 'listChatMessages' ? new Promise(resolve => { finishRead = resolve; }) : oldRpc(name);
  const obsolete = first.api.loadChatMessages();
  assert.equal(first.api.loadChatMessages(), obsolete, 'Los avisos concurrentes comparten una lectura y no saturan la conexión.');
  first.state.currentSession = { id: 'new-session' };
  first.state.chatMessages = [];
  finishRead({ data: { messages: [{ id: 'old-session', session_id: 'session-a', sender_type: 'staff', body: 'Mensaje viejo' }] } });
  assert.equal(await obsolete, false);
  assert.equal(first.state.chatMessages.length, 0, 'Una respuesta de una sesión anterior no contamina la conversación actual.');

  const closingRead = second.api.loadChatMessages();
  server.emit('table:table-a', 'chat-closed', { sessionId: 'session-a' });
  finishRead({ data: { messages: [{ id: 'old-join', session_id: 'session-a', sender_type: 'system', body: 'El administrador se unió al chat.' }] } });
  assert.equal(await closingRead, false);
  assert.equal(second.state.adminChatActive, false, 'Una lectura iniciada antes del cierre no reabre el chat.');
  assert.match(second.state.assistantThreads.bar[0].text, /La conversación ha finalizado/);

  const timed = device(backend());
  let signal;
  const waiting = timed.api.readRealtimeData({ abortSignal(value) { signal = value; return this; }, then() {} });
  await timed.advance(8000);
  assert.equal(await waiting, null);
  assert.equal(signal.aborted, true, 'Una lectura detenida se cancela para permitir el siguiente intento.');
  console.log('PASS recepción en vivo: dos dispositivos, solicitudes, pagos lentos, chat independiente, respaldo, reconexión y reanudación sin recarga.');
})().catch(error => { console.error(error); process.exitCode = 1; });
