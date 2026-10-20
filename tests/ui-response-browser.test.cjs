const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),test=require('node:test');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
test('turno, secciones y escritura responden durante consultas remotas pendientes, con y sin internet',async()=>{
 const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
 const errors=[],measurements=[];
 const server=http.createServer((req,res)=>{
  const file=new URL(req.url,'http://local').pathname.slice(1);
  if(file==='admin.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,file),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<link rel="stylesheet" href="/style.css"></head>'));}
  else if(['style.css','menu-cards.css'].includes(file)){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(root,file)));}
  else{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 try {
  for(const width of [1440,390])for(const online of [true,false]){
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
   page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
   await page.addScriptTag({path:path.join(root,'sales-shift.js')});
   const lucide=[path.join(root,'vendor/lucide.min.js'),path.resolve(root,'../TIENDA-NAPOLES-OFF-LINE.COM-main/vendor/lucide.min.js')].find(file=>fs.existsSync(file));
   if(lucide)await page.addScriptTag({path:lucide});
   const instrumented=source.replace('  return { init };','  return { init, state, bindAdmin, showAdminSection, openSalesShift, renderIncomeReport, renderInventory, renderBrand, incomeFiltersFromForm, loadIncomeReport };')
     .replace('document.addEventListener("DOMContentLoaded", App.init);','window.responseApi = App;');
   await page.addScriptTag({content:instrumented});
   await page.evaluate(({online})=>{
    Object.defineProperty(navigator,'onLine',{get:()=>online,configurable:true});
    window.fetch=async()=>new Promise(()=>{}); // Network never completes during the interaction checks.
    document.body.classList.add('admin-authenticated');
    const state=responseApi.state;
    Object.assign(state,{page:'admin',currentUser:{id:'boss',role:'boss',full_name:'Caja'},authToken:'test',business:{business_name:'Tienda Napoles'},businessTimeZone:'America/Bogota'});
    state.items=Array.from({length:200},(_,i)=>({id:'p'+i,name:'Producto '+i,price:100,is_available:true}));
    state.inventoryMeta=Object.fromEntries(state.items.map(item=>[item.id,{stock:1000,costPrice:40,unit:'unidad',version:4}]));
    state.inventoryMovements=Array.from({length:800},(_,i)=>({movementId:'m'+i,productId:'p'+(i%200),product:'Producto '+(i%200),type:'SALIDA_VENTA',delta:-1,before:1001,after:1000,date:new Date().toISOString()}));
    responseApi.bindAdmin();responseApi.showAdminSection('dashboard');responseApi.openSalesShift();
    state.incomeAwaitingRemote=false;
    const filters=responseApi.incomeFiltersFromForm();
    const records=Array.from({length:300},(_,i)=>({saleId:'s'+i,invoice:'F'+i,table:'Mesa 1',date:new Date().toISOString(),total:100,subtotal:100,cost:40,profit:60,items:[{menuItemId:'p0',name:'Producto',quantity:1,total:100}],payments:[{method:'cash',amount:100}]}));
    window.report={filters,records,totals:{sales:300,income:30000,cost:12000,profit:18000,cash:30000},totalRecords:300,recordRows:records.map((row,i)=>({row:i+2,saleId:row.saleId})),revision:'same',generatedAt:new Date().toISOString()};
    state.incomeReport=report;state.incomeSaleTypeSnapshot={key:JSON.stringify({...filters,saleType:'all'}),report};state.incomeFetchedAt=Date.now();
    if(online)void responseApi.loadIncomeReport({background:true,force:true});
    state.activeAdminSection="income";responseApi.renderIncomeReport();
    if(!state.incomeRenderAfterShift)throw Error("El reporte recibido debe esperar al cierre del turno para dibujar filas.");
   },{online});
   // The X works on the first click, including clicking its nested icon.
   const close=await page.evaluate(()=>{
    const start=performance.now(),dialog=document.querySelector('#salesShiftDialog');
    dialog.querySelector('[data-close-dialog] i, [data-close-dialog] svg, [data-close-dialog]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return {ms:performance.now()-start,open:dialog.open};
   });
   assert.equal(close.open,false);measurements.push({width,online,action:'close',ms:close.ms});
   await page.evaluate(()=>responseApi.openSalesShift());
   const outside=await page.evaluate(()=>{const dialog=document.querySelector('#salesShiftDialog');dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return dialog.open;});
   assert.equal(outside,false);
   await page.evaluate(()=>responseApi.openSalesShift());
   await page.mouse.click(4,4);assert.equal(await page.locator('#salesShiftDialog').evaluate(node=>node.open),false,'Un solo clic real fuera del modal lo cierra.');
   for(const section of ['inventory','movements','income','dashboard','income']){
    const result=await page.evaluate(section=>{
     const start=performance.now();document.querySelector(`.admin-sidebar nav a[href="#${section}"]`).click();
     return {ms:performance.now()-start,section:responseApi.state.activeAdminSection};
    },section);
    assert.equal(result.section,section);measurements.push({width,online,action:section,ms:result.ms});
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    if(section==='inventory')await page.waitForFunction(()=>document.querySelectorAll('#inventoryList .inventory-row').length===200);
    if(section==='movements')await page.waitForFunction(()=>document.querySelectorAll('#inventoryMovementList .movement-row').length===800);
    if(section==='income')await page.waitForFunction(()=>document.querySelectorAll('#incomeRecords .income-record').length===Math.min(responseApi.state.incomeVisibleCount||300,responseApi.state.incomeReport.records.length));
   }
   const typing=await page.evaluate(()=>{
    const input=document.querySelector('#incomeSearch'),times=[];
    for(const text of ['P','Pr','Pro','Prod','Produ','Produc','Product','Producto','']){const start=performance.now();input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));times.push(performance.now()-start);}
    return {ms:Math.max(...times),value:input.value};
   });
   assert.equal(typing.value,'');measurements.push({width,online,action:'typing-max-input',ms:typing.ms});
   const hidden=await page.evaluate(()=>{
    responseApi.showAdminSection('dashboard');
    const before=document.querySelector('#incomeRecords').innerHTML;
    responseApi.state.incomeReport={...report,records:[...report.records],totals:{...report.totals,income:40000}};
    responseApi.renderIncomeReport();
    const field=document.querySelector('#businessForm [name="business_name"]');field.value='Marca original';responseApi.renderBrand();
    return {unchanged:before===document.querySelector('#incomeRecords').innerHTML,name:responseApi.state.business.business_name,field:field.value,label:document.querySelector('#dashboard h1').textContent};
   });
   assert.equal(hidden.unchanged,true);assert.equal(hidden.name,'Tienda Napoles');assert.equal(hidden.field,'Marca original');
   assert.equal(hidden.label,source.includes('data-software-label')?'Tienda Napoles SOFTWARE':'Tienda Napoles');
   const resting=await page.locator('#incomeRecords').innerHTML();await page.waitForTimeout(100);assert.equal(await page.locator('#incomeRecords').innerHTML(),resting,'Las filas pausadas no se reconstruyen en una seccion oculta.');
   await context.close();
  }
  assert.deepEqual(errors,[]);
  const maximum=Math.max(...measurements.map(row=>row.ms));
  console.log('Respuesta de controles en navegador (ms):',JSON.stringify(measurements.map(row=>({...row,ms:Math.round(row.ms)}))));
  assert.ok(maximum<250,'Un control o entrada mantuvo ocupado el hilo mas de 250 ms: '+maximum);
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
