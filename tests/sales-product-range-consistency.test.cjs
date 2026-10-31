const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const SalesShift=require('../sales-shift.js');
function block(name){const a=source.indexOf('  const '+name+' ='),b=source.indexOf('\n  const ',a+1);assert.ok(a>=0&&b>a,name);return source.slice(a,b);}
function harness(items=[]){
 const context=vm.createContext({state:{items},SalesShift});
 vm.runInContext(block('normalizeText')+block('incomeProductSummary')+';globalThis.summary=incomeProductSummary;',context);
 return context;
}
const row=(saleId,name,quantity,date)=>({saleId,date,total:quantity*100+900,items:[{name,quantity,total:quantity*100,cost:quantity*20},{name:'Otro producto',quantity:1,total:900,cost:100}]});
const report=records=>({records,totalRecords:records.length,localOnly:false});
test('soda/ginger y otros productos conservan el mismo criterio al ampliar mes a año, incluso con nombres históricos exactos',()=>{
 for(const name of ['Soda/Ginger','Agua','Cerveza','Café']){
  const h=harness([{id:'p',name:name+' grande'}]);
  const october=row('october',name+' grande',32,'2026-10-20T12:00:00-05:00');
  const june=row('june',name,26,'2026-06-20T12:00:00-05:00');
  const before=JSON.stringify([october,june]);
  const month=h.summary(report([october]),name),year=h.summary(report([october,june]),name);
  assert.equal(month.quantity,32,name);
  assert.equal(year.quantity,58,name+' debe incluir las 32 unidades del mes y las 26 anteriores');
  assert.equal(year.income,5800,name);assert.equal(year.cost,1160,name);assert.equal(year.sales,2,name);
  assert.equal(JSON.stringify([october,june]),before);
 }
});
test('un producto exacto del catálogo conserva su identidad y excluye otros productos con nombres más largos en ambos rangos',()=>{
 const h=harness([{id:'soda',name:'SODA / GINGER'},{id:'light',name:'Soda/Ginger Light'}]);
 const october=row('october','SODA / GINGER',32,'2026-10-20T12:00:00-05:00');
 const june=row('june','Soda/Ginger',26,'2026-06-20T12:00:00-05:00');
 const other=row('other','Soda/Ginger Light',100,'2026-05-20T12:00:00-05:00');
 assert.equal(h.summary(report([october]),'soda/ginger').quantity,32);
 assert.equal(h.summary(report([october,june,other]),'soda/ginger').quantity,58);
});
test('una copia local antigua no sustituye las líneas completas y confirmadas del periodo consultado',()=>{
 const h=harness([{id:'soda',name:'Soda/Ginger'}]);
 const rows=[row('october','Soda/Ginger',32,'2026-10-20'),row('june','Soda/Ginger',26,'2026-06-20')];
 for(const localOnly of [false,true]){
  const result=h.summary({...report(rows),localOnly,allLocalRecords:[rows[1]]},'soda/ginger');
  assert.equal(result.quantity,58);assert.equal(result.income,5800);assert.equal(result.complete,true);
 }
});
test('más de 300 facturas locales completas siguen participando sin cargar páginas remotas',()=>{
 const h=harness([{id:'soda',name:'Soda/Ginger'}]);
 const rows=Array.from({length:650},(_,i)=>row(String(i),'Soda/Ginger',1,'2026-10-20'));
 const result=h.summary({...report(rows.slice(0,300)),localOnly:true,truncated:true,totalRecords:650,allLocalRecords:rows},'soda/ginger');
 assert.equal(result.quantity,650);assert.equal(result.income,65000);assert.equal(result.complete,true);
});
test('SODA/GINGER del catálogo: las ventas recién sincronizadas se cuentan en el año aunque la copia local inicial fuera anterior',()=>{
 const productId='a8886db9-0f10-4fa2-8bc6-265664636355';
 const h=harness([{id:productId,name:'SODA/GINGER'}]);
 const invoice=(id,quantity,date)=>({id,sessionId:id,number:id,createdAt:date,totals:{subtotal:quantity*100,total:quantity*100},
  items:[{menu_item_id:productId,item_name:'SODA/GINGER',quantity,unit_price:100,unit_cost:20}],payments:[{method:'cash',amount:quantity*100}]});
 const old=invoice('old',26,'2026-06-20T12:00:00-05:00'),fresh=invoice('fresh',32,'2026-10-20T12:00:00-05:00');
 const common={paymentMethod:'all',saleType:'all',query:'soda/ginger',dateTo:'2026-10-31'};
 const year={...common,dateFrom:'2026-01-01'},month={...common,dateFrom:'2026-10-01'};
 Object.assign(h.state,{invoiceHistory:[old],inventoryMeta:{}});
 Object.assign(h,{reportMirror:()=>({deleted:{},sales:{fresh:{...fresh,googlePending:true}}}),readAppsScriptOutbox:()=>[]});
 vm.runInContext(block('incomeTotalsFromRecords')+block('localIncomeRecords')+block('localIncomeReport')+block('mergeConfirmedIncomeReport')+
  ';globalThis.local=localIncomeReport;globalThis.merge=mergeConfirmedIncomeReport;',h);
 const cachedYear=h.local(year);
 assert.equal(h.summary(cachedYear).quantity,26);
 h.state.invoiceHistory.push(fresh);
 assert.equal(h.summary(h.local(month)).quantity,32);
 const confirmedYear=h.merge(cachedYear,year);
 if(cachedYear.allLocalRecords)assert.equal(confirmedYear.allLocalRecords.length,1,'la copia original aún existe en la estructura del informe');
 assert.equal(confirmedYear.records.length,2,'la sincronización ya incorporó la venta nueva');
 assert.equal(h.summary(confirmedYear).quantity,58);
 assert.equal(h.summary(confirmedYear).income,5800);
});
