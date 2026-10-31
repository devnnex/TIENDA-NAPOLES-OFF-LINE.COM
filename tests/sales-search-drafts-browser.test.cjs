const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
const instrument=source=>source.replace('  return { init };','  return { init, state, bindAdmin, showAdminSection, renderIncomeReport, incomeFiltersFromForm, loadIncomeReport, previewIncomeSearch, setIncomeRange, createWalkInSale, loadWalkInDrafts, openConsumptionDialog, queueConsumptionDraft, clearConsumptionEntry, confirmConsumptionSelection };').replace('document.addEventListener("DOMContentLoaded", App.init);','window.salesApi=App;');
async function launch(){
 const server=http.createServer((req,res)=>{
  const file=new URL(req.url,'http://local').pathname.slice(1);
  if(file==='admin.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,file),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<link rel="stylesheet" href="/style.css"></head>'));}
  else if(['style.css','menu-cards.css'].includes(file)){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(root,file)));}
  else{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 return {server,browser,url:`http://127.0.0.1:${server.address().port}/admin.html`,async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
}
async function boot(page,url,{productRanges=false}={}){
 await page.goto(url);
 await page.addScriptTag({path:path.join(root,'sales-shift.js')});
 await page.addScriptTag({content:instrument(fs.readFileSync(path.join(root,'app.js'),'utf8'))});
 await page.evaluate(productRanges=>{
  document.body.classList.add('admin-authenticated');
  Object.assign(salesApi.state,{page:'admin',activeAdminSection:'income',currentUser:{id:'boss',role:'boss',full_name:'Caja'},authToken:'test',business:{business_name:'Prueba'},businessTimeZone:'America/Bogota',incomeAwaitingRemote:false});
  salesApi.state.items=[{id:'p',name:'Agua',price:100,category_id:'c',is_active:true},{id:'q',name:'Café',price:900,category_id:'c',is_active:true}];
  salesApi.state.categories=[{id:'c',name:'Bebidas',is_active:true}];
  salesApi.state.inventoryMeta={p:{stock:100000,minimumStock:0,costPrice:10,code:'01',unit:'unidad'},q:{stock:100000,minimumStock:0,costPrice:20,code:'02',unit:'unidad'}};
  window.calls=[];
  const line=(name,quantity,unitPrice)=>({menuItemId:name==='Agua'?'p':'q',name,quantity,unitPrice,total:quantity*unitPrice,cost:quantity*10});
  window.rows=Array.from({length:650},(_,i)=>({saleId:'sale-'+i,invoice:'TN-'+i,date:new Date().toISOString(),table:'Mesa 1',payer:'Cliente',total:1100,subtotal:1100,cost:30,profit:1070,items:[line('Agua',2,100),line('Café',1,900)],payments:[{method:'cash',amount:1100}]}));
  rows.push({...rows[0],saleId:'old',date:new Date(Date.now()-172800000).toISOString(),items:[line('Agua',3,100)],total:300,cost:30,profit:270});
  rows.push({...rows[0],saleId:'metadata',payer:'Agua',items:[line('Café',1,900)],total:900,cost:10,profit:890});
  rows.push({...rows[0],saleId:'previous-year',date:(Number(SalesShift.dateKey(new Date()).slice(0,4))-1)+'-12-31T12:00:00-05:00'});
  if(productRanges){
   const names=['Soda/Ginger','Agua','Cerveza','Café'];
   const year=SalesShift.dateKey(new Date()).slice(0,4);
   salesApi.state.items=names.map((name,i)=>({id:'p'+i,name:name+' grande',price:1000,is_active:true}));
   const sale=(prefix,i,previous)=>{
    const items=names.map((name,index)=>({menuItemId:'p'+index,name:name+(previous?'':' grande'),quantity:.1,unitPrice:1000,total:100,cost:20}));
    items.push({menuItemId:'other',name:'Otro producto',quantity:1,total:900,cost:100});
    return {saleId:prefix+i,invoice:'TN-'+prefix+i,date:previous?year+'-02-15T12:00:00-05:00':new Date().toISOString(),table:'Mesa 1',payer:'Cliente',total:1300,subtotal:1300,cost:180,profit:1120,items,payments:[{method:'cash',amount:1300}]};
   };
   rows=[...Array.from({length:320},(_,i)=>sale('month-',i,false)),...Array.from({length:260},(_,i)=>sale('older-',i,true))];
  }
  window.fetch=async(_url,options={})=>{
   if(!options.body)return new Response('{}');
   const request=JSON.parse(options.body);calls.push(request);let result={ok:true};
   if(request.action==='status')result={ok:true,historyRevision:'same',movementRevision:'same'};
   if(request.action==='get_inventory')result={ok:true,items:Object.entries(salesApi.state.inventoryMeta).map(([productId,item])=>({...item,productId}))};
   if(request.action==='get_income_report'){
    const filters=request.payload.filters,term=(filters.query||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const selected=rows.filter(row=>SalesShift.matches(row.date,filters)&&(!term||[row.invoice,row.table,row.payer,...row.items.map(item=>item.name)].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(term)));
    const records=filters.pageRows?filters.pageRows.map(key=>selected.find(row=>row.saleId===key.saleId)):selected.slice(0,300);
    result={ok:true,intervalApplied:true,revision:'same',records,totalRecords:selected.length,recordRows:selected.map((row,i)=>({saleId:row.saleId,row:i+2})),truncated:selected.length>300,
     totals:{income:selected.reduce((sum,row)=>sum+row.total,0),profit:selected.reduce((sum,row)=>sum+row.profit,0),cost:selected.reduce((sum,row)=>sum+row.cost,0),sales:selected.length,cash:selected.reduce((sum,row)=>sum+row.total,0)}};
   }
   return new Response(JSON.stringify(result),{status:200});
  };
  salesApi.state.sb={rpc:async()=>({data:{ok:true,changes:[],hasMore:false}}),channel:()=>({on(){return this;},subscribe(){return this;},send:async()=> 'ok'})};
  salesApi.bindAdmin();
  salesApi.showAdminSection('income');
 },productRanges);
}

test('soda/ginger y otros productos: mes 32, año 58, con paginación, caché y cambios repetidos de rango',async()=>{
 const session=await launch(),errors=[];
 try{for(const width of [1440,390]){
  const context=await session.browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));await boot(page,session.url,{productRanges:true});
  for(const query of ['soda/ginger','agua','cerveza','café']){
   await page.locator('#incomeSearch').fill(query);
   for(const [range,count,units,money] of [['month',320,32,'32.000'],['year',580,58,'58.000'],['month',320,32,'32.000'],['year',580,58,'58.000']]){
    await page.locator(`[data-income-range="${range}"]`).click();
    await page.waitForFunction(({query,count,range})=>!salesApi.state.incomeLoading&&salesApi.state.incomeRangePreset===range&&salesApi.state.incomeReport?.filters.query===query&&salesApi.state.incomeReport.records.length===count,{query,count,range});
    assert.equal((await page.locator('#incomeKpis .is-product strong').first().innerText()).trim(),String(units),query+' '+range);
    assert.match(await page.locator('#incomeKpis .is-product').nth(1).innerText(),new RegExp(money.replace('.','[.,]')));
    assert.equal(await page.locator('#incomeKpis .is-product').count(),3);
    assert.equal(await page.locator('#incomeSearch').inputValue(),query);
   }
  }
  const pages=await page.evaluate(()=>calls.filter(call=>call.action==='get_income_report'&&call.payload.filters.pageRows).length);
  assert.ok(pages>0,'debe consultar las páginas posteriores a las primeras 300 facturas');
  await context.close();
 }assert.deepEqual(errors,[]);}finally{await session.close();}
});
test('búsqueda general: todas las páginas, rango, año actual, KPI y respuesta inmediata en escritorio y móvil',async()=>{
 const session=await launch(),errors=[],measurements=[];
 try{for(const width of [1440,390]){
  const context=await session.browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));await boot(page,session.url);
  assert.equal(await page.locator('[data-income-range="all"]').count(),0);
  await page.locator('[data-income-range="year"]').click();
  await page.waitForFunction(()=>salesApi.state.incomeReport?.totalRecords===652&&!salesApi.state.incomeLoading);
  await page.locator('#incomeSearch').fill('agu');
  await page.waitForFunction(()=>salesApi.state.incomeReport?.records.length===652&&!salesApi.state.incomeLoading&&document.querySelector('#incomeKpis').textContent.includes('130.300'));
  assert.equal(await page.locator('#incomeKpis .is-product').count(),3);
  assert.match(await page.locator('#incomeKpis').innerText(),/1[.,]303/);
  assert.equal(await page.locator('#incomePaymentBreakdown').isVisible(),false);
  assert.equal(await page.locator('#incomeRecords li').evaluateAll(nodes=>nodes.every(node=>node.textContent.includes('Agua')&&!node.textContent.includes('Café'))),true);
  assert.equal(await page.evaluate(()=>salesApi.state.incomeReport.records.find(row=>row.saleId==='sale-0').total),1100);
  const timing=await page.evaluate(()=>{const input=document.querySelector('#incomeSearch');input.value='Agua';const start=performance.now();input.dispatchEvent(new Event('input',{bubbles:true}));return {ms:performance.now()-start,kpis:document.querySelector('#incomeKpis').textContent};});
  assert.match(timing.kpis,/130.300/);assert.ok(timing.ms<150,JSON.stringify(timing));measurements.push({width,ms:timing.ms});
  await page.evaluate(()=>salesApi.setIncomeRange('today'));
  await page.waitForFunction(()=>!salesApi.state.incomeLoading&&salesApi.state.incomeReport?.filters.query==='Agua'&&document.querySelector('#incomeKpis').textContent.includes('130.000'));
  assert.match(await page.locator('#incomeKpis').innerText(),/1[.,]300/);
  await page.locator('[data-income-range="year"]').click();
  await page.waitForFunction(()=>!salesApi.state.incomeLoading&&document.querySelector('#incomeKpis').textContent.includes('130.300'));
  assert.equal(await page.locator('#incomeDateFrom').inputValue(),await page.evaluate(()=>SalesShift.dateKey(new Date()).slice(0,4)+'-01-01'));
  assert.equal(await page.evaluate(()=>salesApi.state.incomeReport.records.some(row=>row.saleId==='previous-year')),false);
  await page.locator('#incomeSearch').fill('Mesa 1');
  await page.waitForFunction(()=>!salesApi.state.incomeLoading&&salesApi.state.incomeReport?.filters.query==='Mesa 1');
  assert.equal(await page.locator('#incomeKpis .is-product').count(),0);
  assert.equal(await page.locator('#incomePaymentBreakdown').isVisible(),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await context.close();
 }assert.deepEqual(errors,[]);console.log(JSON.stringify({project:path.basename(root),searchInput:measurements}));}finally{await session.close();}
});
test('venta individual: selección editable, guardar al salir, otra mesa, recarga y cierre del cobro',async()=>{
 const session=await launch(),errors=[];
 try{for(const width of [1440,390]){
  const context=await session.browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));await boot(page,session.url);
  await page.evaluate(()=>salesApi.createWalkInSale());await page.locator('#paymentAddItem').click();
  for(const [id,name,qty] of [['p','Agua','2'],['q','Café','3']]){
   await page.locator('#consumptionProductSearch').fill(name);await page.locator(`[data-consumption-product="${id}"]`).click();
   await page.locator('#consumptionForm [name="quantity"]').fill(qty);await page.locator('#consumptionQueueButton').click();
  }
  await page.locator('[data-edit-consumption-product="0"]').dblclick();
  await page.locator('#consumptionForm [name="quantity"]').fill('4');await page.locator('#consumptionQueueButton').click();
  assert.equal(await page.locator('#consumptionSelectionLines > div').count(),2);
  await page.locator('#consumptionProductSearch').fill('Agua');await page.locator('[data-consumption-product="p"]').click();
  await page.locator('#consumptionForm [name="quantity"]').fill('');
  await page.locator('#consumptionDialog [data-cancel-consumption]').first().click();
  assert.equal(await page.locator('#paymentDialog').evaluate(node=>node.open),false);
  await page.evaluate(()=>{
   salesApi.state.tables=[{id:'t',table_name:'Mesa 1'}];salesApi.state.sessions.push({id:'table-session',table_id:'t',status:'open',restaurant_tables:salesApi.state.tables[0],session_items:[]});
   salesApi.openConsumptionDialog('table-session');
  });
  assert.equal(await page.locator('#consumptionSelectionLines > div').count(),0);
  await page.keyboard.press('Escape');
  await page.evaluate(()=>salesApi.createWalkInSale());
  assert.equal(await page.locator('#consumptionSelectionLines > div').count(),2);
  assert.match(await page.locator('#consumptionSelectionLines').innerText(),/4 ×/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('#consumptionDialog').open);
  await boot(page,session.url);
  await page.evaluate(()=>{salesApi.loadWalkInDrafts();return salesApi.createWalkInSale();});
  assert.equal(await page.locator('#consumptionSelectionLines > div').count(),2);
  assert.match(await page.locator('#consumptionSelectionLines').innerText(),/4 ×/);
  assert.equal(await page.locator('#consumptionForm [name="menu_item_id"]').inputValue(),'p');
  assert.equal(await page.locator('#consumptionForm [name="quantity"]').inputValue(),'');
  // A reload while still inside the modal must also preserve the unfinished entry.
  await boot(page,session.url);
  await page.evaluate(()=>{salesApi.loadWalkInDrafts();return salesApi.createWalkInSale();});
  assert.equal(await page.locator('#consumptionSelectionLines > div').count(),2);
  assert.equal(await page.locator('#consumptionForm [name="menu_item_id"]').inputValue(),'p');
  await page.evaluate(()=>salesApi.clearConsumptionEntry(document.querySelector('#consumptionForm')));
  const result=await page.evaluate(()=>salesApi.confirmConsumptionSelection(document.querySelector('#consumptionForm')));
  assert.ok(result);assert.equal(await page.locator('#paymentDialog').evaluate(node=>node.open),true);
  assert.equal(await page.evaluate(()=>salesApi.state.sessions.find(row=>row.id===document.querySelector('#paymentForm').session_id.value).session_items.length),2);
  await page.locator('#paymentSaleLines [data-edit-walk-in-item]').first().dblclick();
  await page.locator('#consumptionForm [name="quantity"]').fill('5');
  await page.locator('#consumptionSubmitButton').click();
  await page.waitForFunction(()=>document.querySelector('#paymentDialog').open);
  assert.match(await page.locator('#paymentSaleLines').innerText(),/5 ×/);
  await page.keyboard.press('Escape');await page.evaluate(()=>salesApi.createWalkInSale());
  assert.match(await page.locator('#paymentSaleLines').innerText(),/5 ×/);
  assert.equal(await page.evaluate(()=>salesApi.state.invoiceHistory.length),0);
  assert.equal(await page.evaluate(()=>salesApi.state.inventoryMeta.p.stock),100000);
  await context.close();
 }assert.deepEqual(errors,[]);}finally{await session.close();}
});
