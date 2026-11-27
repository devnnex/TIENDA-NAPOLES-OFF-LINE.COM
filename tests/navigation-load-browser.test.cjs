const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');

test('catalogo y propinas grandes ceden el hilo, pausan al salir y conservan filas al volver', async () => {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://local').pathname.slice(1);
    if (name === 'admin.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(fs.readFileSync(path.join(root, name), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
    } else if (['style.css', 'menu-cards.css'].includes(name)) {
      response.setHeader('Content-Type', 'text/css'); response.end(fs.readFileSync(path.join(root, name)));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
    await page.addScriptTag({ path: path.join(root, 'sales-shift.js') });
    const vendorRoots = [path.join(root, 'vendor'), path.join(root, '..', 'TIENDA-NAPOLES-OFF-LINE.COM', 'vendor')];
    for (const name of ['lucide.min.js', 'qrcode.min.js']) {
      const vendor = vendorRoots.map(directory => path.join(directory, name)).find(fs.existsSync);
      if (vendor) await page.addScriptTag({ path: vendor });
    }
    await page.addScriptTag({ content: source.replace('  return { init };', '  return { init, state, showAdminSection, renderMenuManager, renderTips, renderGeneratedTableQrs, paintRowsProgressively, cachedQrDataUrl };').replace('document.addEventListener("DOMContentLoaded", App.init);', 'window.navigationApi = App;') });
    const first = await page.evaluate(() => {
      window.fetch = async () => new Promise(() => {});
      document.body.classList.add('admin-authenticated');
      // Some deployments hide the optional menu editor in HTML comments.
      // Exercise the shared renderer with its real list containers present.
      if (!document.querySelector('#itemList')) {
        const editor = document.createElement('section'); editor.dataset.adminSection = 'menu';
        editor.innerHTML = '<div id="categoryList"></div><div id="itemList"></div>';
        document.body.append(editor);
      }
      const state = navigationApi.state;
      Object.assign(state, { page: 'admin', currentUser: { id: 'boss', role: 'boss' }, business: { business_name: 'Prueba' }, tipSettings: { enabled: true, percentage: 10 } });
      state.categories = Array.from({ length: 12 }, (_, i) => ({ id: 'c' + i, name: 'Categoria ' + i, is_active: true }));
      state.items = Array.from({ length: 1500 }, (_, i) => ({ id: 'p' + i, category_id: 'c' + (i % 12), name: 'Producto ' + i, price: 100, is_active: true, is_available: true }));
      state.inventoryMeta = Object.fromEntries(state.items.map(item => [item.id, { stock: 1000, costPrice: 40, unit: 'unidad' }]));
      state.tables = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i, table_number: i + 1, qr_code: 'mesa-' + (i + 1), is_active: true }));
      state.invoiceHistory = Array.from({ length: 600 }, (_, i) => ({ id: 'sale-' + i, number: 'TN-' + i, createdAt: new Date().toISOString(), table: 'Mesa 1', waiterName: 'Caja', tipAmount: 10, totals: { total: 110, tip: 10 } }));
      const start = performance.now(); navigationApi.showAdminSection('menu');
      const elapsed = performance.now() - start;
      const count = document.querySelectorAll('#itemList .product-manager-row').length;
      navigationApi.showAdminSection('dashboard');
      return { elapsed, count };
    });
    assert.ok(first.count > 0 && first.count < 1500, 'El clic dibuja una primera tanda y devuelve el control');
    assert.ok(first.elapsed < 250, `El clic mantuvo el hilo ocupado ${first.elapsed} ms`);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#itemList .product-manager-row').count(), first.count, 'Un catalogo oculto pausa sus filas');
    await page.evaluate(() => navigationApi.showAdminSection('menu'));
    await page.waitForFunction(() => document.querySelectorAll('#itemList .product-manager-row').length === 1500);
    await page.waitForFunction(() => document.querySelectorAll('[data-table-qr] img').length === 60);
    const cached = await page.evaluate(() => {
      const first = document.querySelector('#itemList').firstElementChild;
      navigationApi.renderMenuManager();
      return document.querySelector('#itemList').firstElementChild === first;
    });
    assert.equal(cached, true, 'El catalogo sin cambios conserva el DOM');
    await page.evaluate(() => navigationApi.showAdminSection('tips'));
    await page.waitForFunction(() => document.querySelectorAll('#tipsRecords .tip-record').length === 600);
    const repeated = await page.evaluate(() => {
      const box = document.querySelector('#tipsRecords'), first = box.firstElementChild;
      for (let i = 0; i < 50; i++) navigationApi.renderTips();
      return box.firstElementChild === first;
    });
    assert.equal(repeated, true, 'Cincuenta actualizaciones identicas conservan las propinas dibujadas');
    const cycles = await page.evaluate(() => {
      const durations = [];
      for (let i = 0; i < 15; i++) for (const section of ['dashboard', 'menu', 'tips']) {
        const start = performance.now(); navigationApi.showAdminSection(section); durations.push(performance.now() - start);
      }
      return { max: Math.max(...durations), pending: navigationApi.paintRowsProgressively.pending.size };
    });
    assert.ok(cycles.max < 250, `Una navegacion repetida ocupo ${cycles.max} ms`);
    assert.ok(cycles.pending <= 3, 'Las tareas pausadas no se acumulan por cada navegacion');
    assert.deepEqual(errors, []);
    console.log('Carga de navegacion:', JSON.stringify({ firstClickMs: Math.round(first.elapsed), repeatedMaxMs: Math.round(cycles.max), products: 1500, tables: 60, tips: 600, cycles: 15 }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
