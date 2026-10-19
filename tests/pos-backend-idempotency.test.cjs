const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../appscript/Code.gs'), 'utf8');

function backend() {
  let writes = 0, failure = 0;
  const fault = () => { if (++writes === failure) throw new Error('lost_response_after_write'); };
  class Sheet {
    constructor(name, rows = []) { this.name = name; this.rows = rows; this.columns = 26; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
    getMaxColumns() { return this.columns; }
    insertColumnsAfter(_, count) { this.columns += count; }
    getRange(row, column, height = 1, width = 1) {
      const sheet = this;
      return {
        getRow: () => row,
        getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => sheet.rows[row - 1 + r]?.[column - 1 + c] ?? '')),
        setValues(values) {
          for (let r = 0; r < height; r++) {
            sheet.rows[row - 1 + r] ||= [];
            for (let c = 0; c < width; c++) sheet.rows[row - 1 + r][column - 1 + c] = values[r][c];
          }
          fault();
        },
        setValue(value) { this.setValues([[value]]); },
        clearContent() { this.setValues(Array.from({ length: height }, () => Array(width).fill(''))); },
        createTextFinder(value) {
          return { matchEntireCell() { return this; }, findNext() {
            for (let r = row; r < row + height; r++) for (let c = column; c < column + width; c++) {
              if (String(sheet.rows[r - 1]?.[c - 1] ?? '') === String(value)) return sheet.getRange(r, c);
            }
            return null;
          } };
        }
      };
    }
  }
  const sheets = new Map(), properties = new Map(), cache = new Map();
  const spreadsheet = { getSheetByName: name => sheets.get(name), insertSheet: name => {
    const sheet = new Sheet(name); sheets.set(name, sheet); return sheet;
  } };
  const context = vm.createContext({ console, Date, Number,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => { properties.set(key, String(value)); fault(); },
      deleteProperty: key => { properties.delete(key); fault(); } }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => cache.set(key, value) }) },
    SpreadsheetApp: { flush() {} },
    Utilities: { formatDate: date => date.toISOString().slice(0, 10) }
  });
  vm.runInContext(source, context);
  for (const [key, name] of Object.entries(context.APP.sheets)) sheets.set(name, new Sheet(name, [context.HEADERS[key] || []]));
  const inventory = sheets.get(context.APP.sheets.inventory);
  inventory.rows.push(['p1', 'P1', 'Producto', '', 'unidad', 20, 100, 10, 0, true, '', '', 1]);
  Object.assign(context, { getSpreadsheet_: () => spreadsheet, getTimezone_: () => 'America/Bogota',
    hash_: value => value, archiveSupabaseSession_: () => true, appendAudit_: () => {},
    getInventory_: () => ({ items: context.readInventoryTable_().rows.map(row => ({ productId: row[0], stock: row[7] })) }) });
  return { context, sheets, properties, faultAt: count => { writes = 0; failure = count; }, writes: () => writes,
    sheet: key => sheets.get(context.APP.sheets[key]),
    sale: invoice => context.recordSale_(invoice, { full_name: 'Caja' }, 'test-token') };
}
const invoice = (id, quantity = 2, method = 'card') => ({ id, sessionId: id, saleChannel: 'walk_in', number: 'F-' + id,
  createdAt: '2026-10-19T15:00:00Z', paymentMethod: method, payments: [{ method, amount: quantity * 100 }],
  totals: { subtotal: quantity * 100, total: quantity * 100, discount: 0, tax: 0, serviceFee: 0 },
  items: [{ id: 'line-' + id, menu_item_id: 'p1', item_name: 'Producto', quantity, unit_price: 100, unit_cost: 20 }] });

test('reintenta cada escritura ambigua y recupera la venta antes de aplicar otro inventario', () => {
  const reference = backend(); reference.sale(invoice('sale-a'));
  const writeCount = reference.writes();
  assert.ok(writeCount >= 8);
  for (let fault = 1; fault <= writeCount; fault++) {
    const h = backend(); h.faultAt(fault);
    try { h.sale(invoice('sale-a')); } catch (error) { assert.match(error.message, /lost_response/); }
    h.faultAt(0);
    h.sale(invoice('sale-b', 1, 'cash'));
    h.sale(invoice('sale-a'));
    h.sale(invoice('sale-a'));
    assert.equal(h.sheet('inventory').rows[1][7], 7, 'stock, interruption ' + fault);
    for (const key of ['sales', 'details', 'payments', 'movements']) assert.equal(h.sheet(key).rows.length - 1, 2, key + ', interruption ' + fault);
    const daily = h.sheet('daily').rows[1];
    assert.equal(daily[1], 2, 'daily count, interruption ' + fault);
    assert.equal(daily[2], 300);
    assert.equal(daily[3], 100);
    assert.equal(daily[13], 200);
  }
  console.log('Interrupciones comprobadas:', writeCount);
});

test('una cuenta repetida usa la identidad original y rechaza otro importe o medio de pago', () => {
  const h = backend(), first = invoice('sale-a'); h.sale(first);
  const retry = { ...first, id: 'another-id' };
  const response = h.sale(retry);
  assert.equal(response.duplicate, true);
  assert.equal(response.saleId, first.id);
  assert.equal(h.sheet('daily').rows[1][1], 1);
  assert.equal(h.sheet('inventory').rows[1][7], 8);
  const invalid = h.sale({ ...retry, payments: [{ method: 'cash', amount: 200 }] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.conflict, true);
  assert.equal(h.sheet('payments').rows.length, 2);
});

test('divide un plan grande en celdas compatibles sin truncar los consumos', () => {
  const h = backend(), sale = invoice('large'); sale.recoveryNote = 'x'.repeat(100000);
  h.sale(sale);
  const journal = h.sheets.get('POS_Operaciones').rows[1];
  assert.ok(journal[3] >= 4);
  assert.equal(JSON.parse(journal.slice(5).join('')).invoice.recoveryNote.length, 100000);
  assert.ok(journal.slice(5).every(chunk => chunk.length <= 28000));
});

test('un día con miles de ventas no desborda la celda de idempotencia ni duplica Tarjeta', () => {
  const h = backend(), daily = h.sheet('daily');
  for (let index = 0; index < 2200; index++) {
    const sale = invoice(String(index).padStart(36, '0'), 1);
    h.context.updateDailyIncome_(daily, sale, 20, sale.id);
  }
  const again = invoice(String(0).padStart(36, '0'), 1);
  h.context.updateDailyIncome_(daily, again, 20, again.id);
  assert.equal(daily.rows[1][1], 2200);
  assert.equal(daily.rows[1][13], 220000);
  assert.ok(daily.rows[1].length > 14);
  assert.ok([daily.rows[1][12], ...daily.rows[1].slice(14)].every(chunk => chunk.length <= 28000));
});

const batchOperations = () => [
  { operationId: 'create-sale', action: 'record_sale', payload: { invoice: invoice('batch-sale', 2) } },
  { operationId: 'edit-sale', action: 'edit_sale', payload: { invoice: invoice('batch-sale', 3) } },
  { operationId: 'delete-sale', action: 'delete_sale', payload: { saleId: 'batch-sale' } }
];
const boss = { id: 'boss', role: 'boss', full_name: 'Caja' };
test('un lote confirma altas, ediciones y borrados en orden y repetir la respuesta perdida no revive la venta', () => {
  const h = backend(), operations = batchOperations();
  const reply = h.context.syncSalesBatch_(operations, boss, 'token');
  assert.equal(reply.ok, true);
  assert.equal(reply.results.length, 3);
  assert.ok(reply.results.every(entry => entry.result.ok));
  for (let retry = 0; retry < 3; retry++) h.context.syncSalesBatch_(operations, boss, 'token');
  assert.equal(h.sheet('inventory').rows[1][7], 10);
  for (const key of ['sales', 'details', 'payments', 'daily']) assert.equal(h.sheet(key).rows.filter((row, i) => i && row[0]).length, 0, key);
  assert.equal(h.sheet('movements').rows.filter((row, i) => i && row[0]).length, 3);
  assert.equal(h.sheets.get('Operaciones_Sync').rows.length, 4);
});

test('recupera cada escritura interrumpida de un lote sin duplicar stock, ediciones ni devoluciones', () => {
  const reference = backend(); reference.context.syncSalesBatch_(batchOperations(), boss, 'token');
  const count = reference.writes();
  for (let failure = 1; failure <= count; failure++) {
    const h = backend(); h.faultAt(failure);
    try { h.context.syncSalesBatch_(batchOperations(), boss, 'token'); } catch (_) {}
    h.faultAt(0);
    for (let retry = 0; retry < 3; retry++) {
      const reply = h.context.syncSalesBatch_(batchOperations(), boss, 'token');
      assert.ok(reply.results.every(entry => entry.result.ok), 'receipt, fault ' + failure);
    }
    assert.equal(h.sheet('inventory').rows[1][7], 10, 'stock, fault ' + failure);
    assert.equal(h.sheet('sales').rows.filter((row, i) => i && row[0]).length, 0, 'sales, fault ' + failure);
    assert.equal(h.sheet('movements').rows.filter((row, i) => i && row[0]).length, 3, 'movements, fault ' + failure);
  }
  console.log('Escrituras del lote interrumpidas y recuperadas:', count);
});

test('un lote mantiene permisos por operación y rechaza reutilizar un ID con otro contenido', () => {
  const h = backend();
  assert.throws(() => h.context.syncSalesBatch_(batchOperations(), { id: 'admin', role: 'admin' }, 'token'));
  assert.equal(h.sheet('sales').rows.length, 1, 'Valida todo el lote antes de escribir.');
  h.context.syncSalesBatch_(batchOperations(), boss, 'token');
  const changed = batchOperations(); changed[0].payload.invoice.totals.total = 999;
  const reply = h.context.syncSalesBatch_(changed, boss, 'token');
  assert.equal(reply.results[0].result.conflict, true);
  assert.equal(reply.results[0].result.retryable, false);
});
