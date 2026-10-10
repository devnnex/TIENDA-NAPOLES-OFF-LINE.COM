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
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let now = Date.parse('2026-10-08T18:00:00Z'), serial = 0, renders = 0, markup = '';
  const clock = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const chat = {
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; renders++; },
    get scrollHeight() { return (markup.match(/assistant-message /g) || []).length * 80; },
    scrollTop: 0
  };
  const state = {
    page: 'client', assistantMode: 'bar', assistantThreads: { bar: [], song: [] },
    chatMessages: [], adminChatActive: false, adminChatNotice: '',
    currentTable: { id: 'table-a' }, currentSession: { id: 'session-a' },
    clientStaffMessageSoundIds: new Set(), authToken: '',
    sb: { rpc: async (name, payload) => {
      assert.equal(name, 'sendChatMessage');
      sent.push(payload);
      if (gate) await gate;
      return { data: { message: {
        id: payload.p_message_id, sender_type: payload.p_sender_type,
        body: payload.p_body, created_at: new clock().toISOString()
      } } };
    } }
  };
  const sent = [], notifications = [];
  let gate = null, release;
  const context = vm.createContext({
    state, Date: clock, console, uid: () => `local-${++serial}`,
    $: selector => selector === '#assistantChat' ? chat : selector === '#assistantSuggestions' ? { innerHTML: '' } : null,
    normalizeText: value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    icon: () => '', escapeHTML: value => String(value), refreshIcons() {},
    tableCode: () => 'code', songTurnCount: () => 0, broadcastChatEvent() {},
    tableLabel: () => 'Mesa 1', polishGuestText: text => text,
    createServiceNotification: async (type, message) => { notifications.push({ type, message }); },
    retryQuiet: async factory => (await factory())?.data || null
  });
  vm.runInContext(section('assistantSay', 'activateSongRequestMode')
    + section('mergeChatMessageList', 'setPeerTyping')
    + section('handleAssistantMessage', 'handleSongRequest')
    + ';globalThis.api = { assistantSay, renderAssistant, persistChatMessage, handleAssistantMessage };', context);
  return {
    api: context.api, state, chat, sent, notifications, renders: () => renders,
    advance: seconds => { now += seconds * 1000; },
    pause: () => { gate = new Promise(resolve => { release = resolve; }); },
    release: () => { release(); gate = null; }
  };
}

(async () => {
  const interleaved = harness();
  interleaved.api.assistantSay('user', 'Primer pedido');
  interleaved.advance(1);
  interleaved.api.assistantSay('bot', 'Pedido recibido');
  interleaved.state.chatMessages = [{
    id: 'reply', sender_type: 'staff', body: 'Respuesta reciente del equipo', created_at: '2026-10-08T18:00:02Z'
  }];
  interleaved.advance(3);
  interleaved.api.assistantSay('user', 'Último mensaje del cliente');
  const html = interleaved.chat.innerHTML;
  assert.ok(html.indexOf('Primer pedido') < html.indexOf('Pedido recibido'));
  assert.ok(html.indexOf('Pedido recibido') < html.indexOf('Respuesta reciente del equipo'));
  assert.ok(html.indexOf('Respuesta reciente del equipo') < html.indexOf('Último mensaje del cliente'), 'Los mensajes locales y remotos forman una sola conversación cronológica.');
  assert.equal(interleaved.chat.scrollTop, interleaved.chat.scrollHeight, 'El envío queda visible al final de la conversación.');
  const renders = interleaved.renders();
  interleaved.chat.scrollTop = 0;
  interleaved.api.renderAssistant();
  assert.equal(interleaved.renders(), renders, 'Una actualización sin mensajes nuevos no reconstruye el historial.');
  assert.equal(interleaved.chat.scrollTop, 0, 'Leer mensajes anteriores no se interrumpe por una actualización idéntica.');

  const repeating = harness();
  repeating.state.adminChatActive = true;
  repeating.state.chatMessages = [{
    id: 'previous-thanks', sender_type: 'client', body: 'Gracias', created_at: '2026-10-08T17:59:00Z'
  }];
  repeating.pause();
  await repeating.api.handleAssistantMessage('Gracias');
  await repeating.api.handleAssistantMessage('Gracias');
  assert.equal(repeating.notifications.length, 2, 'Cada mensaje repetido genera una solicitud aunque el chat siga activo.');
  assert.equal((repeating.chat.innerHTML.match(/>Gracias<\/div>/g) || []).length, 3, 'Repetir el mismo texto conserva cada envío como un mensaje distinto.');
  assert.deepEqual(repeating.sent.map(payload => payload.p_message_id), ['local-1', 'local-2'], 'La confirmación remota usa el ID del mensaje mostrado inmediatamente.');
  repeating.release();
  await tick();
  assert.equal((repeating.chat.innerHTML.match(/>Gracias<\/div>/g) || []).length, 3, 'Las confirmaciones sustituyen sus propios mensajes sin duplicarlos ni borrar repeticiones.');

  const delayed = harness();
  delayed.state.adminChatActive = true;
  delayed.pause();
  await delayed.api.handleAssistantMessage('Pedido que tarda en confirmarse');
  delayed.advance(1);
  delayed.state.chatMessages.push({
    id: 'quick-reply', sender_type: 'staff', body: 'Respuesta del administrador', created_at: '2026-10-08T18:00:01Z'
  });
  delayed.api.renderAssistant();
  delayed.advance(10);
  delayed.release();
  await tick();
  assert.ok(delayed.chat.innerHTML.indexOf('Pedido que tarda en confirmarse') < delayed.chat.innerHTML.indexOf('Respuesta del administrador'), 'Una confirmación tardía no mueve el mensaje después de su respuesta.');
  assert.equal((delayed.chat.innerHTML.match(/>Pedido que tarda en confirmarse<\/div>/g) || []).length, 1);

  const music = harness();
  music.state.assistantMode = 'song';
  music.api.assistantSay('user', 'Mi canción');
  music.advance(1);
  music.api.assistantSay('bot', 'Canción recibida');
  assert.ok(music.chat.innerHTML.indexOf('Mi canción') < music.chat.innerHTML.indexOf('Canción recibida'));
  assert.ok(!music.chat.innerHTML.includes('Respuesta del administrador'), 'El modo canción conserva su propio historial.');
  console.log('PASS chat del cliente: conversación cronológica, envío inmediato, repeticiones, confirmaciones tardías y desplazamiento al último mensaje.');
})().catch(error => { console.error(error); process.exitCode = 1; });
