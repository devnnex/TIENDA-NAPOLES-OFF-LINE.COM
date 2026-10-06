const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');

test('el login offline solo se habilita tras una entrada online y renueva el token antes de sincronizar', () => {
  assert.match(source, /await rememberOnlineLogin\(username, pin, session\)/);
  assert.match(source, /action: "verify", username, pin/);
  assert.match(source, /offlineLoginPending && !await refreshOfflineLogin\(\)/);
  assert.match(worker, /url\.pathname\.endsWith\("\/rpc\/login"\)[\s\S]*?event\.respondWith\(fetch\(request\)\)/);
});

test('el almacén local protege credenciales, rechaza PIN erróneo y olvida al usuario', async (t) => {
  const username = `tn_${randomUUID().slice(0, 12)}`;
  const pin = '436281';
  const token = `token-${randomUUID()}`;
  const vaultName = createHash('sha256').update(username).digest('hex') + '.vault';
  const vaultPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Tienda Napoles Offline', 'login-vault', vaultName);
  const port = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const number = probe.address().port;
      probe.close(() => resolve(number));
    });
  });
  const server = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'offline-server.ps1'), '-Port', String(port)
  ], { cwd: root, windowsHide: true, stdio: 'ignore' });
  const endpoint = `http://127.0.0.1:${port}/__tienda_napoles_login`;
  const send = async (payload, origin = `http://127.0.0.1:${port}`) => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json', 'X-Tienda-Napoles-Login': '1'
      }, body: JSON.stringify(payload)
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    try { await send({ action: 'forget', username }); } catch (_) {}
    server.kill();
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/__tienda_napoles_login_health`)).ok;
      if (ready) break;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true);

  const stranger = await send({ action: 'verify', username, pin });
  assert.equal(stranger.data.status, 'missing');
  const denied = await send({ action: 'enroll', username, pin, token, user: { id: 'test-id', username } }, 'http://other.example');
  assert.equal(denied.status, 403);
  const enrolled = await send({ action: 'enroll', username, pin, token, user: { id: 'test-id', username, role: 'boss', is_active: true } });
  assert.equal(enrolled.status, 200);
  const stored = fs.readFileSync(vaultPath);
  assert.equal(stored.includes(Buffer.from(pin)), false);
  assert.equal(stored.includes(Buffer.from(token)), false);

  const wrong = await send({ action: 'verify', username, pin: '999999' });
  assert.equal(wrong.data.status, 'invalid');
  const correct = await send({ action: 'verify', username, pin });
  assert.equal(correct.data.status, 'ok');
  assert.equal(correct.data.token, token);
  assert.equal(correct.data.user.id, 'test-id');
  for (let attempt = 0; attempt < 5; attempt++) {
    const invalid = await send({ action: 'verify', username, pin: '999999' });
    assert.equal(invalid.data.status, 'invalid');
  }
  const locked = await send({ action: 'verify', username, pin });
  assert.equal(locked.data.status, 'locked');
  await send({ action: 'enroll', username, pin, token, user: { id: 'test-id', username, is_active: true } });
  assert.equal((await send({ action: 'verify', username, pin })).data.status, 'ok');
  await send({ action: 'forget', username });
  assert.equal(fs.existsSync(vaultPath), false);
});
