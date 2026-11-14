const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const test = require('node:test'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');

test('clic real en ambos botones: cobro nuevo, factura antigua restaurada e intento pendiente', async () => {
  const server = http.createServer((req, res) => {
    const file = new URL(req.url, 'http://local').pathname.slice(1) || 'admin.html';
    if (file === 'admin.html') {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(fs.readFileSync(path.join(root, file), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
    } else if (['style.css', 'menu-cards.css'].includes(file)) {
      res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, file)));
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    for (const scenario of ['fresh', 'restored', 'pending']) for (const action of ['save', 'print']) {
      const context = await browser.newContext(), page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://**/*', route => route.fulfill({ status: 503, body: 'test-network-disabled' }));
      await page.goto('http://127.0.0.1:' + server.address().port + '/admin.html');
      await page.addScriptTag({ path: path.join(root, 'sales-shift.js') });
      const code = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/webAppUrl:\s*"[^"]*"/, 'webAppUrl: ""')
        .replace('  return { init };', '  return { init, state, bindAdmin, openPaymentDialog, saveCheckoutIntent, readLocalJson };')
        .replace('document.addEventListener("DOMContentLoaded", App.init);', 'window.buttonApi = App;');
      await page.addScriptTag({ content: code });
      await page.evaluate(async scenario => {
        document.body.classList.add('admin-authenticated');
        window.closes = 0; window.prints = 0; window.popups = 0; window.receiptHtml = '';
        window.open = () => { popups++; return { closed: false, document: { open() {}, write(html) { receiptHtml = html; }, close() {} },
          requestAnimationFrame(fn) { fn(); }, focus() {}, print() { prints++; }, close() {} }; };
        const session = { id: 'a0100000-0000-4000-8000-000000000003', table_id: 'table-3', status: 'open', sale_channel: 'table',
          payer_name: 'Prueba', session_payments: [], session_items: [{ id: 'line-3', menu_item_id: 'product-3', item_name: 'Agua', quantity: 2, unit_price: 100, status: 'served' }] };
        const invoice = { id: session.id, sessionId: session.id, number: 'TN-original', table: 'Mesa 3',
          createdAt: '2026-11-12T17:00:00Z', items: session.session_items.map(row => ({ ...row, id: 'historic-report-row' })),
          payments: [{ method: 'cash', amount: 200 }], totals: { subtotal: 200, total: 200 }, checkoutAccepted: true };
        Object.assign(buttonApi.state, { page: 'admin', currentUser: { id: 'boss', role: 'boss', full_name: 'Caja' }, authToken: 'test',
          business: { business_name: 'Tienda Nápoles', tips_enabled: false }, activeAdminSection: 'service',
          tables: [{ id: 'table-3', table_name: 'Mesa 3', table_number: 3, is_active: true }], sessions: [session],
          items: [{ id: 'product-3', name: 'Agua', price: 100, is_available: true }],
          inventoryMeta: { 'product-3': { stock: scenario === 'restored' ? 8 : 10, costPrice: 20 } },
          invoiceHistory: scenario === 'restored' ? [invoice] : [], posFeatures: { abonos: true }, requests: [] });
        let remote = structuredClone(session);
        buttonApi.state.sb = {
          rpc: async (name, payload) => {
            if (name === 'replay_table_session_change') { closes++; remote = { ...remote, ...payload.p_patch }; return { data: { session: remote } }; }
            return { data: { ok: true } };
          },
          from(table) { return { update() { return this; }, eq() { return this; }, select() { return this; }, maybeSingle() { return this; },
            then(resolve) { return Promise.resolve({ data: table === 'table_sessions' ? structuredClone(remote) : [] }).then(resolve); } }; }
        };
        if (scenario === 'pending') await buttonApi.saveCheckoutIntent(invoice, structuredClone(session), 0, 'prepared');
        buttonApi.bindAdmin(); buttonApi.openPaymentDialog(session.id);
      }, scenario);
      await page.locator('#paymentForm button[value="' + action + '"]').click();
      let completed = true;
      try { await page.waitForFunction(() => buttonApi.state.invoiceHistory.length === 1 && !buttonApi.state.paymentProcessing && !document.querySelector('#paymentDialog').open, { timeout: 5000 }); }
      catch { completed = false; }
      const result = await page.evaluate(() => ({ closes, prints, popups, invoices: buttonApi.state.invoiceHistory.length,
        sessions: buttonApi.state.sessions.length, stock: buttonApi.state.inventoryMeta['product-3'].stock,
        processing: buttonApi.state.paymentProcessing, dialog: document.querySelector('#paymentDialog').open,
        receiptPaid: receiptHtml.includes('PAGADO'), text: document.body.innerText.slice(-2000) }));
      assert.equal(completed, true, scenario + '/' + action + ': ' + JSON.stringify(result));
      assert.equal(result.closes, 1, scenario + '/' + action);
      assert.equal(result.invoices, 1);
      assert.equal(result.sessions, 0);
      assert.equal(result.stock, 8, 'No repite el descuento de inventario: ' + scenario);
      assert.equal(result.prints, action === 'print' ? 1 : 0);
      assert.equal(result.popups, action === 'print' ? 1 : 0);
      if (action === 'print') assert.equal(result.receiptPaid, true);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
