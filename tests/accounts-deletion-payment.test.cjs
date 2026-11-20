const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf('  const ' + from + ' ='), source.indexOf('  const ' + to + ' =', source.indexOf('  const ' + from + ' =') + 1));
const clone = value => JSON.parse(JSON.stringify(value));
function setup({ paid = 50, reject = false, duringConfirmation, duringWrite } = {}) {
  const account = { id: 'account', status: 'open', session_items: [
    { id: 'one', item_name: 'Agua', quantity: 1, unit_price: 100, status: 'served' },
    { id: 'two', item_name: 'Jugo', quantity: 1, unit_price: 100, status: 'served' }
  ], session_payments: paid ? [{ id: 'payment', amount: paid }] : [] };
  const state = { sessions: [clone(account)], invoiceHistory: [], checkoutClosures: {}, optimisticSessionStates: new Map(), optimisticRequestStates: new Map(), currentUser: { id: 'boss' } };
  const events = [], messages = [];
  const context = vm.createContext({ state, Date, Map, Set, REMOTE_CONFIRMATION_HOLD_MS: 1500,
    integerMoney: value => Math.round(Number(value || 0)),
    canDeleteRecords: () => true, isLocalWalkInSession: () => false, renderAdminLive() {}, persistWalkInDrafts() {}, persistOfflineAdminSnapshot() {},
    askForConfirmation: async () => { duringConfirmation?.(state); return true; },
    toast: (...args) => messages.push(args),
    retryQuiet: async factory => { const result = await factory(); return result.data; }
  });
  state.sb = { from: () => { let id; return {
    update() { return this; }, eq(_, value) { id = value; return this; }, select() { return this; },
    async single() { events.push('write'); await duringWrite?.(state, context.api, account);
      return { data: reject ? null : { ...account.session_items.find(row => row.id === id), status: 'cancelled' } }; }
  }; } };
  const offline = source.includes('  const applyOfflineSessionRemap =');
  vm.runInContext(section('sessionTotals', 'aggregateAccountPayments')
    + section('mergeOptimisticRequests', offline ? 'applyOfflineSessionRemap' : 'isSongRequest')
    + section('deleteConsumption', 'showStockWarning')
    + ';globalThis.api={remove:deleteConsumption,merge:mergeOptimisticSessions};', context);
  return { state, api: context.api, events, messages, account };
}

for (const paid of [0, 50, 100]) test('eliminar con abonos de ' + paid + ' resiste una lectura atrasada y conserva el saldo', async () => {
  const h = setup({ paid, duringWrite(state, api, original) { state.sessions = api.merge([clone(original)]); } });
  await h.api.remove('account', 'one');
  const result = h.api.merge([clone(h.account)])[0];
  assert.equal(result.session_items.find(row => row.id === 'one').status, 'cancelled');
  assert.equal(result.session_items.find(row => row.id === 'two').status, 'served');
  assert.equal(result.session_payments.reduce((sum, row) => sum + row.amount, 0), paid);
  assert.equal(h.events.length, 1);
});

test('retirar el ultimo producto limpia los abonos de la cuenta vacia', async () => {
  const h = setup(); h.state.sessions[0].session_items.splice(1);
  const previous = clone(h.state.sessions[0]);
  await h.api.remove('account', 'one');
  assert.equal(h.state.sessions[0].session_payments.length, 0);
  assert.equal(h.state.sessions[0].session_items[0].status, 'cancelled');
  const stale = h.api.merge([previous])[0];
  assert.equal(stale.session_payments.length, 0, 'Una lectura atrasada no vuelve a ocupar la mesa con abonos antiguos.');
});

test('un abono recibido mientras se confirma la eliminacion vuelve a validar el saldo', async () => {
  const h = setup({ duringConfirmation(state) { state.sessions = [{ ...state.sessions[0], session_payments: [{ id: 'other-payment', amount: 150 }] }]; } });
  await h.api.remove('account', 'one');
  assert.equal(h.events.length, 0);
  assert.equal(h.state.sessions[0].session_items[0].status, 'served');
  assert.equal(h.state.sessions[0].session_payments[0].amount, 150);
});

test('un rechazo restaura solo el producto y conserva otros consumos y abonos nuevos', async () => {
  const h = setup({ reject: true, duringWrite(state) {
    state.sessions[0].session_items.push({ id: 'new', quantity: 1, unit_price: 20, status: 'served' });
    state.sessions[0].session_payments.push({ id: 'new-payment', amount: 10 });
  } });
  await h.api.remove('account', 'one');
  assert.equal(h.state.sessions[0].session_items[0].status, 'served');
  assert.equal(h.state.sessions[0].session_items.length, 3);
  assert.equal(h.state.sessions[0].session_payments.length, 2);
});
