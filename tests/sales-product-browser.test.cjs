const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
test('selector buscable, KPI de producto, quitar filtro y ráfagas de refrescos en escritorio y móvil',async()=>{
 const server=http.createServer((req,res)=>{
  const file=new URL(req.url,'http://local').pathname.slice(1);
  if(file==='admin.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,file),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<link rel="stylesheet" href="/style.css"></head>'));}
  else if(['style.css','menu-cards.css'].includes(file)){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(root,file)));}
  else{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 const errors=[],measurements=[];
 try {
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
   page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
   await page.addScriptTag({path:path.join(root,'sales-shift.js')});
   const instrumented=fs.readFileSync(path.join(root,'app.js'),'utf8')
    .replace('  return { init };','  return { init, state, bindAdmin, showAdminSection, renderIncomeReport, incomeFiltersFromForm, loadIncomeReport, applyIncomeProductFilter, writeAppsScriptOutbox };')
    .replace('document.addEventListener("DOMContentLoaded", App.init);','window.salesApi=App;');
   await page.addScriptTag({content:instrumented});
   await page.evaluate(()=>{
    document.body.classList.add('admin-authenticated');
    Object.assign(salesApi.state,{page:'admin',activeAdminSection:'dashboard',currentUser:{id:'boss',role:'boss',full_name:'Caja'},authToken:'test',business:{business_name:'Prueba'},businessTimeZone:'America/Bogota',incomeAwaitingRemote:false});
    salesApi.state.items=[{id:'p',name:'Água seleccionada',price:100},{id:'q',name:'Otro producto',price:900}];
    window.requests=[];
    window.fetch=async(_input,options)=>{
     const request=JSON.parse(options.body);requests.push(request);
     const filters=request.payload?.filters || {},date=filters.startAt?new Date(Date.parse(filters.startAt)+1000).toISOString():new Date().toISOString();
     const records=Array.from({length:650},(_,i)=>({saleId:'sale-'+i,invoice:'TN-'+i,date,table:'Mesa 1',total:1100,subtotal:1100,cost:100,profit:1000,
      items:[{menuItemId:'p',name:'Água seleccionada',quantity:2,unitPrice:100,total:200,cost:40},{menuItemId:'q',name:'Otro producto',quantity:1,unitPrice:900,total:900,cost:60}],payments:[{method:'cash',amount:1100}]}));
     const all={ok:true,intervalApplied:true,revision:'same',records:records.slice(0,300),recordRows:records.map((row,i)=>({saleId:row.saleId,row:i+2})),totalRecords:650,truncated:true,
      totals:{income:715000,sales:650,profit:650000,cost:65000,cash:715000}};
     let result=request.action==='status'?{ok:true,historyRevision:'same',movementRevision:''}:all;
     if(filters.pageRows)result={ok:true,intervalApplied:true,revision:'same',records:filters.pageRows.map(row=>records[Number(row.saleId.slice(5))])};
     return new Response(JSON.stringify(result),{status:200});
    };
    salesApi.bindAdmin();
    // Reproduce entering with a zero local report before the first authoritative report.
    const filters=salesApi.incomeFiltersFromForm();
    salesApi.state.incomeReport={filters,records:[],totals:{income:0},totalRecords:0,localOnly:true};
    salesApi.state.incomeRevision='same';if(salesApi.state.syncFresh)salesApi.state.syncFresh.sales=false;
    salesApi.showAdminSection('income');
   });
   // BCA retains its original entry/status behaviour; request explicitly there if needed.
   if(!fs.readFileSync(path.join(root,'app.js'),'utf8').includes('  const reflectInvoiceInIncomeReport ='))await page.evaluate(()=>salesApi.loadIncomeReport({force:true}));
   await page.waitForFunction(()=>salesApi.state.incomeReport?.totalRecords===650&&!salesApi.state.incomeLoading);
   const normal=await page.locator('#incomeKpis').innerText();
   const normalColor=await page.locator('#incomeKpis article').first().evaluate(node=>getComputedStyle(node).backgroundImage);
   assert.match(normal,/715[.,]000/);
   await page.locator('#incomeProductToggle').fill('agua');
   await page.locator('[data-income-product="p"]').click();
   await page.waitForFunction(()=>document.querySelector('#incomeKpis').textContent.includes('130.000'));
   assert.equal(await page.locator('#incomeKpis .is-product').count(),3);
   const productText=await page.locator('#incomeKpis').innerText();
   assert.match(productText,/1[.,]300/);assert.match(productText,/130[.,]000/);assert.doesNotMatch(productText,/715[.,]000/);
   assert.equal(await page.locator('#incomePaymentBreakdown').isVisible(),false);
   assert.notEqual(await page.locator('#incomeKpis article').first().evaluate(node=>getComputedStyle(node).backgroundImage),normalColor);
   assert.equal(await page.evaluate(()=>salesApi.state.incomeReport.records[0].items.length),2);
   assert.equal(await page.evaluate(()=>salesApi.state.incomeReport.records[0].total),1100);
   const burst=await page.evaluate(async()=>{
    const started=performance.now();
    for(let i=0;i<30;i++)await salesApi.loadIncomeReport({background:true,force:true});
    return {ms:performance.now()-started,records:salesApi.state.incomeReport.records.length,kpis:document.querySelector('#incomeKpis').textContent};
   });
   assert.equal(burst.records,650);assert.match(burst.kpis,/130.000/);measurements.push({width,...burst,kpis:undefined});
   await page.locator('#clearIncomeProduct').click();
   assert.equal(await page.locator('#incomeKpis .is-product').count(),0);
   assert.equal(await page.locator('#incomeKpis').innerText(),normal);
   assert.equal(await page.locator('#incomePaymentBreakdown').isVisible(),true);
   if(fs.readFileSync(path.join(root,'app.js'),'utf8').includes('  const reflectInvoiceInIncomeReport =')){
    const onlineRefresh=await page.evaluate(async()=>{
     const jobs=salesApi.state.incomeReport.records.map(row=>({id:'queued-'+row.saleId,action:'record_sale',payload:{invoice:{id:row.saleId,sessionId:row.saleId,
      createdAt:row.date,table:row.table,totals:{total:row.total,subtotal:row.subtotal},payments:row.payments,
      items:row.items.map(line=>({menu_item_id:line.menuItemId,item_name:line.name,quantity:line.quantity,unit_price:line.unitPrice,unit_cost:line.cost/line.quantity}))}}}));
     salesApi.state.invoiceHistory=[];
     await salesApi.writeAppsScriptOutbox(jobs);
     const amounts=[];
     for(let i=0;i<5;i++){
      await salesApi.loadIncomeReport({background:true,force:true});
      amounts.push(salesApi.state.incomeReport.totals.income);
     }
     Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true});
     await salesApi.loadIncomeReport();amounts.push(salesApi.state.incomeReport.totals.income);
     Object.defineProperty(navigator,'onLine',{get:()=>true,configurable:true});
     await salesApi.loadIncomeReport({background:true,force:true});amounts.push(salesApi.state.incomeReport.totals.income);
     await salesApi.writeAppsScriptOutbox([],jobs.map(job=>job.id));
     await salesApi.loadIncomeReport({background:true,force:true});
     return {online:navigator.onLine,amounts,final:salesApi.state.incomeReport.totals.income};
    });
    assert.equal(onlineRefresh.online,true);assert.deepEqual(onlineRefresh.amounts,Array(7).fill(715000));assert.equal(onlineRefresh.final,715000);
    assert.equal(await page.locator('#incomeKpis').innerText(),normal);
   }
   // Clearing the selection by keyboard also restores the same normal KPIs.
   await page.locator('#incomeProductToggle').focus();await page.keyboard.type('agua');await page.keyboard.press('Enter');
   assert.equal(await page.locator('#incomeKpis .is-product').count(),3);
   await page.locator('#clearIncomeProduct').click();
   assert.equal(await page.locator('#incomeKpis').innerText(),normal);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({project:path.basename(root),syntheticRefreshBurst:measurements}));
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
