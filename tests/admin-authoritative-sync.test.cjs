const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const from=source.indexOf('  const loadAdminData ='),to=source.indexOf(source.includes('  const setScopedCoreRead =')?'  const setScopedCoreRead =':'  const mergePendingCoreData =',from);
assert.ok(from>0&&to>from);
const account={id:'account-a',status:'open',session_items:[{id:'item-a',quantity:2,unit_price:10000,item_name:'Anterior'}],session_payments:[]};
let remote=null,restReads=0;
const cached={sessions:[account],requests:[]};
const state={authToken:'valid',sessions:[account],requests:[],syncFresh:{},optimisticSessionStates:new Map(),sb:{rpc:async()=>({data:remote}),from:()=>{restReads++;throw Error('Un GET vacío no reemplaza una RPC autorizada.');}}};
const context=vm.createContext({state,Date,navigator:{onLine:true},
 readOfflineAdminSnapshot:()=>cached,getOfflineSyncStatus:async()=>({blockingRecords:[]}),
 pendingAdminReadScope:()=>({safe:true,sessionIds:new Set(),requestIds:new Set(),closedIds:new Set()}),
 setScopedAdminRead:async()=>true,mergePendingAdminRows:s=>s,
 mergeOptimisticRequests:r=>r,mergeOptimisticSessions:r=>r,persistOfflineAdminSnapshot(){},
 dbQuiet:async q=>(await q)?.data});
vm.runInContext(source.slice(from,to)+';globalThis.read=loadAdminData;',context);
(async()=>{
 assert.equal(await context.read(),false);
 assert.equal(state.sessions[0].id,'account-a');assert.equal(restReads,0);
 remote={sessions:[account],requests:[]};assert.equal(await context.read(),true);
 remote={sessions:[{...account,session_items:[{...account.session_items[0],unit_price:8000,item_name:'Actualizado en el otro equipo'}]}],requests:[]};
 assert.equal(await context.read(),true,'Nombre y precio se actualizan aunque IDs, cantidad y fechas no cambien.');
 assert.equal(state.sessions[0].session_items[0].unit_price,8000);
 remote={sessions:[],requests:[]};assert.equal(await context.read(),true);
 assert.equal(state.sessions.length,0,'Una respuesta autorizada válida y vacía sí libera las cuentas cerradas o retiradas.');
 console.log('PASS cuentas: error de red/RLS conserva datos; snapshot autorizado actualiza precio/nombre y acepta vacío confirmado.');
})().catch(e=>{console.error(e);process.exitCode=1;});
