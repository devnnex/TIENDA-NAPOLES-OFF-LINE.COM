const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const backup=fs.readFileSync(path.join(__dirname,'../supabase/backups/schema_2026-09-03.sql'),'utf8');
test('las treinta mesas libres o con sesión envían mesero, canción y chat con el backend anterior, sin registrar consumo',async()=>{
 const db=new PGlite();await db.exec(`create table restaurant_tables(id uuid primary key,qr_code text,is_active boolean default true);
 create table table_sessions(id uuid primary key default gen_random_uuid(),table_id uuid,status text default 'open');
 create unique index open_table on table_sessions(table_id) where status='open';
 create table service_requests(id uuid primary key,table_id uuid,session_id uuid,request_type text,message text,status text default 'pending');
 create function valid_table_access(p_id uuid,p_code text) returns boolean language sql as $$select exists(select 1 from restaurant_tables where id=p_id and qr_code=p_code and is_active)$$;`);
 const a=backup.indexOf('CREATE OR REPLACE FUNCTION "public"."create_service_request"('),b=backup.indexOf('ALTER FUNCTION "public"."create_service_request"',a);await db.exec(backup.slice(a,b));
 const tables=Array.from({length:30},(_,i)=>({id:randomUUID(),qr_code:'qr-'+(i+1)}));
 for(const table of tables)await db.query('insert into restaurant_tables(id,qr_code) values($1,$2)',[table.id,table.qr_code]);
 await db.query('insert into table_sessions(table_id) values($1)',[tables[3].id]);
 await assert.rejects(db.query('select create_service_request($1,$2,$3,$4,$5,null)',[randomUUID(),tables[0].id,tables[0].qr_code,'waiter','']),/ambiguous/);
 const state={currentTable:tables[0],currentSession:null};
 const context=vm.createContext({state,Map,URL,AbortController,SUPABASE_CONFIG:{url:'https://fixture.supabase.co',anonKey:'public'},uid:randomUUID,subscribeClient(){},window:{setTimeout,clearTimeout},
  fetch:async(raw,options)=>{
   const url=new URL(raw),body=options.body?JSON.parse(options.body):null,tableId=body?.table_id || url.searchParams.get('table_id').slice(3);
   assert.equal(options.headers['x-table-id'],tableId);const allowed=(await db.query('select valid_table_access($1,$2) allowed',[tableId,options.headers['x-table-code']])).rows[0].allowed;
   if(!allowed)return Response.json({message:'No autorizado'},{status:403});
   if(body){try{const row=await db.query('insert into table_sessions(id,table_id,status) values($1,$2,$3) returning *',[body.id,body.table_id,body.status]);return Response.json(row.rows,{status:201});}catch(error){return Response.json({message:error.message},{status:409});}}
   return Response.json((await db.query("select * from table_sessions where table_id=$1 and status='open'",[tableId])).rows);
  }});
 const from=source.indexOf('  const requestSessionReads ='),to=source.indexOf('  const flushRequestOutbox =',from);
 vm.runInContext(source.slice(from,to)+';globalThis.prepare=prepareRequestSession;',context);
 assert.equal(await context.prepare({table_id:tables[1].id,table_access_code:'invalid'}),null);
 const sessions=await Promise.all(tables.map(table=>context.prepare({table_id:table.id,table_access_code:table.qr_code})));
 assert.ok(sessions.every((session,i)=>session?.table_id===tables[i].id));
 for(const [i,table] of tables.entries())for(const [type,message] of [['waiter',''],['other','Mesa solicita la canción: Prueba'],['other','Mesa escribió en el chat: Hola']]){
  const result=await db.query('select create_service_request($1,$2,$3,$4,$5,$6) result',[randomUUID(),table.id,table.qr_code,type,message,sessions[i].id]);assert.equal(result.rows[0].result.request.table_id,table.id);
 }
 assert.equal((await db.query('select count(*)::int n from service_requests')).rows[0].n,90);
 assert.equal((await db.query('select count(*)::int n from table_sessions')).rows[0].n,30);
 const one={table_id:tables[0].id,table_access_code:tables[0].qr_code};await Promise.all([context.prepare(one),context.prepare(one)]);
 assert.equal((await db.query('select count(*)::int n from table_sessions')).rows[0].n,30,'No se duplican sesiones ni se insertan líneas de consumo.');
 const added={id:randomUUID(),qr_code:'qr-creada-despues'};await db.query('insert into restaurant_tables(id,qr_code) values($1,$2)',[added.id,added.qr_code]);
 const newSession=await context.prepare({table_id:added.id,table_access_code:added.qr_code});
 assert.equal(newSession.table_id,added.id,'Una mesa creada después funciona sin modificar una lista fija ni reiniciar el cliente.');
 for(const [type,message] of [['waiter',''],['other','Canción'],['other','Chat']])await db.query('select create_service_request($1,$2,$3,$4,$5,$6)',[randomUUID(),added.id,added.qr_code,type,message,newSession.id]);
 assert.equal((await db.query('select count(*)::int n from service_requests')).rows[0].n,93);
 await db.close();
});
