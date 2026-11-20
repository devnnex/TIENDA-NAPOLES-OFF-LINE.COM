const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
async function launch(){
 const port=await freePort(),dataDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'napoles-reset-test-'));
 const server=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'offline-server.ps1'),'-Port',String(port)],{windowsHide:true,env:{...process.env,LOCALAPPDATA:dataDirectory},stdio:'ignore'});
 const origin='http://127.0.0.1:'+port;
 const deadline=Date.now()+15000;
 while(true){try{if((await fetch(origin+'/__tienda_napoles_health')).ok)break;}catch{}if(Date.now()>deadline)throw new Error('server_start_failed');await new Promise(resolve=>setTimeout(resolve,100));}
 const browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 return {origin,dataDirectory,browser,async close(){await browser.close();server.kill();}};
}
async function boot(session){
 const health=await fetch(session.origin+'/__tienda_napoles_browser_reset_health');
 assert.equal(health.status,200);assert.equal(await health.text(),'OK_BROWSER_RESET_V1');
 const context=await session.browser.newContext(),page=await context.newPage();
 await page.goto(session.origin+'/manifest.webmanifest');
 await page.addScriptTag({path:path.join(root,'offline-login-reset.js')});
 await context.addCookies([{name:'secret',value:'test-cookie',url:session.origin,httpOnly:true}]);
 await page.evaluate(async()=>{
  localStorage.setItem('inventory','{"stock":7}');sessionStorage.setItem('token','keep-current-login');
  localStorage.setItem('tienda_napoles_walk_in_drafts_v1','[{"id":"pending-sale"}]');
  const cache=await caches.open('obsolete-app-assets');await cache.put('/old.js',new Response('old'.repeat(100000)));
  const database=await new Promise((resolve,reject)=>{
   const request=indexedDB.open('tienda-napoles-offline-sync-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('entries',{keyPath:'id'});
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  await new Promise((resolve,reject)=>{const tx=database.transaction('entries','readwrite');tx.objectStore('entries').put({id:'queued-sale',status:'pending',payload:{quantity:2}});tx.oncomplete=resolve;tx.onerror=reject;});database.close();
 });
 return {context,page};
}
test('Vaciado real con Clear-Site-Data: cookies, cachés, workers y bases; recupera pendientes sin perder sesión',async()=>{
 const session=await launch();try{
  const {context,page}=await boot(session);
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/__tienda_napoles_browser_reset') && response.request().postDataJSON()?.version===1);
  const result=await page.evaluate(()=>OfflineLoginReset.reset());
  const response=await responsePromise;
  assert.equal(response.status(),200,JSON.stringify({result,body:await response.text()}));
  assert.equal((await response.allHeaders())['clear-site-data'],'"cache", "cookies", "storage"');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.verifiedEmpty,true);
  assert.deepEqual(await context.cookies(),[]);
  assert.deepEqual(await page.evaluate(()=>caches.keys()),[]);
  assert.equal(await page.evaluate(()=>localStorage.getItem('inventory')),'{"stock":7}');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('token')),'keep-current-login');
  assert.match(await page.evaluate(()=>localStorage.getItem('tienda_napoles_walk_in_drafts_v1')),/pending-sale/);
  assert.equal(await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('tienda-napoles-offline-sync-v1');r.onsuccess=()=>resolve(r.result);});try{return await new Promise(resolve=>{const r=db.transaction('entries').objectStore('entries').get('queued-sale');r.onsuccess=()=>resolve(r.result.status);});}finally{db.close();}}),'pending');
  assert.ok(fs.statSync(path.join(session.dataDirectory,'TiendaNapolesOffline/browser-reset-backups/before-login.bin')).size>0);
  assert.equal((await page.evaluate(()=>OfflineLoginReset.reset())).ok,true,'Cada acceso puede repetir la limpieza');
  await context.close();
 }finally{await session.close();}
});
test('Si falla el respaldo local, no se borra ningún dato del navegador',async()=>{
 const session=await launch();try{
  const {context,page}=await boot(session);
  await page.route('**/__tienda_napoles_browser_reset',route=>route.fulfill({status:503,body:'backup failed'}));
  const result=await page.evaluate(()=>OfflineLoginReset.reset());
  assert.equal(result.ok,false);assert.equal(await page.evaluate(()=>localStorage.getItem('inventory')),'{"stock":7}');
  assert.deepEqual(await page.evaluate(()=>caches.keys()),['obsolete-app-assets']);assert.equal((await context.cookies()).length,1);
  await context.close();
 }finally{await session.close();}
});

test('Un cierre después del borrado recupera el respaldo cifrado al abrir de nuevo',async()=>{
 const session=await launch();try{
  const {context,page}=await boot(session);
  const response=await page.evaluate(async()=>{
   const data={version:1,origin:location.origin,local:{inventory:localStorage.getItem('inventory')},session:{token:sessionStorage.getItem('token')},
    databases:[{name:'recovery-test',version:1,stores:[{name:'records',keyPath:'id',autoIncrement:false,indexes:[],keys:['invoice'],values:[{id:'invoice',amount:12000}]}]}]};
   const response=await fetch('/__tienda_napoles_browser_reset',{method:'POST',headers:{'Content-Type':'application/json','X-Tienda-Napoles-Reset':'1'},body:JSON.stringify(data)});
   return response.json();
  });
  assert.equal(response.backupSaved,true);assert.equal(await page.evaluate(()=>localStorage.length),0);
  await page.close();const next=await context.newPage();await next.goto(session.origin+'/manifest.webmanifest');
  await next.addScriptTag({path:path.join(root,'offline-login-reset.js')});
  assert.deepEqual(await next.evaluate(()=>OfflineLoginReset.recover()),{ok:true,recovered:true});
  assert.equal(await next.evaluate(()=>localStorage.getItem('inventory')),'{"stock":7}');
  assert.equal(await next.evaluate(()=>sessionStorage.getItem('token')),'keep-current-login');
  assert.equal(fs.existsSync(path.join(session.dataDirectory,'TiendaNapolesOffline/browser-reset-backups/recovery-pending.txt')),false);
  await context.close();
 }finally{await session.close();}
});

test('La limpieza con service worker real elimina el registro; otra ventana abierta impide borrar sus datos',async()=>{
 const session=await launch();try{
  const {context,page}=await boot(session);
  await page.evaluate(async()=>{
   await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready;
   if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
  });
  const other=await context.newPage();await other.goto(session.origin+'/manifest.webmanifest');
  assert.equal((await page.evaluate(()=>OfflineLoginReset.reset())).reason,'other_windows_open');
  assert.equal(await page.evaluate(()=>localStorage.getItem('inventory')),'{"stock":7}');
  await other.close();
  const result=await page.evaluate(()=>OfflineLoginReset.reset());assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0);
  await context.close();
 }finally{await session.close();}
});

test('El reinicio usado por el login conserva al usuario y entrega de nuevo el control al service worker',async()=>{
 const session=await launch();try{
  const {context,page}=await boot(session);
  await page.evaluate(async()=>{
   const db=await new Promise(resolve=>{const request=indexedDB.open('tienda-napoles-offline-sync-v1');request.onsuccess=()=>resolve(request.result);});
   await new Promise(resolve=>{const tx=db.transaction('entries','readwrite');tx.objectStore('entries').clear();tx.oncomplete=resolve;});db.close();
  });
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8').replace('  return { init };','  return { init, state, resetOfflineBrowserOnLogin };').replace('document.addEventListener("DOMContentLoaded", App.init);','window.resetApi=App;');
  await page.addScriptTag({content:source});
  const result=await page.evaluate(async()=>{
   Object.assign(resetApi.state,{page:'admin',authToken:'new-login-token',currentUser:{id:'test-user',role:'boss'}});
   const ok=await resetApi.resetOfflineBrowserOnLogin();
   return {ok,user:resetApi.state.currentUser.id,token:sessionStorage.getItem('la_licorera_17_admin_token'),controlled:Boolean(navigator.serviceWorker.controller),resetting:resetApi.state.loginStorageResetting};
  });
  assert.deepEqual(result,{ok:true,user:'test-user',token:'new-login-token',controlled:true,resetting:false});
  await context.close();
 }finally{await session.close();}
});
