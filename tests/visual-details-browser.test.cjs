const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const clean=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
test('Carta mantiene cuatro opciones, visor adaptable, lupa, arrastre y restablecimiento por doble clic',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 try{for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<640,isMobile:width<640}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(clean('index.html'));
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'style.css'),'utf8')});await page.addStyleTag({content:fs.readFileSync(path.join(root,'menu-cards.css'),'utf8')});
  const positions=await page.locator('.quick-actions .request-btn').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent.trim(),x:node.getBoundingClientRect().x,y:node.getBoundingClientRect().y})));
  assert.deepEqual(positions.map(row=>row.text),['Mesero','Ver cuenta','Carta','Pedir canción']);
  assert.equal(positions[0].y,positions[1].y);assert.equal(width>640?positions[0].y===positions[3].y:positions[2].y>positions[0].y,true);
  if(width<640)assert.equal(positions[0].x,positions[2].x);
  await page.addScriptTag({path:path.join(root,'menu-cards.js')});
  const fixture=await page.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=700;canvas.height=1100;const c=canvas.getContext('2d');c.fillStyle='#fff5da';c.fillRect(0,0,700,1100);c.fillStyle='#102039';c.font='45px sans-serif';c.fillText('CARTA DE PRUEBA',90,140);c.fillText('Bebidas y comidas',90,230);
   const url='https://menu.test/card.png',cards=[{id:'one',name:'Bebidas',image_path:'one'},{id:'two',name:'Comidas',image_path:'two'}];
   MenuCards.init({page:'client',getCurrentTable:()=>({id:'t',qr_code:'qr'}),sb:{rpc:async()=>({data:cards}),storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:url}})})}}});
   return canvas.toDataURL().split(',')[1];
  });
  await page.route('https://menu.test/card.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from(fixture,'base64')}));
  await page.locator('#openMenuCards').click();await page.locator('#menuViewerImage').waitFor({state:'visible'});
  assert.equal(await page.locator('#menuViewerClose').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(220, 38, 38)');
  const footer=await page.locator('.menu-viewer-footer small').evaluate(node=>({size:parseFloat(getComputedStyle(node).fontSize),bottom:node.getBoundingClientRect().bottom,text:node.textContent}));
  assert.ok(footer.size>=16);assert.ok(footer.bottom<=900);assert.match(footer.text,/Mira la carta y pide en línea/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#menuViewerZoom').click();await page.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='true');
  const area=page.locator('#menuViewerImageWrap'),before=await page.locator('#menuViewerImage').evaluate(node=>node.style.transform),bounds=await area.boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2+45,bounds.y+bounds.height/2+65,{steps:5});await page.mouse.up();
  await page.waitForFunction(before=>document.querySelector('#menuViewerImage').style.transform!==before,before);
  await area.dblclick();await page.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='false');
  await area.dblclick();await page.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='true');
  await page.locator('#menuViewerNext').click();await page.waitForFunction(()=>document.querySelector('#menuViewerTitle').textContent==='Comidas'&&document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='false');
  if(width<640){
   const session=await page.context().newCDPSession(page),box=await area.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
   await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-25,y,id:1},{x:x+25,y,id:2}]});
   await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-70,y,id:1},{x:x+70,y,id:2}]});
   await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='true');
   await page.touchscreen.tap(x,y);await page.touchscreen.tap(x,y);
   await page.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='false');await session.detach();
  }
  if(process.env.POS_QA_ARTIFACTS){fs.mkdirSync(process.env.POS_QA_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.POS_QA_ARTIFACTS,'viewer-'+width+'.png')});}
  await page.locator('#menuViewerClose').click();assert.equal(await page.locator('#menuCardsViewer').isVisible(),false);assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}
});
test('los indicadores quedan alineados y el selector busca por palabras sin tildes o por siglas, con raton y teclado',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 try{for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900}});await page.setContent(clean('admin.html'));await page.addStyleTag({content:fs.readFileSync(path.join(root,'style.css'),'utf8')});
  await page.evaluate(()=>{document.body.classList.add('admin-authenticated');document.querySelector('#dashboard').classList.add('section-active');const status=document.querySelector('#realtimeStatus');status.className='live-status live';status.innerHTML='<svg width="18" height="18"></svg> En vivo';});
  if(await page.locator('#softwareStatus').count()){
   const pair=await page.locator('#realtimeStatus, #softwareStatus').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {y:r.y,h:r.height};}));
   assert.ok(Math.abs(pair[0].y-pair[1].y)<1);assert.ok(Math.abs(pair[0].h-pair[1].h)<1);
  }
  const start=source.indexOf('  const renderMovementProductOptions ='),end=source.indexOf('  let completeMovementsPromise =',start);
  const normalize=source.slice(source.indexOf('  const normalizeText ='),source.indexOf('  const escapeHTML ='));
  await page.addScriptTag({content:'const $=s=>document.querySelector(s),icon=()=>"",escapeHTML=s=>String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll("\\\"","&quot;");const state={items:[{id:"gas",name:"Agua con gás"},{id:"beer",name:"Cerveza Águila"},{id:"juice",name:"Jugo de naranja"}],inventoryMovements:[],inventoryMeta:{gas:{code:"ACG"},beer:{code:"CA"}},movementProductFilter:"all"};'+normalize+source.slice(start,end)+'renderMovementProductOptions();bindMovementProductPicker();document.querySelector("#movementProductFilter").addEventListener("change",event=>{state.movementProductFilter=event.target.value;renderMovementProductOptions();});'});
  await page.evaluate(()=>{document.querySelector('#dashboard').classList.remove('section-active');document.querySelector('#movements').classList.add('section-active');});
  const input=page.locator('#movementProductToggle');await input.fill('gas agua');
  assert.equal(await page.locator('#movementProductOptions [data-movement-product="gas"]').isVisible(),true);assert.equal(await page.locator('#movementProductOptions [data-movement-product="beer"]').count(),0);
  await page.locator('[data-movement-product="gas"]').click();assert.equal(await input.inputValue(),'Agua con gás');assert.equal(await page.locator('#movementProductFilter').inputValue(),'gas');
  await input.fill('CA');await input.press('Enter');assert.equal(await page.locator('#movementProductFilter').inputValue(),'beer');
  await input.fill('noexiste');assert.equal(await page.locator('.movement-product-empty').textContent(),'Sin coincidencias');await input.press('Escape');assert.equal(await input.inputValue(),'Cerveza Águila');
  await input.fill('');await page.locator('[data-movement-product="all"]').click();assert.equal(await page.locator('#movementProductFilter').inputValue(),'all');
  await page.close();
 }}finally{await browser.close();}
});
