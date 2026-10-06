const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const request = (port, method, headers = {}, body) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: '/__tienda_napoles_drawer', method, headers }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (part) => { text += part; });
    res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end(body);
});

test('el modal separa la lista de productos de los botones', () => {
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assert.match(css, /#consumptionDialog \.product-combobox\.is-open \.product-combobox-options\s*\{\s*position: static;/);
  assert.match(css, /#consumptionDialog \.modal-actions\s*\{\s*position: static;/);
});

test('el servidor local enumera impresoras y rechaza solicitudes ajenas sin activar ninguna caja', async (t) => {
  const freePort = await new Promise((resolve) => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const server = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'offline-server.ps1'), '-Port', String(freePort)
  ], { cwd: root, windowsHide: true, stdio: 'ignore' });
  t.after(() => server.kill());
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${freePort}/__tienda_napoles_drawer_health`);
      ready = response.ok;
      if (ready) break;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'el servidor de prueba debe iniciar');

  const appHeaders = { 'X-Tienda-Napoles-Drawer': '1', Referer: `http://127.0.0.1:${freePort}/admin.html` };
  const list = await request(freePort, 'GET', appHeaders);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.printers));

  const rejected = await request(freePort, 'POST', {
    'X-Tienda-Napoles-Drawer': '1', Origin: 'http://otro-sitio.example', 'Content-Type': 'application/json'
  }, JSON.stringify({ printer: 'ninguna', pin: 0 }));
  assert.equal(rejected.status, 403);

  const unknown = await request(freePort, 'POST', {
    'X-Tienda-Napoles-Drawer': '1', Origin: `http://127.0.0.1:${freePort}`, 'Content-Type': 'application/json'
  }, JSON.stringify({ printer: 'impresora-inexistente-de-prueba', pin: 0 }));
  assert.equal(unknown.status, 503);
});
