const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(`  const ${start} =`);
  const to = source.indexOf(`  const ${end} =`, from + 1);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const request = (id, minute, type = 'waiter', table = 'table-a', session = 'session-a') => ({
  id, created_at: `2026-10-08T17:${String(minute).padStart(2, '0')}:00Z`,
  table_id: table, session_id: session, request_type: type, status: 'pending',
  message: type === 'other' ? 'Pedido de bebida' : '',
  restaurant_tables: { table_name: table }
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(storage = new Map()) {
  const backend = {
    snapshot: { requests: [], sessions: [] }, rows: [], readsFail: false, cached: null, blockingRecords: [],
    writesFail: false, closeFails: false, beforeWrite: null, beforeClose: null, savedIds: null
  };
  const state = {
    requests: [], sessions: [], tables: [{ id: 'table-a' }], authToken: 'valid',
    currentUser: null, posFeatures: {}, optimisticRequestStates: new Map(),
    optimisticSessionStates: new Map(), adminChats: new Map(), adminChatTypingTimers: new Map(),
    alertFilter: 'all', announcedRequestIds: new Set(), syncFresh: {}
  };
  state.sb = {
    rpc: async (name, payload) => {
      if (name === 'getAdminSnapshot') return { data: backend.snapshot };
      if (name === 'closeChatSession') return { data: { closed: true } };
      assert.equal(name, 'acknowledgeServiceRequests');
      if (backend.beforeWrite) await backend.beforeWrite();
      if (backend.writesFail) return { data: null, error: 'write failed' };
      const saved = backend.rows.filter(row => payload.ids.includes(row.id)
        && (!backend.savedIds || backend.savedIds.includes(row.id)));
      saved.forEach(row => Object.assign(row, {
        status: 'acknowledged', acknowledged_at: payload.acknowledged_at,
        ...(payload.message ? { message: payload.message } : {})
      }));
      return { data: saved.map(row => ({ ...row })) };
    },
    from: table => {
      const filters = [];
      let patch = null, single = false;
      const query = {
        select() { return this; },
        update(value) { patch = value; return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        single() { single = true; return this; },
        maybeSingle() { single = true; return this; },
        then(resolve, reject) {
          return Promise.resolve().then(async () => {
            if (table === 'service_requests') {
              if ((patch && backend.writesFail) || (!patch && backend.readsFail)) return { data: null };
              const rows = backend.rows.filter(row => filters.every(filter => filter(row)));
              if (patch) rows.forEach(row => Object.assign(row, patch));
              return { data: rows.map(row => ({ ...row })) };
            }
            assert.equal(table, 'table_sessions');
            if (backend.beforeClose) await backend.beforeClose();
            if (backend.closeFails) return { data: null };
            const rows = state.sessions.filter(row => filters.every(filter => filter(row)));
            // La cuenta ya se retiró de la vista al iniciar el cierre.
            const saved = patch ? { id: 'session-a', ...patch } : rows[0];
            return { data: single ? saved : rows };
          }).then(resolve, reject);
        }
      };
      return query;
    },
    removeChannel() {}
  };
  const alerts = { innerHTML: '', classList: { toggle() {} } };
  const toasts = [];
  const context = vm.createContext({
    state, Date, console, navigator: { onLine: true }, SUPABASE_CONFIG: { url: 'test-project' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    dbQuiet: async query => (await query)?.data || null,
    readRealtimeData: async query => (await query)?.data || null,
    readOfflineAdminSnapshot: () => backend.cached, getOfflineSyncStatus: async () => ({ blockingRecords: backend.blockingRecords }),
    persistOfflineAdminSnapshot() {},
    retryQuiet: async factory => (await factory())?.data || null,
    mergeOptimisticSessions: rows => rows, renderAdminLive() {}, renderAdmin() {},
    stopAlarm() {}, toast: message => toasts.push(message),
    normalizeText: value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    sessionTotals: () => ({ total: 100, subtotal: 100, discount: 0, tax: 0, serviceFee: 0 }),
    sessionPaid: () => 0, isLocalWalkInSession: () => false,
    buildBillMessage: () => '{"kind":"bill_receipt"}',
    setAdminChatMinimized() {}, loadChatMessages: async () => {}, createAdminChatWindow() {},
    renderAdminChat() {}, subscribeAdminChat() {}, persistChatMessage() {},
    broadcastChatEvent: async () => {}, refreshAdminNow: async () => {},
    window: { clearInterval() {}, clearTimeout() {} },
    $: selector => selector === '#alertsPanel' ? alerts : null,
    icon: () => '', escapeHTML: value => String(value), tableLabel: table => table?.table_name || '',
    prettyDateTime: value => value, parseBillMessage: () => null,
    REQUEST_LABELS: { waiter: 'Mesero', bill: 'Cuenta', other: 'Otro' }, REQUEST_IMAGES: {}, REQUEST_ICONS: {},
    emptyState: () => 'empty', requestSignature: () => '', playAlarm() {}, refreshIcons() {}
  });
  vm.runInContext(
    section('mergeOptimisticRequests', 'sessionItemMatches')
    + section('pendingAdminReadScope', 'pendingAdminRequestsStorageKey')
    + section('pendingAdminRequestsStorageKey', 'mergePendingCoreData')
    + section('isSongRequest', 'hasOpenAdminChatForRequest')
    + section('groupedActiveRequests', 'compactTableTiles')
    + section('acknowledgeRequestOptimistically', 'openMoveSessionDialog')
    + section('openAdminChat', 'requestFinishAdminChat')
    + section('closeSession', 'thermalReceiptHtml')
    + ';globalThis.api = { loadAdminData, groupedActiveRequests, renderAlerts, acceptRequest, '
    + 'acknowledgeRequestOptimistically, openAdminChat, finishAdminChat, closeSession };', context
  );
  return { api: context.api, state, backend, storage, alerts, toasts,
    ids: () => state.requests.filter(row => row.status === 'pending').map(row => row.id) };
}

(async () => {
  const h = harness();
  const first = request('first', 1), second = request('second', 2), chat = request('chat', 3, 'other');
  h.backend.rows = [first, second, chat].map(row => ({ ...row }));
  h.backend.snapshot = { requests: [chat, second, first], sessions: [] };
  await h.api.loadAdminData();
  assert.deepEqual([...h.ids()], ['first', 'second', 'chat']);
  assert.equal(h.api.groupedActiveRequests().length, 2, 'Las solicitudes de la misma mesa y categoria comparten tarjeta.');
  assert.deepEqual([...h.api.groupedActiveRequests()].map(row => row.id), ['chat', 'second'], 'Los grupos muestran primero la solicitud mas reciente.');
  assert.equal(h.api.groupedActiveRequests()[1].count, 2);
  assert.deepEqual([...h.api.groupedActiveRequests()[1].request_ids], ['second', 'first']);
  h.api.renderAlerts();
  assert.equal((h.alerts.innerHTML.match(/data-accept-request=/g) || []).length, 2);
  h.state.alertFilter = 'waiter';
  h.api.renderAlerts();
  assert.ok(h.alerts.innerHTML.includes('data-accept-request="second,first"'), 'El boton acepta todas las solicitudes de la tarjeta.');
  assert.ok(!h.alerts.innerHTML.includes('data-alert-card="first"'), 'La repeticion no agrega otra tarjeta.');
  assert.ok(!h.alerts.innerHTML.includes('data-alert-card="chat"'));

  h.backend.snapshot = { requests: [second], sessions: [] };
  h.backend.readsFail = true;
  await h.api.loadAdminData();
  assert.deepEqual([...h.ids()], ['first', 'second', 'chat'], 'Una respuesta parcial y una lectura fallida no retiran solicitudes.');
  h.backend.snapshot = { requests: [], sessions: [] };
  await h.api.loadAdminData();
  assert.deepEqual([...h.ids()], ['first', 'second', 'chat'], 'Un snapshot vacío conserva las pendientes.');
  const reloaded = harness(new Map(h.storage));
  reloaded.backend.rows = [first, second, chat].map(row => ({ ...row }));
  await reloaded.api.loadAdminData();
  assert.deepEqual([...reloaded.ids()], ['first', 'second', 'chat'], 'Recargar conserva el orden de las solicitudes confirmadas como pendientes.');

  const unverified = harness(new Map(h.storage));
  await unverified.api.loadAdminData();
  assert.deepEqual([...unverified.ids()], [], 'Recargar no muestra registros viejos de la caché que el servidor ya no confirma.');
  const unverifiedOffline = harness(new Map(h.storage));
  unverifiedOffline.backend.readsFail = true;
  await unverifiedOffline.api.loadAdminData();
  assert.deepEqual([...unverifiedOffline.ids()], [], 'Una lectura fallida al recargar no convierte la caché antigua en nuevas solicitudes.');
  reloaded.backend.readsFail = true;
  await reloaded.api.loadAdminData();
  assert.deepEqual([...reloaded.ids()], ['first', 'second', 'chat'], 'Un fallo posterior conserva las solicitudes ya confirmadas en pantalla.');

  h.backend.snapshot = { sessions: [] };
  assert.equal(await h.api.loadAdminData(), false, 'Un snapshot incompleto no sustituye la cola.');
  await h.api.openAdminChat('chat');
  assert.ok(h.ids().includes('chat'), 'Abrir un chat sin Aceptar conserva su solicitud.');
  const laterChat = request('later-chat', 4, 'other');
  const pendingSong = { ...request('song', 5, 'other'), message: 'Mesa solicita la canción: prueba' };
  const pendingBill = request('bill-pending', 6, 'bill');
  for (const row of [laterChat, pendingSong, pendingBill]) {
    h.state.requests.push({ ...row });
    h.backend.rows.push({ ...row });
  }
  await h.api.finishAdminChat('session-a');
  await tick();
  assert.deepEqual([...h.ids()], ['first', 'second', 'later-chat', 'song', 'bill-pending'], 'Cerrar chat conserva todas las demás solicitudes de esa mesa, incluso otro chat.');
  assert.equal(h.backend.rows.find(row => row.id === 'chat').status, 'resolved');
  assert.ok(h.backend.rows.filter(row => row.id !== 'chat').every(row => row.status === 'pending'), 'Solo la solicitud usada para abrir el chat se resuelve en el servidor.');
  assert.deepEqual(JSON.parse(h.storage.get('napoles_pending_admin_requests_v1:test-project:completed')), ['chat'], 'La caché no marca como atendidas las demás solicitudes.');

  const accept = harness();
  accept.backend.rows = [first, second].map(row => ({ ...row }));
  accept.backend.snapshot.requests = accept.backend.rows.map(row => ({ ...row }));
  await accept.api.loadAdminData();
  await accept.api.acceptRequest('first');
  await tick();
  assert.deepEqual([...accept.ids()], ['second'], 'Aceptar retira únicamente la solicitud pulsada.');
  await accept.api.loadAdminData();
  assert.deepEqual([...accept.ids()], ['second'], 'Un snapshot atrasado no vuelve a mostrar la solicitud aceptada.');
  const acceptedReload = harness(new Map(accept.storage));
  acceptedReload.backend.snapshot.requests = [first, second].map(row => ({ ...row }));
  acceptedReload.backend.readsFail = true;
  await acceptedReload.api.loadAdminData();
  assert.deepEqual([...acceptedReload.ids()], ['second'], 'Una respuesta atrasada tras recargar no vuelve a mostrar una aceptación confirmada.');
  const pendingKey = 'napoles_pending_admin_requests_v1:test-project';
  assert.ok(!JSON.parse(acceptedReload.storage.get(pendingKey)).some(row => row.id === 'first'), 'La aceptación no se vuelve a guardar como pendiente en la caché.');
  accept.backend.snapshot.requests = accept.backend.rows.map(row => ({ ...row }));
  await accept.api.loadAdminData();
  assert.equal(accept.state.optimisticRequestStates.size, 0, 'La confirmación remota libera la protección optimista.');
  accept.backend.snapshot.requests = [first, second].map(row => ({ ...row }));
  await accept.api.loadAdminData();
  assert.deepEqual([...accept.ids()], ['second'], 'Una respuesta vieja posterior a la confirmación tampoco revive la solicitud.');
  accept.backend.writesFail = true;
  await accept.api.acceptRequest('second');
  await tick();
  assert.deepEqual([...accept.ids()], ['second'], 'Aceptar sin poder guardar restaura la solicitud.');

  const groupedAccept = harness();
  groupedAccept.backend.rows = [first, second].map(row => ({ ...row }));
  groupedAccept.backend.snapshot.requests = groupedAccept.backend.rows.map(row => ({ ...row }));
  await groupedAccept.api.loadAdminData();
  await groupedAccept.api.acceptRequest(groupedAccept.api.groupedActiveRequests()[0].request_ids.join(','));
  await tick();
  assert.deepEqual([...groupedAccept.ids()], [], 'Aceptar una tarjeta retira todas sus repeticiones confirmadas.');
  assert.ok(groupedAccept.backend.rows.every(row => row.status === 'acknowledged'));
  await groupedAccept.api.loadAdminData();
  assert.deepEqual([...groupedAccept.ids()], [], 'El grupo aceptado no reaparece con un snapshot viejo.');

  const partial = harness();
  partial.backend.rows = [first, second].map(row => ({ ...row }));
  partial.backend.snapshot.requests = partial.backend.rows.map(row => ({ ...row }));
  await partial.api.loadAdminData();
  partial.backend.savedIds = ['first'];
  await partial.api.acceptRequest(partial.api.groupedActiveRequests()[0].request_ids.join(','));
  await tick();
  assert.deepEqual([...partial.ids()], ['second'], 'Una escritura parcial restaura las solicitudes no confirmadas.');

  const missingOnFailure = harness();
  missingOnFailure.state.requests = [{ ...first }];
  missingOnFailure.backend.writesFail = true;
  missingOnFailure.api.acknowledgeRequestOptimistically('first', { status: 'acknowledged' }, 'falló');
  missingOnFailure.state.requests = [];
  await tick();
  assert.deepEqual([...missingOnFailure.ids()], ['first'], 'Un fallo de escritura restaura incluso una solicitud omitida por una actualización concurrente.');

  const confirmedDespiteError = harness();
  confirmedDespiteError.state.requests = [{ ...first }];
  confirmedDespiteError.backend.writesFail = true;
  confirmedDespiteError.backend.beforeWrite = async () => {
    confirmedDespiteError.backend.snapshot.requests = [{ ...first, status: 'acknowledged' }];
    await confirmedDespiteError.api.loadAdminData();
  };
  await confirmedDespiteError.api.acceptRequest('first');
  await tick();
  assert.deepEqual([...confirmedDespiteError.ids()], [], 'Un error en la respuesta de escritura no revive una aceptación que otra lectura ya confirmó.');

  const peer = harness(reloaded.storage);
  peer.backend.rows = [
    { ...first, status: 'acknowledged' }, { ...second, status: 'resolved' }, chat
  ];
  await peer.api.loadAdminData();
  assert.deepEqual([...peer.ids()], ['chat'], 'La lectura directa confirma aceptaciones y cierres de otro equipo.');
  const stalePeer = harness(new Map(reloaded.storage));
  stalePeer.backend.snapshot.requests = [first, second, chat].map(row => ({ ...row }));
  stalePeer.backend.rows = peer.backend.rows.map(row => ({ ...row }));
  await stalePeer.api.loadAdminData();
  assert.deepEqual([...stalePeer.ids()], ['chat'], 'Al recargar, la verificación de la caché también descarta aceptaciones de otro equipo aunque el snapshot esté atrasado.');

  const closing = harness();
  const orphan = request('no-session', 4, 'waiter', 'table-a', null);
  const other = request('other-table', 5, 'waiter', 'table-b', 'session-b');
  closing.backend.rows = [first, chat, orphan, other].map(row => ({ ...row }));
  closing.backend.snapshot.requests = closing.backend.rows.map(row => ({ ...row }));
  await closing.api.loadAdminData();
  closing.state.sessions = [{ id: 'session-a', table_id: 'table-a' }];
  await closing.api.closeSession('session-a');
  assert.deepEqual([...closing.ids()], ['other-table'], 'Cerrar la cuenta retira todos los tipos de esa mesa, incluyendo solicitudes sin sesión.');
  assert.ok(closing.backend.rows.filter(row => row.table_id === 'table-a').every(row => row.status === 'resolved'));
  const closedReload = harness(new Map(closing.storage));
  closedReload.backend.snapshot.requests = [first, chat, orphan, other].map(row => ({ ...row }));
  closedReload.backend.readsFail = true;
  await closedReload.api.loadAdminData();
  assert.deepEqual([...closedReload.ids()], ['other-table'], 'Recargar con una respuesta atrasada no revive las solicitudes de una mesa cerrada.');

  const failedClose = harness();
  failedClose.backend.rows = [{ ...first }];
  failedClose.backend.snapshot.requests = [{ ...first }];
  await failedClose.api.loadAdminData();
  failedClose.state.sessions = [{ id: 'session-a', table_id: 'table-a' }];
  failedClose.backend.closeFails = true;
  failedClose.backend.beforeClose = async () => {
    if (!failedClose.state.requests.some(row => row.id === other.id)) failedClose.state.requests.push(other);
  };
  await failedClose.api.closeSession('session-a');
  assert.deepEqual([...failedClose.ids()].sort(), ['first', 'other-table'], 'Un cierre fallido restaura la cola sin borrar solicitudes recién llegadas.');

  const offlineReload = harness();
  offlineReload.storage.set('napoles_pending_admin_requests_v1:test-project', JSON.stringify([first, second]));
  offlineReload.backend.cached = { requests: [{ ...first, status: 'acknowledged' }, second], sessions: [] };
  offlineReload.backend.blockingRecords = [{ entity: 'rpc:acknowledge_service_requests', recordIds: ['first'] }];
  offlineReload.backend.snapshot.requests = [first, second];
  offlineReload.backend.rows = [first, second];
  await offlineReload.api.loadAdminData();
  assert.deepEqual([...offlineReload.ids()], ['second'], 'Una aceptación guardada sin conexión no reaparece por una lectura remota anterior.');
  assert.equal(offlineReload.state.syncFresh.operational, false, 'La aceptación sigue pendiente de sincronización.');
  const disconnected = harness(new Map(offlineReload.storage));
  disconnected.backend.snapshot = null;
  disconnected.backend.cached = { requests: [first, second], sessions: [] };
  await disconnected.api.loadAdminData();
  assert.deepEqual([...disconnected.ids()], ['second'], 'La copia offline antigua tampoco revive una solicitud ya aceptada.');

  const special = harness();
  const bill = request('bill', 7, 'bill'), specialChat = request('special-chat', 8, 'other');
  special.backend.rows = [bill, specialChat].map(row => ({ ...row }));
  special.backend.snapshot.requests = special.backend.rows.map(row => ({ ...row }));
  await special.api.loadAdminData();
  special.state.sessions = [{ id: 'session-a', table_id: 'table-a' }];
  await special.api.acceptRequest('bill');
  await tick();
  assert.match(special.backend.rows[0].message, /bill_receipt/, 'Aceptar cuenta mantiene el envío del recibo.');
  await special.api.acceptRequest('special-chat');
  await tick();
  assert.equal(special.state.adminChats.size, 1, 'Aceptar chat mantiene la apertura del chat.');
  assert.deepEqual([...special.ids()], []);
  console.log('PASS solicitudes: persistencia, recarga, orden, aceptación individual, fallos, confirmación remota y cierres por chat/mesa.');
})().catch(error => { console.error(error); process.exitCode = 1; });
