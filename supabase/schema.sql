-- Tienda Napoles - migracion operativa 2026-09-03
-- Archivo aditivo e idempotente. Ejecutar en el SQL Editor del proyecto actual.

begin;

alter table public.table_sessions add column if not exists sale_channel text not null default 'table';
alter table public.table_sessions alter column table_id drop not null;
alter table public.session_items alter column table_id drop not null;
alter table public.session_items add column if not exists created_by_user_id uuid;
alter table public.session_items add column if not exists updated_by_user_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'table_sessions_sale_channel_check') then
    alter table public.table_sessions add constraint table_sessions_sale_channel_check check (sale_channel in ('table', 'walk_in'));
  end if;
end $$;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  table_id uuid references public.restaurant_tables(id) on delete cascade,
  sender_type text not null check (sender_type in ('client', 'staff', 'system')),
  sender_user_id uuid,
  sender_name text not null default '',
  body text not null check (char_length(body) between 1 and 600),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_created_idx on public.chat_messages(session_id, created_at);
alter table public.chat_messages enable row level security;
revoke all on public.chat_messages from anon, authenticated;

create or replace function public.chat_staff_user(p_auth_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
begin
  if coalesce(p_auth_token, '') = '' then return null; end if;
  select to_jsonb(public.get_current_user(p_auth_token)) into staff;
  if coalesce((staff->>'is_active')::boolean, false) is not true then return null; end if;
  return staff;
exception when others then
  return null;
end;
$$;

create or replace function public.chat_client_can_access(p_table_id uuid, p_session_id uuid, p_table_access_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.valid_table_access(p_table_id, p_table_access_code) and exists (
    select 1
    from public.restaurant_tables rt
    join public.table_sessions ts on ts.table_id = rt.id
    where rt.id = p_table_id
      and ts.id = p_session_id
      and ts.status = 'open'
  );
$$;

create or replace function public.list_chat_messages(p_session_id uuid, p_table_id uuid default null, p_table_access_code text default '', p_auth_token text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
  result jsonb;
begin
  staff := public.chat_staff_user(p_auth_token);
  if staff is null and not public.chat_client_can_access(p_table_id, p_session_id, p_table_access_code) then
    raise exception 'Acceso al chat no autorizado';
  end if;
  select jsonb_build_object('messages', coalesce(jsonb_agg(to_jsonb(cm) order by cm.created_at), '[]'::jsonb))
    into result
  from public.chat_messages cm
  where cm.session_id = p_session_id;
  return result;
end;
$$;

create or replace function public.send_chat_message(p_message_id uuid, p_session_id uuid, p_table_id uuid default null, p_sender_type text default 'client', p_body text default '', p_table_access_code text default '', p_auth_token text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
  saved public.chat_messages;
  effective_sender text;
begin
  staff := public.chat_staff_user(p_auth_token);
  effective_sender := lower(coalesce(p_sender_type, 'client'));
  if effective_sender in ('staff', 'system') then
    if staff is null then raise exception 'Usuario administrativo no autorizado'; end if;
  elsif effective_sender = 'client' then
    if not public.chat_client_can_access(p_table_id, p_session_id, p_table_access_code) then raise exception 'Mesa no autorizada'; end if;
  else
    raise exception 'Remitente invalido';
  end if;
  insert into public.chat_messages(id, session_id, table_id, sender_type, sender_user_id, sender_name, body)
  values (
    coalesce(p_message_id, gen_random_uuid()), p_session_id, p_table_id, effective_sender,
    case when staff is null then null else nullif(staff->>'id', '')::uuid end,
    case when effective_sender = 'client' then 'Cliente' when effective_sender = 'system' then 'Sistema' else coalesce(staff->>'full_name', staff->>'username', 'Equipo') end,
    left(trim(p_body), 600)
  )
  on conflict (id) do update set body = excluded.body
  returning * into saved;
  return jsonb_build_object('message', to_jsonb(saved));
end;
$$;

create or replace function public.close_chat_session(p_session_id uuid, p_auth_token text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
  deleted_count integer;
begin
  staff := public.chat_staff_user(p_auth_token);
  if staff is null then raise exception 'Usuario administrativo no autorizado'; end if;
  delete from public.chat_messages cm where cm.session_id = p_session_id;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('closed', true, 'deleted', deleted_count);
end;
$$;

grant execute on function public.list_chat_messages(uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.send_chat_message(uuid, uuid, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.close_chat_session(uuid, text) to anon, authenticated;

create or replace function public.get_admin_snapshot(auth_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_app_user(auth_token);
  return jsonb_build_object(
    'requests', (
      select coalesce(jsonb_agg(
        to_jsonb(r) || jsonb_build_object(
          'restaurant_tables', jsonb_build_object('table_number', t.table_number, 'table_name', t.table_name),
          'acknowledged_by_user', case when u.id is null then null else public.public_user(u) end
        ) order by r.created_at desc), '[]'::jsonb)
      from public.service_requests r
      join public.restaurant_tables t on t.id = r.table_id
      left join public.app_users u on u.id = r.acknowledged_by_user_id
      where r.status in ('pending', 'acknowledged')
    ),
    'sessions', (
      select coalesce(jsonb_agg(
        to_jsonb(s) || jsonb_build_object(
          'restaurant_tables', case when t.id is null then null else jsonb_build_object('table_number', t.table_number, 'table_name', t.table_name) end,
          'assigned_waiter', case when u.id is null then null else public.public_user(u) end,
          'session_items', (
            select coalesce(jsonb_agg(
              to_jsonb(i) || jsonb_build_object('created_by_user', case when cu.id is null then null else public.public_user(cu) end)
              order by i.created_at
            ), '[]'::jsonb)
            from public.session_items i
            left join public.app_users cu on cu.id = i.created_by_user_id
            where i.session_id = s.id
          )
        ) order by s.opened_at desc), '[]'::jsonb)
      from public.table_sessions s
      left join public.restaurant_tables t on t.id = s.table_id
      left join public.app_users u on u.id = s.assigned_waiter_id
      where s.status = 'open'
    )
  );
end;
$$;

grant execute on function public.get_admin_snapshot(text) to anon, authenticated;

do $$
declare
  category_name text;
  category_order integer := 100;
begin
  foreach category_name in array array['Snack', 'Bebidas', 'Medicina', 'Otros'] loop
    if not exists (select 1 from public.menu_categories mc where lower(mc.name) = lower(category_name)) then
      insert into public.menu_categories(name, sort_order, is_active) values (category_name, category_order, true);
    end if;
    category_order := category_order + 1;
  end loop;
end $$;

do $$
begin
  begin alter publication supabase_realtime add table public.service_requests; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.table_sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.session_items; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_messages; exception when duplicate_object then null; end;
end $$;

commit;

-- Administracion segura de usuarios. Las relaciones operativas usan ON DELETE
-- SET NULL y el historico de Apps Script conserva el nombre del responsable.
create or replace function public.delete_user(auth_token text, user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor public.app_users;
  target public.app_users;
begin
  actor := public.require_admin(auth_token);
  select * into target from public.app_users where id = user_id;
  if target.id is null then return jsonb_build_object('deleted', false, 'reason', 'not_found'); end if;
  if target.id = actor.id then raise exception 'No puedes eliminar tu propio usuario mientras tienes la sesion abierta.'; end if;
  if target.role = 'admin' and target.is_active
     and not exists(select 1 from public.app_users u where u.id <> target.id and u.role = 'admin' and u.is_active) then
    raise exception 'No puedes eliminar el ultimo administrador activo.';
  end if;
  delete from public.app_users where id = target.id;
  return jsonb_build_object('deleted', true, 'id', target.id, 'full_name', target.full_name);
end;
$$;

grant execute on function public.delete_user(text, uuid) to anon, authenticated;

-- Correccion de administracion de usuarios: usa parametros posicionales para
-- evitar ambiguedades entre el parametro id y la columna app_users.id.
create or replace function public.save_user(
  auth_token text,
  id uuid,
  full_name text,
  username text,
  pin text default '',
  role text default 'waiter',
  is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  saved public.app_users;
  current_row public.app_users;
begin
  perform public.require_admin($1);
  if trim($3) = '' or lower(trim($4)) !~ '^[a-z0-9._-]{3,40}$' then raise exception 'Nombre o usuario invalido.'; end if;
  if $5 <> '' and $5 !~ '^[0-9]{4,12}$' then raise exception 'El PIN debe tener entre 4 y 12 digitos.'; end if;
  select u.* into current_row from public.app_users u where u.id = $2;
  if current_row.id is null and $5 = '' then raise exception 'El PIN es obligatorio para un usuario nuevo.'; end if;
  if current_row.role = 'admin' and ($6 <> 'admin' or not $7)
     and not exists(select 1 from public.app_users u where u.id <> current_row.id and u.role = 'admin' and u.is_active) then
    raise exception 'No puedes desactivar o cambiar el rol del ultimo administrador.';
  end if;
  insert into public.app_users(id, full_name, username, pin_hash, role, is_active)
  values ($2, trim($3), lower(trim($4)), crypt($5, gen_salt('bf', 10)), case when $6 = 'admin' then 'admin' else 'waiter' end, $7)
  on conflict on constraint app_users_pkey do update set
    full_name = excluded.full_name, username = excluded.username, role = excluded.role, is_active = excluded.is_active,
    pin_hash = case when $5 <> '' then crypt($5, gen_salt('bf', 10)) else app_users.pin_hash end
  returning * into saved;
  return public.public_user(saved);
exception when unique_violation then
  raise exception 'Ese nombre de usuario ya esta en uso.';
end;
$$;

grant execute on function public.save_user(text, uuid, text, text, text, text, boolean) to anon, authenticated;

create or replace function public.login(username text, pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized text := lower(trim($1));
  found_user public.app_users;
  attempt public.login_attempts;
  raw_token text;
  expiry timestamptz := now() + interval '12 hours';
begin
  select a.* into attempt from public.login_attempts a where a.username = normalized;
  if attempt.blocked_until > now() then return null; end if;
  select u.* into found_user from public.app_users u where u.username = normalized and u.is_active limit 1;
  if found_user.id is null or crypt($2, found_user.pin_hash) <> found_user.pin_hash then
    insert into public.login_attempts(username, attempts, blocked_until)
    values (normalized, 1, null)
    on conflict on constraint login_attempts_pkey do update set
      attempts = case when login_attempts.blocked_until <= now() then 1 else login_attempts.attempts + 1 end,
      blocked_until = case when login_attempts.attempts + 1 >= 8 then now() + interval '5 minutes' else login_attempts.blocked_until end,
      updated_at = now();
    return null;
  end if;
  delete from public.login_attempts a where a.username = normalized;
  delete from public.auth_sessions s where s.expires_at <= now();
  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into public.auth_sessions(user_id, token_hash, expires_at)
  values (found_user.id, encode(digest(raw_token, 'sha256'), 'hex'), expiry);
  update public.app_users u set last_login_at = now() where u.id = found_user.id returning u.* into found_user;
  return jsonb_build_object('token', raw_token, 'expires_at', expiry, 'user', public.public_user(found_user));
end;
$$;

grant execute on function public.login(text, text) to anon, authenticated;

-- Optional product barcode; preserves existing names, acronyms, prices and stock.
begin;
alter table public.menu_items add column if not exists barcode text;
create unique index if not exists menu_items_barcode_unique
  on public.menu_items (barcode) where barcode is not null;
notify pgrst, 'reload schema';
commit;
