const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),test=require('node:test');
const {PGlite}=require('@electric-sql/pglite');
test('la bitácora rápida exige empleado autorizado, protege importes, ordena e identifica los reintentos',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema realtime;
   create table notices(payload jsonb,event text,topic text);
   create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$insert into public.notices values(payload,event,topic)$$;
   create table business_settings(id int);create table app_users(role text,permissions jsonb);
   create function require_app_user(token text) returns app_users language plpgsql as $$begin
    if token='boss' then return ('boss',null)::app_users;
    elsif token='stock' then return ('admin','["inventory","movements"]'::jsonb)::app_users;
    elsif token='sales' then return ('admin','["income"]'::jsonb)::app_users;
    elsif token='waiter' then return ('waiter',null)::app_users;
    else raise exception 'No autorizado';end if;end$$;`);
  const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261013160000_fast_reports_and_client_bill.sql'),'utf8');await db.exec(migration);await db.exec(migration);
  const payload={invoice:{id:'a',payerName:'Privado',totals:{total:300}},movements:[{movementId:'m',delta:-1}],items:[{productId:'p',stock:3}]};
  const publish=(token,id='op',action='record_sale')=>db.query('select publish_report_change($1,$2,$3,$4::jsonb) result',[token,id,action,JSON.stringify(payload)]);
  await assert.rejects(publish('bad'),/No autorizado/);await assert.rejects(publish('waiter'),/No autorizado/);
  const first=(await publish('boss')).rows[0].result;const duplicate=(await publish('boss')).rows[0].result;assert.equal(duplicate.sequence,first.sequence);assert.equal(duplicate.duplicate,true);
  await assert.rejects(publish('boss','op','edit_sale'),/Operación ya utilizada/);
  await assert.rejects(publish('boss','bad-action','arbitrary'),/Cambio no válido/);
  const read=async(token,after=0)=>(await db.query('select get_report_changes($1,$2) result',[token,after])).rows[0].result;
  await assert.rejects(read(''),/No autorizado/);await assert.rejects(read('waiter'),/No autorizado/);
  assert.equal((await read('boss')).changes[0].payload.invoice.payerName,'Privado');
  const stock=(await read('stock')).changes[0].payload;assert.equal(stock.invoice,undefined);assert.equal(stock.movements.length,1);
  const sales=(await read('sales')).changes[0].payload;assert.equal(sales.invoice.id,'a');assert.equal(sales.items.length,0);assert.equal(sales.movements.length,0);
  assert.equal((await read('boss',first.sequence)).changes.length,0);
  const notices=(await db.query('select * from notices')).rows;assert.equal(notices.length,1);assert.deepEqual(notices[0].payload,{});assert.equal(notices[0].event,'reports-committed');
  await db.exec('set role anon');await assert.rejects(db.query('select * from pos_report_changes'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
