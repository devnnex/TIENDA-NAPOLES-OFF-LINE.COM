const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const section=(start,end)=>{const a=source.indexOf('  const '+start+' ='),b=source.indexOf('  const '+end+' =',a+1);assert.ok(a>=0&&b>a);return source.slice(a,b);};
test('BCA actualiza Agregar consumo al recibir existencias, sin cerrar el modal ni perder la cantidad escrita',async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'admin.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 try{for(const role of ['boss','waiter']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.addScriptTag({path:path.join(root,'sales-shift.js')});
  await page.addScriptTag({content:source.replace('  return { init };','  return { init, state, openConsumptionDialog, openPaymentDialog, renderConsumptionProductOptions, showConsumptionProductOptions, selectConsumptionProduct, applyRemoteInventoryItems, inventoryFor, paidInventoryPlan, validatePaidInventory, refreshConsumptionInventory };').replace('document.addEventListener("DOMContentLoaded", App.init);','window.stockApi=App;')});
  await page.evaluate(role=>{
   document.body.classList.add('admin-authenticated');
   const state=stockApi.state;
   Object.assign(state,{page:'admin',authToken:'test',currentUser:{id:'staff',role,full_name:'Equipo'},activeAdminSection:'service',business:{business_name:'Tienda Napoles'}});
   state.items=[{id:'agua',name:'Agua con gas',price:100,is_available:true}];
   state.inventoryMeta={agua:{stock:0,version:1,updatedAt:'old',unit:'unidad'}};
   state.tables=[{id:'mesa',table_number:1}];
   state.sessions=[{id:'account',table_id:'mesa',status:'open',session_items:[{id:'line',menu_item_id:'agua',item_name:'Agua con gas',quantity:2,unit_price:100,status:'served'}]}];
   window.requests=[];
   window.fetch=async(url,options)=>{const request=JSON.parse(options.body);requests.push(request.action);if(request.action!=='get_inventory')throw Error('Unexpected request '+request.action);return new Promise(resolve=>{window.finishStock=items=>resolve({ok:true,text:async()=>JSON.stringify({ok:true,everInitialized:true,items})});});};
   stockApi.openConsumptionDialog('account');
   document.querySelector('#consumptionProductSearch').value='Agua';
   stockApi.renderConsumptionProductOptions('Agua');stockApi.showConsumptionProductOptions();
   document.querySelector('#consumptionForm').quantity.value='2';
  },role);
  assert.equal(await page.locator('#consumptionDialog').evaluate(node=>node.open),true);
  assert.equal(await page.locator('[data-consumption-product="agua"]').isDisabled(),true);
  await page.waitForFunction(()=>typeof finishStock==='function');
  await page.evaluate(()=>finishStock([{productId:'agua',stock:8,version:2,updatedAt:'new',unit:'unidad',isAvailable:true}]));
  await page.waitForFunction(()=>!document.querySelector('[data-consumption-product="agua"]').disabled);
  assert.match(await page.locator('[data-consumption-product="agua"]').textContent(),/8 unidad/);
  assert.equal(await page.locator('#consumptionForm [name="quantity"]').inputValue(),'2');
  assert.equal(await page.locator('#consumptionProductSearch').inputValue(),'Agua');
  assert.equal(await page.evaluate(()=>stockApi.validatePaidInventory(stockApi.paidInventoryPlan(stockApi.state.sessions[0]))),true);
  await page.evaluate(()=>stockApi.selectConsumptionProduct('agua'));
  assert.equal(await page.locator('#consumptionForm [name="menu_item_id"]').inputValue(),'agua');
  await page.evaluate(()=>{
   stockApi.applyRemoteInventoryItems([{productId:'agua',stock:0,version:1,updatedAt:'old'}]);
   if(stockApi.inventoryFor(stockApi.state.items[0]).stock!==8)throw Error('Older stock replaced the replenishment');
   document.querySelector('#consumptionDialog').close();
   stockApi.openPaymentDialog('account');
  });
  assert.equal(await page.locator('#paymentDialog').evaluate(node=>node.open),true);
  await page.waitForFunction(()=>requests.length===2);
  await page.evaluate(()=>finishStock([{productId:'agua',stock:0,version:3,updatedAt:'now-empty',unit:'unidad'}]));
  await page.waitForFunction(()=>stockApi.inventoryFor(stockApi.state.items[0]).stock===0);
  assert.equal(await page.evaluate(()=>stockApi.validatePaidInventory(stockApi.paidInventoryPlan(stockApi.state.sessions[0]))),false,'Sigue bloqueando cuando el producto realmente esta agotado.');
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
for(const [name,online,fresh,shouldCharge] of [['reposicion remota',true,8,true],['agotamiento real',true,0,false],['sin red',false,8,false]]){
 test('el cobro comprueba existencias actuales antes de rechazar por '+name,async()=>{
  const item={id:'p',name:'Agua'},session={id:'s',session_items:[{id:'line',menu_item_id:'p',quantity:2,status:'served'}]};
  const state={sessions:[session],items:[item],inventoryMeta:{p:{stock:0}},inventoryMovements:[],invoiceHistory:[],activePaymentTotal:100,activePaymentBase:100};
  const buttons=[{disabled:false}],form={session_id:{value:'s'},cash_received:{value:100}},warnings=[];let checks=0,charged=0;
  const context=vm.createContext({state,navigator:{onLine:online},window:{},$$:()=>buttons,
   sessionPaid:()=>0,sessionTotals:()=>({total:100}),integerMoney:Number,tipsEnabled:()=>false,
   paymentFromForm:()=>({method:'cash',payments:[{method:'cash',amount:100}]}),currencyInputNumber:field=>field.value,
   newestSessionItems:session=>session.session_items,inventoryFor:item=>state.inventoryMeta[item.id],
   refreshConsumptionInventory:async()=>{checks++;state.inventoryMeta.p.stock=fresh;return true;},
   toast:message=>warnings.push(message),complete:()=>{charged++;state.paymentProcessing=false;buttons[0].disabled=false;}});
  const payment=section('performPayment','renderConsumptionSelection'),stop=payment.indexOf('    try {\n    const createdAt');assert.ok(stop>0);
  vm.runInContext(section('paidInventoryPlan','applyPaidInventoryLocally')+payment.slice(0,stop)+'complete();\n};globalThis.pay=performPayment;',context);
  await context.pay(form,{value:'save'});assert.equal(charged>0,shouldCharge);assert.equal(checks,online?1:0);
  assert.equal(warnings.length,shouldCharge?0:1);assert.equal(buttons[0].disabled,false);assert.equal(state.paymentProcessing,false);
 });
}
