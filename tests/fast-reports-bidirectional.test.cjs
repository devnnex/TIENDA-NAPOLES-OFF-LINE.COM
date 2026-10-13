const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (from,to) => { const a=source.indexOf('  const '+from+' ='),b=source.indexOf('  const '+to+' =',a+1);assert.ok(a>=0&&b>a);return source.slice(a,b); };
const settle = async () => {for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const filters={dateFrom:'2000-01-01',dateTo:'2099-12-31',paymentMethod:'all',saleType:'all',query:''};
function server(){
 const events=[],calls=[];
 let fail=false;
 return {events,calls,setFail(value){fail=value;},async rpc(name,payload){
  calls.push(name);
  if(fail)return {error:{message:'Sin conexión'}};
  if(name==='publish_report_change'){
   const old=events.find(row=>row.operationId===payload.p_operation_id);
   if(!old)events.push({sequence:events.length+1,operationId:payload.p_operation_id,action:payload.p_action,payload:structuredClone(payload.p_payload)});
   return {data:{ok:true,duplicate:Boolean(old)}};
  }
  if(name==='get_report_changes')return {data:{ok:true,changes:events.filter(row=>row.sequence>payload.p_after).slice(0,200),hasMore:events.filter(row=>row.sequence>payload.p_after).length>200}};
  throw Error(name);
 }};
}
function device(backend,id){
 const storage=new Map(),timers=[],renders=[];
 const state={currentUser:{id,role:'boss'},authToken:id,page:'admin',invoiceHistory:[],inventoryMovements:[],inventoryMeta:{},tables:[],incomeRequestId:1,activeAdminSection:'income',localSupabaseWrites:0};
 const store=(key,value)=>{storage.set(key,structuredClone(value));return true;};
 const context=vm.createContext({state,Map,Set,Object,Date,Number,JSON,navigator:{onLine:true},SUPABASE_CONFIG:{url:'https://test.invalid'},SYNC_INTERVAL_MS:1500,
  SalesShift:require('../sales-shift.js'),normalizeText:value=>String(value).toLowerCase().trim(),incomeRecordSaleType:()=> 'table',
  readLocalJson:(key,fallback)=>structuredClone(storage.has(key)?storage.get(key):fallback),persistDurableJson:async(key,value)=>store(key,value),
  readAppsScriptOutbox:()=>structuredClone(storage.get('jobs')||[]),writeAppsScriptOutbox:async jobs=>store('jobs',jobs),
  persistInvoiceHistory(){},persistInventoryMovements(){},applyRemoteInventoryItems:items=>items.forEach(item=>{state.inventoryMeta[item.productId]=item;}),
  incomeFiltersFromForm:()=>({...filters}),isManager:()=>true,canAccessAdminSection:()=>true,$:()=>null,
  renderIncomeReport:()=>renders.push('sales'),renderInventoryMovements:()=>renders.push('movements'),renderInventory(){},renderPurchaseProductOptions(){},renderPurchaseHistory(){},loadMovementSalesTotals(){},
  transientAppsScriptError:message=>new Error(message),uid:()=> 'op-'+Math.random(),
  getOfflineSyncStatus:async()=>({blocking:state.blocked?1:0}),isSupabaseWriteBlockingJob:()=>Boolean(state.blocked),
  window:{setTimeout:callback=>timers.push(callback),clearInterval(){},setInterval:callback=>timers.push(callback)},localStorage:{setItem(key,value){store(key,JSON.parse(value));}}
 });
 state.sb={rpc:backend.rpc};
 vm.runInContext(section('incomeTotalsFromRecords','localIncomeReport')+section('localIncomeReport','mergeIncomeReport')
  +section('reportMirrorKey','clientBillEnabled')+';globalThis.api={protectCheckoutForFastSync,queueReadyCheckoutReports,queueConfirmedReportChange,flushConfirmedReportChanges,syncConfirmedReports,mergeConfirmedIncomeReport,mergeConfirmedMovements,reportMirror};',context);
 return {context,state,storage,renders,api:context.api};
}
const invoice=(id,quantity=2)=>({id,sessionId:'session-'+id,number:'TN-'+id,createdAt:'2026-10-13T17:00:00Z',totals:{subtotal:quantity*100,total:quantity*100},items:[{id:'line-'+id,menu_item_id:'product',item_name:'Agua',quantity,unit_price:100,unit_cost:40}],payments:[{method:'cash',amount:quantity*100}]});

test('una venta llega de Offline a BCA y de BCA a Offline sin esperar el informe de Google',async()=>{
 for(const [senderId,receiverId] of [['offline','bca'],['bca','offline']]){
  const backend=server(),sender=device(backend,senderId),receiver=device(backend,receiverId),sale=invoice(senderId);
  sender.state.invoiceHistory=[sale];sender.storage.set('jobs',[{id:'job',action:'record_sale',payload:{invoice:sale}}]);
  await sender.api.protectCheckoutForFastSync(sale);await settle();await receiver.api.syncConfirmedReports();
  assert.equal(receiver.state.incomeReport.records.length,1);assert.equal(receiver.state.incomeReport.totals.income,200);
  assert.ok(receiver.renders.includes('sales'));assert.ok(!backend.calls.includes('get_income_report'));
 }
});
test('sin red conserva el aviso y al reconectar lo recupera aunque el receptor no oyera Realtime',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca'),sale=invoice('queued');
 sender.state.invoiceHistory=[sale];sender.storage.set('jobs',[{id:'job',action:'record_sale',payload:{invoice:sale}}]);
 sender.context.navigator.onLine=false;receiver.context.navigator.onLine=false;
 await sender.api.protectCheckoutForFastSync(sale);await settle();assert.equal(backend.events.length,0);
 sender.context.navigator.onLine=true;await sender.api.queueReadyCheckoutReports();await settle();
 assert.equal(backend.events.length,1);assert.equal(await receiver.api.syncConfirmedReports(),false);
 receiver.context.navigator.onLine=true;await receiver.api.syncConfirmedReports();assert.equal(receiver.state.incomeReport.totals.sales,1);
});
test('no publica una venta cuyo cierre de mesa sigue pendiente en Supabase',async()=>{
 const backend=server(),sender=device(backend,'offline'),sale=invoice('blocked');sender.state.blocked=true;
 sender.state.invoiceHistory=[sale];sender.storage.set('jobs',[{id:'job',action:'record_sale',payload:{invoice:sale}}]);
 await sender.api.protectCheckoutForFastSync(sale);await settle();assert.equal(backend.events.length,0);
 sender.state.blocked=false;await sender.api.queueReadyCheckoutReports();await settle();assert.equal(backend.events.length,1);
});
test('una respuesta antigua y un aviso repetido no duplican ventas ni movimientos',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca'),sale=invoice('stable');
 sender.state.invoiceHistory=[sale];sender.state.inventoryMovements=[{movementId:'SALE-stable-product',productId:'product',delta:-2,type:'SALIDA_VENTA',date:sale.createdAt}];
 await sender.api.queueConfirmedReportChange('record_sale',{invoice:sale},{ok:true},'stable');await settle();
 await receiver.api.syncConfirmedReports();await receiver.api.syncConfirmedReports();
 const old={records:[],totals:{sales:0,income:0},totalRecords:0};
 const once=receiver.api.mergeConfirmedIncomeReport(old,filters),twice=receiver.api.mergeConfirmedIncomeReport(once,filters);
 assert.equal(twice.records.length,1);assert.equal(twice.totals.income,200);assert.equal(twice.totals.sales,1);
 const already=receiver.api.mergeConfirmedIncomeReport({...once,recordRows:[{saleId:'stable',row:2}]},filters);
 assert.equal(already.totals.income,200);
 assert.equal(receiver.api.mergeConfirmedMovements(receiver.state.inventoryMovements).length,1);
});
test('las correcciones y eliminaciones confirmadas sobreviven a lecturas anteriores',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca'),sale=invoice('editable');
 await sender.api.queueConfirmedReportChange('record_sale',{invoice:sale},{ok:true},'created');await settle();await receiver.api.syncConfirmedReports();
 const original=structuredClone(receiver.state.incomeReport),changed=invoice('editable',3);
 await sender.api.queueConfirmedReportChange('edit_sale',{invoice:changed},{ok:true},'edited');await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.api.mergeConfirmedIncomeReport(original,filters).totals.income,300);
 await sender.api.queueConfirmedReportChange('delete_sale',{saleId:'editable'},{ok:true},'deleted');await settle();await receiver.api.syncConfirmedReports();
 const merged=receiver.api.mergeConfirmedIncomeReport(original,filters);assert.equal(merged.records.length,0);assert.equal(merged.totals.income,0);
});
test('si falla el envío conserva la cola y el reintento mantiene una única operación',async()=>{
 const backend=server(),sender=device(backend,'offline');backend.setFail(true);
 await sender.api.queueConfirmedReportChange('record_sale',{invoice:invoice('retry')},{ok:true},'retry');await settle();
 assert.equal(sender.storage.get('napoles_report_change_outbox_v1').length,1);
 backend.setFail(false);await sender.api.flushConfirmedReportChanges();await sender.api.flushConfirmedReportChanges();assert.equal(backend.events.length,1);
 assert.equal(sender.storage.get('napoles_report_change_outbox_v1').length,0);
});
test('si falla el guardado de la réplica no adelanta el cursor y recupera el cambio al reintentar',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 await sender.api.queueConfirmedReportChange('record_sale',{invoice:invoice('durable')},{ok:true},'durable');await settle();
 receiver.context.persistDurableJson=async()=>false;assert.equal(await receiver.api.syncConfirmedReports(),false);assert.equal(receiver.api.reportMirror().cursor,0);
 receiver.context.persistDurableJson=async(key,value)=>{receiver.storage.set(key,structuredClone(value));return true;};
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.incomeReport.totals.sales,1);assert.equal(receiver.api.reportMirror().cursor,1);
});
test('el informe posterior confirmado conserva correcciones de Google al conciliar la réplica rápida',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 await sender.api.queueConfirmedReportChange('record_sale',{invoice:invoice('later')},{ok:true},'later');await settle();await receiver.api.syncConfirmedReports();
 const remote=structuredClone(receiver.state.incomeReport);remote.records[0].total=250;remote.totals.income=250;remote.generatedAt='2099-01-01T00:00:00Z';
 const merged=receiver.api.mergeConfirmedIncomeReport(remote,filters);assert.equal(merged.records[0].total,250);assert.equal(merged.totals.income,250);
});
