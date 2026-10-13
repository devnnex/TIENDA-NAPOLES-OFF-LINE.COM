const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
let chromium;try{chromium=require('playwright-core').chromium;}catch{}
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
test('el selector conserva el producto con flechas y los clientes ven el switch en vivo', {skip:!chromium||!fs.existsSync(chrome)},async()=>{
 const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
 const start=source.indexOf('  const renderConsumptionProductOptions ='),end=source.indexOf(source.includes('  const renderCategorySelects =')?'  const renderCategorySelects =':'  const renderMenuManager =',start);
 const hooksStart=source.lastIndexOf('    const productSearch = $("#consumptionProductSearch");'),hooksEnd=source.indexOf('    $("#userForm")',hooksStart);
 const billStart=source.indexOf('  const clientBillEnabled ='),billEnd=source.indexOf('  const saveClientBillVisibility =',billStart);
 assert.ok(start>=0&&end>start&&hooksEnd>hooksStart&&billEnd>billStart);
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:360,height:740}});
  await page.setContent('<main style="padding:20px"><form id="consumptionForm"><input name="menu_item_id" type="hidden"><input name="item_name" type="hidden"><input name="unit_price" type="hidden"><div id="consumptionProductCombobox"><input id="consumptionProductSearch"><div id="consumptionProductOptions" hidden></div></div><small id="consumptionProductHint"></small><input name="quantity" type="number"></form><button class="request-btn" data-request="bill">Ver cuenta</button><div id="billChat">Cuenta</div><div class="cash-change is-sufficient" id="cashChange"><span>Vueltas / cambio</span><strong>$ 7.500</strong><small>Recibido $ 10.000</small></div></main>');
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'style.css'),'utf8')});
  const setup=`const $=(selector,base=document)=>base.querySelector(selector),$$=(selector,base=document)=>[...(base||document).querySelectorAll(selector)];const state={page:'client',business:{client_bill_enabled:true},inventoryMeta:{},items:[{id:'a',name:'Agua',price:1000},{id:'b',name:'Agua con gas',price:1500},{id:'c',name:'Agua saborizada',price:2000}]};const matchingProducts=query=>state.items.filter(row=>row.name.toLowerCase().includes(query.toLowerCase()));const inventoryFor=row=>({code:row.id,stock:10,unit:'unidad'});const escapeHTML=value=>String(value),icon=()=>'',money=value=>'$ '+value;const refreshIcons=()=>{},setCurrencyInputValue=(input,value)=>input.value=value;`;
  await page.addScriptTag({content:setup+source.slice(start,end)+source.slice(billStart,billEnd)+source.slice(hooksStart,hooksEnd)+'window.testApi={state,renderConsumptionProductOptions,syncClientBillVisibility};'});
  const search=page.locator('#consumptionProductSearch');await search.fill('Agua');await search.press('ArrowDown');await search.press('ArrowDown');
  assert.equal(await page.locator('.product-combobox-option.is-selected').getAttribute('data-consumption-product'),'b');
  for(let i=0;i<4;i++)await page.evaluate(()=>testApi.renderConsumptionProductOptions('Agua'));
  await page.evaluate(()=>{testApi.state.items[0].price=1100;testApi.renderConsumptionProductOptions('Agua');});
  assert.equal(await page.locator('.product-combobox-option.is-selected').getAttribute('data-consumption-product'),'b');
  await search.press('Enter');assert.equal(await page.locator('[name=menu_item_id]').inputValue(),'b');
  await page.evaluate(()=>{testApi.state.business.client_bill_enabled=false;testApi.syncClientBillVisibility();});assert.equal(await page.locator('[data-request=bill]').isVisible(),false);
  await page.evaluate(()=>{testApi.state.business.client_bill_enabled=true;testApi.syncClientBillVisibility();});assert.equal(await page.locator('[data-request=bill]').isVisible(),true);
  assert.ok(await page.locator('#cashChange strong').evaluate(node=>parseFloat(getComputedStyle(node).fontSize))>=33);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 }finally{await browser.close();}
});
