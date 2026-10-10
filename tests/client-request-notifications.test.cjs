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
const request = (id, type = 'waiter', extra = {}) => ({ id, table_id: 'table-a', session_id: 'session-a', request_type: type, status: 'pending', ...extra });
function harness(storage = new Map()) {
  let now = Date.parse('2026-10-09T18:00:00Z'), serial = 0;
  const timers = new Map(), sounds = [], box = { hidden: true, innerHTML: '' };
  const state = { currentTable: { id: 'table-a' }, currentSession: { id: 'session-a' }, clientRequests: [], clientQueuePositions: [] };
  const clock = class extends Date { static now() { return now; } };
  const context = vm.createContext({ state, Date: clock, $: () => box, escapeHTML: String,
    requestKind: row => row.request_type, playClientChatReceipt: id => { sounds.push(id); },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { clearTimeout: id => timers.delete(id), setTimeout: (fn, delay) => {
      const id = ++serial; timers.set(id, { fn, at: now + delay }); return id;
    } } });
  vm.runInContext(section('renderClientQueue', 'bindAccountFeatures') + ';globalThis.render = renderClientQueue;', context);
  return { state, box, sounds, storage, render: context.render, now: () => now,
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    } };
}

test('El aviso de turno desaparece a los cinco segundos sin reaparecer con cada consulta', () => {
  const h = harness();
  h.state.clientQueuePositions = [{ id: 'a', kind: 'service', position: 2 }];
  h.render();
  assert.equal(h.box.hidden, false);
  assert.match(h.box.innerHTML, /client-notification/);
  h.advance(4000); h.render();
  h.advance(999);
  assert.equal(h.box.hidden, false);
  h.advance(1);
  assert.equal(h.box.hidden, true);
  h.render();
  assert.equal(h.box.hidden, true);
  h.state.clientQueuePositions.push({ id: 'b', kind: 'service', position: 2 });
  h.render();
  assert.equal(h.box.hidden, false, 'Una nueva solicitud genera un aviso nuevo.');
  assert.equal((h.box.innerHTML.match(/client-notification/g) || []).length, 1);
  h.advance(5000);
  assert.equal(h.box.hidden, true);
});

test('La aceptacion agrupada muestra un contador, suena una vez por categoria y dura cinco segundos', () => {
  const h = harness();
  h.state.clientRequests = [request('a'), request('b')]; h.render();
  assert.equal(h.sounds.length, 0);
  h.state.clientRequests.forEach(row => { row.status = 'acknowledged'; row.acknowledged_at = new Date(h.now()).toISOString(); });
  h.render();
  assert.equal(h.sounds.length, 1);
  assert.equal((h.box.innerHTML.match(/data-attending-request=/g) || []).length, 1);
  assert.match(h.box.innerHTML, /Te estamos atendiendo \(2\)/);
  h.advance(3000); h.render();
  assert.equal(h.sounds.length, 1);
  h.advance(2000);
  assert.equal(h.box.hidden, true);
  h.render();
  assert.equal(h.box.hidden, true);
  assert.equal(h.sounds.length, 1);
  h.state.clientRequests.push(request('c', 'song', { status: 'acknowledged', acknowledged_at: new Date(h.now()).toISOString() }));
  h.render();
  assert.equal(h.sounds.length, 2);
  assert.match(h.box.innerHTML, /de canción/);
});

test('Los avisos antiguos y los de otra mesa o sesion no vuelven a sonar al refrescar', () => {
  const h = harness();
  h.state.clientRequests = [
    request('old', 'waiter', { status: 'acknowledged', acknowledged_at: new Date(h.now() - 60000).toISOString() }),
    request('other-table', 'waiter', { status: 'acknowledged', table_id: 'table-b' }),
    request('other-session', 'waiter', { status: 'acknowledged', session_id: 'session-b' })
  ];
  h.render();
  assert.equal(h.box.hidden, true);
  assert.equal(h.sounds.length, 0);
  const recent = request('recent', 'waiter', { status: 'acknowledged', acknowledged_at: new Date(h.now()).toISOString() });
  h.state.clientRequests.push(recent); h.render();
  assert.equal(h.sounds.length, 1);
  const reloaded = harness(h.storage);
  reloaded.state.clientRequests = [recent]; reloaded.render();
  assert.equal(reloaded.sounds.length, 0);
  assert.equal(reloaded.box.hidden, true);
});

test('Aceptar el chat usa el mismo sonido y conserva el aviso propio de la conversacion', () => {
  const h = harness();
  h.state.clientRequests = [request('chat', 'chat')]; h.render();
  h.state.clientRequests[0].status = 'acknowledged'; h.render(); h.render();
  assert.equal(h.sounds.length, 1);
  assert.equal(h.box.hidden, true);
});

test('La agrupacion conserva todos los IDs y separa las mesas y categorias', () => {
  const records = [request('a', 'waiter', { created_at: 1 }), request('b', 'waiter', { created_at: 2 }),
    request('song', 'song', { created_at: 3 }), request('other-table', 'waiter', { table_id: 'table-b', created_at: 4 })];
  const context = vm.createContext({ activeRequests: () => records, requestKind: row => row.request_type,
    compareRequestArrival: (a, b) => a.created_at - b.created_at });
  vm.runInContext(section('groupedActiveRequests', 'renderAlerts') + ';globalThis.group = groupedActiveRequests;', context);
  const groups = context.group();
  assert.equal(groups.length, 3);
  assert.deepEqual([...groups].map(row => row.id), ['other-table', 'song', 'b']);
  assert.equal(groups[2].count, 2);
  assert.deepEqual([...groups[2].request_ids], ['b', 'a']);
  assert.equal(records.length, 4, 'Agrupa las tarjetas y conserva las solicitudes originales.');
});

test('El aviso emergente del cliente usa verde y desaparece exactamente a los cinco segundos', () => {
  for (const page of ['client', 'admin']) {
    const state = { page, visibleToastKeys: new Set(), toastLastShown: new Map() };
    const items = [], timers = [];
    const context = vm.createContext({ state, icon: () => '', refreshIcons() {},
      $: () => ({ appendChild: item => items.push(item) }),
      document: { createElement: () => ({ classList: { add() {} }, remove() { this.removed = true; } }) },
      setTimeout: (fn, delay) => timers.push({ fn, delay }) });
    vm.runInContext(section('toast', 'isConfigured') + ';globalThis.notify = toast;', context);
    context.notify('Solicitud enviada', 'ok', 'request');
    assert.equal(items[0].className.includes('client-notification'), page === 'client');
    assert.equal(timers[0].delay, page === 'client' ? 5000 : 3600);
    if (page === 'client') {
      timers[0].fn();
      assert.equal(items[0].removed, true);
      assert.equal(state.visibleToastKeys.size, 0);
    }
  }
});
