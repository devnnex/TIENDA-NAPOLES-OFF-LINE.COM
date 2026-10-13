const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const section=(from,to)=>{const a=source.indexOf('  const '+from+' ='),b=source.indexOf('  const '+to+' =',a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
function fixture(){
 const backend={session:null,items:[],requests:[],writes:0,rpcCalls:[],rpcAvailable:true};
 const state={page:'client',currentTable:{id:'table'},currentSession:null,sessionItems:[],clientRequests:[],clientHydrationToken:0,clientStaffMessageSoundIds:new Set(),clientSyncBusy:false,sessions:[],requests:[]};
 const timers=[];
 const channel={on(){return this;},subscribe(){return this;}};
 const query={select(){return this;},eq(){return this;},order(){return this;},limit(){return this;},maybeSingle:async()=>({data:backend.session}),single:async()=>({data:backend.session}),insert(){backend.writes++;backend.session={id:'created',status:'open',table_id:'table'};return this;}};
 state.sb={from:()=>query,removeChannel(){},channel:()=>channel,rpc:async(name,params)=>{backend.rpcCalls.push({name,params});assert.equal(name,'getClientTableState');return {data:backend.rpcAvailable?{session:backend.session,sessionItems:backend.items,requests:backend.requests}:null};}};
 const context=vm.createContext({state,Date,Number,Map,Set,SYNC_INTERVAL_MS:1500,CHAT_SYNC_INTERVAL_MS:1200,
  db:async query=>(await query).data,readRealtimeData:async query=>(await query).data,
  tableCode:()=> 'valid-qr',renderTablePicker(){},renderAccount(){},renderBillChat(){},renderClientQueue(){},refreshTableLock(){},refreshClientPosData(){},reconcilePendingBillsForTable(){},loadClientSnapshot:async()=>true,loadChatMessages(){},
  setInterval:callback=>{timers.push(callback);return timers.length;},clearInterval(){},window:{clearTimeout(){},setTimeout(){}},
  integerMoney:value=>Number(value||0),normalTables:()=> [{id:'table',table_number:1}],tableMatchesZone:()=>true,tableMatchesGroup:()=>true,tableMatchesSearch:()=>true,isOutdoorTable:()=>false,isTerraceTable:()=>false,
  escapeHTML:String,tableLabel:()=> 'Mesa 1',icon:()=>'',money:value=>'$'+value,sessionTotal:()=>100
 });
 vm.runInContext(section('ensureOpenSession','reconcilePendingBillsForTable')+section('hydrateSelectedTable','loadClientSessionItems')
  +section('subscribeClient','initClient')+section('sessionPayments','sessionBalance')+section('compactTableTiles','renderTables')
  +';globalThis.api={hydrateSelectedTable,ensureOpenSession,subscribeClient,sessionHasConsumption,compactTableTiles};',context);
 return {backend,state,context,timers,api:context.api};
}
test('abrir, recargar, recuperar y consultar un QR libre no escribe ni crea una cuenta en cero',async()=>{
 const f=fixture();for(let i=0;i<4;i++)await f.api.hydrateSelectedTable('table');
 assert.equal(f.backend.writes,0);assert.equal(f.state.currentSession,null);assert.equal(f.state.sessionItems.length,0);
 assert.ok(f.backend.rpcCalls.every(call=>call.params.ensure_session===false));
});
test('si falla el RPC la consulta alternativa también es solo lectura',async()=>{
 const f=fixture();f.backend.rpcAvailable=false;await f.api.hydrateSelectedTable('table');assert.equal(f.backend.writes,0);assert.equal(f.state.currentSession,null);
});
test('el navegador que quedó abierto descubre consumo nuevo y limpia una cuenta cerrada sin reabrirla',async()=>{
 const f=fixture();await f.api.hydrateSelectedTable('table');assert.equal(typeof f.state.clientLiveRefresh,'function');
 f.backend.session={id:'real',status:'open',table_id:'table'};f.backend.items=[{id:'item',status:'served',quantity:1,unit_price:100}];
 await f.state.clientLiveRefresh();assert.equal(f.state.currentSession.id,'real');assert.equal(f.state.sessionItems.length,1);
 f.backend.session=null;f.backend.items=[];await f.state.clientLiveRefresh();assert.equal(f.state.currentSession,null);assert.equal(f.state.sessionItems.length,0);assert.equal(f.backend.writes,0);
});
test('los llamados y el chat no ocupan una mesa vacía; consumo confirmado y abonos reales se conservan',()=>{
 const f=fixture(),row={id:'s',status:'open',table_id:'table',session_items:[]};
 assert.equal(f.api.sessionHasConsumption(row),false);
 assert.equal(f.api.sessionHasConsumption({...row,session_items:[{status:'pending',quantity:1}]}),false);
 assert.equal(f.api.sessionHasConsumption({...row,session_items:[{status:'cancelled',quantity:1}]}),false);
 assert.equal(f.api.sessionHasConsumption({...row,session_items:[{status:'served',quantity:1,unit_price:0}]}),true);
 assert.equal(f.api.sessionHasConsumption({...row,session_items:[{status:'served',quantity:0}]}),false);
 assert.equal(f.api.sessionHasConsumption({...row,session_payments:[{id:'a',amount:100}]}),true);
 f.state.sessions=[row];f.state.requests=[{table_id:'table',status:'pending',request_type:'waiter'}];
 const tile=f.api.compactTableTiles();assert.match(tile,/free/);assert.match(tile,/Libre/);assert.match(tile,/needs-attention/);assert.doesNotMatch(tile,/occupied/);
 row.session_items=[{status:'served',quantity:1}];assert.match(f.api.compactTableTiles(),/occupied/);
});
test('las acciones explícitas mantienen la apertura necesaria para enviar una solicitud o registrar consumo',async()=>{
 const f=fixture();await f.api.ensureOpenSession('table');assert.equal(f.backend.writes,1);assert.equal(f.state.currentSession.id,'created');
 assert.equal(f.api.sessionHasConsumption({...f.state.currentSession,session_items:[]}),false);
});
test('las cuentas y los indicadores usan consumo real para excluir sesiones vacías',()=>{
 assert.match(section('renderAccounts','renderAdminLive'),/sessionHasConsumption\(session\)/);
 assert.match(section('renderAdminShell','sessionTotals'),/sessionHasConsumption\(session\)/);
});
