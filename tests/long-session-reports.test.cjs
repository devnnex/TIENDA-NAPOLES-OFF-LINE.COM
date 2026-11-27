const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const block = (start, end) => {
  const a = source.indexOf('  const ' + start + ' =');
  const b = source.indexOf('  const ' + end + ' =', a + 1);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
};

test('filtrar miles de compras reutiliza el formateador y respeta el dia de Bogota', () => {
  let created = 0;
  const state = { businessTimeZone: 'America/Bogota' };
  const context = vm.createContext({ state, Date, Object, Number, String,
    Intl: { DateTimeFormat: function (...args) { created++; return new Intl.DateTimeFormat(...args); } } });
  const offline = source.includes('  const purchaseDateKey =');
  vm.runInContext((offline ? block('purchaseDateKey', 'purchaseUnitCost') : block('businessDateKey', 'shiftBusinessDateKey'))
    + ';globalThis.dateKey=' + (offline ? 'purchaseDateKey' : 'businessDateKey') + ';', context);
  for (let i = 0; i < 5000; i++) assert.equal(context.dateKey(new Date('2026-11-28T04:59:00Z')), '2026-11-27');
  assert.equal(created, 1, 'La consulta no crea 5000 formateadores');
  assert.equal(context.dateKey(new Date('2026-11-28T05:00:00Z')), '2026-11-28');
  if (!offline) {
    state.businessTimeZone = 'UTC';
    assert.equal(context.dateKey(new Date('2026-11-28T04:59:00Z')), '2026-11-28');
    assert.equal(created, 2, 'Un cambio de zona invalida el formateador');
  }
});

test('inventario recorre productos una vez para las categorias y conserva las opciones sin cambios', () => {
  let categoryReads = 0, paints = 0;
  const state = { inventoryCategoryFilter: 'c999', categories: Array.from({ length: 1000 }, (_, i) => ({ id: 'c' + i, name: 'Categoria ' + i })),
    items: Array.from({ length: 1000 }, (_, i) => ({ get category_id() { categoryReads++; return 'c' + i; } })) };
  const select = { value: '', get innerHTML() { return this.markup || ''; }, set innerHTML(value) { this.markup = value; paints++; } };
  const context = vm.createContext({ state, Set, String, Number, $: () => select, escapeHTML: String });
  vm.runInContext(block('renderInventoryCategoryFilter', 'renderInventory') + ';globalThis.render=renderInventoryCategoryFilter;', context);
  context.render();
  assert.equal(select.value, 'c999');
  assert.equal(categoryReads, 1000, 'No examina 1000 productos para cada categoria');
  context.render();
  assert.equal(paints, 1, 'Conserva el selector mientras no cambien sus opciones');
  state.categories.pop();
  context.render();
  assert.equal(state.inventoryCategoryFilter, 'all');
  assert.equal(select.value, 'all');
});

test('filtrar compras sin fechas no calcula un dia para cada movimiento', () => {
  let dateReads = 0;
  const state = { inventoryMovements: Array.from({ length: 4000 }, (_, i) => ({ movementId: 'm' + i, productId: 'p', product: 'Agua', date: '2026-11-27T20:00:00Z' })),
    purchaseSearch: '', purchaseProductFilter: 'all', purchaseDateFrom: '', purchaseDateTo: '' };
  const context = vm.createContext({ state, String, Number, Date, normalizeText: String, isPurchaseMovement: () => true,
    purchaseHistoryCutoff: () => NaN, hiddenPurchaseMovementIds: () => new Set(),
    businessDateKey: () => { dateReads++; return '2026-11-27'; }, purchaseDateKey: () => { dateReads++; return '2026-11-27'; } });
  vm.runInContext(block('purchaseMovements', 'renderPurchaseProductOptions') + ';globalThis.rows=purchaseMovements;', context);
  assert.equal(context.rows().length, 4000);
  assert.equal(dateReads, 0);
  state.purchaseDateFrom = '2026-11-28';
  assert.equal(context.rows().length, 0);
  assert.equal(dateReads, 4000);
});
