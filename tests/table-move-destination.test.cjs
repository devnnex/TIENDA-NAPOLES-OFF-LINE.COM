const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261007190000_abonos_turnos_caja.sql'),'utf8');
function block(name){const a=source.indexOf('  const '+name+' ='),b=source.indexOf('\n  const ',a+1);assert.ok(a>=0&&b>a,name);return source.slice(a,b);}
async function fixture(){
 const db=new PGlite();await db.exec(`create table table_sessions(id uuid primary key,table_id uuid,status text default 'open',sale_channel text default 'table',payer_name text,assigned_waiter_id uuid,notes text,payment_method text,updated_at timestamptz,closed_at timestamptz,subtotal numeric default 0,total numeric default 0,discount numeric default 0,tax numeric default 0,service_fee numeric default 0);
 create unique index open_table on table_sessions(table_id) where status='open';
 create table session_items(id uuid primary key,session_id uuid,table_id uuid,quantity numeric,unit_price numeric,status text,updated_by_user_id uuid);
 create table session_payments(id uuid primary key,session_id uuid,amount numeric);
 create table service_requests(id uuid primary key,session_id uuid,table_id uuid);
 create function require_app_user(text) returns void language sql as $$select$$;`);
 const start=migration.indexOf('create or replace function public.replay_table_session_change('),end=migration.indexOf('revoke all on function',start);await db.exec(migration.slice(start,end));
 const ids={source:randomUUID(),empty:randomUUID(),occupied:randomUUID(),s1:randomUUID(),s2:randomUUID(),s3:randomUUID(),item:randomUUID()};
 await db.query('insert into table_sessions(id,table_id) values($1,$2),($3,$4),($5,$6)',[ids.s1,ids.source,ids.s2,ids.empty,ids.s3,ids.occupied]);
 await db.query("insert into session_items(id,session_id,table_id,quantity,unit_price,status) values($1,$2,$3,2,100,'served'),($4,$5,$6,1,200,'served')",[ids.item,ids.s1,ids.source,randomUUID(),ids.s3,ids.occupied]);
 await db.query('insert into service_requests values($1,$2,$3)',[randomUUID(),ids.s1,ids.source]);
 const tables=Object.entries(ids).slice(0,3).map(([name,id])=>({id,table_name:name,is_active:true}));
 const state={tables,requests:[],currentUser:{id:randomUUID()},authToken:'staff',optimisticSessionStates:new Map()};
 state.sessions=await Promise.all((await db.query('select * from table_sessions')).rows.map(async s=>({...s,session_items:(await db.query('select * from session_items where session_id=$1',[s.id])).rows,session_payments:[]})));
 const calls=[],toasts=[];const form={session_id:{value:''},reset(){},querySelector(){return {disabled:false};}},options={innerHTML:''};
 state.sb={rpc:async(name,payload)=>{calls.push({name,payload});try{return(await db.query('select replay_table_session_change($1,$2,$3,$4,$5) result',[payload.auth_token,payload.p_session_id,payload.p_patch,payload.p_expected_status,payload.p_expected_paid??null])).rows[0].result;}catch(_){return null;}},
 from(table){let patch,key,value;const chain={update(p){patch=p;return chain;},eq(k,v){key=k;value=v;return chain;},async select(){const fields=Object.keys(patch);return(await db.query(`update ${table} set ${fields.map((f,i)=>f+'=$'+(i+1)).join(',')} where ${key}=$${fields.length+1} returning id`,[...Object.values(patch),value])).rows;}};return chain;}};
 const context=vm.createContext({state,Date,Set,Map,$:s=>({'#moveTableForm':form,'#moveTableOptions':options,'#moveTableHint':{},'#moveTableDialog':{showModal(){},close(){}}}[s]),
  retryQuiet:factory=>factory(),dbQuiet:p=>p,renderAdminLive(){},persistOfflineAdminSnapshot(){},toast:message=>toasts.push(message),
  refreshIcons(){},icon:()=>'',escapeHTML:String,tableLabel:t=>t.table_name,sessionLabel:()=>'',emptyState:()=>'',integerMoney:n=>Math.max(0,Math.round(Number(n||0)))});
 vm.runInContext(block('sessionPayments')+block('sessionPaid')+block('sessionHasConsumption')+block('openMoveSessionDialog')+block('moveSessionToTable')+';globalThis.move=moveSessionToTable;globalThis.open=openMoveSessionDialog;',context);
 return{db,ids,state,calls,toasts,context,options,async close(){await db.close();}};
}
test('el selector distingue sesión vacía, consumo y abonos; una cuenta ocupada se traslada a la sesión vacía',async()=>{
 const h=await fixture();try{
  h.context.open(h.ids.s1);const choices=h.options.innerHTML;
  assert.match(choices,new RegExp(`value="${h.ids.empty}" ><span>`));assert.match(choices,new RegExp(`value="${h.ids.occupied}" disabled`));
  await h.context.move(h.ids.s1,h.ids.empty);
  assert.equal((await h.db.query('select status from table_sessions where id=$1',[h.ids.s2])).rows[0].status,'closed');
  assert.equal((await h.db.query('select table_id from table_sessions where id=$1',[h.ids.s1])).rows[0].table_id,h.ids.empty);
  assert.equal((await h.db.query('select table_id from session_items where id=$1',[h.ids.item])).rows[0].table_id,h.ids.empty);
  assert.equal((await h.db.query('select table_id from service_requests where session_id=$1',[h.ids.s1])).rows[0].table_id,h.ids.empty);
  assert.equal((await h.db.query('select count(*)::int n from session_items')).rows[0].n,2);
  assert.equal(h.state.tableMoveBusy,false);
 }finally{await h.close();}
});
test('un consumo o abono nuevo en el destino rechaza el traslado aunque la pantalla todavía lo muestre libre',async()=>{
 for(const type of ['item','payment']){const h=await fixture();try{
  if(type==='item')await h.db.query("insert into session_items values($1,$2,$3,1,500,'served',null)",[randomUUID(),h.ids.s2,h.ids.empty]);
  else await h.db.query('insert into session_payments values($1,$2,100)',[randomUUID(),h.ids.s2]);
  await h.context.move(h.ids.s1,h.ids.empty);
  assert.equal((await h.db.query('select table_id from table_sessions where id=$1',[h.ids.s1])).rows[0].table_id,h.ids.source);
  assert.equal((await h.db.query('select status from table_sessions where id=$1',[h.ids.s2])).rows[0].status,'open');
  assert.equal(h.calls.length,1);assert.match(h.toasts.at(-1),/destino cambió/);assert.equal(h.state.tableMoveBusy,false);
 }finally{await h.close();}}
});
test('rechaza destinos con consumo o abonos visibles sin escribir en el backend',async()=>{
 const h=await fixture();try{
  await h.context.move(h.ids.s1,h.ids.occupied);assert.equal(h.calls.length,0);
  h.state.sessions.find(s=>s.id===h.ids.s2).session_payments=[{id:'p',amount:10}];
  h.context.open(h.ids.s1);assert.match(h.options.innerHTML,new RegExp(`value="${h.ids.empty}" disabled`));
  await h.context.move(h.ids.s1,h.ids.empty);assert.equal(h.calls.length,0);
 }finally{await h.close();}
});
