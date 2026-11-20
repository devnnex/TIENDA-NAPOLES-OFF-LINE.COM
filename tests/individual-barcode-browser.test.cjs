const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
const instrument=source=>source.replace('  return { init };','  return { init, state, bindAdmin, showAdminSection, renderIncomeReport, incomeFiltersFromForm, loadIncomeReport, previewIncomeSearch, setIncomeRange, createWalkInSale, loadWalkInDrafts, openConsumptionDialog, queueConsumptionDraft, clearConsumptionEntry, confirmConsumptionSelection, resetInventoryForm, editInventoryProduct, saveInventoryProduct, openPaymentDialog, addBarcodeToSale, processPayment };').replace('document.addEventListener("DOMContentLoaded", App.init);','window.salesApi=App;');
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
    const records=filters.pageRows?filters.pageRows.map(key=>selected.find(row=>row.saleId===key.saleId)):selected.slice(0,Math.min(500,Number(filters.limit)||300));
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


test('Venta individual fija: cobro visible, tres borradores independientes y mesas conservadas en Inicio',async()=>{
 const session=await launch(),errors=[];
 try{for(const width of [1440,390]){
  const context=await session.browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.setDefaultTimeout(7000);
  page.on('pageerror',error=>errors.push(error.message));await boot(page,session.url);
  await page.evaluate(()=>{salesApi.state.tables=[{id:'table1',table_number:1,is_active:true}];salesApi.showAdminSection('dashboard');});
  assert.equal(await page.locator('[data-dashboard-walk-in]').count(),3);
  assert.deepEqual(await page.locator('[data-dashboard-walk-in] small').allTextContents(),['Venta individual 1','Venta individual 2','Venta individual 3']);
  assert.equal(await page.locator('#tablesGrid [data-open-table="table1"]').count(),1);
  const ids=[];
  for(const slot of [1,2,3]){
   await page.locator('[data-dashboard-walk-in="'+slot+'"]').click();
   ids.push(await page.locator('#paymentForm [name="session_id"]').inputValue());
   await page.locator('#paymentAddItem').click();await page.locator('#consumptionProductSearch').fill(slot===2?'Café':'Agua');
   await page.locator('[data-consumption-product="'+(slot===2?'q':'p')+'"]').click();
   await page.locator('#consumptionForm [name="quantity"]').fill(String(slot));await page.locator('#consumptionQueueButton').click();
   await page.locator('#consumptionDialog [data-cancel-consumption]').first().click();
   assert.equal(await page.locator('[data-dashboard-walk-in="'+slot+'"] [data-walk-in-draft-count]').isVisible(),true);
  }
  assert.equal(new Set(ids).size,3);
  await page.locator('.admin-sidebar a[href="#service"]').click();
  assert.equal(await page.locator('#service #paymentDialog').isVisible(),true);
  assert.equal(await page.locator('#paymentDialog').evaluate(node=>node.matches(':modal')),false);
  assert.equal(await page.locator('#service [data-open-table], #service [data-service-zone], #service [data-service-walk-in]').count(),0);
  assert.equal(await page.locator('#paymentDialogTitle').innerText(),'Cobrar venta individual');
  const fixedId=await page.locator('#paymentForm [name="session_id"]').inputValue();assert.ok(!ids.includes(fixedId));
  await page.locator('#paymentAddItem').click();await page.locator('#consumptionProductSearch').fill('Agua');
  await page.locator('[data-consumption-product="p"]').click();await page.locator('#consumptionForm [name="quantity"]').fill('4');
  await page.locator('#consumptionQueueButton').click();await page.locator('#consumptionSubmitButton').click();
  assert.equal(await page.locator('#service #paymentDialog').isVisible(),true);assert.match(await page.locator('#paymentSaleLines').innerText(),/4.*Agua/);
  await page.screenshot({path:path.resolve(root,'../.delivery/individual-'+path.basename(root)+'-'+width+'.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('.admin-sidebar a[href="#dashboard"]').click();
  assert.equal(await page.locator('#paymentDialog').evaluate(node=>node.open),false);
  for(const slot of [1,2,3]){
   await page.locator('[data-dashboard-walk-in="'+slot+'"]').click();
   assert.equal(await page.locator('#consumptionForm [name="session_id"]').inputValue(),ids[slot-1]);
   await page.keyboard.press('Escape');
  }
  await boot(page,session.url);await page.evaluate(()=>{salesApi.loadWalkInDrafts();salesApi.showAdminSection('dashboard');});
  assert.equal(await page.locator('[data-dashboard-walk-in] [data-walk-in-draft-count]:visible').count(),3);
  await page.locator('.admin-sidebar a[href="#service"]').click();
  assert.equal(await page.locator('#paymentForm [name="session_id"]').inputValue(),fixedId);
  assert.match(await page.locator('#paymentSaleLines').innerText(),/4.*Agua/);
  await context.close();
 }assert.deepEqual(errors,[]);}finally{await session.close();}
});

test('Pistola: Enter agrega productos, conserva ceros y medio de pago, valida stock y código desconocido',async()=>{
 const session=await launch(),errors=[];
 try{const context=await session.browser.newContext(),page=await context.newPage();page.setDefaultTimeout(7000);
 page.on('pageerror',error=>errors.push(error.message));await boot(page,session.url);
 await page.evaluate(()=>{salesApi.state.items[0].barcode='0012345678905';salesApi.state.items[1].barcode='0098765432109';salesApi.state.inventoryMeta.p.stock=2;salesApi.showAdminSection('dashboard');});
 await page.locator('#openBarcodeSale').click();
 const id=await page.locator('#paymentForm [name="session_id"]').inputValue();
 await page.locator('#paymentForm .payment-methods label').filter({has:page.locator('input[value="transfer"]')}).click();
 const input=page.locator('#barcodeSaleInput');await input.fill('0012345678905');await input.press('Enter');
 await page.waitForFunction(()=>document.querySelectorAll('#paymentSaleLines [data-remove-walk-in-item]').length===1);
 assert.equal(await page.evaluate(()=>salesApi.state.invoiceHistory.length),0,'Escanear no debe cobrar');
 assert.equal(await page.locator('#paymentForm [name="payment_method"]:checked').inputValue(),'transfer');
 await input.fill('0012345678905');await input.press('Enter');await input.fill('0098765432109');await input.press('Tab');
 await page.waitForFunction(()=>document.querySelectorAll('#paymentSaleLines [data-remove-walk-in-item]').length===3);
 assert.match(await page.locator('#paymentTotal').innerText(),/1[.,]100/);
 await input.fill('0012345678905');await input.press('Enter');await page.waitForFunction(()=>document.querySelector('#barcodeSaleStatus').textContent.includes('existencias'));
 assert.equal(await page.locator('#paymentSaleLines [data-remove-walk-in-item]').count(),3);
 await input.fill('0000000000000');await input.press('Enter');await page.waitForFunction(()=>document.querySelector('#barcodeSaleStatus').textContent.includes('no registrado'));
 assert.equal(await page.evaluate(()=>salesApi.state.inventoryMeta.p.stock),2,'Escanear reserva; el cobro descuenta');
 await page.locator('#paymentDialog [data-cancel-payment]').first().click();await page.locator('#openBarcodeSale').click();
 assert.equal(await page.locator('#paymentForm [name="session_id"]').inputValue(),id);assert.equal(await page.locator('#paymentSaleLines [data-remove-walk-in-item]').count(),3);
 assert.deepEqual(errors,[]);await context.close();}finally{await session.close();}
});

test('Inventario: guardar y editar código de barras sin cambiar siglas, rechazar duplicados',async()=>{
 const session=await launch(),errors=[];
 try{const context=await session.browser.newContext(),page=await context.newPage();page.setDefaultTimeout(7000);
 page.on('pageerror',error=>errors.push(error.message));await boot(page,session.url);
 await page.evaluate(()=>{
  window.savedProducts=[];
  salesApi.state.sb.from=table=>{let payload=null,id='new-barcode-product';const query={
   insert(value){payload=value;return this;},update(value){payload=value;return this;},eq(_key,value){id=value;return this;},select(){return this;},
   single:async()=>{const data={id,...payload};savedProducts.push(data);return {data};}
  };return query;};
  salesApi.resetInventoryForm({open:true});
 });
 const form=page.locator('#inventoryForm');await form.locator('[name="barcode"]').fill('0001234567890');await form.locator('[name="barcode"]').press('Enter');
 assert.equal(await page.locator('#inventoryDialog').evaluate(node=>node.open),true);assert.equal(await page.evaluate(()=>savedProducts.length),0);
 await form.locator('[name="product_name"]').fill('Producto escaneado');await form.locator('[name="product_code"]').fill('PE');
 await form.locator('[name="cost_price"]').fill('100');await form.locator('[name="sale_price"]').fill('500');await form.locator('[name="stock"]').fill('8');
 await form.locator('[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#inventoryDialog').open);
 const product=await page.evaluate(()=>salesApi.state.items.find(item=>item.name==='Producto escaneado'));
 assert.equal(product.barcode,'0001234567890');assert.equal(await page.evaluate(id=>salesApi.state.inventoryMeta[id].code,product.id),'PE');
 await page.evaluate(id=>salesApi.editInventoryProduct(id),product.id);assert.equal(await form.locator('[name="barcode"]').inputValue(),'0001234567890');
 await form.locator('[name="barcode"]').fill('0001234567891');await form.locator('[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#inventoryDialog').open);
 assert.equal(await page.evaluate(id=>salesApi.state.items.find(item=>item.id===id).barcode,product.id),'0001234567891');
 await page.evaluate(()=>{salesApi.state.items[0].barcode='0001234567891';salesApi.resetInventoryForm({open:true});});
 await form.locator('[name="product_name"]').fill('Duplicado');await form.locator('[name="barcode"]').fill('0001234567891');await form.locator('[name="cost_price"]').fill('100');await form.locator('[name="sale_price"]').fill('500');await form.locator('[type="submit"]').click();
 assert.equal(await page.locator('#inventoryDialog').evaluate(node=>node.open),true);assert.equal(await page.evaluate(()=>salesApi.state.items.some(item=>item.name==='Duplicado')),false);
 assert.deepEqual(errors,[]);await context.close();}finally{await session.close();}
});

test('Cobro de pistola y cobro fijo: factura única, descuento de stock y formulario fijo listo para otra venta',async()=>{
 const session=await launch();try{const context=await session.browser.newContext(),page=await context.newPage();page.setDefaultTimeout(7000);await boot(page,session.url);
 await page.evaluate(()=>{salesApi.state.items[0].barcode='0012345678905';salesApi.showAdminSection('dashboard');});
 await page.locator('#openBarcodeSale').click();const barcodeId=await page.locator('#paymentForm [name="session_id"]').inputValue();
 await page.locator('#barcodeSaleInput').fill('0012345678905');await page.locator('#barcodeSaleInput').press('Enter');
 await page.waitForFunction(()=>document.querySelectorAll('#paymentSaleLines [data-remove-walk-in-item]').length===1);
 await page.locator('#paymentForm .payment-methods label').filter({has:page.locator('input[value="transfer"]')}).click();
 await page.locator('#paymentForm button[type="submit"][value="save"]').click();
 await page.waitForFunction(()=>salesApi.state.invoiceHistory.length===1);
 assert.equal(await page.evaluate(()=>salesApi.state.inventoryMeta.p.stock),99999);
 assert.equal(await page.evaluate(id=>salesApi.state.invoiceHistory.filter(row=>row.sessionId===id).length,barcodeId),1);
 await page.locator('.admin-sidebar a[href="#service"]').click();const fixedId=await page.locator('#paymentForm [name="session_id"]').inputValue();
 await page.locator('#paymentAddItem').click();await page.locator('#consumptionProductSearch').fill('Agua');await page.locator('[data-consumption-product="p"]').click();
 await page.locator('#consumptionForm [name="quantity"]').fill('2');await page.locator('#consumptionQueueButton').click();await page.locator('#consumptionSubmitButton').click();
 await page.locator('#paymentForm .payment-methods label').filter({has:page.locator('input[value="transfer"]')}).click();
 await page.locator('#paymentForm button[type="submit"][value="save"]').click();
 await page.waitForFunction(()=>salesApi.state.invoiceHistory.length===2);
 await page.waitForFunction(old=>document.querySelector('#paymentDialog').open&&document.querySelector('#paymentForm [name="session_id"]').value!==old,fixedId);
 assert.equal(await page.evaluate(()=>salesApi.state.inventoryMeta.p.stock),99997);
 assert.match(await page.locator('#paymentSaleLines').innerText(),/Agrega el producto/);
 assert.equal(await page.locator('#paymentDialog').evaluate(node=>node.matches(':modal')),false);
 await context.close();}finally{await session.close();}
});
