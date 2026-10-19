const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const ids=['10000000-0000-4000-a000-000000000001','10000000-0000-4000-a000-000000000002'];
const cardId=n=>`20000000-0000-4000-a000-${String(n).padStart(12,'0')}`;
const imagePath=n=>`cards/${cardId(n)}/${String(n).padStart(64,'a')}.png`;
test('Carta: SQL idempotente, permisos reales RLS, mesas, concurrencia, orden y almacenamiento privado',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema storage;
   create table app_users(role text,permissions jsonb);
   create table restaurant_tables(id uuid primary key,is_active boolean default true);
   create table service_requests(id int primary key,message text);insert into service_requests values(1,'Sin modificar');
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id int generated always as identity,bucket_id text,name text);
   alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
   grant select,insert,delete on storage.objects to anon,authenticated;
   grant usage on sequence storage.objects_id_seq to anon,authenticated;
   create function app_user_for_token(token text) returns app_users language sql as $$select case
     when token='boss' then ('boss',null)::app_users
     when token='brand' then ('admin','["brand"]'::jsonb)::app_users
     when token='stock' then ('admin','["inventory"]'::jsonb)::app_users
     when token='legacy' then ('admin',null)::app_users
     when token='waiter' then ('waiter',null)::app_users else null end$$;
   create function request_header(key text) returns text language sql as $$select current_setting('test.'||replace(key,'-','_'),true)$$;
   create function valid_table_access(id uuid,code text) returns boolean language sql as $$select code='qr-'||id::text and exists(select 1 from restaurant_tables t where t.id=$1 and t.is_active)$$;
   create function valid_table_header(id uuid) returns boolean language sql as $$select id::text=request_header('x-table-id') and valid_table_access(id,request_header('x-table-code'))$$;
   insert into restaurant_tables(id) values('${ids[0]}'),('${ids[1]}');`);
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261019190000_pos_menu_cards.sql'),'utf8');
  await db.exec(sql);await db.exec(sql);
  const value=async(sql,args)=>(await db.query(sql,args)).rows[0]?.result;
  const list=token=>value('select pos_list_menu_cards($1) result',[token]);
  const save=(n,token='boss',tables=[],all=true,version=0,name='Carta '+n)=>value('select pos_save_menu_card($1,$2,$3,$4,$5::uuid[],$6,$7) result',[cardId(n),name,imagePath(n),all,tables,version,token]);
  const upload=n=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['pos-menu-cards',imagePath(n)]);
  const get=(table,code='qr-'+table)=>value('select pos_get_menu_cards($1,$2) result',[table,code]);
  for(const token of ['', 'bad','waiter','stock']){
   await assert.rejects(list(token),/permiso/);
   await assert.rejects(save(1,token),/permiso/);
   await assert.rejects(db.query('select pos_delete_menu_card($1,1,$2)',[cardId(1),token]),/permiso/);
   await assert.rejects(db.query('select pos_reorder_menu_cards($1::uuid[],$2)',[[],token]),/permiso/);
  }
  assert.deepEqual(await list('brand'),[]);assert.deepEqual(await list('legacy'),[]);
  await assert.rejects(save(1),/sube una imagen/);await upload(1);await upload(2);
  const a=await save(1,'brand',[ids[0]],false);assert.equal(a.version,1);
  const duplicate=await save(1,'brand',[ids[0]],false);assert.equal(duplicate.version,1);assert.equal((await list('boss')).length,1);
  await assert.rejects(save(1,'brand',[ids[1]],false,0),/Otra persona/);
  await assert.rejects(save(2,'boss',[cardId(99)],false),/mesas inactivas/);
  await save(2);assert.equal((await get(ids[0])).length,2);assert.equal((await get(ids[1])).length,1);
  await assert.rejects(get(ids[0],'bad'),/QR válido/);
  await db.query('select pos_reorder_menu_cards($1::uuid[],$2)',[[cardId(2),cardId(1)],'boss']);
  assert.equal((await get(ids[0]))[0].id,cardId(2));
  await assert.rejects(db.query('select pos_reorder_menu_cards($1::uuid[],$2)',[[cardId(1),cardId(1)],'brand']),/biblioteca cambió/);
  const bucket=(await db.query("select * from storage.buckets where id='pos-menu-cards'")).rows[0];
  assert.equal(bucket.public,false);assert.equal(Number(bucket.file_size_limit),15*1024*1024);assert.deepEqual(bucket.allowed_mime_types,['image/jpeg','image/png','image/webp']);
  await db.exec('set role anon');await assert.rejects(db.query('select * from pos_menu_cards'),/permission denied/);await db.exec('reset role');
  await db.query("select set_config('test.x_app_token','waiter',false)");await db.exec('set role anon');
  await assert.rejects(upload(3),/row-level security/);await db.exec('reset role');
  await db.query("select set_config('test.x_app_token','brand',false)");await db.exec('set role anon');
  await upload(3);assert.equal((await db.query("delete from storage.objects where name=$1 returning *",[imagePath(1)])).rows.length,0);
  await db.exec('reset role');
  await db.query("select set_config('test.x_app_token','',false),set_config('test.x_table_id',$1,false),set_config('test.x_table_code',$2,false)",[ids[1],'qr-'+ids[1]]);
  await db.exec('set role anon');
  const visible=(await db.query('select name from storage.objects')).rows;assert.deepEqual(visible.map(r=>r.name),[imagePath(2)]);
  await db.exec('reset role');
  await db.query("select set_config('test.x_table_code','bad-code',false)");await db.exec('set role anon');
  assert.equal((await db.query('select * from storage.objects')).rows.length,0);await db.exec('reset role');
  const current=(await list('boss')).find(c=>c.id===cardId(1));
  await assert.rejects(db.query('select pos_delete_menu_card($1,$2,$3)',[cardId(1),0,'boss']),/Otra persona/);
  await db.query('select pos_delete_menu_card($1,$2,$3)',[cardId(1),current.version,'boss']);
  await db.query("select set_config('test.x_app_token','brand',false)");await db.exec('set role anon');
  assert.equal((await db.query('delete from storage.objects where name=$1 returning *',[imagePath(1)])).rows.length,1);
  await db.exec('reset role');assert.equal((await get(ids[0])).length,1);
  for(let n=3;n<=21;n++){if(n>3)await upload(n);await save(n);}
  await upload(22);await assert.rejects(save(22),/Máximo 20/);
  assert.equal((await list('boss')).length,20);
  assert.deepEqual((await db.query('select * from service_requests')).rows,[{id:1,message:'Sin modificar'}]);
  assert.equal((await db.query('select count(*)::int n from restaurant_tables')).rows[0].n,2);
 }finally{await db.close();}
});
