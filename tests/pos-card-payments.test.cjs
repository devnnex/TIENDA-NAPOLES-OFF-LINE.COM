const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SalesShift = require('../sales-shift.js');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (from, to) => {
  const start = source.indexOf('  const ' + from + ' ='), end = source.indexOf('  const ' + to + ' =', start + 1);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
};
const plain = value => JSON.parse(JSON.stringify(value));
function setup() {
  const state = { activePaymentTotal: 100, inventoryMeta: {}, invoiceHistory: [] };
  const context = vm.createContext({ state, SalesShift, normalizeText: value => String(value).toLowerCase(),
    integerMoney: Number, currencyInputNumber: input => Number(input.value), incomeRecordSaleType: () => 'table' });
  vm.runInContext(section('paymentFromForm', source.includes('  const reflectInvoiceInIncomeReport =') ? 'reflectInvoiceInIncomeReport' : 'applyInvoiceToInventory')
    + section('incomeTotalsFromRecords', 'localIncomeRecords') + section('localIncomeRecords', 'localIncomeReport')
    + ';globalThis.api={payment:paymentFromForm,totals:incomeTotalsFromRecords,records:localIncomeRecords};', context);
  return { context, state, api: context.api };
}
test('Tarjeta y mixto con Tarjeta conservan los importes y validan el saldo', () => {
  const h = setup(), form = { payment_method: { value: 'card' } };
  assert.deepEqual(plain(h.api.payment(form)), { method: 'card', payments: [{ method: 'card', amount: 100 }] });
  Object.assign(form, { payment_method: { value: 'mixed' }, mixed_method_one: { value: 'card' }, mixed_method_two: { value: 'cash' }, mixed_amount_one: { value: 60 }, mixed_amount_two: { value: 40 } });
  assert.equal(h.api.payment(form).payments[0].method, 'card');
  form.mixed_amount_two.value = 50;
  assert.equal(h.api.payment(form), null);
});
test('el KPI respeta el periodo, separa Tarjeta de efectivo y conserva datos históricos', () => {
  const h = setup();
  h.state.invoiceHistory = [
    { id: 'card-sale', createdAt: '2026-10-19T16:00:00Z', totals: { total: 100 }, paymentMethod: 'card', payments: [{ method: 'card', amount: 100 }] },
    { id: 'mixed-sale', createdAt: '2026-10-19T16:01:00Z', totals: { total: 100 }, paymentMethod: 'mixed', payments: [{ method: 'card', amount: 60 }, { method: 'cash', amount: 40 }] },
    { id: 'old-sale', createdAt: '2026-10-18T16:00:00Z', totals: { total: 500 }, paymentMethod: 'cash', payments: [{ method: 'cash', amount: 500 }] },
    { id: 'transfer-sale', createdAt: '2026-10-19T16:02:00Z', totals: { total: 200 }, payments: [{ method: 'transfer', amount: 200 }] }
  ];
  const filters = { dateFrom: '2026-10-19', dateTo: '2026-10-19', paymentMethod: 'all', saleType: 'all' };
  const totals = h.api.totals(h.api.records(filters));
  assert.equal(totals.income, 400);
  assert.equal(totals.card, 160);
  assert.equal(totals.cash, 40);
  assert.equal(totals.transfer, 200);
  assert.equal(totals.income, totals.card + totals.cash + totals.transfer + totals.breb + totals.other);
  assert.equal(h.api.records({ ...filters, paymentMethod: 'card' }).length, 2);
  assert.equal(h.state.invoiceHistory[2].paymentMethod, 'cash');
});
