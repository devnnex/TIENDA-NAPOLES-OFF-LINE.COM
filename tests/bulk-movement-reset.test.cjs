const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const block=(from,to)=>{const a=source.indexOf('  const '+from+' ='),b=source.indexOf('  const '+to+' =',a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
function harness({confirmed=true,authorized=true,failed=false,storageFailure=false}={}){
 const actions=[],messages=[],confirmations=[];
 const state={items:[{id:'p',name:'Agua'},{id:'q',name:'Pan'}],inventoryMeta:{p:{stock:7,costPrice:40},q:{stock:12,costPrice:20}},
  invoiceHistory:[{id:'sale',totals:{total:200}}],incomeReport:{totals:{income:200}},sessions:[],movementRequestId:1,
  movementProductFilter:'p',inventoryMovements:[{movementId:'sale',productId:'p',delta:-2},{movementId:'return',productId:'q',delta:1}],
  reportMirror:{cursor:4,sales:{sale:{id:'sale',reportMutation:true,reportConfirmedAt:'2020-01-01T00:00:00Z',items:[{menu_item_id:'p',quantity:2}]}},deleted:{},movements:{sale:{movementId:'sale',delta:-2}}}};
 const forbidden=()=>{throw Error('Bulk movement reset must not mutate inventory or sales');};
 const context=vm.createContext({state,Date,Map,Set,Number,Object,JSON,
  isManager:()=>authorized,canDeleteRecords:()=>authorized,askForConfirmation:async details=>{confirmations.push(details);return confirmed;},
  $:()=>null,uid:()=> 'bulk-reset',refreshIcons(){},toast:message=>messages.push(message),
  reportMirror:()=>state.reportMirror,reportMirrorKey:()=> 'mirror',
  saveReportSyncValue:async()=>!storageFailure,persistInventoryMovements(){},renderInventoryMovements(){},readAppsScriptOutbox:()=>[],
  enqueueAppsScriptJob:(action,payload)=>{if(failed)throw Error('reset rejected');actions.push({action,payload});},
  window:{requestAnimationFrame:callback=>callback()},isAppsScriptConfigured:()=>true,waitForRemoteQueue:async()=>{},
  appsScriptRequest:async(action,payload)=>{if(failed)throw Error('reset rejected');actions.push({action,payload});return {ok:true,cleared:true};},
  persistInventoryStore:forbidden,persistInvoiceHistory:forbidden,applyRemoteInventoryItems:forbidden,
  persistBootstrapCache:forbidden,renderInventory:forbidden,renderIncomeReport:forbidden,
 });
 vm.runInContext(block('resetSectionData','dateTimeLocalValue')+block('movementBelongsToSale','mergeConfirmedIncomeReport')
  +';globalThis.api={reset:resetSectionData,merge:mergeConfirmedMovements};',context);
 return {state,actions,messages,confirmations,api:context.api};
}
test('Eliminar todos borra movimientos de todos los productos, conserva stock, costos y ventas y envía solo el borrado del historial',async()=>{
 const h=harness(),protectedBefore=JSON.stringify([h.state.items,h.state.inventoryMeta,h.state.invoiceHistory,h.state.incomeReport,h.state.reportMirror.sales]);
 await h.api.reset('movements');
 assert.equal(h.state.inventoryMovements.length,0);assert.equal(Object.keys(h.state.reportMirror.movements).length,0);
 assert.equal(JSON.stringify([h.state.items,h.state.inventoryMeta,h.state.invoiceHistory,h.state.incomeReport,h.state.reportMirror.sales]),protectedBefore);
 assert.deepEqual(h.actions.map(row=>row.action),['clear_inventory_movements']);assert.equal(Object.keys(h.actions[0].payload).length,0);
 assert.match(h.confirmations[0].message,/No se devolverán productos al inventario/);
 assert.equal(h.api.merge([{movementId:'old',productId:'p',delta:-2}],'old').length,0,'Una réplica o corrección antigua no reconstruye el historial borrado.');
});
test('cancelar el borrado conserva todos los movimientos y no envía ninguna operación',async()=>{
 const h=harness({confirmed:false}),before=JSON.stringify(h.state);await h.api.reset('movements');
 assert.equal(JSON.stringify(h.state),before);assert.equal(h.actions.length,0);
});
test('se conservan los permisos existentes para borrar movimientos',async()=>{
 const h=harness({authorized:false}),before=JSON.stringify(h.state);await h.api.reset('movements');
 assert.equal(JSON.stringify(h.state),before);assert.equal(h.confirmations.length,0);assert.equal(h.actions.length,0);
});
test('un fallo al encolar o confirmar el borrado restaura el historial y la réplica sin cambiar inventario',async()=>{
 const h=harness({failed:true}),before=JSON.stringify([h.state.inventoryMeta,h.state.invoiceHistory,h.state.inventoryMovements,h.state.reportMirror]);
 await h.api.reset('movements');assert.equal(JSON.stringify([h.state.inventoryMeta,h.state.invoiceHistory,h.state.inventoryMovements,h.state.reportMirror]),before);
 assert.ok(h.messages.some(message=>message.includes('reset rejected')));
});
test('un fallo al guardar el reinicio no envía un borrado remoto y conserva stock e historial',async()=>{
 const h=harness({storageFailure:true}),before=JSON.stringify([h.state.inventoryMeta,h.state.inventoryMovements,h.state.reportMirror]);
 await h.api.reset('movements');assert.equal(h.actions.length,0);assert.equal(JSON.stringify([h.state.inventoryMeta,h.state.inventoryMovements,h.state.reportMirror]),before);
});
test('las correcciones nuevas después del borrado siguen apareciendo sin modificar las facturas',async()=>{
 const h=harness();await h.api.reset('movements');
 h.state.reportMirror.sales.later={id:'later',reportMutation:true,reportConfirmedAt:'2099-01-01T00:00:00Z',items:[{menu_item_id:'p',quantity:1}]};
 const before=JSON.stringify(h.state.reportMirror.sales),rows=h.api.merge([]);
 assert.equal(rows.length,1);assert.equal(rows[0].delta,-1);assert.equal(JSON.stringify(h.state.reportMirror.sales),before);
});
test('el backend borra únicamente las filas de Movimientos; no solicita inventario, productos ni ventas',()=>{
 const backend=fs.readFileSync(path.join(__dirname,'../appscript/Code.gs'),'utf8'),a=backend.indexOf('function clearInventoryMovements_'),b=backend.indexOf('\nfunction ',a+1),accesses=[],writes=[];
 const rows=Array.from({length:1205},(_,i)=>['movement-'+i]);const sheet={getLastRow:()=>rows.length+1};
 const context=vm.createContext({APP:{sheets:{movements:'Movimientos'}},HEADERS:{movements:Array(12)},withScriptLock_:work=>work(),
  getSpreadsheet_:()=>({getSheetByName:name=>{accesses.push(name);assert.equal(name,'Movimientos');return sheet;}}),
  writeDataRows_:(target,data)=>{assert.equal(target,sheet);assert.equal(data.length,0);writes.push('movements');rows.length=0;},appendAudit_:()=>writes.push('audit')});
 vm.runInContext(backend.slice(a,b)+';globalThis.clear=clearInventoryMovements_;',context);
 assert.equal(context.clear({full_name:'Caja'}).deleted,1205);assert.equal(rows.length,0);assert.deepEqual(accesses,['Movimientos']);assert.deepEqual(writes,['movements','audit']);
});
test('el botón identifica el borrado completo de Movimientos y conserva su acción específica',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../admin.html'),'utf8');
 assert.match(html,/data-reset-section="movements"[^>]*><i data-lucide="trash-2"><\/i> Eliminar todos los movimientos/);
});
