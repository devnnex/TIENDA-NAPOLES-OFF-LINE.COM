const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
const from = source.indexOf('  const pendingAdminReadScope =');
const to = source.indexOf('  const setScopedAdminRead =', from);
assert.ok(from > 0 && to > from);
const context = vm.createContext({});
vm.runInContext(source.slice(from, to) + ';globalThis.api={pendingAdminReadScope,mergePendingAdminRows}', context);
const { pendingAdminReadScope, mergePendingAdminRows } = context.api;
const cached = { requests: [{ id: 'request-a', status: 'acknowledged' }], sessions: [
  { id: 'a', payer_name: 'Cliente pendiente', session_items: [{ id: 'item-a', quantity: 2, unit_price: 4500 }] },
  { id: 'b', session_items: [{ id: 'item-b', quantity: 1, unit_price: 3000 }] }
] };
const remote = { requests: [{ id: 'request-a', status: 'pending' }, { id: 'request-b', status: 'pending' }],
  sessions: [{ id: 'a', session_items: [] }, { id: 'b', session_items: [{ id: 'item-b', quantity: 4, unit_price: 3000 }] }, { id: 'c', session_items: [] }] };
const record = (entity, recordIds, sessionIds = [], sessionStatus = '') => ({ entity, recordIds, sessionIds, sessionStatus });
let scope = pendingAdminReadScope(cached, { blockingRecords: [record('session_items', ['item-a'], ['a'])] });
assert.equal(scope.safe, true);
let merged = mergePendingAdminRows(remote, cached, scope);
assert.equal(merged.sessions.find(row => row.id === 'a').session_items[0].quantity * 4500, 9000);
assert.equal(merged.sessions.find(row => row.id === 'b').session_items[0].quantity, 4);
assert.ok(merged.sessions.some(row => row.id === 'c'));
scope = pendingAdminReadScope(cached, { blockingRecords: [record('table_sessions', ['a'], [], 'closed')] });
assert.equal(mergePendingAdminRows(remote, cached, scope).sessions.some(row => row.id === 'a'), false);
scope = pendingAdminReadScope({ ...cached, sessions: [] }, { blockingRecords: [record('table_sessions', ['a'], [], 'closed')] });
assert.equal(scope.safe, true, 'El cierre pendiente no reaparece al caducar una lapida temporal.');
scope = pendingAdminReadScope(cached, { blockingRecords: [record('rpc:acknowledge_service_requests', ['request-a'])] });
merged = mergePendingAdminRows(remote, cached, scope);
assert.equal(merged.requests.find(row => row.id === 'request-a').status, 'acknowledged');
assert.ok(merged.requests.some(row => row.id === 'request-b'));
assert.equal(pendingAdminReadScope(null, { blockingRecords: [record('session_items', ['item-a'], ['a'])] }).safe, false);
assert.equal(pendingAdminReadScope(cached, { blockingRecords: [record('session_items', ['unknown-item'])] }).safe, false);
assert.equal(pendingAdminReadScope(cached, { blockingRecords: null }).safe, false);
console.log('Lectura por cuenta: conserva pendientes, refresca otras cuentas, protege cierres y solicitudes; sin evidencia mantiene proteccion.');
