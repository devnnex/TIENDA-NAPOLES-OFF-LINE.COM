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
function harness({ popover = true } = {}) {
  let now = 18000;
  const state = { page: 'admin', visibleToastKeys: new Set(), toastLastShown: new Map() };
  const items = [], timers = [], fallbackItems = [];
  const dialog = { appendChild: item => fallbackItems.push(item) };
  const context = vm.createContext({ state, Date: class extends Date { static now() { return now; } },
    $: () => ({ appendChild: item => items.push(item) }),
    icon: () => '', refreshIcons() {}, inventoryFor: item => ({ stock: item.stock }),
    document: { querySelectorAll: () => [dialog], createElement: () => {
      const item = { attributes: {}, classList: { add() {} }, removed: false,
        setAttribute(name, value) { this.attributes[name] = value; }, remove() { this.removed = true; } };
      if (popover) item.showPopover = () => { item.inTopLayer = true; };
      return item;
    } },
    setTimeout: (callback, delay) => timers.push({ callback, delay })
  });
  vm.runInContext(section('toast', 'isConfigured') + section('validatePaidInventory', 'applyPaidInventoryLocally')
    + ';globalThis.api = {toast, validatePaidInventory};', context);
  return { api: context.api, items, timers, fallbackItems, state, advance: ms => { now += ms; } };
}
test('El stock insuficiente sigue bloqueando el cobro y genera un aviso en la capa superior por cinco segundos', () => {
  const h = harness();
  const plan = [{ item: { id: 'product', name: 'Cerveza', stock: 1 }, quantity: 2 }];
  assert.equal(h.api.validatePaidInventory(plan), false);
  assert.equal(h.items.length, 1);
  const item = h.items[0];
  assert.match(item.className, /stock-warning/);
  assert.match(item.innerHTML, /Stock insuficiente/);
  assert.match(item.innerHTML, /Cerveza requiere 2 y solo hay 1/);
  assert.equal(item.inTopLayer, true);
  assert.deepEqual(item.attributes, { role: 'alert', 'aria-live': 'assertive', popover: 'manual' });
  assert.equal(h.timers[0].delay, 5000);
  assert.equal(item.removed, false);
  h.api.validatePaidInventory(plan);
  assert.equal(h.items.length, 1, 'No apila el mismo aviso al insistir mientras está visible.');
  h.advance(5000); h.timers[0].callback();
  assert.equal(item.removed, true);
  assert.equal(h.state.visibleToastKeys.size, 0);
  assert.equal(h.api.validatePaidInventory(plan), false);
  assert.equal(h.items.length, 2, 'Otro intento bloqueado vuelve a mostrar el motivo al terminar los cinco segundos.');
  plan[0].item.stock = 2;
  assert.equal(h.api.validatePaidInventory(plan), true);
  assert.equal(h.items.length, 2);
});
test('El aviso usa el modal abierto como respaldo cuando no existe la API de popover', () => {
  const h = harness({ popover: false });
  h.api.toast('Stock insuficiente', 'error', 'payment-stock:product');
  assert.deepEqual(h.fallbackItems, h.items);
  assert.equal(h.timers[0].delay, 5000);
  assert.equal(h.items[0].attributes.popover, undefined);
});
test('Los otros avisos conservan su duracion y no pasan a la capa superior', () => {
  for (const type of ['ok', 'error']) {
    const h = harness();
    h.api.toast('Otro aviso', type, 'ordinary:' + type);
    assert.doesNotMatch(h.items[0].className, /stock-warning/);
    assert.equal(h.items[0].inTopLayer, undefined);
    assert.equal(h.timers[0].delay, type === 'error' ? 5600 : 3600);
  }
});
