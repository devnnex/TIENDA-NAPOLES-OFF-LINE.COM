const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'app.js'), 'utf8')
  .replace('  return { init };', '  return { init, state, commitCheckout, mergeOptimisticSessions, hydrateDurableKey, persistDurableJson, loadInventoryStore };')
  .replace('document.addEventListener("DOMContentLoaded", App.init);', 'window.checkoutApi = App;');

test('IndexedDB real conserva el cierre tras recargar y al abrir otra ventana de la app', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body data-page="admin"></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const url = 'http://127.0.0.1:' + server.address().port;
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.addScriptTag({ path: path.join(root, 'sales-shift.js') });
      await page.addScriptTag({ content: code });
      await page.evaluate(async () => {
        const session = { id: 'account-3', table_id: 'table-3', status: 'open', session_payments: [],
          session_items: [{ id: 'line-3', item_name: 'Agua', quantity: 2, unit_price: 100, status: 'served' }] };
        const invoice = { id: session.id, sessionId: session.id, createdAt: '2026-11-12T17:00:00Z',
          totals: { subtotal: 200, total: 200 }, items: session.session_items, payments: [{ method: 'cash', amount: 200 }] };
        const { state } = checkoutApi;
        Object.assign(state, { page: 'admin', sessions: [session], invoiceHistory: [invoice], inventoryMeta: {}, inventoryMovements: [], requests: [], business: {} });
        if (!await checkoutApi.commitCheckout({ session, invoice, paid: 0, stage: 'closed' })) throw Error('checkout failed');
        if (state.sessions.length) throw Error('account remains open');
      });
      for (const reopen of ['reload', 'new-window']) {
        const current = reopen === 'reload' ? page : await context.newPage();
        if (reopen === 'reload') await current.reload(); else await current.goto(url);
        await current.addScriptTag({ path: path.join(root, 'sales-shift.js') });
        await current.addScriptTag({ content: code });
        const result = await current.evaluate(async () => {
          for (const key of ['napoles_checkout_closures_v1', 'tienda_napoles_invoices_v1', 'tienda_napoles_inventory_v1']) await checkoutApi.hydrateDurableKey(key);
          checkoutApi.state.business = {};
          checkoutApi.loadInventoryStore();
          const stale = { id: 'account-3', table_id: 'table-3', status: 'open', session_payments: [],
            session_items: [{ id: 'line-3', item_name: 'Agua', quantity: 2, unit_price: 100, status: 'served' }] };
          const fresh = { ...stale, id: 'new-account-3' };
          return { stale: checkoutApi.mergeOptimisticSessions([stale]).length,
            active: checkoutApi.mergeOptimisticSessions([stale, fresh]).map(row => row.id),
            invoices: checkoutApi.state.invoiceHistory.length,
            accepted: checkoutApi.state.invoiceHistory[0]?.checkoutAccepted };
        });
        assert.deepEqual(result, { stale: 0, active: ['new-account-3'], invoices: 1, accepted: true }, width + '/' + reopen);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
