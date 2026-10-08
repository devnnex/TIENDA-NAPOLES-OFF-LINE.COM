const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const from=source.indexOf('  let coreRefreshPromise ='),to=source.indexOf('  const updateNavRequestBadge =',from);
assert.ok(from>0&&to>from);
let calls=0,directReads=0;
const snapshot={business:{id:'business-a',business_name:'Nombre actual'},tables:[{id:'table-a',table_number:8}],categories:[{id:'category-a',name:'Bebidas'}],items:[{id:'product-a',name:'Producto actual',price:7000}]};
const state={page:'admin',authToken:'valid-token',business:{id:'business-a',business_name:'Nombre viejo'},tables:[],categories:[],items:[],syncFresh:{},activeAdminSection:'dashboard',sb:{rpc:async name=>{assert.equal(name,'getBootstrapData');calls++;return {data:snapshot};}}};
const context=vm.createContext({state,Date,URLSearchParams,window:{setTimeout},location:{search:''},tableCode:()=>'',dbQuiet:async q=>(await q)?.data,
 getOfflineSyncStatus:async()=>({blockingRecords:[]}),setScopedCoreRead:async()=>true,
 mergePendingCoreData:data=>data,
 loadBusiness:async()=>{directReads++;return false;},loadCore:async()=>{directReads++;state.tables=[];state.items=[];return true;},
 applyBusinessTipSettings(){},persistBootstrapCache(){},renderBrand(){},syncTipFeatureVisibility(){},renderTables(){},renderServiceTables(){},renderTableManager(){},renderMenuManager(){},renderInventory(){},renderBusinessForm(){},renderMenu(){},updateGlobalSyncStatus:async()=>{}});
const mergeFrom=source.indexOf('  const mergePendingCoreData =');
vm.runInContext(source.slice(mergeFrom,from)+source.slice(from,to)+';globalThis.refreshCore=refreshCoreNow;globalThis.mergeCore=mergePendingCoreData;',context);
(async()=>{
 await context.refreshCore();
 assert.equal(state.items[0]?.id,'product-a','La lectura autenticada del backend prevalece sobre GET vacíos por permisos.');
 assert.equal(state.tables[0]?.table_number,8);assert.equal(state.business.business_name,'Nombre actual');
 assert.equal(calls,1);assert.equal(directReads,0);assert.equal(state.syncFresh.core,true);
 state.items=[{id:'product-a',name:'Nombre local pendiente',price:1000},{id:'product-new',name:'Nuevo producto local',price:2000}];
 const peer={...snapshot,items:[{id:'product-a',name:'Nombre anterior',price:9000},{id:'product-peer',name:'Agregado en BCA',price:6000}]};
 const merged=context.mergeCore(peer,{blockingRecords:[{entity:'menu_items',recordIds:['product-a'],method:'PATCH',changedFields:['name']},{entity:'menu_items',recordIds:['product-new'],method:'POST',changedFields:['id','name','price']}]});
 assert.equal(merged.items.find(x=>x.id==='product-a').name,'Nombre local pendiente');
 assert.equal(merged.items.find(x=>x.id==='product-a').price,9000,'Un nombre pendiente no oculta el precio actualizado del otro equipo.');
 assert.ok(merged.items.some(x=>x.id==='product-peer'));assert.ok(merged.items.some(x=>x.id==='product-new'));
 state.sb.rpc=async()=>({error:{message:'Red interrumpida'}});
 const retained=JSON.stringify({business:state.business,tables:state.tables,items:state.items});
 assert.equal(await context.refreshCore(),false);
 assert.equal(JSON.stringify({business:state.business,tables:state.tables,items:state.items}),retained,'Un error de red conserva lo que había y no sustituye datos por listas vacías.');
 let release,round=0;const held=new Promise(r=>{release=r;});
 state.sb.rpc=()=>++round===1?held:Promise.resolve({data:{...snapshot,items:[{...snapshot.items[0],price:12000}]}});
 const reading=context.refreshCore();assert.equal(context.refreshCore(),reading);
 release({data:snapshot});await reading;await new Promise(r=>setTimeout(r,20));
 assert.equal(round,2,'Un aviso recibido durante la lectura genera una revisión posterior.');
 assert.equal(state.items[0].price,12000,'No se pierde el cambio que llegó mientras otra respuesta estaba pendiente.');
 console.log('PASS catálogo/Marca/mesas: snapshot autorizado actual, sin vaciar datos por GET de cero filas.');
})().catch(e=>{console.error(e);process.exitCode=1;});
