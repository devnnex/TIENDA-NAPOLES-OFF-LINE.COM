const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const block = (name, next) => {
  const start = source.indexOf('  const ' + name + ' ='), end = source.indexOf('  const ' + next + ' =', start);
  assert.ok(start >= 0 && end > start, name); return source.slice(start, end);
};

test('una jornada larga conserva como maximo 160 QR y permite reintentar errores', async () => {
  const state = { qrCache: new Map() }; let generated = 0, fail = false;
  const context = vm.createContext({ state, generateQrDataUrl: async text => { generated++; if (fail) throw Error('QR failed'); return text; } });
  vm.runInContext(block('cachedQrDataUrl', 'renderQrImage') + ';globalThis.read = cachedQrDataUrl;', context);
  for (let i = 0; i < 400; i++) assert.equal(await context.read('mesa-' + i), 'mesa-' + i);
  assert.equal(state.qrCache.size, 160);
  assert.equal(await context.read('mesa-399'), 'mesa-399'); assert.equal(generated, 400);
  fail = true; await assert.rejects(context.read('retry')); assert.equal(state.qrCache.has('720:retry'), false);
  fail = false; assert.equal(await context.read('retry'), 'retry'); assert.equal(state.qrCache.size, 160);
});

test('las miniaturas QR ceden el clic y cancelan las tandas al cambiar de seccion', async () => {
  const queued = [], rendered = [];
  const targets = [1, 2, 3].map(id => ({ dataset: { tableQr: String(id) }, isConnected: true }));
  const state = { activeAdminSection: 'menu', tables: [1, 2, 3].map(id => ({ id })) };
  const context = vm.createContext({ state, $$: () => targets, qrTextForTable: table => String(table.id), tableLabel: table => String(table.id),
    renderQrImage: async (_target, text) => { rendered.push(text); }, window: { setTimeout: callback => queued.push(callback) } });
  vm.runInContext(block('renderGeneratedTableQrs', 'renderTableFormQr') + ';globalThis.render = renderGeneratedTableQrs;', context);
  context.render(); assert.equal(rendered.length, 0, 'No genera codigos en el controlador del clic');
  await queued.shift()(); assert.deepEqual(rendered, ['1']);
  state.activeAdminSection = 'dashboard'; await queued.shift()(); assert.deepEqual(rendered, ['1']);
  state.activeAdminSection = 'menu'; context.render();
  while (queued.length) await queued.shift()();
  assert.deepEqual(rendered, ['1', '1', '2', '3']);
});

test('las mesas indexan cuentas una vez y mantienen solicitudes y consumo correctos', () => {
  const state = { sessions: [{ id: 'closed', table_id: 'a', status: 'closed' }, { id: 'sale', table_id: 'a', status: 'open' }],
    requests: [{ table_id: 'a', status: 'pending' }, { table_id: 'a', status: 'pending' }, { table_id: 'b', status: 'accepted' }] };
  let inspected = 0;
  const context = vm.createContext({ state, normalTables: () => [{ id: 'a', table_number: 1, is_active: true }, { id: 'b', table_number: 2, is_active: true }],
    sessionHasConsumption: session => { inspected++; return session.status === 'open'; }, sessionTotal: () => 2500,
    tableMatchesZone: () => true, tableMatchesGroup: () => true, tableMatchesSearch: () => true, isOutdoorTable: () => false, isTerraceTable: () => false,
    escapeHTML: String, icon: () => '', money: amount => '$' + amount, tableLabel: table => 'Mesa ' + table.table_number });
  vm.runInContext(block('compactTableTiles', 'renderTables') + ';globalThis.render = compactTableTiles;', context);
  const html = context.render();
  assert.equal(inspected, 2); assert.match(html, /occupied[^]*<small>\$2500<\/small><em>2<\/em>/); assert.match(html, /data-open-table="b"[^]*<small>Libre<\/small>/);
});

test('las solicitudes identicas no vuelven a formatear tarjetas y siguen notificando llegadas', () => {
  let formatted = 0, alarms = 0;
  const request = { id: 'r', kind: 'waiter', request_type: 'waiter', request_ids: ['r'], entries: [{ id: 'r', message: '', created_at: '2026-11-27' }], restaurant_tables: { table_number: 1 }, created_at: '2026-11-27' };
  const state = { alertFilter: 'all' }, box = { innerHTML: '', classList: { toggle() {} }, querySelectorAll: () => [] };
  const context = vm.createContext({ state, $: selector => selector === '#alertsPanel' ? box : null, groupedActiveRequests: () => [request],
    REQUEST_IMAGES: {}, REQUEST_ICONS: {}, REQUEST_LABELS: {}, icon: () => '', tableLabel: () => 'Mesa 1', escapeHTML: String,
    prettyDateTime: () => { formatted++; return 'Hoy'; }, requestGroupDetailsHtml: () => '', parseBillMessage: () => false,
    requestSignature: () => 'arrival', playAlarm: () => alarms++, activeRequests: () => [request], refreshIcons() {}, emptyState: () => '' });
  vm.runInContext(block('renderAlerts', 'compactTableTiles') + ';globalThis.render = renderAlerts;', context);
  context.render(); const initial = box.innerHTML;
  for (let i = 0; i < 100; i++) context.render();
  assert.equal(formatted, 1); assert.equal(alarms, 1); assert.equal(box.innerHTML, initial);
  request.entries[0].message = 'Cambio'; context.render(); assert.equal(formatted, 2);
});

test('cien actualizaciones bajo el turno usan un solo listener y dibujan la ultima version', () => {
  const listeners = [], queued = []; let opened = true;
  const modal = { addEventListener: (_name, callback) => listeners.push(callback) };
  const target = { isConnected: true, closest: () => null, innerHTML: '', firstElementChild: null, lastElementChild: null,
    insertAdjacentHTML(_position, html) { this.innerHTML += html; } };
  const context = vm.createContext({ document: { querySelector: () => opened ? modal : null },
    window: { setTimeout: callback => queued.push(callback) }, performance: { now: () => 0 }, refreshIcons() {} });
  vm.runInContext(block('paintRowsProgressively', 'setLoading') + ';globalThis.paint = paintRowsProgressively;', context);
  for (let i = 0; i < 100; i++) context.paint(target, [() => '<div>' + i + '</div>']);
  assert.equal(listeners.length, 1); assert.equal(target.innerHTML, '');
  opened = false; listeners[0](); while (queued.length) queued.shift()();
  assert.equal(target.innerHTML, '<div>99</div>'); assert.equal(target.rowPaintShiftResume, null);
});
