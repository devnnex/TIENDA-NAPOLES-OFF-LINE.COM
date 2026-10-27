const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');const root=path.resolve(__dirname,'..');
async function launch(){
 const server=http.createServer((req,res)=>{const file=new URL(req.url,'http://local').pathname.slice(1);if(file==='admin.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,file),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<link rel="stylesheet" href="/style.css"></head>'));}else if(['style.css','menu-cards.css'].includes(file)){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(root,file)));}else{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 return {server,browser,url:'http://127.0.0.1:'+server.address().port+'/admin.html',close:async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));}};
}
const instrument=source=>source.replace('  return { init };','  return { init, state, bindAdmin, showAdminSection, renderIncomeReport, loadIncomeReport, incomeFiltersFromForm, refreshBackgroundReports, persistSalesShift, openSalesShift, syncSalesShift, saveSalesShift, addConsumptionBatch, confirmConsumptionSelection, renderConsumptionSelection, openConsumptionDialog };').replace('document.addEventListener("DOMContentLoaded", App.init);','window.repairApi=App;');
test('Hoy/Ayer/semana conservan sus cifras al navegar, las horas del turno se pueden editar y solo datos nuevos cambian los KPI',async()=>{
 const session=await launch(),errors=[];
 try{for(const width of [1440,390]){
  const context=await session.browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(session.url);await page.addScriptTag({path:path.join(root,'sales-shift.js')});await page.addScriptTag({content:instrument(fs.readFileSync(path.join(root,'app.js'),'utf8'))});
  await page.evaluate(async()=>{
   document.body.classList.add('admin-authenticated');Object.assign(repairApi.state,{page:'admin',currentUser:{id:'boss',role:'boss',full_name:'Caja'},authToken:'test',business:{business_name:'Prueba'},businessTimeZone:'America/Bogota',activeAdminSection:'dashboard'});
   const today=SalesShift.dateKey(),yesterday=SalesShift.range('yesterday').dateFrom,older=SalesShift.range('7days').dateFrom;
   window.rows=Array.from({length:130},(_,i)=>({saleId:'s'+i,invoice:'TN-'+i,date:(i<60?today:i<110?yesterday:older)+(i<60?'T10:00:00-05:00':'T23:30:00-05:00'),table:'Mesa 1',total:i<60?100:i<110?200:300,subtotal:i<60?100:i<110?200:300,cost:40,profit:i<60?60:i<110?160:260,items:[{menuItemId:'p',name:'Agua',quantity:1,total:i<60?100:i<110?200:300,cost:40}],payments:[{method:'cash',amount:i<60?100:i<110?200:300}]}));
   window.revision='r1';window.remoteShift={id:'shift-actual',date:today,startMinutes:1140,endMinutes:60,initialBase:50000,base:50000,version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};window.calls=[];
   window.fetch=async(_input,options={})=>{const request=options.body?JSON.parse(options.body):{};calls.push(request);const action=request.action,payload=request.payload||{},filters=payload.filters||{};
    let result={ok:true};if(action==='status')result={ok:true,historyRevision:revision,movementRevision:'m1'};
    if(action==='get_sales_shift')result={ok:true,shift:remoteShift,shifts:[remoteShift]};
    if(action==='save_sales_shift'){remoteShift={...remoteShift,date:payload.date,startMinutes:payload.startMinutes,endMinutes:payload.endMinutes,version:remoteShift.version+1,updatedAt:new Date().toISOString()};result={ok:true,shift:remoteShift,shifts:[remoteShift]};}
    if(action==='get_income_report'){
     const records=rows.filter(row=>SalesShift.matches(row.date,filters)),totals=records.reduce((t,row)=>({income:t.income+row.total,sales:t.sales+1,cash:t.cash+row.total,cost:t.cost+row.cost,profit:t.profit+row.profit}),{income:0,sales:0,cash:0,cost:0,profit:0});
     result={ok:true,intervalApplied:true,filters,revision,generatedAt:new Date().toISOString(),totals,totalRecords:records.length,truncated:records.length>300,records:records.slice(0,300),recordRows:records.map(row=>({saleId:row.saleId,row:rows.indexOf(row)+2}))};
     if(filters.pageRows)result={ok:true,intervalApplied:true,revision,records:filters.pageRows.map(ref=>rows.find(row=>row.saleId===ref.saleId))};
    }
    if(action==='get_inventory_movements')result={ok:true,movements:[],hasMore:false,revision:'m1'};
    return new Response(JSON.stringify(result),{status:200});};
   repairApi.state.sb={rpc:async()=>({data:{ok:true,changes:[],hasMore:false}}),channel:()=>({on(){return this;},subscribe(){return this;},send:async()=> 'ok'})};
   await repairApi.persistSalesShift(remoteShift,null,[remoteShift]);repairApi.bindAdmin();repairApi.showAdminSection('income');
  });
  await page.waitForFunction(()=>repairApi.state.incomeReport?.totals.income===6000&&!repairApi.state.incomeLoading);
  assert.match(await page.locator('#incomeKpis').innerText(),/6[.,]000/);
  await page.locator('[data-income-range="yesterday"]').click();await page.waitForFunction(()=>repairApi.state.incomeReport?.totals.income===10000&&!repairApi.state.incomeLoading);
  await page.locator('[data-income-range="7days"]').click();await page.waitForFunction(()=>repairApi.state.incomeReport?.totals.income===22000&&!repairApi.state.incomeLoading);
  await page.evaluate(()=>{window.originalCard=document.querySelector('#incomeKpis article');window.kpiChanges=0;window.watch=new MutationObserver(()=>kpiChanges++);watch.observe(document.querySelector('#incomeKpis'),{childList:true,subtree:true});});
  for(let i=0;i<3;i++){await page.locator('.admin-sidebar nav a[href="#accounts"]').click();await page.locator('.admin-sidebar nav a[href="#income"]').click();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.evaluate(()=>repairApi.loadIncomeReport({background:true}));}
  const unchanged=await page.evaluate(()=>({same:originalCard===document.querySelector('#incomeKpis article'),changes:kpiChanges,preset:repairApi.state.incomeRangePreset,total:repairApi.state.incomeReport.totals.income}));
  assert.deepEqual(unchanged,{same:true,changes:0,preset:'7days',total:22000});
  await page.evaluate(async()=>{rows.push({...rows[0],saleId:'new',invoice:'TN-new',total:400,profit:360,payments:[{method:'cash',amount:400}]});revision='r2';await repairApi.refreshBackgroundReports({force:true});});
  await page.waitForFunction(()=>repairApi.state.incomeReport.totals.income===22400&&!repairApi.state.incomeLoading);
  assert.equal(await page.evaluate(()=>kpiChanges),1);
  await page.locator('#salesShiftBase').click();await page.waitForFunction(()=>document.querySelector('#salesShiftDialog').open);
  assert.equal(await page.locator('#salesShiftForm [name="action"]').inputValue(),'edit');
  assert.equal(await page.locator('#salesShiftForm [name="start_time"]').isEnabled(),true);assert.equal(await page.locator('#salesShiftForm [name="end_time"]').isEnabled(),true);
  await page.locator('#salesShiftForm [name="start_time"]').fill('800');await page.locator('#salesShiftForm [name="start_period"]').selectOption('AM');await page.locator('#salesShiftForm [name="end_time"]').fill('1100');await page.locator('#salesShiftForm [name="end_period"]').selectOption('PM');
  await page.evaluate(()=>repairApi.syncSalesShift());assert.equal(await page.locator('#salesShiftForm [name="start_time"]').inputValue(),'8:00');
  await page.locator('#salesShiftForm button[type="submit"]').click();
  await page.waitForFunction(()=>!repairApi.state.salesShiftPending&&repairApi.state.salesShift?.startMinutes===480);
  const saved=await page.evaluate(()=>({base:repairApi.state.salesShift.base,end:repairApi.state.salesShift.endMinutes,action:calls.find(call=>call.action==='save_sales_shift')?.payload.action}));assert.deepEqual(saved,{base:50000,end:1380,action:'edit'});
  await page.locator('[data-income-range="today"]').click();await page.waitForFunction(()=>repairApi.state.incomeReport.totals.income===6400&&!repairApi.state.incomeLoading);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await context.close();
 }assert.deepEqual(errors,[]);}finally{await session.close();}
});
