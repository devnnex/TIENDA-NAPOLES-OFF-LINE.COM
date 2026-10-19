const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf('  const '+from+' ='), source.indexOf('  const '+to+' =', source.indexOf('  const '+from+' =')));
const job = (id, action='record_sale', saleId=id) => ({ id, operationId:id, action, status:'pending', attempts:0, nextAttemptAt:0,
  payload: action==='delete_sale' ? {saleId} : {invoice:{id:saleId,sessionId:saleId,items:[{menu_item_id:'p'}]}} });
function fixture(initial) {
  let jobs=structuredClone(initial), fail=false, partial=false, appended=false, writes=0, legacy=false;
  const calls=[], confirmed=new Set(), notices=[], timers=[];
  const state={appsScriptOutboxBusy:false, localSupabaseWrites:0};
  const context=vm.createContext({state, Date, performance, clearTimeout,
    window:{setTimeout:fn=>{timers.push(fn);return 1;}},
    isAppsScriptConfigured:()=>true, flushDurableWrites:async()=>true,
    getOfflineSyncStatus:async()=>({blockingRecords:[]}),
    readAppsScriptOutbox:()=>structuredClone(jobs),
    writeAppsScriptOutbox:async(rows)=>{writes++;jobs=structuredClone(rows);return true;},
    recordSyncEvent(){}, updateGlobalSyncStatus(){}, setInventorySyncStatus(){},
    scheduleAppsScriptRetry:()=>timers.push(true), appsScriptRetryDelay:()=>1000,
    normalizeText:s=>String(s).toLowerCase(), toast:m=>notices.push(m), APPS_SCRIPT_TIMEOUT_MS:45000,
    applyRemoteInventoryItems(){},
    appsScriptRequest:async(action,payload,_timeout,operationId)=>{
      calls.push({action,payload});
      if (action==='sync_sales_batch') {
        if(legacy)return {ok:false,error:'Accion no permitida: sync_sales_batch'};
        const ops=partial ? payload.operations.slice(0,1) : payload.operations;
        const results=ops.map(op=>{confirmed.add(op.operationId);return {operationId:op.operationId,result:{ok:true,batchReceipt:true}};});
        if (!appended) { appended=true; jobs.push(job('new-during-send')); }
        if(fail)throw Error('network response lost');
        return {ok:true,results};
      }
      confirmed.add(operationId);
      if(fail)throw Error('network response lost');
      return {ok:true};
    }
  });
  const helpersEnd=source.includes('  const startOfflineSyncPulse =')?'startOfflineSyncPulse':'isPendingInventoryJob';
  vm.runInContext(section('isSupabaseWriteBlockingJob',helpersEnd)+section('runAppsScriptOutbox','flushAppsScriptOutbox')
    +';globalThis.api={run:runAppsScriptOutbox,next:nextReadyAppsScriptJob};',context);
  return {context,state,calls,confirmed,notices,timers,writes:()=>writes,jobs:()=>jobs,fail:v=>{fail=v;},partial:v=>{partial=v;},legacy:v=>{legacy=v;}};
}
test('envía veinte operaciones por objeto y conserva lo registrado durante el envío',async()=>{
  const f=fixture(Array.from({length:40},(_,i)=>job('sale-'+i)));
  assert.equal(await f.context.api.run(),true);
  assert.deepEqual(f.calls.map(c=>c.action),['sync_sales_batch','sync_sales_batch','record_sale']);
  assert.equal(f.calls[0].payload.operations.length,20);
  assert.equal(f.confirmed.size,41);
  assert.equal(f.writes(),6,'Una escritura de envío y una de confirmación por petición.');
  assert.equal(f.jobs().length,0);
  assert.deepEqual(f.notices,[]);
});
test('respuesta perdida conserva el alta y el borrado para reintentar en ese orden',async()=>{
  const f=fixture([job('create'),job('delete','delete_sale','create')]);f.fail(true);
  assert.equal(await f.context.api.run(),false);
  assert.deepEqual(f.jobs().map(j=>j.id),['create','delete','new-during-send']);
  assert.ok(f.jobs().every(j=>j.status==='pending'));
  f.fail(false);assert.equal(await f.context.api.run(true),true);
  assert.deepEqual(Array.from(f.calls[1].payload.operations,op=>op.operationId),['create','delete','new-during-send']);
  assert.equal(f.jobs().length,0);assert.deepEqual(f.notices,[]);
});
test('una confirmación parcial solo retira los IDs confirmados',async()=>{
  const f=fixture([job('one'),job('two'),job('three')]);f.partial(true);
  assert.equal(await f.context.api.run(),false);
  assert.deepEqual(f.jobs().map(j=>j.id),['two','three','new-during-send']);
  f.partial(false);assert.equal(await f.context.api.run(true),true);
  assert.equal(f.jobs().length,0);
});
test('una edición o borrado no adelanta una venta con reintento retrasado o conflicto',()=>{
  const first=job('create');first.nextAttemptAt=Date.now()+100000;
  const f=fixture([]);
  for (const status of ['pending','syncing','failed','conflict']) {
    first.status=status;
    assert.equal(f.context.api.next([first,job('edit','edit_sale','create')],{},false),null);
    assert.equal(f.context.api.next([first,job('delete','delete_sale','create')],{},false),null);
  }
});

test('mil operaciones sobreviven varios lotes parciales y cortes sin que ningún ID quede fuera',async()=>{
  const initial=Array.from({length:1001},(_,i)=>job('operation-'+i));
  const f=fixture(initial);
  f.partial(true);
  for(let retry=0;retry<8;retry++) {
    await f.context.api.run(true);
    const retained=new Set([...f.jobs().map(j=>j.id),...f.confirmed]);
    for(const entry of initial)assert.ok(retained.has(entry.id),entry.id);
  }
  f.partial(false);f.fail(true);
  for(let retry=0;retry<3;retry++)await f.context.api.run(true);
  f.fail(false);
  assert.equal(await f.context.api.run(true),true);
  assert.equal(f.jobs().length,0);
  assert.equal(f.confirmed.size,1002,'Incluye la operación creada mientras viajaba otro lote.');
  for(const entry of initial)assert.ok(f.confirmed.has(entry.id),entry.id);
  assert.ok(f.calls.filter(call=>call.action==='sync_sales_batch').every(call=>call.payload.operations.length<=20));
});

test('el backend anterior conserva todos los IDs sin repetir la consulta de capacidad por cada venta',async()=>{
  const f=fixture(Array.from({length:40},(_,i)=>job('legacy-'+i)));f.legacy(true);
  assert.equal(await f.context.api.run(),true);
  assert.equal(f.calls.filter(call=>call.action==='sync_sales_batch').length,1);
  assert.equal(f.confirmed.size,40);assert.equal(f.jobs().length,0);
});
