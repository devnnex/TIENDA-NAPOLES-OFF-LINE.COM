const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const slice=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const block=(from,to)=>slice('  const '+from+' =','  const '+to+' =');
const offline=source.includes('  let movementLoadPromise =');
const tick=()=>new Promise(setImmediate);
function fixture(){
 const state={currentUser:{id:'boss'},inventoryMovements:[],invoiceHistory:[],inventoryMeta:{},incomeRequestId:1,movementTypeFilter:'all',movementView:'inventory',movementProductFilter:'all',syncFresh:{},items:[],movementRequestId:0,activeAdminSection:'movements'};
 const jobs=[],mirror={cursor:1,sales:{},deleted:{},movements:{}},calls=[],controls=new Map(),saved=[];
 let response={ok:true,movements:[],revision:'same',hasMore:false},gate=null;
 const context=vm.createContext({state,Date,Map,Set,Number,Object,JSON,navigator:{onLine:true},normalizeText:value=>String(value||'').toLowerCase(),
  reportMirror:()=>mirror,reportMirrorKey:()=> 'mirror',readAppsScriptOutbox:()=>jobs,
  saveReportSyncValue:(key,value)=>{saved.push(structuredClone(value));return true;},persistInventoryMovements(){},renderInventoryMovements(){},
  appsScriptRequest:async(action)=>{calls.push(action);if(gate)await gate;return structuredClone(response);},
  isAppsScriptConfigured:()=>true,canAccessAdminSection:()=>true,updateGlobalSyncStatus(){},toast(){},
  canDeleteRecords:()=>true,persistInvoiceHistory(){},persistInventoryStore(){},renderIncomeReport(){},renderInventory(){},
  inventoryFor:item=>state.inventoryMeta[item.id],writeAppsScriptOutbox:rows=>jobs.splice(0,jobs.length,...rows),
  enqueueAppsScriptJob:(action,payload)=>jobs.push({action,payload}),queueConfirmedReportChange:async()=>true,
  loadIncomeReport:async()=>true,applyRemoteInventoryItems(){},
  localIncomeRecords:()=>state.invoiceHistory,purchaseDateKey:value=>String(value).slice(0,10),
  $:key=>controls.get(key)||null,window:{setTimeout:fn=>{fn();},clearTimeout(){}},
 });
 vm.runInContext(block('movementBelongsToSale','mergeConfirmedIncomeReport')
  +block('filteredMovementRows','renderMovementProductOptions')
  +block('loadMovementSalesTotals','movementSoldUnits')
  +(offline?block('pendingInventoryMovementIds','resetInventoryForm'):slice('  let movementRefreshPending =','  const resetInventoryForm ='))
  +block('deleteIncomeSale','replaceEditedIncomeRecord')
  +';globalThis.api={loadInventoryMovements,mergeConfirmedMovements,removeDeletedSaleMovements,loadMovementSalesTotals,filteredMovementRows,movementViewRows,deleteIncomeSale};',context);
 return {state,context,jobs,mirror,calls,controls,saved,api:context.api,setResponse:value=>{response=value;},hold(){let release;gate=new Promise(resolve=>{release=resolve;});return()=>{gate=null;release();};}};
}
const movement=(id,extras={})=>({movementId:id,productId:'p',product:'Agua',delta:-2,type:'CONSUMO_MESA',sessionId:'session-a',date:'2026-10-13T18:00:00Z',...extras});
const sale={saleId:'sale-a',sessionId:'session-a',invoice:'TN-1',date:'2026-10-13T18:00:00Z',items:[{menuItemId:'p',name:'Agua',quantity:3,total:300},{menuItemId:'p',name:'Agua',quantity:2,total:200}]};

test('una respuesta vacía elimina movimientos borrados directamente del backend aunque su revisión no cambie',async()=>{
 const h=fixture(),row=movement('consumption');h.state.inventoryMovements=[row];h.state.completeMovementRevision='same';h.state.movementRevision='same';
 h.mirror.movements[row.movementId]={...row,reportConfirmedAt:'2020-01-01T00:00:00Z'};
 assert.equal(await h.api.loadInventoryMovements(),true);assert.equal(h.state.inventoryMovements.length,0);
 assert.equal(Object.keys(h.mirror.movements).length,0);assert.deepEqual(h.calls,['get_inventory_movements']);
 assert.equal(h.api.mergeConfirmedMovements([]).length,0,'Otra actualización no revive la réplica retirada.');
});
test('un borrado parcial retira solamente la fila omitida y conserva cambios locales durante la lectura',async()=>{
 const h=fixture();h.state.inventoryMovements=[movement('keep'),movement('removed')];
 h.setResponse({ok:true,movements:[movement('keep')],revision:'same',hasMore:false});
 const release=h.hold(),loading=h.api.loadInventoryMovements();await tick();
 h.state.inventoryMovements.push(movement('new-local'));release();await loading;
 assert.deepEqual(Array.from(h.state.inventoryMovements,row=>row.movementId).sort(),['keep','new-local']);
});
test('un borrado remoto no descarta movimientos que todavía están en la cola ni eventos confirmados después de iniciar la lectura',async()=>{
 const h=fixture();h.state.inventoryMovements=[movement('pending')];h.jobs.push({action:'adjust_inventory',payload:{adjustment:{eventId:'pending'}}});
 h.mirror.movements.new=movement('new',{reportConfirmedAt:'2099-01-01T00:00:00Z'});
 await h.api.loadInventoryMovements();assert.deepEqual(Array.from(h.state.inventoryMovements,row=>row.movementId).sort(),['new','pending']);
});
test('las tres tarjetas totalizan el producto y cambiar a ventas agrupa líneas cobradas sin pedir datos de red',()=>{
 const h=fixture();h.state.inventoryMovements=[movement('consume'),movement('manual',{sessionId:'',delta:10,type:'ENTRADA_UNIDADES'})];
 h.state.invoiceHistory=[sale];h.state.incomeReport={records:[sale]};h.api.loadMovementSalesTotals();
 h.state.movementView='sales';let rows=h.api.filteredMovementRows();
 assert.equal(rows.length,1);assert.equal(rows[0].delta,-5);assert.equal(rows[0].total,500);assert.equal(rows[0].type,'VENTA_COBRADA');
 h.state.movementProductFilter='other';assert.equal(h.api.filteredMovementRows().length,0);
 h.state.movementProductFilter='p';assert.equal(h.api.filteredMovementRows().length,1);
 h.state.movementView='inventory';assert.equal(h.api.filteredMovementRows().length,2);assert.equal(h.calls.length,0);
});
test('eliminar una venta oculta su consumo y devolución, conserva ajustes ajenos y evita que lecturas antiguas los restauren',()=>{
 const h=fixture();h.mirror.deleted['sale-a']='2026-10-13';h.mirror.deletedSaleLinks={'sale-a':{sessionId:'session-a',invoice:'TN-1'}};
 const rows=[movement('consume'),movement('SALE-sale-a-p'),movement('DELETE-SALE-sale-a-p',{type:'VENTA_ELIMINADA',delta:2}),movement('manual',{sessionId:'',type:'ENTRADA_UNIDADES',delta:10})];
 assert.deepEqual(Array.from(h.api.mergeConfirmedMovements(rows),row=>row.movementId),['manual']);
 h.state.invoiceHistory=[sale];h.api.loadMovementSalesTotals();assert.equal(h.state.movementSalesRecords.length,0);
});
test('la eliminación confirmada por backend se reconoce aunque el navegador no recibiera el aviso de venta',()=>{
 const h=fixture();const rows=[movement('consume'),movement('DELETE-SALE-sale-a-p',{type:'VENTA_ELIMINADA',reference:'TN-1'}),movement('other',{sessionId:'other-session'})];
 assert.deepEqual(Array.from(h.api.removeDeletedSaleMovements(rows),row=>row.movementId),['other']);
});
test('eliminar desde Ventas quita su movimiento de inmediato y conserva la restauración existente de inventario',async()=>{
 const h=fixture();h.state.items=[{id:'p'}];h.state.inventoryMeta={p:{stock:10}};
 h.state.inventoryMovements=[movement('consume'),movement('manual',{sessionId:'',delta:10})];
 h.state.incomeReport={records:[{...sale,total:500,payments:[]}],totals:{sales:1,income:500},totalRecords:1};h.state.invoiceHistory=[sale];
 const removing=h.api.deleteIncomeSale({sale_id:{value:'sale-a'}});
 assert.deepEqual(Array.from(h.state.inventoryMovements,row=>row.movementId),['manual']);
 assert.equal(h.state.inventoryMeta.p.stock,15);await removing;
 assert.equal(h.state.incomeReport.records.length,0);assert.ok(h.mirror.deleted['sale-a']);
 if(offline)assert.ok(h.jobs.some(job=>job.action==='delete_sale'&&job.payload.saleLink.sessionId==='session-a'));
});
if(!offline)test('si el backend rechaza borrar una venta se restauran también sus movimientos y KPI',async()=>{
 const h=fixture();h.state.items=[{id:'p'}];h.state.inventoryMeta={p:{stock:10}};
 h.state.inventoryMovements=[movement('consume')];h.state.incomeReport={records:[{...sale,total:500,payments:[]}],totals:{sales:1,income:500},totalRecords:1};
 h.state.invoiceHistory=[sale];h.setResponse({ok:false,error:'No autorizado'});
 await h.api.deleteIncomeSale({sale_id:{value:'sale-a'}});
 assert.equal(h.state.inventoryMeta.p.stock,10);assert.equal(h.state.incomeReport.records.length,1);
 assert.equal(h.state.inventoryMovements.length,1);assert.equal(h.mirror.deleted['sale-a'],undefined);
 h.api.loadMovementSalesTotals();assert.equal(h.state.movementSalesRecords.length,1);
});
test('entrar y filtrar no inicia consultas completas de ventas o movimientos y mantiene tres KPI',()=>{
 assert.doesNotMatch(block('showAdminSection','ensureOpenSession'),/loadMovementSalesTotals\(|ensureCompleteMovementHistory\(/);
 const a=source.indexOf('    const updateMovementFilters ='),b=source.indexOf('    $("#exportPurchasesPdf")',a);
 assert.doesNotMatch(source.slice(a,b),/appsScriptRequest\(|ensureCompleteMovementHistory\(|loadIncomeReport\(/);
 assert.equal((block('renderMovementTotals','buildBusinessReportPdf').match(/<article /g)||[]).length,3);
 assert.ok(!fs.readFileSync(path.join(__dirname,'../admin.html'),'utf8').includes('id="completeMovementHistory"'));
});
