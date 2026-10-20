const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const {chromium}=require('playwright-core');
test('el respaldo local del inventario aparece verde y los rechazos conservan su estado de error',async()=>{
 const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
 const start=source.indexOf('  const setInventorySyncStatus ='),end=source.indexOf('  const readAppsScriptOutbox =',start);
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:800}});await page.setContent('<span id="inventorySyncStatus" hidden></span>');
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'style.css'),'utf8')});
  await page.addScriptTag({content:'const $=s=>document.querySelector(s),icon=()=>"",escapeHTML=String,refreshIcons=()=>{};'+source.slice(start,end)+'window.setStatus=setInventorySyncStatus;'});
  await page.evaluate(()=>{document.querySelector('#inventorySyncStatus').hidden=false;setStatus('Usando respaldo local','local','cloud-off');});
  assert.equal(await page.locator('#inventorySyncStatus').evaluate(node=>getComputedStyle(node).color),'rgb(13, 112, 67)');
  assert.equal(await page.locator('#inventorySyncStatus').textContent(),' Usando respaldo local');
  await page.evaluate(()=>setStatus('Operacion rechazada','error','triangle-alert'));
  assert.equal(await page.locator('#inventorySyncStatus').evaluate(node=>getComputedStyle(node).color),'rgb(173, 48, 48)');await page.close();
 }}finally{await browser.close();}
});
