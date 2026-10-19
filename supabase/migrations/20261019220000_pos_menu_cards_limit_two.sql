-- Limita nuevas cartas a dos imágenes sin eliminar imágenes existentes.
begin;

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
  if old.id is null and (select count(*) from public.pos_menu_cards)>=2 then raise exception 'Máximo 2 imágenes. Elimina una antes de subir otra.'; end if;
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

commit;
