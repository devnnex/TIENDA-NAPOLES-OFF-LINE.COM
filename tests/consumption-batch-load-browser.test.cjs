const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');const root=path.resolve(__dirname,'..');

test('OFF-LINE confirma lotes grandes con doble espacio sin duplicarlos y conserva el parpadeo de confirmación',async t=>{
 const source=fs.readFileSync(process.env.POS_BENCHMARK_SOURCE||path.join(root,'app.js'),'utf8');
 const instrument=source.replace('  return { init };','  return { init, state, bindAdmin, openConsumptionDialog, renderConsumptionSelection };').replace('document.addEventListener("DOMContentLoaded", App.init);','window.batchApi=App;');
 const server=http.createServer((req,res)=>{if(req.url==='/admin.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'admin.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<link rel="stylesheet" href="/style.css"></head>'));}else if(req.url==='/style.css'||req.url.startsWith('/menu-cards.css')){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(root,req.url.startsWith('/style')?'style.css':'menu-cards.css')));}else{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin.html');await page.addScriptTag({path:path.join(root,'sales-shift.js')});await page.addScriptTag({content:instrument});
  await page.evaluate(()=>{
   document.body.classList.add('admin-authenticated');const table={id:'table',table_number:1,table_name:'Mesa 1',is_active:true},user={id:'boss',role:'boss',full_name:'Caja'};
   const items=Array.from({length:120},(_,i)=>({id:'p'+i,name:'Producto '+i,price:1000,is_active:true}));
   Object.assign(batchApi.state,{page:'admin',currentUser:user,authToken:'test',business:{business_name:'Prueba'},activeAdminSection:'service',tables:[table],items,inventoryMeta:Object.fromEntries(items.map(item=>[item.id,{stock:10000,costPrice:400,code:item.id}])),sessions:[{id:'account',table_id:table.id,status:'open',assigned_waiter_id:user.id,assigned_waiter:user,restaurant_tables:table,payer_name:'',session_items:Array.from({length:500},(_,i)=>({id:'existing'+i,session_id:'account',table_id:table.id,menu_item_id:'p'+i%120,item_name:'Producto '+i%120,unit_price:1000,quantity:1,status:'served',created_at:new Date(Date.now()-3600000+i).toISOString()}))}]});
   window.inserted=[];window.fetch=()=>new Promise(()=>{});
   batchApi.state.sb={from:entity=>({insert(rows){if(entity!=='session_items')throw Error('Unexpected write '+entity);inserted.push(rows);return {select:async()=>({data:rows.map(row=>({...row,created_at:new Date().toISOString()})),error:null})};}}),rpc:async()=>({data:{ok:true,changes:[],hasMore:false}})};
   batchApi.bindAdmin();window.timings=[];window.lags=[];let last=performance.now();window.heartbeat=setInterval(()=>{const now=performance.now();lags.push(now-last);last=now;},16);
  });
  for(let batch=0;batch<3;batch++){
   await page.evaluate(()=>{batchApi.openConsumptionDialog('account');batchApi.state.consumptionDrafts=Array.from({length:80},(_,i)=>({menuItemId:'p'+i,itemName:'Producto '+i,unitPrice:1000,quantity:1,notes:'',payerName:''}));batchApi.renderConsumptionSelection();});
   await page.locator('#consumptionProductSearch').focus();await page.keyboard.press('Space');
   await page.evaluate(()=>{window.started=performance.now();const observer=new MutationObserver(()=>{if(document.querySelectorAll('#tableConsumptionPreview .consumption-just-added').length===80){timings.push(performance.now()-started);window.flashAt=performance.now();observer.disconnect();}});observer.observe(document.querySelector('#tableConsumptionPreview'),{childList:true,attributes:true,subtree:true});});
   await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelectorAll('#tableConsumptionPreview .consumption-just-added').length===80);
   assert.equal(await page.locator('#consumptionDialog').evaluate(node=>node.open),true);assert.equal(await page.locator('#consumptionForm').evaluate(node=>node.inert),true);
   await page.keyboard.press('Space');await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>inserted.length),batch+1);
   await page.waitForFunction(()=>!document.querySelector('#consumptionDialog').open);assert.ok(await page.evaluate(()=>performance.now()-flashAt)>=2100,'Conserva los 2,2 s del parpadeo.');
  }
  const result=await page.evaluate(()=>{clearInterval(heartbeat);const rows=batchApi.state.sessions[0].session_items;return {timings,maxLag:Math.max(...lags),batches:inserted.map(rows=>rows.length),lines:rows.length,ids:new Set(rows.map(row=>row.id)).size};});
  assert.deepEqual(result.batches,[80,80,80]);assert.equal(result.lines,740);assert.equal(result.ids,740);assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify(result));if(!process.env.POS_BENCHMARK_SOURCE){assert.ok(Math.max(...result.timings)<1500,'La confirmación local no debe bloquear varios segundos.');assert.ok(result.maxLag<1500,'La interfaz debe seguir atendiendo eventos.');}
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
