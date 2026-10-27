const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function block(from,to) {
  const a=source.indexOf('  const '+from+' ='), b=source.indexOf('  const '+to+' =',a+1);
  assert.ok(a>=0 && b>a,from); return source.slice(a,b);
}
const line=(id,quantity,price,cost=10)=>({menuItemId:id,name:'Mismo nombre',quantity,total:quantity*price,cost:quantity*cost});
function harness() {
  const state={sessions:[{id:'open',status:'open'}],incomeRequestId:1};
  const context=vm.createContext({state,Date,Map,Set,Number,String,APPS_SCRIPT_TIMEOUT_MS:1000});
  vm.runInContext(block('incomeProductSummary','renderIncomeProductOptions')+block('movementSoldUnits','renderMovementTotals')
    +block('completeIncomeSaleTypeReport','incomeSaleTypeFiltersKey')
    +';globalThis.api={summary:incomeProductSummary,sold:movementSoldUnits,complete:completeIncomeSaleTypeReport};',context);
  return {state,context,api:context.api};
}
test('el producto suma solo sus líneas por ID, incluye fracciones y conserva intacta la factura mixta',()=>{
  const h=harness(), report={records:[{saleId:'1',total:9999,payments:[{method:'card',amount:9999}],items:[line('p',2,100),line('q',20,300),line('p',.5,120)]}],totalRecords:1};
  const before=JSON.stringify(report), summary=h.api.summary(report,'p');
  assert.equal(summary.quantity,2.5); assert.equal(summary.income,260); assert.equal(summary.cost,25); assert.equal(summary.profit,235); assert.equal(summary.sales,1);
  assert.equal(summary.complete,true);assert.equal(JSON.stringify(report),before);
  assert.equal(h.api.summary(report,'missing').income,0);
});
test('650 facturas se completan antes de dar por definitivo el conteo de producto',async()=>{
  const h=harness(), rows=Array.from({length:650},(_,i)=>({saleId:String(i),row:i+2}));
  const records=rows.map(row=>({...row,date:'2026-10-27T15:00:00Z',items:[line('p',2,100),line('q',1,900)]}));
  h.context.appsScriptRequest=async(action,{filters})=>({ok:true,revision:'r1',records:filters.pageRows.map(row=>records[Number(row.saleId)])});
  const first={records:records.slice(0,300),recordRows:rows,totalRecords:650,truncated:true,revision:'r1'};
  assert.equal(h.api.summary(first,'p').complete,false);
  const complete=await h.api.complete(first,{complete:true},1);
  assert.equal(complete.records.length,650);assert.equal(h.api.summary(complete,'p').quantity,1300);assert.equal(h.api.summary(complete,'p').income,130000);assert.equal(h.api.summary(complete,'p').complete,true);
});
test('si falta una página no presenta las primeras 300 facturas como el total del producto',async()=>{
  const h=harness();h.context.appsScriptRequest=async()=>({ok:true,records:[],revision:'r1'});
  await assert.rejects(h.api.complete({records:[],recordRows:[{saleId:'missing',row:2}],totalRecords:1,revision:'r1'},{complete:true},1),/confirmar todas/);
});
test('un cambio de revisión entre páginas no mezcla conteos de dos versiones',async()=>{
  const h=harness();h.context.appsScriptRequest=async()=>({ok:true,revision:'changed',records:[{saleId:'1'}]});
  await assert.rejects(h.api.complete({records:[],recordRows:[{saleId:'1',row:2}],totalRecords:1,revision:'original'},{complete:true},1),/historial cambio/);
});
test('el historial del producto en Movimientos recorre más de 800 filas y reutiliza una revisión completa',async()=>{
  const h=harness(), rows=Array.from({length:1605},(_,i)=>({movementId:'m'+i,productId:'p',type:'SALIDA_VENTA',delta:-1,date:'2026-10-27T15:00:00Z'}));
  Object.assign(h.state,{inventoryMovements:[],movementProductFilter:'p'});
  let calls=0;
  Object.assign(h.context,{navigator:{onLine:true},appsScriptRequest:async(_action,{cursor})=>{
    calls++;const start=Number(cursor||0),end=start+800;return {ok:true,revision:'r1',movements:rows.slice(start,end),hasMore:end<rows.length,nextCursor:end<rows.length?String(end):null};
  },readAppsScriptOutbox:()=>[],mergeConfirmedMovements:rows=>rows,saveReportSyncValue:async()=>true,persistInventoryMovements(){},renderInventoryMovements(){}});
  const from=source.indexOf('  let completeMovementsPromise ='),to=source.indexOf('  const loadSelectedMovementHistory =',from);
  vm.runInContext(source.slice(from,to)+';globalThis.completeMovements=ensureCompleteMovementHistory;',h.context);
  assert.equal(await h.context.completeMovements(),true);assert.equal(calls,3);assert.equal(h.api.sold(h.state.inventoryMovements),1605);
  assert.equal(h.state.movementHasMore,false);
  assert.equal(await h.context.completeMovements(),true);assert.equal(calls,4);assert.equal(h.state.inventoryMovements.length,1605);
});
test('unidades vendidas en Movimientos excluyen retiros manuales, entradas y cuentas abiertas y descuentan devoluciones',()=>{
  const h=harness(), movements=[
    {type:'SALIDA_VENTA',delta:-5}, {type:'CORRECCION_VENTA',delta:2},
    {type:'CONSUMO_MESA',sessionId:'closed',delta:-3},{type:'DEVOLUCION_CONSUMO',sessionId:'closed',delta:1},
    {type:'CONSUMO_MESA',sessionId:'open',delta:-20}, {type:'SALIDA_UNIDADES',delta:-100}, {type:'ENTRADA_UNIDADES',delta:200}];
  assert.equal(h.api.sold(movements),5);assert.equal(h.api.sold([]),0);
  const report={records:[{items:[line('p',3,100)]},{items:[line('p',2,100)]}],totalRecords:2};
  assert.equal(h.api.sold(movements),h.api.summary(report,'p').quantity);
});
test('el borrado del backend toca solo movimientos y auditoría, sin reponer existencias ni borrar ventas',()=>{
  const backend=fs.readFileSync(path.join(__dirname,'../appscript/Code.gs'),'utf8');
  const a=backend.indexOf('function clearInventoryMovements_'),b=backend.indexOf('\nfunction ',a+1),calls=[];
  const movementSheet={getLastRow:()=>10}, stock={p:7}, sales=[{id:'sale'}];
  const context=vm.createContext({APP:{sheets:{movements:'movements'}},HEADERS:{movements:Array(12)},withScriptLock_:fn=>fn(),
    getSpreadsheet_:()=>({getSheetByName:name=>{assert.equal(name,'movements');return movementSheet;}}),
    writeDataRows_:(sheet,rows)=>{assert.equal(sheet,movementSheet);assert.equal(rows.length,0);calls.push('clear');},appendAudit_:()=>calls.push('audit')});
  vm.runInContext(backend.slice(a,b)+';globalThis.clear=clearInventoryMovements_;',context);
  assert.equal(context.clear({full_name:'Caja'}).deleted,9);assert.deepEqual(calls,['clear','audit']);assert.equal(stock.p,7);assert.equal(sales.length,1);
});
function resetHarness({confirm=true,fail=false}={}) {
  const h=harness(),jobs=[],messages=[];
  Object.assign(h.state,{items:[{id:'p',name:'Agua'}],inventoryMeta:{p:{stock:7}},inventoryMovements:[{movementId:'old',productId:'p',type:'SALIDA_VENTA',delta:-3}],invoiceHistory:[{id:'sale',total:300}],
    reportMirror:{sales:{sale:{id:'sale',reportMutation:'edit',reportPrevious:{items:[]},items:[{menu_item_id:'p',quantity:3}]}},movements:{old:{movementId:'old'}},deleted:{}},movementHasMore:true});
  Object.assign(h.context,{isManager:()=>true,isBoss:()=>true,canDeleteRecords:()=>true,askForConfirmation:async()=>confirm,$:()=>null,
    reportMirror:()=>h.state.reportMirror,reportMirrorKey:()=> 'mirror',saveReportSyncValue:async()=>true,
    readAppsScriptOutbox:()=>[],window:{requestAnimationFrame:fn=>fn()},isAppsScriptConfigured:()=>true,
    waitForRemoteQueue:async()=>{if(fail)throw Error('queue unavailable');},
    appsScriptRequest:async(action,payload)=>{jobs.push({action,payload});return {ok:true,cleared:true};},
    persistInventoryMovements(){},renderInventoryMovements(){},refreshIcons(){},uid:()=> 'reset',toast:message=>messages.push(message),
    enqueueAppsScriptJob:(action,payload)=>{if(fail)throw Error('queue unavailable');jobs.push({action,payload});}});
  vm.runInContext(block('resetSectionData','dateTimeLocalValue')+block('movementBelongsToSale','mergeConfirmedIncomeReport')
    +';globalThis.reset=resetSectionData;globalThis.mergeMovements=mergeConfirmedMovements;',h.context);
  return {...h,jobs,messages};
}
test('reiniciar movimientos deja cero, conserva inventario y facturas y no revive correcciones previas',async()=>{
  const h=resetHarness(),before=JSON.stringify([h.state.inventoryMeta,h.state.invoiceHistory]);
  await h.context.reset('movements');
  assert.equal(h.state.inventoryMovements.length,0);assert.equal(Object.keys(h.state.reportMirror.movements).length,0);
  assert.equal(h.state.reportMirror.sales.sale.reportMovementSettled,true);
  assert.equal(h.jobs.length,1);assert.equal(h.jobs[0].action,'clear_inventory_movements');
  assert.equal(JSON.stringify([h.state.inventoryMeta,h.state.invoiceHistory]),before);
  assert.equal(h.context.mergeMovements([{movementId:'old',productId:'p',delta:-3}],'old').length,0);
});
test('cancelar el borrado conserva el historial y no encola nada',async()=>{
  const h=resetHarness({confirm:false}),before=JSON.stringify(h.state);
  await h.context.reset('movements');assert.equal(h.jobs.length,0);assert.equal(JSON.stringify(h.state),before);
});
test('si falla la cola del reinicio se restauran los movimientos y su réplica, conservando stock',async()=>{
  const h=resetHarness({fail:true}),mirror=JSON.stringify(h.state.reportMirror);
  await h.context.reset('movements');assert.equal(h.state.inventoryMovements.length,1);assert.equal(JSON.stringify(h.state.reportMirror),mirror);assert.equal(h.state.inventoryMeta.p.stock,7);
  assert.ok(h.messages.some(message=>message.includes('queue unavailable')));
});
if(source.includes('  const reflectInvoiceInIncomeReport ='))test('un nuevo cobro transforma una sola factura y conserva totales de las páginas remotas no cargadas',()=>{
  const h=harness(), filters={dateFrom:'2026-10-27',dateTo:'2026-10-27'}, invoice={id:'new',sessionId:'new'};
  h.state.invoiceHistory=Array.from({length:50000},(_,i)=>({id:String(i)}));
  h.state.incomeReport={filters,records:[{saleId:'old',total:100}],totalRecords:650,totals:{income:65000,sales:650,profit:39000,cost:26000}};
  let transformed=0;
  Object.assign(h.context,{incomeFiltersFromForm:()=>filters,localIncomeRecords:(_filters,invoices)=>{transformed+=invoices.length;return [{saleId:invoices[0].id,total:200,subtotal:200,cost:80,profit:120,payments:[]}];}});
  vm.runInContext(block('incomeTotalsFromRecords','localIncomeRecords')+block('reflectInvoiceInIncomeReport','applyInvoiceToInventory')+';globalThis.reflect=reflectInvoiceInIncomeReport;',h.context);
  h.context.reflect(invoice);
  assert.equal(transformed,1);assert.equal(h.state.incomeReport.totals.income,65200);assert.equal(h.state.incomeReport.totalRecords,651);
  assert.equal(h.state.incomeReport.records.length,2);
});
