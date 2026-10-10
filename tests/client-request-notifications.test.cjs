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
  const outbox = [];
  const timers = new Map(), sounds = [], box = { hidden: true, innerHTML: '' };
  const state = { currentTable: { id: 'table-a' }, currentSession: { id: 'session-a' }, clientRequests: [], clientQueuePositions: [] };
  const clock = class extends Date { static now() { return now; } };
  const context = vm.createContext({ state, Date: clock, $: () => box, escapeHTML: String,
    readRequestOutbox: () => outbox, isSongRequest: row => row.request_type === 'song',
    requestKind: row => row.request_type, playClientChatReceipt: id => { sounds.push(id); },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { clearTimeout: id => timers.delete(id), setTimeout: (fn, delay) => {
      const id = ++serial; timers.set(id, { fn, at: now + delay }); return id;
    } } });
  vm.runInContext(section('songTurnCount', 'showSongLimitNotice') + section('renderClientQueue', 'bindAccountFeatures') + ';globalThis.render = renderClientQueue;', context);
  return { state, box, sounds, storage, outbox, render: context.render, now: () => now,
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

test('Los badges de turno persisten, actualizan el contador y no duplican tarjetas', () => {
  const h = harness();
  h.state.clientQueuePositions = [{ id: 'a', kind: 'service', position: 2 }];
  h.render();
  assert.equal(h.box.hidden, false);
  assert.match(h.box.innerHTML, /data-queue-kind="service"/);
  assert.match(h.box.innerHTML, /Turno <b>2/);
  assert.doesNotMatch(h.box.innerHTML, /client-notification/);
  h.advance(60000); h.render();
  assert.match(h.box.innerHTML, /Turno <b>2/);
  h.state.clientQueuePositions.push({ id: 'b', kind: 'service', position: 2 });
  h.render();
  assert.equal((h.box.innerHTML.match(/data-queue-kind="service"/g) || []).length, 1);
  assert.match(h.box.innerHTML, /Atención · 2 solicitud/);
  h.state.clientQueuePositions.forEach(row => row.position = 1);
  h.render();
  assert.match(h.box.innerHTML, /Turno <b>1/);
  assert.match(h.box.innerHTML, /Tu mesa es la siguiente/);
  h.state.clientQueuePositions = []; h.render();
  assert.doesNotMatch(h.box.innerHTML, /data-queue-kind="service"/);
  assert.match(h.box.innerHTML, /0[/]5/);
});

test('Las canciones y oportunidades siguen visibles con envios pendientes y al recargar', () => {
  const h = harness();
  h.outbox.push(request('a', 'song', { status: 'sending' }));
  h.state.clientRequests = [request('a', 'song', { status: 'sending' }), request('b', 'song')];
  h.render();
  assert.match(h.box.innerHTML, /2[/]5/);
  assert.match(h.box.innerHTML, /<b>3<[/]b> disponibles/);
  h.state.clientQueuePositions = [{ id: 'a', kind: 'song', position: 3 }, { id: 'b', kind: 'song', position: 3 }];
  h.render(); h.advance(10000); h.render();
  assert.equal((h.box.innerHTML.match(/data-queue-kind="song"/g) || []).length, 1);
  assert.match(h.box.innerHTML, /Turno <b>3/);
  assert.match(h.box.innerHTML, /2[/]5/);
  const reloaded = harness(h.storage);
  reloaded.state.clientRequests = h.state.clientRequests;
  reloaded.state.clientQueuePositions = h.state.clientQueuePositions;
  reloaded.render();
  assert.match(reloaded.box.innerHTML, /Turno <b>3/);
  assert.match(reloaded.box.innerHTML, /2[/]5/);
  assert.equal(reloaded.sounds.length, 0);
  h.state.clientRequests.push(...['c', 'd', 'e'].map(id => request(id, 'song'))); h.render();
  assert.match(h.box.innerHTML, /5[/]5/);
  assert.match(h.box.innerHTML, /<b>0<[/]b> disponibles/);
  h.state.clientRequests = []; h.state.clientQueuePositions = []; h.outbox.length = 0; h.render();
  assert.match(h.box.innerHTML, /0[/]5/);
  h.state.currentTable = null; h.state.currentSession = null; h.render();
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
  assert.doesNotMatch(h.box.innerHTML, /client-notification/);
  h.render();
  assert.doesNotMatch(h.box.innerHTML, /client-notification/);
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
  assert.doesNotMatch(h.box.innerHTML, /client-notification/);
  assert.equal(h.sounds.length, 0);
  const recent = request('recent', 'waiter', { status: 'acknowledged', acknowledged_at: new Date(h.now()).toISOString() });
  h.state.clientRequests.push(recent); h.render();
  assert.equal(h.sounds.length, 1);
  const reloaded = harness(h.storage);
  reloaded.state.clientRequests = [recent]; reloaded.render();
  assert.equal(reloaded.sounds.length, 0);
  assert.doesNotMatch(reloaded.box.innerHTML, /client-notification/);
});

test('Aceptar el chat usa el mismo sonido y conserva el aviso propio de la conversacion', () => {
  const h = harness();
  h.state.clientRequests = [request('chat', 'chat')]; h.render();
  h.state.clientRequests[0].status = 'acknowledged'; h.render(); h.render();
  assert.equal(h.sounds.length, 1);
  assert.doesNotMatch(h.box.innerHTML, /client-notification/);
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
