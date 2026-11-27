const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');

test('2500 compras permiten filtrar durante el pintado sin mezclar filas y conservan el editor de costo', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(root, 'admin.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
    await page.addScriptTag({ path: path.join(root, 'sales-shift.js') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'app.js'), 'utf8')
      .replace('  return { init };', '  return { init, state, renderPurchaseHistory, purchaseMovements };')
      .replace('document.addEventListener("DOMContentLoaded", App.init);', 'window.reportApi=App;') });
    const measurements = await page.evaluate(() => {
      const state = reportApi.state;
      Object.assign(state, { page: 'admin', currentUser: { id: 'boss', role: 'boss' }, businessTimeZone: 'America/Bogota',
        purchaseProductFilter: 'all', purchaseSearch: '', purchaseDateFrom: '2026-11-27', purchaseDateTo: '2026-11-27' });
      state.inventoryMovements = Array.from({ length: 2500 }, (_, i) => ({ movementId: 'm' + i, productId: 'p', product: i === 0 ? 'Unico' : 'Agua',
        date: '2026-11-27T20:00:00Z', type: 'ENTRADA_UNIDADES', delta: 2, unitCost: 100, user: 'Caja' }));
      document.querySelector('#purchaseHistoryDialog').showModal();
      const start = performance.now();
      reportApi.renderPurchaseHistory();
      const first = performance.now() - start;
      const firstCount = document.querySelectorAll('.purchase-record').length;
      state.purchaseSearch = 'Unico';
      const filterStart = performance.now();
      reportApi.renderPurchaseHistory();
      return { first, firstCount, filter: performance.now() - filterStart };
    });
    assert.ok(measurements.firstCount > 0 && measurements.firstCount < 2500, 'El primer clic pinta un lote y devuelve el control');
    assert.ok(measurements.first < 250, 'La primera respuesta no bloquea 250 ms: ' + JSON.stringify(measurements));
    assert.ok(measurements.filter < 150, 'Filtrar no bloquea 150 ms: ' + JSON.stringify(measurements));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.purchase-record').count(), 1, 'Los lotes de la consulta anterior no se agregan');
    assert.equal(await page.locator('.purchase-record').getAttribute('data-purchase-record'), 'm0');
    assert.equal(await page.locator('[data-purchase-unit-cost]').getAttribute('data-currency-bound'), 'true');
    await page.locator('[data-purchase-unit-cost]').fill('2500');
    assert.match(await page.locator('[data-purchase-unit-cost]').inputValue(), /2[.,]500/);
    const totals = await page.locator('#purchaseSummary').textContent();
    assert.match(totals, /200/);
    assert.match(totals, /1 registro/);
    await page.evaluate(() => {
      reportApi.state.purchaseSearch = '';
      reportApi.renderPurchaseHistory();
      document.querySelector('#purchaseHistoryDialog').close();
    });
    await page.waitForTimeout(50);
    const stopped = await page.locator('.purchase-record').count();
    assert.ok(stopped < 2500, 'Cerrar Compras cancela el trabajo restante');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.purchase-record').count(), stopped, 'No sigue construyendo filas en el dialogo cerrado');
    await page.evaluate(() => {
      reportApi.state.purchaseSearch = 'Unico';
      document.querySelector('#purchaseHistoryDialog').showModal();
      reportApi.renderPurchaseHistory();
    });
    assert.equal(await page.locator('.purchase-record').count(), 1, 'Se puede reabrir y consultar de nuevo');
    assert.deepEqual(errors, []);
    console.log('2500 compras, respuesta inicial y filtro (ms):', JSON.stringify(measurements));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
