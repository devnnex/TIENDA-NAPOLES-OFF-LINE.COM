const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const start=source.indexOf('  let inventorySnapshotProofPromise'),end=source.indexOf('  let reportChangeBatchDepth',start);assert.ok(start>0&&end>start);
const clone=x=>structuredClone(x),item=(stock,version=2)=>({productId:'product',name:'Producto',stock,version,costPrice:40,salePrice:100,minStock:5,unit:'unidad'});
function fixture({legacy=false,projected=50,effects={pending:{product:-2},saved:{product:-3}},links=null}={}){
 const mirror={cursor:20,sales:{untouched:{total:123}},movements:{untouched:{delta:7}},inventoryBase:{product:item(100)},inventoryEffects:clone(effects),inventorySettled:{},inventoryProjected:{product:projected},
  ...(!legacy?{inventoryOperations:links||{pending:{saleId:'pending-sale',action:'record_sale'},saved:{saleId:'saved-sale',action:'record_sale'}}}:{})};
 const state={authToken:'user',inventoryMeta:{product:{stock:projected}},currentUser:{id:'staff'}};
 const env={snapshot:{ok:true,items:[item(97)]},report:{ok:true,revision:'R1',recordRows:[{saleId:'saved-sale',row:2}],records:[{saleId:'saved-sale',items:[{menuItemId:'product',quantity:3}]}]},revision:'R1',save:true,fail:false,afterRead:null,
  events:[{sequence:1,action:'record_sale',payload:{invoice:{id:'pending-sale'},inventoryEffect:{operationId:'pending',deltas:{product:-2}}}},{sequence:2,action:'record_sale',payload:{invoice:{id:'saved-sale'},inventoryEffect:{operationId:'saved',deltas:{product:-3}}}}]};
 const calls=[],persisted=[];
 const context=vm.createContext({state,Map,Set,Object,Date,Number,JSON,readAppsScriptOutbox:()=>[],reportMirror:()=>mirror,reportMirrorKey:()=> 'mirror',transientAppsScriptError:message=>Error(message),
  saveReportSyncValue:async(key,value)=>{if(env.save)persisted.push(clone(value));return env.save;},
  appsScriptRequest:async(action,payload)=>{calls.push({action,payload});if(env.fail)throw Error('Sin conexion');
   if(action==='status')return {ok:true,historyRevision:env.revision};if(action==='get_inventory'){env.afterRead?.();return clone(env.snapshot);}
   if(action==='get_income_report')return payload.filters.pageRows?clone(env.page):clone(env.report);throw Error('Unexpected write '+action);
  }});
 state.sb={rpc:async(name,payload)=>{assert.equal(name,'get_report_changes');calls.push({action:name});const changes=env.events.filter(e=>e.sequence>payload.p_after).slice(0,1);return {data:{ok:true,changes,hasMore:env.events.some(e=>e.sequence>changes.at(-1)?.sequence)}};}};
 vm.runInContext(source.slice(start,end)+';globalThis.api={readCoherentInventorySnapshot,reconcileReportInventory};',context);
 return {mirror,state,env,calls,persisted,api:context.api};
}
test('recupera dos caches antiguas distintas desde la misma lectura remota, sin cambiar ventas ni movimientos',async()=>{
 const a=fixture({legacy:true,projected:63}),b=fixture({legacy:true,projected:-37});
 for(const app of [a,b]){
  const other=clone({cursor:app.mirror.cursor,sales:app.mirror.sales,movements:app.mirror.movements});
  const result=await app.api.readCoherentInventorySnapshot();assert.equal(result.items[0].stock,95);
  assert.equal(app.mirror.inventoryEffects.saved,undefined);assert.deepEqual(clone(app.mirror.inventoryEffects.pending),{product:-2});
  assert.deepEqual(clone({cursor:app.mirror.cursor,sales:app.mirror.sales,movements:app.mirror.movements}),other);
  const second=await app.api.readCoherentInventorySnapshot();assert.equal(second.items[0].stock,95);
  assert.equal(app.calls.filter(c=>c.action==='get_income_report').length,1,'Reutiliza la prueba mientras la revision no cambie.');
  assert.equal(app.calls.filter(c=>c.action==='get_report_changes').length,2,'La recuperacion historica paginada solo se hace una vez.');
  app.env.fail=true;const saved=clone(app.mirror);await assert.rejects(app.api.readCoherentInventorySnapshot());assert.deepEqual(clone(app.mirror),saved);
  app.env.fail=false;assert.equal((await app.api.readCoherentInventorySnapshot()).items[0].stock,95);
 }
});
test('una prueba incompleta, una revision distinta o un fallo durable conserva el inventario guardado',async()=>{
 for(const fault of ['revision','storage','request','history']){
  const app=fixture({legacy:fault==='history'}),before=clone(app.mirror);
  if(fault==='revision')app.env.revision='R2';if(fault==='storage')app.env.save=false;if(fault==='request')app.env.fail=true;
  if(fault==='history')app.env.events=[];
  await assert.rejects(app.api.readCoherentInventorySnapshot());assert.deepEqual(clone(app.mirror),before,fault);
 }
});
test('un ajuste recibido durante la verificacion no se pierde ni se mezcla con una lectura anterior',async()=>{
 const app=fixture();app.env.afterRead=()=>{app.mirror.inventoryEffects.new={product:-1};};
 await assert.rejects(app.api.readCoherentInventorySnapshot());assert.deepEqual(clone(app.mirror.inventoryEffects.new),{product:-1});assert.equal(app.persisted.length,0);
});
test('comprueba las cantidades de ediciones fuera de la primera pagina y conserva las ediciones aun pendientes',async()=>{
 for(const quantity of [2,4]){
  const app=fixture({effects:{edit:{product:-2}},links:{edit:{saleId:'edited',action:'edit_sale',quantities:[['product',4]]}}});
  app.env.report={ok:true,revision:'R1',records:[],recordRows:[{saleId:'edited',row:502}]};app.env.page={ok:true,records:[{saleId:'edited',items:[{menuItemId:'product',quantity}]}]};
  const r=await app.api.readCoherentInventorySnapshot();assert.equal(r.items[0].stock,quantity===4?97:95);
  assert.equal(app.calls.filter(c=>c.action==='get_income_report').length,2);
 }
});
test('cincuenta confirmaciones parciales conservan las mismas unidades finales al avanzar el respaldo',async()=>{
 const effects={},links={};for(let i=0;i<50;i++){effects['op-'+i]={product:-2};links['op-'+i]={saleId:'sale-'+i,action:'record_sale'};}
 const app=fixture({effects,links,projected:900});
 for(const done of [0,20,40,50]){
  app.env.revision='R'+done;app.env.snapshot={ok:true,items:[item(1000-done*2,done+1)]};
  app.env.report={ok:true,revision:app.env.revision,records:[],recordRows:Array.from({length:done},(_,i)=>({saleId:'sale-'+i,row:i+2}))};
  const r=await app.api.readCoherentInventorySnapshot();assert.equal(r.items[0].stock,900,'confirmadas '+done);
 }
 assert.equal(Object.keys(app.mirror.inventoryEffects).length,0);
});
test('registra la referencia de una operacion nueva para evitar releer el historial completo',()=>{
 const app=fixture({effects:{},links:{}});app.api.reconcileReportInventory(app.mirror,{invoice:{id:'new-sale'},inventoryEffect:{operationId:'new',deltas:{product:-2}}},'record_sale');
 assert.equal(app.mirror.inventoryOperations.new.saleId,'new-sale');
});

test('sigue conciliando entradas retiros y operaciones nuevas despues de recuperar los caches antiguos',async()=>{
 const apps=[fixture({legacy:true,projected:63}),fixture({legacy:true,projected:-37})];
 const same=async expected=>{for(const app of apps){const result=await app.api.readCoherentInventorySnapshot();assert.equal(result.items[0].stock,expected);assert.equal(result.items[0].stock*result.items[0].costPrice,expected*40);}};
 await same(95);
 for(const app of apps)app.env.snapshot={ok:true,items:[item(107,3)]};await same(105);
 for(const app of apps)app.env.snapshot={ok:true,items:[item(99,4)]};await same(97);
 for(const app of apps){app.api.reconcileReportInventory(app.mirror,{invoice:{id:'next-sale'},inventoryEffect:{operationId:'next',deltas:{product:-4}}},'record_sale');}
 await same(93);
 for(const app of apps){app.env.revision='R2';app.env.report.revision='R2';app.env.report.recordRows.push({saleId:'next-sale',row:3});app.env.snapshot={ok:true,items:[item(95,5)]};}
 await same(93);
 for(const app of apps){app.env.fail=true;await assert.rejects(app.api.readCoherentInventorySnapshot());app.env.fail=false;}
 await same(93);
 for(const app of apps){app.env.revision='R3';app.env.report.revision='R3';app.env.report.recordRows.push({saleId:'pending-sale',row:4});app.env.snapshot={ok:true,items:[item(93,6)]};}
 await same(93);
 for(const app of apps)app.env.snapshot={ok:true,items:[item(103,7)]};await same(103);
});
