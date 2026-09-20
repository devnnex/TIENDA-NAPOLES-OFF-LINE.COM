-- Propagacion de cambios del nucleo del POS. Realtime acelera la interfaz;
-- la reconciliacion por lectura sigue siendo la autoridad final.

create or replace function public.broadcast_core_refresh()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$
begin
  perform realtime.send(
    jsonb_build_object('entity', tg_table_name, 'operation', tg_op),
    'core-refresh',
    'admin',
    false
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists broadcast_business_core on public.business_settings;
create trigger broadcast_business_core
after insert or update or delete on public.business_settings
for each row execute function public.broadcast_core_refresh();

drop trigger if exists broadcast_tables_core on public.restaurant_tables;
create trigger broadcast_tables_core
after insert or update or delete on public.restaurant_tables
for each row execute function public.broadcast_core_refresh();

drop trigger if exists broadcast_categories_core on public.menu_categories;
create trigger broadcast_categories_core
after insert or update or delete on public.menu_categories
for each row execute function public.broadcast_core_refresh();

drop trigger if exists broadcast_menu_items_core on public.menu_items;
create trigger broadcast_menu_items_core
after insert or update or delete on public.menu_items
for each row execute function public.broadcast_core_refresh();

alter table public.business_settings replica identity full;
alter table public.restaurant_tables replica identity full;
alter table public.menu_categories replica identity full;
alter table public.menu_items replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table public.business_settings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.restaurant_tables; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.menu_categories; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.menu_items; exception when duplicate_object then null; end;
end;
$$;

grant execute on function public.broadcast_core_refresh() to anon, authenticated, service_role;
