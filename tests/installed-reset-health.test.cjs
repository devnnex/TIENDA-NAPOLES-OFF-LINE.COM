const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');

test('el iniciador reconoce el servidor con limpieza y rechaza servidores anteriores o respuestas ambiguas', async () => {
  const seen = [];
  const responses = [{status:200, body:'OK_BROWSER_RESET_V1'}, {status:404, body:'Not found'}, {status:200, body:'OK'}];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    const result = responses[seen.length - 1];
    response.writeHead(result.status, {'Content-Type':'text/plain'});
    response.end(result.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'napoles-launcher-reset-health-'));
    const scriptPath = path.join(directory, 'probe.ps1');
    fs.writeFileSync(scriptPath, `param([string]$SourcePath, [int]$Port)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($SourcePath).Replace('http://127.0.0.1:8766', ('http://127.0.0.1:' + $Port))
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Management
$method = [TiendaNapolesOffline].GetMethod('ServerSupportsBrowserReset', [Reflection.BindingFlags]'Static,NonPublic')
$results = @($method.Invoke($null, @()), $method.Invoke($null, @()), $method.Invoke($null, @()))
@{supported=$results; version=[TiendaNapolesOffline].Assembly.GetName().Version.ToString()} | ConvertTo-Json -Compress
`, 'utf8');
    const output = await new Promise((resolve, reject) => {
      const process = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-SourcePath', path.resolve(__dirname, '../packaging/TiendaNapolesOffline.cs'), '-Port', String(server.address().port)],
      {windowsHide:true, stdio:['ignore','pipe','pipe']});
      let stdout = '', stderr = '';
      process.stdout.on('data', value => {stdout += value;});
      process.stderr.on('data', value => {stderr += value;});
      process.on('error', reject);
      process.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    const result = JSON.parse(output.trim());
    assert.deepEqual(result.supported, [true,false,false]);
    assert.equal(result.version, '1.0.42.0');
    assert.deepEqual(seen, Array(3).fill('/__tienda_napoles_browser_reset_health'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
