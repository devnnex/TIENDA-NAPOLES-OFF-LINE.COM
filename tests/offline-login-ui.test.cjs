const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('  const ADMIN_USER_CACHE_KEY =');
const end = source.indexOf('  const sortUsers =', start);
assert.ok(start >= 0 && end > start);
const code = `${source.slice(start, end)}\nglobalThis.loginFlow = { waitForAdminLogin, refreshOfflineLogin };`;

const setup = ({ online, result, localResult }) => {
  const user = { id: 'user-1', username: 'jefe', full_name: 'Jefe', role: 'boss', is_active: true };
  const state = {
    authToken: '', currentUser: null, offlineLoginPending: false,
    offlineLoginPin: '', offlineLoginUsername: '', offlineLoginNextRetryAt: 0,
    sb: {
      rpc: async (name) => name === 'getInitialSetupStatus'
        ? { data: { needs_initial_admin: false }, error: null }
        : typeof result === 'function' ? result(name) : result,
      setAuthToken: () => undefined
    }
  };
  const saved = new Map();
  const sessionSaved = new Map();
  const calls = [];
  const errorBox = { textContent: '' };
  const button = { disabled: false, innerHTML: '' };
  const form = {
    username: { value: 'jefe' }, pin: { value: '1234' },
    initialUsername: { value: '' }, initialPin: { value: '' }, initialFullName: { value: '' },
    querySelector: () => button,
    addEventListener: (_name, callback) => { form.submit = callback; }
  };
  const fields = {
    '#loginForm': form, '#loginError': errorBox, '#loginCredentials': { hidden: false },
    '#initialAdminCredentials': { hidden: true }, '#loginIntro': { textContent: '' }, '#loginSubmit': button
  };
  const context = vm.createContext({
    state, navigator: { onLine: online },
    localStorage: {
      getItem: (key) => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: (key) => saved.delete(key)
    },
    sessionStorage: {
      getItem: (key) => sessionSaved.get(key) || null,
      setItem: (key, value) => sessionSaved.set(key, value),
      removeItem: (key) => sessionSaved.delete(key)
    },
    fetch: async (_url, options) => {
      const payload = JSON.parse(options.body);
      calls.push(payload);
      return { ok: true, json: async () => typeof localResult === 'function' ? localResult(payload) : localResult || { ok: true } };
    },
    dbQuiet: async (promise) => (await promise)?.data || null,
    $: (selector) => fields[selector], $$: () => [],
    setLoading: () => undefined, applyCurrentUser: () => undefined,
    refreshIcons: () => undefined, icon: () => '', toast: () => undefined,
    reportNetworkStatus: (value) => calls.push({ network: value }),
    synchronizeAfterReconnect: () => Promise.resolve(true),
    window: { setTimeout: (callback) => { callback(); return 1; } },
    location: { reload: () => calls.push({ reload: true }) },
    console
  });
  vm.runInContext(code, context);
  return { state, context, form, errorBox, saved, sessionSaved, calls, user };
};

test('un login online valido prepara el acceso local', async () => {
  const fixture = setup({ online: true, result: { data: { token: 'online-token', user: { id: 'user-1', username: 'jefe', is_active: true } }, error: null } });
  const pending = fixture.context.loginFlow.waitForAdminLogin();
  await new Promise(setImmediate);
  await fixture.form.submit({ preventDefault() {} });
  await pending;
  assert.equal(fixture.state.authToken, 'online-token');
  assert.equal(fixture.calls.find((call) => call.action === 'enroll')?.pin, '1234');
  assert.equal(fixture.state.offlineLoginPending, false);
});

test('sin internet valida el PIN local y renueva token al volver', async () => {
  const fixture = setup({
    online: false,
    result: { data: { token: 'new-online-token', user: { id: 'user-1', username: 'jefe', is_active: true } }, error: null },
    localResult: (payload) => payload.action === 'verify'
      ? { status: 'ok', token: 'old-offline-token', user: { id: 'user-1', username: 'jefe', is_active: true } }
      : { ok: true }
  });
  const pending = fixture.context.loginFlow.waitForAdminLogin();
  await new Promise(setImmediate);
  await fixture.form.submit({ preventDefault() {} });
  await pending;
  assert.equal(fixture.state.authToken, 'old-offline-token');
  assert.equal(fixture.state.offlineLoginPending, true);
  fixture.context.navigator.onLine = true;
  assert.equal(await fixture.context.loginFlow.refreshOfflineLogin(), true);
  assert.equal(fixture.state.authToken, 'new-online-token');
  assert.equal(fixture.state.offlineLoginPending, false);
  assert.equal(fixture.calls.findLast((call) => call.action === 'enroll')?.token, 'new-online-token');
});

test('sin credencial previa no permite entrar y explica la conexion inicial', async () => {
  const fixture = setup({ online: false, localResult: { status: 'missing' } });
  void fixture.context.loginFlow.waitForAdminLogin();
  await new Promise(setImmediate);
  await fixture.form.submit({ preventDefault() {} });
  assert.equal(fixture.state.currentUser, null);
  assert.match(fixture.errorBox.textContent, /una vez con conexión/);
});

test('al reabrir sin internet exige PIN aunque exista un token de la pestaña anterior', async () => {
  const fixture = setup({
    online: false,
    localResult: (payload) => payload.action === 'verify'
      ? { status: 'ok', token: 'offline-token', user: { id: 'user-1', username: 'jefe', is_active: true } }
      : { ok: true }
  });
  fixture.sessionSaved.set('la_licorera_17_admin_token', 'old-tab-token');
  const pending = fixture.context.loginFlow.waitForAdminLogin();
  await new Promise(setImmediate);
  assert.equal(fixture.state.currentUser, null);
  assert.equal(fixture.sessionSaved.has('la_licorera_17_admin_token'), false);
  await fixture.form.submit({ preventDefault() {} });
  await pending;
  assert.equal(fixture.state.authToken, 'offline-token');
  assert.equal(fixture.state.offlineLoginPending, true);
});

test('un PIN rechazado por el backend online nunca entra por la credencial local', async () => {
  const fixture = setup({ online: true, result: { data: null, error: null }, localResult: { status: 'ok' } });
  void fixture.context.loginFlow.waitForAdminLogin();
  await new Promise(setImmediate);
  await fixture.form.submit({ preventDefault() {} });
  assert.equal(fixture.state.currentUser, null);
  assert.equal(fixture.calls.some((call) => call.action === 'verify'), false);
  assert.match(fixture.errorBox.textContent, /PIN incorrectos/);
});

test('si el backend revoca el acceso al reconectar se cierra la sesion local', async () => {
  const fixture = setup({
    online: false, result: { data: null, error: null },
    localResult: (payload) => payload.action === 'verify'
      ? { status: 'ok', token: 'old-token', user: { id: 'user-1', username: 'jefe', is_active: true } }
      : { ok: true }
  });
  const pending = fixture.context.loginFlow.waitForAdminLogin();
  await new Promise(setImmediate);
  await fixture.form.submit({ preventDefault() {} });
  await pending;
  fixture.context.navigator.onLine = true;
  assert.equal(await fixture.context.loginFlow.refreshOfflineLogin(), false);
  assert.equal(fixture.state.currentUser, null);
  assert.equal(fixture.calls.some((call) => call.action === 'forget'), true);
  assert.equal(fixture.calls.some((call) => call.reload), true);
});
