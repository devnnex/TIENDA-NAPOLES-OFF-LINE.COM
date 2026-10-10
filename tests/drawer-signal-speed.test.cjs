const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = source.indexOf('  const openLocalCashDrawer =');
const end = source.indexOf('  const getAppsScriptUrl =', start);
assert.ok(start >= 0 && end > start);
function harness({ saved = false, connected = true } = {}) {
  let now = 18000, subscribed;
  const calls = [], events = new Map(), timers = new Map(), storage = new Map();
  const local = { deviceId: 'device-1', secret: 'drawer-secret', settings: { printer: 'POS', pin: 0 }, printers: ['POS'] };
  if (saved) storage.set('drawer-settings', JSON.stringify(local.settings));
  const state = { authToken: 'staff-token', currentUser: { id: 'staff' }, posFeatures: { remote_drawer: true } };
  const channel = {
    on(type, filter, callback) { events.set(filter.event, callback); return this; },
    subscribe(callback) { subscribed = callback; if (connected) callback('SUBSCRIBED'); return this; },
    async send(message) { calls.push('signal:' + message.event); return 'ok'; }
  };
  const hooks = { claim: async () => ({ command: null }) };
  state.sb = {
    channel: () => channel,
    async rpc(name, payload) {
      calls.push(name);
      if (name === 'claim_pos_drawer') return { data: await hooks.claim() };
      if (name === 'request_pos_drawer') return { data: { command: { id: payload.p_command_id, device_id: 'device-1' } } };
      if (name === 'get_pos_drawer_command') return { data: { command: { status: 'accepted' } } };
      return { data: { ok: true } };
    }
  };
  const context = vm.createContext({ state, Date: class extends Date { static now() { return now; } },
    CASH_DRAWER_SETTINGS_KEY: 'drawer-settings', uid: () => 'command-1', $: () => null,
    navigator: { userAgent: 'Windows', onLine: true }, toast() {}, configureCashDrawer() {},
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { clearTimeout: id => timers.delete(id), setTimeout: (callback, delay) => {
      const id = timers.size + 1; timers.set(id, { callback, delay }); return id;
    } },
    setTimeout: (callback, delay) => { calls.push('delay:' + delay); callback(); },
    cashDrawerRequest: async method => { calls.push('http:' + method); return structuredClone(local); },
    sendCashDrawerPulse: async settings => { assert.equal(settings.printer, 'POS'); calls.push('pulse'); return true; },
    dbQuiet: async query => (await query).data,
    retryQuiet: async factory => (await factory()).data
  });
  vm.runInContext(source.slice(start, end) + ';globalThis.api = {openCashDrawer, openRemoteCashDrawer, pollDrawerReceiver};', context);
  return { api: context.api, state, calls, hooks, events, connect: () => subscribed('SUBSCRIBED'), advance: ms => { now += ms; } };
}
test('00 y el cobro envian el pulso con la configuracion guardada sin consultar impresoras primero', async () => {
  for (const localOnly of [false, true]) {
    const h = harness({ saved: true });
    const opening = h.api.openCashDrawer({ localOnly });
    assert.deepEqual(h.calls, ['pulse']);
    assert.equal(await opening, true);
    assert.equal(h.calls.includes('http:GET'), false);
  }
});
test('La orden remota se registra sin esperar la conexion del canal ni una pausa artificial', async () => {
  const h = harness({ connected: false });
  assert.equal(await h.api.openRemoteCashDrawer(), true);
  assert.deepEqual(h.calls, ['request_pos_drawer', 'get_pos_drawer_command']);
  h.connect();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.slice(2), ['signal:wake', 'signal:open']);
});
test('Una señal recibida durante otra consulta se atiende inmediatamente y pulsa una sola vez', async () => {
  const h = harness();
  let release, claimCount = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  h.hooks.claim = () => ++claimCount === 1 ? blocked : Promise.resolve({ command: claimCount === 2 ? { id: 'command-1' } : null });
  const first = h.api.pollDrawerReceiver();
  await new Promise(setImmediate);
  assert.equal(claimCount, 1);
  h.events.get('open')();
  release({ command: null });
  await first;
  await new Promise(setImmediate);
  assert.equal(claimCount, 2);
  assert.equal(h.calls.filter(call => call === 'http:GET').length, 1);
  assert.equal(h.calls.filter(call => call === 'register_pos_drawer').length, 1);
  assert.equal(h.calls.filter(call => call === 'http:POST').length, 1);
  await h.api.pollDrawerReceiver();
  assert.equal(h.calls.filter(call => call === 'http:POST').length, 1);
});
test('La configuracion se reutiliza y el registro conserva el latido de la caja', async () => {
  const h = harness();
  await h.api.pollDrawerReceiver();
  await h.api.pollDrawerReceiver();
  assert.equal(h.calls.filter(call => call === 'http:GET').length, 1);
  assert.equal(h.calls.filter(call => call === 'register_pos_drawer').length, 1);
  h.advance(4500); await h.api.pollDrawerReceiver();
  assert.equal(h.calls.filter(call => call === 'register_pos_drawer').length, 2);
  h.state.authToken = 'new-token'; await h.api.pollDrawerReceiver();
  assert.equal(h.calls.filter(call => call === 'register_pos_drawer').length, 3);
  h.advance(30000); await h.api.pollDrawerReceiver();
  assert.equal(h.calls.filter(call => call === 'http:GET').length, 2);
});
test('Cerrar la sesion mientras se reclama una orden impide activar el hardware', async () => {
  const h = harness();
  let release;
  h.hooks.claim = () => new Promise(resolve => { release = resolve; });
  const polling = h.api.pollDrawerReceiver();
  await new Promise(setImmediate);
  h.state.authToken = ''; h.state.currentUser = null;
  release({ command: { id: 'command-1' } });
  await polling;
  assert.equal(h.calls.includes('http:POST'), false);
});
