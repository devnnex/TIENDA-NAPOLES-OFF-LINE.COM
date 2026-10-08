-- Ejecutar UNA vez en el SQL Editor del backend compartido por BCA y Offline.
-- Aditivo e idempotente. No borra cuentas, consumos, ventas ni colas existentes.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.restaurant_tables add column if not exists is_outdoor boolean not null default false;

create table if not exists public.session_payments (
  id uuid primary key,
  -- Conserva el registro cuando Apps Script archiva y retira la cuenta.
  session_id uuid not null,
  amount numeric(12,0) not null check (amount > 0),
  payment_method text not null check (payment_method in ('cash','transfer','breb')),
  reference text not null default '',
  created_by_user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists session_payments_session_idx on public.session_payments(session_id, created_at);
alter table public.session_payments drop constraint if exists session_payments_session_id_fkey;
alter table public.session_payments enable row level security;
revoke all on public.session_payments from anon, authenticated;

create or replace function public.record_session_payment(auth_token text, payment_id uuid, p_session_id uuid, p_amount numeric, p_method text, p_reference text default '', p_created_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare staff jsonb; account public.table_sessions; saved public.session_payments; consumed numeric; paid numeric;
begin
  staff := to_jsonb(public.require_app_user(auth_token));
  select * into account from public.table_sessions s where s.id = p_session_id for update;
  if not found then raise exception 'La cuenta no existe. El abono no fue registrado.'; end if;
  select * into saved from public.session_payments p where p.id = payment_id;
  if found then
    if saved.session_id <> p_session_id or saved.amount <> p_amount or saved.payment_method <> p_method or saved.reference <> left(coalesce(p_reference,''),100) then
      raise exception 'El identificador de abono ya pertenece a otro pago.';
    end if;
    return jsonb_build_object('payment',to_jsonb(saved),'duplicate',true);
  end if;
  if account.status <> 'open' then raise exception 'La cuenta ya está cerrada. El abono no fue registrado.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount) or p_method not in ('cash','transfer','breb') then raise exception 'Abono no válido.'; end if;
  select coalesce(sum(i.quantity*round(i.unit_price)),0) into consumed from public.session_items i where i.session_id=p_session_id and i.status <> 'cancelled';
  select coalesce(sum(p.amount),0) into paid from public.session_payments p where p.session_id=p_session_id;
  if p_amount > consumed-paid then raise exception 'El abono supera el saldo pendiente. Actualiza la cuenta.'; end if;
  insert into public.session_payments(id,session_id,amount,payment_method,reference,created_by_user_id,created_at)
  values(payment_id,p_session_id,p_amount,p_method,left(coalesce(p_reference,''),100),(staff->>'id')::uuid,least(coalesce(p_created_at,now()),now())) returning * into saved;
  return jsonb_build_object('payment',to_jsonb(saved),'duplicate',false);
end;
$$;
revoke all on function public.record_session_payment(text,uuid,uuid,numeric,text,text,timestamptz) from public;
grant execute on function public.record_session_payment(text,uuid,uuid,numeric,text,text,timestamptz) to anon, authenticated;

create or replace function public.get_session_payments(p_session_id uuid, auth_token text default '', p_table_id uuid default null, p_table_access_code text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if coalesce(auth_token,'') <> '' then perform public.require_app_user(auth_token);
  elsif not public.valid_table_access(p_table_id,p_table_access_code) or not exists(select 1 from public.table_sessions s where s.id=p_session_id and s.table_id=p_table_id) then
    raise exception 'Acceso a la cuenta no autorizado.';
  end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at,p.id),'[]'::jsonb) into result from public.session_payments p where p.session_id=p_session_id;
  return jsonb_build_object('payments',result);
end;
$$;
revoke all on function public.get_session_payments(uuid,text,uuid,text) from public;
grant execute on function public.get_session_payments(uuid,text,uuid,text) to anon, authenticated;

-- Lectura autorizada de una cuenta: no interpreta cero filas de REST como
-- prueba de eliminación cuando una política impide verlas.
create or replace function public.get_table_session_for_sync(auth_token text,p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  perform public.require_app_user(auth_token);
  select to_jsonb(s) into result from public.table_sessions s where s.id=p_session_id;
  return jsonb_build_object('session',result,'exists',result is not null);
end;
$$;
create or replace function public.replay_table_session_change(auth_token text,p_session_id uuid,p_patch jsonb,p_expected_status text default '',p_expected_paid numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare current_row public.table_sessions; next_row public.table_sessions; consumed numeric; paid numeric; field text;
begin
  perform public.require_app_user(auth_token);
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'Cambio de cuenta no válido.'; end if;
  for field in select jsonb_object_keys(p_patch) loop
    if field not in ('payer_name','assigned_waiter_id','table_id','sale_channel','notes','payment_method','updated_at','status','closed_at','subtotal','discount','tax','service_fee','total') then raise exception 'Campo de cuenta no permitido: %',field; end if;
  end loop;
  select * into current_row from public.table_sessions s where s.id=p_session_id for update;
  if not found then raise exception 'La cuenta no existe. No se aplicó el cambio.'; end if;
  select coalesce(sum(p.amount),0) into paid from public.session_payments p where p.session_id=p_session_id;
  if p_expected_paid is not null and paid <> p_expected_paid then raise exception 'Los abonos cambiaron en otra sesión. Actualiza la cuenta antes de cobrar.'; end if;
  if current_row.status='closed' and p_patch->>'status'='closed' and current_row.closed_at=(p_patch->>'closed_at')::timestamptz then
    return jsonb_build_object('session',to_jsonb(current_row),'duplicate',true);
  end if;
  if current_row.status <> 'open' or (p_expected_status <> '' and current_row.status <> p_expected_status) then raise exception 'La cuenta cambió de estado. Actualiza antes de continuar.'; end if;
  next_row := jsonb_populate_record(current_row,p_patch);
  if p_patch ? 'status' then
    if next_row.status <> 'closed' then raise exception 'Estado de cuenta no permitido.'; end if;
    select coalesce(sum(i.quantity*round(i.unit_price)),0) into consumed from public.session_items i where i.session_id=p_session_id and i.status <> 'cancelled';
    if paid > consumed then raise exception 'Los abonos superan el consumo actual. Revisa la cuenta antes de cobrar.'; end if;
    if next_row.subtotal <> consumed or next_row.total <> consumed or next_row.discount <> 0 or next_row.tax <> 0 or next_row.service_fee <> 0 then raise exception 'El consumo cambió. Actualiza la cuenta antes de cobrar.'; end if;
  elsif p_patch ?| array['closed_at','subtotal','discount','tax','service_fee','total'] then
    raise exception 'No se pueden cambiar importes sin cerrar la cuenta.';
  end if;
  update public.table_sessions s set payer_name=next_row.payer_name,assigned_waiter_id=next_row.assigned_waiter_id,
    table_id=next_row.table_id,sale_channel=next_row.sale_channel,notes=next_row.notes,payment_method=next_row.payment_method,
    status=next_row.status,closed_at=next_row.closed_at,subtotal=next_row.subtotal,discount=next_row.discount,
    tax=next_row.tax,service_fee=next_row.service_fee,total=next_row.total,updated_at=now()
  where s.id=p_session_id returning s.* into current_row;
  return jsonb_build_object('session',to_jsonb(current_row),'duplicate',false);
end;
$$;
revoke all on function public.get_table_session_for_sync(text,uuid),public.replay_table_session_change(text,uuid,jsonb,text,numeric) from public;
grant execute on function public.get_table_session_for_sync(text,uuid),public.replay_table_session_change(text,uuid,jsonb,text,numeric) to anon,authenticated;

-- Copia la implementación administrativa actual, con sus permisos y campos,
-- antes de añadir abonos al resultado. No reemplaza la autenticación existente.
do $patch$
declare definition text;
begin
  if to_regprocedure('public.get_admin_snapshot_before_abonos(text)') is null then
    -- Conserva las mesas exteriores marcadas por el BCA anterior. Solo se
    -- convierte una vez; repetir la migración no revierte cambios posteriores.
    update public.restaurant_tables set is_outdoor=true
    where qr_image_url like 'tn-outdoor:v1:%' and is_outdoor is false;
    definition := pg_get_functiondef('public.get_admin_snapshot(text)'::regprocedure);
    definition := regexp_replace(definition,'FUNCTION public\.get_admin_snapshot\(', 'FUNCTION public.get_admin_snapshot_before_abonos(', 'i');
    execute definition;
  end if;
end;
$patch$;
revoke all on function public.get_admin_snapshot_before_abonos(text) from public, anon, authenticated;
create or replace function public.get_admin_snapshot(auth_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare snapshot jsonb; sessions jsonb;
begin
  snapshot := public.get_admin_snapshot_before_abonos(auth_token);
  select coalesce(jsonb_agg(account || jsonb_build_object('session_payments',(
    select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at,p.id),'[]'::jsonb)
    from public.session_payments p where p.session_id=(account->>'id')::uuid
  ))),'[]'::jsonb) into sessions from jsonb_array_elements(coalesce(snapshot->'sessions','[]'::jsonb)) account;
  return snapshot || jsonb_build_object('sessions',sessions,'pos_features',jsonb_build_object('abonos',true,'turnos',true,'remote_drawer',true));
end;
$$;
grant execute on function public.get_admin_snapshot(text) to anon, authenticated;

-- Limita canciones dentro del mismo turno pendiente. El bloqueo por mesa
-- evita superar cinco enviando desde varios celulares simultáneamente.
create or replace function public.enforce_song_turn_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare queued integer;
begin
  if new.request_type <> 'other' or lower(new.message) not like '%solicita la canci%n:%' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('song:'||new.table_id::text,0));
  if exists(select 1 from public.service_requests r where r.id=new.id) then return new; end if;
  select count(*) into queued from public.service_requests r where r.table_id=new.table_id
    and r.status='pending' and r.request_type='other' and lower(r.message) like '%solicita la canci%n:%';
  if queued >= 5 then raise exception 'Puedes pedir máximo 5 canciones por turno. Espera a que termine tu turno.'; end if;
  return new;
end;
$$;
drop trigger if exists service_requests_song_limit on public.service_requests;
create trigger service_requests_song_limit before insert on public.service_requests for each row execute function public.enforce_song_turn_limit();

create or replace function public.get_service_request_queue(p_table_id uuid, p_table_access_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.valid_table_access(p_table_id,p_table_access_code) then raise exception 'Mesa no autorizada.'; end if;
  with waiting as (
    select r.*, case when r.request_type='other' and lower(r.message) like '%solicita la canci%n:%' then 'song' else 'service' end as queue_kind
    from public.service_requests r where r.status='pending'
  ), turns as (
    select queue_kind,table_id,min(created_at) first_at from waiting group by queue_kind,table_id
  ), ranked as (
    select *,row_number() over(partition by queue_kind order by first_at,table_id) position from turns
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'kind',w.queue_kind,'position',r.position,'status',w.status,'created_at',w.created_at) order by w.created_at),'[]'::jsonb)
  into result from waiting w join ranked r using(queue_kind,table_id) where w.table_id=p_table_id;
  return jsonb_build_object('requests',result);
end;
$$;
revoke all on function public.get_service_request_queue(uuid,text) from public;
grant execute on function public.get_service_request_queue(uuid,text) to anon, authenticated;

-- Una orden remota se entrega a UNA caja configurada y con señal reciente.
-- El secreto del controlador protege la recepción y la confirmación.
create table if not exists public.pos_drawer_devices (
  id uuid primary key, secret_hash text not null, label text not null,
  last_seen timestamptz not null default now(), user_id uuid not null
);
create table if not exists public.pos_drawer_commands (
  id uuid primary key, device_id uuid not null references public.pos_drawer_devices(id),
  requested_by uuid not null, created_at timestamptz not null default now(),
  status text not null default 'pending' check(status in ('pending','claimed','accepted','failed','expired')),
  claimed_at timestamptz, finished_at timestamptz, error text not null default ''
);
create index if not exists pos_drawer_commands_device_idx on public.pos_drawer_commands(device_id,status,created_at);
alter table public.pos_drawer_devices enable row level security;
alter table public.pos_drawer_commands enable row level security;
revoke all on public.pos_drawer_devices, public.pos_drawer_commands from anon, authenticated;

create or replace function public.register_pos_drawer(auth_token text,p_device_id uuid,p_secret text,p_label text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare staff jsonb; old public.pos_drawer_devices;
begin
  staff := to_jsonb(public.require_app_user(auth_token));
  if length(coalesce(p_secret,'')) < 32 then raise exception 'Controlador no válido.'; end if;
  select * into old from public.pos_drawer_devices d where d.id=p_device_id for update;
  if found and old.secret_hash <> encode(digest(p_secret,'sha256'),'hex') then raise exception 'Identidad de controlador no válida.'; end if;
  insert into public.pos_drawer_devices(id,secret_hash,label,last_seen,user_id)
  values(p_device_id,encode(digest(p_secret,'sha256'),'hex'),left(coalesce(p_label,'Caja POS'),100),now(),(staff->>'id')::uuid)
  on conflict(id) do update set last_seen=now(),label=excluded.label,user_id=excluded.user_id;
  return jsonb_build_object('ok',true);
end;
$$;
create or replace function public.request_pos_drawer(auth_token text,p_command_id uuid,p_device_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare staff jsonb; target public.pos_drawer_devices; command public.pos_drawer_commands;
begin
  staff := to_jsonb(public.require_app_user(auth_token));
  select * into command from public.pos_drawer_commands c where c.id=p_command_id;
  if found then
    if command.requested_by <> (staff->>'id')::uuid then raise exception 'Orden no autorizada.'; end if;
    return jsonb_build_object('command',to_jsonb(command));
  end if;
  select * into target from public.pos_drawer_devices d where d.last_seen > now()-interval '12 seconds'
    and (p_device_id is null or d.id=p_device_id) order by d.last_seen desc,d.id limit 1;
  if not found then raise exception 'No hay una caja conectada. Abre Tienda Nápoles en el PC de la caja y configura la impresora.'; end if;
  insert into public.pos_drawer_commands(id,device_id,requested_by) values(p_command_id,target.id,(staff->>'id')::uuid) returning * into command;
  return jsonb_build_object('command',to_jsonb(command),'device',target.label);
end;
$$;
create or replace function public.claim_pos_drawer(auth_token text,p_device_id uuid,p_secret text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare command public.pos_drawer_commands;
begin
  perform public.require_app_user(auth_token);
  if not exists(select 1 from public.pos_drawer_devices d where d.id=p_device_id and d.secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'Controlador no autorizado.'; end if;
  update public.pos_drawer_commands c set status='expired',finished_at=now() where c.device_id=p_device_id and c.status='pending' and c.created_at < now()-interval '15 seconds';
  select * into command from public.pos_drawer_commands c where c.device_id=p_device_id and c.status='pending' order by c.created_at,c.id for update skip locked limit 1;
  if not found then return jsonb_build_object('command',null); end if;
  update public.pos_drawer_commands c set status='claimed',claimed_at=now() where c.id=command.id;
  return jsonb_build_object('command',to_jsonb(command));
end;
$$;
create or replace function public.finish_pos_drawer(auth_token text,p_device_id uuid,p_secret text,p_command_id uuid,p_accepted boolean,p_error text default '')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.require_app_user(auth_token);
  if not exists(select 1 from public.pos_drawer_devices d where d.id=p_device_id and d.secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'Controlador no autorizado.'; end if;
  update public.pos_drawer_commands c set status=case when p_accepted then 'accepted' else 'failed' end,finished_at=now(),error=left(coalesce(p_error,''),200)
  where c.id=p_command_id and c.device_id=p_device_id and c.status='claimed';
  return jsonb_build_object('ok',found);
end;
$$;
create or replace function public.get_pos_drawer_command(auth_token text,p_command_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare staff jsonb; result jsonb;
begin
  staff := to_jsonb(public.require_app_user(auth_token));
  select to_jsonb(c) into result from public.pos_drawer_commands c where c.id=p_command_id and c.requested_by=(staff->>'id')::uuid;
  return jsonb_build_object('command',result);
end;
$$;
revoke all on function public.register_pos_drawer(text,uuid,text,text),public.request_pos_drawer(text,uuid,uuid),public.claim_pos_drawer(text,uuid,text),public.finish_pos_drawer(text,uuid,text,uuid,boolean,text),public.get_pos_drawer_command(text,uuid) from public;
grant execute on function public.register_pos_drawer(text,uuid,text,text),public.request_pos_drawer(text,uuid,uuid),public.claim_pos_drawer(text,uuid,text),public.finish_pos_drawer(text,uuid,text,uuid,boolean,text),public.get_pos_drawer_command(text,uuid) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
