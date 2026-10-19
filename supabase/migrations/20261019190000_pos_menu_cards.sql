-- Biblioteca de imágenes de Carta. No modifica ventas, solicitudes ni sus tablas.
begin;

create table if not exists public.pos_menu_cards (
  id uuid primary key,
  name text not null check (length(trim(name)) between 1 and 80),
  image_path text not null unique,
  all_tables boolean not null default true,
  sort_order integer not null default 0,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create table if not exists public.pos_menu_card_tables (
  card_id uuid references public.pos_menu_cards(id) on delete cascade,
  table_id uuid references public.restaurant_tables(id) on delete cascade,
  primary key(card_id, table_id)
);
create index if not exists pos_menu_card_tables_table_idx on public.pos_menu_card_tables(table_id);
alter table public.pos_menu_cards enable row level security;
alter table public.pos_menu_card_tables enable row level security;
revoke all on public.pos_menu_cards, public.pos_menu_card_tables from public, anon, authenticated;

create or replace function public.pos_menu_can_manage(p_token text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(u->>'role' = 'boss' or (u->>'role' = 'admin' and
    (u->'permissions' is null or u->'permissions' = 'null'::jsonb or u->'permissions' ? 'brand')), false)
  from (select to_jsonb(public.app_user_for_token(p_token)) u) actor;
$$;

create or replace function public.pos_list_menu_cards(p_auth_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.pos_menu_can_manage(p_auth_token) then raise exception 'No tienes permiso para administrar la Carta.'; end if;
  return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('table_ids',
    (select coalesce(jsonb_agg(t.table_id order by t.table_id), '[]'::jsonb) from public.pos_menu_card_tables t where t.card_id=c.id))
    order by c.sort_order, c.id) from public.pos_menu_cards c), '[]'::jsonb);
end; $$;

create or replace function public.pos_save_menu_card(p_id uuid, p_name text, p_image_path text,
  p_all_tables boolean, p_table_ids uuid[], p_expected_version integer, p_auth_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare old public.pos_menu_cards; saved public.pos_menu_cards;
begin
  if not public.pos_menu_can_manage(p_auth_token) then raise exception 'No tienes permiso para administrar la Carta.'; end if;
  perform pg_advisory_xact_lock(hashtext('pos_menu_cards'));
  select * into old from public.pos_menu_cards where id=p_id;
  -- Reintentar la misma alta/edición tras perder la respuesta no crea otra carta.
  if old.id is not null and old.name=trim(p_name) and old.image_path=p_image_path and old.all_tables=p_all_tables
    and array(select table_id from public.pos_menu_card_tables where card_id=p_id order by table_id)
      = array(select distinct unnest(coalesce(p_table_ids, array[]::uuid[])) order by 1) then
    return to_jsonb(old);
  end if;
  if p_expected_version is null or coalesce(old.version,0) <> p_expected_version then raise exception 'Otra persona cambió esta carta. Recarga la biblioteca antes de guardar.'; end if;
  if p_id is null or length(trim(coalesce(p_name,''))) not between 1 and 80 or p_all_tables is null then raise exception 'Nombre de carta inválido.'; end if;
  if old.id is null and (select count(*) from public.pos_menu_cards)>=20 then raise exception 'Máximo 20 imágenes. Elimina una antes de subir otra.'; end if;
  if p_image_path !~ ('^cards/' || p_id::text || '/[a-f0-9]{64}\.(jpg|png|webp)$')
    or not exists(select 1 from storage.objects where bucket_id='pos-menu-cards' and name=p_image_path) then
    raise exception 'Primero sube una imagen válida de esta carta.';
  end if;
  if exists(select 1 from unnest(coalesce(p_table_ids,array[]::uuid[])) t(id)
    where not exists(select 1 from public.restaurant_tables r where r.id=t.id and r.is_active)) then
    raise exception 'La selección contiene mesas inactivas. Recarga la biblioteca.';
  end if;
  insert into public.pos_menu_cards(id,name,image_path,all_tables,sort_order)
    values(p_id,trim(p_name),p_image_path,p_all_tables,coalesce((select max(sort_order)+1 from public.pos_menu_cards),0))
    on conflict(id) do update set name=excluded.name,image_path=excluded.image_path,all_tables=excluded.all_tables,
      version=pos_menu_cards.version+1,updated_at=clock_timestamp() returning * into saved;
  delete from public.pos_menu_card_tables where card_id=p_id;
  insert into public.pos_menu_card_tables select p_id, id from (select distinct unnest(coalesce(p_table_ids,array[]::uuid[])) id) t;
  return to_jsonb(saved);
end; $$;

create or replace function public.pos_delete_menu_card(p_id uuid, p_expected_version integer, p_auth_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.pos_menu_can_manage(p_auth_token) then raise exception 'No tienes permiso para administrar la Carta.'; end if;
  perform pg_advisory_xact_lock(hashtext('pos_menu_cards'));
  if p_expected_version is null or exists(select 1 from public.pos_menu_cards where id=p_id and version<>p_expected_version) then
    raise exception 'Otra persona cambió esta carta. Recarga la biblioteca.';
  end if;
  delete from public.pos_menu_cards where id=p_id;
  return jsonb_build_object('ok',true);
end; $$;

create or replace function public.pos_reorder_menu_cards(p_ids uuid[], p_auth_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.pos_menu_can_manage(p_auth_token) then raise exception 'No tienes permiso para administrar la Carta.'; end if;
  perform pg_advisory_xact_lock(hashtext('pos_menu_cards'));
  if coalesce(cardinality(p_ids),0)<>(select count(*) from public.pos_menu_cards)
    or (select count(distinct id) from unnest(p_ids) t(id))<>cardinality(p_ids)
    or exists(select 1 from unnest(p_ids) t(id) where not exists(select 1 from public.pos_menu_cards c where c.id=t.id)) then
    raise exception 'La biblioteca cambió. Recárgala antes de ordenar.';
  end if;
  update public.pos_menu_cards c set sort_order=t.position::integer,version=c.version+1,updated_at=clock_timestamp()
    from unnest(p_ids) with ordinality t(id,position) where c.id=t.id and c.sort_order<>t.position;
  return jsonb_build_object('ok',true);
end; $$;

create or replace function public.pos_get_menu_cards(p_table_id uuid, p_table_access_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.valid_table_access(p_table_id,p_table_access_code) then raise exception 'Selecciona una mesa con un QR válido para ver la Carta.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'image_path',c.image_path)
    order by c.sort_order,c.id) from public.pos_menu_cards c where c.all_tables
    or exists(select 1 from public.pos_menu_card_tables t where t.card_id=c.id and t.table_id=p_table_id)), '[]'::jsonb);
end; $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('pos-menu-cards','pos-menu-cards',false,15728640,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.pos_menu_image_readable(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.pos_menu_can_manage(public.request_header('x-app-token')) or exists(
    select 1 from public.pos_menu_cards c where c.image_path=p_path and exists(
      select 1 from public.restaurant_tables r where r.is_active and public.valid_table_header(r.id)
      and (c.all_tables or exists(select 1 from public.pos_menu_card_tables t where t.card_id=c.id and t.table_id=r.id))));
$$;
drop policy if exists pos_menu_images_read on storage.objects;
create policy pos_menu_images_read on storage.objects for select to anon,authenticated
using(bucket_id='pos-menu-cards' and public.pos_menu_image_readable(name));
drop policy if exists pos_menu_images_insert on storage.objects;
create policy pos_menu_images_insert on storage.objects for insert to anon,authenticated
with check(bucket_id='pos-menu-cards' and public.pos_menu_can_manage(public.request_header('x-app-token'))
  and name ~ '^cards/[0-9a-f-]{36}/[a-f0-9]{64}\.(jpg|png|webp)$');
-- Objetos inmutables: reemplazar publica una ruta nueva antes de retirar la anterior.
drop policy if exists pos_menu_images_delete on storage.objects;
create or replace function public.pos_menu_image_deletable(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.pos_menu_can_manage(public.request_header('x-app-token'))
    and not exists(select 1 from public.pos_menu_cards c where c.image_path=p_path);
$$;
create policy pos_menu_images_delete on storage.objects for delete to anon,authenticated
using(bucket_id='pos-menu-cards' and public.pos_menu_image_deletable(name));

revoke all on function public.pos_menu_can_manage(text),public.pos_menu_image_readable(text),public.pos_menu_image_deletable(text),
  public.pos_list_menu_cards(text),public.pos_save_menu_card(uuid,text,text,boolean,uuid[],integer,text),
  public.pos_delete_menu_card(uuid,integer,text),public.pos_reorder_menu_cards(uuid[],text),public.pos_get_menu_cards(uuid,text) from public;
grant execute on function public.pos_menu_can_manage(text),public.pos_menu_image_readable(text),public.pos_menu_image_deletable(text),
  public.pos_list_menu_cards(text),public.pos_save_menu_card(uuid,text,text,boolean,uuid[],integer,text),
  public.pos_delete_menu_card(uuid,integer,text),public.pos_reorder_menu_cards(uuid[],text),public.pos_get_menu_cards(uuid,text) to anon,authenticated;
commit;
