const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

(async () => {
  const root = path.resolve(__dirname, "..");
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261008120000_song_chat_turn_limit.sql"), "utf8");
  const oldMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261007190000_abonos_turnos_caja.sql"), "utf8");
  const songSql = oldMigration.slice(oldMigration.indexOf("create or replace function public.enforce_song_turn_limit()"),
    oldMigration.indexOf("create or replace function public.get_service_request_queue("));
  const db = new PGlite();
  await db.exec(`
    create table public.service_requests (
      id uuid primary key, table_id uuid not null, request_type text not null,
      message text not null, status text not null default 'pending'
    );
    create table public.chat_messages (
      id uuid primary key, table_id uuid not null, sender_type text not null, body text not null
    );
  `);
  await db.exec(songSql);
  await db.exec(migration);
  await db.exec(migration);
  const tableId = "11111111-1111-4111-8111-111111111111";
  for (let n = 1; n <= 5; n++) {
    await db.query("insert into public.service_requests values($1,$2,'other','Mesa solicita la canción: Prueba','pending')",
      [`${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`, tableId]);
  }
  await assert.rejects(db.query("insert into public.service_requests values($1,$2,'other','Mesa solicita la canción: Sexta','pending')",
    ["00000006-1111-4111-8111-111111111111", tableId]), /5 canciones/);
  await assert.rejects(db.query("insert into public.chat_messages values($1,$2,'client','Otra canción')",
    ["22222222-2222-4222-8222-222222222222", tableId]), /5 canciones/);
  await db.query("insert into public.chat_messages values($1,$2,'staff','Atendemos tu mesa')",
    ["33333333-3333-4333-8333-333333333333", tableId]);
  await db.query("update public.service_requests set status='acknowledged' where id=$1",
    ["00000001-1111-4111-8111-111111111111"]);
  await db.query("insert into public.chat_messages values($1,$2,'client','Gracias')",
    ["44444444-4444-4444-8444-444444444444", tableId]);
  assert.equal((await db.query("select count(*)::integer n from public.chat_messages")).rows[0].n, 2);
  await db.close();
  console.log("PASS base de datos: quinta canción permitida, sexta y chat bloqueados, reapertura tras atender el turno");
})().catch((error) => { console.error(error); process.exitCode = 1; });
