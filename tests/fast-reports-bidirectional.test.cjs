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
  if(name==='publish_report_changes_batch'){
   const results=[];
   for(const change of payload.p_changes){
    let old=events.find(row=>row.operationId===change.operationId);
    if(!old){old={sequence:events.length+1,operationId:change.operationId,action:change.action,payload:structuredClone(change.payload)};events.push(old);}
    results.push({operationId:change.operationId,sequence:old.sequence});
   }
   return {data:{ok:true,results}};
  }
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
 const context=vm.createContext({state,Map,Set,Object,Date,Number,JSON,AbortController,clearTimeout,APPS_SCRIPT_TIMEOUT_MS:45000,isAppsScriptConfigured:()=>true,getAppsScriptUrl:()=>"https://test.invalid",location:{origin:"https://test.invalid"},pendingInventoryProductIds:()=>state.pendingProducts||new Set(),navigator:{onLine:true},SUPABASE_CONFIG:{url:'https://test.invalid'},SYNC_INTERVAL_MS:1500,
  SalesShift:require('../sales-shift.js'),normalizeText:value=>String(value).toLowerCase().trim(),incomeRecordSaleType:()=> 'table',
  readLocalJson:(key,fallback)=>structuredClone(storage.has(key)?storage.get(key):fallback),persistDurableJson:async(key,value)=>store(key,value),
  readAppsScriptOutbox:()=>structuredClone(storage.get('jobs')||[]),writeAppsScriptOutbox:async jobs=>store('jobs',jobs),
  persistInvoiceHistory(){},persistInventoryMovements(){},applyRemoteInventoryItems:(items,{preserveProductIds=new Set()}={})=>items.forEach(item=>{if(!preserveProductIds.has(item.productId))state.inventoryMeta[item.productId]=item;}),
  incomeFiltersFromForm:()=>({...filters}),isManager:()=>true,canAccessAdminSection:()=>true,$:()=>null,
  renderIncomeReport:()=>renders.push('sales'),renderInventoryMovements:()=>renders.push('movements'),renderInventory(){},renderPurchaseProductOptions(){},renderPurchaseHistory(){},loadMovementSalesTotals(){},
  transientAppsScriptError:message=>new Error(message),uid:()=> 'op-'+Math.random(),
  getOfflineSyncStatus:async()=>({blocking:state.blocked?1:0}),isSupabaseWriteBlockingJob:()=>Boolean(state.blocked),
  window:{setTimeout:callback=>timers.push(callback),clearInterval(){},setInterval:callback=>timers.push(callback)},localStorage:{setItem(key,value){store(key,JSON.parse(value));}}
 });
 state.sb={rpc:backend.rpc};
 vm.runInContext(section('incomeTotalsFromRecords','localIncomeReport')+section('localIncomeReport','mergeIncomeReport')
  +section('reportMirrorKey','clientBillEnabled')+section('appsScriptRequest',source.includes('  const readAppsScriptStatus =')?'readAppsScriptStatus':'inventoryPayload')+';globalThis.api={appsScriptRequest,protectCheckoutForFastSync,queueReadyCheckoutReports,queueConfirmedReportChange,flushConfirmedReportChanges,syncConfirmedReports,mergeConfirmedIncomeReport,mergeConfirmedMovements,reportMirror};',context);
 return {context,state,storage,renders,api:context.api};
}
const invoice=(id,quantity=2)=>({id,sessionId:'session-'+id,number:'TN-'+id,createdAt:'2026-10-13T17:00:00Z',totals:{subtotal:quantity*100,total:quantity*100},items:[{id:'line-'+id,menu_item_id:'product',item_name:'Agua',quantity,unit_price:100,unit_cost:40}],payments:[{method:'cash',amount:quantity*100}]});

test('una ráfaga pendiente viaja en lotes, conserva todo al perder una respuesta y pinta los KPI una vez al recibirla',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');
 const changes=Array.from({length:50},(_,i)=>({operationId:'burst-'+i,action:'record_sale',payload:{invoice:invoice('burst-'+i)}}));
 sender.storage.set('napoles_report_change_outbox_v1',changes);
 let lose=true;sender.state.sb={rpc:async(name,payload)=>{const reply=await backend.rpc(name,payload);if(lose){lose=false;throw Error('respuesta perdida');}return reply;}};
 assert.equal(await sender.api.flushConfirmedReportChanges(),false);
 assert.equal(sender.storage.get('napoles_report_change_outbox_v1').length,50);
 assert.equal(await sender.api.flushConfirmedReportChanges(),true);
 assert.equal(backend.events.length,50);assert.equal(sender.storage.get('napoles_report_change_outbox_v1').length,0);
 assert.equal(backend.calls.filter(name=>name==='publish_report_changes_batch').length,4);
 assert.ok(!backend.calls.includes('publish_report_change'));
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.incomeReport.totals.sales,50);
 assert.equal(receiver.renders.filter(name=>name==='sales').length,1);
});

test('una segunda página fallida conserva el cursor anterior y no aplica una recepción incompleta',async()=>{
 const backend=server(),receiver=device(backend,'receiver');
 backend.events.push(...Array.from({length:301},(_,i)=>({sequence:i+1,operationId:'page-'+i,action:'record_sale',payload:{invoice:invoice('page-'+i),items:[{productId:'p',stock:i}]}})));
 let fail=true;receiver.state.sb={rpc:async(name,payload)=>fail&&payload.p_after>0?{error:{message:'sin red'}}:backend.rpc(name,payload)};
 assert.equal(await receiver.api.syncConfirmedReports(),false);
 assert.equal(receiver.api.reportMirror().cursor,0);assert.equal(receiver.state.invoiceHistory.length,0);
 assert.equal(receiver.state.inventoryMeta.p,undefined);
 fail=false;assert.equal(await receiver.api.syncConfirmedReports(),true);
 assert.equal(receiver.api.reportMirror().cursor,301);assert.equal(receiver.state.incomeReport.totals.sales,301);
 assert.equal(receiver.state.inventoryMeta.p.stock,300);
 assert.equal(receiver.renders.filter(name=>name==='sales').length,1);
});

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

 test('sin la nueva funcion de lotes conserva compatibilidad y vacia la cola confirmada',async()=>{
 const backend=server(),sender=device(backend,'sender');
 sender.storage.set('napoles_report_change_outbox_v1',Array.from({length:3},(_,i)=>({operationId:'compatible-'+i,action:'record_sale',payload:{invoice:invoice('compatible-'+i)}})));
 let attempts=0;sender.state.sb={rpc:async(name,payload)=>{if(name==='publish_report_changes_batch'){attempts++;return {error:{code:'PGRST202',message:'Missing function'}};}return backend.rpc(name,payload);}};
 assert.equal(await sender.api.flushConfirmedReportChanges(),true);assert.equal(attempts,1);
 assert.equal(backend.events.length,3);assert.equal(sender.storage.get('napoles_report_change_outbox_v1').length,0);
 });
 test('no retira operaciones por acuses ausentes o ajenos al lote enviado',async()=>{
 const backend=server(),sender=device(backend,'sender');
 sender.storage.set('napoles_report_change_outbox_v1',Array.from({length:3},(_,i)=>({operationId:'partial-'+i,action:'record_sale',payload:{invoice:invoice('partial-'+i)}})));
 let attempts=0;sender.state.sb={rpc:async()=>{attempts++;return attempts===1?{data:{ok:true,results:[{operationId:'partial-0'},{operationId:'unrequested'}]}}:{error:{message:'sin red'}};}};
 assert.equal(await sender.api.flushConfirmedReportChanges(),false);
 assert.deepEqual(sender.storage.get('napoles_report_change_outbox_v1').map(change=>change.operationId),['partial-1','partial-2']);
 });

const billedMovement = sale => ({ movementId:'SALE-'+sale.id+'-product', productId:'product', product:'Agua', type:'SALIDA_VENTA', delta:-sale.items[0].quantity, before:100, after:100-sale.items[0].quantity, sessionId:sale.sessionId, reference:sale.number });
async function stockedReceiver(backend,receiver,count=50) {
 const invoices=Array.from({length:count},(_,i)=>invoice('existing-'+i));
 backend.events.push(...invoices.map((sale,i)=>({sequence:i+1,action:'record_sale',payload:{invoice:sale,movements:[billedMovement(sale)]}})));
 await receiver.api.syncConfirmedReports();
 receiver.state.incomeReport.recordRows=receiver.state.incomeReport.records.map((record,i)=>({saleId:record.saleId,row:i+2}));
 receiver.renders.length=0;return invoices;
}
test('borrar cincuenta ventas sin red actualiza BCA en bloque al reconectar sin esperar Google',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const invoices=await stockedReceiver(backend,receiver),stale=structuredClone(receiver.state.incomeReport);
 sender.context.navigator.onLine=false;
 sender.storage.set('jobs',invoices.map((sale,i)=>({id:'delete-'+i,operationId:'delete-'+i,status:'pending',action:'delete_sale',payload:{saleId:sale.id,saleLink:{sessionId:sale.sessionId,invoice:sale.number},previousRecord:stale.records.find(row=>row.saleId===sale.id)}})));
 await sender.api.queueReadyCheckoutReports();assert.equal(backend.events.length,50);
 sender.context.navigator.onLine=true;await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.incomeReport.totals.sales,0);assert.equal(receiver.state.incomeReport.totals.income,0);
 assert.equal(receiver.state.inventoryMovements.length,0);assert.equal(receiver.renders.filter(name=>name==='sales').length,1);
 assert.equal(sender.storage.get('jobs').length,50,'Los avisos no eliminan el respaldo pendiente de Google.');
 assert.equal(backend.calls.filter(name=>name==='publish_report_changes_batch').length,3);
 assert.equal(receiver.api.mergeConfirmedIncomeReport({...stale,generatedAt:'2099-01-01'},filters).totals.sales,0);
 const count=backend.events.length;await sender.api.queueReadyCheckoutReports();await settle();assert.equal(backend.events.length,count);
 const paged={...stale,records:stale.records.slice(0,10)};
 const merged=receiver.api.mergeConfirmedIncomeReport(paged,filters);assert.equal(merged.totals.sales,0);
 assert.equal(receiver.api.mergeConfirmedIncomeReport(merged,filters).totals.sales,0);
});
test('editar cincuenta ventas sin red sustituye importes y unidades facturadas en BCA al reconectar',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const invoices=await stockedReceiver(backend,receiver),stale=structuredClone(receiver.state.incomeReport);
 sender.storage.set('jobs',invoices.map((sale,i)=>({id:'edit-'+i,operationId:'edit-'+i,status:'pending',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:stale.records.find(row=>row.saleId===sale.id)}})));
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.incomeReport.totals.sales,50);assert.equal(receiver.state.incomeReport.totals.income,15000);
 assert.equal(receiver.state.inventoryMovements.reduce((sum,row)=>sum+row.delta,0),-150);
 assert.equal(receiver.renders.filter(name=>name==='sales').length,1);
 const old=receiver.api.mergeConfirmedIncomeReport({...stale,generatedAt:'2099-01-01'},filters);assert.equal(old.totals.income,15000);
 const paged=receiver.api.mergeConfirmedIncomeReport({...stale,records:stale.records.slice(0,10)},filters);
 assert.equal(paged.totals.income,15000);assert.equal(receiver.api.mergeConfirmedIncomeReport(paged,filters).totals.income,15000);
});
test('una confirmacion tardia del alta o de una edicion anterior no revive la venta borrada',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const [sale]=await stockedReceiver(backend,receiver,1),before=receiver.state.incomeReport.records[0];
 sender.storage.set('jobs',[{id:'edit-old',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:before}},
 {id:'delete-new',action:'delete_sale',payload:{saleId:sale.id,saleLink:{sessionId:sale.sessionId,invoice:sale.number},previousRecord:before}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.incomeReport.totals.sales,0);
 await sender.api.queueConfirmedReportChange('record_sale',{invoice:sale},{ok:true},'create-receipt');await settle();
 await sender.api.queueConfirmedReportChange('edit_sale',{invoice:invoice(sale.id,3)},{ok:true},'edit-old');await settle();
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.incomeReport.totals.sales,0);assert.equal(receiver.state.inventoryMovements.length,0);
 await sender.api.queueConfirmedReportChange('delete_sale',{saleId:sale.id},{ok:true},'delete-new');await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.api.reportMirror().pendingSaleMutations[sale.id],undefined);assert.equal(receiver.state.incomeReport.totals.sales,0);
});

test('dos ediciones pendientes conservan la base remota fuera de pagina y el acuse final no restaura cantidades anteriores',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const [sale]=await stockedReceiver(backend,receiver,1),before=receiver.state.incomeReport.records[0];
 const stale=structuredClone(receiver.state.incomeReport);stale.records=[];
 sender.storage.set('jobs',[{id:'edit-first',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:before}},
 {id:'edit-last',action:'edit_sale',payload:{invoice:invoice(sale.id,4),previousRecord:{...before,total:300,subtotal:300,payments:[{method:'cash',amount:300}]}}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.api.mergeConfirmedIncomeReport(stale,filters).totals.income,400);
 await sender.api.queueConfirmedReportChange('edit_sale',{invoice:invoice(sale.id,3)},{ok:true},'edit-first');await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.incomeReport.totals.income,400);assert.equal(receiver.state.inventoryMovements.reduce((sum,row)=>sum+row.delta,0),-4);
 await sender.api.queueConfirmedReportChange('edit_sale',{invoice:invoice(sale.id,4)},{ok:true},'edit-last');await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.incomeReport.totals.income,400);assert.equal(receiver.state.inventoryMovements.reduce((sum,row)=>sum+row.delta,0),-4);
 const authoritative=[billedMovement(sale),{movementId:'EDIT-real',type:'CORRECCION_VENTA',productId:'product',delta:-2}];
 const real=receiver.api.mergeConfirmedMovements(authoritative,'',{authoritative:true,readStartedAt:Date.parse('2099-01-01')});
 assert.equal(real.find(row=>row.type==='SALIDA_VENTA').delta,-2);
 assert.equal(receiver.api.mergeConfirmedMovements(real).find(row=>row.type==='SALIDA_VENTA').delta,-2);
});

test('un lote mixto publica una sola foto de inventario con todos los productos incluso si el ultimo recibo falla',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const ops=[{operationId:'create-a',action:'record_sale',payload:{invoice:{...invoice('a'),items:[{menu_item_id:'a',quantity:1}]}}},
 {operationId:'delete-c',action:'delete_sale',payload:{saleId:'c'}},
 {operationId:'edit-b',action:'edit_sale',payload:{invoice:{...invoice('b'),items:[{menu_item_id:'b',quantity:1}]}}},
 {operationId:'fail-d',action:'edit_sale',payload:{invoice:invoice('d')}}];
 const snapshot=[{productId:'a',stock:7},{productId:'b',stock:8},{productId:'c',stock:9}];
 sender.context.fetch=async()=>({ok:true,text:async()=>JSON.stringify({ok:true,results:ops.map((op,i)=>({operationId:op.operationId,result:i===3?{ok:false,retryable:true,items:snapshot}:{ok:true}}))})});
 await sender.api.appsScriptRequest('sync_sales_batch',{operations:ops});await settle();
 const withStock=backend.events.filter(event=>event.payload.items.length);
 assert.equal(withStock.length,1);assert.deepEqual(withStock[0].payload.items,snapshot);
 receiver.state.pendingProducts=new Set(['b']);receiver.state.inventoryMeta.b={productId:'b',stock:99};
 await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.inventoryMeta.a.stock,7);assert.equal(receiver.state.inventoryMeta.b.stock,99);assert.equal(receiver.state.inventoryMeta.c.stock,9);
});
test('la edicion local actualiza el stock por diferencia antes de esperar la red',()=>{
 const backend=server(),sender=device(backend,'offline');sender.state.items=[{id:'product'},{id:'other'}];
 sender.state.inventoryMeta={product:{stock:10,version:7},other:{stock:20,version:8}};
 vm.runInContext(section('applyEditedSaleStock','replaceEditedIncomeRecord')+';globalThis.editStock=applyEditedSaleStock;',sender.context);
 sender.context.editStock({items:[{menuItemId:'product',quantity:2}]},{items:[{menu_item_id:'product',quantity:3}]});assert.equal(sender.state.inventoryMeta.product.stock,9);
 sender.context.editStock({items:[{menuItemId:'product',quantity:3}]},{items:[{menu_item_id:'other',quantity:4}]});
 assert.equal(sender.state.inventoryMeta.product.stock,12);assert.equal(sender.state.inventoryMeta.other.stock,16);assert.equal(sender.state.inventoryMeta.product.version,7);
});

test('un rechazo permanente retira la proyeccion rapida y recupera la venta canonica',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const [sale]=await stockedReceiver(backend,receiver,1),record=receiver.state.incomeReport.records[0];
 sender.storage.set('jobs',[{id:'rejected',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:record}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.incomeReport.totals.income,300);
 sender.context.fetch=async()=>({ok:true,text:async()=>JSON.stringify({ok:true,records:[record]})});
 await sender.api.queueConfirmedReportChange('edit_sale',{invoice:invoice(sale.id,3)},{ok:false,retryable:false,error:'Sin existencias'},'rejected');
 await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.incomeReport.totals.income,200);assert.equal(receiver.api.reportMirror().pendingSaleMutations[sale.id],undefined);
 assert.equal(sender.storage.get('jobs').length,1);
});

test('la edicion conserva consumos previos y agrega solo la diferencia sin duplicarla en refrescos',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const [sale]=await stockedReceiver(backend,receiver,1),before=receiver.state.incomeReport.records[0];
 receiver.state.inventoryMovements=[{...billedMovement(sale),movementId:'consume',type:'CONSUMO_MESA',delta:-2}];
 receiver.api.reportMirror().movements={consume:receiver.state.inventoryMovements[0]};
 sender.storage.set('jobs',[{id:'edit-consumption',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:before}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
 const once=receiver.api.mergeConfirmedMovements(receiver.state.inventoryMovements),twice=receiver.api.mergeConfirmedMovements(once);
 assert.equal(twice.length,2);assert.equal(twice.reduce((sum,row)=>sum+row.delta,0),-3);
 assert.equal(twice.find(row=>row.type==='CONSUMO_MESA').delta,-2);
});

test('la recepcion usa el aplicador real de inventario en ambos proyectos y conserva productos con cambios pendientes',async()=>{
 const backend=server(),receiver=device(backend,'receiver');receiver.state.items=[{id:'a',name:'Agua'},{id:'b',name:'Pan'}];
 receiver.state.inventoryMeta={a:{stock:1},b:{stock:99}};receiver.storage.set('jobs',[{id:'pending',status:'pending',action:'edit_sale',payload:{invoice:{items:[{menu_item_id:'b'}]}}}]);
 Object.assign(receiver.context,{inventoryFor:item=>receiver.state.inventoryMeta[item.id],inventoryStatus:()=> 'available',productAcronym:()=>'',persistInventoryStore(){},persistBootstrapCache(){},renderMenuManager(){}});
 const offline=!source.includes('  const pendingInventoryIds =');
 vm.runInContext(section(offline?'isPendingInventoryJob':'pendingInventoryIds',offline?'enqueueAppsScriptJob':'enqueueAppsScriptJob'),receiver.context);
 backend.events.push({sequence:1,action:'edit_sale',payload:{items:[{productId:'a',stock:7},{productId:'b',stock:8}]}});
 assert.equal(await receiver.api.syncConfirmedReports(),true);assert.equal(receiver.state.inventoryMeta.a.stock,7);assert.equal(receiver.state.inventoryMeta.b.stock,99);
});

test('editar y despues borrar retira el importe original fuera de pagina una sola vez',async()=>{
 const backend=server(),sender=device(backend,'offline'),receiver=device(backend,'bca');
 const [sale]=await stockedReceiver(backend,receiver,1),before=receiver.state.incomeReport.records[0];
 const paged={...structuredClone(receiver.state.incomeReport),records:[]};
 sender.storage.set('jobs',[{id:'edit-then-delete',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:before}},
 {id:'delete-after-edit',action:'delete_sale',payload:{saleId:sale.id,previousRecord:{...before,total:300,subtotal:300,payments:[{method:'cash',amount:300}]}}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
 const merged=receiver.api.mergeConfirmedIncomeReport(paged,filters);assert.equal(merged.totals.income,0);assert.equal(merged.totals.sales,0);
 assert.equal(receiver.api.mergeConfirmedIncomeReport(merged,filters).totals.income,0);
});

test('borrar localmente y recibir su propio lote deja dinero y existencias en cero ventas sin restar dos veces',async()=>{
 const backend=server(),sender=device(backend,'offline');const invoices=await stockedReceiver(backend,sender,50),remoteBefore=structuredClone(sender.state.incomeReport);
 Object.assign(sender.context,{isBoss:()=>true,canDeleteRecords:()=>true,toast(){},persistInventoryStore(){},inventoryFor:item=>sender.state.inventoryMeta[item.id],
 enqueueAppsScriptJob:(action,payload,key)=>{const jobs=sender.storage.get('jobs')||[];jobs.push({id:key,operationId:key,status:'pending',action,payload});sender.storage.set('jobs',jobs);},
 $:selector=>selector==='#deleteIncomeDialog'?{close(){}}:null});
 sender.state.items=[{id:'product'}];sender.state.inventoryMeta.product={stock:0};sender.context.navigator.onLine=false;
 vm.runInContext(section('deleteIncomeSale','applyEditedSaleStock')+section('mergeIncomeReport','setIncomeReportStatus')+';globalThis.actual={deleteIncomeSale,mergeIncomeReport};',sender.context);
 for(const sale of invoices)await sender.context.actual.deleteIncomeSale({sale_id:{value:sale.id}});
 assert.equal(sender.state.incomeReport.totals.income,0);assert.equal(sender.state.inventoryMeta.product.stock,100);
 sender.context.navigator.onLine=true;await sender.api.queueReadyCheckoutReports();await settle();await sender.api.syncConfirmedReports();
 assert.equal(sender.state.incomeReport.totals.income,0);assert.equal(sender.state.incomeReport.totals.sales,0);
 assert.equal(sender.state.inventoryMovements.length,0);assert.equal(sender.state.inventoryMeta.product.stock,100);
 assert.equal(sender.context.actual.mergeIncomeReport(remoteBefore,filters).totals.income,0,'El informe remoto anterior tampoco vuelve a descontar las ventas pendientes.');
 const emptyRemote={records:[],recordRows:[],totals:{income:0,sales:0,cash:0},totalRecords:0,generatedAt:'2099-01-01'};
 sender.state.incomeReport=sender.context.actual.mergeIncomeReport(emptyRemote,filters);
 assert.equal(sender.state.incomeReport.totals.income,0);
});

test('rafagas de altas ediciones y borrados mantienen las unidades finales aunque despues llegue una foto anterior',async()=>{
 const backend=server(),receiver=device(backend,'receiver');receiver.state.items=[{id:'a',name:'Agua',price:100}];receiver.state.inventoryMeta={a:{stock:1000,version:1}};
 Object.assign(receiver.context,{inventoryFor:item=>receiver.state.inventoryMeta[item.id],inventoryStatus:()=> 'available',productAcronym:()=>'',persistInventoryStore(){},persistBootstrapCache(){},renderMenuManager(){}});
 const offline=!source.includes('  const pendingInventoryIds =');
 vm.runInContext(section(offline?'isPendingInventoryJob':'pendingInventoryIds','enqueueAppsScriptJob')+section('inventorySummary','renderInventoryLiveCalculation')+';globalThis.actualStock={applyRemoteInventoryItems,inventorySummary};',receiver.context);
 for(const [stock,version] of [[960,21],[940,41],[1000,61]]){
 backend.events.push({sequence:backend.events.length+1,action:'edit_sale',payload:{items:[{productId:'a',stock,version,costPrice:40}]}});
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.a.stock,stock);assert.equal(receiver.context.actualStock.inventorySummary().units,stock);
 }
 backend.events.push({sequence:backend.events.length+1,action:'record_sale',payload:{items:[{productId:'a',stock:960,version:21}]}});
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.a.stock,1000);
 receiver.context.actualStock.applyRemoteInventoryItems([{productId:'a',stock:940,version:41}]);assert.equal(receiver.context.actualStock.inventorySummary().units,1000);
});


function installActualInventory(target, stock=1000) {
 target.state.items=[{id:'product',name:'Agua',price:100}];target.state.inventoryMeta={product:{stock,version:1,costPrice:40,updatedAt:'base'}};
 Object.assign(target.context,{inventoryFor:item=>target.state.inventoryMeta[item.id],inventoryStatus:()=> 'available',productAcronym:()=>'',persistInventoryStore(){},persistBootstrapCache(){},renderMenuManager(){}});
 const offline=!source.includes('  const pendingInventoryIds =');
 vm.runInContext(section(offline?'isPendingInventoryJob':'pendingInventoryIds','enqueueAppsScriptJob')+';globalThis.actualInventory=applyRemoteInventoryItems;',target.context);
}
test('altas ediciones y borrados transmiten unidades en la misma rafaga y los tres acuses parciales no vuelven a moverlas',async()=>{
 for(const action of ['record_sale','edit_sale','delete_sale']){
  const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');
  const sales=Array.from({length:50},(_,i)=>invoice('units-'+i));
  const initial=action==='record_sale'?1000:900,final=action==='record_sale'?900:action==='edit_sale'?850:1000;
  installActualInventory(sender,final);installActualInventory(receiver,initial);
  const jobs=sales.map((sale,i)=>({id:'units-op-'+i,operationId:'units-op-'+i,status:'pending',action,
   payload:{...(action==='delete_sale'?{saleId:sale.id}:{invoice:{...sale,checkoutAccepted:true,...(action==='edit_sale'?{items:sale.items.map(line=>({...line,quantity:3}))}:{})}}),
    previousRecord:{saleId:sale.id,items:[{menuItemId:'product',quantity:2}]}}}));
  sender.storage.set('jobs',jobs);sender.context.navigator.onLine=false;
  await sender.api.queueReadyCheckoutReports();assert.equal(backend.events.length,0);
  sender.context.navigator.onLine=true;await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
  assert.equal(receiver.state.inventoryMeta.product.stock,final,'La primera rafaga ya lleva las existencias finales: '+action);
  await sender.api.syncConfirmedReports();assert.equal(sender.state.inventoryMeta.product.stock,final,'El emisor no se aplica su propio descuento dos veces.');
  for(let start=0;start<50;start+=20){
   const batch=jobs.slice(start,start+20),done=start+batch.length;
   const stock=initial+(final-initial)*done/50;
   sender.context.fetch=async()=>({ok:true,text:async()=>JSON.stringify({ok:true,results:batch.map((job,index)=>({operationId:job.id,result:{ok:true,batchReceipt:true,...(index===batch.length-1?{items:[{productId:'product',stock,version:done+1,costPrice:40}]}:{})}}))})});
   await sender.api.appsScriptRequest('sync_sales_batch',{operations:batch});await settle();
   sender.storage.set('jobs',jobs.slice(done));
   if(start===20){receiver.context.navigator.onLine=false;assert.equal(await receiver.api.syncConfirmedReports(),false);receiver.context.navigator.onLine=true;}
   await receiver.api.syncConfirmedReports();await sender.api.syncConfirmedReports();
   assert.equal(receiver.state.inventoryMeta.product.stock,final,'Cada confirmacion parcial conserva el saldo final: '+action+' '+done);
   assert.equal(sender.state.inventoryMeta.product.stock,final);
   receiver.context.actualInventory([{productId:'product',stock,version:done+1}]);
   assert.equal(receiver.state.inventoryMeta.product.stock,final,'Una lectura intermedia tampoco repite el lote.');
  }
  assert.equal(Object.keys(receiver.api.reportMirror().inventoryEffects).length,0);
  const saved=structuredClone(receiver.api.reportMirror());receiver.state.inventoryMeta.product.stock=initial;receiver.state.reportMirror=saved;
  await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,final,'Recupera el saldo persistido aunque se cerrara antes de pintar.');
 }
});
test('el inventario acumula equipos distintos y un acuse perdido o repetido no duplica unidades',async()=>{
 const backend=server(),a=device(backend,'a'),b=device(backend,'b'),receiver=device(backend,'receiver');installActualInventory(receiver,100);
 for(const [sender,id,quantity] of [[a,'device-a',2],[b,'device-b',3]]){
  sender.storage.set('jobs',[{id,operationId:id,status:'pending',action:'record_sale',payload:{invoice:{...invoice(id,quantity),checkoutAccepted:true}}}]);
  await sender.api.queueReadyCheckoutReports();await settle();
 }
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,95);
 await a.api.queueConfirmedReportChange('record_sale',{invoice:invoice('device-a',2)},{ok:true,items:[{productId:'product',stock:98,version:2}]},'device-a');await settle();
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,95);
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,95);
 await b.api.queueConfirmedReportChange('record_sale',{invoice:invoice('device-b',3)},{ok:true,items:[{productId:'product',stock:95,version:3}]},'device-b');await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.inventoryMeta.product.stock,95);
});
test('una lectura de movimientos tomada entre dos ediciones no suma correcciones remotas encima de la proyeccion final',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');
 const [sale]=await stockedReceiver(backend,receiver,1),before=receiver.state.incomeReport.records[0];
 sender.storage.set('jobs',[{id:'edit-one',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:before}},
 {id:'edit-two',action:'edit_sale',payload:{invoice:invoice(sale.id,4),previousRecord:{...before,items:[{menuItemId:'product',quantity:3}]}}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
 const partial=[billedMovement(sale),{movementId:'EDIT-intermediate-product',type:'CORRECCION_VENTA',productId:'product',sessionId:sale.sessionId,delta:-1}];
 const merged=receiver.api.mergeConfirmedMovements(partial,'',{authoritative:true,readStartedAt:Date.now()});
 assert.equal(merged.reduce((sum,row)=>sum+row.delta,0),-4);
 assert.equal(receiver.api.mergeConfirmedMovements(merged).reduce((sum,row)=>sum+row.delta,0),-4);
});

test('alta edicion y borrado de la misma venta quedan quietos durante los acuses y los reintentos',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');installActualInventory(receiver,100);
 const sale=invoice('same-sale'),record={saleId:sale.id,items:[{menuItemId:'product',quantity:2}]};
 const jobs=[{id:'same-create',action:'record_sale',payload:{invoice:{...sale,checkoutAccepted:true}}},
 {id:'same-edit',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:record}},
 {id:'same-delete',action:'delete_sale',payload:{saleId:sale.id,previousRecord:{...record,items:[{menuItemId:'product',quantity:3}]}}}];
 sender.storage.set('jobs',jobs);await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.inventoryMeta.product.stock,100);assert.equal(receiver.state.incomeReport.totals.sales,0);
 for(const [index,stock] of [98,97,100].entries()){
  const job=jobs[index];await sender.api.queueConfirmedReportChange(job.action,job.payload,{ok:true,items:[{productId:'product',stock,version:index+2}]},job.id);
  await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,100);
  assert.equal(receiver.state.inventoryMovements.length,0);await sender.api.queueReadyCheckoutReports();await settle();
  await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,100);
 }
});
test('el rechazo definitivo retira tambien las unidades proyectadas, sin dejarlas pendientes para siempre',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');
 const [sale]=await stockedReceiver(backend,receiver,1),record=receiver.state.incomeReport.records[0];installActualInventory(receiver,98);
 sender.storage.set('jobs',[{id:'reject-stock',action:'edit_sale',payload:{invoice:invoice(sale.id,3),previousRecord:record}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,97);
 sender.context.fetch=async()=>({ok:true,text:async()=>JSON.stringify({ok:true,records:[record]})});
 await sender.api.queueConfirmedReportChange('edit_sale',{invoice:invoice(sale.id,3)},{ok:false,retryable:false},'reject-stock');
 await settle();delete backend.events.at(-1).payload.invoice; // Un lector de inventario sin permiso de ventas tampoco recibe la factura.
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,98);
 assert.equal(Object.keys(receiver.api.reportMirror().inventoryEffects).length,0);
});
test('el cierre de una mesa cuyo consumo ya se desconto no vuelve a descontar ese consumo',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');installActualInventory(receiver,98);
 const sale={...invoice('consumed'),checkoutAccepted:true};
 sender.state.inventoryMovements=[{movementId:'consumed-before',sessionId:sale.sessionId,productId:'product',type:'CONSUMO_MESA',delta:-2}];
 sender.storage.set('jobs',[{id:'close-consumed',action:'record_sale',payload:{invoice:sale}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,98);
});

test('los acuses de dos equipos recibidos en orden inverso no repiten ni compensan unidades en pantalla',async()=>{
 const backend=server(),a=device(backend,'a'),b=device(backend,'b'),receiver=device(backend,'receiver');installActualInventory(receiver,100);
 for(const [sender,id,quantity] of [[a,'reverse-a',2],[b,'reverse-b',3]]){
  sender.storage.set('jobs',[{id,operationId:id,action:'record_sale',payload:{invoice:{...invoice(id,quantity),checkoutAccepted:true}}}]);
  await sender.api.queueReadyCheckoutReports();await settle();
 }
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,95);
 // B se guardo primero, pero se perdio su respuesta. El acuse de A llega antes.
 await a.api.queueConfirmedReportChange('record_sale',{invoice:invoice('reverse-a',2)},{ok:true,items:[{productId:'product',stock:95,version:3}]},'reverse-a');await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.inventoryMeta.product.stock,95,'No suma B encima de un saldo que ya incluye B.');
 await b.api.queueConfirmedReportChange('record_sale',{invoice:invoice('reverse-b',3)},{ok:true,items:[{productId:'product',stock:97,version:2}]},'reverse-b');await settle();await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.inventoryMeta.product.stock,95,'El acuse atrasado tampoco restaura el saldo anterior.');
});

test('reponer Club Colombia no vuelve a agotarlo al recibir avisos de ventas pendientes o acuses anteriores',async()=>{
 for(const action of ['adjust_inventory','set_inventory_stock','upsert_inventory']){
  const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');installActualInventory(receiver,2);
  const sale={...invoice('club'),checkoutAccepted:true};sender.storage.set('jobs',[{id:'club-sale',action:'record_sale',payload:{invoice:sale}}]);
  await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,0);
  const item={productId:'product',stock:24,version:3,unit:'unidad'};
  const payload=action==='adjust_inventory'?{adjustment:{eventId:'club-entry',productId:'product',delta:24}}:action==='set_inventory_stock'?{productId:'product',stock:24,inventoryDelta:24}:{item:{...item,inventoryDelta:24,movementEventId:'club-entry'}};
  await sender.api.queueConfirmedReportChange(action,payload,{ok:true,item},'restock-club');await settle();await receiver.api.syncConfirmedReports();
  assert.equal(receiver.state.inventoryMeta.product.stock,24,'La entrada confirmada debe sumarse tambien al inventario proyectado: '+action);
  await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,24,'El sondeo sin novedades tampoco restaura el cero.');
  await sender.api.queueConfirmedReportChange('record_sale',{invoice:sale},{ok:true,items:[{productId:'product',stock:0,version:2}]},'club-sale');
  await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,24,'El acuse anterior a la entrada no la deshace.');
 }
});

test('la reposicion propia permanece aunque se corte la publicacion del aviso despues de guardarla en el backend',async()=>{
 const backend=server(),owner=device(backend,'owner');installActualInventory(owner,2);
 const sale={...invoice('own-club'),checkoutAccepted:true};owner.storage.set('jobs',[{id:'own-club-sale',action:'record_sale',payload:{invoice:sale}}]);
 owner.state.inventoryMeta.product.stock=0;await owner.api.queueReadyCheckoutReports();await settle();await owner.api.syncConfirmedReports();
 owner.state.inventoryMeta.product.stock=24;owner.storage.set('jobs',[{id:'own-entry',action:'adjust_inventory',payload:{adjustment:{eventId:'own-entry',productId:'product',delta:24}}}]);
 backend.setFail(true);
 await owner.api.queueConfirmedReportChange('adjust_inventory',{adjustment:{eventId:'own-entry',productId:'product',delta:24}},{ok:true,item:{productId:'product',stock:24,version:3}},'own-entry');await settle();
 owner.storage.set('jobs',[]);backend.setFail(false);
 await owner.api.syncConfirmedReports();assert.equal(owner.state.inventoryMeta.product.stock,24,'El sondeo anterior al aviso no restaura cero tras retirar el job confirmado.');
 await owner.api.flushConfirmedReportChanges();await settle();await owner.api.syncConfirmedReports();assert.equal(owner.state.inventoryMeta.product.stock,24);
 await owner.api.queueConfirmedReportChange('adjust_inventory',{adjustment:{eventId:'own-entry',productId:'product',delta:24}},{ok:true,item:{productId:'product',stock:24,version:3}},'own-entry');
 await settle();await owner.api.syncConfirmedReports();assert.equal(owner.state.inventoryMeta.product.stock,24,'Una respuesta repetida no repone dos veces.');
});
test('el acceso compartido al inventario conserva la version al hacer una reposicion local',()=>{
 const backend=server(),owner=device(backend,'owner');installActualInventory(owner,0);
 owner.state.inventoryMeta.product={stock:0,version:7};
 vm.runInContext(section('inventoryFor','inventoryStatus')+';globalThis.readInventory=inventoryFor;',owner.context);
 const before=owner.context.readInventory(owner.state.items[0]);assert.equal(before.version,7);
 owner.state.inventoryMeta.product={...before,stock:24,updatedAt:'local-entry'};
 owner.context.actualInventory([{productId:'product',stock:0,version:6}]);assert.equal(owner.state.inventoryMeta.product.stock,24);
});

test('el lote manual confirmado comparte stock y todos los campos de inventario sin esperar a Google otra vez',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');installActualInventory(receiver,10);
 const item={productId:'product',name:'Club Colombia',category:'Cervezas',stock:24,version:2,costPrice:2500,salePrice:5000,minStock:6,unit:'botella',code:'CC',isAvailable:false,updatedAt:'remote-change'};
 await sender.api.queueConfirmedReportChange('sync_inventory',{items:[item]},{ok:true,items:[item]},'manual-batch');await settle();
 await receiver.api.syncConfirmedReports();
 assert.equal(receiver.state.inventoryMeta.product.stock,24);
 assert.equal(receiver.state.inventoryMeta.product.costPrice,2500);
 assert.equal(receiver.state.inventoryMeta.product.minStock,6);
 assert.equal(receiver.state.items[0].name,'Club Colombia');
 assert.equal(receiver.state.items[0].menu_categories.name,'Cervezas');
 assert.equal(receiver.state.items[0].price,5000);assert.equal(receiver.state.items[0].is_available,false);
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,24);
});
test('una rafaga de cincuenta ajustes manuales se recibe completa y no vuelve al saldo anterior',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');installActualInventory(receiver,100);
 backend.setFail(true);
 for(let i=0;i<50;i++)await sender.api.queueConfirmedReportChange('adjust_inventory',{adjustment:{eventId:'entry-'+i,productId:'product',delta:i<25?1:-1}},{ok:true,item:{productId:'product',name:'Agua',stock:i<25?101+i:149-i,version:i+2,costPrice:40,salePrice:100}},'manual-'+i);
 await settle();backend.setFail(false);await sender.api.flushConfirmedReportChanges();await settle();
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,100);
 assert.equal(backend.events.length,50);const before=receiver.renders.length;
 await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,100);assert.equal(receiver.renders.length,before);
});
test('agrupar cambios de stock antes de enviarlos conserva todo el ajuste y respeta la escritura en vuelo',async()=>{
 const backend=server(),sender=device(backend,'sender'),receiver=device(backend,'receiver');installActualInventory(receiver,2);
 const sale={...invoice('before-manual'),checkoutAccepted:true};sender.storage.set('jobs',[{id:'sale',action:'record_sale',payload:{invoice:sale}}]);
 await sender.api.queueReadyCheckoutReports();await settle();await receiver.api.syncConfirmedReports();assert.equal(receiver.state.inventoryMeta.product.stock,0);
 sender.storage.set('jobs',[]);
 Object.assign(sender.context,{recordSyncEvent(){},isAppsScriptConfigured:()=>false,setInventorySyncStatus(){},updateGlobalSyncStatus(){},flushAppsScriptOutbox(){}});
 vm.runInContext(section('enqueueAppsScriptJob','appsScriptRetryDelay')+';globalThis.enqueue=enqueueAppsScriptJob;',sender.context);
 for(const action of ['set_inventory_stock','upsert_inventory']){
  sender.storage.set('jobs',[]);
  const payload=stock=>action==='set_inventory_stock'?{productId:'product',stock,inventoryDelta:10}:{item:{productId:'product',stock,inventoryDelta:10}};
  await sender.context.enqueue(action,payload(10),'same');await sender.context.enqueue(action,payload(20),'same');
  const jobs=sender.storage.get('jobs');assert.equal(jobs.length,1);
  const delta=action==='set_inventory_stock'?jobs[0].payload.inventoryDelta:jobs[0].payload.item.inventoryDelta;
  assert.equal(delta,20,'El ultimo valor absoluto incluye ambos ajustes');
  jobs[0].status='syncing';sender.storage.set('jobs',jobs);
  await sender.context.enqueue(action,payload(30),'same');assert.equal(sender.storage.get('jobs').length,2,'Una escritura en vuelo conserva su identidad y su ajuste');
 }
});
