const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const {chromium}=require('playwright-core');
test('el indicador de pendientes del inventario no ocupa espacio en escritorio ni movil',async()=>{
 const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
 const start=source.indexOf('  const setInventorySyncStatus ='),end=source.indexOf('  const readAppsScriptOutbox =',start);
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 try {
  for(const width of [390,1440]) {
   const page=await browser.newPage({viewport:{width,height:800}});
   await page.setContent('<span class="inventory-sync-status is-local" id="inventorySyncStatus" hidden>Respaldo local</span>');
   await page.addStyleTag({content:fs.readFileSync(path.join(root,'style.css'),'utf8')});
   await page.addScriptTag({content:'const $=s=>document.querySelector(s),icon=()=>"",escapeHTML=String,refreshIcons=()=>{};'+source.slice(start,end)+'window.setStatus=setInventorySyncStatus;'});
   assert.equal(await page.locator('#inventorySyncStatus').isVisible(),false);
   await page.evaluate(()=>setStatus('46 cambios pendientes','pending','refresh-cw'));
   assert.equal(await page.locator('#inventorySyncStatus').isVisible(),false);
   assert.equal(await page.locator('#inventorySyncStatus').evaluate(node=>node.getBoundingClientRect().height),0);
   await page.evaluate(()=>setStatus('Operacion rechazada','error','cloud-off'));
   assert.equal(await page.locator('#inventorySyncStatus').isVisible(),true);
   await page.close();
  }
 } finally { await browser.close(); }
});
