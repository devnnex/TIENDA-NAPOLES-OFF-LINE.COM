const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
test('confirmar un abono termina, actualiza la cuenta vigente y permite reintentar sin duplicarlo',async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'admin.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{for(const mode of ['normal','refresh','retry','offline-pending']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.addScriptTag({path:path.join(root,'sales-shift.js')});
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
  await page.addScriptTag({content:source.replace('  return { init };','  return { init, state, openAbonoDialog, bindAccountFeatures, bindCurrencyInputs };').replace('document.addEventListener("DOMContentLoaded", App.init);','window.api=App;')});
  await page.evaluate(mode=>{
   const s=api.state;Object.assign(s,{page:'admin',authToken:'token',currentUser:{id:'user',role:'boss'},activeAdminSection:'service',posFeatures:{abonos:true},business:{business_name:'Tienda Napoles'}});
   s.tables=[{id:'table',table_number:1}];s.items=[{id:'product',name:'Agua',price:10000,is_available:true}];
   s.sessions=[{id:'session',table_id:'table',status:'open',session_items:[{id:'line',menu_item_id:'product',quantity:2,unit_price:10000,status:'served'}]}];
   window.calls=[];window.saved=new Map();s.sb={rpc:async(name,payload)=>{
    calls.push({name,payload});const old=saved.get(payload.payment_id);
    const payment=old||{id:payload.payment_id,session_id:payload.p_session_id,amount:payload.p_amount,payment_method:payload.p_method,created_at:payload.p_created_at,...(mode==='offline-pending'?{_offline_pending:true}:{})};
    saved.set(payment.id,payment);
    if(mode==='retry'&&calls.length===1)return {error:{message:'Respuesta perdida'}};
    if(mode==='refresh')s.sessions=structuredClone(s.sessions);
    return {data:{payment,duplicate:Boolean(old)}};
   }};
   api.bindAccountFeatures();api.bindCurrencyInputs();api.openAbonoDialog('session');
  },mode);
  await page.locator('#abonoForm [name=amount]').fill('5000');
  await page.locator('#abonoForm [name=payment_method]').selectOption('transfer');
  await page.locator('#abonoForm [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#abonoForm').dataset.saving!=='1');
  if(mode==='retry'){
   assert.equal(await page.locator('#abonoDialog').evaluate(e=>e.open),true);
   await page.locator('#abonoForm [type=submit]').click();
   await page.waitForFunction(()=>document.querySelector('#abonoForm').dataset.saving!=='1');
  }
  assert.equal(await page.locator('#abonoDialog').evaluate(e=>e.open),false,mode+': cierra al confirmar');
  const result=await page.evaluate(()=>({payments:api.state.sessions[0].session_payments,calls,saved:saved.size}));
  assert.equal(result.payments?.length,1,mode+': el abono queda en la cuenta actual');
  assert.equal(result.payments[0].amount,5000);assert.equal(result.saved,1);
  if(mode==='retry')assert.equal(result.calls[0].payload.payment_id,result.calls[1].payload.payment_id);
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();await new Promise(done=>server.close(done));}
});
