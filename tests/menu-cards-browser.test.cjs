const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..'),chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
test('Carta: carga múltiple, confirmación, persistencia entre dispositivos, reemplazo, orden, mesas y visor móvil',async()=>{
 const records=new Map(),objects=new Map(),calls=[];let lostResponse=false,failUpload=false,allowed=true;
 const tables=[{id:'a',table_number:1,qr_code:'qr-a',is_active:true},{id:'b',table_number:2,qr_code:'qr-b',is_active:true}];
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/image/')){const buffer=objects.get(decodeURIComponent(url.pathname.slice(7)));res.writeHead(buffer?200:404,{'Content-Type':'image/png'});res.end(buffer);return;}
  if(url.pathname==='/admin'){const form=fs.readFileSync(path.join(root,'admin.html'),'utf8').match(/<form class="form-grid" id="businessForm">[\s\S]*?<\/form>/)?.[0];assert.ok(form);res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/menu-cards.css"><main><section id="brand">'+form+'</section></main><script src="/menu-cards.js"></script>');return;}
  if(url.pathname==='/client'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));return;}
  const file=url.pathname.slice(1);if(!['style.css','menu-cards.css','menu-cards.js'].includes(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(root,file)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 const backend=async(op,arg)=>{
  calls.push([op,arg]);
  if(op==='upload'){if(failUpload)return {error:{message:'Red interrumpida'}};if(objects.has(arg.path))return {error:{statusCode:'409'}};objects.set(arg.path,Buffer.from(arg.bytes));return {};}
  if(op==='sign')return objects.has(arg)?{data:{signedUrl:`${origin}/image/${encodeURIComponent(arg)}`}}:{error:{message:'Ausente'}};
  if(op==='remove'){arg.forEach(p=>objects.delete(p));return {};}
  const {name,args}=arg;
  if(name!=='pos_get_menu_cards' && !allowed)return {error:{message:'No tienes permiso'}};
  const sorted=()=>[...records.values()].sort((a,b)=>a.sort_order-b.sort_order);
  if(name==='pos_list_menu_cards')return {data:sorted()};
  if(name==='pos_save_menu_card'){
   const old=records.get(args.p_id),entry={id:args.p_id,name:args.p_name,image_path:args.p_image_path,all_tables:args.p_all_tables,table_ids:args.p_table_ids,version:(old?.version||0)+1,sort_order:old?.sort_order??records.size};
   records.set(entry.id,entry);if(lostResponse){lostResponse=false;return {error:{message:'Se perdió la respuesta'}};}return {data:entry};
  }
  if(name==='pos_get_menu_cards')return {data:sorted().filter(c=>c.all_tables||c.table_ids.includes(args.p_table_id))};
  if(name==='pos_delete_menu_card'){records.delete(args.p_id);return {data:{ok:true}};}
  if(name==='pos_reorder_menu_cards'){args.p_ids.forEach((id,index)=>records.get(id).sort_order=index);return {data:{ok:true}};}
  throw Error(name);
 };
 const setup=async(page,admin)=>{
  await page.exposeFunction('menuBackend',backend);
  await page.goto(origin+(admin?'/admin':'/client'));
  if(!admin)await page.addScriptTag({path:path.join(root,'menu-cards.js')});
  await page.evaluate(({admin,tables})=>{
   window.currentMenuTable=tables[0];
   const sb={rpc:(name,args)=>menuBackend('rpc',{name,args}),storage:{from:bucket=>{
    if(bucket!=='pos-menu-cards')throw Error('Bucket inesperado');return {
     upload:async(path,file)=>menuBackend('upload',{path,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))}),
     createSignedUrl:path=>menuBackend('sign',path),remove:paths=>menuBackend('remove',paths)};
   }}};
   MenuCards.init({page:admin?'admin':'client',sb,getAuthToken:()=> 'brand',getTables:()=>tables,getCurrentTable:()=>currentMenuTable,canManage:()=>true,confirm:async()=>true});
  },{admin,tables});
  if(admin)await page.waitForFunction(()=>document.querySelector('#menuCardLibrary').dataset.loaded==='true');
 };
 const openEditor=async page=>{
  if(await page.locator('#menuCardsEditor').evaluate(n=>n.open))await page.locator('#closeMenuCardsEditor').click();
  await page.locator('#menuLibraryStack button').first().click();
  await page.waitForFunction(()=>document.querySelector('#menuCardsEditor').open && document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');
 };
 const fixture=async(page,color,name)=>({name,mimeType:'image/png',buffer:Buffer.from(await page.evaluate(color=>{const canvas=document.createElement('canvas');canvas.width=600;canvas.height=1000;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,600,1000);ctx.fillStyle='black';ctx.font='32px sans-serif';ctx.fillText('Carta de prueba · $ 12.500',20,100);return canvas.toDataURL().split(',')[1];},color),'base64')});
 try{
  const admin=await browser.newPage();await setup(admin,true);
  const first=await fixture(admin,'#eef4ff','Bebidas.png'),second=await fixture(admin,'#fff4ed','Comidas.png'),replacement=await fixture(admin,'#e3f8ec','Nueva.png');
  await admin.locator('#menuCardsUpload').setInputFiles([first,second]);
  await admin.waitForFunction(()=>document.querySelectorAll('[data-menu-card]').length===2 && document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');
  assert.equal(records.size,2);assert.equal(objects.size,2);assert.ok([...records.values()].every(card=>card.all_tables && card.table_ids.length===0),"Cada carta nueva queda disponible para todas las mesas por defecto.");
  assert.equal(await admin.locator('#menuCardsUpload').isDisabled(),true);
  assert.equal(await admin.locator('details.menu-cards-admin, #menuCardsReload').count(),0);
  assert.equal(await admin.locator('#menuCardsEditor').isVisible(),false);
  await openEditor(admin);assert.equal(await admin.locator('.menu-card-preview:visible').count(),2);
  await admin.locator('#closeMenuCardsEditor').click();
  assert.equal(await admin.locator('#menuLibraryCount').textContent(),'2/2');
  assert.equal(await admin.locator('#menuLibraryProgress').getAttribute('value'),'2');
  assert.equal(await admin.locator('#menuLibraryStack [data-menu-library-image]').count(),2);
  const layout=await admin.evaluate(()=>{const tile=document.querySelector('#menuCardLibrary').getBoundingClientRect(),save=document.querySelector('#saveBusinessBrand').getBoundingClientRect(),cover=document.querySelector('[data-upload-box="cover_url"]').getBoundingClientRect();return {tile:{x:tile.x,y:tile.y,right:tile.right},save:{x:save.x,y:save.y},cover:{x:cover.x,y:cover.y}};});
  assert.ok(layout.cover.x<layout.tile.x && layout.tile.right<=layout.save.x,'Guardar marca debe quedar a la derecha de Cartas');
  assert.ok(Math.abs(layout.tile.y-layout.save.y)<8 && Math.abs(layout.cover.y-layout.tile.y)<3,'Logo, Portada, Carta y Guardar permanecen en la misma fila');
  if(process.env.POS_QA_ARTIFACTS){fs.mkdirSync(process.env.POS_QA_ARTIFACTS,{recursive:true});await admin.locator('#businessForm').screenshot({path:path.join(process.env.POS_QA_ARTIFACTS,'marca-cartas-fila.png')});}
  await admin.setViewportSize({width:375,height:812});
  assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'La fila de Marca se adapta al móvil sin desbordarse');
  assert.equal(await admin.evaluate(()=>document.querySelector('#saveBusinessBrand').getBoundingClientRect().top>=document.querySelector('#menuCardLibrary').getBoundingClientRect().bottom),true);
  await admin.setViewportSize({width:1280,height:720});
  await admin.locator('#menuCardsUpload').setInputFiles(first);await admin.waitForFunction(()=>document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');assert.equal(records.size,2);
  // Segundo contexto de navegador: no comparte almacenamiento con la administración.
  const clientContext=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
  const client=await clientContext.newPage();await setup(client,false);
  await client.locator('#openMenuCards').click();await client.locator('#menuViewerImage').waitFor({state:'visible'});
  assert.equal(await client.locator('#menuViewerTitle').textContent(),'Bebidas');assert.equal(await client.locator('#menuViewerCounter').textContent(),'1 de 2');
  await client.locator('#menuViewerNext').click();await client.waitForFunction(()=>document.querySelector('#menuViewerTitle').textContent==='Comidas'&&!document.querySelector('#menuViewerImage').hidden);
  await client.locator('#menuViewerZoom').click();await client.waitForFunction(()=>document.querySelector('#menuViewerImage').style.transform.includes('scale(2.5)'));assert.equal(await client.locator('#menuViewerZoom').getAttribute('aria-pressed'),'true');
  assert.equal(await client.locator('#menuViewerImage').evaluate(n=>Math.abs(n.width/n.height-n.naturalWidth/n.naturalHeight)<.01),true);
  await client.locator('#menuViewerZoom').click();await client.locator('#menuViewerClose').click();assert.equal(await client.locator('#openMenuCards').evaluate(n=>n===document.activeElement),true);
  assert.equal(await client.locator('[data-request=waiter]').count(),1);assert.equal(await client.locator('[data-request=bill]').count(),1);
  // Edita nombre, asignación y orden sin tocar las mesas reales.
  await openEditor(admin);let row=admin.locator('[data-menu-card]').first();await row.locator('[data-menu-name]').fill('Bebidas de afuera');await row.locator('[data-menu-all]').uncheck();await row.locator('[data-menu-table][value=a]').check();
  await row.locator('[data-menu-action=save]').click();await admin.waitForFunction(()=>document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');
  row=admin.locator('[data-menu-card]').first();await row.locator('[data-menu-action=down]').click();await admin.waitForFunction(()=>document.querySelector('[data-menu-name]').value==='Comidas'&&document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');
  row=admin.locator('[data-menu-card]').last();await row.locator('[data-menu-replace]').setInputFiles(replacement);await admin.waitForFunction(()=>document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');
  assert.equal(objects.size,2);assert.equal(records.size,2);
  await client.reload();await client.addScriptTag({path:path.join(root,'menu-cards.js')});
  // Recargar el documento restablece el módulo y lee nuevamente el servidor.
  await client.evaluate(({tables})=>{window.currentMenuTable=tables[1];const sb={rpc:(name,args)=>menuBackend('rpc',{name,args}),storage:{from:()=>({createSignedUrl:p=>menuBackend('sign',p)})}};MenuCards.init({page:'client',sb,getCurrentTable:()=>currentMenuTable});},{tables});
  await client.locator('#openMenuCards').click();await client.locator('#menuViewerImage').waitFor({state:'visible'});assert.equal(await client.locator('#menuViewerCounter').textContent(),'1 de 1');assert.equal(await client.locator('#menuViewerTitle').textContent(),'Comidas');
  assert.equal(await client.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await client.locator('#menuViewerClose').click();
  await admin.reload();await admin.evaluate(({tables})=>{const sb={rpc:(name,args)=>menuBackend('rpc',{name,args}),storage:{from:()=>({createSignedUrl:p=>menuBackend('sign',p),remove:p=>menuBackend('remove',p),upload:async(path,file)=>menuBackend('upload',{path,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))})})}};MenuCards.init({page:'admin',sb,getAuthToken:()=> 'brand',getTables:()=>tables,canManage:()=>true,confirm:async()=>true});},{tables});
  await admin.waitForFunction(()=>document.querySelector('#menuCardLibrary').dataset.loaded==='true');await openEditor(admin);await admin.waitForFunction(()=>document.querySelectorAll('[data-menu-card]').length===2);
  await admin.locator('[data-menu-card]').last().locator('[data-menu-action=delete]').click();await admin.waitForFunction(()=>document.querySelectorAll('[data-menu-card]').length===1&&document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');assert.equal(records.size,1);assert.equal(objects.size,1);
  // Un archivo falso y un fallo de red no se presentan como publicados.
  await admin.locator('#menuCardsUpload').setInputFiles({name:'falsa.png',mimeType:'image/png',buffer:Buffer.from('<svg onload="alert(1)">')});await admin.waitForFunction(()=>document.querySelector('#menuCardsStatus').classList.contains('is-error'));assert.equal(records.size,1);
  await admin.locator('#menuCardsUpload').setInputFiles({name:'grande.png',mimeType:'image/png',buffer:Buffer.alloc(15*1024*1024+1)});await admin.waitForFunction(()=>document.querySelector('#menuCardsStatus').textContent.includes('15 MB'));assert.equal(records.size,1);
  const uploadsBeforeOffline=calls.filter(([op])=>op==='upload').length;
  await admin.context().setOffline(true);await admin.locator('#menuCardsUpload').setInputFiles(first);await admin.waitForFunction(()=>document.querySelector('#menuCardsStatus').classList.contains('is-error'));
  assert.equal(calls.filter(([op])=>op==='upload').length,uploadsBeforeOffline);assert.equal(records.size,1);await admin.context().setOffline(false);
  failUpload=true;await admin.locator('#menuCardsUpload').setInputFiles(first);await admin.waitForFunction(()=>document.querySelector('#menuCardsStatus').textContent.includes('Red interrumpida'));assert.equal(records.size,1);failUpload=false;
  // Respuesta perdida después del commit: recargar y reintentar no duplica.
  lostResponse=true;await admin.locator('#menuCardsUpload').setInputFiles(first);await admin.waitForFunction(()=>document.querySelector('#menuCardsStatus').textContent.includes('Se perdió'));assert.equal(records.size,2);
  await admin.locator('#menuCardsUpload').setInputFiles(first);await admin.waitForFunction(()=>document.querySelector('#menuCardLibrary').getAttribute('aria-busy')==='false');assert.equal(records.size,2);
  allowed=false;await openEditor(admin);await admin.waitForFunction(()=>document.querySelector('#menuCardsStatus').textContent.includes('No tienes permiso'));allowed=true;
  assert.equal(calls.some(([,arg])=>arg?.name && !arg.name.startsWith('pos_')),false);
  if(process.env.POS_QA_ARTIFACTS){fs.mkdirSync(process.env.POS_QA_ARTIFACTS,{recursive:true});await openEditor(admin);await admin.waitForFunction(()=>!document.querySelector('#menuCardsStatus').classList.contains('is-error'));await admin.locator('#closeMenuCardsEditor').click();await admin.screenshot({path:path.join(process.env.POS_QA_ARTIFACTS,'carta-admin.png'),fullPage:true});await client.evaluate(()=>currentMenuTable={id:'a',qr_code:'qr-a'});await client.locator('#openMenuCards').click();await client.locator('#menuViewerImage').waitFor({state:'visible'});await client.screenshot({path:path.join(process.env.POS_QA_ARTIFACTS,'carta-movil.png')});}
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('PDF: descarga real desde botón de Compras y contraste del cobro sin cambiar el fondo',async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const page=await browser.newPage({acceptDownloads:true});
  const admin=fs.readFileSync(path.join(root,'admin.html'),'utf8'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const match=admin.match(/<button class="ghost" id="exportPurchasesPdf"[^>]*>[\s\S]*?<\/button>/);assert.ok(match);
  await page.setContent(`${match[0]}<p id="purchaseFilterFeedback"></p><div class="cash-change is-sufficient" id="cashChange"><span>Vueltas / cambio</span><strong>$ 500</strong><small>Recibido $ 3.000</small></div>`);
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'style.css'),'utf8')});
  await page.addScriptTag({path:path.join(root,'vendor/jspdf.umd.min.js')});
  const start=source.indexOf('  const buildPurchasesReportPdf ='),end=source.indexOf('  const renderConsumptionProductOptions =',start);
  const click=source.split('\n').find(line=>line.includes('$("#exportPurchasesPdf")?.addEventListener'));assert.ok(click);
  await page.addScriptTag({content:`const $=s=>document.querySelector(s),money=n=>'$ '+Number(n).toLocaleString('es-CO'),reportNumber=n=>Number(n).toLocaleString('es-CO');const state={business:{business_name:'Tienda Nápoles'},purchaseDateFrom:'2026-10-01',purchaseDateTo:'2026-10-19',purchaseSearch:'',movementHasMore:true};const purchaseDateKey=v=>new Date(v).toISOString().slice(0,10),prettyDateTime=v=>new Date(v).toLocaleString('es-CO'),purchaseUnitCost=r=>r.unitCost,toast=message=>{window.pdfError=message};const purchaseMovements=()=>Array.from({length:135},(_,i)=>({productId:'p'+i,product:'Producto '+i,date:'2026-10-18T18:30:00Z',user:'Ana',reference:'Compra '+i,delta:3,unitCost:12500}));`+source.slice(start,end)+click});
  const colors=await page.locator('#cashChange').evaluate(n=>({background:getComputedStyle(n).backgroundColor,text:[...n.children].map(c=>getComputedStyle(c).color)}));
  assert.equal(colors.background,'rgb(227, 248, 236)');assert.deepEqual(colors.text,['rgb(0, 0, 0)','rgb(0, 0, 0)','rgb(0, 0, 0)']);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#exportPurchasesPdf').click()]);assert.match(download.suggestedFilename(),/^compras-2026-10-01-2026-10-19\.pdf$/);
  const buffer=fs.readFileSync(await download.path());assert.equal(buffer.subarray(0,5).toString(),'%PDF-');assert.ok(buffer.toString().includes('Producto 134'));assert.ok(buffer.toString().includes('5.062.500'));
  assert.equal(await page.locator('#exportPurchasesPdf').isEnabled(),true);assert.equal(await page.evaluate(()=>window.pdfError),undefined);
  if(process.env.POS_QA_ARTIFACTS){fs.mkdirSync(process.env.POS_QA_ARTIFACTS,{recursive:true});fs.writeFileSync(path.join(process.env.POS_QA_ARTIFACTS,'compras-descarga.pdf'),buffer);await page.screenshot({path:path.join(process.env.POS_QA_ARTIFACTS,'cobro-negro.png')});}
 }finally{await browser.close();}
});
