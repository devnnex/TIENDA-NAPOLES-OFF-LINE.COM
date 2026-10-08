const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

(async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon; create role authenticated; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table app_users(id uuid primary key, role text);
    insert into app_users values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','waiter');
    create function require_app_user(token text) returns app_users language plpgsql as $$
      declare staff app_users; begin
      if token <> 'valid' then raise exception 'No autorizado'; end if;
      select * into staff from app_users limit 1; return staff; end; $$;
    create table restaurant_tables(id uuid primary key, table_number integer, qr_image_url text);
    create table table_sessions(id uuid primary key,table_id uuid,status text default 'open',payer_name text,
      assigned_waiter_id uuid,sale_channel text default 'table',notes text,payment_method text,opened_at timestamptz default now(),
      closed_at timestamptz,subtotal numeric default 0,discount numeric default 0,tax numeric default 0,service_fee numeric default 0,total numeric default 0,updated_at timestamptz default now());
    create table session_items(id uuid primary key,session_id uuid,quantity integer,unit_price numeric,status text);
    create table service_requests(id uuid primary key,table_id uuid,request_type text,message text,status text default 'pending',created_at timestamptz default now());
    create function valid_table_access(p_table_id uuid,p_code text) returns boolean language sql as $$ select p_code='qr-valid' and p_table_id is not null $$;
    create function get_admin_snapshot(auth_token text) returns jsonb language plpgsql as $$ begin
      perform require_app_user(auth_token);
      return jsonb_build_object('original_field','preserved','requests','[]'::jsonb,'sessions',
        (select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) from table_sessions s where s.status='open')); end; $$;
  `);
  const migration = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261007190000_abonos_turnos_caja.sql'),'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const table = '11111111-1111-4111-8111-111111111111';
  const account = '22222222-2222-4222-8222-222222222222';
  const payment = '33333333-3333-4333-8333-333333333333';
  await db.query('insert into restaurant_tables(id,table_number) values($1,8)',[table]);
  await db.query('insert into table_sessions(id,table_id) values($1,$2)',[account,table]);
  await db.query("insert into session_items values('44444444-4444-4444-8444-444444444444',$1,3,10000,'served')",[account]);
  const call = async (sql, args) => (await db.query(sql,args)).rows[0].result;
  const add = (id,amount,token='valid') => call('select record_session_payment($1,$2,$3,$4,$5,$6,$7) result',[token,id,account,amount,'cash','Abono prueba','2026-10-07T16:30:00Z']);
  await assert.rejects(add(payment,10000,'bad'),/No autorizado/);
  await assert.rejects(add(payment,0),/no válido/);
  await assert.rejects(add(payment,40000),/supera el saldo/);
  const added = await add(payment,10000);
  assert.equal(Number(added.payment.amount),10000);
  assert.equal(added.payment.created_by_user_id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal((await add(payment,10000)).duplicate,true);
  await assert.rejects(add(payment,9000),/identificador/);
  const snapshot = await call('select get_admin_snapshot($1) result',['valid']);
  assert.equal(snapshot.original_field,'preserved');
  assert.equal(snapshot.sessions[0].session_payments.length,1);
  assert.equal(snapshot.pos_features.remote_drawer,true);
  await assert.rejects(call('select get_session_payments($1,$2,$3,$4) result',[account,'',table,'bad']),/no autorizado/);
  assert.equal((await call('select get_session_payments($1,$2,$3,$4) result',[account,'',table,'qr-valid'])).payments.length,1);
  const closure = { status:'closed',closed_at:'2026-10-07T18:00:00Z',subtotal:30000,total:30000,discount:0,tax:0,service_fee:0 };
  const close = paid => call('select replay_table_session_change($1,$2,$3,$4,$5) result',['valid',account,closure,'open',paid]);
  await assert.rejects(close(0),/abonos cambiaron/);
  assert.equal((await close(10000)).session.status,'closed');
  assert.equal((await close(10000)).duplicate,true);
  await db.query('delete from table_sessions where id=$1',[account]);
  assert.equal((await call('select get_session_payments($1,$2) result',[account,'valid'])).payments.length,1);
  console.log('PASS abonos autenticados, saldo, identidad estable, cierre con verificación y archivo conservado');

  await db.query("insert into service_requests values('55555555-5555-4555-8555-555555555555',$1,'waiter','', 'pending','2026-10-07T12:00:00Z')",[table]);
  const other = '66666666-6666-4666-8666-666666666666';
  await db.query("insert into service_requests values('77777777-7777-4777-8777-777777777777',$1,'waiter','', 'pending','2026-10-07T13:00:00Z')",[other]);
  for (let i=0;i<5;i++) await db.query("insert into service_requests(id,table_id,request_type,message) values($1,$2,'other','Mesa solicita la canción: tema')",[`88888888-8888-4888-8888-${String(i).padStart(12,'0')}`,other]);
  await assert.rejects(db.query("insert into service_requests(id,table_id,request_type,message) values('99999999-9999-4999-8999-999999999999',$1,'other','Mesa solicita la canción: tema 6')",[other]),/máximo 5/);
  let queue = await call('select get_service_request_queue($1,$2) result',[other,'qr-valid']);
  assert.equal(queue.requests.find(row=>row.kind==='service').position,2);
  assert.equal(queue.requests.find(row=>row.kind==='song').position,1);
  assert.equal(queue.requests.filter(row=>row.kind==='song').length,5);
  await db.query("update service_requests set status='acknowledged' where table_id=$1 and request_type='other'",[other]);
  await db.query("insert into service_requests(id,table_id,request_type,message) values('99999999-9999-4999-8999-999999999999',$1,'other','Mesa solicita la canción: nuevo turno')",[other]);
  await assert.rejects(call('select get_service_request_queue($1,$2) result',[other,'bad']),/Mesa no autorizada/);
  console.log('PASS turnos independientes, cinco canciones y nuevo turno tras atender el anterior');

  const device='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', command='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const secret='controller-secret-with-more-than-32-characters';
  await call('select register_pos_drawer($1,$2,$3,$4) result',['valid',device,secret,'POS del negocio']);
  await assert.rejects(call('select register_pos_drawer($1,$2,$3,$4) result',['valid',device,secret+'other','Caja falsa']),/no válida/);
  const requested=await call('select request_pos_drawer($1,$2) result',['valid',command]);
  assert.equal(requested.command.device_id,device);
  await call('select request_pos_drawer($1,$2) result',['valid',command]);
  await assert.rejects(call('select claim_pos_drawer($1,$2,$3) result',['valid',device,'bad']),/no autorizado/);
  assert.equal((await call('select claim_pos_drawer($1,$2,$3) result',['valid',device,secret])).command.id,command);
  assert.equal((await call('select claim_pos_drawer($1,$2,$3) result',['valid',device,secret])).command,null);
  await call('select finish_pos_drawer($1,$2,$3,$4,$5) result',['valid',device,secret,command,true]);
  assert.equal((await call('select get_pos_drawer_command($1,$2) result',['valid',command])).command.status,'accepted');
  await db.query("update pos_drawer_devices set last_seen=now()-interval '1 minute' where id=$1",[device]);
  await assert.rejects(call('select request_pos_drawer($1,$2) result',['valid','dddddddd-dddd-4ddd-8ddd-dddddddddddd']),/No hay una caja conectada/);
  console.log('PASS apertura remota a una sola caja, orden única, secreto, confirmación y rechazo de equipos ausentes');
  await db.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
